/**
 * NovelAI 生图：请求体怎么拼、回来的 zip 怎么拆。
 *
 * 发请求、重试、报错这些和别家共用一套，在 media.js:novelaiImage 里；
 * 这个文件只放「NovelAI 自己的形状」，没有网络、没有文件读写，
 * 小手机（Worker）和桌面版跑的是同一份。
 *
 * ── 接口 ──
 *
 *   POST {根}/ai/generate-image
 *   Authorization: Bearer pst-…（NovelAI 网页 → 设置 → Account → Get Persistent API Token）
 *   回来是一个 zip，里面一张 image_0.png
 *
 * 官方地址是 image.novelai.net。老的 api.novelai.net 不认 V4 以后的模型
 * （400「model must be a valid enum value」）。走中转站就把根换成中转站的。
 *
 * ── 请求体 ──
 *
 * 官方没有公开文档，下面是照网页端抓的包对出来的。几条踩过的坑：
 *   - V4 以后的模型**必须**带 `v4_prompt` 和 `v4_negative_prompt`，少了回的是
 *     500，不是 400，看着像服务器挂了；
 *   - 提示词要写三遍：`input`、`parameters.prompt`、`v4_prompt.caption.base_caption`；
 *   - Opus 会员免费出图（不扣 Anlas）的条件：一张、总像素 ≤ 1024×1024、
 *     ≤ 28 步、不带参考图。下面的默认值全按这条卡着，图生图那条除外。
 */

/**
 * 「获取模型列表」给的清单。NovelAI 没有列模型的接口，只能写死。
 * 新的在前 —— 弹窗里从上往下挑。
 */
export const NOVELAI_MODELS = [
  "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full",
  "nai-diffusion-4-curated-preview",
  "nai-diffusion-3",
  "nai-diffusion-furry-3",
];

export const NOVELAI_DEFAULT_URL = "https://image.novelai.net";

/**
 * 用户可能把整条接口地址贴进来（`…/ai/generate-image`），剥回根上。
 */
export function novelaiRoot(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/ai\/generate-image$/i, "")
    .replace(/\/+$/, "");
}

/**
 * 比例档位 → 像素。config.js:IMAGE_RATIOS 那几档的 key。
 *
 * 不用那张表里的 `size`：那是照 gpt-image 的下限凑的，NovelAI 要的是 64 的
 * 倍数、总像素不超过 1024×1024（超了 Opus 也要扣 Anlas）。下面每一档都卡在
 * 这条线以内。没选比例就用网页端的默认竖图 832×1216。
 */
const SIZES = {
  "1:1": [1024, 1024],
  "3:4": [896, 1152],
  "4:3": [1152, 896],
  "9:16": [768, 1344],
  "16:9": [1344, 768],
};
const DEFAULT_SIZE = [832, 1216];
const MAX_PIXELS = 1024 * 1024;

export function novelaiSize(ratioKey) {
  return SIZES[ratioKey] ?? DEFAULT_SIZE;
}

/**
 * 照一张参考图的长宽比挑一个尺寸：64 的倍数、总像素不超过 1024×1024。
 *
 * 图生图的时候用 —— 参考图和输出尺寸对不上，NovelAI 会把参考图拉变形。
 */
export function novelaiSizeLike(width, height) {
  if (!(width > 0 && height > 0)) return DEFAULT_SIZE;
  const scale = Math.sqrt(MAX_PIXELS / (width * height));
  let w = Math.max(64, Math.floor((width * scale) / 64) * 64);
  let h = Math.max(64, Math.floor((height * scale) / 64) * 64);
  while (w * h > MAX_PIXELS) {
    if (w >= h) w -= 64;
    else h -= 64;
  }
  return [w, h];
}

/** V3 那两个老模型不认 v4_prompt 那一套。 */
function isV3(model) {
  return /diffusion-(furry-)?3\b/i.test(model);
}

/**
 * 网页端「质量词」开关打开时补在提示词后面的那几个词。API 上的 qualityToggle
 * 只是个记号，不会替你补，得自己拼。
 */
function qualityTags(model) {
  return isV3(model)
    ? "best quality, amazing quality, very aesthetic, absurdres"
    : "very aesthetic, masterpiece, no text";
}

/**
 * 用户没填负面提示词时用的。照网页端 V4.5 的默认那档（Heavy）删短了一点。
 */
export const NOVELAI_DEFAULT_NEGATIVE =
  "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, " +
  "jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, " +
  "screentone, multiple views, logo, too many watermarks, negative space, blank page";

/**
 * 拼请求体。
 *
 * @param {{model:string, prompt:string, negative?:string, width:number, height:number,
 *          seed?:number, image?:string, strength?:number}} req
 *   image 是参考图的 base64（不带 data: 前缀），有它就是图生图
 */
