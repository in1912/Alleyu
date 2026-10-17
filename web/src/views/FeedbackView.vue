<template>
  <div class="com-page fb-page">
    <div v-if="!session.me" class="com-guest-head">
      <a class="brand" href="#/">游巷<small>AI 旅行札记</small></a>
      <div class="acts">
        <a class="btn ghost sm" href="#/community">逛社区</a>
        <a class="btn sm" href="#/login">登录</a>
      </div>
    </div>

    <div class="com-head">
      <div>
        <h1>客服留言</h1>
        <p class="hint">给管理员留句话；回复会显示在下面的回复框里。</p>
      </div>
      <a class="btn ghost sm" href="#/">← 回首页</a>
    </div>

    <div class="fb-identity">
      <span>当前身份：<b>{{ displayName }}</b></span>
      <span>日期：{{ today }}</span>
    </div>

    <section class="card fb-form">
      <label class="fb-label" for="fb-body">留言内容</label>
      <textarea id="fb-body" v-model="body" class="input fb-textarea" maxlength="4000"
        placeholder="写下遇到的问题或建议（最多 4000 字）"></textarea>
      <div class="fb-actions">
        <span class="hint">{{ body.length }} / 4000</span>
        <button class="btn" :disabled="busy || !body.trim()" @click="submit">{{ busy ? '提交中…' : '提交留言' }}</button>
      </div>
      <p v-if="notice" class="ok-text">{{ notice }}</p>
      <p v-if="error" class="err-text">{{ error }}</p>
    </section>

    <h2 class="fb-h2">我的留言</h2>
    <p v-if="loadingMine" class="hint">正在加载…</p>
    <p v-else-if="!mine.length" class="hint">还没有留言。</p>
    <div v-else class="fb-list">
      <div v-for="f in mine" :key="f.id" class="fb-item" :data-id="f.id">
        <div class="fb-item-head"><b>{{ f.author_name }}</b><span>{{ String(f.created_at || '').slice(0, 16) }}</span></div>
        <div class="fb-body-text">{{ f.body }}</div>
        <!-- 只读的管理员回复框：已回复就显示内容，没有就明说 -->
        <div class="fb-reply">
          <div class="fb-reply-label">管理员回复</div>
          <div v-if="f.reply" class="fb-reply-text">{{ f.reply }}</div>
          <div v-else class="fb-reply-empty">管理员还没有回复</div>
          <div v-if="f.replied_at" class="fb-reply-time">回复于 {{ String(f.replied_at).slice(0, 16) }}</div>
        </div>
      </div>
    </div>

    <!-- 管理员：同一页处理全部留言（不另开设置页签） -->
    <template v-if="isAdmin">
      <h2 class="fb-h2">全部留言 <small class="hint">（仅管理员可见）</small></h2>
      <p v-if="loadingAll" class="hint">正在加载…</p>
      <p v-else-if="!all.length" class="hint">还没有任何留言。</p>
      <div v-else class="fb-list">
        <div v-for="f in all" :key="'a' + f.id" class="fb-item fb-admin-item" :data-id="f.id">
          <div class="fb-item-head">
            <b>{{ f.author_name }}</b>
            <span>{{ String(f.created_at || '').slice(0, 16) }}<template v-if="f.user_id"> · 用户 #{{ f.user_id }}</template><template v-else-if="f.guest_tag"> · 游客末四位 {{ f.guest_tag }}</template></span>
          </div>
          <div class="fb-body-text">{{ f.body }}</div>
          <textarea v-model="drafts[f.id]" class="input fb-textarea sm" maxlength="4000" placeholder="写给这条留言的回复（留空保存=清空回复）"></textarea>
          <div class="fb-actions">
            <button class="btn sm" :disabled="saving[f.id]" @click="saveReply(f.id)">{{ saving[f.id] ? '保存中…' : '保存回复' }}</button>
            <button class="btn ghost sm" @click="remove(f.id)">删除</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, token } from '../api/index.js';
import { session, loadMe } from '../stores/session.js';

