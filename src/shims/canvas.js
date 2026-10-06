/**
 * `@napi-rs/canvas` 在小手机上的替身：只够 transferlogo.js:renderLogo 用。
 *
 * 真的那个是 skia 原生模块，Worker 跑不了。renderLogo 用到的就这几样：
 * `loadImage(字节)` → `createCanvas(w, h)` → 填底色 → `drawImage` 等比缩放 →
 * `encode("jpeg", 质量)`。这里用纯 JS 各做一遍，桌面版代码一行不用改。
 *
 * 能吃什么：
 *
 *  - **PNG**：自己解（zlib 交给 Worker 自带的 DecompressionStream）。控制台在小手机上
 *    传 logo 时会先在浏览器里转成 PNG（role.jsx:RoleTransferLogoPicker），所以
 *    这是主路。
 *  - **JPEG**：交给 jpeg-js。
 *  - **SVG**：画不了，只认 sync-core 在桌面上预先渲好的那几个自带 logo（按
 *    shims/svgkey.js 的指纹查 core/assets.js 里的 LOGO_BITMAPS）。用户自己以前传的
 *    SVG 会报一句「重新传一次」的错，renderLogo 接住后这张卡片不带图照发。
 *  - WebP 不认，报错同上。
 */

import jpeg from "jpeg-js";

import { LOGO_BITMAPS } from "../../core/assets.js";
import { svgKey } from "./svgkey.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 一张解好的图：`width/height` 是对外报的尺寸，`bmp` 是实际像素（RGBA）。 */
class Image {
  constructor(width, height, bmp) {
    this.width = width;
    this.height = height;
    this.bmp = bmp;
  }
}

/** 解好的自带 logo，按指纹缓存。一个 logo 一次。 */
const builtinCache = new Map();

export async function loadImage(src) {
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
  if (PNG_SIG.every((b, i) => bytes[i] === b)) {
    const bmp = await decodePng(bytes);
    return new Image(bmp.w, bmp.h, bmp);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const r = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
    return new Image(r.width, r.height, { w: r.width, h: r.height, data: r.data });
  }

  const head = new TextDecoder().decode(bytes.subarray(0, 2048));
  if (/<svg\b/i.test(head) || /^\s*<\?xml/i.test(head)) {
    const key = svgKey(new TextDecoder().decode(bytes));
    const pre = LOGO_BITMAPS[key];
    if (!pre) {
      throw new Error("小手机画不了自己传的 SVG。在控制台把这个 logo 删掉重新传一次，会自动转成 PNG");
    }
    let bmp = builtinCache.get(key);
    if (!bmp) {
      bmp = await decodePng(Uint8Array.from(atob(pre.png), (c) => c.charCodeAt(0)));
      builtinCache.set(key, bmp);
    }
    // 对外报 skia 会报的那个尺寸，renderLogo 的缩放算式才和桌面版一致；像素是预先缩好的
    return new Image(pre.w, pre.h, bmp);
  }

  throw new Error("小手机只认 PNG / JPG 的 logo。在控制台把它删掉重新传一次，会自动转成 PNG");
}

export function createCanvas(w, h) {
  return new Canvas(w, h);
}

class Canvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this.ctx = new Context2D(this);
  }

  getContext() {
    return this.ctx;
  }

  async encode(type, quality = 92) {
    if (type !== "jpeg") throw new Error(`小手机的 canvas 只会编 jpeg，不会 ${type}`);
    const out = jpeg.encode({ data: this.data, width: this.width, height: this.height }, quality);
    return out.data;
  }
}

