/**
 * 小剧场：主线之外的番外、脑洞，让模型写成一份完整的 HTML 页面。
 *
 * 从用户自己的 AstrBot 插件 astrbot_plugin_html_theater 搬过来的，功能对应：
 *
 *  - 模板目录（标题 + 提示词，{{char}} / {{user}} 照常替换），首次自带三个默认模板
 *  - 生成：选角色 + 模板（或者临时写一段提示词），人设用 Uranus 里这个角色的人设
 *    和它对应的用户人设 —— 插件那边的「Persona 页面配置」在这里就是角色本身
 *  - **世界书**：插件没有，这里加上。可选的是这个角色关联的那几本（挂在角色上的 +
 *    全局的），每个角色上次勾了哪几本记在 state 里
 *  - 空回 / HTML 没闭合时最多补救三次，仍然不完整就不存残缺文件
 *  - 成品：预览、收藏、删除、重试（同一份快照再生成一次）、线性续写章节、
 *    超过保留数量时删最旧的未收藏成品
 *  - 可选注入这个角色最近的聊天记录
 *
 * 和插件不一样的地方：
 *
 *  - **不开独立端口。** 成品走 `/api/theater/plays/:id/html`，控制台里用沙箱
 *    iframe 预览 / 新标签页打开（见 client/src/panels/theater.jsx）。小手机上
 *    也一样能用。
 *  - **生成是后台任务。** 一次要几分钟，HTTP 请求干等着会撞上各种代理的超时
 *    （Cloudflare 是 100 秒），所以 POST 只返回一个任务 id，前端轮询。
 *  - 超时用户自己定，默认 180 秒（config.theater.timeout）。
 *  - QQ 白名单、指令、备份 ZIP、面板配色这些插件里跟 AstrBot 绑着的东西不搬：
 *    Uranus 有自己的登录、备份和界面。「生成后注入当前会话」也先不搬。
 *
 * 数据：data/theater/state.json + data/theater/html/<id>.html（见 datadir.js）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyVars, resolveEndpoint, resolveUser } from "./config.js";
import { THEATER_DIR, THEATER_HTML_DIR, readJson, writeJson } from "./datadir.js";
import { chatCompletion } from "./llm.js";
import { logError, logInfo, logWarn } from "./logs.js";
import { listSessions, recentMessages } from "./sessions.js";
import { activate, worldBooksFor } from "./worldinfo.js";

const STATE_PATH = path.join(THEATER_DIR, "state.json");
const SCOPE = "小剧场";

/** 插件自带的三个默认模板，原样搬过来。只在第一次（还没有 state.json）时种进去。 */
const DEFAULT_TEMPLATES = [
  {
    title: "假如是X上的网H博主小剧场",
    prompt:
      "{{char}}会想和{{user}}拍摄什么题材影片，粉丝受众都是哪些？" +
      "如果要拍一部{{char}}最喜欢的play，{{char}}想用什么标题？" +
      "会带什么tag？拍摄内容是什么呢？假如想要以" +
      "【“乖巧的小狗喜欢daddy的🍆”】为标题，你会想怎么拍？",
  },
  {
    title: "同人小剧场",
    prompt: "模仿网上火热的同人女风格，允许参考的页面：bilibili混剪、lofter、AO3、微博、论坛。全文不少于2000字。",
  },
  {
    title: "小红书小剧场",
    prompt: "模仿小红书发贴的内容，讨论{{char}}和{{user}}的感情、八卦等等，全文不少于2000字。",
  },
];

/** 插件的默认系统提示词，原样搬过来。config.theater.systemPrompt 留空时用它。 */
export const DEFAULT_SYSTEM_PROMPT = [
  "你是一个 HTML 小剧场助手，请发挥你的脑洞。",
  "- 只输出一个完整、可独立打开的 HTML 文档。",
  "- 严格按照本次小剧场提示词实现页面；提示词要求的外部图片、CSS、JavaScript、CDN、表单、事件属性和网络行为都可以直接使用。",
  "- 不要自行删除、替换或限制用户提示词要求的资源和交互。",
  "- 根据小剧场内容选择协调的 CSS 风格，并在顶部标记小剧场类型。",
].join("\n");

