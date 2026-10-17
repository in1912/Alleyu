<template>
  <div class="jd">
    <div class="jd-head">
      <h2 style="margin: 0">📖 {{ j?.title || j?.destination || '游记' }}</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button v-if="status === 'done'" class="btn ghost sm" @click="startEdit">编辑</button>
        <!-- v1.13.0 社区：发布的是数据库里已保存的那一版（编辑中不显示）；文案避开「分享」二字 -->
        <button v-if="status === 'done' && !editing" class="btn ghost sm" :disabled="communityBusy" @click="toggleCommunity">{{ communityBusy ? '处理中…' : (communityPost ? '取消发布' : '发布到社区') }}</button>
        <button v-if="status === 'done'" class="btn ghost sm" @click="exportPng" :disabled="pngBusy">{{ pngBusy ? '渲染中…' : '导出PNG' }}</button>
        <button v-if="status === 'done'" class="btn ghost sm" :disabled="pdfBusy" @click="exportPdf('a4')">{{ pdfBusy ? '生成中…' : 'PDF·A4打印' }}</button>
        <button v-if="status === 'done'" class="btn ghost sm" :disabled="pdfBusy" @click="exportPdf('long')">PDF·长图分享</button>
        <!-- v1.9.0：成稿后的右上角不再是「原地重跑 AI」，而是回引导模式改答案再走一遍 -->
        <button v-if="status === 'done'" class="btn ghost sm" title="回问答向导：填好的内容都留着，改完再走一遍生成" @click="backToWizard">✏️ 回引导修改</button>
        <button v-if="status === 'error'" class="btn ghost sm" @click="regen">重新生成</button>
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
      <p class="hint">可以点「重新生成」原参数重跑，或点「回引导修改」改完再生成。</p>
    </div>
    <div v-else-if="status === 'draft' && !j?.content" class="card">
      <p>这篇游记还没生成正文。</p>
      <div style="display: flex; gap: 10px; margin-top: 8px">
        <button class="btn sm" @click="generateNow">开始生成</button>
        <a :href="'#/journals/new?draft=' + id" class="btn ghost sm">回引导补内容</a>
      </div>
    </div>

    <!-- 成稿：左侧大纲（景点排序）+ 右侧封面/路线/正文 -->
    <template v-if="(status === 'done' || (status === 'draft' && j?.content))">
      <div class="jd-wrap">
        <aside class="jd-out card">
          <div class="out-head">
            <b>🧭 景点大纲</b>
            <span class="hint">{{ spots.length }} 个</span>
          </div>
          <ol v-if="spots.length" class="out-list">
            <li v-for="(s, i) in spots" :key="s.name" class="out-item" :class="{ dragging: dragIdx === i }"
                draggable="true" @dragstart="dragIdx = i" @dragover.prevent @drop.prevent="dropOn(i)" @dragend="dragIdx = null">
              <span class="out-grip" title="按住拖动调整顺序">⋮⋮</span>
              <span class="out-idx">{{ i + 1 }}</span>
              <span class="out-name" :title="s.note || ''">{{ s.name }}</span>
              <button class="xbtn" title="从大纲移除" @click="removeSpot(i)">✕</button>
            </li>
          </ol>
          <p v-else class="hint">还没有景点，下面加一个；顺序就是路线连线的顺序。</p>
          <div class="out-add">
            <input v-model="newSpot" class="input" placeholder="新增景点名，回车" @keydown.enter.prevent="addSpot" />
            <button class="btn ghost sm" :disabled="!newSpot.trim()" @click="addSpot">加</button>
          </div>
          <p class="hint out-tip">拖动 = 改顺序；顺序同时决定路线连线的走向，也重排生成时喂给 AI 的景点顺序。</p>
        </aside>

        <div class="jd-main">
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

            <!-- 照片：默认折叠，展开后右下角标出正文里的占位编号 (photo:N) -->
            <div v-if="photos.length" class="strip-wrap">
              <button class="btn ghost sm" @click="showPhotos = !showPhotos">{{ showPhotos ? '收起照片' : `展开照片（${photos.length} 张）` }}</button>
              <span class="hint">右下角的 <code>(photo:N)</code> 就是正文里的图片占位编号；点开可设为封面。</span>
              <div v-if="showPhotos" class="strip">
                <div v-for="p in photos" :key="p.id" class="thumb" :class="{ on: j?.cover_photo_id === p.id }" @click="setCover(p)" :title="p.id === j?.cover_photo_id ? '当前封面' : '点我设为封面'">
                  <div class="tw">
                    <img :src="withToken('/api/journals/' + id + '/photos/' + p.id + '/file')" alt="" />
                    <span v-if="j?.cover_photo_id === p.id" class="cov-badge">封面</span>
                    <span class="pnum">(photo:{{ p.sort }})</span>
                  </div>
                  <span v-if="p.caption" class="tcap">{{ p.caption }}</span>
                  <span class="tmeta">{{ sizeLabel(p) }}</span>
                </div>
                <span class="hint" style="align-self: center">未手选封面时，生成完随机选一张。</span>
              </div>
            </div>
          </div>

          <!-- 景点连线路线图（顺序=大纲顺序，坐标取自景点库/高德） -->
          <div v-if="routeCard" class="card route-card">
            <div class="route-head">
              <b>🗺️ 景点路线</b>
              <span class="hint" v-if="j?.route?.at">{{ j.route.at }}</span>
              <span style="flex: 1"></span>
              <button class="btn ghost sm" :disabled="routeBusy" @click="postRoute(true)">{{ routeBusy ? '生成中…' : '重新生成路线' }}</button>
            </div>
            <img v-if="j?.route?.url" class="route-img" :src="j.route.url" alt="景点路线图" />
            <p v-if="j?.route?.summary" class="route-sum">{{ j.route.summary }}</p>
            <p v-else-if="j?.route?.reason" class="hint">没画出连线：{{ j.route.reason }}</p>
          </div>

          <!-- 编辑模式：富文本（存 HTML），自动保存实时版；「保存一版」存手动版 -->
          <div v-if="editing" class="card">
            <div class="pb-bar">
              <span class="hint">富文本编辑：图片直接显示，尺寸标在图片下方。改动会自动存成当前正文。</span>
              <div class="pb-btns">
                <span class="hint" v-if="saveHint">{{ saveHint }}</span>
                <button class="btn ghost sm" :disabled="busyRestore || !j?.has_manual"
                        :title="j?.has_manual ? '回到上次点「保存一版」时的那一份' : '还没手动保存过，先点「保存一版」'"
                        @click="restoreVersion('manual')">恢复一版</button>
                <button class="btn ghost sm" :disabled="busyRestore || !j?.has_original"
                        title="回到系统 AI 最初生成的那一版"
                        @click="restoreVersion('original')">恢复原版</button>
                <button class="btn ghost sm" @click="closeEdit">取消</button>
                <button class="btn sm" :disabled="savingVer" @click="saveVersion">{{ savingVer ? '保存中…' : '保存一版' }}</button>
              </div>
            </div>
            <div class="rt-tools">
              <button class="rtb" title="二级标题" @mousedown.prevent="cmd('formatBlock', 'h2')">H2</button>
              <button class="rtb" title="三级标题" @mousedown.prevent="cmd('formatBlock', 'h3')">H3</button>
              <span class="rt-sep"></span>
              <button class="rtb" title="加粗" @mousedown.prevent="cmd('bold')"><b>B</b></button>
              <button class="rtb" title="斜体" @mousedown.prevent="cmd('italic')"><i>I</i></button>
              <button class="rtb" title="无序列表" @mousedown.prevent="cmd('insertUnorderedList')">• 列表</button>
              <button class="rtb" title="引用" @mousedown.prevent="cmd('formatBlock', 'blockquote')">❝</button>
              <span class="rt-sep"></span>
              <button class="rtb" title="插入图片 / 调整显示宽度" @mousedown.prevent="openImgDlg">🖼 插图</button>
              <button class="rtb" title="撤销" @mousedown.prevent="cmd('undo')">↶</button>
            </div>
            <div ref="editorEl" class="rt-editor" contenteditable="true" spellcheck="false"
                 @input="onEditInput" @keyup="rememberRange" @mouseup="rememberRange" @blur="rememberRange"></div>
            <p class="hint ver-line">
              同一篇存三套：<b>实时版</b>（正在编辑，自动保存）· <b>手动版</b>{{ j?.has_manual ? `（${j.manual_len} 字，可「恢复一版」）` : '（还没存过）' }} ·
              <b>系统原版</b>{{ j?.has_original ? `（${j.original_len} 字，可「恢复原版」）` : '（无）' }}
            </p>
          </div>
          <div v-else class="card jr-md" v-html="html"></div>

          <details v-if="j?.prompt" class="card promptbox">
            <summary>📋 本次生成的完整提示词（默认折叠）</summary>
            <pre>{{ j.prompt }}</pre>
          </details>
        </div>
      </div>
    </template>

    <!-- 插图对话框：从游记已上传的照片里选，或从本机/手机现传 -->
    <div v-if="imgDlg" class="mask" @click.self="imgDlg = false">
      <div class="card img-dlg">
        <div class="dlg-head">
          <b>插入图片</b>
          <button class="xbtn always" @click="imgDlg = false">✕</button>
        </div>
        <div class="img-tabs">
          <button class="btn ghost sm" :class="{ on: imgTab === 'uploaded' }" @click="imgTab = 'uploaded'">从游记照片选</button>
          <button class="btn ghost sm" :class="{ on: imgTab === 'device' }" @click="imgTab = 'device'">从本机/手机上传</button>
        </div>
        <div v-if="imgTab === 'uploaded'" class="img-pane">
          <p v-if="!photos.length" class="hint">这篇游记还没有照片，切到「从本机/手机上传」传一张。</p>
          <div v-else class="picks">
            <div v-for="p in photos" :key="p.id" class="pick" @click="insertPhoto(p)">
              <img :src="photoUrlOf(p)" alt="" />
              <span class="pk-cap">{{ p.caption || p.spot || ('照片 ' + p.sort) }}</span>
              <span class="pk-meta">{{ sizeLabel(p) }}</span>
            </div>
          </div>
        </div>
        <div v-else class="img-pane">
          <p class="hint">支持 PNG / JPEG / WEBP，单张 ≤ 8MB；手机上会直接打开相册或相机。</p>
          <input ref="fileEl" class="input" type="file" accept="image/png,image/jpeg,image/webp" @change="onPickFile" />
          <p v-if="imgBusy" class="hint">上传中…</p>
        </div>
        <div class="w-row">
          <span class="hint">插入后的显示宽度：</span>
          <button v-for="o in WIDTHS" :key="o.v" class="btn ghost sm" :class="{ on: imgWidth === o.v }" @click="imgWidth = o.v">{{ o.label }}</button>
          <span class="hint">（原图 = 按图片自身尺寸，超宽时自动缩到栏宽）</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { api, withToken, downloadPdfFile } from '../api/index.js';
