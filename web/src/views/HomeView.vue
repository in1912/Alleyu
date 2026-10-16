<template>
  <div class="home-page">
    <!-- v1.8.0：右上角登录/退出（游客也能看首页，登录后才进得了功能）；v1.10.0 旁边加注册 -->
    <div class="corner">
      <template v-if="session.me">
        <span class="who">{{ session.me.display_name || session.me.username }}</span>
        <button class="btn ghost sm" @click="logout">退出</button>
      </template>
      <template v-else>
        <span class="who hint">游客模式 · 仅可浏览</span>
        <button class="btn ghost sm" @click="goRegister">注册</button>
        <button class="btn sm" @click="needLogin">登录</button>
      </template>
    </div>

    <div class="home-wrap">
      <RiderScene ref="riderRef" />
      <h1 class="home-title">游巷</h1>
      <!-- v1.10.1：删掉「—— 每敲一个字，它就兔跳一下」（用户要求；兔跳本身照旧触发，只是不写在页面上） -->
      <p class="home-sub">输入一个目的地，小兔骑车带你去 🐰</p>

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

      <div v-if="session.me && hotCities.length" class="hot-cities">
        <span v-for="c in hotCities" :key="c.id" class="c" @click="pick(c)">{{ c.name }}</span>
      </div>

      <!-- v1.10.0：入口按角色过滤——普通用户看不到 城市景点库/设置/用户管理（服务端也 403），
           多了「我的账号」（改昵称密码、看剩余次数）。判据与侧栏同一份 navVisible。 -->
      <div class="quick-links" v-if="session.me">
        <a v-for="l in quickLinks" :key="l.href" :href="l.href">{{ l.label }}</a>
      </div>
      <p v-else class="hint" style="margin-top: 26px">
        游客可以看首页；<a href="#/login" style="color: var(--acc-d)">登录</a> 后可以生成 AI 攻略、写游记、看地图与天气。
      </p>
    </div>

    <!-- v1.10.1：底部 ICP 备案号（页面是浅灰绿底，用 --mut 灰绿小字；纯白在这个底色上看不见） -->
    <p class="beian">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">浙ICP备2026080083号-1</a>
    </p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import RiderScene from '../components/RiderScene.vue';
import { api, setToken, token } from '../api/index.js';
import { session, loadMe, clearSession, navVisible } from '../stores/session.js';

const riderRef = ref(null);
const inputRef = ref(null);
const q = ref('');
const showSug = ref(false);
const suggestions = ref([]);
const hotCities = ref([]);
let sugTimer = 0;

const LINKS = [
  { href: '#/plan', label: '🧭 生成攻略', page: 'guides' },
  { href: '#/history', label: '📚 我的攻略', page: 'guides' },
  { href: '#/journals', label: '📖 游记整理', page: 'guides' },
  { href: '#/library', label: '🗺️ 城市景点库', page: 'library', adminOnly: true },
  { href: '#/weather', label: '🌤️ 天气', page: 'weather' },
  { href: '#/account', label: '👤 我的账号', always: true },
  { href: '#/settings', label: '⚙️ 设置', page: 'settings', adminOnly: true },
  { href: '#/users', label: '👥 用户管理', page: 'settings', adminOnly: true },
];
const quickLinks = computed(() => LINKS.filter((l) => navVisible(l)));

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
function goRegister() {
  location.hash = '#/register';
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
  clearSession();
  hotCities.value = [];
}
onMounted(async () => {
  // v1.8.0：游客不再踢回登录页——首页就是门面；只有登录用户才拉用户信息与热门城市
  if (!token()) return;
  try {
    const me = await loadMe();
    if (!me) return;
    const c = await api('/cities');
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
/* 备案号：.home-page 是 flex 行容器，直接把 <p> 放进流里会跟 .home-wrap 并排——必须绝对定位到底部
   （容器已有 padding-bottom:46px 给它留位） */
.beian { position: absolute; left: 0; right: 0; bottom: 14px; margin: 0; text-align: center; font-size: 12px; }
.beian a { color: var(--mut); }
.beian a:hover { color: var(--acc-d); }
</style>
