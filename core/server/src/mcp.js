/**
 * 自定义 MCP（Model Context Protocol）工具。
 *
 * 用户在「角色 → MCP 工具」里登记几台 MCP 服务器（全局一份，所有角色共用），
 * 再给每个角色勾上它能用哪几台。一轮对话里模型想用工具时，这里替它去
 * 调 `tools/call`，把结果接在回复后面再问一次 —— 和联网搜索同一个形态
 * （见 imessage.js:mcpRound），对方只收到最后那条回复。
 *
 * ── 两种调用方式，角色上选 ──
 *
 *  - `text`（文本标记，默认）：工具清单写进提示词，模型在回复里写
 *    `[工具:名字 {"参数":…}]` 这种标记，我们拦下来去调。**哪家 API 都能用** ——
 *    中转站、Gemini、Claude 原生接口都不用支持 tools。标记的样子用户能改
 *    （`{name}` / `{args}` 两个占位符），见 compileMarker。
 *  - `native`（原生 function calling）：工具清单走请求体的 `tools` 字段，
 *    模型回 `tool_calls`。更稳，但要上游支持；不支持的会被 llm.js 脱掉 tools
 *    重打一次（这一轮就当没有工具），控制台里会提示换成文本标记。
 *
 * ── 三种传输 ──
 *
 *  - `http`：Streamable HTTP（2025-03 之后的标准写法），POST 一个地址，
 *    回 JSON 或者一段 SSE。
 *  - `sse`：老式 HTTP+SSE（2024-11），先 GET 一条长连接拿到 POST 地址，
 *    回应从那条长连接里来。还有不少托管服务只给这个。
 *  - `stdio`：本地起一个进程（`npx xxx-mcp` 这种），按行收发 JSON-RPC。
 *    **只有桌面版能用** —— 小手机跑在 Cloudflare Worker 里，起不了进程。
 *
 * 客户端是自己写的，没引官方 SDK：SDK 会带进来一串 Node 依赖，Worker 那边
 * 要一个个 alias 掉；而我们只用得到 initialize / tools/list / tools/call 三个方法。
 *
 * ── 省 token ──
 *
 * 工具结果是外部文本，和搜索结果一样**只注入这一次、不进存档**，单条按角色
 * 配的字数硬切。一轮最多调几次、最多往返几趟也是角色上配。
 *
 * ── 密钥 ──
 *
 * 服务器列表（地址、请求头里的 token、stdio 的环境变量）整块只写
 * data.config.json，和 searchApi 一个待遇（见 config.js:writeToDisk）。
 */

import { spawn } from "node:child_process";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { clampInt, pickId, str } from "./normalize.js";
import { stripXmlBlocks } from "./websearch.js";

/** 我们说的协议版本。服务器回什么版本就跟着用什么版本（HTTP 头里要带）。 */
const PROTOCOL_VERSION = "2025-06-18";

/** 连上 + 握手最多等多久。stdio 第一次 `npx` 要下载包，给宽一点。 */
const CONNECT_TIMEOUT = 45_000;

/** 工具清单缓存多久。每轮都 tools/list 一遍太浪费，服务器改了工具也不会频繁。 */
const TOOLS_TTL = 5 * 60_000;

/** 连接闲置多久就关掉（stdio 进程一直挂着占内存）。 */
const IDLE_MS = 10 * 60_000;

/** 单个工具 / 参数说明在提示词里最多留多少字。 */
const MAX_TOOL_DESC = 300;
const MAX_PARAM_DESC = 80;

export const TRANSPORTS = ["http", "sse", "stdio"];
export const MODES = ["text", "native"];

/** 默认的文本标记。`{name}` 必须有，`{args}` 可以没有（那就是不收参数）。 */
export const DEFAULT_MARKER = "[工具:{name} {args}]";

/**
 * 角色上那几个额度的默认值和上下限。和 websearch.js 的 LIMITS 一个路子：
 * 范围只在这里定义，config.js 和界面都跟着它。
 */
export const LIMITS = {
  // 一轮最多往返几趟（模型拿到结果之后还能接着调）
  rounds: { def: 2, min: 1, max: 5 },
  // 一轮总共最多调几次工具
  calls: { def: 3, min: 1, max: 10 },
  // 单个工具结果最多留多少字
  chars: { def: 2000, min: 200, max: 8000 },
};

/** 服务器上单次调用的超时（秒）。 */
export const TIMEOUT_LIMITS = { def: 30, min: 5, max: 120 };

/** 文本标记模式下默认的那段提示词。 */
export const DEFAULT_TEXT_PROMPT = [
  "你可以调用下面这些工具去查东西或者办事。需要用的时候，在回复里写：",
  "{{format}}",
  "参数写成 JSON，没有参数就写 {}。一轮最多调用 {{maxCalls}} 次。",
  "写了工具标记就先别回答对方，等拿到结果再正式回话。对方看不到这一趟，也不用跟对方交代你用了工具。",
  "用不上就别用，正常聊天。",
  "",
  "可用的工具：",
  "{{tools}}",
].join("\n");