import { cleanMd } from '../md.js';
import { PALETTES } from '../journalPalettes.js';
import { renderJournalPng } from '../journalPng.js';
import { isHtml, decorateJournalHtml, sizeLabel } from '../htmlMd.js';

const route = useRoute();
const id = route.params.id;
const j = ref(null);
const status = ref('pending');
const photos = ref([]);
const streamed = ref('');
const stage = ref('');
const editing = ref(false);
const editorEl = ref(null);
const imgDlg = ref(false);
const imgTab = ref('uploaded');
const imgWidth = ref(100);
const imgBusy = ref(false);
const fileEl = ref(null);
const WIDTHS = [
  { v: 100, label: '原图' },
  { v: 75, label: '75%' },
  { v: 50, label: '50%' },
  { v: 33, label: '33%' },
];
let savedRange = null;
const pngBusy = ref(false);
const pdfBusy = ref(false);
const titleEditing = ref(false);
const titleText = ref('');
const titleBusy = ref(false);
const showPhotos = ref(false);          // v1.9.0 需求 5：封面下的照片默认折叠
const newSpot = ref('');
const dragIdx = ref(null);
const routeBusy = ref(false);
const saveHint = ref('');
const savingVer = ref(false);
const busyRestore = ref(false);
let es = null;
let autoTimer = 0;