/** 超时的范围（秒）。config.js 收口用。 */
export const TIMEOUT_LIMITS = { def: 180, min: 30, max: 1800 };

/** 空回 / 截断最多补救几次（和插件一样是三次）。 */
const RESCUE_ATTEMPTS = 3;

const newId = () => crypto.randomBytes(8).toString("hex");

/* ================= 存储 ================= */

function freshState() {
  return {
    templates: DEFAULT_TEMPLATES.map((t) => ({ id: newId(), ...t })),
    plays: [],
    // 角色 id → 上次生成时勾的世界书 id
    roleBooks: {},
  };
}

function loadState() {
  const raw = readJson(STATE_PATH, null);
  if (!raw || typeof raw !== "object") {
    const s = freshState();
    writeJson(STATE_PATH, s);
    return s;
  }
  return {
    templates: Array.isArray(raw.templates) ? raw.templates.filter((t) => t?.id && t.title) : [],
    plays: Array.isArray(raw.plays) ? raw.plays.filter((p) => p?.id) : [],
    roleBooks: raw.roleBooks && typeof raw.roleBooks === "object" ? raw.roleBooks : {},
  };
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

/** 成品 id 只认 16 位十六进制，挡在拼路径之前（`../` 那一类）。 */
const SAFE_ID = /^[0-9a-f]{16}$/;

function htmlPath(id) {
  if (!SAFE_ID.test(String(id))) throw new Error("成品 id 不对");
  return path.join(THEATER_HTML_DIR, `${id}.html`);
}

export function readPlayHtml(id) {
  const file = htmlPath(id);
  if (!fs.existsSync(file)) throw new Error("这个成品的 HTML 文件不见了");
  return fs.readFileSync(file, "utf-8");
}

/** 不重名：已有「X」就叫「X 2」「X 3」…… */
function uniqueTitle(base, taken) {
  const t = String(base || "小剧场").trim() || "小剧场";
  if (!taken.has(t)) return t;
  for (let n = 2; ; n++) if (!taken.has(`${t} ${n}`)) return `${t} ${n}`;
}

/* ================= HTML 工具 ================= */

/** 去掉模型包在外面的 ```html 围栏。 */
export function stripFence(text) {
  return String(text ?? "")
    .replace(/^\s*```(?:html)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** 有 `<html` 开头标签也有 `</html>`，才算一份完整的文档。 */
export function isCompleteHtml(text) {
  const t = stripFence(text);
  return /<html(?:\s|>)/i.test(t) && /<\/html\s*>/i.test(t);
}

/** 粗略抽出页面里看得见的字，给列表摘要和搜索用。不求精确。 */
export function htmlText(html) {
  return String(html ?? "")
    .replace(/<(script|style|head|noscript|template|svg|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/* ================= 拼请求 ================= */

/** 这个角色最近那条聊天会话（按更新时间）。没有就 null。 */
function latestSessionOf(roleId) {
  return listSessions().find((s) => s.roleId === roleId && s.kind !== "legacy-preset") ?? null;
}

/**
 * 把一次生成要用的东西全部定下来，存成快照 —— 重试、续写都照这份来，
 * 中途改了角色人设或世界书也不影响「重试」拿到的是同一个请求。
 */
function buildSnapshot(config, role, { title, prompt, bookIds }) {
  const settings = config.theater ?? {};
  const user = resolveUser(config, role);
  const vars = { char: role?.name ?? "", user: user?.name ?? "" };
  const fill = (t) => applyVars(String(t ?? ""), vars).trim();

  const templatePrompt = fill(prompt);

  // 世界书：只从这个角色关联的书里挑（挂在角色上的 + 全局的），用户勾了哪几本用哪几本
  const allowed = worldBooksFor(config, role);
  const picked = Array.isArray(bookIds) ? allowed.filter((b) => bookIds.includes(b.id)) : [];

  // 可选：这个角色最近的聊天记录
  let context = [];
  if (settings.injectContext) {
    const s = latestSessionOf(role.id);
    if (s) context = recentMessages(s.id, settings.contextCount ?? 20).filter((m) => m.content.trim());
  }

  // 世界书按「提示词 + 人设 + 最近聊天」扫关键词，常驻条目直接带上
  let world = "";
  if (picked.length) {
    const scan = [
      { role: "user", content: templatePrompt },
      { role: "system", content: fill(role?.description) },
      ...context,
    ];
    const hit = activate(picked, scan);
    world = [hit.before, ...[...hit.depths.values()].map((d) => d.content), hit.after]
      .map((s) => fill(s))
      .filter(Boolean)
      .join("\n\n");
  }

  return {
    title: String(title || "临时小剧场"),
    templatePrompt,
    systemPrompt: String(settings.systemPrompt ?? "").trim() || DEFAULT_SYSTEM_PROMPT,
    stylePrompt: String(settings.stylePrompt ?? "").trim(),
    roleId: role.id,
    charName: vars.char || "Char",
    charPrompt: fill(role?.description),
    userName: vars.user || "User",
    userPrompt: fill(user?.description),
    bookIds: picked.map((b) => b.id),
    bookNames: picked.map((b) => b.name),
    world,
    context,
  };
}

/** 插件 build_generation_messages 的搬运，多了一块世界书。 */
function generationMessages(snap) {
  const system = [snap.systemPrompt];
  if (snap.stylePrompt) system.push(`本次小剧场额外文风要求：\n${snap.stylePrompt}`);
  system.push(
    "The generated HTML is stored and served without content sanitization. " +
      "Follow the user's requested resources, scripts, styles, events, forms, and network behavior literally."
  );

  const messages = [
    { role: "system", content: system.join("\n\n") },
    {
      role: "user",
      content: `小剧场类型：${snap.title}\n\n小剧场提示词：\n${snap.templatePrompt}`,
    },
    ...(snap.context ?? []),
  ];
  if (snap.world) {
    messages.push({
      role: "system",
      content: `以下是这个角色的世界设定，作为创作参考：\n\n${snap.world}`,
    });
  }
  messages.push({ role: "user", content: personaBlock(snap) });
  return messages;
}

/** 人设 + 输出要求，插件里叫「后置注入」的那一条。 */
function personaBlock(snap) {
  const lines = [`char 名字：${snap.charName}`, `user 名字：${snap.userName}`];
  if (snap.charPrompt) lines.push(`char 人设内容：\n${snap.charPrompt}`);
  if (snap.userPrompt) lines.push(`user 人设内容：\n${snap.userPrompt}`);
  return [
    `人物设定（后置注入）：\n${lines.join("\n\n")}`,
    [
      "Return exactly one complete standalone HTML document (单文件) and no explanation.",
      "Implement the theater prompt literally, including external images, stylesheets, scripts, libraries, forms, event attributes, and network-backed behavior when requested.",
      "Do not remove, replace, or restrict resources or interactions requested by the prompt.",
      "Include viewport metadata and support desktop and mobile layouts (桌面端和移动端).",
    ].join("\n"),
  ].join("\n\n");
}

/** 续写：前两条照旧，中间换成原章节 HTML + 续写要求，人设那条放最后。 */
function continuationMessages(snap, sourceHtml, request) {
  const base = generationMessages({ ...snap, context: [] });
  const persona = base.pop();
  return [
    ...base,
    {
      role: "user",
      content: [
        `Original theater type: ${snap.title}`,
        `Original complete HTML:\n${sourceHtml}`,
        `Continuation request:\n${request}`,
        "Return a new complete standalone HTML document that continues the original, with a short recap so it can be read on its own. Keep the characters and style consistent.",
      ].join("\n\n"),
    },
    persona,
  ];
}

/* ================= 调模型 ================= */

/**
 * 打一次（加补救）拿到完整 HTML。空回就原样重打，截断了就让它从断处接着写，
 * 最多补救三次，仍然不完整就抛错 —— 不存残缺文件（插件同一个规矩）。
 */
async function generateHtml(config, messages) {
  const settings = config.theater ?? {};
  const endpoint = resolveEndpoint(config, settings.model);
  if (!endpoint) throw new Error("还没选小剧场用的模型（去「小剧场 → 设置」里选一个，选完记得保存）");

  const timeout = (settings.timeout ?? TIMEOUT_LIMITS.def) * 1000;
  const attempts = 1 + (settings.continueOnEmpty === false ? 0 : RESCUE_ATTEMPTS);
  let working = messages;
  let acc = "";

  for (let i = 0; i < attempts; i++) {
    const piece = stripFence(
      await chatCompletion(endpoint, working, { label: `小剧场（${endpoint.label}）`, timeout })
    );
    if (piece) {
      // 补救那一趟模型整份重写了一遍：用新的，不往后拼
      acc = acc && /<html/i.test(piece) && isCompleteHtml(piece) ? piece : acc + piece;
    }
    if (isCompleteHtml(acc)) return stripFence(acc);
    if (i + 1 >= attempts) break;
    if (acc) {
      logWarn(SCOPE, `HTML 没写完（${acc.length} 字），让模型接着写（第 ${i + 1} 次补救）`);
      working = [
        ...messages,
        { role: "assistant", content: acc },
        {
          role: "user",
          content: "上一次 HTML 在传输中被截断。请从中断处准确续写，不要重复已经输出的部分，只输出剩余 HTML，直到 </html>。",
        },
      ];
    } else {
      logWarn(SCOPE, `模型回了空内容，原样再问一次（第 ${i + 1} 次补救）`);
      working = messages;
    }
  }
  if (!acc.trim()) throw new Error("模型连续返回空内容，已经停了");
  throw new Error(
    settings.continueOnEmpty === false
      ? "模型返回的 HTML 不完整（没有 </html>），没有保存。可以在设置里打开「空回 / 截断补救」"
      : `补救了 ${RESCUE_ATTEMPTS} 次 HTML 还是没写完，没有保存残缺文件`
  );
}

/** 存一个成品，顺手按保留数量清理。 */
function addPlay(config, snap, html, extra = {}) {
  const state = loadState();
  const id = newId();
  const taken = new Set(state.plays.map((p) => p.title));
  const title = extra.title
    ? uniqueTitle(extra.title, taken)
    : (() => {
        // 和插件一样按「角色 + 模板」各自编号：Aki·同人小剧场 1、2、3……
        const base = `${snap.charName}·${snap.title}`;
        let n = 1;
        while (taken.has(`${base} ${n}`)) n++;
        return `${base} ${n}`;
      })();

  fs.mkdirSync(THEATER_HTML_DIR, { recursive: true });
  fs.writeFileSync(htmlPath(id), html, "utf-8");

  const play = {
    id,
    title,
    templateTitle: snap.title,
    roleId: snap.roleId,
    roleName: snap.charName,
    text: htmlText(html).slice(0, 400),
    bytes: html.length,
    favorite: false,
    createdAt: Date.now(),
    sourcePlayId: extra.sourcePlayId ?? "",
    basePlayId: extra.basePlayId ?? id,
    chapter: extra.chapter ?? null,
    // 快照里聊天记录不存：那是隐私数据，而且重试 / 续写时会按当下重新取
    snapshot: { ...snap, context: undefined },
  };
  state.plays.push(play);
  enforceRetention(state, config.theater?.retention ?? 30);
  saveState(state);
  return play;
}

/** 超过保留数量就删最旧的未收藏成品。收藏的不算在清理范围里。 */
function enforceRetention(state, limit) {
  const max = Math.max(1, Number(limit) || 1);
  while (state.plays.length > max) {
    const victim = state.plays
      .filter((p) => !p.favorite)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!victim) break;
    state.plays = state.plays.filter((p) => p.id !== victim.id);
    try {
      fs.unlinkSync(htmlPath(victim.id));
    } catch {
      /* 文件已经没了 */
    }
    logInfo(SCOPE, `超过保留数量（${max}），删掉最旧的未收藏成品「${victim.title}」`);
  }
}

/* ================= 后台任务 ================= */

/** 任务 id → { id, kind, title, status, startedAt, endedAt, playId, error } */
const jobs = new Map();

function startJob(kind, title, run) {
  const job = { id: newId(), kind, title, status: "running", startedAt: Date.now(), endedAt: 0, playId: "", error: "" };
  jobs.set(job.id, job);
  // 只留最近 30 个
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  const done = (async () => {
    try {
      const play = await run();
      job.playId = play.id;
      job.status = "done";
      logInfo(SCOPE, `「${play.title}」生成好了，${Math.round((Date.now() - job.startedAt) / 1000)} 秒`);
      return play;
    } catch (e) {
      job.status = "error";
      job.error = String(e?.message ?? e);
      logError(SCOPE, `「${title}」没能生成`, job.error);
      return null;
    } finally {
      job.endedAt = Date.now();
    }
  })();
  // 不可枚举：面板那边 JSON 序列化任务时不带它。iMessage 指令那条路要等它（waitJob）
  Object.defineProperty(job, "done", { value: done });
  return job;
}

/** 等一个任务跑完。成功给成品记录，失败抛出那句错误。 */
export async function waitJob(job) {
  const play = await job.done;
  if (!play) throw new Error(job.error || "没能生成");
  return play;
}

/* ================= iMessage 指令用 ================= */

export function listTemplates() {
  return loadState().templates;
}

/**
 * 按标题或目录编号（从 1 开始，和「小剧场目录」那份顺序一致）找模板。
 * 和插件一样：编号跟着模板当前的顺序走，删了中间的，后面的编号会往前挪。
 */
export function findTemplate(arg) {
  const s = String(arg ?? "").trim();
  if (!s) return null;
  const list = listTemplates();
  if (/^\d+$/.test(s)) return list[Number(s) - 1] ?? null;
  return list.find((t) => t.title === s) ?? list.find((t) => t.title.toLowerCase() === s.toLowerCase()) ?? null;
}

/** 插件原版的注入提示词。config.theater.injectionPrompt 留空时用它。 */
export const DEFAULT_INJECTION_PROMPT = "[系统提示]这是你的真实经历与内容，请根据你当前人设，直接自然回应用户。";

/** 小剧场正文注入时的字数上限：长篇 HTML 抽出来的字可能上万，整段塞进上下文太亏。 */
const INJECT_MAX_CHARS = 6000;

/**
 * 「生成后注入当前会话」那条消息，照插件 _reaction_request 的格式拼：
 *
 *   注入提示词
 *   [小剧场提示词]
 *   这次的提示词            ← 设置里可以关掉
 *   [小剧场正文]
 *   从 HTML 里抽出来的纯文字（不带 CSS / JS / 标签）
 *
 * 这条会当成用户发来的一轮交给角色回复，和回复一起进会话历史（插件也是这么存的）。
 */
export function reactionPrompt(config, play) {
  const t = config.theater ?? {};
  let text = "";
  try {
    text = htmlText(readPlayHtml(play.id));
  } catch {
    text = String(play.text ?? "");
  }
  if (text.length > INJECT_MAX_CHARS) text = `${text.slice(0, INJECT_MAX_CHARS)}…`;
  const parts = [];
  // 和插件一样：留空 = 不加这一句（默认值在 config.js:normalizeTheater 里填好了）
  const lead = String(t.injectionPrompt ?? DEFAULT_INJECTION_PROMPT).trim();
  if (lead) parts.push(lead);
  const prompt = String(play.snapshot?.templatePrompt ?? "").trim();
  if (t.injectTheaterPrompt !== false && prompt) parts.push("[小剧场提示词]", prompt);
  parts.push("[小剧场正文]", text);
  return parts.join("\n\n");
}

/** 这个角色最近一次生成的成品（「小剧场 重试」用）。 */
export function latestPlayOf(roleId) {
  return (
    loadState()
      .plays.filter((p) => p.roleId === roleId && p.snapshot)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

/* ================= 对外 ================= */

function roleById(config, id) {
  return (config.roles ?? []).find((r) => r.id === id) ?? null;
}

/** 面板要的整份状态。成品不带快照（大，而且前端用不着）。 */
export function publicState(config) {
  const state = loadState();
  return {
    templates: state.templates,
    plays: state.plays
      .map(({ snapshot, ...p }) => ({ ...p, bookNames: snapshot?.bookNames ?? [], prompt: snapshot?.templatePrompt ?? "" }))
      .sort((a, b) => b.createdAt - a.createdAt),
    roleBooks: state.roleBooks,
    jobs: [...jobs.values()].reverse(),
    // 每个角色能选哪几本世界书（挂在角色上的 + 全局的）
    roleBookOptions: Object.fromEntries(
      (config.roles ?? []).map((r) => [r.id, worldBooksFor(config, r).map((b) => ({ id: b.id, name: b.name, global: b.global }))])
    ),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
}

/** 生成一个新成品（模板或临时提示词）。返回任务。 */
export function generate(config, { roleId, templateId, prompt, bookIds }) {
  const role = roleById(config, roleId);
  if (!role) throw new Error("先选一个角色");
  const state = loadState();
  let title = "临时小剧场";
  let text = String(prompt ?? "").trim();
  if (templateId) {
    const t = state.templates.find((x) => x.id === templateId);
    if (!t) throw new Error("这个模板不存在了");
    title = t.title;
    text = t.prompt;
  }
  if (!text) throw new Error("提示词是空的");

  // 记住这个角色这次勾的世界书，下次默认还是这几本。没传（iMessage 指令那条路）
  // 就用上次在面板里勾的
  if (Array.isArray(bookIds)) {
    state.roleBooks[role.id] = bookIds;
    saveState(state);
  }
  const books = Array.isArray(bookIds) ? bookIds : state.roleBooks[role.id] ?? [];

  const snap = buildSnapshot(config, role, { title, prompt: text, bookIds: books });
  logInfo(
    SCOPE,
    `开始生成「${title}」（${role.name}${snap.bookNames.length ? `，世界书：${snap.bookNames.join("、")}` : ""}` +
      `${snap.context.length ? `，带最近 ${snap.context.length} 条聊天` : ""}）`
  );
  return startJob("generate", `${role.name}·${title}`, async () =>
    addPlay(config, snap, await generateHtml(config, generationMessages(snap)))
  );
}

/** 同一份快照再生成一次。聊天记录按当下重新取（快照里没存）。 */
export function retry(config, playId) {
  const play = loadState().plays.find((p) => p.id === playId);
  if (!play?.snapshot) throw new Error("这个成品没有可重试的快照");
  const snap = { ...play.snapshot, context: [] };
  if (config.theater?.injectContext) {
    const s = latestSessionOf(snap.roleId);
    if (s) snap.context = recentMessages(s.id, config.theater.contextCount ?? 20);
  }
  return startJob("retry", play.title, async () =>
    addPlay(config, snap, await generateHtml(config, generationMessages(snap)))
  );
}

/** 线性续写：在这个成品的系列里接下一章。 */
export function continuePlay(config, playId, request) {
  const req = String(request ?? "").trim();
  if (!req) throw new Error("续写要求不能为空");
  const state = loadState();
  const source = state.plays.find((p) => p.id === playId);
  if (!source?.snapshot) throw new Error("这个成品不存在，或者没有快照可以续写");
  const sourceHtml = readPlayHtml(source.id);
  const baseId = source.basePlayId || source.id;
  const base = state.plays.find((p) => p.id === baseId) ?? source;
  const chapter =
    Math.max(0, ...state.plays.filter((p) => (p.basePlayId || p.id) === baseId).map((p) => Number(p.chapter) || 0)) + 1;
  const baseTitle = base.title.replace(/ - 第\d+章$/, "");
  const snap = { ...source.snapshot, continuation: req };
  return startJob("continue", `${baseTitle} - 第${chapter}章`, async () =>
    addPlay(config, snap, await generateHtml(config, continuationMessages(snap, sourceHtml, req)), {
      title: `${baseTitle} - 第${chapter}章`,
      sourcePlayId: source.id,
      basePlayId: baseId,
      chapter,
    })
  );
}

export function saveTemplate({ id, title, prompt }) {
  const t = String(title ?? "").trim();
  const p = String(prompt ?? "").trim();
  if (!t || !p) throw new Error("标题和提示词都要填");
  const state = loadState();
  const others = new Set(state.templates.filter((x) => x.id !== id).map((x) => x.title));
  const existing = id ? state.templates.find((x) => x.id === id) : null;
  if (existing) {
    existing.title = uniqueTitle(t, others);
    existing.prompt = p;
  } else {
    state.templates.push({ id: newId(), title: uniqueTitle(t, others), prompt: p });
  }
  saveState(state);
}

export function deleteTemplate(id) {
  const state = loadState();
  state.templates = state.templates.filter((t) => t.id !== id);
  saveState(state);
}

export function setFavorite(id, favorite) {
  const state = loadState();
  const play = state.plays.find((p) => p.id === id);
  if (!play) throw new Error("这个成品不存在");
  play.favorite = Boolean(favorite);
  saveState(state);
}

export function deletePlay(id) {
  const state = loadState();
  state.plays = state.plays.filter((p) => p.id !== id);
  saveState(state);
  try {
    fs.unlinkSync(htmlPath(id));
  } catch {
    /* 已经没了 */
  }
}

/** 挂到 express 上。index.js 调一次。 */
export function mountTheater(app, loadConfig) {
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req);
      res.json({ ok: true, ...(out ?? {}), state: publicState(loadConfig()) });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  };

  app.get("/api/theater", (_req, res) => res.json(publicState(loadConfig())));
  app.post("/api/theater/generate", wrap((req) => ({ job: generate(loadConfig(), req.body ?? {}) })));
  app.post("/api/theater/plays/:id/retry", wrap((req) => ({ job: retry(loadConfig(), req.params.id) })));
  app.post(
    "/api/theater/plays/:id/continue",
    wrap((req) => ({ job: continuePlay(loadConfig(), req.params.id, req.body?.prompt) }))
  );
  app.post("/api/theater/plays/:id/favorite", wrap((req) => setFavorite(req.params.id, req.body?.favorite)));
  app.delete("/api/theater/plays/:id", wrap((req) => deletePlay(req.params.id)));
  app.post("/api/theater/templates", wrap((req) => saveTemplate(req.body ?? {})));
  app.delete("/api/theater/templates/:id", wrap((req) => deleteTemplate(req.params.id)));

  // 成品 HTML 原文。前端拿去塞进沙箱 iframe（srcdoc），不直接在本站源下打开
  app.get("/api/theater/plays/:id/html", (req, res) => {
    try {
      res.json({ ok: true, html: readPlayHtml(req.params.id) });
    } catch (e) {
      res.status(404).json({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
