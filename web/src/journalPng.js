// 游记 PNG 长图导出（v1.8.0）：纯浏览器 canvas 渲染，零服务端依赖。
// 配色用 journalPalettes.js（与 PDF 服务端 PALETTES 同值）；photo:N 占位换真图 URL 由调用方传入。
// 两遍渲染：先量高（文字换行 + 图片按宽定高），再整图绘制。
export async function renderJournalPng({ title, subtitle, markdown, palette, coverUrl, photoUrls }) {
  const W = 750; // 适合手机端浏览分享的宽度
  const PAD = 34;
  const MAX_H = 32000; // canvas 单边安全上限（32767）留余量
  const p = palette;

  const meas = document.createElement('canvas').getContext('2d');
  const F = (px, weight = 400, italic = false) => `${italic ? 'italic ' : ''}${weight} ${px}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;

  // ---- 预载图片（同源 + token query，不污染 canvas） ----
  const imgCache = new Map();
  async function loadImg(url) {
    if (!url || imgCache.has(url)) return imgCache.get(url) || null;
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    });
    imgCache.set(url, img);
    return img;
  }
  const urlBySort = new Map((photoUrls || []).map((x) => [String(x.sort), x.url]));
  const coverImg = await loadImg(coverUrl);

  // ---- 解析 markdown → 块（标题/段落/引用/列表/图片） ----
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'para', text: para.join('') }); para = []; }
  };
  for (const line of String(markdown || '').split('\n')) {
    const s = line.trim();
    if (!s) { flushPara(); continue; }
    const h = s.match(/^#{1,6}\s+(.*)/);
    const img = s.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (h) { flushPara(); blocks.push({ type: 'head', text: h[1].replace(/[*#]/g, '').trim() }); }
    else if (img) {
      flushPara();
      const src = img[2];
      const url = src.startsWith('photo:') ? urlBySort.get(String(src.slice(6))) : src;
      blocks.push({ type: 'img', url: url || '', alt: img[1] });
    }
    else if (/^>\s?/.test(s)) { flushPara(); blocks.push({ type: 'quote', text: s.replace(/^>\s?/, '') }); }
    else if (/^[-*]\s+/.test(s)) { flushPara(); blocks.push({ type: 'li', text: s.replace(/^[-*]\s+/, '') }); }
    else if (/^\|/.test(s) || /^[-=]{3,}$/.test(s)) { continue; } // 表格线/分隔线不进长图
    else para.push(s);
  }
  flushPara();

  // ---- CJK 按字换行（英文单词尽量不拆） ----
  function wrap(text, font, maxW) {
    meas.font = font;
    const out = [];
    let line = '';
    const pushChar = (ch) => {
      if (meas.measureText(line + ch).width <= maxW) line += ch;
      else { out.push(line); line = ch; }
    };
    for (const seg of String(text || '').split(/(\s+)/)) {
      if (/^\s+$/.test(seg)) { if (line && meas.measureText(line + ' ').width <= maxW) line += ' '; continue; }
      for (const word of seg.split(/(?<=[A-Za-z0-9,.!?;:'")\]])/)) {
        if (meas.measureText(line + word).width <= maxW) line += word;
        else {
          if (line) out.push(line);
          if (meas.measureText(word).width <= maxW) line = word;
          else { line = ''; for (const ch of word) pushChar(ch); }
        }
      }
    }
    if (line) out.push(line);
    return out;
  }

  // ---- 第一遍：量高 ----
  const innerW = W - PAD * 2;
  const headFont = F(21, 700);
  const bodyFont = F(15);
  const quoteFont = F(14, 400, true);
  const liFont = F(15);
  const capFont = F(12.5);
  let y = 0;
  for (const b of blocks) {
    if (b.type === 'head') {
      b.lines = wrap(b.text, headFont, innerW);
      b.h = 30 + b.lines.length * 30;
    } else if (b.type === 'para') {
      b.lines = wrap(b.text, bodyFont, innerW);
      b.h = 14 + b.lines.length * 27;
    } else if (b.type === 'quote') {
      b.lines = wrap(b.text, quoteFont, innerW - 14);
      b.h = 10 + b.lines.length * 24 + 8;
    } else if (b.type === 'li') {
      b.lines = wrap(b.text, liFont, innerW - 16);
      b.h = 4 + b.lines.length * 26;
    } else if (b.type === 'img') {
      const im = b.url ? await loadImg(b.url) : null;
      b.img = im;
      const iw = Math.min(innerW, 620);
      b.iw = iw;
      b.ih = im ? Math.min(480, Math.round(iw * im.naturalHeight / im.naturalWidth)) : 0;
      b.capLines = im && b.alt ? wrap(b.alt, capFont, innerW) : [];
      b.h = (im ? b.ih + 10 : 0) + b.capLines.length * 18 + 14;
      if (!im && b.alt) { // 图没了 → 说明文字顶上
        b.capLines = wrap(b.alt, capFont, innerW);
        b.h = b.capLines.length * 18 + 14;
      }
    }
    y += b.h;
  }

  const coverH = coverImg ? Math.round(W * 0.52) : Math.round(W * 0.3);
  const footerH = 54;
  const titleLines = wrap(title, F(28, 700), innerW - 20);
  const H = coverH + 16 + y + footerH;
  if (H > MAX_H) throw new Error(`内容太长（约 ${Math.round(H / 1000)}k px，上限 ${MAX_H / 1000}k px），删几段或几张图再导`);

  // ---- 第二遍：绘制 ----
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);

  // 封面（照片裁切铺满 + 底部压暗 + 标题/副标题；无图=纯色面）
  if (coverImg) {
    const sc = Math.max(W / coverImg.width, coverH / coverImg.height);
    const dw = coverImg.width * sc;
    const dh = coverImg.height * sc;
    ctx.drawImage(coverImg, (W - dw) / 2, (coverH - dh) / 2, dw, dh);
    const g = ctx.createLinearGradient(0, coverH * 0.35, 0, coverH);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.66)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, coverH);
  }
  ctx.fillStyle = coverImg ? '#fff' : p.acc;
  ctx.fillRect(PAD, coverH - 34 - (titleLines.length * 38 + 30), 38, 5);
  ctx.font = F(28, 700);
  ctx.fillStyle = coverImg ? '#fff' : p.text;
  ctx.shadowColor = coverImg ? 'rgba(0,0,0,0.5)' : 'transparent';
  ctx.shadowBlur = coverImg ? 10 : 0;
  let ty = coverH - 34 - (titleLines.length * 38 + 30) + 5 + 38;
  for (const ln of titleLines) { ctx.fillText(ln, PAD, ty); ty += 38; }
  ctx.shadowBlur = 0;
  ctx.font = F(14);
  ctx.fillStyle = coverImg ? 'rgba(255,255,255,0.92)' : p.sub;
  ctx.fillText(String(subtitle || '').slice(0, 60), PAD, ty + 2);

  // 正文块
  let cy = coverH + 16;
  for (const b of blocks) {
    if (b.type === 'head') {
      ctx.font = headFont;
      ctx.fillStyle = p.acc;
      let ly = cy + 30 - 8;
      for (const ln of b.lines) { ctx.fillText(ln, PAD, ly); ly += 30; }
    } else if (b.type === 'para') {
      ctx.font = bodyFont;
      ctx.fillStyle = p.text;
      let ly = cy + 14 + 15;
      for (const ln of b.lines) { ctx.fillText(ln, PAD, ly); ly += 27; }
    } else if (b.type === 'quote') {
      ctx.fillStyle = p.acc;
      ctx.fillRect(PAD, cy + 10, 3, b.lines.length * 24);
      ctx.font = quoteFont;
      ctx.fillStyle = p.sub;
      let ly = cy + 10 + 17;
      for (const ln of b.lines) { ctx.fillText(ln, PAD + 14, ly); ly += 24; }
    } else if (b.type === 'li') {
      ctx.font = liFont;
      ctx.fillStyle = p.text;
      let ly = cy + 4 + 15;
      let first = true;
      for (const ln of b.lines) {
        if (first) ctx.fillText('·  ' + ln, PAD + 4, ly);
        else ctx.fillText('    ' + ln, PAD + 4, ly);
        first = false;
        ly += 26;
      }
    } else if (b.type === 'img') {
      let iy = cy + 4;
      if (b.img) {
        const ix = (W - b.iw) / 2;
        ctx.save();
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(ix, iy, b.iw, b.ih, 10);
          ctx.clip();
        }
        ctx.drawImage(b.img, ix, iy, b.iw, b.ih);
        ctx.restore();
        iy += b.ih + 10;
      }
      ctx.font = capFont;
      ctx.fillStyle = p.sub;
      ctx.textAlign = 'center';
      for (const ln of b.capLines) { ctx.fillText(ln, W / 2, iy + 13); iy += 18; }
      ctx.textAlign = 'left';
    }
    cy += b.h;
  }

  // 页脚
  ctx.font = F(11);
  ctx.fillStyle = p.sub;
  ctx.textAlign = 'center';
  ctx.fillText(`— ${p.name} · 游巷 Alleyu —`, W / 2, H - 22);
  ctx.textAlign = 'left';

  // ---- 下载 ----
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas 导出失败');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (String(title || '游记').slice(0, 40)) + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