/** 原生 function calling 模式下默认的那段提示词。工具清单在请求体里，这里只交代规矩。 */
export const DEFAULT_NATIVE_PROMPT = [
  "你可以通过函数调用使用工具去查东西或者办事，一轮最多调用 {{maxCalls}} 次。",
  "对方看不到这一趟，也不用跟对方交代你用了工具。用不上就别调，正常聊天。",
].join("\n");

const isWorker = () => process.env.URANUS_WORKER === "1";

/* ================= 配置规范化（config.js 用） ================= */

/** `[{name, value}]` 形状的键值对，空名字的丢掉。 */
function normalizePairs(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => ({ name: str(p?.name).trim(), value: str(p?.value) }))
    .filter((p) => p.name);
}

/**
 * 全局的 MCP 服务器列表。
 *
 * 默认 enabled 为 true —— 用户既然登记了一台，多半是想用；真正决定「哪个角色
 * 用」的是角色上的勾选，这个开关只是临时停用一台用的。
 */
export function normalizeMcpServers(input) {
  if (!Array.isArray(input)) return [];
  const used = new Set();
  return input
    .filter((s) => s && typeof s === "object")
    .map((s, i) => {
      const id = pickId(s.id, used, "mcp", i);
      used.add(id);
      const transport = TRANSPORTS.includes(s.transport) ? s.transport : "http";
      return {
        id,
        name: str(s.name).trim(),
        enabled: s.enabled !== false,
        transport,
        // http / sse 用
        url: str(s.url).trim(),
        headers: normalizePairs(s.headers),
        // stdio 用。args 一行一个，免得参数里带空格时还要猜引号
        command: str(s.command).trim(),
        args: Array.isArray(s.args) ? s.args.map((a) => str(a)).filter((a) => a !== "") : [],
        env: normalizePairs(s.env),
        cwd: str(s.cwd).trim(),
        timeout: clampInt(s.timeout, TIMEOUT_LIMITS.def, TIMEOUT_LIMITS.min, TIMEOUT_LIMITS.max),
        // 这台服务器上不给模型用的工具（按原名）。测试连接之后在界面上勾
        disabledTools: Array.isArray(s.disabledTools)
          ? [...new Set(s.disabledTools.map((t) => str(t)).filter(Boolean))]
          : [],
      };
    });
}

/**
 * 角色上的 MCP 设置。默认关，理由和 webSearch 一样：开着就意味着每轮
 * 多一段提示词，还会真的往外发请求。
 */
export function normalizeRoleMcp(input) {
  const { rounds, calls, chars } = LIMITS;
  return {
    enabled: Boolean(input?.enabled),
    // 这个角色能用哪几台（服务器 id）。指向已删除的不清理，用的时候跳过
    servers: Array.isArray(input?.servers)
      ? [...new Set(input.servers.map((s) => str(s).trim()).filter(Boolean))]
      : [],
    mode: MODES.includes(input?.mode) ? input.mode : "text",
    // 空 = 用 DEFAULT_MARKER
    marker: str(input?.marker),
    // 空 = 按 mode 用 DEFAULT_TEXT_PROMPT / DEFAULT_NATIVE_PROMPT
    prompt: str(input?.prompt),
    maxRounds: clampInt(input?.maxRounds, rounds.def, rounds.min, rounds.max),
    maxCalls: clampInt(input?.maxCalls, calls.def, calls.min, calls.max),
    maxChars: clampInt(input?.maxChars, chars.def, chars.min, chars.max),
  };
}

/** 这台服务器填全了没有（不管开没开）。 */
export function serverUsable(s) {
  if (!s) return false;
  if (s.transport === "stdio") return Boolean(s.command) && !isWorker();
  return /^https?:\/\//i.test(s.url ?? "");
}

/* ================= 传输层 ================= */

class McpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

const pairsToObject = (pairs) =>
  Object.fromEntries((pairs ?? []).map((p) => [p.name, p.value]));

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSON-RPC 回应 → 结果，或者抛出它带的错误。 */
function unwrap(msg, method) {
  if (msg?.error) {
    const e = msg.error;
    throw new McpError(`${method} 被服务器拒绝：${e.message ?? JSON.stringify(e)}`, {
      rpc: true,
    });
  }
  return msg?.result;
}

function httpError(method, status, text, hadSession) {
  const body = String(text ?? "").replace(/\s+/g, " ").slice(0, 200);
  const hint =
    status === 401 || status === 403
      ? "（鉴权没过，检查请求头里的 token）"
      : status === 404 && !hadSession
        ? "（地址不对？）"
        : "";
  return new McpError(`${method} 返回 HTTP ${status}${hint}${body ? `：${body}` : ""}`, {
    // 会话过期：服务器认不得这个 Mcp-Session-Id 了。这一下请求没被执行，
    // 换条新连接重来是安全的
    reconnect: status === 404 && hadSession,
  });
}

