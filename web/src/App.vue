<template>
  <div v-if="['login', 'register', 'home', 'share'].includes(route.name)" class="full">
    <router-view />
  </div>
  <div v-else class="shell">
    <aside class="side">
      <div class="logo">游巷<small>AI 旅行札记</small></div>
      <div v-for="n in navItems" :key="n.to" class="nav-item" :class="{ on: isOn(n) }" @click="go(n)">
        <span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[n.ic]"></svg></span><span class="txt">{{ n.label }}</span>
      </div>
      <div class="spacer"></div>
      <div class="me">
        <b>{{ session.me?.display_name || session.me?.username || '…' }}</b>
        {{ session.me?.role === 'admin' ? '管理员' : '用户' }}
        <div style="margin-top: 8px"><a href="#/" style="font-size: 12px">← 回首页</a> · <a style="font-size: 12px; cursor: pointer" @click="logout">退出</a></div>
      </div>
    </aside>
    <main class="main">
      <router-view @refresh-me="() => loadMe(true)" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, setToken, token } from './api/index.js';
import { session, loadMe, clearSession, navVisible } from './stores/session.js';

const route = useRoute();
const router = useRouter();

// 侧栏图标：单色线性 SVG（stroke=currentColor，跟随菜单文字色），不用彩色 emoji
const ICONS = {
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="15.5 8.5 13.8 13.8 8.5 15.5 10.2 10.2 15.5 8.5"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  map: '<polygon points="1 6 1 18 8 15 16 18 23 15 23 3 16 6 8 3 1 6"/><line x1="8" y1="3" x2="8" y2="15"/><line x1="16" y1="6" x2="16" y2="18"/>',
  weather: '<path d="M12 2v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="M20 12h2"/><path d="m19.1 4.9-1.4 1.4"/><path d="M15.9 12.6a4 4 0 0 0-5.9-4.1"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6z"/>',
  sliders: '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};

// v1.10.0：城市景点库/设置/用户管理都是管理员专属（adminOnly），
// 普通用户多一个「账号」（改昵称+密码、看自己的剩余次数与累计 token）——
// 原来是塞在设置页里的「修改密码」页签，现在设置页只对管理员开放，就独立成页了。
const ALL_NAV = [
  { to: '/plan', label: '生成攻略', ic: 'compass', page: 'guides' },
  { to: '/history', label: '我的攻略', ic: 'book', page: 'guides' },
  { to: '/journals', label: '游记整理', ic: 'pen', page: 'guides' }, // v1.8.0 游记整理（在「我的攻略」下方）
  { to: '/library', label: '城市景点库', ic: 'map', page: 'library', adminOnly: true },
  { to: '/weather', label: '天气', ic: 'weather', page: 'weather' },
  { to: '/account', label: '账号', ic: 'user', always: true },
  { to: '/settings', label: '设置', ic: 'sliders', page: 'settings', adminOnly: true },
  { to: '/users', label: '用户管理', ic: 'users', page: 'settings', adminOnly: true },
];

const navItems = computed(() => ALL_NAV.filter((n) => navVisible(n)));

function isOn(n) {
  return route.path === n.to || route.path.startsWith(n.to + '/');
}
function go(n) {
  router.push(n.to);
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  setToken('');
  clearSession(); // 清掉共享缓存，否则路由守卫会拿着上一个账号的角色放行
  location.hash = '#/login';
}
onMounted(() => { loadMe(); });
// 登录是 SPA 内跳转（不刷新页面），App 不会重新挂载——路由变化时补拉用户信息，
// 否则从首页进任何功能页侧栏菜单都是空的
watch(() => route.fullPath, () => {
  if (token() && !session.me) loadMe();
});
</script>

<style scoped>
.full { min-height: 100vh; }
</style>