export function novelaiBody({ model, prompt, negative, width, height, seed, image, strength }) {
  const v3 = isV3(model);
  const full = `${prompt}, ${qualityTags(model)}`;
  const uc = String(negative ?? "").trim() || NOVELAI_DEFAULT_NEGATIVE;
  const s = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 4294967295);

  const parameters = {
    params_version: 3,
    width,
    height,
    scale: 5,
    sampler: "k_euler_ancestral",
    steps: 28,
    n_samples: 1,
    seed: s,
    ucPreset: 0,
    qualityToggle: true,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: 0,
    noise_schedule: "karras",
    legacy_v3_extend: false,
    skip_cfg_above_sigma: null,
    use_coords: false,
    characterPrompts: [],
    prompt: full,
    negative_prompt: uc,
    reference_image_multiple: [],
    reference_information_extracted_multiple: [],
    reference_strength_multiple: [],
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
  };
  if (!v3) {
    parameters.v4_prompt = {
      caption: { base_caption: full, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: uc, char_captions: [] },
      legacy_uc: false,
    };
  }
  if (image) {
    parameters.image = image;
    // 0.7 是网页端的默认：大体构图和配色跟着参考图，细节照提示词重画
    parameters.strength = typeof strength === "number" ? strength : 0.7;
    parameters.noise = 0;
    parameters.extra_noise_seed = s;
  }

  return { input: full, model, action: image ? "img2img" : "generate", parameters };
}

/* ================= 回来的 zip ================= */

/**
 * 从 zip 里取第一张图。
 *
 * 不引解压库：走中央目录（不走本地文件头 —— 本地头里的大小可能是 0，
 * 真值在后面的数据描述符里），只认「不压缩」和 deflate 两种。deflate 用
 * DecompressionStream，Node 18+ 和 Worker 都自带。
 *
 * @param {Buffer} buf
 * @returns {Promise<Buffer|null>} 不是 zip、或者里面没东西就返回 null
 */
export async function unzipFirstImage(buf) {
  if (!buf || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;

  // 中央目录结束记录在末尾，后面最多跟 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      size: buf.readUInt32LE(p + 20),
      offset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }

  const hit = entries.find((e) => /\.(png|jpe?g|webp)$/i.test(e.name)) ?? entries[0];
  if (!hit) return null;
  const start = hit.offset + 30 + buf.readUInt16LE(hit.offset + 26) + buf.readUInt16LE(hit.offset + 28);
  const data = buf.subarray(start, start + hit.size);

  if (hit.method === 0) return Buffer.from(data);
  if (hit.method !== 8) throw new Error(`NovelAI 回的 zip 用了不认识的压缩方式（${hit.method}）`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/* ================= 参考图尺寸 ================= */

/**
 * 读一张图的宽高，不解码。认 PNG / JPEG / WebP / GIF，认不出返回 null。
 *
 * 图生图要照参考图的比例挑输出尺寸（novelaiSizeLike），小手机那边没有 ffmpeg
 * 也没有 canvas，只能从文件头里读。
 */
export function imageDims(buf) {
  if (!buf || buf.length < 30) return null;
  // PNG：IHDR 紧跟在 8 字节签名后面
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP：RIFF....WEBP，再看是哪种块
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG：一段段往后跳，找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null;
      const marker = buf[p + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      const len = buf.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
      }
      p += 2 + len;
    }
  }
  return null;
}

/* ================= 中文描述 → 英文 tag ================= */

/** 有中日韩文字就得翻：NovelAI 的文本编码器不认它们，画出来和描述没关系。 */
export function needsTranslation(text) {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(String(text ?? ""));
}

export const NOVELAI_TRANSLATE_PROMPT = [
  "You turn an image description into a prompt for NovelAI Diffusion (an anime-style image model).",
  "Output exactly one line of comma-separated English Danbooru tags, most important first:",
  "subject count (1girl / 1boy / 2girls / no humans …), then appearance, clothing, pose and action,",
  "expression, setting, lighting, framing (close-up, upper body, from above …).",
  "If something cannot be said with tags, add a short plain-English phrase.",
  "Keep every concrete detail from the description. Do not invent people or objects that are not in it.",
  "No explanations, no quotes, no line breaks, no Chinese.",
].join("\n");

/**
 * 收拾翻译模型回的东西：去掉思考段、代码块、换行，留一行 tag。
 */
export function cleanTranslation(text) {
  return String(text ?? "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/```[a-z]*|```/gi, "")
    .replace(/^\s*(prompt|tags)\s*[:：]\s*/i, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}
