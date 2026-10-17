<template>
  <!-- 单色耳麦（stroke=currentColor）：用户点名的客服悬浮图标 -->
  <button class="fab-feedback" type="button" aria-label="客服留言" title="客服留言" @click="go">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 13a8 8 0 0 1 16 0" />
      <rect x="2.5" y="13" width="4" height="7" rx="2" />
      <rect x="17.5" y="13" width="4" height="7" rx="2" />
      <path d="M20 20a3 3 0 0 1-3 2h-3" />
    </svg>
  </button>
</template>

<script setup>
import { useRouter } from 'vue-router';

const router = useRouter();
function go() {
  router.push('/feedback');
}
</script>