marked.setOptions({ breaks: true, gfm: true });

const pal = computed(() => PALETTES[((j.value?.palette || 1) - 1 + PALETTES.length) % PALETTES.length]);
const spots = computed(() => j.value?.spots || []);
const coverPhoto = computed(() => {
  if (!photos.value.length) return null;
  return photos.value.find((p) => p.id === j.value?.cover_photo_id) || photos.value[0];
});
const coverUrl = computed(() => (coverPhoto.value ? withToken('/api/journals/' + id + '/photos/' + coverPhoto.value.id + '/file') : ''));
const subFallback = computed(() => j.value?.destination || '');
const peek = computed(() => (streamed.value ? streamed.value.slice(-220) : ''));
// 只有景点 ≥2 才值得摆路线卡（1 个点连不成线，0 个点更没得说）
const routeCard = computed(() => !!j.value?.route && spots.value.length >= 2);

// 正文：新写入的是 HTML，AI 直接生成的和历史行仍是 Markdown——按内容判定分流。
// ⚠️ HTML 绝不能进 cleanMd（它会从第一个 Markdown 标题开始截断，第一段/第一张图会静默消失）。
const rawContent = () => streamed.value || j.value?.content || '';
const photoUrlOf = (p) => withToken('/api/journals/' + id + '/photos/' + p.id + '/file');
const html = computed(() => {
  const raw = rawContent();
  const src = isHtml(raw) ? raw : marked.parse(mdWithPhotos(cleanMd(raw)));
  return decorateJournalHtml(src, { photos: photos.value, photoUrl: photoUrlOf });
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
    if (r.journal.status === 'done') { maybeRoute(); loadCommunity(); }
  } catch (e) {
    status.value = 'error';
    j.value = { error: e.message };
  }
}

