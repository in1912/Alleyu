<template>
  <div class="jd">
    <div class="jd-head">
      <h2 style="margin: 0">📖 {{ j?.title || j?.destination || '游记' }}</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button v-if="status === 'done'" class="btn ghost sm" @click="startEdit">编辑</button>
        <button v-if="status === 'done'" class="btn ghost sm" :disabled="pngBusy" @click="exportPng">{{ pngBusy ? '渲染中…' : '导出PNG' }}</button>
        <button v-if="status === 'done'" class="btn ghost sm" :disabled="pdfBusy" @click="exportPdf('a4')">{{ pdfBusy ? '生成中…' : 'PDF·A4打印' }}</button>
        <button v-if="status === 'done'" class="btn ghost sm" :disabled="pdfBusy" @click="exportPdf('long')">PDF·长图分享</button>
        <button v-if="status === 'error' || status === 'done'" class="btn ghost sm" @click="regen">重新生成</button>
        <a href="#/journals" class="btn ghost sm">返回列表</a>
        <button class="btn danger sm" @click="del">删除</button>
      </div>
    </div>

    <!-- 生成中：SSE 进度（与攻略同构） -->
    <div v-if="status === 'pending'" class="card status-card">
      <div class="spin">🐰</div>
      <div class="stg">
        <b>{{ stageLabel }}</b>
        <div class="genbar"><div class="fill" :style="{ width: pct + '%' }"></div></div>
        <p class="hint">写完正文后还会顺手起一个短标题（≤20 字），完成后自动展示。</p>
        <pre class="peek" :class="{ dim: !peek }">{{ peek || '▌ 等待模型返回…' }}</pre>
      </div>
    </div>
    <div v-else-if="status === 'error'" class="card">
      <p class="err-text" style="font-size: 14px">❌ {{ j?.error }}</p>
      <p class="hint">可以点「重新生成」原参数重跑。</p>
    </div>
    <div v-else-if="status === 'draft' && !j?.content" class="card">
      <p>这篇游记还没生成正文。</p>
      <div style="display: flex; gap: 10px; margin-top: 8px">
        <button class="btn sm" @click="generateNow">开始生成</button>
        <a :href="'#/journals/new?draft=' + id" class="btn ghost sm">回引导补内容</a>
      </div>
    </div>

    <!-- 成稿：封面 + 配色 + 正文 -->
    <template v-if="(status === 'done' || (status === 'draft' && j?.content))">
      <div class="card">
        <!-- 封面：照片压标题（AI 短标题）+ 副标题（出行基础信息） -->
        <div class="jcover" :class="{ noimg: !coverPhoto }" :style="!coverPhoto ? { background: pal.bg } : {}">
          <img v-if="coverPhoto" :src="coverUrl" alt="封面" />
          <div class="scrim"></div>
          <div class="cvr-text">
            <div class="cvr-bar" :style="{ background: coverPhoto ? '#fff' : pal.acc }"></div>
            <div v-if="!titleEditing" class="cvr-title" :class="{ dark: !coverPhoto }" :title="'点击修改标题'">{{ j?.title || '（未起标题）' }}</div>
            <div v-else class="cvr-edit">
              <input v-model="titleText" class="input" maxlength="40" @keyup.enter="saveTitle" />
              <button class="btn sm" @click="saveTitle">存</button>
              <button class="btn ghost sm" @click="titleEditing = false">取消</button>
            </div>
            <div class="cvr-sub" :class="{ dark: !coverPhoto }">{{ j?.subtitle || subFallback }}</div>
          </div>
          <div class="cvr-btns">
            <button class="btn ghost sm" :disabled="titleBusy" @click="aiTitle" :title="'AI 参考 目的地/偏好/季节 重新起一个 ≤20 字标题（现有标题会被覆盖）'">{{ titleBusy ? '起标题中…' : '✨ AI 标题' }}</button>
            <button v-if="titleEditing === false" class="btn ghost sm" @click="titleEditing = true; titleText = j?.title || ''">✏️ 改标题</button>
          </div>
        </div>

        <!-- 配色：莫兰迪 5 套（PNG/PDF 同步用它） -->
        <div class="pal-row">
          <span class="hint">配色：</span>
          <span v-for="(p, i) in PALETTES" :key="i" class="pal" :class="{ on: j?.palette === i + 1 }" @click="setPalette(i + 1)">
            <i :style="{ background: p.bg, borderColor: p.acc }"></i>{{ p.name }}
          </span>
        </div>

        <!-- 照片条：点选设封面 -->
        <div v-if="photos.length" class="strip">
          <div v-for="p in photos" :key="p.id" class="thumb" :class="{ on: j?.cover_photo_id === p.id }" @click="setCover(p)" :title="p.id === j?.cover_photo_id ? '当前封面' : '点我设为封面'">
            <img :src="withToken('/api/journals/' + id + '/photos/' + p.id + '/file')" alt="" />
            <span v-if="p.caption" class="tcap">{{ p.caption }}</span>
            <span v-if="j?.cover_photo_id === p.id" class="cov-badge">封面</span>
          </div>
          <span class="hint" style="align-self: center">点击照片设为封面；未手选时生成完随机选一张。</span>
        </div>
      </div>

      <!-- 编辑模式 -->
      <div v-if="editing" class="card">
        <div class="pb-bar">
          <span class="hint">编辑游记 Markdown 原文（图片占位 <code>![说明](photo:序号)</code> 保留即可，导出时自动换回真图）</span>
          <div style="display: flex; gap: 8px">
            <button class="btn ghost sm" @click="editing = false">取消</button>
            <button class="btn sm" @click="saveEdit">保存修改</button>
          </div>
        </div>
        <textarea v-model="editText" class="editarea" spellcheck="false"></textarea>
      </div>
      <div v-else class="card jr-md" v-html="html"></div>

      <details v-if="j?.prompt" class="card promptbox">
        <summary>📋 本次生成的完整提示词（默认折叠）</summary>
        <pre>{{ j.prompt }}</pre>
      </details>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { api, withToken, downloadPdfFile } from '../api/index.js';
