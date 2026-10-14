<template>
  <div class="gv">
    <div class="gv-head">
      <h2 style="margin: 0">📘 {{ guide?.title || '攻略生成中…' }}</h2>
      <div style="display: flex; gap: 8px">
        <button v-if="streamed" class="btn ghost sm" @click="copy">复制全文</button>
        <button v-if="status === 'error' || status === 'done'" class="btn ghost sm" @click="regen">重新生成</button>
        <a href="#/history" class="btn ghost sm">返回列表</a>
        <button class="btn danger sm" @click="del">删除</button>
      </div>
    </div>

    <div v-if="status === 'pending' || status === 'generating'" class="card status-card">
      <div class="spin">🐰</div>
      <div class="stg">
        <b>{{ stageLabel }}</b>
        <div class="genbar"><div class="fill" :style="{ width: pct + '%' }"></div></div>
        <p class="hint">{{ stageHint }}</p>
        <!-- 真实内容的 3 行小窗（v1.5.0）：模型正在返回什么，直接看尾巴，不猜 -->
        <pre class="peek" :class="{ dim: !peekText }">{{ peekText || '▌ 等待模型返回…' }}</pre>
      </div>
    </div>
    <div v-else-if="status === 'error'" class="card">
      <p class="err-text" style="font-size: 14px">❌ {{ guide?.error }}</p>
    </div>

    <div v-if="streamed" class="card md" v-html="html"></div>

    <!-- 完整提示词（v1.5.0）：默认折叠，展开可看全文/复制——交代这次生成到底发了什么给模型 -->
    <details v-if="guide && guide.prompt" class="card promptbox">
      <summary>📋 本次生成的完整提示词（默认折叠）</summary>
      <div class="pb-bar">
        <span class="hint">系统提示词 + 用户提示词（含景点库/天气上下文与固定九模块框架）原文</span>
        <button class="btn ghost sm" @click="copyPrompt">复制提示词</button>
      </div>
      <pre>{{ guide.prompt }}</pre>
    </details>
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
const stage = ref('');
const enrichSeen = ref([]);
let es = null;

// ---- 进度条：阶段来自服务端 guides.stage（真阶段），百分比是诚实估算 ----
// write 阶段按「已生成字数 / 按天数估的字数」走 12%→70%；其余阶段到位即定格，
// 斜纹动画持续滚动表示进行中；enrich 每见一个新子阶段 +4%。
const expectedChars = computed(() => Math.min(12000, Math.max(3000, (guide.value?.days || 3) * 2500)));
const pct = computed(() => {
  const s = stage.value;
  if (status.value === 'pending' || !s) return 4;
  if (s === 'weather') return 8;
  if (s === 'connect') return 12;
  if (/^retry/.test(s)) return 15;
  if (s === 'write') return 12 + Math.min(58, Math.round((58 * streamed.value.length) / expectedChars.value));
  if (s.startsWith('enrich')) return Math.min(95, 75 + enrichSeen.value.length * 4);
  return 50;
});
const stageLabel = computed(() => {
  const s = stage.value;
  if (status.value === 'pending' || !s) return '排队中…';
  if (s === 'weather') return '正在获取天气数据…';
  if (s === 'connect') return '正在连接模型…';
  if (/^retry/.test(s)) return '模型返回为空或过短，自动重试中…';
  if (s === 'write') return streamed.value ? `AI 正在撰写攻略正文…（已生成 ${streamed.value.length} 字）` : '模型已响应，等待首段内容…';
  if (s.startsWith('enrich')) return '图文增强：' + (s.split(':')[1] || '进行中') + '…';
  return '生成中…';
});
const stageHint = computed(() => {
  const s = stage.value;
  if (s === 'write') return `全文预计 ${expectedChars.value} 字左右（按天数估算），写完自动插入地图、照片与天气表`;
  if (s && s.startsWith('enrich')) return '地图与照片走高德免费接口（限速串行），约需半分钟，等图是正常的';
  if (s && /^retry/.test(s)) return 'AI 服务偶发首连返回空，已自动重试（无需手动操作）';
  if (s === 'connect') return '正在与 AI 接口建立流式连接';
  return '已提交，等待服务端调度';
});
function onStage(s) {
  if (s && s.startsWith('enrich:') && !enrichSeen.value.includes(s)) enrichSeen.value.push(s);
  stage.value = s;
}

// 3 行实时小窗内容：模型返回的尾巴（截 220 字符，3 行装得下的量）
const peekText = computed(() => (streamed.value ? streamed.value.slice(-220) : ''));

