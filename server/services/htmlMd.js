// v1.12.0 游记正文改为「富文本编辑、存 HTML」之后的服务端配套：格式判定 + HTML→Markdown。
//
// 为什么要转回 Markdown：PDF（pdfService.renderJournalPdf）与浏览器长图 PNG（journalPng.js）
// 两套导出都只认 Markdown。与其重写两个渲染器，不如在导出前转一次——转完喂的还是原来那条管线。
//
// ⚠️ 致命细节：**HTML 绝对不能送进 cleanForPdf / cleanMd**。那两个函数会「从第一个 Markdown
// 标题开始截断」，而 HTML 正文开头是 <p>，一进去第一段/第一张图就静默消失。
//
// 只需支持编辑器产出的标签子集（以及 marked 从 Markdown 生成的 HTML），不为任意网页服务。
// 纯函数、零 require —— 自检可以直接 require 跑确定性断言。

const HTML_START = /^\s*<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|span|img|figure|section|br|hr)\b/i;

// 首个非空白标签是块级/媒体元素才算 HTML；**不能只看裸 `<`**——Markdown 自动链接 <https://x> 也以 < 开头。
function isHtml(text) {
  return HTML_START.test(String(text || ''));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    // 越界码点会让 String.fromCodePoint 抛 RangeError —— 正文是用户内容，绝不能在这里炸掉 PDF
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&amp;/gi, '&'); // 放最后：先解别的实体，再解它，避免 &amp;lt; 被解成 <
}

function attrOf(attrs, name) {
  const re1 = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const re2 = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i');
  const m = re1.exec(attrs) || re2.exec(attrs);
  return m ? decodeEntities(m[1]) : '';
}

// 图片引用优先 data-photo，其次 src="photo:N"（编辑器保存时的规范形式），再其次外链原样保留。
function imgMd(attrs) {
  const alt = attrOf(attrs, 'alt') || '';
  const dataPhoto = attrOf(attrs, 'data-photo');
  const src = attrOf(attrs, 'src');
  let href = '';
  let ph = /^photo:(\d+)$/i.exec(dataPhoto.trim());
  if (!ph) ph = /^photo:(\d+)$/i.exec(src.trim());
  if (ph) href = `photo:${ph[1]}`;
  else if (/^(https?:)?\/\//i.test(src)) href = src;
  else if (src) href = src; // 相对路径原样留着（PDF 会尝试按外链规则抓）
  if (!href) return alt; // 认不出照片就退化成文字说明，别留半个坏标签
  return `![${alt.replace(/[\[\]]/g, ' ')}](${href})`;
}

function htmlToMd(html) {
  let t = String(html || '');
  // 注释、脚注说明（尺寸文字绝不能漏进 PDF/PNG）
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, '');
  t = t.replace(/<span\b[^>]*class="[^"]*\brt-cap\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  // 先把图片换成占位符，避免被块级替换搅乱；最后再还原成独立成行的 Markdown 图片
  const imgs = [];
  t = t.replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
    imgs.push(attrs);
    return `\n\n@@ALLEYU_IMG_${imgs.length - 1}@@\n\n`;
  });
  // 代码块（先于行内 code）
  t = t.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => `\n\n\`\`\`\n${stripTags(c).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`);
  t = t.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, c) => `\n\n${'#'.repeat(Number(n))} ${inlineMd(c).trim()}\n\n`);
  t = t.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, c) => {
    const body = inlineMd(c).trim().split('\n').map((l) => '> ' + l).join('\n');
    return `\n\n${body}\n\n`;
  });
  t = t.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  t = t.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, c) => {
    let i = 0;
    const items = [];
    for (const mm of c.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      i++;
      const body = inlineMd(mm[1]).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
      items.push((tag.toLowerCase() === 'ol' ? `${i}. ` : '- ') + body);
    }
    return `\n\n${items.join('\n')}\n\n`;
  });
  // 表格：保留行内容，按单元格用 | 分隔（PDF 的表格渲染也能认）
  t = t.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (m, c) => {
    const rows = [];
    for (const tr of c.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const td of tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) cells.push(inlineMd(td[1]).trim().replace(/\|/g, '/'));
      if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
    }
    if (!rows.length) return '';
    const head = rows[0];
    const sep = '| ' + head.split('|').slice(1, -1).map(() => '---').join(' | ') + ' |';
    return `\n\n${[head, sep, ...rows.slice(1)].join('\n')}\n\n`;
  });
  // 块级容器变成段落分隔
  t = t.replace(/<\/?(p|div|section|article|header|footer|figure|main|aside)\b[^>]*>/gi, '\n\n');
  t = t.replace(/<li\b[^>]*>|<\/li>/gi, '\n');
  // 剩下的行内标签（strong/em/a/code/br/u/span/font…）
  t = inlineMd(t);
  // 还原图片：独立成行、前后空行（PNG 的 journalPng 只认「整行图片」）
  t = t.replace(/@@ALLEYU_IMG_(\d+)@@/g, (m, i) => imgMd(imgs[Number(i)] || ''));
  t = decodeEntities(t);
  // 收拾空行：最多一个空行；行尾空白去掉
  t = t.split('\n').map((l) => l.replace(/[ \t]+$/, (s) => (s === '  ' ? '  ' : ''))).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return t;
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ''));
}

// 行内标签 → Markdown 记号。注意只替换**标签**，不会碰已经转好的 `**` 文本。
function inlineMd(s) {
  let t = String(s);
  t = t.replace(/<br\b[^>]*\/?>/gi, '  \n');
  t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  t = t.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  t = t.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => {
    const clean = String(txt).replace(/<[^>]+>/g, '').trim();
    return /^(https?:|\/|#)/i.test(href) ? `[${clean}](${href})` : clean;
  });
  return t.replace(/<[^>]+>/g, '');
}

module.exports = { isHtml, htmlToMd, decodeEntities };
