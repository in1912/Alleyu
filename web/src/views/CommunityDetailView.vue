<template>
  <div class="com-page com-detail">
    <div v-if="!session.me" class="com-guest-head">
      <a class="brand" href="#/">游巷<small>AI 旅行札记</small></a>
      <div class="acts">
        <a class="btn ghost sm" href="#/login">登录</a>
        <a class="btn sm" href="#/register">注册</a>
      </div>
    </div>

    <div class="com-head">
      <a class="btn ghost sm" href="#/community">← 返回社区</a>
    </div>

    <p v-if="loading" class="hint">正在加载…</p>
    <p v-else-if="error" class="err-text">{{ error }}</p>
    <article v-else-if="post" class="com-article">
      <div class="com-article-head">
        <span class="com-chip">{{ post.kind === 'journal' ? '游记' : '攻略' }}</span>
        <h1>{{ post.title }}</h1>
        <p class="com-meta">
          <span class="com-author">{{ post.author_name }}</span>
          <span>{{ dateOf(post.published_at) }}</span>
        </p>
      </div>
      <div v-if="post.cover_url" class="com-hero">
        <img :src="post.cover_url" :alt="post.title" @error="coverBroken = true" v-show="!coverBroken" />
      </div>
      <!-- 正文是发布时的快照 HTML（服务端已归一化+白名单重建），这里只做照片排序占位替换 -->
      <div class="com-md md" v-html="bodyHtml"></div>
      <p class="com-foot">这是发布时的快照；作者之后的修改不会同步到这里。</p>
    </article>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { decorateJournalHtml } from '../htmlMd.js';
import { session } from '../stores/session.js';

const route = useRoute();
const post = ref(null);
const loading = ref(true);
const error = ref('');
const coverBroken = ref(false);

const dateOf = (s) => String(s || '').slice(0, 10);

const bodyHtml = computed(() => {
  if (!post.value) return '';
  const id = post.value.id;
  return decorateJournalHtml(post.value.content_html || '', {
    photos: post.value.photos || [],
    photoUrl: (p) => '/api/community/feed/' + id + '/photos/' + p.sort + '/file',
  });
});

onMounted(async () => {
  try {
    // 公开端点：不用 api()（401 会跳登录页）
    const res = await fetch('/api/community/feed/' + encodeURIComponent(route.params.id), { cache: 'no-store' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    post.value = j.post;
  } catch (e) {
    error.value = '打不开这篇分享：' + (e.message || e);
  } finally {
    loading.value = false;
  }
});
</script>
