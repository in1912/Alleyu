// API 封装：Bearer 头为主；<img>/EventSource 场景用 withToken() 拼 ?token=。
// 约定：非 2xx 一律 {error} JSON；401 统一踢回登录页。
const TOKEN_KEY = 'alleyu_token';

export function token() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function withToken(url) {
  const t = token();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(path.startsWith('/api') ? path : '/api' + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('网络请求失败（服务未启动或网络异常）');
  }
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
  if (res.status === 401) {
    setToken('');
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new Error(j.error || '未登录或会话已过期');
  }
  if (!res.ok) throw new Error(j.error || `请求失败 HTTP ${res.status}`);
  return j;
}

// v1.11.0 上传升级包（原始 zip 二进制体，不走 JSON）。
// 为什么不复用 api()：api() 只会发 JSON，而且它的 401 分支会**强制跳登录页**——
// 升级应用之后服务端要重启，重启窗口里的请求本来就可能 401，用 api() 会把管理员踢出去。
// 这里先看 content-type 再决定怎么解析：nginx 拒收/反代出错时回的是 HTML，
// 直接 res.json() 会抛出看不懂的 "Unexpected token '<'"。
export async function uploadZip(path, file) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(path.startsWith('/api') ? path : '/api' + path, { method: 'POST', headers, body: file });
  } catch {
    throw new Error('上传失败：网络中断或服务未启动');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const txt = await res.text();
    throw new Error(res.status === 413
      ? '上传被拦下：文件超过服务器允许的大小（nginx 的 client_max_body_size 或服务端上限）'
      : `服务器回的不是 JSON（HTTP ${res.status}）——多半是 nginx 拒收或反代出错：${txt.slice(0, 120)}`);
  }
  const j = await res.json();
  if (!res.ok) {
    const e = new Error(j.error || `HTTP ${res.status}`);
    if (j.code) e.code = j.code;
    throw e;
  }
  return j;
}

// 裸探针：只问「服务起来了吗、版本是多少」。
// 走免登录的 /api/system-info（EXEMPT），**绝不用 api()**——重启窗口里它 401 会跳登录页，
// 而升级过程中最不该发生的就是把管理员踢回登录页。连不上时返回 null，由调用方计时。
export async function probeVersion() {
  try {
    const res = await fetch('/api/system-info', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.version ? j : null;
  } catch { return null; }
}

// v1.6.1 导出 PDF：服务端生成 PDF 文件 → blob → a[download] 直接触发浏览器下载，
// 不走 window.print（用户明确要「直接下载文件」）。没配字体的服务端回 400 {code:'NO_FONT'}，
// 抛的 Error 带 .code，由调用方决定回落打印。分享页无 token 也能用（公开端点）。
export async function downloadPdfFile(path, filename) {
  const headers = {};
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(path.startsWith('/api') ? path : '/api' + path, { headers });
  } catch {
    throw new Error('网络请求失败（服务未启动或网络异常）');
  }
  if (!res.ok) {
    let j = {};
    try { j = await res.json(); } catch { /* 非 JSON 错误体 */ }
    const e = new Error(j.error || `PDF 生成失败 HTTP ${res.status}`);
    if (j.code) e.code = j.code;
    throw e;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
