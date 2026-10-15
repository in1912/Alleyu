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

// ==================== v1.8.0 游记 PDF ====================
// 与攻略 PDF 分开实现（攻略版 12 条 check 依赖，不动它）：差异在
//  - 莫兰迪配色 5 套（页面底色不再白纸，文字/强调色跟配色走）
//  - 封面：用户照片 + 标题压图 + 副标题（基础信息一行）
//  - 两种规格：mode=a4（A4 分页打印用）/ mode=long（纯图不分页、单页长条，网络分享用）
//    long 用两遍渲染：先在 14400pt（PDF 页高上限）的量高页上排版取最终 y，再按实测高度出真页。
//  - 正文图片占位 photo:N 由路由换成 {src:Buffer} 传进 extraImages。
const PALETTES = [
  { name: '雾灰绿', bg: '#E8E6DF', text: '#3D4038', sub: '#7A8073', acc: '#5A6650' },
  { name: '豆沙粉', bg: '#EFE6E4', text: '#4A3F3D', sub: '#9A8783', acc: '#A5645C' },
  { name: '灰蓝', bg: '#E3E8EB', text: '#37424C', sub: '#7C8A96', acc: '#6E8CA0' },
  { name: '暖沙', bg: '#EDE4D6', text: '#4A4234', sub: '#94886F', acc: '#A98D5F' },
  { name: '燕麦紫', bg: '#E9E5EC', text: '#3F3A45', sub: '#8B8494', acc: '#8B7F96' },
];

function paletteOf(n) { return PALETTES[Math.min(PALETTES.length, Math.max(1, Number(n) || 1)) - 1]; }

