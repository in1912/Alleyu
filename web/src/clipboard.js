// 复制到剪贴板（v1.10.2）。为什么需要这个文件：
// navigator.clipboard 只在「安全上下文」（https:// 或 localhost）里存在。本项目线上是
// 裸 HTTP（http://alleyu.in1912.cn），在那里 navigator.clipboard === undefined，
// 直接写 navigator.clipboard.writeText(...) 会当场抛
//   Cannot read properties of undefined (reading 'writeText')
// —— 这就是用户实测到的报错（点「生成分享链接」「复制」都中）。
// 所以全站统一走这里的 copyText()：先试异步剪贴板；不可用（或无权限）则退回
// 「隐藏 textarea + document.execCommand('copy')」——老办法在 HTTP 页面里照样管用。
export function hasAsyncClipboard() {
  return typeof navigator !== 'undefined' && !!(navigator.clipboard && navigator.clipboard.writeText);
}

// 退回落旧办法。返回是否成功；不抛异常（失败由调用方决定怎么提示）。
function legacyCopy(text) {
  if (typeof document.execCommand !== 'function') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null; // 复制完把用户原有的选中还回去
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
  return !!ok;
}

// 成功返回 true；彻底失败抛 Error（message 是给用户看的人话，没有那种英文抛栈）
export async function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) throw new Error('没有可复制的内容');
  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      // 权限被拒 / 非当前焦点窗口等：继续往下走老办法，别把英文异常抛给用户
    }
  }
  if (legacyCopy(s)) return true;
  throw new Error('浏览器不允许自动复制，请手动选中内容后复制');
}
