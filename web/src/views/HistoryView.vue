<template>
  <div>
    <div class="gv-head">
      <h2 style="margin: 0">📚 我的攻略</h2>
      <a href="#/plan" class="btn sm">＋ 新建攻略</a>
    </div>
    <div v-if="!list.length" class="card empty">还没有生成过攻略，去 <a href="#/plan">生成第一份</a></div>
    <div v-else class="grid3">
      <div v-for="g in list" :key="g.id" class="card gcard" @click="open(g)">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <b style="font-size: 16px; color: var(--acc-d)">{{ g.title }}</b>
          <span class="badge" :class="g.status === 'done' ? '' : g.status === 'error' ? 'red' : 'gray'">
            {{ g.status === 'done' ? '完成' : g.status === 'error' ? '失败' : '生成中' }}
          </span>
        </div>
        <p class="hint" style="margin: 8px 0 4px">{{ g.days }} 天 · {{ (g.images || []).length }} 张配图 · {{ g.created_at }}</p>
        <p class="hint" v-if="g.model">{{ g.model }}</p>
        <p v-if="g.status === 'error'" class="err-text">{{ g.error }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/index.js';

const list = ref([]);
onMounted(async () => {
  try {
    const j = await api('/guides');
    list.value = j.guides;
  } catch { /* 401 已处理 */ }
});
function open(g) {
  location.hash = '#/guide/' + g.id;
}
</script>

<style scoped>
.gv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.gcard { cursor: pointer; transition: transform 0.12s; }
.gcard:hover { transform: translateY(-2px); }
</style>
