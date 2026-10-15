// 登录态单例（v1.10.0）：App 侧栏、首页快捷入口、路由守卫共用同一份 me。
// 为什么要有它：以前 App.vue 自己拉一次 /auth/me，路由守卫拿不到角色 ——
// 非管理员手敲 #/settings 能进页面（服务端 403，页面只剩白屏），
// 侧栏/首页又各自算一遍「哪些入口可见」。现在三处同源。
import { reactive } from 'vue';
import { api, setToken, token } from '../api/index.js';

export const session = reactive({ me: null, loaded: false });

// 非管理员的「空白名单」= 攻略 + 天气（与服务端 auth.js 的 canAccess 同语义：
// v1.10.0 起不再是「全放行」，城市景点库/设置/用户管理都归管理员）
export const DEFAULT_PAGES = ['guides', 'weather'];

export function isAdmin() {
  return !!session.me && session.me.role === 'admin';
}

// 菜单与快捷入口显隐的唯一判据。
// item: { page, adminOnly, always }
export function navVisible(item, me = session.me) {
  if (item.always) return !!me;       // 账号页：登录即可见
  if (!me) return false;
  if (item.adminOnly) return me.role === 'admin';
  if (me.role === 'admin') return true;
  const allowed = me.allowed_pages || [];
  if (!allowed.length) return DEFAULT_PAGES.includes(item.page);
  return allowed.includes(item.page);
}

export async function loadMe(force = false) {
  if (!token()) { session.me = null; session.loaded = true; return null; }
  if (session.me && !force) return session.me;
  try {
    const j = await api('/auth/me');
    session.me = j.user || null;
    if (!j.user) setToken('');
  } catch { session.me = null; }
  session.loaded = true;
  return session.me;
}

export function setSession(user) { session.me = user || null; session.loaded = true; }
export function clearSession() { session.me = null; session.loaded = true; }
