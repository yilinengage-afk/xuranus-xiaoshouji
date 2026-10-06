/**
 * 冒充 tar-fs，够云备份打包/恢复用（cloudbackup.js 的 packSnapshot/unpackSnapshot）。
 *
 * 真的 tar-fs 靠 fs 的文件描述符和流一个个读文件，Worker 的虚拟文件系统没有这些；
 * 这里的文件本来就整个在 KV 里，直接读出来拼成 tar，或者整个收完再一次性解开。
 * 只认 cloudbackup.js 用到的那几个选项：`pack` 的 `entries`/`finalize: false`+
 * `finish(pack)`/`pack.entry()`；`extract` 的 `ignore(name, header)`。
 *
 * extract 不做真流式解析（不值当，体量本来就按几十 MB 设计）：收完整个
 * tar 字节再一次性解析，和 pack() 先攒后吐是对称的写法。ustar + PAX 长文件名
 * 两种头都认——pack() 自己写的、以及桌面版真正 tar-fs（底层 tar-stream）写的
 * 都是这个格式，两边能对上。
 */
import { Readable, Writable } from "node:stream";
import path from "node:path";
import fs from "./fs.js";

/*
 * Durable Object 一次最多 128MB 内存，包连原始文件带 gzip 要在内存里各放一份。
 * 聊天和记忆一般几 MB，远到不了；真到了就明说，别等 OOM 把整个后端拖挂。
 */
const MAX_RAW = 40 * 1024 * 1024;

const enc = new TextEncoder();

function octal(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name, size, type = "0") {
  const h = new Uint8Array(512);
  const put = (str, at, len) => h.set(enc.encode(str).subarray(0, len), at);
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8); // 算校验和时这 8 位按空格算
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

const pad = (size) => new Uint8Array((512 - (size % 512)) % 512);

/** 名字超过 100 字节（中文文件名很容易）就先垫一条 PAX 头，把完整路径放那里。 */
function headers(name, size) {
  if (enc.encode(name).length <= 100) return [header(name, size)];
  const body = (len) => `${len} path=${name}\n`;
  let rec = body(0);
  // 长度字段把自己也算进去，位数变了要再算一遍
  for (let len = enc.encode(rec).length; ; len = enc.encode(rec).length) {
    const next = body(len);
    if (next === rec) break;
    rec = next;
  }
  const pax = enc.encode(rec);
  const short = `PaxHeaders/${path.posix.basename(name)}`.slice(0, 99);
  return [header(short, pax.length, "x"), pax, pad(pax.length), header(short, size)];
}

function toBytes(data) {
  if (typeof data === "string") return enc.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function pack(cwd, opts = {}) {
  const stream = new Readable({ read() {} });
  let raw = 0;

  const p = {
    entry(h, data) {
      const bytes = toBytes(data ?? new Uint8Array(0));
      for (const part of headers(h.name, bytes.length)) stream.push(part);
      stream.push(bytes);
      stream.push(pad(bytes.length));
    },
    finalize() {
      stream.push(new Uint8Array(1024));
      stream.push(null);
    },
  };

  // 下一拍再开始：调用方要先把流接进 pipeline
  queueMicrotask(() => {
    try {
      for (const rel of opts.entries ?? []) {
        const bytes = toBytes(fs.readFileSync(path.join(cwd, rel)));
        raw += bytes.length;
        if (raw > MAX_RAW) {
          throw new Error(
            `要备份的内容超过 ${MAX_RAW / 1024 / 1024}MB，小手机的内存打不下这么大的包。少勾几块再试`
          );
        }
        p.entry({ name: rel.replace(/\\/g, "/") }, bytes);
      }
      if (opts.finalize === false) opts.finish?.(p);
      else p.finalize();
    } catch (e) {
      stream.destroy(e);
    }
  });

  return stream;
}

/*
 * 恢复包比打包的 raw 内容多一层 tar 的 512 字节头/对齐开销，顶比 MAX_RAW
 * 松一点，省得刚好卡在边界上的包白白报错。
 */
const MAX_EXTRACT = 48 * 1024 * 1024;

const TYPE_NAMES = { 0: "file", 5: "directory", 2: "symlink", 1: "link" };

/** 数字字段：八进制 ASCII，去掉尾部的 `\0`/空格（和 octal() 写出来的格式对称）。 */
function parseOctal(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0 || b === 32) break;
    s += String.fromCharCode(b);
  }
  return s ? parseInt(s, 8) || 0 : 0;
}