/** `promise` 超时就抛。不负责取消底下的东西 —— 那是调用方各自的事。 */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new McpError(`${what}超过 ${Math.round(ms / 1000)} 秒没回应`, { timeout: true })),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseSseBlock(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** 一段 SSE 响应体里的事件。调用方 break 出去时会把流关掉。 */
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const ev = parseSseBlock(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (ev) yield ev;
      }
    }
    const tail = parseSseBlock(buf);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** 一条或一批 JSON-RPC 消息摊平成数组。 */
const messagesOf = (data) => (Array.isArray(data) ? data : data ? [data] : []);

/** Streamable HTTP：每个请求一次 POST，回 JSON 或者 SSE。 */
class HttpTransport {
  constructor(server) {
    this.url = server.url;
    this.headers = pairsToObject(server.headers);
    this.session = "";
    this.protocol = "";
    this.seq = 0;
  }

  head(extra = {}) {
    return {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}),
      ...extra,
    };
  }

  async request(method, params, ms) {
    const id = ++this.seq;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const hadSession = Boolean(this.session);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.head(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.session = sid;
      if (!res.ok) throw httpError(method, res.status, await res.text().catch(() => ""), hadSession);

      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for await (const ev of sseEvents(res.body)) {
          for (const m of messagesOf(safeJson(ev.data))) {
            if (m?.id === id && ("result" in m || "error" in m)) return unwrap(m, method);
          }
        }
        throw new McpError(`${method} 的回应流断了，没等到结果`);
      }
      const text = await res.text();
      const m = messagesOf(safeJson(text)).find((x) => x?.id === id);
      if (!m) throw new McpError(`${method} 回的不是 JSON-RPC：${text.slice(0, 200)}`);
      return unwrap(m, method);
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw new McpError(`${method} 超过 ${Math.round(ms / 1000)} 秒没回应`, { timeout: true });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method, params) {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.head(),
        body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* 通知丢了不影响后面的请求 */
    }
  }

  close() {
    if (!this.session) return;
    // 告诉服务器这个会话不用了。不等结果，失败也无所谓
    fetch(this.url, { method: "DELETE", headers: this.head() })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

/**
 * 服务器主动发来的请求（ping、roots/list 之类）怎么回。我们什么能力都没声明，
 * 所以除了 ping 一律回「不支持」，免得它那头一直等。
 */
function replyToServer(msg) {
  if (msg.method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
}

/** 两种长连接传输（老式 SSE、stdio）共用的「按 id 等回应」那一套。 */
class Pending {
  constructor() {
    this.map = new Map();
    this.seq = 0;
    this.dead = null;
  }

  /** 先登记再发 —— 有的服务器回得比 POST 本身还快。 */
  open() {
    // 连接早就死了（闲着的时候进程退了、SSE 断了）：这一下还没发出去，
    // 标上 reconnect 让 withClient 换条新连接重来
    if (this.dead) throw new McpError(this.dead.message, { reconnect: true });
    const id = ++this.seq;
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { resolve, reject };
    });
    // 没人 await 之前就被 fail 掉的话，别让 Node 当成未处理的拒绝把进程带走
    promise.catch(() => {});
    this.map.set(id, entry);
    return { id, promise };
  }

  settle(msg) {
    const entry = this.map.get(msg?.id);
    if (!entry || !("result" in msg || "error" in msg)) return false;
    this.map.delete(msg.id);
    entry.resolve(msg);
    return true;
  }

  forget(id) {
    this.map.delete(id);
  }

  fail(err) {
    if (this.dead) return;
    this.dead = err;
    for (const entry of this.map.values()) entry.reject(err);
    this.map.clear();
  }
}

/** 老式 HTTP+SSE：GET 一条长连接，第一个 endpoint 事件告诉我们往哪儿 POST。 */
class SseTransport {
  constructor(server) {
    this.url = server.url;
    this.headers = pairsToObject(server.headers);
    this.pending = new Pending();
    this.endpoint = "";
    this.ctrl = null;
  }