class Context2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000000";
  }

  fillRect(x, y, w, h) {
    const [r, g, b] = parseHex(this.fillStyle);
    const { width, height, data } = this.canvas;
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) {
        const o = (yy * width + xx) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
  }

  /**
   * 把整张图缩放画到 (dx, dy, dw, dh)，盖在底色上。
   *
   * 缩小时按面积平均（每个目标像素取它盖住的那一片源像素的均值），放大时就近取。
   * renderLogo 只缩不放，所以主要是前者。按预乘 alpha 算，透明边缘不会发黑。
   */
  drawImage(img, dx, dy, dw, dh) {
    const { w: sw, h: sh, data: src } = img.bmp;
    const { width, height, data: dst } = this.canvas;
    const fx = sw / dw;
    const fy = sh / dh;
    for (let y = 0; y < dh; y += 1) {
      const ty = dy + y;
      if (ty < 0 || ty >= height) continue;
      const y0 = Math.floor(y * fy);
      const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * fy)));
      for (let x = 0; x < dw; x += 1) {
        const tx = dx + x;
        if (tx < 0 || tx >= width) continue;
        const x0 = Math.floor(x * fx);
        const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * fx)));

        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let sy = y0; sy < y1; sy += 1) {
          for (let sx = x0; sx < x1; sx += 1) {
            const o = (sy * sw + sx) * 4;
            const al = src[o + 3];
            r += src[o] * al;
            g += src[o + 1] * al;
            b += src[o + 2] * al;
            a += al;
            n += 1;
          }
        }
        if (!a) continue;
        const alpha = a / n / 255;
        const o = (ty * width + tx) * 4;
        // r/a 是去预乘后的颜色，再按平均 alpha 叠到底色上
        dst[o] = (r / a) * alpha + dst[o] * (1 - alpha);
        dst[o + 1] = (g / a) * alpha + dst[o + 1] * (1 - alpha);
        dst[o + 2] = (b / a) * alpha + dst[o + 2] * (1 - alpha);
        dst[o + 3] = 255;
      }
    }
  }
}

function parseHex(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? ""));
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ── PNG ── */

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PNG → RGBA。认 8 / 16 位的灰度、RGB、灰度+透明、RGBA，以及 1/2/4/8 位的调色板
 * 和灰度（带 tRNS 透明）。不认隔行扫描（浏览器转出来的从来不是）。
 */
async function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const name = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (name === "IHDR") {
      w = view.getUint32(16);
      h = view.getUint32(20);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) throw new Error("隔行扫描的 PNG 小手机解不了，重新传一次会自动转好");
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") trns = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
  }
  if (!w || !h) throw new Error("这个 PNG 读不出尺寸");
  if (w * h > 16_000_000) throw new Error(`这个 PNG 太大了（${w}×${h}）`);

  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  const raw = await inflate(joined);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`不认识的 PNG 颜色类型 ${type}`);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((w * bitsPerPixel) / 8);

  // 反滤波
  const pix = new Uint8Array(stride * h);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pix.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pix.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v;
    }
  }

  // 取第 n 个样本（按位深），统一折成 0~255
  const sample = (row, n) => {
    if (depth === 8) return row[n];
    if (depth === 16) return row[n * 2];
    const bit = n * depth;
    const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  // 灰度 / RGB 的 tRNS 是「这个颜色当透明」，按原始样本值比
  const rawSample = (row, n) => {
    if (depth === 16) return (row[n * 2] << 8) | row[n * 2 + 1];
    if (depth === 8) return row[n];
    const bit = n * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const trnsVal = (i) => (trns ? (trns[i * 2] << 8) | trns[i * 2 + 1] : -1);

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const row = pix.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const s = x * channels;
      if (type === 6) {
        data[o] = sample(row, s);
        data[o + 1] = sample(row, s + 1);
        data[o + 2] = sample(row, s + 2);
        data[o + 3] = sample(row, s + 3);
      } else if (type === 2) {
        data[o] = sample(row, s);
        data[o + 1] = sample(row, s + 1);
        data[o + 2] = sample(row, s + 2);
        const hit =
          trns &&
          rawSample(row, s) === trnsVal(0) &&
          rawSample(row, s + 1) === trnsVal(1) &&
          rawSample(row, s + 2) === trnsVal(2);
        data[o + 3] = hit ? 0 : 255;
      } else if (type === 4) {
        data[o] = data[o + 1] = data[o + 2] = sample(row, s);
        data[o + 3] = sample(row, s + 1);
      } else if (type === 0) {
        data[o] = data[o + 1] = data[o + 2] = sample(row, s);
        data[o + 3] = trns && rawSample(row, s) === trnsVal(0) ? 0 : 255;
      } else {
        const i = sample(row, s);
        if (!palette || i * 3 + 2 >= palette.length) throw new Error("这个 PNG 的调色板不完整");
        data[o] = palette[i * 3];
        data[o + 1] = palette[i * 3 + 1];
        data[o + 2] = palette[i * 3 + 2];
        data[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  }
  return { w, h, data };
}