// ---- 社区发布（v1.13.0）：快照=当前已保存正文+照片；再点一次撤下 ----
const communityPost = ref(null);
const communityBusy = ref(false);
async function loadCommunity() {
  if (status.value !== 'done') { communityPost.value = null; return; }
  try {
    const r = await api('/community/by-source?kind=journal&source_id=' + encodeURIComponent(id));
    communityPost.value = r.shared ? r.post : null;
  } catch { communityPost.value = null; }
}
async function toggleCommunity() {
  if (communityBusy.value) return;
  communityBusy.value = true;
  try {
    if (communityPost.value) {
      await api('/community/posts/' + communityPost.value.id, { method: 'DELETE' });
      communityPost.value = null;
    } else {
      await api('/community/publish', { method: 'POST', body: { kind: 'journal', source_id: Number(id) } });
      await loadCommunity();
    }
  } catch (e) {
    alert(e.message);
  } finally {
    communityBusy.value = false;
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

// ---- 大纲：景点顺序（拖动 / 新增 / 移除），顺序同时决定路线连线与喂给 AI 的景点顺序 ----
async function persistSpots(next) {
  try {
    const r = await api('/journals/' + id, { method: 'PUT', body: { spots: next } });
    j.value = r.journal;
    if (j.value.route) await postRoute(true); // 顺序变了，路线重画
  } catch (e) { alert('保存景点失败：' + e.message); }
}
function dropOn(i) {
  const src = dragIdx.value;
  dragIdx.value = null;
  if (src === null || src === i) return;
  const next = spots.value.slice();
  const [s] = next.splice(src, 1);
  next.splice(src < i ? i - 1 : i, 0, s);
  persistSpots(next);
}
function addSpot() {
  const n = newSpot.value.trim();
  if (!n) return;
  newSpot.value = '';
  if (spots.value.some((s) => s.name === n)) return;
  persistSpots([...spots.value, { name: n, attraction_id: null, note: '' }]);
}
function removeSpot(i) {
  if (!confirm(`从大纲移除「${spots.value[i]?.name}」？照片与正文不动，只影响大纲与路线。`)) return;
  const next = spots.value.slice();
  next.splice(i, 1);
  persistSpots(next);
}

// ---- 路线图：进页面若还没有结果就自动算一次；改顺序/手动点 = 强制重算 ----
async function maybeRoute() {
  if (j.value?.route || routeBusy.value) return;
  if ((j.value?.spots || []).length < 2) return;
  postRoute(false);
}
async function postRoute(force) {
  if (routeBusy.value) return;
  if (!force && j.value?.route) return;
  routeBusy.value = true;
  try {
    const out = await api('/journals/' + id + '/route', { method: 'POST' });
    j.value = { ...j.value, route: out };
  } catch { /* 路线是加分项：失败静默，卡片位置靠 route 有无决定 */ } finally { routeBusy.value = false; }
}

// ---- 生成 / 编辑 ----
async function backToWizard() {
  if (j.value?.has_manual) {
    const ok = confirm('回引导模式改答案再生成：新生成会覆盖当前正文（已「保存一版」的手动版和系统原版都留着，可以恢复）。继续？');
    if (!ok) return;
  } else {
    const ok = confirm('回引导模式改答案再生成：新生成会覆盖当前正文。想留一份就先「编辑 → 保存一版」。继续？');
    if (!ok) return;
  }
  location.hash = '#/journals/new?draft=' + id;
}
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
  try {
    await api('/journals/' + id + '/regenerate', { method: 'POST' });
    status.value = 'pending';
    streamed.value = '';
    stage.value = '';
    if (es) { es.close(); es = null; }
    connect();
  } catch (e) { alert(e.message); }
}
// ---- 富文本编辑：种子 → contenteditable（只写一次 innerHTML，之后不再响应式覆盖，否则光标会跳） ----
// Markdown 稿（AI 生成/历史行）先渲染成 HTML 再进编辑器；HTML 稿原样进。保存一律写 HTML。
function seedHtml() {
  const raw = rawContent();
  return isHtml(raw) ? raw : marked.parse(mdWithPhotos(cleanMd(raw)));
}
function applyEditorSeed(seed) {
  const el = editorEl.value;
  if (!el) return;
  el.innerHTML = decorateJournalHtml(seed, { photos: photos.value, photoUrl: photoUrlOf, editable: true });
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
  } catch { /* 没有选区也不影响编辑 */ }
}
function startEdit() {
  saveHint.value = '';
  editing.value = true;
  nextTick(() => applyEditorSeed(seedHtml()));
}
// 序列化：图片 URL 换回 photo:N（绝不把 token/绝对地址写进库），编辑态属性与尺寸标注全部剥掉
function serializeEditor() {
  const el = editorEl.value;
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.rt-cap').forEach((n) => n.remove());
  clone.querySelectorAll('img').forEach((img) => {
    const wrap = img.closest ? img.closest('.rt-img') : null;
    const sort = String((wrap && wrap.getAttribute('data-photo')) || img.getAttribute('data-photo') || '').trim();
    if (sort) img.setAttribute('src', 'photo:' + sort);
    img.removeAttribute('data-photo');
    ['srcset', 'width', 'height'].forEach((a) => img.removeAttribute(a));
    ['width', 'height', 'max-width'].forEach((p) => img.style.removeProperty(p));
  });
  clone.querySelectorAll('.rt-img').forEach((w) => w.removeAttribute('contenteditable'));
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('spellcheck');
  return clone.innerHTML.trim();
}
function rememberRange() {
  const el = editorEl.value;
  const sel = window.getSelection();
  if (!el || !sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (el.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
}
function cmd(name, val) {
  const el = editorEl.value;
  if (!el) return;
  el.focus();
  try { document.execCommand(name, false, val); } catch { /* 浏览器不支持就忽略 */ }
  rememberRange();
  onEditInput();
}
function closeEdit() {
  clearTimeout(autoTimer); // 最后一次输入若还没落库，取消编辑前先补一次
  if (serializeEditor() !== (j.value?.content || '')) pushLive();
  editing.value = false;
}
// 自动保存实时版（防抖 1.2s）：编辑框里改的就是当前正文，页面刷新/关掉都不丢
function onEditInput() {
  saveHint.value = '正在自动保存…';
  clearTimeout(autoTimer);
  autoTimer = setTimeout(pushLive, 1200);
}
async function pushLive() {
  const content = serializeEditor();
  try {
    const r = await api('/journals/' + id, { method: 'PUT', body: { content } });
    const saved = r.journal ? r.journal.content : content; // 服务端净化后的权威值
    streamed.value = saved;
    j.value = { ...j.value, content: saved };
    saveHint.value = '已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (e) { saveHint.value = '自动保存失败：' + e.message; }
}
async function saveVersion() {
  savingVer.value = true;
  clearTimeout(autoTimer);
  try {
    const r = await api('/journals/' + id + '/content/save-version', { method: 'POST', body: { content: serializeEditor() } });
    streamed.value = r.content;
    j.value = { ...j.value, content: r.content, has_manual: true, manual_len: r.manual_len };
    saveHint.value = '已保存一版（' + r.manual_len + ' 字）';
  } catch (e) { alert('保存一版失败：' + e.message); } finally { savingVer.value = false; }
}
async function restoreVersion(which) {
  const label = which === 'manual' ? '手动保存版' : '系统生成版';
  if (!confirm(`恢复${label}会覆盖当前正文（想反悔可以先「保存一版」），确定？`)) return;
  busyRestore.value = true;
  clearTimeout(autoTimer);
  try {
    const r = await api('/journals/' + id + '/content/restore', { method: 'POST', body: { which } });
    streamed.value = r.content;
    j.value = { ...j.value, content: r.content };
    applyEditorSeed(isHtml(r.content) ? r.content : marked.parse(cleanMd(r.content)));
    saveHint.value = '已恢复' + label;
  } catch (e) { alert('恢复失败：' + e.message); } finally { busyRestore.value = false; }
}

// ---- 插图：从已上传照片里选 / 从本机或手机现传；插入时按选定宽度写 data-w ----
function openImgDlg() {
  rememberRange();
  imgTab.value = photos.value.length ? 'uploaded' : 'device';
  imgWidth.value = 100;
  imgDlg.value = true;
}
function photoHtml(p, w) {
  const url = photoUrlOf(p);
  const alt = String(p.caption || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const style = (w > 0 && w < 100)
    ? ` style="width:${w}%;max-width:100%;height:auto"`
    : ' style="max-width:100%;height:auto"';
  return `<span class="rt-img" data-photo="${p.sort}" data-w="${w}"><img src="${url}" alt="${alt}"${style}>`
    + `<span class="rt-cap" contenteditable="false">${sizeLabel(p)}</span></span><p><br></p>`;
}
function insertPhoto(p) {
  const el = editorEl.value;
  if (!el) { imgDlg.value = false; return; }
  el.focus();
  const sel = window.getSelection();
  if (savedRange && el.contains(savedRange.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  const html = photoHtml(p, imgWidth.value);
  let ok = false;
  try { ok = document.execCommand('insertHTML', false, html); } catch { ok = false; }
  if (!ok) el.insertAdjacentHTML('beforeend', html);
  imgDlg.value = false;
  rememberRange();
  onEditInput();
}
function onPickFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(f.type)) return alert('只支持 PNG / JPEG / WEBP');
  if (f.size > 8 * 1024 * 1024) return alert('单张照片不能超过 8MB');
  const reader = new FileReader();
  reader.onload = async () => {
    imgBusy.value = true;
    try {
      const r = await api('/journals/' + id + '/photos', {
        method: 'POST',
        body: { data_url: String(reader.result), spot: (spots.value[0] && spots.value[0].name) || '' },
      });
      photos.value = [...photos.value, r.photo];
      insertPhoto(r.photo);
      saveHint.value = '已上传照片 (photo:' + r.photo.sort + ')';
    } catch (e2) { alert('上传失败：' + e2.message); } finally { imgBusy.value = false; }
  };
  reader.onerror = () => alert('读取文件失败');
  reader.readAsDataURL(f);
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
    const raw = j.value?.content || '';
    await renderJournalPng({
      title: j.value?.title || j.value?.destination || '旅行游记',
      subtitle: j.value?.subtitle || subFallback.value,
      // HTML 稿在 journalPng 里转回 Markdown；只能对 Markdown 调 cleanMd
      markdown: isHtml(raw) ? raw : cleanMd(raw),
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
onBeforeUnmount(() => {
  if (es) es.close();
  clearTimeout(autoTimer);
});
</script>

<style scoped>
.jd { max-width: 1180px; margin: 0 auto; }
.jd-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.status-card { text-align: center; padding: 30px 20px; }
.spin { font-size: 40px; animation: hop 0.9s ease-in-out infinite; }
@keyframes hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
.stg { margin-top: 10px; }
.genbar { height: 8px; border-radius: 4px; background: var(--card2); overflow: hidden; margin: 12px auto 6px; max-width: 420px; }
.genbar .fill { height: 100%; background: linear-gradient(90deg, var(--acc-d), color-mix(in srgb, var(--acc-d) 60%, #fff)); }
.peek { max-width: 520px; margin: 12px auto 0; text-align: left; white-space: pre-wrap; word-break: break-all; font-size: 12px; color: var(--mut); background: var(--card2); border-radius: 8px; padding: 8px 10px; max-height: 3.6em; overflow: hidden; }
.peek.dim { opacity: 0.5; }

/* 两栏：左大纲 + 右正文 */
.jd-wrap { display: flex; gap: 16px; align-items: flex-start; }
.jd-out { width: 220px; flex: none; position: sticky; top: 14px; }
.out-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.out-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.out-item { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 8px; font-size: 13px; cursor: grab; }
.out-item:hover { background: var(--card2); }
.out-item:hover .xbtn { opacity: 1; }
.out-item.dragging { opacity: 0.45; }
.out-item:active { cursor: grabbing; }
.out-grip { color: var(--mut); letter-spacing: -2px; font-size: 12px; }
.out-idx { width: 18px; height: 18px; border-radius: 50%; background: var(--card2); color: var(--mut); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.out-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.out-add { display: flex; gap: 6px; margin-top: 10px; }
.out-add .input { flex: 1; min-width: 0; font-size: 13px; }
.out-tip { margin-top: 8px; line-height: 1.5; }
.xbtn { border: none; background: none; color: var(--mut); cursor: pointer; font-size: 12px; padding: 0 2px; opacity: 0; flex: none; }
.jd-main { flex: 1; min-width: 0; }
@media (max-width: 900px) {
  .jd-wrap { flex-direction: column; }
  .jd-out { width: 100%; position: static; }
}

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
.strip-wrap { margin-top: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.strip { display: flex; gap: 10px; flex-wrap: wrap; width: 100%; }
.thumb { position: relative; width: 108px; cursor: pointer; border-radius: 8px; overflow: hidden; border: 2px solid transparent; }
.thumb.on { border-color: var(--acc-d); }
.tw { position: relative; }
.thumb img { width: 108px; height: 76px; object-fit: cover; display: block; }
.pnum { position: absolute; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.62); color: #fff; font-size: 10.5px; padding: 1px 6px; border-radius: 8px 0 0 0; letter-spacing: 0.3px; }
.tcap { display: block; font-size: 11px; color: var(--mut); padding: 4px 5px; background: var(--card2); max-height: 3em; overflow: hidden; }
.cov-badge { position: absolute; top: 5px; left: 5px; background: var(--acc-d); color: #fff; font-size: 10.5px; padding: 1px 7px; border-radius: 9px; }
.route-card { margin-top: 14px; }
.route-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.route-img { width: 100%; border-radius: 10px; display: block; }
.route-sum { margin: 10px 0 0; font-size: 13.5px; color: var(--text); line-height: 1.7; }
.pb-bar { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.pb-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ver-line { margin-top: 8px; line-height: 1.7; }
.jr-md :deep(img) { max-width: 100%; border-radius: 10px; margin: 8px 0; }
/* 富文本编辑区（v1.12.0） */
.rt-tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--line); border-bottom: none; border-radius: 10px 10px 0 0; background: var(--card2); }
.rtb { border: 1px solid transparent; background: none; color: var(--text); font-size: 12.5px; padding: 4px 9px; border-radius: 7px; cursor: pointer; line-height: 1.4; }
.rtb:hover { background: var(--card); border-color: var(--line); }
.rt-sep { width: 1px; height: 16px; background: var(--line); margin: 0 3px; }
/* 编辑区高度不再随正文无限拉长：内容超出就在框内滚动，工具栏始终留在视野上方 */
.rt-editor { min-height: 320px; max-height: 62vh; overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; padding: 14px 16px; border: 1px solid var(--line); border-radius: 0 0 10px 10px; background: var(--card); font-size: 14px; line-height: 1.85; outline: none; overflow-wrap: break-word; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.rt-editor::-webkit-scrollbar { width: 10px; }
.rt-editor::-webkit-scrollbar-track { background: transparent; }
.rt-editor::-webkit-scrollbar-thumb { background: var(--line); border-radius: 6px; border: 2px solid var(--card); }
.rt-editor::-webkit-scrollbar-thumb:hover { background: var(--mut); }
.rt-editor:focus { border-color: var(--acc-d); }
.rt-editor :deep(h2) { font-size: 20px; margin: 14px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 5px; }
.rt-editor :deep(h3) { font-size: 16.5px; margin: 12px 0 6px; }
.rt-editor :deep(blockquote) { margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--acc-d); color: var(--mut); background: var(--card2); border-radius: 0 8px 8px 0; }
.rt-editor :deep(img) { border-radius: 8px; display: block; margin: 4px 0; }
.rt-editor :deep(.rt-img), .jr-md :deep(.rt-img) { display: block; margin: 12px 0; }
.rt-editor :deep(.rt-cap), .jr-md :deep(.rt-cap) { display: block; font-size: 11.5px; color: var(--mut); margin-top: 3px; }
.tmeta { display: block; font-size: 10.5px; color: var(--mut); padding: 0 5px 4px; background: var(--card2); }
/* 插图对话框 */
.mask { position: fixed; inset: 0; background: rgba(20, 30, 22, 0.42); display: flex; align-items: center; justify-content: center; z-index: 120; padding: 16px; }
.img-dlg { width: min(720px, 100%); max-height: 86vh; overflow: auto; }
.dlg-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.xbtn.always { opacity: 1; font-size: 15px; }
.img-tabs { display: flex; gap: 8px; margin-bottom: 10px; }
.img-tabs .btn.on { border-color: var(--acc-d); color: var(--text); background: var(--card2); }
.img-pane { margin-bottom: 10px; }
.picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.pick { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; cursor: pointer; background: var(--card); }
.pick:hover { border-color: var(--acc-d); }
.pick img { width: 100%; height: 84px; object-fit: cover; display: block; }
.pk-cap { display: block; font-size: 12px; padding: 4px 6px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-meta { display: block; font-size: 10.5px; color: var(--mut); padding: 1px 6px 5px; }
.w-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid var(--line); }
.w-row .btn.on { border-color: var(--acc-d); color: var(--text); background: var(--card2); }
.jr-md :deep(h2) { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.promptbox { margin-top: 14px; }
.promptbox pre { white-space: pre-wrap; font-size: 12px; max-height: 320px; overflow: auto; }
</style>