  async start(ms) {
    this.ctrl = new AbortController();
    const res = await withTimeout(
      fetch(this.url, {
        headers: { ...this.headers, Accept: "text/event-stream" },
        signal: this.ctrl.signal,
      }),
      ms,
      "连 SSE "
    );
    if (!res.ok) throw httpError("连接", res.status, await res.text().catch(() => ""), false);

    let gotEndpoint;
    const ready = new Promise((resolve, reject) => {
      gotEndpoint = { resolve, reject };
    });
    ready.catch(() => {});

    (async () => {
      try {
        for await (const ev of sseEvents(res.body)) {
          if (ev.event === "endpoint") {
            this.endpoint = new URL(ev.data.trim(), this.url).href;
            gotEndpoint.resolve();
            continue;
          }
          for (const m of messagesOf(safeJson(ev.data))) {
            if (m?.method && m.id != null) this.post(replyToServer(m)).catch(() => {});
            else this.pending.settle(m);
          }
        }
        throw new McpError("SSE 连接被服务器关掉了");
      } catch (e) {
        const err = this.ctrl.signal.aborted ? new McpError("连接已关闭") : e;
        this.pending.fail(err);
        gotEndpoint.reject(err);
      }
    })();

    await withTimeout(ready, ms, "等服务器给出 POST 地址");
  }

  async post(payload) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw httpError(payload.method ?? "回应", res.status, await res.text().catch(() => ""), false);
    await res.body?.cancel().catch(() => {});
  }

  async request(method, params, ms) {
    const { id, promise } = this.pending.open();
    try {
      await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      return unwrap(await withTimeout(promise, ms, `${method} `), method);
    } finally {
      this.pending.forget(id);
    }
  }

  async notify(method, params) {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => {});
  }

  close() {
    this.ctrl?.abort();
  }
}

/**
 * Windows 上给 cmd 拼命令行时的引号。`npx` 在 Windows 上是 npx.cmd，
 * 不走 shell 起不来，而走 shell 就得自己拼整条命令。
 */
function quoteWin(arg) {
  const s = String(arg);
  return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** stdio：起一个本地进程，一行一条 JSON-RPC。 */
class StdioTransport {
  constructor(server) {
    this.server = server;
    this.pending = new Pending();
    this.child = null;
    this.stderr = "";
  }

  async start() {
    if (isWorker()) {
      throw new McpError("小手机跑在 Cloudflare 上，起不了本地命令（stdio），只能连远程 MCP 地址");
    }
    const { command, args, cwd } = this.server;
    const env = { ...process.env, ...pairsToObject(this.server.env) };
    const opts = { env, windowsHide: true, ...(cwd ? { cwd } : {}) };
    const child =
      process.platform === "win32"
        ? spawn([command, ...args].map(quoteWin).join(" "), { ...opts, shell: true })
        : spawn(command, args, opts);
    this.child = child;

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        for (const m of messagesOf(safeJson(line))) {
          if (m?.method && m.id != null) this.write(replyToServer(m));
          else this.pending.settle(m);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", () => {
      /* 进程退出时写入会 EPIPE，下面 exit 那里统一报 */
    });
    child.on("error", (e) => this.pending.fail(new McpError(`启动不了「${command}」：${e.message}`)));
    child.on("exit", (code, signal) => {
      const tail = this.stderr.trim().split(/\r?\n/).slice(-3).join(" / ");
      this.pending.fail(
        new McpError(`进程退出了（${code ?? signal}）${tail ? `：${tail}` : ""}`, { exited: true })
      );
    });
  }

  write(payload) {
    if (this.pending.dead) throw this.pending.dead;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async request(method, params, ms) {
    const { id, promise } = this.pending.open();
    try {
      this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      return unwrap(await withTimeout(promise, ms, `${method} `), method);
    } finally {
      this.pending.forget(id);
    }
  }

  async notify(method, params) {
    try {
      this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    } catch {
      /* 同 HttpTransport.notify */
    }
  }

  close() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.pending.fail(new McpError("连接已关闭"));
    // Windows 上走了 shell，杀 cmd.exe 杀不到底下的 node，得连进程树一起收
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on(
        "error",
        () => {}
      );
    } else {
      child.kill();
    }
  }
}

/* ================= 客户端 + 连接池 ================= */

class McpClient {
  constructor(server) {
    this.server = server;
    this.transport =
      server.transport === "stdio"
        ? new StdioTransport(server)
        : server.transport === "sse"
          ? new SseTransport(server)
          : new HttpTransport(server);
    this.tools = null;
    this.toolsAt = 0;
    this.lastUsed = Date.now();
    this.info = {};
  }

  async connect() {
    const t = this.transport;
    await t.start?.(CONNECT_TIMEOUT);
    const r = await t.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Uranus", version: "1.0.0" },
      },
      CONNECT_TIMEOUT
    );
    t.protocol = str(r?.protocolVersion) || PROTOCOL_VERSION;
    this.info = r?.serverInfo ?? {};
    await t.notify("notifications/initialized");
  }

  async listTools(force = false) {
    if (!force && this.tools && Date.now() - this.toolsAt < TOOLS_TTL) return this.tools;
    const out = [];
    let cursor;
    // 分页上限是兜底：哪个服务器的 nextCursor 写坏了也不至于死循环
    for (let page = 0; page < 20; page++) {
      const r = await this.transport.request(
        "tools/list",
        cursor ? { cursor } : undefined,
        CONNECT_TIMEOUT
      );
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (t?.name) out.push(t);
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.tools = out;
    this.toolsAt = Date.now();
    return out;
  }

  callTool(name, args) {
    return this.transport.request(
      "tools/call",
      { name, arguments: args ?? {} },
      this.server.timeout * 1000
    );
  }

  close() {
    this.transport.close?.();
  }
}

