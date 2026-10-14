<template>
  <div class="home-page">
    <div class="home-wrap">
      <RiderScene ref="riderRef" />
      <h1 class="home-title">游巷</h1>
      <p class="home-sub">输入一个目的地，乳白小兔骑车带你去 —— 每敲一个字，它就兔跳一下 🐰</p>

      <div class="searchbar">
        <input
          ref="inputRef"
          v-model="q"
          class="input"
          placeholder="想去哪座城市？例如：杭州"
          @input="onType"
          @keydown.enter="goPlan"
          @focus="showSug = true"
          @blur="blurSug"
        />
        <button class="go" @click="goPlan">做攻略</button>
        <div v-if="showSug && suggestions.length" class="sug">
          <div v-for="c in suggestions" :key="c.id" class="s" @mousedown.prevent="pick(c)">
            <span>{{ c.name }}</span><small>{{ c.province }}</small>
          </div>
        </div>
      </div>

      <div class="hot-cities">
        <span v-for="c in hotCities" :key="c.id" class="c" @click="pick(c)">{{ c.name }}</span>
      </div>

      <div class="quick-links" v-if="me">
        <a href="#/plan">🧭 生成攻略</a><a href="#/history">📚 我的攻略</a>
        <a href="#/library">🗺️ 城市景点库</a><a href="#/weather">🌤️ 天气</a>
        <a href="#/settings">⚙️ 设置</a><a v-if="me.role === 'admin'" href="#/users">👥 用户管理</a>
        <a v-else href="#/login" @click="logout">🚪 退出</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import RiderScene from '../components/RiderScene.vue';
import { api, setToken, token } from '../api/index.js';

const riderRef = ref(null);
const inputRef = ref(null);
const q = ref('');
const showSug = ref(false);
const suggestions = ref([]);
const hotCities = ref([]);
const me = ref(null);
let sugTimer = 0;

// 每敲进一个字符 → 兔跳一次（删除不触发）
function onType(e) {
  if (e && e.inputType && !e.inputType.startsWith('insert')) return;
  if (riderRef.value) riderRef.value.jump();
  clearTimeout(sugTimer);
  sugTimer = setTimeout(loadSug, 180);
}
async function loadSug() {
  const kw = q.value.trim();
  if (!kw) { suggestions.value = []; return; }
  try {
    const j = await api('/cities?q=' + encodeURIComponent(kw));
    suggestions.value = j.cities.slice(0, 8);
  } catch { suggestions.value = []; }
}
function blurSug() {
  setTimeout(() => { showSug.value = false; }, 150);
}
function pick(c) {
  q.value = c.name;
  showSug.value = false;
  goPlan();
}
function goPlan() {
  const kw = q.value.trim();
  if (!kw) { inputRef.value && inputRef.value.focus(); return; }
  location.hash = '#/plan?destination=' + encodeURIComponent(kw);
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  setToken('');
}
onMounted(async () => {
  if (!token()) { location.hash = '#/login'; return; }
  try {
    const [m, c] = await Promise.all([api('/auth/me'), api('/cities')]);
    me.value = m.user;
    hotCities.value = (c.cities || []).filter((x) => x.hot).slice(0, 12);
  } catch { /* 401 已跳登录 */ }
});
</script>

<style scoped>
.home-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px 16px 46px; }
.quick-links { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; font-size: 14px; }
.quick-links a { color: var(--mut); }
.quick-links a:hover { color: var(--acc-d); }
</style>
