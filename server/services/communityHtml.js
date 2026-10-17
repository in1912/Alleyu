// v1.13.0 社区公开内容的渲染管线（纯函数，自检可直接 require）。
//
// 为什么不能直接用游记的 sanitizeJournalHtml：
//   那是**私有游记**的卫生措施（黑名单），定位是「别把 script 原样存回自己的库」，
//   而社区内容会被游客打开，必须有更强的保证。这里的做法是「先归一化成 Markdown，
//   再把 Markdown 渲染成 HTML」——用户正文里的原始 HTML 一律转义成字面文字，
//   marked 只会输出它自己生成的标签，最后再按白名单清一遍链接/图片。
//
// 代价（写进 README 的诚实边界）：行内样式、图片显示宽度会丢；标题/加粗/斜体/列表/
// 引用/图片/链接保留。

const { marked } = require('marked');
const { isHtml, htmlToMd } = require('./htmlMd');

// 展示前清洗攻略 Markdown：去掉桩模式横幅/内部标记，正文从第一个 Markdown 标题起。
// 与 web/src/md.js 的 cleanMd 同规则（服务端要独立一份，不能 import 浏览器 ESM）。
function cleanGuideMd(raw) {
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

// 允许公开引用的图片：本站高德缓存图 / 照片代理 / 相对路径 / https 外链 / photo:N。
// 刻意拒绝 http:（混合内容）与 data:（把二进制塞进正文）。
function isAllowedImageUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (/^photo:\d+$/i.test(u)) return true;
  if (/^\/api\/amap\/(mapimg|photo)\b/i.test(u)) return true;
  if (/^\/[^/]/.test(u)) return true;
  return /^https:\/\//i.test(u);
}

// 攻略封面：优先 images_json 里 type=cover，其次正文里第一张白名单图片。
function extractGuideCover(imagesJson, markdown) {
  let arr = [];
  try {
    const v = JSON.parse(imagesJson || '[]');
    if (Array.isArray(v)) arr = v;
  } catch { /* 坏 JSON 就当没有 */ }
  const fromMeta = arr.map((x) => (x && (x.url || x.src)) || '')
    .find((u) => isAllowedImageUrl(u) && !/^photo:/i.test(u));
  if (fromMeta) return String(fromMeta).trim();
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(String(markdown || '')))) {
    const u = m[1];
    if (!/^photo:/i.test(u) && isAllowedImageUrl(u)) return u;
  }
  return '';
}

function attrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(String(attrs || ''));
  return m ? m[1] : '';
}

function safeHref(url) {
  const u = String(url || '').trim();
  return /^(https?:|mailto:|\/|#)/i.test(u) || u === '' ? u : '#';
}

function safeSrc(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return isAllowedImageUrl(u) ? u : '';
}

// 最后一道：删危险标签 / 事件属性 / 行内样式，链接与图片按白名单重建。
function hardenPublicHtml(html) {
  let t = String(html || '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  const blocks = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
    'textarea', 'select', 'option', 'svg', 'math', 'link', 'meta', 'base'];
  for (const tag of blocks) {
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    t = t.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  t = t.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  t = t.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  t = t.replace(/\s(href)\s*=\s*"([^"]*)"/gi, (m, a, v) => ` ${a}="${safeHref(v)}"`);
  t = t.replace(/\s(href)\s*=\s*'([^']*)'/gi, (m, a, v) => ` ${a}='${safeHref(v)}'`);
  t = t.replace(/\s(src)\s*=\s*"([^"]*)"/gi, (m, a, v) => ` ${a}="${safeSrc(v)}"`);
  t = t.replace(/\s(src)\s*=\s*'([^']*)'/gi, (m, a, v) => ` ${a}='${safeSrc(v)}'`);
  // 外链新窗口打开并断开 opener（站内相对路径与 # 锚点保持原样）
  t = t.replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const href = attrValue(attrs, 'href');
    if (!/^https?:/i.test(href)) return m;
    let a = attrs.replace(/\s(target|rel)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<a${a} target="_blank" rel="noopener noreferrer">`;
  });
  return t;
}

// Markdown → 公开 HTML。正文里的 `<` 全部转义：原始 HTML 不会被执行，只会显示成文字。
function renderCommunityHtml(markdown) {
  const escaped = String(markdown || '').replace(/</g, '&lt;');
  let html = '';
  try {
    html = marked.parse(escaped, { async: false });
  } catch {
    html = '';
  }
  return hardenPublicHtml(html);
}

// 游记正文：HTML 先转 Markdown（只保留安全链接/图片），旧 Markdown 原样。
function journalToMarkdown(content) {
  const raw = String(content || '');
  return isHtml(raw) ? htmlToMd(raw) : raw;
}

module.exports = {
  cleanGuideMd,
  extractGuideCover,
  hardenPublicHtml,
  renderCommunityHtml,
  journalToMarkdown,
  isAllowedImageUrl,
};
