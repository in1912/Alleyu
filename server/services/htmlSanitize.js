// v1.12.0 游记正文改为存 HTML 之后的服务端卫生处理。
//
// 定位要说清楚：游记按 user_id 严格隔离、没有分享，**这不是安全边界**，是卫生措施——
// 免得编辑器里沾进来的 script / on* / javascript: 被原样存库、下次打开又原样执行。
// 刻意用**黑名单**而不是标签白名单：编辑器的 execCommand 产物五花八门（font/span/b/i/u），
// 白名单会把用户刚排好的格式打散。纯函数、零 require，自检可直接断言。

const DROP_BLOCKS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math'];

function sanitizeJournalHtml(html) {
  let t = String(html || '');
  for (const tag of DROP_BLOCKS) {
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    t = t.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  // 事件属性：三种写法都清（双引号 / 单引号 / 裸值）
  t = t.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  t = t.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  t = t.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // 编辑态属性不该落库
  t = t.replace(/\scontenteditable(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  t = t.replace(/\sspellcheck(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  // 危险协议
  t = t.replace(/\s(href|src)\s*=\s*"\s*(javascript|vbscript|data:text\/html)[^"]*"/gi, ' $1="#"');
  t = t.replace(/\s(href|src)\s*=\s*'\s*(javascript|vbscript|data:text\/html)[^']*'/gi, " $1='#'");
  // 正文里不塞图片二进制：图片只能进 journal_photos，引用走 photo:N
  t = t.replace(/\ssrc\s*=\s*"\s*data:[^"]*"/gi, ' src=""');
  t = t.replace(/\ssrc\s*=\s*'\s*data:[^']*'/gi, " src=''");
  // style 里可能藏 url(javascript:) / expression()
  t = t.replace(/\sstyle\s*=\s*"[^"]*(javascript:|expression\s*\()[^"]*"/gi, '');
  t = t.replace(/\sstyle\s*=\s*'[^']*(javascript:|expression\s*\()[^']*'/gi, '');
  return t;
}

module.exports = { sanitizeJournalHtml };