import { cleanMd } from '../md.js';
import { PALETTES } from '../journalPalettes.js';
import { renderJournalPng } from '../journalPng.js';

const route = useRoute();
const id = route.params.id;
const j = ref(null);
const status = ref('pending');
const photos = ref([]);
const streamed = ref('');
const stage = ref('');
const editing = ref(false);
const editText = ref('');
const pngBusy = ref(false);
const pdfBusy = ref(false);
const titleEditing = ref(false);
const titleText = ref('');
const titleBusy = ref(false);
let es = null;

marked.setOptions({ breaks: true, gfm: true });

const pal = computed(() => PALETTES[((j.value?.palette || 1) - 1 + PALETTES.length) % PALETTES.length]);
const coverPhoto = computed(() => {
  if (!photos.value.length) return null;
  return photos.value.find((p) => p.id === j.value?.cover_photo_id) || photos.value[0];
});
const coverUrl = computed(() => (coverPhoto.value ? withToken('/api/journals/' + id + '/photos/' + coverPhoto.value.id + '/file') : ''));
const subFallback = computed(() => j.value?.destination || '');
const peek = computed(() => (streamed.value ? streamed.value.slice(-220) : ''));

// 正文：clean 后把 ![alt](photo:N) 占位换成真图 URL（N=照片 sort 值，与服务端 PDF 同一套约定）
const html = computed(() => {
  const md = mdWithPhotos(cleanMd(streamed.value || j.value?.content || ''));
  return marked.parse(md);
});
function mdWithPhotos(md) {
  return String(md || '').replace(/!\[([^\]]*)\]\(photo:(\d+)\)/g, (m, alt, n) => {
    const p = photos.value.find((x) => String(x.sort) === String(n));
    if (!p) return alt; // 照片已删 → 退化为文字说明
    return `![${alt}](${withToken('/api/journals/' + id + '/photos/' + p.id + '/file')})`;
  });
}

const pct = computed(() => {
  if (!stage.value) return 4;
  if (stage.value === 'write') return 10 + Math.min(80, Math.round((80 * streamed.value.length) / 1500));
  if (stage.value === 'title') return 96;
  return 50;
});
const stageLabel = computed(() => {
  if (!stage.value) return '排队中…';
  if (stage.value === 'write') return streamed.value ? `AI 正在撰写游记正文…（已生成 ${streamed.value.length} 字）` : '模型已响应，等待首段内容…';
  if (stage.value === 'title') return '正文完成，AI 正在起标题…';
  return '生成中…';
});

