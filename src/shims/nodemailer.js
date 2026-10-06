/**
 * 冒充 nodemailer，够 spyphone.js 发一封触发邮件用
 * （`createTransport` + `transporter.sendMail` + `transporter.close`）。
 *
 * Worker 没有给 Node 用的真 TCP，但 `cloudflare:sockets` 有一套够用的原语——
 * 自己手搓一个最小 SMTP 客户端：EHLO → STARTTLS（587 这类）或直连 TLS
 * （465）→ AUTH LOGIN → MAIL FROM / RCPT TO / DATA → QUIT。只认
 * spyphone.js 实际用到的那几个字段，不是通用 SMTP 库。
 *
 * 错误形状尽量对上真正 nodemailer 的 `e.code` / `e.responseCode`——
 * spyphone.js 的 whySmtp() 靠这两个字段挑错误文案给用户看，不用跟着改。
 */
import { connect } from "cloudflare:sockets";

const CRLF = "\r\n";

function smtpError(message, extra) {
  return Object.assign(new Error(message), extra);
}

function b64(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

/** 主题目前只会是固定关键字或偶尔的英文参数；真遇到非 ASCII 就按 UTF-8 Base64 编。 */
function encodeSubject(subject) {
  const s = String(subject ?? "");
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

function withTimeout(promise, ms, code, message) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(smtpError(message, { code })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 连接阶段的错误没有现成的 code，从错误文本里猜一个，给 whySmtp() 认。 */
function codeFromConnectError(e) {
  const msg = String(e?.message ?? e);
  if (/refused/i.test(msg)) return "ECONNREFUSED";
  if (/timed? ?out/i.test(msg)) return "ETIMEDOUT";
  if (/dns|resolve|not found|getaddrinfo/i.test(msg)) return "ENOTFOUND";
  return "ESOCKET";
}

/** 逐行读 SMTP 应答；多行应答（`250-` 续行、`250 ` 收尾）跟到最后一行才算完。 */
class ReplyReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.buf = "";
  }
  async readLine() {
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, "");
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw smtpError("SMTP 连接被对面断开", { code: "ECONNECTION" });
      this.buf += new TextDecoder().decode(value);
    }
  }
  async readReply() {
    let code = 0;
    const lines = [];
    while (true) {
      const line = await this.readLine();
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue; // 有些服务器问候语之外会插无关行，忽略
      code = Number(m[1]);
      lines.push(m[3]);
      if (m[2] === " ") break;
    }
    return { code, text: lines.join("\n") };
  }
}

export function createTransport(opts) {
  const host = String(opts.host);
  const port = Number(opts.port) || 25;
  const secure = Boolean(opts.secure);
  const auth = opts.auth;
  const cTimeout = opts.connectionTimeout;
  const gTimeout = opts.greetingTimeout;
  const sTimeout = opts.socketTimeout;

  let socket = null;

  async function handshake() {
    socket = connect(
      { hostname: host, port },
      { secureTransport: secure ? "on" : "starttls", allowHalfOpen: false }
    );
    try {
      await withTimeout(socket.opened, cTimeout, "ETIMEDOUT", "连接 SMTP 服务器超时");
    } catch (e) {
      throw e?.code ? e : smtpError(String(e?.message ?? e), { code: codeFromConnectError(e) });
    }

    let reader = new ReplyReader(socket.readable);
    let writer = socket.writable.getWriter();
    const send = (line) => writer.write(new TextEncoder().encode(line + CRLF));
    const expect = (ms) => withTimeout(reader.readReply(), ms, "ETIMEDOUT", "等 SMTP 应答超时");

    const greet = await expect(gTimeout);
    if (greet.code !== 220) throw smtpError(`SMTP 服务器问候失败：${greet.text}`, { responseCode: greet.code });

    await send("EHLO uranus-imessage");
    const ehlo = await expect(sTimeout);
    if (ehlo.code !== 250) throw smtpError(`EHLO 失败：${ehlo.text}`, { responseCode: ehlo.code });

    if (!secure) {
      await send("STARTTLS");
      const tlsReply = await expect(sTimeout);
      if (tlsReply.code !== 220) throw smtpError(`STARTTLS 失败：${tlsReply.text}`, { responseCode: tlsReply.code });

      // 升级前把原连接上的读写锁放掉，不然 startTls() 会报流被锁住
      writer.releaseLock();
      reader.reader.releaseLock();

      // 升级成 TLS 连接，EHLO 要在新连接上重来一遍
      socket = socket.startTls();
      reader = new ReplyReader(socket.readable);
      writer = socket.writable.getWriter();
      await send("EHLO uranus-imessage");
      const ehlo2 = await expect(sTimeout);
      if (ehlo2.code !== 250) throw smtpError(`STARTTLS 后 EHLO 失败：${ehlo2.text}`, { responseCode: ehlo2.code });
    }

    if (auth?.user) {
      await send("AUTH LOGIN");
      const r1 = await expect(sTimeout);
      if (r1.code !== 334) throw smtpError(`AUTH LOGIN 没被接受：${r1.text}`, { responseCode: r1.code, code: "EAUTH" });
      await send(b64(auth.user));
      const r2 = await expect(sTimeout);
      if (r2.code !== 334) throw smtpError(`账号被拒：${r2.text}`, { responseCode: r2.code, code: "EAUTH" });
      await send(b64(auth.pass ?? ""));
      const r3 = await expect(sTimeout);
      if (r3.code !== 235) throw smtpError(`认证失败：${r3.text}`, { responseCode: r3.code, code: "EAUTH" });
    }

    return { send, expect };
  }

  return {
    async sendMail(msg) {
      const { send, expect } = await handshake();

      await send(`MAIL FROM:<${msg.from}>`);
      const mf = await expect(sTimeout);
      if (mf.code !== 250) throw smtpError(`MAIL FROM 被拒：${mf.text}`, { responseCode: mf.code });

      await send(`RCPT TO:<${msg.to}>`);
      const rt = await expect(sTimeout);
      if (rt.code !== 250) throw smtpError(`RCPT TO 被拒：${rt.text}`, { responseCode: rt.code });

      await send("DATA");
      const dataReply = await expect(sTimeout);
      if (dataReply.code !== 354) throw smtpError(`DATA 被拒：${dataReply.text}`, { responseCode: dataReply.code });

      const body = [
        `From: ${msg.from}`,
        `To: ${msg.to}`,
        `Subject: ${encodeSubject(msg.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        // 正文里单独一行的 "." 要按 SMTP 的规矩转义成 ".."，否则会被当成结束标记
        String(msg.text ?? "").replace(/^\./gm, ".."),
        ".",
      ].join(CRLF);
      await send(body);
      const sent = await expect(sTimeout);
      if (sent.code !== 250) throw smtpError(`发信被拒：${sent.text}`, { responseCode: sent.code });

      try {
        await send("QUIT");
      } catch {
        // 信已经发出去了，收尾失败不影响结果
      }
    },
    close() {
      try {
        socket?.close();
      } catch {
        // 关闭失败无所谓
      }
    },
  };
}

export default { createTransport };
