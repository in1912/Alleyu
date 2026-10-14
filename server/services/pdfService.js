// PDF 导出（v1.6.1）：服务端 pdfkit 直出可下载文件——用户明确要「直接下载」而不是浏览器打印。
// 中文只认单文件 .ttf/.otf：fontkit 对 .ttc 集合缺 createSubset（实测 msyh.ttc 报
// this.font.createSubset is not a function），所以 Windows 用等线/黑体、Docker/Linux 放
// data/fonts/ 或设 ALLEYU_PDF_FONT。找不到字体抛 NO_FONT（路由回 400，前端回落打印并明说）。
// 排版自己走 marked lexer（h1-3/段落/列表/表格/引用/图片），零浏览器依赖；
// 图片：/api/amap/mapimg/ 直读本地缓存，其余外链 fetch（15s 超时、单图失败不拦整份）。
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { marked } = require('marked');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const A4 = [595.28, 841.89];
const MARGIN = 56;
const CONTENT_W = A4[0] - MARGIN * 2;
const INK = '#2e3a32';
const MUT = '#75816f';
const ACC_D = '#47704f';
const LINE = '#d6dfd3';

let fontCache;
function findFonts() {
  if (fontCache !== undefined) return fontCache;
  const cands = [
    process.env.ALLEYU_PDF_FONT,
    'C:/Windows/Fonts/Deng.ttf', // 等线 regular：Win10/11 标配单文件 TTF，有 Dengb 粗体对
    'C:/Windows/Fonts/simhei.ttf', // 黑体：更老的 Windows 也有（单文件，无粗体对）
    '/usr/share/fonts/opentype/source-han-sans/SourceHanSansCN-Regular.otf',
  ].filter(Boolean);
  // 用户自放字体永远优先于系统猜测（Docker 场景的主路径）
  const userDir = path.join(DATA_DIR, 'fonts');
  try {
    if (fs.existsSync(userDir)) {
      for (const f of fs.readdirSync(userDir)) {
        if (/\.(ttf|otf)$/i.test(f)) cands.unshift(path.join(userDir, f));
      }
    }
  } catch { /* 目录读不了就跳过 */ }
  // .ttc 集合一律排除：fontkit 对它缺 createSubset，等到渲染才崩就晚了
  const ok = cands.filter((p) => !/\.ttc$/i.test(p));
  let regular = null;
  for (const p of ok) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 500 * 1024) { regular = p; break; } // CJK 字体没有小于 500KB 的
    } catch { /* 不存在就下一个 */ }
  }
  fontCache = null;
  if (regular) {
    let bold = process.env.ALLEYU_PDF_FONT_BOLD || '';
    if (!bold && /Deng\.ttf$/i.test(regular)) bold = 'C:/Windows/Fonts/Dengb.ttf'; // 等线的粗体对
    if (!bold || !fs.existsSync(bold)) bold = regular.replace(/Regular/i, 'Bold'); // 思源黑体等命名惯例
    fontCache = { regular, bold: bold !== regular && fs.existsSync(bold) && !/\.ttc$/i.test(bold) ? bold : null };
  }
  return fontCache;
}

// 与 web/src/md.js 同规则的展示清洗（服务端不能 require 前端模块，逻辑保持一致）
function cleanForPdf(raw) {
  let t = String(raw || '');
  t = t.replace(/^>?\s*⚠?️?\s*这是\s*ALLEYU_AI_STUB=1\s*的本地桩输出[^\n]*\n?/gm, '');
  t = t.replace(/<!--\s*alleyu:stub[^\n]*?-->\n?/g, '');
  const lines = t.split('\n');
  const isHeading = (s) => /^#{1,6}\s/.test(s);
  if (lines.length && !isHeading(lines[0])) {
    const hi = lines.findIndex(isHeading);
    if (hi > 0) t = lines.slice(hi).join('\n');
  }
  return t;
}

// ---- 行内样式摊平：strong/link/codespan → runs，pdfkit continued 链式混排 ----
function collectRuns(tokens, style = {}, out = []) {
  for (const t of tokens || []) {
    if (t.type === 'strong') collectRuns(t.tokens, { ...style, bold: true }, out);
    else if (t.type === 'em') collectRuns(t.tokens, style, out);
    else if (t.type === 'link') out.push({ text: t.text || t.href, ...style, color: '#3d6a94', underline: true, link: t.href });
    else if (t.type === 'codespan') out.push({ text: t.text, ...style, color: '#9c5b2f' });
    else if (t.type === 'image') { if (t.text) out.push({ text: `［${t.text}］`, ...style, color: MUT }); }
    else if (t.type === 'br') out.push({ text: ' ', ...style });
    else if (t.text) out.push({ text: t.text, ...style });
  }
  return out.filter((r) => r.text);
}

