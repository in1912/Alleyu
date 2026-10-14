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
