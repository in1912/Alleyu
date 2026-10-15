<template>
  <div>
    <h2 style="margin: 0 0 14px">📖 游记整理</h2>
    <div class="card">
      <div style="display: flex; gap: 10px; margin-bottom: 14px; align-items: center">
        <button class="btn sm" @click="openNew">＋ 写游记（引导式）</button>
        <span class="hint">问答式录入 → 照片与体验 → AI 成文 → 封面标题 → 导出 PNG/PDF</span>
      </div>
      <div v-if="!rows.length && !loading" class="empty">还没有游记。点「写游记」，从第一个问题开始。</div>
      <table v-else class="tb">
        <thead><tr><th>标题</th><th>目的地</th><th>天数</th><th>季节</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="j in rows" :key="j.id">
            <td><a @click="open(j)" style="cursor: pointer; font-weight: 600">{{ j.title || '（未起标题）' }}</a></td>
            <td>{{ j.destination || '-' }}</td>
            <td>{{ j.meta.days || '-' }}</td>
            <td>{{ j.meta.season || '-' }}</td>
            <td><span class="badge" :class="{ gray: j.status !== 'done' }">{{ statusText(j.status) }}</span></td>
            <td class="hint">{{ j.updated_at }}</td>
            <td>
              <button class="btn ghost sm" @click="open(j)">查看</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="del(j)">删</button>
            </td>
          </tr>
        </tbody>
      </table>
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