function connect() {
  es = new EventSource(withToken('/api/journals/' + id + '/stream'));
  es.addEventListener('stage', (e) => { stage.value = JSON.parse(e.data).stage; });
  es.addEventListener('reset', (e) => { streamed.value = JSON.parse(e.data).content; });
  es.addEventListener('delta', (e) => { streamed.value += JSON.parse(e.data).text; });
  es.addEventListener('done', () => { if (es) { es.close(); es = null; } load(); });
  es.addEventListener('error', () => {
    if (es) { es.close(); es = null; }
    load();
    if (status.value === 'pending') setTimeout(connect, 1500); // 还没终态 → 重连续看
  });
}
async function load() {
  try {
    const r = await api('/journals/' + id);
    j.value = r.journal;
    status.value = r.journal.status;
    photos.value = r.journal.photos || [];
    if (r.journal.status === 'done' && r.journal.content) streamed.value = r.journal.content;
  } catch (e) {
    status.value = 'error';
    j.value = { error: e.message };
  }
}

// ---- 封面 / 标题 / 配色 ----
async function setCover(p) {
  try {
    const r = await api('/journals/' + id + '/cover', { method: 'PUT', body: { photo_id: p.id } });
    j.value = r.journal;
  } catch (e) { alert(e.message); }
}
async function aiTitle() {
  if (j.value?.title && !confirm('AI 重新起标题会覆盖现有标题，确定？')) return;
  titleBusy.value = true;
  try {
    const r = await api('/journals/' + id + '/title', { method: 'POST' });
    j.value = { ...j.value, title: r.title };
  } catch (e) { alert('起标题失败：' + e.message); } finally { titleBusy.value = false; }
}
async function saveTitle() {
  try {
    await api('/journals/' + id, { method: 'PUT', body: { title: titleText.value.trim() || j.value.title } });
    j.value = { ...j.value, title: titleText.value.trim() || j.value.title };
    titleEditing.value = false;
  } catch (e) { alert(e.message); }
}
async function setPalette(n) {
  try {
    await api('/journals/' + id, { method: 'PUT', body: { palette: n } });
    j.value = { ...j.value, palette: n };
  } catch (e) { alert(e.message); }
}

// ---- 生成 / 编辑 ----
async function generateNow() {
  try {
    await api('/journals/' + id + '/generate', { method: 'POST', body: {} });
    status.value = 'pending';
    streamed.value = '';
    stage.value = '';
    connect();
  } catch (e) { alert(e.message); }
}
async function regen() {
  if (status.value === 'done' && !confirm('重新生成会覆盖当前正文与副标题（标题、封面、配色保留），确定？')) return;
  try {
    await api('/journals/' + id + '/regenerate', { method: 'POST' });
    status.value = 'pending';
    streamed.value = '';
    stage.value = '';
    if (es) { es.close(); es = null; }
    connect();
  } catch (e) { alert(e.message); }
}
function startEdit() {
  editText.value = j.value?.content || '';
  editing.value = true;
}
async function saveEdit() {
  if (!editText.value.trim()) { alert('正文不能清空（要重来请用「重新生成」）'); return; }
  try {
    await api('/journals/' + id, { method: 'PUT', body: { content: editText.value } });
    streamed.value = editText.value;
    j.value = { ...j.value, content: editText.value };
    editing.value = false;
  } catch (e) { alert(e.message); }
}
async function del() {
  if (!confirm('删除这篇游记？照片一并删除，不可恢复。')) return;
  try {
    await api('/journals/' + id, { method: 'DELETE' });
    location.hash = '#/journals';
  } catch (e) { alert(e.message); }
}