/** 服务器 id → { sig, ready: Promise<McpClient> } */
const pool = new Map();

/** 连接相关的字段。改了任何一个都得重连，改名字、勾工具不用。 */
function signature(s) {
  return JSON.stringify([s.transport, s.url, s.headers, s.command, s.args, s.env, s.cwd, s.timeout]);
}

let sweeper = null;

/** 闲置太久的连接关掉。池子空了就停。 */
function scheduleSweep() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const [id, slot] of pool) {
      if (slot.client && Date.now() - slot.client.lastUsed > IDLE_MS) {
        slot.client.close();
        pool.delete(id);
      }
    }
    if (!pool.size) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  sweeper.unref?.();
}

function drop(id) {
  const slot = pool.get(id);
  if (!slot) return;
  pool.delete(id);
  slot.client?.close();
}

async function clientFor(server) {
  const sig = signature(server);
  let slot = pool.get(server.id);
  if (slot && slot.sig !== sig) {
    drop(server.id);
    slot = null;
  }
  if (!slot) {
    const client = new McpClient(server);
    slot = { sig, client: null };
    slot.ready = client.connect().then(
      () => {
        slot.client = client;
        return client;
      },
      (e) => {
        client.close();
        if (pool.get(server.id) === slot) pool.delete(server.id);
        throw e;
      }
    );
    pool.set(server.id, slot);
    scheduleSweep();
  }
  const client = await slot.ready;
  client.lastUsed = Date.now();
  // 名字这类不影响连接的字段可能改过，让日志里用新的
  client.server = server;
  return client;
}

/**
 * 拿一条连接干一件事。连接死了（会话过期、进程退出、SSE 断了）**而且这件事
 * 还没被执行**时换一条新连接再试一次；工具执行到一半超时不重试 —— 它可能
 * 已经做完了，再调一次就是做两遍。
 */
async function withClient(server, fn) {
  try {
    return await fn(await clientFor(server));
  } catch (e) {
    if (!e?.reconnect) throw e;
    drop(server.id);
    return await fn(await clientFor(server));
  }
}

/** 服务器在日志和提示词里叫什么。 */
export function serverLabel(s) {
  return s?.name || s?.url || s?.command || s?.id || "MCP";
}

/**
 * 测试一台服务器：连上、握手、列工具。**不用连接池**里的那条 —— 界面上
 * 测的可能是还没保存的配置，测完就关。
 *
 * @returns {Promise<{ok:boolean, ms:number, server?:object, tools?:object[], error?:string}>}
 */
export async function testServer(input) {
  const [server] = normalizeMcpServers([input]);
  const startedAt = Date.now();
  if (!server) return { ok: false, ms: 0, error: "没收到服务器配置" };
  if (server.transport === "stdio" && isWorker()) {
    return { ok: false, ms: 0, error: "小手机跑在 Cloudflare 上，起不了本地命令（stdio），只能连远程 MCP 地址" };
  }
  if (!serverUsable(server)) {
    return {
      ok: false,
      ms: 0,
      error: server.transport === "stdio" ? "还没填命令" : "地址要以 http:// 或 https:// 开头",
    };
  }
  const client = new McpClient(server);
  try {
    await client.connect();
    const tools = await client.listTools(true);
    return {
      ok: true,
      ms: Date.now() - startedAt,
      server: { name: str(client.info?.name), version: str(client.info?.version) },
      tools: tools.map((t) => ({
        name: t.name,
        description: str(t.description).slice(0, 400),
      })),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - startedAt, error: String(e?.message ?? e) };
  } finally {
    client.close();
  }
}

/* ================= 一轮对话里的工具箱 ================= */

/** OpenAI 的函数名只收 [A-Za-z0-9_-]，最长 64。 */
function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
}