const KEY_STORE = 'alleyu_guest_key';
const body = ref('');
const notice = ref('');
const error = ref('');
const busy = ref(false);
const mine = ref([]);
const all = ref([]);
const loadingMine = ref(true);
const loadingAll = ref(false);
const guestKey = ref('');
const guestName = ref('');
const drafts = reactive({});
const saving = reactive({});

const isAdmin = computed(() => session.me?.role === 'admin');
const displayName = computed(() => {
  if (session.me) return session.me.display_name || session.me.username || '用户';
  if (guestName.value) return guestName.value;
  return guestKey.value ? '游客 #' + guestKey.value.slice(-4).toUpperCase() : '游客';
});
const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();

function genKey() {
  const b = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// 游客编号在页面打开时就定下来（游客 #XXXX = key 末 4 位），不等第一次提交
function ensureGuestKey() {
  if (guestKey.value) return guestKey.value;
  let k = '';
  try { k = localStorage.getItem(KEY_STORE) || ''; } catch { /* 隐私模式 */ }
  if (!/^[0-9a-f]{32}$/.test(k)) k = genKey();
  guestKey.value = k;
  guestName.value = '游客 #' + k.slice(-4).toUpperCase();
  try { localStorage.setItem(KEY_STORE, k); } catch { /* 存不了就只在本次会话用 */ }
  return k;
}

async function rawJson(path, opts) {
  const res = await fetch(path.startsWith('/api') ? path : '/api' + path, opts);
  let j = {};
  try { j = await res.json(); } catch { j = {}; }
  if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}

function fillDrafts(items) {
  for (const f of items) drafts[f.id] = f.reply || '';
}

async function loadMine() {
  loadingMine.value = true;
  try {
    if (token() && session.me) {
      const j = await api('/feedback/mine');
      mine.value = j.items || [];
    } else {
      const k = ensureGuestKey();
      const j = await rawJson('/feedback/open?key=' + k);
      guestName.value = j.author_name || guestName.value;
      mine.value = j.items || [];
    }
  } catch (e) {
    // 存下来的 key 失效（服务端清过库）→ 换一个新的，不要让游客卡死
    if (!session.me && /凭证不合法/.test(e.message)) {
      try { localStorage.removeItem(KEY_STORE); } catch { /* 忽略 */ }
      guestKey.value = '';
      guestName.value = '';
      mine.value = [];
    } else {
      error.value = '加载留言失败：' + e.message;
    }
  } finally {
    loadingMine.value = false;
  }
}

async function loadAll() {
  if (!isAdmin.value) return;
  loadingAll.value = true;
  try {
    const j = await api('/feedback/admin');
    all.value = j.items || [];
    fillDrafts(all.value);
  } catch (e) {
    error.value = '加载全部留言失败：' + e.message;
  } finally {
    loadingAll.value = false;
  }
}

async function submit() {
  const text = body.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  notice.value = '';
  error.value = '';
  try {
    if (token() && session.me) {
      await api('/feedback', { method: 'POST', body: { body: text } });
    } else {
      const k = ensureGuestKey();
      const j = await rawJson('/feedback/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k, body: text }),
      });
      if (j.author_name) guestName.value = j.author_name;
    }
    body.value = '';
    notice.value = '留言已提交，管理员回复后会显示在这里。';
    await loadMine();
    await loadAll();
  } catch (e) {
    error.value = '提交失败：' + e.message;
  } finally {
    busy.value = false;
  }
}

async function saveReply(id) {
  if (saving[id]) return;
  saving[id] = true;
  try {
    await api('/feedback/' + id + '/reply', { method: 'PUT', body: { reply: drafts[id] || '' } });
    await loadAll();
    await loadMine();
  } catch (e) {
    error.value = '保存回复失败：' + e.message;
  } finally {
    saving[id] = false;
  }
}

async function remove(id) {
  try {
    await api('/feedback/' + id, { method: 'DELETE' });
    await loadAll();
    await loadMine();
  } catch (e) {
    error.value = '删除失败：' + e.message;
  }
}

onMounted(async () => {
  if (token()) await loadMe(); // 角色/名字要从会话缓存里来
  await loadMine();
  await loadAll();
});
</script>