function parseField(block, at, len) {
  let end = at;
  while (end < at + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(at, end));
}

function isZeroBlock(block) {
  for (const b of block) if (b !== 0) return false;
  return true;
}

/** 和 header() 用同一套求和算法：校验和字段本身按 8 个空格算。 */
function checksum(block) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum;
}

function parseHeader(block) {
  const chk = parseOctal(block.subarray(148, 156));
  if (checksum(block) !== chk) return null;
  const name = parseField(block, 0, 100);
  const size = parseOctal(block.subarray(124, 12 + 124));
  const typeflag = String.fromCharCode(block[156] || 0x30);
  const linkname = parseField(block, 157, 100);
  const magic = parseField(block, 257, 6);
  const prefix = magic.startsWith("ustar") ? parseField(block, 345, 155) : "";
  const fullName = prefix ? `${prefix}/${name}` : name;
  return { name: fullName, size, typeflag, linkname };
}

/** PAX 扩展头：一串 `"<len> key=value\n"` 记录，长度把自己也算进去。 */
function parsePax(data) {
  const text = new TextDecoder().decode(data);
  const out = {};
  let at = 0;
  while (at < text.length) {
    const sp = text.indexOf(" ", at);
    if (sp < 0) break;
    const len = parseInt(text.slice(at, sp), 10);
    if (!len || len <= sp - at) break;
    const rec = text.slice(at, at + len);
    const eq = rec.indexOf("=", sp - at);
    if (eq > 0) out[rec.slice(sp - at + 1, eq)] = rec.slice(eq + 1).replace(/\n$/, "");
    at += len;
  }
  return out;
}

function concat(chunks) {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 和真正 tar-fs 一样防路径穿越：先拼到 `/` 下把开头的 `..` 吃掉，再拼到 cwd。 */
function safeJoin(cwd, name) {
  return path.join(cwd, path.join("/", name));
}

function extractAll(buf, cwd, opts) {
  let off = 0;
  let paxName = null;
  let paxLink = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (isZeroBlock(block)) break;
    const header = parseHeader(block);
    if (!header) throw new Error("包里的 tar 头校验和对不上，文件可能传坏了");
    off += 512;
    const data = buf.subarray(off, off + header.size);
    off += header.size + ((512 - (header.size % 512)) % 512);

    if (header.typeflag === "x" || header.typeflag === "X") {
      const pax = parsePax(data);
      if (pax.path) paxName = pax.path;
      if (pax.linkpath) paxLink = pax.linkpath;
      continue;
    }
    if (header.typeflag === "g" || header.typeflag === "L" || header.typeflag === "K") continue;

    const name = paxName ?? header.name;
    const linkname = paxLink ?? header.linkname;
    paxName = null;
    paxLink = null;
    if (!name) continue;

    const type = TYPE_NAMES[header.typeflag] ?? TYPE_NAMES[Number(header.typeflag)] ?? "other";
    if (opts?.ignore?.(name, { type, name, linkname, size: header.size })) continue;

    const dest = safeJoin(cwd, name);
    if (type === "directory") {
      fs.mkdirSync(dest, { recursive: true });
    } else if (type === "file") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    // symlink / link / other：不落盘（ignore 没挡住也不写，链接类条目本来就不该进 data/）
  }
}

export function extract(cwd, opts = {}) {
  const chunks = [];
  let total = 0;
  return new Writable({
    write(chunk, _enc, cb) {
      const bytes = toBytes(chunk);
      chunks.push(bytes);
      total += bytes.length;
      if (total > MAX_EXTRACT) {
        return cb(new Error(`这个包超过 ${MAX_EXTRACT / 1024 / 1024}MB，小手机的内存解不开这么大的包`));
      }
      cb();
    },
    final(cb) {
      try {
        extractAll(concat(chunks), cwd, opts);
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });
}

export default { pack, extract };