/** 入参 schema 兜底成一个 object（有的服务器干脆不给）。 */
function objectSchema(schema) {
  if (schema && typeof schema === "object" && schema.type === "object") return schema;
  return { type: "object", properties: {} };
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 这个角色这一轮能用的工具。角色没开、没勾服务器、服务器全连不上 → null，
 * 这一轮就当没有 MCP（连不上不能让整轮对话失败）。
 *
 * @returns {Promise<null|{mode:string, marker:string, limits:object, tools:object[], byName:Map, prompt:string}>}
 */
export async function roleToolkit(config, role, scope = "MCP") {
  const m = role?.mcp;
  if (!m?.enabled) return null;
  const servers = (config?.mcpServers ?? []).filter(
    (s) => s.enabled && m.servers.includes(s.id) && serverUsable(s)
  );
  if (!servers.length) {
    logWarn(scope, "开了 MCP 工具，但这个角色没勾上能用的服务器，这轮不带工具");
    return null;
  }

  const lists = await Promise.all(
    servers.map(async (s) => {
      try {
        return { s, tools: await withClient(s, (c) => c.listTools()) };
      } catch (e) {
        logWarn(scope, `MCP「${serverLabel(s)}」连不上，这轮不用它的工具`, String(e?.message ?? e));
        return { s, tools: [] };
      }
    })
  );

  const tools = [];
  const byName = new Map();
  for (const { s, tools: list } of lists) {
    for (const t of list) {
      if (s.disabledTools.includes(t.name)) continue;
      // 重名（两台服务器都有个 search）时后来的加个序号
      const base = safeName(t.name);
      let name = base;
      for (let n = 2; byName.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
      const entry = {
        name,
        tool: t.name,
        server: s,
        description: str(t.description),
        schema: objectSchema(t.inputSchema),
      };
      tools.push(entry);
      byName.set(name, entry);
    }
  }
  if (!tools.length) {
    logWarn(scope, "MCP 服务器上一个能用的工具都没有，这轮不带工具");
    return null;
  }

  const kit = {
    mode: m.mode,
    marker: m.marker.trim() || DEFAULT_MARKER,
    limits: { maxRounds: m.maxRounds, maxCalls: m.maxCalls, maxChars: m.maxChars },
    tools,
    byName,
  };
  kit.prompt = buildPrompt(kit, m.prompt);
  logDebug(scope, `这轮带 ${tools.length} 个 MCP 工具（${m.mode === "native" ? "原生调用" : "文本标记"}）`);
  return kit;
}

/** 参数在提示词里的一行：`query（string，必填）搜什么；limit（integer）` */
function describeParams(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const parts = Object.entries(props).map(([k, v]) => {
    const type = Array.isArray(v?.type) ? v.type.join("|") : v?.type ?? (v?.enum ? "enum" : "any");
    const meta = [type, required.has(k) ? "必填" : ""].filter(Boolean).join("，");
    const options = Array.isArray(v?.enum) ? ` 可选：${v.enum.slice(0, 8).join(" / ")}` : "";
    const desc = v?.description ? clip(v.description, MAX_PARAM_DESC) : "";
    return `${k}（${meta}）${desc}${options}`.trim();
  });
  return parts.length ? parts.join("；") : "无";
}

/** 提示词里那份工具清单。 */
function toolList(kit) {
  return kit.tools
    .map((t) => {
      const desc = clip(t.description, MAX_TOOL_DESC) || "（没有说明）";
      return `- ${t.name}：${desc}\n  参数：${describeParams(t.schema)}`;
    })
    .join("\n");
}

/** 标记模板的一个示范，给提示词里的 {{format}} 用。 */
export function markerExample(template, name = "工具名", args = '{"参数名": "值"}') {
  const { pre, mid, post } = compileMarker(template);
  return mid === null ? `${pre}${name}${post}` : `${pre}${name}${mid}${args}${post}`;
}

function buildPrompt(kit, custom) {
  const template =
    String(custom ?? "").trim() || (kit.mode === "native" ? DEFAULT_NATIVE_PROMPT : DEFAULT_TEXT_PROMPT);
  const fill = {
    tools: kit.mode === "native" ? kit.tools.map((t) => t.name).join("、") : toolList(kit),
    format: kit.mode === "native" ? "" : markerExample(kit.marker),
    maxCalls: String(kit.limits.maxCalls),
  };
  let text = template.replace(/\{\{\s*(tools|format|maxCalls)\s*\}\}/g, (_, k) => fill[k]);
  // 文本模式下用户自己写的提示词里漏了 {{tools}}：清单不给的话模型根本不知道有什么可用
  if (kit.mode !== "native" && !/\{\{\s*tools\s*\}\}/.test(template)) {
    text += `\n\n可用的工具：\n${fill.tools}`;
  }
  return text.trim();
}

/**
 * 把工具说明塞进提示词：放在开头那一串 system 之后，第一条对话之前。
 * 不放末尾 —— 预设可能以一条 assistant 预填收尾，插在后面就把预填顶掉了。
 */
export function injectToolPrompt(messages, kit) {
  if (!kit?.prompt) return messages;
  const at = messages.findIndex((m) => m.role !== "system");
  const i = at === -1 ? messages.length : at;
  return [...messages.slice(0, i), { role: "system", content: kit.prompt }, ...messages.slice(i)];
}

/** 原生调用那条路的 `tools` 字段（OpenAI 形状，apitype.js 再翻成各家原生的）。 */
export function openAiTools(kit) {
  return kit.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: clip(t.description, 1000),
      parameters: t.schema,
    },
  }));
}