async function renderJournalPdf({ title, subtitle, markdown, palette = 1, mode = 'a4', coverBuf = null, extraImages = {} }) {
  const F = findFonts();
  if (!F) {
    throw Object.assign(new Error('服务器没有可用的中文字体（只认单文件 .ttf/.otf，.ttc 不支持）。Windows 用系统等线/黑体即可；Docker/Linux 请把任一中文 .ttf/.otf 放到 data/fonts/ 目录或设 ALLEYU_PDF_FONT 环境变量。'), { code: 'NO_FONT' });
  }
  const P = paletteOf(palette);
  const tokens = marked.lexer(cleanForPdf(markdown));
  const srcs = collectImageSrcs(tokens, []);
  for (const s of srcs) if (extraImages[s]) continue; // extraImages 优先，其余按外链规则
  const images = { ...extraImages };
  for (const [k, v] of Object.entries(await loadImages(srcs))) if (v) images[k] = v;

  const W = A4[0];
  const M = MARGIN; // 与攻略版同边距
  const CW = W - M * 2;
  const LONG_MAX_H = 14400; // PDF 规范页高上限（200in）

  // 布局引擎：跑在给定 doc 上，返回最终 y（量高遍与出真页遍共用，输入相同结果相同）
  function layout(doc, pageH) {
    const isLong = mode === 'long';
    const maxH = isLong ? pageH - M : A4[1] - M;
    const ensure = (h) => { if (!isLong && doc.y + h > doc.page.maxY() - 8) doc.addPage(); };
    // 页面底色（long 模式整页一次性铺；a4 模式每页铺）
    const paintBg = () => doc.rect(0, 0, doc.page.width, doc.page.height).fill(P.bg);
    paintBg();
    const onPageAdded = () => paintBg();
    doc.on('pageAdded', onPageAdded);

    // 封面块：照片（宽满版心、按比例）+ 底部渐变替代=深色半透明条 + 标题/副标题
    let coverH = 0;
    if (coverBuf && isPngOrJpg(coverBuf)) {
      try {
        const img = doc.openImage(coverBuf);
        const w = CW, h = Math.min(360, img.height * (w / img.width));
        doc.image(img, M, M, { width: w, height: h });
        coverH = h + 6;
        // 标题压图：图底部一条 accent 半透明带（opacity 0.82）+ 白字
        const bandH = 46;
        doc.save().opacity(0.82).rect(M, M + h - bandH, w, bandH).fill(P.acc).restore();
        doc.fillColor('#ffffff');
        doc.font(F.bold || F.regular).fontSize(17);
        doc.text(title || '旅行游记', M + 16, M + h - bandH + 12, { width: w - 32, lineBreak: false });
      } catch { /* 封面失败继续正文 */ }
    } else {
      coverH = 0;
    }
    doc.y = M + coverH + 10;
    if (!coverBuf) {
      doc.font(F.bold || F.regular).fontSize(20).fillColor(P.acc).text(title || '旅行游记', { width: CW });
    }
    doc.font(F.regular).fontSize(10).fillColor(P.sub).text(subtitle || '', { width: CW });
    doc.moveDown(0.2);
    doc.moveTo(M, doc.y).lineTo(M + CW, doc.y).lineWidth(1).strokeColor(P.acc).stroke();
    doc.moveDown(0.55);

    const para = (runs2) => {
      if (!runs2.length) return;
      ensure(doc.currentLineHeight() * 2);
      doc.font(F.regular).fontSize(10.5);
      for (let i = 0; i < runs2.length; i++) {
        const rr = runs2[i];
        doc.font(rr.bold && F.bold ? F.bold : F.regular).fillColor(rr.color || P.text);
        doc.text(rr.text, { continued: i < runs2.length - 1, width: CW });
      }
      doc.moveDown(0.25);
    };
    const heading = (tok) => {
      const size = tok.depth === 1 ? 16 : tok.depth === 2 ? 13 : 11.5;
      ensure(60);
      doc.moveDown(0.35);
      doc.font(F.bold || F.regular).fontSize(size).fillColor(P.acc);
      doc.text(collectRuns(tok.tokens).map((x) => x.text).join(''), { width: CW });
      doc.moveDown(0.2);
    };
    const image = (src, alt) => {
      const buf = images[src];
      if (!isPngOrJpg(buf)) {
        doc.font(F.regular).fontSize(9).fillColor(P.sub).text(`［${alt || '图片'}未能载入］`, { width: CW });
        return;
      }
      try {
        const img = doc.openImage(buf);
        const w = Math.min(CW, img.width);
        const h = img.height * (w / img.width);
        const drawH = Math.min(h, 480);
        const drawW = w * (drawH / h);
        ensure(drawH + 16);
        doc.image(img, M + (CW - drawW) / 2, doc.y, { width: drawW, height: drawH });
        if (alt) {
          doc.y += drawH + 4;
          doc.font(F.regular).fontSize(8.5).fillColor(P.sub).text(alt, { width: CW, align: 'center' });
        } else doc.y += drawH + 10;
        doc.y += 6;
      } catch { /* 解码失败当未载入 */ }
    };
    const list = (tok, depth) => {
      for (let i = 0; i < (tok.items || []).length; i++) {
        const it = tok.items[i];
        const label = tok.ordered ? `${(tok.start || 1) + i}. ` : '• ';
        ensure(doc.currentLineHeight() * 2);
        doc.font(F.regular).fontSize(10.5).fillColor(P.text);
        doc.text(label + collectRuns(it.tokens).map((x) => x.text).join(''), { width: CW - depth * 14, indent: depth * 14 });
        for (const t of it.tokens || []) if (t.type === 'list') list(t, depth + 1);
      }
      doc.moveDown(0.2);
    };
    const blockquote = (tok) => {
      ensure(doc.currentLineHeight() * 2);
      doc.font(F.regular).fontSize(10);
      const y0 = doc.y;
      doc.x = M + 12;
      const runs2 = collectRuns(tok.tokens);
      for (let i = 0; i < runs2.length; i++) {
        doc.font(runs2[i].bold && F.bold ? F.bold : F.regular).fillColor(runs2[i].color || P.sub);
        doc.text(runs2[i].text, { continued: i < runs2.length - 1, width: CW - 12 });
      }
      const y1 = doc.y;
      doc.x = M;
      doc.moveTo(M + 3, y0 - 2).lineTo(M + 3, y1).lineWidth(2.5).strokeColor(P.acc).stroke();
      doc.moveDown(0.25);
    };
    const walk = (ts) => {
      for (const t of ts) {
        if (t.type === 'heading') heading(t);
        else if (t.type === 'paragraph') {
          const imgs = (t.tokens || []).filter((x) => x.type === 'image');
          const rest = (t.tokens || []).filter((x) => x.type !== 'image');
          for (const im of imgs) image(im.href, im.text);
          if (rest.some((x) => x.type !== 'space')) para(collectRuns(rest));
        } else if (t.type === 'list') list(t, 0);
        else if (t.type === 'table') { // 游记少表格：按列表降级渲染，不丢内容
          const rows = [[...(tok_header(t) || [])], ...(t.rows || [])];
          const flat = rows.map((cells) => cells.map((c) => collectRuns(c.tokens).map((x) => x.text).join('')).join(' ｜ '));
          list({ items: flat.map((s) => ({ tokens: [{ type: 'text', text: s }] })) }, 0);
        } else if (t.type === 'blockquote') blockquote(t);
        else if (t.type === 'hr') {
          ensure(20);
          doc.moveTo(M, doc.y).lineTo(M + CW, doc.y).lineWidth(0.8).strokeColor(P.acc).stroke();
          doc.moveDown(0.35);
        } else if (t.type === 'code') {
          ensure(20 * Math.min((t.text || '').split('\n').length, 20));
          doc.font(F.regular).fontSize(9).fillColor(P.sub);
          for (const line of String(t.text || '').split('\n').slice(0, 200)) doc.text(line, { width: CW });
          doc.moveDown(0.25);
        }
      }
    };
    walk(tokens);
    doc.removeListener('pageAdded', onPageAdded);
    return doc.y;
  }
  function tok_header(t) { return t.header; }

  let pageH;
  if (mode === 'long') {
    // 第一遍：量高（14400pt 单页，排版同参数；内容万一超上限就只能砍到上限）
    const m = new PDFDocument({ size: [W, LONG_MAX_H], margin: 0 });
    const sink = (c) => { /* 丢弃量高遍输出 */ };
    m.on('data', sink);
    layout(m, LONG_MAX_H);
    m.end();
    pageH = Math.min(LONG_MAX_H, Math.ceil(m.y) + M + 30);
  } else {
    pageH = A4[1];
  }

  const doc = new PDFDocument({ size: mode === 'long' ? [W, pageH] : A4, margin: M, info: { Title: title || '旅行游记', Creator: '游巷 Alleyu' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve) => doc.on('end', resolve));
  layout(doc, pageH);

  if (mode !== 'long') {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font(F.regular).fontSize(8).fillColor(P.sub)
        .text(`游巷 Alleyu · ${P.name} · 第 ${i + 1} / ${range.start + range.count} 页`, MARGIN, A4[1] - 34, { width: CONTENT_W, align: 'center', lineBreak: false });
    }
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

module.exports = { renderGuidePdf, findFonts, PALETTES, renderJournalPdf };
