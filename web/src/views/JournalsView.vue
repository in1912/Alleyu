<template>
  <div>
    <div class="gv-head">
      <h2 style="margin: 0">📖 生成游记</h2>
      <button class="btn sm" @click="openNew">＋ 写游记（引导式）</button>
    </div>
    <!-- v1.12.0：列表改成与「我的攻略」一致方框卡片（用户点名不要表格） -->
    <div v-if="!rows.length && !loading" class="card empty">还没有游记。点「写游记」，从第一个问题开始。</div>
    <div v-else-if="rows.length" class="grid3">
      <div v-for="j in rows" :key="j.id" class="card gcard" @click="open(j)">
        <div class="gc-top">
          <b class="gc-title">{{ j.title || '（未起标题）' }}</b>
          <span class="badge" :class="{ gray: j.status !== 'done' }">{{ statusText(j.status) }}</span>
        </div>
        <p class="hint" style="margin: 8px 0 4px">
          {{ j.destination || '-' }}
          <template v-if="j.meta.days"> · {{ j.meta.days }} 天</template>
          <template v-if="j.meta.season"> · {{ j.meta.season }}</template>
        </p>
        <p class="hint" style="margin: 0">{{ j.updated_at }}</p>
        <div class="gc-acts">
          <span class="hint">点卡片查看</span>
          <button class="btn ghost sm" @click.stop="del(j)">删</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/index.js';

const rows = ref([]);
const loading = ref(true);

function statusText(s) {
  return { draft: '草稿', pending: '生成中', done: '已完成', error: '失败' }[s] || s;
}
function open(j) {
  location.hash = '#/journal/' + j.id;
}
function openNew() {
  location.hash = '#/journals/new';
}
async function load() {
  loading.value = true;
  try {
    const j = await api('/journals');
    rows.value = j.journals || [];
  } finally {
    loading.value = false;
  }
}
async function del(j) {
  if (!confirm(`删除游记「${j.title || j.destination || j.id}」？照片一并删除，不可恢复。`)) return;
  await api('/journals/' + j.id, { method: 'DELETE' });
  load();
}
onMounted(load);
</script>

<style scoped>
.gv-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.gcard { cursor: pointer; transition: transform 0.12s; }
.gcard:hover { transform: translateY(-2px); }
.gc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.gc-title { font-size: 16px; color: var(--acc-d); line-height: 1.4; }
.gc-acts { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
</style>
