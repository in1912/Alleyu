<template>
  <div v-if="route.name === 'login' || route.name === 'home'" class="full">
    <router-view />
  </div>
  <div v-else class="shell">
    <aside class="side">
      <div class="logo">游巷<small>AI 旅行札记</small></div>
      <div v-for="n in navItems" :key="n.to" class="nav-item" :class="{ on: isOn(n) }" @click="go(n)">
        <span class="ic">{{ n.ic }}</span><span class="txt">{{ n.label }}</span>
      </div>
      <div class="spacer"></div>
      <div class="me">
        <b>{{ me?.display_name || me?.username || '…' }}</b>
        {{ me?.role === 'admin' ? '管理员' : '用户' }}
        <div style="margin-top: 8px"><a href="#/" style="font-size: 12px">← 回首页</a> · <a style="font-size: 12px; cursor: pointer" @click="logout">退出</a></div>
      </div>
    </aside>
    <main class="main">
      <router-view @refresh-me="loadMe" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, setToken, token } from './api/index.js';

const route = useRoute();
const router = useRouter();
const me = ref(null);

const ALL_NAV = [
  { to: '/plan', label: '生成攻略', ic: '🧭', page: 'guides' },
  { to: '/history', label: '我的攻略', ic: '📚', page: 'guides' },
  { to: '/library', label: '城市景点库', ic: '🗺️', page: 'library' },
  { to: '/weather', label: '天气', ic: '🌤️', page: 'weather' },
  { to: '/settings', label: '设置', ic: '⚙️', page: 'settings' },
  { to: '/users', label: '用户管理', ic: '👥', page: 'settings', admin: true },
];

const navItems = computed(() => {
  if (!me.value) return [];
  return ALL_NAV.filter((n) => {
    if (n.admin && me.value.role !== 'admin') return false;
    const allowed = me.value.allowed_pages || [];
    if (me.value.role === 'admin' || !allowed.length) return true;
    return allowed.includes(n.page);
  });
});

function isOn(n) {
  return route.path === n.to || route.path.startsWith(n.to + '/');
}
function go(n) {
  router.push(n.to);
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  setToken('');
  me.value = null;
  location.hash = '#/login';
}
async function loadMe() {
  if (!token()) return;
  try {
    const j = await api('/auth/me');
    me.value = j.user;
    if (!j.user) { setToken(''); location.hash = '#/login'; }
  } catch { /* 401 已由 api 统一处理 */ }
}
onMounted(loadMe);
// 登录是 SPA 内跳转（不刷新页面），App 不会重新挂载——路由变化时补拉用户信息，
// 否则从首页进任何功能页侧栏菜单都是空的
watch(() => route.fullPath, () => {
  if (token() && !me.value) loadMe();
});
</script>

<style scoped>
.full { min-height: 100vh; }
</style>
