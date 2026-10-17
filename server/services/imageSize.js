// v1.12.0 从图片字节里读像素尺寸（纯函数，零依赖，自检可直接 require）。
// 存在意义：游记编辑页要「看到图片的大小」——上传那一刻就有尺寸，不必等浏览器把图加载完。
// 只读文件头，不解码像素；读不出来就回 null（调用方据此拒绝损坏文件 / 显示「尺寸未知」），绝不抛。
const MIN = 1;
const MAX = 20000;

function plausible(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < MIN || h < MIN || w > MAX || h > MAX) return null;
  return { width: w, height: h };
}

function pngMeta(buf) {
  if (buf.length < 24) return null;
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  return plausible(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function jpegMeta(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xda || m === 0xd9) break; // 扫描数据开始 / 图片结束，后面不会再有 SOF
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0/1/2/3, SOF5/6/7, SOF9/10/11, SOF13/14/15（C4/C8/CC 是别的段，别误认）
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return plausible(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)); // 宽在 +7、高在 +5
    }
    i += 2 + len;
  }
  return null;
}

function webpMeta(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  const p = 20; // payload 起点（12 字节 RIFF 头 + 8 字节 chunk 头）
  if (buf.length < p + 10) return null;
  if (chunk === 'VP8 ') {
    if (!(buf[p + 3] === 0x9d && buf[p + 4] === 0x01 && buf[p + 5] === 0x2a)) return null;
    return plausible(buf.readUInt16LE(p + 6) & 0x3fff, buf.readUInt16LE(p + 8) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (buf[p] !== 0x2f) return null;
    const b = buf.readUInt32LE(p + 1);
    return plausible((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    const w = (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16)) + 1;
    const h = (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16)) + 1;
    return plausible(w, h);
  }
  return null;
}

function imageMeta(buf) {
  if (!buf || !buf.length) return null;
  try {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return pngMeta(buf);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return jpegMeta(buf);
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF') return webpMeta(buf);
  } catch { /* 畸形文件读越界 → 当作读不出来 */ }
  return null;
}

function isWebp(buf) {
  return !!buf && buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

module.exports = { imageMeta, isWebp };