function emitRuns(doc, F, runs2, opts = {}) {
  for (let i = 0; i < runs2.length; i++) {
    const r = runs2[i];
    doc.font(r.bold && F.bold ? F.bold : F.regular);
    doc.fillColor(r.color || INK);
    const o = { continued: i < runs2.length - 1, underline: !!r.underline, width: opts.width || CONTENT_W };
    if (r.link) o.link = r.link;
    if (opts.x !== undefined) doc.text(r.text, opts.x, opts.y, o);
    else doc.text(r.text, o);
  }
}

// ---- 图片：先收集 token 里的全部 src，统一预载（mapimg 本地直读 / 外链 fetch）----
function collectImageSrcs(tokens, out) {
  for (const t of tokens || []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'image' && t.href) out.push(t.href);
    if (Array.isArray(t.tokens)) collectImageSrcs(t.tokens, out);
    if (Array.isArray(t.items)) for (const it of t.items) collectImageSrcs(it.tokens, out);
  }
  return out;
}

async function loadImages(srcs) {
  const map = {};
  for (const src of srcs) {
    if (map[src] === undefined) {
      map[src] = null;
      try {
        if (src.startsWith('/api/amap/mapimg/')) {
          const p = path.join(DATA_DIR, 'mapimg', src.split('/').pop());
          if (fs.existsSync(p)) map[src] = fs.readFileSync(p);
        } else {
          let u = src;
          if (u.startsWith('/api/amap/photo?u=')) u = decodeURIComponent(u.split('?u=')[1] || '');
          if (!/^https?:\/\//i.test(u)) continue;
          const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
          if (res.ok) {
            const ab = await res.arrayBuffer();
            if (ab.byteLength > 0 && ab.byteLength < 8 * 1024 * 1024) map[src] = Buffer.from(ab);
          }
        }
      } catch { /* 单图失败不拦整份 PDF */ }
    }
  }
  // pdfkit 只支持 PNG/JPEG，其余（gif/webp）跳过
  for (const [k, buf] of Object.entries(map)) {
    if (buf && !(buf[0] === 0x89 && buf[1] === 0x50) && !(buf[0] === 0xff && buf[1] === 0xd8)) map[k] = null;
  }
  return map;
}

function isPngOrJpg(buf) { return buf && ((buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8)); }

// ---- 主入口：markdown → PDF Buffer ----
async function renderGuidePdf(title, markdown) {
  const F = findFonts();
  if (!F) {
    throw Object.assign(new Error('服务器没有可用的中文字体（只认单文件 .ttf/.otf，.ttc 不支持）。Windows 用系统等线/黑体即可；Docker/Linux 请把任一中文 .ttf/.otf 放到 data/fonts/ 目录或设 ALLEYU_PDF_FONT 环境变量。'), { code: 'NO_FONT' });
  }
  const tokens = marked.lexer(cleanForPdf(markdown));
  const images = await loadImages(collectImageSrcs(tokens, []));

  const doc = new PDFDocument({ size: A4, margin: MARGIN, info: { Title: title, Creator: '游巷 Alleyu' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve) => doc.on('end', resolve));

  const ensureSpace = (h) => { if (doc.y + h > doc.page.maxY() - 8) doc.addPage(); };

  // 抬头：标题 + 导出时间 + 分隔线
  doc.font(F.bold || F.regular).fontSize(20).fillColor(ACC_D).text(title, { width: CONTENT_W });
  doc.font(F.regular).fontSize(8.5).fillColor(MUT)
    .text(`由 游巷 Alleyu 导出 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`, { width: CONTENT_W });
  doc.moveDown(0.4);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(1).strokeColor(LINE).stroke();
  doc.moveDown(0.6);

  const para = (runs2, opts = {}) => {
    if (!runs2.length) return;
    ensureSpace(doc.currentLineHeight() * 2);
    doc.font(F.regular).fontSize(10.5);
    emitRuns(doc, F, runs2, opts);
    doc.moveDown(0.25);
  };

  const heading = (tok) => {
    const size = tok.depth === 1 ? 16 : tok.depth === 2 ? 13 : 11.5;
    ensureSpace(60);
    doc.moveDown(0.35);
    doc.font(F.bold || F.regular).fontSize(size).fillColor(ACC_D);
    doc.text(collectRuns(tok.tokens).map((r) => r.text).join(''), { width: CONTENT_W });
    doc.moveDown(0.2);
  };

  const image = (src, alt) => {
    const buf = images[src];
    if (!isPngOrJpg(buf)) {
      doc.font(F.regular).fontSize(9).fillColor(MUT).text(`［${alt || '图片'}未能载入］`, { width: CONTENT_W });
      return;
    }
    try {
      const img = doc.openImage(buf);
      const w = Math.min(CONTENT_W, img.width);
      const h = img.height * (w / img.width);
      ensureSpace(Math.min(h, 480) + 16);
      const drawH = Math.min(h, 480);
      const drawW = w * (drawH / h);
      doc.image(img, MARGIN + (CONTENT_W - drawW) / 2, doc.y, { width: drawW, height: drawH });
      doc.y += drawH + 10;
    } catch { /* 解码失败当未载入 */ }
  };

  const list = (tok, depth) => {
    for (let i = 0; i < (tok.items || []).length; i++) {
      const it = tok.items[i];
      const label = tok.ordered ? `${(tok.start || 1) + i}. ` : '• ';
      doc.font(F.regular).fontSize(10.5).fillColor(INK);
      ensureSpace(doc.currentLineHeight() * 2);
      doc.text(label + collectRuns(it.tokens).map((r) => r.text).join(''), { width: CONTENT_W - depth * 14, indent: depth * 14 });
      // 嵌套列表
      for (const t of it.tokens || []) if (t.type === 'list') list(t, depth + 1);
    }
    doc.moveDown(0.2);
  };

  const table = (tok) => {
    const cols = Math.max(1, (tok.header || []).length);
    const colW = CONTENT_W / cols;
    const fs = 9;
    const rowsCells = [tok.header || [], ...(tok.rows || [])].map((cells) => cells.map((c) => collectRuns(c.tokens)));
    doc.font(F.regular).fontSize(fs);
    for (let ri = 0; ri < rowsCells.length; ri++) {
      const cells = rowsCells[ri];
      // 行高按 CJK 均宽估（宁可偏高也别裁字）
      const rh = Math.max(...cells.map((runs2) => {
        const len = runs2.map((r) => r.text).join('').length;
        const perLine = Math.max(4, Math.floor((colW - 10) / fs));
        return Math.max(1, Math.ceil(len / perLine)) * (fs * 1.4) + 7;
      }), 18);
      ensureSpace(rh + 4);
      const y = doc.y;
      if (ri === 0) doc.rect(MARGIN, y, CONTENT_W, rh).fillColor('#e2ecdf').fill();
      doc.rect(MARGIN, y, CONTENT_W, rh).lineWidth(0.8).strokeColor(LINE).stroke();
      for (let ci = 0; ci < cols; ci++) {
        if (ci > 0) doc.moveTo(MARGIN + ci * colW, y).lineTo(MARGIN + ci * colW, y + rh).lineWidth(0.8).strokeColor(LINE).stroke();
        const cell = cells[ci];
        if (cell && cell.length) {
          const sx = doc.x, sy = doc.y;
          doc.font(F.regular).fontSize(fs);
          emitRuns(doc, F, cell, { x: MARGIN + ci * colW + 5, y: y + 3.5, width: colW - 10 });
          doc.x = sx; doc.y = sy;
        }
      }
      doc.y = y + rh;
    }
    doc.moveDown(0.35);
  };

  const blockquote = (tok) => {
    ensureSpace(doc.currentLineHeight() * 2);
    doc.font(F.regular).fontSize(10);
    const y0 = doc.y;
    doc.x = MARGIN + 12;
    emitRuns(doc, F, collectRuns(tok.tokens), { width: CONTENT_W - 12 });
    const y1 = doc.y;
    doc.x = MARGIN;
    doc.moveTo(MARGIN + 3, y0 - 2).lineTo(MARGIN + 3, y1).lineWidth(2.5).strokeColor('#5c8a6a').stroke();
    doc.moveDown(0.25);
  };

  const walk = (ts) => {
    for (const t of ts) {
      if (t.type === 'heading') heading(t);
      else if (t.type === 'paragraph') {
        // 独立成段的图片按块渲染（封面地图/路线图都是这种形态）
        const imgs = (t.tokens || []).filter((x) => x.type === 'image');
        const rest = (t.tokens || []).filter((x) => x.type !== 'image');
        for (const im of imgs) image(im.href, im.text);
        if (rest.some((x) => x.type !== 'space')) para(collectRuns(rest));
      } else if (t.type === 'list') list(t, 0);
      else if (t.type === 'table') table(t);
      else if (t.type === 'blockquote') blockquote(t);
      else if (t.type === 'hr') {
        ensureSpace(20);
        doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
        doc.moveDown(0.35);
      } else if (t.type === 'code') {
        ensureSpace(20 * Math.min((t.text || '').split('\n').length, 20));
        doc.font(F.regular).fontSize(9).fillColor('#57604f');
        for (const line of String(t.text || '').split('\n').slice(0, 200)) doc.text(line, { width: CONTENT_W });
        doc.moveDown(0.25);
      } else if (t.type === 'space') { /* 跳过 */ }
    }
  };
  walk(tokens);

  // 页脚页码（switchToPage 回写所有页）
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(F.regular).fontSize(8).fillColor(MUT)
      .text(`游巷 Alleyu · 第 ${i + 1} / ${range.start + range.count} 页`, MARGIN, A4[1] - 34, { width: CONTENT_W, align: 'center', lineBreak: false });
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

module.exports = { renderGuidePdf, findFonts };
