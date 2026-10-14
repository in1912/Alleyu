<template>
  <div class="gv">
    <div class="gv-head">
      <h2 style="margin: 0">📘 {{ guide?.title || '攻略生成中…' }}</h2>
      <div style="display: flex; gap: 8px">
        <button v-if="streamed" class="btn ghost sm" @click="copy">复制全文</button>
        <a href="#/history" class="btn ghost sm">返回列表</a>
        <button class="btn danger sm" @click="del">删除</button>
      </div>
    </div>

    <div v-if="status === 'pending' || status === 'generating'" class="card status-card">
      <div class="spin">🐷</div>
      <div>
        <b>{{ status === 'pending' ? '排队中…' : 'AI 正在写攻略…' }}</b>
        <p class="hint">{{ streamed ? '已收到 ' + streamed.length + ' 字' : '正在连接模型' }}</p>
        <p class="hint" v-if="note">插图生成中：{{ note }}</p>
      </div>
    </div>
    <div v-else-if="status === 'error'" class="card">
      <p class="err-text" style="font-size: 14px">❌ {{ guide?.error }}</p>
    </div>

    <div v-if="streamed" class="card md" v-html="html"></div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { api, token, withToken } from '../api/index.js';

const route = useRoute();
const id = route.params.id;
const guide = ref(null);
const status = ref('pending');
const streamed = ref('');
const note = ref('');
const noteTimer = 0;
let es = null;

marked.setOptions({ breaks: true, gfm: true });
const html = computed(() => marked.parse(streamed.value || ''));

function connect() {
  es = new EventSource(withToken('/api/guides/' + id + '/stream'));
  es.addEventListener('delta', (e) => {
    const j = JSON.parse(e.data);
    streamed.value += j.text;
  });
  es.addEventListener('done', () => {
    es && es.close();
    loadGuide();
  });
  es.addEventListener('error', (e) => {
    // EventSource 出错可能是生成结束后的断流；回读一次确认终态
    if (es) { es.close(); es = null; }
    loadGuide();
    if (status.value === 'generating' || status.value === 'pending') {
      setTimeout(connect, 1500); // 还没终态 → 重连续看
    }
  });
}
async function loadGuide() {
  try {
    const j = await api('/guides/' + id);
    guide.value = j.guide;
    status.value = j.guide.status;
    if (j.guide.content && j.guide.content.length > streamed.value.length) {
      streamed.value = j.guide.content;
    }
  } catch (e) {
    status.value = 'error';
    guide.value = { error: e.message, title: '' };
  }
}
function copy() {
  navigator.clipboard.writeText(streamed.value).then(() => {
    alert('已复制全文');
  });
}
async function del() {
  if (!confirm('确定删除这份攻略？')) return;
  try {
    await api('/guides/' + id, { method: 'DELETE' });
    location.hash = '#/history';
  } catch (e) {
    alert(e.message);
  }
}
onBeforeUnmount(() => { if (es) es.close(); });

// 先读一次（可能早已生成完），未完成再挂 SSE
loadGuide().then(() => {
  if (status.value !== 'done' && status.value !== 'error' && token()) connect();
});
</script>

<style scoped>
.gv { max-width: 900px; margin: 0 auto; }
.gv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 10px; flex-wrap: wrap; }
.status-card { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
.spin { font-size: 34px; animation: bounce 0.7s infinite alternate; }
@keyframes bounce { from { transform: translateY(0); } to { transform: translateY(-8px); } }
</style>