/* ================= 文本标记 ================= */

/**
 * 标记模板拆成三段：`{name}` 前面、`{name}` 和 `{args}` 之间、最后面。
 * 模板写坏了（没有 {name}、{args} 跑到 {name} 前面、开头是空的）就用默认的 ——
 * 开头那段是用来在原文里找标记的，空着的话满篇都是匹配。
 */
export function compileMarker(template) {
  const t = String(template ?? "").trim();
  const ni = t.indexOf("{name}");
  const ai = t.indexOf("{args}");
  if (ni <= 0 || !t.slice(0, ni).trim() || (ai !== -1 && ai < ni)) {
    return t === DEFAULT_MARKER ? null : compileMarker(DEFAULT_MARKER);
  }
  return {
    pre: t.slice(0, ni),
    mid: ai === -1 ? null : t.slice(ni + 6, ai),
    post: ai === -1 ? t.slice(ni + 6) : t.slice(ai + 6),
  };
}

/** 模板能不能用。界面上提示用 —— 不能用的话实际走的是默认那个。 */
export function markerValid(template) {
  const t = String(template ?? "").trim();
  if (!t) return true;
  const ni = t.indexOf("{name}");
  const ai = t.indexOf("{args}");
  return ni > 0 && Boolean(t.slice(0, ni).trim()) && !(ai !== -1 && ai < ni);
}

// 工具名：字母数字下划线、连字符、点，外加汉字（用户自己的服务器可能起中文名）
const NAME_RE = /^[\w\-.一-鿿]+/;