// ---- 导出：PNG（浏览器 canvas）/ PDF（服务端 pdfkit，两种 mode） ----
async function exportPng() {
  if (pngBusy.value) return;
  pngBusy.value = true;
  try {
    await renderJournalPng({
      title: j.value?.title || j.value?.destination || '旅行游记',
      subtitle: j.value?.subtitle || subFallback.value,
      markdown: cleanMd(j.value?.content || ''),
      palette: pal.value,
      coverUrl: coverUrl.value,
      photoUrls: photos.value.map((p) => ({ sort: p.sort, url: withToken('/api/journals/' + id + '/photos/' + p.id + '/file') })),
    });
  } catch (e) { alert('PNG 导出失败：' + e.message); } finally { pngBusy.value = false; }
}
async function exportPdf(mode) {
  if (pdfBusy.value) return;
  pdfBusy.value = true;
  try {
    const name = (j.value?.title || '游记') + (mode === 'long' ? '-长图' : '-A4') + '.pdf';
    await downloadPdfFile('/api/journals/' + id + '/pdf?mode=' + mode, name);
  } catch (e) {
    if (e.code === 'NO_FONT') alert(e.message);
    else alert('PDF 导出失败：' + e.message);
  } finally { pdfBusy.value = false; }
}

onMounted(async () => {
  await load();
  if (status.value === 'pending') connect();
});
onBeforeUnmount(() => { if (es) es.close(); });
</script>

<style scoped>
.jd { max-width: 880px; margin: 0 auto; }
.jd-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.status-card { text-align: center; padding: 30px 20px; }
.spin { font-size: 40px; animation: hop 0.9s ease-in-out infinite; }
@keyframes hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
.stg { margin-top: 10px; }
.genbar { height: 8px; border-radius: 4px; background: var(--card2); overflow: hidden; margin: 12px auto 6px; max-width: 420px; }
.genbar .fill { height: 100%; background: linear-gradient(90deg, var(--acc-d), color-mix(in srgb, var(--acc-d) 60%, #fff)); }
.peek { max-width: 520px; margin: 12px auto 0; text-align: left; white-space: pre-wrap; word-break: break-all; font-size: 12px; color: var(--mut); background: var(--card2); border-radius: 8px; padding: 8px 10px; max-height: 3.6em; overflow: hidden; }
.peek.dim { opacity: 0.5; }
.jcover { position: relative; border-radius: 12px; overflow: hidden; aspect-ratio: 21 / 9; min-height: 180px; }
.jcover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.jcover .scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.6) 100%); }
.jcover.noimg .scrim { background: none; }
.cvr-text { position: absolute; left: 26px; right: 90px; bottom: 18px; }
.cvr-bar { width: 34px; height: 4px; border-radius: 2px; margin-bottom: 10px; }
.cvr-title { font-size: 30px; font-weight: 700; color: #fff; letter-spacing: 1.5px; text-shadow: 0 2px 12px rgba(0,0,0,0.5); cursor: pointer; line-height: 1.25; }
.cvr-title.dark { color: var(--pal-text, #333); text-shadow: none; }
.cvr-sub { color: rgba(255,255,255,0.93); font-size: 13.5px; margin-top: 7px; text-shadow: 0 1px 6px rgba(0,0,0,0.45); }
.cvr-sub.dark { color: #777; text-shadow: none; }
.cvr-edit { display: flex; gap: 6px; align-items: center; }
.cvr-edit .input { max-width: 320px; }
.cvr-btns { position: absolute; right: 14px; bottom: 14px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.pal-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.pal { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 14px; border: 1.5px solid transparent; cursor: pointer; font-size: 12.5px; color: var(--mut); }
.pal i { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; display: inline-block; }
.pal.on { border-color: var(--acc-d); color: var(--text); background: var(--card2); }
.strip { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.thumb { position: relative; width: 108px; cursor: pointer; border-radius: 8px; overflow: hidden; border: 2px solid transparent; }
.thumb.on { border-color: var(--acc-d); }
.thumb img { width: 108px; height: 76px; object-fit: cover; display: block; }
.tcap { display: block; font-size: 11px; color: var(--mut); padding: 4px 5px; background: var(--card2); max-height: 3em; overflow: hidden; }
.cov-badge { position: absolute; top: 5px; left: 5px; background: var(--acc-d); color: #fff; font-size: 10.5px; padding: 1px 7px; border-radius: 9px; }
.pb-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.editarea { width: 100%; min-height: 420px; box-sizing: border-box; font-family: Consolas, monospace; font-size: 13px; line-height: 1.7; }
.jr-md :deep(img) { max-width: 100%; border-radius: 10px; margin: 8px 0; }
.jr-md :deep(h2) { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.promptbox { margin-top: 14px; }
.promptbox pre { white-space: pre-wrap; font-size: 12px; max-height: 320px; overflow: auto; }
</style>
