// v1.12.0 浏览器侧的 HTML ⇄ Markdown 桥（与服务端 server/services/htmlMd.js 同规则）。
// 用途有三：
//   1. 游记正文改存 HTML 之后，PNG 导出（canvas 只认 Markdown）要先把 HTML 转回去；
//   2. 富文本编辑器把「AI 生成的 Markdown」种子渲染成 HTML；
//   3. 显示时把正文里 photo:N 的占位换成本次登录的 token URL，并在编辑态标注图片尺寸。
// 注意：**HTML 绝不能送进 md.js 的 cleanMd**——它会「从第一个 Markdown 标题开始截断」，
// HTML 开头是 <p>，第一段/第一张图会被静默吞掉。这里的 isHtml 就是分流开关。

const HTML_START = /^\s*<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|span|img|figure|section|br|hr)\b/i;

export function isHtml(text) {
  return HTML_START.test(String(text === undefined || text === null ? '' : text));
}

function el(tag) {
  return tag && tag.nodeType === 1 ? tag : null;
}
function cls(node) {
  const e = el(node);
  return (e && typeof e.className === 'string') ? e.className : '';
}
function skipped(node) {
  const e = el(node);
  if (!e) return false;
  const t = e.tagName.toLowerCase();
  return t === 'figcaption' || t === 'script' || t === 'style' || t === 'noscript'
    || cls(e).split(/\s+/).includes('rt-cap');
}
function photoRef(img) {
  const wrap = img.closest ? img.closest('.rt-img') : null;
  const cands = [wrap && wrap.getAttribute('data-photo'), img.getAttribute('data-photo')];
  for (const c of cands) {
    const m = /^\s*photo:(\d+)\s*$/i.exec(String(c || '')) || /^\s*(\d+)\s*$/.exec(String(c || ''));
    if (m) return 'photo:' + m[1];
  }
  const src = String(img.getAttribute('src') || '').trim();
  const m = /^photo:(\d+)$/i.exec(src);
  if (m) return 'photo:' + m[1];
  // 带 token 的解析后 URL：**不能入库**，这里也不猜（路径里是照片 id，不是 sort）
  if (/\/photos\/\d+\/file/.test(src)) return '';
  if (/^https?:\/\//i.test(src) || /^\/[^/]/.test(src)) return src;
  return '';
}
function imgLine(img) {
  const alt = String(img.getAttribute('alt') || '').replace(/[\[\]]/g, ' ').trim();
  const href = photoRef(img);
  if (!href) return alt;
  return `![${alt}](${href})`;
}

// ---------- HTML → Markdown ----------
function inlineMd(node, imgs) {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += n.nodeValue; return; }
    if (n.nodeType !== 1 || skipped(n)) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') { out += '  \n'; return; }
    if (tag === 'strong' || tag === 'b') { out += '**' + inlineMd(n, imgs) + '**'; return; }
    if (tag === 'em' || tag === 'i') { out += '*' + inlineMd(n, imgs) + '*'; return; }
    if (tag === 'del' || tag === 's') { out += '~~' + inlineMd(n, imgs) + '~~'; return; }
    if (tag === 'code') { out += '`' + n.textContent + '`'; return; }
    if (tag === 'a') {
      const h = String(n.getAttribute('href') || '').trim();
      const t = inlineMd(n, imgs);
      out += /^(https?:|\/|#|mailto:)/i.test(h) ? `[${t}](${h})` : t;
      return;
    }
    if (tag === 'img') { imgs.push(n); out += `\u0000I${imgs.length - 1}\u0000`; return; }
    if (tag === 'span' && cls(n).split(/\s+/).includes('rt-img')) {
      const img = n.querySelector('img');
      if (img) { imgs.push(img); out += `\u0000I${imgs.length - 1}\u0000`; return; }
    }
    out += inlineMd(n, imgs);
  });
  return out;
}

