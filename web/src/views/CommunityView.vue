<template>
  <div class="com-page">
    <!-- 游客整页布局：自己带品牌头（登录用户由 .shell 的侧栏/底栏承担导航） -->
    <div v-if="!session.me" class="com-guest-head">
      <a class="brand" href="#/">游巷<small>AI 旅行札记</small></a>
      <div class="acts">
        <a class="btn ghost sm" href="#/login">登录</a>
        <a class="btn sm" href="#/register">注册</a>
      </div>
    </div>

    <div class="com-head">
      <div>
        <h1>社区</h1>
        <p class="hint">大家分享的攻略与游记，点开就能看。游客也能逛。</p>
      </div>
      <a v-if="!session.me" class="btn ghost sm" href="#/">← 回首页</a>
    </div>

    <p v-if="loading" class="hint">正在加载社区…</p>
    <p v-else-if="error" class="err-text">{{ error }}</p>
    <div v-else-if="!posts.length" class="com-empty">
      <div class="big">🌱</div>
      <p>社区还空着。登录后打开一篇自己的攻略或游记，点「发布到社区」就能成为第一篇。</p>
      <a v-if="!session.me" class="btn sm" href="#/login">去登录</a>
    </div>

    <div v-else class="com-grid">
      <a v-for="p in posts" :key="p.id" class="com-card" :href="'#/community/' + p.id">
        <div class="com-cover">
          <img v-if="p.cover_url && !broken[p.id]" :src="p.cover_url" :alt="p.title" loading="lazy" @error="broken[p.id] = true" />
          <span v-else class="ph">{{ p.kind === 'journal' ? '📖' : '🧭' }}</span>
        </div>
        <div class="com-body">
          <div class="com-title">{{ p.title }}</div>
          <div class="com-meta">
            <span class="com-author">{{ p.author_name }}</span>
            <span>{{ dateOf(p.published_at) }}</span>
          </div>
        </div>
      </a>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { session } from '../stores/session.js';

const posts = ref([]);
const loading = ref(true);
const error = ref('');
const broken = reactive({});

function dateOf(s) {
  return String(s || '').slice(0, 10) || '';
}

onMounted(async () => {
  try {
    // 公开端点：**不用 api()**（它 401 会跳登录页，把游客踢走）
    const res = await fetch('/api/community/feed', { cache: 'no-store' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    posts.value = j.posts || [];
  } catch (e) {
    error.value = '社区加载失败：' + (e.message || e);
  } finally {
    loading.value = false;
  }
});
</script>