function skipSpaces(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

/** 参数那段是不是空的或者合法 JSON 对象。 */
function jsonish(text) {
  const t = text.trim();
  if (!t) return true;
  const v = safeJson(t);
  return v !== null && typeof v === "object";
}

/**
 * 按模板在原文里找标记。参数可以是任意 JSON（里面带 `]` 也行）：
 * 结尾那段出现好几次时，取第一个让参数能解析成 JSON 的位置。
 *
 * @returns {{start:number, end:number, name:string, args:string}[]}
 */
export function findMarkers(text, template) {
  const src = String(text ?? "");
  const mk = compileMarker(template);
  if (!mk) return [];
  const pre = mk.pre;
  const midT = mk.mid?.trim() ?? "";
  const postT = mk.post.trim();
  const out = [];
  let from = 0;
  for (;;) {
    const p = src.indexOf(pre, from);
    if (p === -1) break;
    from = p + pre.length;
    let k = skipSpaces(src, p + pre.length);
    const nm = NAME_RE.exec(src.slice(k));
    if (!nm) continue;
    const name = nm[0];
    k += name.length;

    let args = "";
    let end;
    if (mk.mid === null) {
      k = skipSpaces(src, k);
      if (postT && !src.startsWith(postT, k)) continue;
      end = k + postT.length;
    } else {
      k = skipSpaces(src, k);
      if (midT && src.startsWith(midT, k)) k = skipSpaces(src, k + midT.length);
      if (!postT) {
        // 结尾没东西：参数一直到这一行末尾
        const nl = src.indexOf("\n", k);
        end = nl === -1 ? src.length : nl;
        args = src.slice(k, end).trim();
      } else {
        let first = -1;
        let hit = -1;
        for (let c = src.indexOf(postT, k), n = 0; c !== -1 && n < 50; c = src.indexOf(postT, c + 1), n++) {
          if (first === -1) first = c;
          if (jsonish(src.slice(k, c))) {
            hit = c;
            break;
          }
        }
        const c = hit !== -1 ? hit : first;
        if (c === -1) continue;
        args = src.slice(k, c).trim();
        end = c + postT.length;
      }
    }
    out.push({ start: p, end, name, args });
    from = end;
  }
  return out;
}

/** 回复里的工具标记（思维链这种 XML 块里写的不算）。 */
export function parseToolMarkers(text, kit) {
  return findMarkers(stripXmlBlocks(text), kit.marker).map((m) => ({ name: m.name, args: m.args }));
}

/** 发给对方之前把工具标记收掉。角色没开 MCP 时原样返回。 */
export function stripToolMarkers(text, role) {
  const src = String(text ?? "");
  if (!role?.mcp?.enabled) return src.trim();
  const template = role.mcp.marker?.trim() || DEFAULT_MARKER;
  const found = findMarkers(src, template);
  if (!found.length) return src.trim();
  let out = "";
  let cursor = 0;
  for (const m of found) {
    out += src.slice(cursor, m.start);
    cursor = m.end;
  }
  out += src.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/* ================= 执行 ================= */

/** 找工具：先按对外的名字，再按服务器上的原名，最后不分大小写。 */
function lookup(kit, name) {
  if (kit.byName.has(name)) return kit.byName.get(name);
  const lower = name.toLowerCase();
  return (
    kit.tools.find((t) => t.tool === name) ??
    kit.tools.find((t) => t.name.toLowerCase() === lower || t.tool.toLowerCase() === lower) ??
    null
  );
}

/**
 * 参数文本 → 对象。不是 JSON 的话，工具只有一个参数时就当成那一个参数的值
 * （模型写 `[工具:search 今天天气]` 这种很常见），否则报回给模型让它改。
 */
function parseArgs(raw, tool) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const v = safeJson(text);
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  const keys = Object.keys(tool.schema?.properties ?? {});
  if (keys.length === 1) return { [keys[0]]: text.replace(/^["']|["']$/g, "") };
  throw new McpError(`参数不是合法的 JSON 对象：${clip(text, 100)}`);
}

/** tools/call 的结果 → 一段文字。 */
function formatResult(r, maxChars) {
  const parts = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === "text") parts.push(str(c.text));
    else if (c?.type === "image") parts.push(`[一张图片（${c.mimeType ?? "image"}），没法转成文字]`);
    else if (c?.type === "audio") parts.push(`[一段音频（${c.mimeType ?? "audio"}），没法转成文字]`);
    else if (c?.type === "resource") {
      parts.push(str(c.resource?.text) || `[资源] ${str(c.resource?.uri)}`);
    } else if (c?.type === "resource_link") {
      parts.push(`[链接] ${[c.name, c.uri].filter(Boolean).join(" ")}`);
    }
  }
  if (!parts.join("").trim() && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  let text = parts.join("\n").trim() || "（工具没有返回内容）";
  let cut = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…（后面截掉了）`;
    cut = true;
  }
  return { text: r?.isError ? `工具报错：${text}` : text, cut, error: Boolean(r?.isError) };
}

/**
 * 真去调一批工具。并发调，**从不抛错** —— 调不通的那条结果写成一句错误，
 * 照样交还给模型，让它自己决定怎么跟对方说（和搜索「没搜到不算失败」一个道理）。
 *
 * @param {{name:string, args:string|object, id?:string}[]} calls
 * @returns {Promise<{id?:string, name:string, text:string, ok:boolean}[]>}
 */
export async function runToolCalls(kit, calls, scope = "MCP") {
  return Promise.all(
    calls.map(async (call) => {
      const tool = lookup(kit, call.name);
      if (!tool) {
        logWarn(scope, `模型要调一个不存在的工具「${call.name}」`);
        return {
          id: call.id,
          name: call.name,
          ok: false,
          text: `没有叫「${call.name}」的工具。能用的有：${kit.tools.map((t) => t.name).join("、")}`,
        };
      }
      const label = `${serverLabel(tool.server)} / ${tool.tool}`;
      const startedAt = Date.now();
      let args;
      try {
        args = parseArgs(call.args, tool);
        const r = await withClient(tool.server, (c) => c.callTool(tool.tool, args));
        const { text, cut, error } = formatResult(r, kit.limits.maxChars);
        logInfo(
          scope,
          `MCP 调用 ${label}${error ? "（工具报错）" : ""}，${Date.now() - startedAt}ms，结果 ${text.length} 字` +
            `${cut ? `（已按 ${kit.limits.maxChars} 字截断）` : ""}，只注入这一次`,
          `参数：${JSON.stringify(args)}\n\n${text}`
        );
        return { id: call.id, name: tool.name, ok: !error, text };
      } catch (e) {
        const why = String(e?.message ?? e);
        logWarn(scope, `MCP 调用 ${label} 失败`, `参数：${JSON.stringify(args ?? call.args)}\n\n${why}`);
        return { id: call.id, name: tool.name, ok: false, text: `调用失败：${why}` };
      }
    })
  );
}

/** 文本标记模式下，工具结果拼成的那条 user 消息。 */
export function textResultsNote(results, { final }) {
  const body = results.map((r) => `[${r.name}]\n${r.text}`).join("\n\n");
  const next = final
    ? "现在正式回答对方，别再写工具标记。"
    : "还需要的话可以接着调用；不需要就正式回答对方。";
  return (
    `<工具结果>\n${body}\n</工具结果>\n\n上面是刚才工具返回的结果。${next}` +
    "结果里没提到的别硬说，也不用跟对方交代你用过工具。" +
    "照你原来的格式回答（预设里要求的思考块、气泡分隔这些照旧写，别因为这段资料就省掉）。"
  );
}

/** 原生调用模式下，工具结果之后补的那句提醒。 */
export function nativeFollowNote({ final }) {
  return (
    (final ? "工具额度用完了，现在正式回答对方，别再调用工具。" : "") +
    "照你原来的格式回答（预设里要求的思考块、气泡分隔这些照旧写，别因为工具结果就省掉）。"
  );
}