function tableMd(tbl, imgs) {
  const rows = Array.from(tbl.querySelectorAll('tr'));
  if (!rows.length) return '';
  const cells = rows.map((r) => Array.from(r.querySelectorAll('th,td'))
    .map((c) => inlineMd(c, imgs).replace(/\u0000I\d+\u0000/g, '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()));
  const width = Math.max(1, ...cells.map((r) => r.length));
  const pad = (r) => { const x = r.slice(); while (x.length < width) x.push(''); return x; };
  const head = pad(cells[0]);
  const lines = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => ' --- ').join('|') + '|'];
  for (const r of cells.slice(1)) lines.push('| ' + pad(r).join(' | ') + ' |');
  return lines.join('\n');
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'figure', 'header', 'footer', 'main',
  'aside', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
function hasBlockChildren(n) {
  return Array.from(n.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()));
}

function blockMd(root, imgs) {
  const parts = [];
  root.childNodes.forEach((n) => {
    if (n.nodeType === 3) { const t = n.nodeValue.trim(); if (t) parts.push(t); return; }
    if (n.nodeType !== 1 || skipped(n)) return;
    const tag = n.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const t = inlineMd(n, imgs).replace(/\u0000I\d+\u0000/g, '').trim();
      if (t) parts.push('#'.repeat(Number(tag[1])) + ' ' + t);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      let i = 0;
      const items = [];
      Array.from(n.children).forEach((li) => {
        if (!el(li) || li.tagName.toLowerCase() !== 'li') return;
        i += 1;
        const t = inlineMd(li, imgs).trim().replace(/\n/g, '\n  ');
        items.push((tag === 'ol' ? `${i}. ` : '- ') + t);
      });
      if (items.length) parts.push(items.join('\n'));
      return;
    }
    if (tag === 'blockquote') {
      const inner = blockMd(n, imgs).trim();
      if (inner) parts.push(inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
      return;
    }
    if (tag === 'pre') { parts.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```'); return; }
    if (tag === 'hr') { parts.push('---'); return; }
    if (tag === 'table') { const t = tableMd(n, imgs); if (t) parts.push(t); return; }
    if (tag === 'img') { imgs.push(n); parts.push(`\u0000I${imgs.length - 1}\u0000`); return; }
    if (tag === 'span' && cls(n).split(/\s+/).includes('rt-img')) {
      const img = n.querySelector('img');
      if (img) { imgs.push(img); parts.push(`\u0000I${imgs.length - 1}\u0000`); }
      return;
    }
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'figure'
      || tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'aside' || tag === 'body') {
      // 只有真的装了块级子元素才递归；普通 <p><strong>x</strong> y</p> 走行内，
      // 否则 blockMd 会把同一段里的 strong 和后面的文字拆成两段。
      const inner = hasBlockChildren(n) ? blockMd(n, imgs).trim() : '';
      const t = inner || inlineMd(n, imgs).trim();
      if (t) parts.push(t);
      return;
    }
    const t = inlineMd(n, imgs).trim();
    if (t) parts.push(t);
  });
  return parts.join('\n\n');
}

export function htmlToMd(html) {
  const src = String(html === undefined || html === null ? '' : html);
  if (!isHtml(src) || typeof DOMParser === 'undefined') return src;
  let doc;
  try { doc = new DOMParser().parseFromString('<body>' + src + '</body>', 'text/html'); } catch { return src; }
  const imgs = [];
  let text = blockMd(doc.body, imgs);
  text = text.replace(/\u0000I(\d+)\u0000/g, (m, i) => {
    const img = imgs[Number(i)];
    return img ? '\n\n' + imgLine(img) + '\n\n' : '\n\n';
  });
  text = text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  text = text.split('\n').map((line) => {
    const hardBreak = /  $/.test(line);
    const core = line.replace(/[ \t]+/g, ' ').trimEnd();
    return hardBreak && core ? core + '  ' : core;
  }).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

// ---------- 图片尺寸的展示 ----------
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

export function sizeLabel(photo) {
  const p = photo || {};
  const w = Number(p.width) || 0;
  const h = Number(p.height) || 0;
  const dim = (w && h) ? `${w}×${h}` : '尺寸未知';
  const b = formatBytes(p.bytes);
  return b ? `${dim} · ${b}` : dim;
}

// ---------- 正文装饰：photo:N → 本次登录的 token URL；编辑态补尺寸标注 ----------
function findPhoto(img, bySort, byId) {
  const wrap = img.closest ? img.closest('.rt-img') : null;
  const cands = [wrap && wrap.getAttribute('data-photo'), img.getAttribute('data-photo')];
  for (const c of cands) {
    const s = String(c || '').trim();
    const m = /^photo:(\d+)$/i.exec(s) || /^(\d+)$/.exec(s);
    if (m && bySort.has(m[1])) return bySort.get(m[1]);
  }
  const src = String(img.getAttribute('src') || '').trim();
  const m1 = /^photo:(\d+)$/i.exec(src);
  if (m1 && bySort.has(m1[1])) return bySort.get(m1[1]);
  const m2 = /\/photos\/(\d+)\/file/.exec(src);
  if (m2 && byId.has(m2[1])) return byId.get(m2[1]);
  return null;
}

function applyWidth(img, w) {
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  img.removeAttribute('width');
  img.removeAttribute('height');
  if (w > 0 && w < 100) img.style.width = w + '%';
  else img.style.width = 'auto';
}

/**
 * @param {string} html
 * @param {{photos?: Array, photoUrl?: (p:any)=>string, editable?: boolean}} opts
 */
export function decorateJournalHtml(html, opts) {
  const src = String(html === undefined || html === null ? '' : html);
  if (typeof DOMParser === 'undefined') return src;
  const o = opts || {};
  const photos = Array.isArray(o.photos) ? o.photos : [];
  const bySort = new Map();
  const byId = new Map();
  for (const p of photos) { bySort.set(String(p.sort), p); byId.set(String(p.id), p); }
  const photoUrl = typeof o.photoUrl === 'function' ? o.photoUrl : () => '';
  let doc;
  try { doc = new DOMParser().parseFromString('<body>' + src + '</body>', 'text/html'); } catch { return src; }

  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const p = findPhoto(img, bySort, byId);
    if (!p) {
      // 只把「明显是照片占位但照片已删」的退化成文字；外链图片原样留着
      const looksLikePhoto = img.hasAttribute('data-photo')
        || /^photo:/i.test(String(img.getAttribute('src') || ''))
        || /\/photos\/\d+\/file/.test(String(img.getAttribute('src') || ''));
      if (!looksLikePhoto) continue;
      const alt = String(img.getAttribute('alt') || '').trim();
      const holder = (img.closest && img.closest('.rt-img')) || img;
      holder.replaceWith(doc.createTextNode(alt ? `［图片已删除：${alt}］` : '［图片已删除］'));
      continue;
    }
    const url = photoUrl(p);
    if (url) img.setAttribute('src', url);
    img.removeAttribute('srcset');

    let wrap = img.closest('.rt-img');
    if (!wrap) {
      wrap = doc.createElement('span');
      wrap.className = 'rt-img';
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
    }
    wrap.setAttribute('data-photo', String(p.sort));
    const w = Number(wrap.getAttribute('data-w')) || Number(img.getAttribute('data-w')) || 0;
    if (w > 0) wrap.setAttribute('data-w', String(w));
    applyWidth(img, w);

    wrap.querySelectorAll('.rt-cap').forEach((n) => n.remove());
    if (o.editable) {
      const cap = doc.createElement('span');
      cap.className = 'rt-cap';
      cap.setAttribute('contenteditable', 'false');
      cap.textContent = sizeLabel(p);
      wrap.appendChild(cap);
    }
  }
  return doc.body.innerHTML;
}
