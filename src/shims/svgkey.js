/**
 * 一份 SVG 的指纹，用来在 Worker 上认出「这是哪个自带 logo」。
 *
 * Worker 上没有 skia，画不了 SVG。自带的那几个 logo 由 sync-core 在桌面上先渲成
 * 位图、按这个指纹存进 core/assets.js；canvas 替身（shims/canvas.js）收到 SVG 字节
 * 时算一遍指纹去查表。
 *
 * 指纹之前先把根标签上的 width / height 摘掉：transferlogo.js:safeSvgBytes 会改写
 * 这两个属性再交给 loadImage，摘掉以后改没改过算出来都一样。摘的两条正则和那边
 * 一字不差，别单独改。
 *
 * sync-core 那边也 import 这个文件，所以它不能 import 任何东西。
 */
export function svgKey(text) {
  let s = String(text ?? "");
  const m = /<svg\b[^>]*>/i.exec(s);
  if (m) {
    const clean = m[0]
      .replace(/\s(width|height)\s*=\s*"[^"]*"/gi, "")
      .replace(/\s(width|height)\s*=\s*'[^']*'/gi, "");
    s = s.slice(0, m.index) + clean + s.slice(m.index + m[0].length);
  }
  // FNV-1a，够区分十来个文件；带上长度再降一档撞车的可能
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}-${h.toString(16).padStart(8, "0")}`;
}
