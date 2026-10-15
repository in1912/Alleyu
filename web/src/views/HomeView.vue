<template>
  <div class="home-page">
    <!-- v1.8.0：右上角登录/退出（游客也能看首页，登录后才进得了功能） -->
    <div class="corner">
      <template v-if="me">
        <span class="who">{{ me.display_name || me.username }}</span>
        <button class="btn ghost sm" @click="logout">退出</button>
      </template>
      <template v-else>
        <span class="who hint">游客模式 · 仅可浏览</span>
        <button class="btn sm" @click="needLogin">登录</button>
      </template>
    </div>

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
        <button class="go journal-go" @click="goJournal">写游记</button>
        <div v-if="showSug && suggestions.length" class="sug">
          <div v-for="c in suggestions" :key="c.id" class="s" @mousedown.prevent="pick(c)">
            <span>{{ c.name }}</span><small>{{ c.province }}</small>
          </div>
        </div>
      </div>

      <div v-if="me && hotCities.length" class="hot-cities">
        <span v-for="c in hotCities" :key="c.id" class="c" @click="pick(c)">{{ c.name }}</span>
      </div>

      <div class="quick-links" v-if="me">
        <a href="#/plan">🧭 生成攻略</a><a href="#/history">📚 我的攻略</a>
        <a href="#/journals">📖 游记整理</a><a href="#/library">🗺️ 城市景点库</a>
        <a href="#/weather">🌤️ 天气</a><a href="#/settings">⚙️ 设置</a>
        <a v-if="me.role === 'admin'" href="#/users">👥 用户管理</a>
      </div>
      <p v-else class="hint" style="margin-top: 26px">
        游客可以看首页；<a href="#/login" style="color: var(--acc-d)">登录</a> 后可以生成 AI 攻略、写游记、看地图与天气。
      </p>
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
  if (!token()) return; // 游客打不了 /cities（需要登录），直接不联想
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
function needLogin() {
  location.hash = '#/login';
}
function goPlan() {
  if (!token()) return needLogin(); // 游客引导登录
  const kw = q.value.trim();
  if (!kw) { inputRef.value && inputRef.value.focus(); return; }
  location.hash = '#/plan?destination=' + encodeURIComponent(kw);
}
function goJournal() {
  if (!token()) return needLogin();
  location.hash = '#/journals/new';
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  setToken('');
  me.value = null;
  hotCities.value = [];
}
onMounted(async () => {
  // v1.8.0：游客不再踢回登录页——首页就是门面；只有登录用户才拉用户信息与热门城市
  if (!token()) return;
  try {
    const [m, c] = await Promise.all([api('/auth/me'), api('/cities')]);
    me.value = m.user;
    hotCities.value = (c.cities || []).filter((x) => x.hot).slice(0, 12);
  } catch { /* 401 已跳登录 */ }
});
</script>

<style scoped>
.home-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px 16px 46px; position: relative; }
.quick-links { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; font-size: 14px; }
.quick-links a { color: var(--mut); }
.quick-links a:hover { color: var(--acc-d); }
.corner { position: absolute; top: 16px; right: 18px; display: flex; gap: 10px; align-items: center; z-index: 30; }
.corner .who { font-size: 13px; color: var(--mut); }
/* .go 基础样式是绝对定位 right:6px——第二个按钮必须错开，否则叠在「做攻略」上（render 抓出的真 bug） */
.journal-go { background: #fff; color: var(--acc-d); border: 1px solid var(--acc-d); right: 110px; }
</style>