marked.setOptions({ breaks: true, gfm: true });

// 展示前清洗：①去掉桩模式横幅（老数据存过整行提示）②去掉九模块框架正文之外的
// AI 客套/杂项（第一个 markdown 标题之前的内容不显示，正文从框架标题起）
function cleanMd(raw) {
  let t = String(raw || '');
  t = t.replace(/^>?\s*⚠?️?\s*这是\s*ALLEYU_AI_STUB=1\s*的本地桩输出[^\n]*\n?/gm, '');
  t = t.replace(/<!--\s*alleyu:stub[^\n]*?-->\n?/g, ''); // 内部桩标记不进 DOM/复制（披露交给生成来源页脚）
  const lines = t.split('\n');
  const isHeading = (s) => /^#{1,6}\s/.test(s);
  if (lines.length && !isHeading(lines[0])) {
    const hi = lines.findIndex(isHeading);
    if (hi > 0) t = lines.slice(hi).join('\n');
  }
  return t;
}
const clean = computed(() => cleanMd(streamed.value));
const html = computed(() => marked.parse(clean.value));

function connect() {
  es = new EventSource(withToken('/api/guides/' + id + '/stream'));
  es.addEventListener('stage', (e) => {
    onStage(JSON.parse(e.data).stage);
  });
  es.addEventListener('reset', (e) => {
    // 全文快照：首拍/断线重连/enrich 顶部插封面改写了内容 → 整体替换，不追加
    streamed.value = JSON.parse(e.data).text;
  });
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
    if (j.guide.stage) onStage(j.guide.stage);
    if (j.guide.status === 'done' && j.guide.content) {
      streamed.value = j.guide.content; // 终态以库内全文为准（enrich 会前插封面，长度比较不可靠）
    } else if (j.guide.content && j.guide.content.length > streamed.value.length) {
      streamed.value = j.guide.content;
    }
  } catch (e) {
    status.value = 'error';
    guide.value = { error: e.message, title: '' };
  }
}
function copy() {
  navigator.clipboard.writeText(clean.value).then(() => {
    alert('已复制全文');
  });
}
function copyPrompt() {
  navigator.clipboard.writeText(guide.value?.prompt || '').then(() => {
    alert('已复制完整提示词');
  });
}
// 重新生成（v1.5.0）：失败红字时一键原参数重跑；已完成的会先确认（覆盖现有内容）
async function regen() {
  if (status.value === 'done' && !confirm('重新生成会用相同参数重跑并覆盖当前内容，确定？')) return;
  try {
    await api('/guides/' + id + '/regenerate', { method: 'POST' });
    guide.value = guide.value ? { ...guide.value, prompt: '', error: '' } : guide.value;
    status.value = 'pending';
    streamed.value = '';
    stage.value = '';
    enrichSeen.value = [];
    if (es) { es.close(); es = null; }
    connect();
  } catch (e) {
    alert(e.message);
  }
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
.status-card .stg { flex: 1; min-width: 0; }
.spin { font-size: 34px; animation: bounce 0.7s infinite alternate; }
@keyframes bounce { from { transform: translateY(0); } to { transform: translateY(-8px); } }
.genbar { height: 10px; background: var(--card2); border-radius: 999px; overflow: hidden; margin: 9px 0 7px; }
.genbar .fill {
  height: 100%; border-radius: 999px; position: relative; overflow: hidden;
  background: linear-gradient(90deg, var(--acc), var(--acc-d));
  transition: width 0.8s ease;
}
/* 斜纹滚动：阶段不可精确计百分比时也在明确地动，不是死进度条 */
.genbar .fill::after {
  content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.22) 0 9px, transparent 9px 18px);
  animation: stripeSlide 1s linear infinite;
}
@keyframes stripeSlide { to { transform: translateX(18px); } }
/* 实时内容小窗：深色终端样式，固定 3 行（v1.5.0） */
.peek {
  margin: 4px 0 0; padding: 8px 12px; border-radius: 10px;
  background: #0e1626; color: #9fc3e8;
  font: 12px/1.7 ui-monospace, Consolas, 'Courier New', monospace;
  max-height: 5.1em; overflow: hidden; white-space: pre-wrap; word-break: break-all;
}
.peek.dim { color: #5b7395; }
/* 完整提示词折叠框（v1.5.0） */
.promptbox summary { cursor: pointer; user-select: none; font-weight: 600; }
.promptbox pre {
  margin: 10px 0 0; padding: 12px; background: var(--card2); border-radius: 10px;
  max-height: 340px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  font-size: 12px; line-height: 1.6;
}
.pb-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
</style>
