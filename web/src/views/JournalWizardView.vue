<template>
  <div>
    <h2 style="margin: 0 0 6px">📖 写游记</h2>
    <p class="hint" style="margin: 0 0 14px">问答式录入，一问一答往下走；不想答的点「跳过」。草稿自动保存，中途退出也能回来接着写。</p>

    <div class="card wiz">
      <div class="steps-bar">
        <span class="st" :class="{ done: step > i, on: step === i }" v-for="(s, i) in STEPS" :key="i">{{ i + 1 }}</span>
        <span class="hint" style="margin-left: auto">{{ STEPS[step].title }}（{{ step + 1 }}/{{ STEPS.length }}）</span>
      </div>

      <!-- 每步一问 -->
      <div class="q-area">
        <h3>{{ STEPS[step].title }}</h3>
        <p class="hint">{{ STEPS[step].hint }}</p>

        <!-- 目的地：城市库联想 -->
        <template v-if="step === 0">
          <input v-model="destQ" class="input" style="max-width: 320px" placeholder="输入目的地城市，如：杭州" @input="destTyping" />
          <div v-if="destHits.length" class="dest-hits">
            <span v-for="c in destHits" :key="c.id" class="chip" :class="{ on: form.city_id === c.id }" @click="pickDest(c)">{{ c.name }}<small> {{ c.province }}</small></span>
          </div>
        </template>

        <!-- 出发地 -->
        <input v-else-if="step === 1" v-model="form.meta.origin" class="input" style="max-width: 320px" placeholder="如：上海" />

        <!-- 天数：只选天数不选日期 -->
        <div v-else-if="step === 2" class="chip-row">
          <span v-for="n in [1, 2, 3, 4, 5, 6, 7, 8, 10, 15]" :key="n" class="chip" :class="{ on: form.meta.days === String(n) }" @click="form.meta.days = String(n)">{{ n }} 天</span>
        </div>

        <!-- 人数 -->
        <input v-else-if="step === 3" v-model="form.meta.people" class="input" style="max-width: 320px" placeholder="如：2 人 / 一家三口 / 独自" />

        <!-- 出发交通方式 -->
        <div v-else-if="step === 4" class="chip-row">
          <span v-for="t in ['高铁', '飞机', '自驾', '大巴', '火车', '轮船', '其他']" :key="t" class="chip" :class="{ on: form.meta.transport === t }" @click="form.meta.transport = t">{{ t }}</span>
        </div>

        <!-- 目的地出行方式 -->
        <div v-else-if="step === 5" class="chip-row">
          <span v-for="t in ['地铁公交', '打车', '租车自驾', '步行', '骑行', '包车']" :key="t" class="chip" :class="{ on: form.meta.local_transport === t }" @click="form.meta.local_transport = t">{{ t }}</span>
        </div>

        <!-- 旅行偏好（可多选） -->
        <div v-else-if="step === 6" class="chip-row">
          <span v-for="t in ['人文', '自然风光', '美食', '逛街', '休闲', '拍照打卡', '亲子', '徒步']" :key="t" class="chip" :class="{ on: form.meta.prefs.includes(t) }" @click="togglePref(t)">{{ t }}</span>
        </div>

        <!-- 总费用 -->
        <input v-else-if="step === 7" v-model="form.meta.budget" class="input" style="max-width: 320px" placeholder="如：约 5000 元/人" />

        <!-- 住宿档次 -->
        <div v-else-if="step === 8" class="chip-row">
          <span v-for="t in ['青旅/民宿', '舒适连锁', '四星', '五星/度假']" :key="t" class="chip" :class="{ on: form.meta.hotel === t }" @click="form.meta.hotel = t">{{ t }}</span>
        </div>

        <!-- 季节 -->
        <div v-else-if="step === 9" class="chip-row">
          <span v-for="t in ['春', '夏', '秋', '冬']" :key="t" class="chip" :class="{ on: form.meta.season === t }" @click="form.meta.season = t">{{ t }}季</span>
        </div>

        <!-- 所到景点：城市景点库备选 + 边录边搜 + 搜不到再按文本添加 -->
        <template v-else-if="step === 10">
          <p v-if="!form.city_id" class="hint">没有选目的地城市：下面输入时也会边录边搜（全库范围），搜不到的按你写的加。</p>
          <div v-if="form.city_id && spotOptions.length" class="chip-row" style="margin-bottom: 10px">
            <span v-for="a in spotOptions" :key="a.id" class="chip" :class="{ on: !!form.spots.find((s) => s.attraction_id === a.id) }" @click="toggleSpot(a)">{{ a.name }}<small v-if="a.must"> ★</small></span>
          </div>
          <div class="spot-add">
            <input v-model="spotInput" class="input" placeholder="边录边搜：输入景点名，底下实时给库内建议" @input="spotTyping" @focus="spotTyping" @keydown.enter.prevent="addSpotInput" @blur="hideHitsLater" />
            <button class="btn sm ghost" @click="addSpotInput">＋ 按我写的加</button>
            <div v-if="spotHits.length" class="sug-inline">
              <div v-for="a in spotHits" :key="a.id" class="s" @mousedown.prevent="pickSpotHit(a)">
                <span>{{ a.name }}</span>
                <small>{{ a.city || '' }}<span v-if="a.must"> ★</span><span v-if="a.level"> {{ a.level }}</span></small>
              </div>
            </div>
          </div>
          <p v-if="spotInput.trim() && !spotHits.length" class="hint" style="margin-top: 6px">库里没有搜到——回车或点「按我写的加」，就用你输入的名字。</p>
          <ol v-if="form.spots.length" class="spot-list">
            <li v-for="(s, i) in form.spots" :key="s.name">
              <span class="sl-idx">{{ i + 1 }}</span>
              <b>{{ s.name }}</b>
              <span class="hint">{{ s.attraction_id ? '库内景点' : '手动录入' }}</span>
              <button class="xbtn" title="从列表移除" @click="form.spots.splice(i, 1)">✕</button>
            </li>
          </ol>
        </template>

        <!-- 照片与体验说明 -->
        <template v-else-if="step === 11">
          <p class="hint">
            给去过的景点配照片（≤8MB/张，PNG/JPG/WEBP）。景点可<strong>按住标题拖动</strong>换顺序，也可用 ↑↓ 微调（这里每张照片的编号 photo:N 会跟着变）。<br />
            每张可写体验说明或让 AI 写一句；每个景点标题下的「体会」框随手记几句，AI 生成时会融进那一段。
          </p>
          <div class="photo-groups">
            <div v-for="(g, gi) in photoGroups" :key="g.key" class="pgroup">
              <div class="pg-head" :class="{ draggable: g.si >= 0 }" :draggable="g.si >= 0"
                   @dragstart="dragGroup = gi" @dragover.prevent @drop.prevent="dropGroup(gi)" @dragend="dragGroup = null">
                <span v-if="g.si >= 0" class="pg-grip" title="按住拖动调整景点顺序">⋮⋮</span>
                <b>{{ g.name || '（未分景点）' }}</b>
                <span v-if="g.si >= 0" class="pg-move">
                  <button class="btn-plain" :disabled="g.si === 0" title="上移" @click="moveSpot(g.si, -1)">↑</button>
                  <button class="btn-plain" :disabled="g.si === form.spots.length - 1" title="下移" @click="moveSpot(g.si, 1)">↓</button>
                </span>
                <span class="hint" v-if="g.photos.length">{{ g.photos.length }} 张</span>
              </div>
              <input v-if="g.si >= 0" class="input note-in" :value="spotNote(g.name)" placeholder="这个景点的体会（写几句心里话，AI 会融进这段）" @input="setSpotNote(g.name, $event.target.value)" @change="saveDraft" />
              <div class="prow">
                <div v-for="(p, pi) in g.photos" :key="p.id" class="pbox" draggable="true" title="按住拖动可换图片顺序"
                     @dragstart="dragPhoto = { g: gi, i: pi }" @dragover.prevent @drop.prevent.stop="dropPhoto(gi, pi)" @dragend="dragPhoto = null">
                  <span class="pimg">
                    <img :src="withToken('/api/journals/' + journalId + '/photos/' + p.id + '/file')" />
                    <span class="pnum">(photo:{{ p.sort }})</span>
                  </span>
                  <div class="pcap">
                    <textarea v-model="p.caption" rows="2" placeholder="体验说明（可留空让 AI 写）" @change="saveCaption(p)"></textarea>
                    <div class="pbtns">
                      <button class="btn ghost sm" :disabled="p.aiBusy" @click="aiCaption(p, false)">✨ AI 写</button>
                      <button class="btn ghost sm" :disabled="p.aiBusy || !p.caption" :title="p.caption ? '参考你写的重新润色' : '先写几个字再参考生成'" @click="aiCaption(p, true)">✨ 参考我写的</button>
                      <button class="btn ghost sm" @click="delPhoto(p)">删</button>
                    </div>
                    <span v-if="p.caption_by === 'ai'" class="badge gray" style="margin-top: 4px">AI</span>
                  </div>
                </div>
                <label class="padd" :data-spot="g.name">
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden @change="uploadPhotos($event, g.name)" />
                  ＋ 加照片
                </label>
              </div>
            </div>
          </div>
          <div class="pg-add">
            <input v-model="newSpotName" class="input" placeholder="插入新景点：输入名称，回车" @keydown.enter.prevent="addSpotInline" />
            <button class="btn ghost sm" @click="addSpotInline">＋ 插入景点</button>
            <span class="hint">新景点会带一个自己的「加照片」入口</span>
          </div>
        </template>

        <!-- 生成设置：合并攻略？ -->
        <template v-else-if="step === 12">
          <p class="hint">结合攻略框架：合并=游记里带上你那篇攻略的实用信息（交通/住宿/美食/门票，文末附速查）；不合并=纯旅行记录。</p>
          <label class="radio-row"><input type="radio" value="" v-model="mergeGuideId" /> 纯旅行记录（不合并）</label>
          <label v-for="g in myGuides" :key="g.id" class="radio-row">
            <input type="radio" :value="g.id" v-model="mergeGuideId" /> 合并《{{ g.title || g.destination }}（{{ g.days }}天）》
          </label>
          <p v-if="!myGuides.length" class="hint">你还没有已完成的攻略，只能纯记录。</p>
        </template>

        <!-- 生成 -->
        <template v-else>
          <p>答案齐了：{{ summaryLine }}</p>
          <p class="hint">点「生成游记」后 AI 开始写作（进度在下一页实时可见）；标题也会顺手起一个（≤20 字，可换可重生成）。</p>
          <p v-if="genErr" class="err-text">{{ genErr }}</p>
        </template>
      </div>

      <div class="nav-row">
        <button class="btn ghost" :disabled="step === 0" @click="step--">← 上一问</button>
        <span class="hint" v-if="saveState">{{ saveState }}</span>
        <span v-if="quota" class="hint">
          游记剩余：<b>{{ quota.unlimited ? '不限' : quota.left + ' 次' }}</b>
          <span v-if="!quota.unlimited">（共 {{ quota.limit }} 次，已用 {{ quota.used }}）</span>
        </span>
        <span style="flex: 1"></span>
        <button class="btn ghost" v-if="STEPS[step].skippable" @click="step++">跳过 →</button>
        <button v-if="step < STEPS.length - 1" class="btn" @click="next">{{ '下一问 →' }}</button>
        <button v-else class="btn" :disabled="generating || quotaOut" @click="generate">{{ generating ? '提交中…' : '生成游记 ✍️' }}</button>
      </div>
      <p v-if="quotaOut" class="err-text" style="margin: 6px 0 0">
        游记生成次数已用完（共 {{ quota.limit }} 次），请联系管理员增加
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api, withToken } from '../api/index.js';

// 问答步骤（skippable=显示「跳过」；目的地与照片步也允许跳过=纯文字游记）
const STEPS = [
  { title: '这次去了哪儿？', hint: '目的地（选城市后，景点库会给你备选）', skippable: false },
  { title: '从哪儿出发？', hint: '出发地', skippable: true },
  { title: '玩了几天？', hint: '只选天数，不用记具体日期', skippable: true },
  { title: '几个人同行？', hint: '人数/同伴', skippable: true },
  { title: '怎么去的？', hint: '出发交通方式', skippable: true },
  { title: '在目的地怎么逛？', hint: '当地出行方式', skippable: true },
  { title: '偏好什么玩法？', hint: '旅行偏好（可多选）', skippable: true },
  { title: '这趟花了多少钱？', hint: '总费用（大约即可）', skippable: true },
  { title: '住的什么档次？', hint: '住宿档次', skippable: true },
  { title: '什么季节去的？', hint: '季节', skippable: true },
  { title: '都到了哪些景点？', hint: '从城市景点库勾选，没有的手动加', skippable: true },
  { title: '照片与体验', hint: '每个景点可配图和一句体验（AI 可代笔）', skippable: true },
  { title: '要不要合并攻略？', hint: '带攻略数据 or 纯记录', skippable: false },
  { title: '开始生成', hint: '确认信息后交给 AI', skippable: false },
];

const step = ref(0);
const form = ref({ city_id: null, destination: '', meta: { origin: '', days: '', people: '', transport: '', local_transport: '', prefs: [], budget: '', hotel: '', season: '' }, spots: [] });
const journalId = ref(null);
const saveState = ref('');
const genErr = ref('');
const generating = ref(false);
// v1.10.0 生成配额：来自 /auth/me 的 quota.journal（管理员 unlimited）
const quota = ref(null);
const quotaOut = computed(() => !!quota.value && !quota.value.unlimited && quota.value.left <= 0);
const destQ = ref('');
const destHits = ref([]);
const spotOptions = ref([]);
const spotInput = ref('');
const spotHits = ref([]);
const newSpotName = ref('');
const photos = ref([]);
const myGuides = ref([]);
const mergeGuideId = ref('');
const dragGroup = ref(null);
const dragPhoto = ref(null);
let destTimer = 0;
let spotTimer = 0;

// 分组顺序 = form.spots 顺序（si = 在 form.spots 里的下标，-1 表示这组不对应任何景点：
// 未分景点的照片、或景点被移除后遗留的照片组）。key 用名字而非下标，拖动时才不会整组重建 DOM。
const photoGroups = computed(() => {
  const groups = [];
  const orphan = photos.value.filter((p) => !p.spot);
  if (orphan.length || !form.value.spots.length) groups.push({ key: 'none', name: '', si: -1, photos: orphan });
  form.value.spots.forEach((s, si) => {
    groups.push({ key: 's:' + s.name, name: s.name, si, photos: photos.value.filter((p) => p.spot === s.name) });
  });
  // 照片归的景点后来被取消勾选了——照片还在，保留那组（不丢内容）
  const known = new Set(form.value.spots.map((s) => s.name));
  for (const n of [...new Set(photos.value.filter((p) => p.spot && !known.has(p.spot)).map((p) => p.spot))]) {
    groups.push({ key: 'x:' + n, name: n, si: -1, photos: photos.value.filter((p) => p.spot === n) });
  }
  return groups;
});
const summaryLine = computed(() => {
  const m = form.value.meta;
  return [form.value.destination || '（未填目的地）', m.days && m.days + '天', m.people, m.season && m.season + '季',
    form.value.spots.length && form.value.spots.length + ' 个景点', photos.value.length && photos.value.length + ' 张照片',
    mergeGuideId.value ? '合并攻略' : '纯记录'].filter(Boolean).join(' · ');
});

function destTyping() {
  clearTimeout(destTimer);
  destTimer = setTimeout(async () => {
    const kw = destQ.value.trim();
    if (!kw) { destHits.value = []; return; }
    try {
      const j = await api('/cities?q=' + encodeURIComponent(kw));
      destHits.value = j.cities.slice(0, 6);
    } catch { destHits.value = []; }
  }, 180);
}
async function pickDest(c) {
  form.value.city_id = c.id;
  form.value.destination = c.name;
  destQ.value = c.name;
  destHits.value = [];
  await loadSpots();
}
async function loadSpots() {
  if (!form.value.city_id) { spotOptions.value = []; return; }
  try {
    const j = await api('/cities/' + form.value.city_id + '/attractions');
    spotOptions.value = j.attractions || [];
  } catch { spotOptions.value = []; }
}
function togglePref(t) {
  const p = form.value.meta.prefs;
  const i = p.indexOf(t);
  if (i >= 0) p.splice(i, 1); else p.push(t);
}
function toggleSpot(a) {
  const i = form.value.spots.findIndex((s) => s.attraction_id === a.id);
  if (i >= 0) form.value.spots.splice(i, 1);
  else form.value.spots.push({ name: a.name, attraction_id: a.id, note: a.note || '' });
}
function addSpotInput() {
  const name = spotInput.value.trim();
  if (!name) return;
  if (!form.value.spots.some((s) => s.name === name)) form.value.spots.push({ name, attraction_id: null, note: '' });
  spotInput.value = '';
  spotHits.value = [];
}
// 边录边搜（v1.9.0 需求 8）：输入即查景点库，点建议=带 attraction_id 入库；搜不到就按文本添加
function spotTyping() {
  clearTimeout(spotTimer);
  spotTimer = setTimeout(async () => {
    const kw = spotInput.value.trim();
    if (!kw) { spotHits.value = []; return; }
    try {
      const q = '/attractions?q=' + encodeURIComponent(kw) + (form.value.city_id ? '&city_id=' + form.value.city_id : '') + '&page_size=8';
      const j = await api(q);
      spotHits.value = (j.attractions || []).filter((a) => !form.value.spots.some((s) => s.name === a.name));
    } catch { spotHits.value = []; }
  }, 180);
}
function pickSpotHit(a) {
  if (!form.value.spots.some((s) => s.name === a.name)) {
    form.value.spots.push({ name: a.name, attraction_id: a.id, note: '' });
  }
  spotInput.value = '';
  spotHits.value = [];
}
function hideHitsLater() {
  setTimeout(() => { spotHits.value = []; }, 150); // 留出 mousedown 的时间
}

// ---- 景点排序（照片步）：拖动 / ↑↓ 都改 form.spots 顺序，照片编号跟着重排 ----
function moveSpot(si, d) {
  const t = si + d;
  if (t < 0 || t >= form.value.spots.length) return;
  const [s] = form.value.spots.splice(si, 1);
  form.value.spots.splice(t, 0, s);
  afterSpotOrder();
}
function dropGroup(gi) {
  const src = dragGroup.value;
  dragGroup.value = null;
  if (src === null || src === gi) return;
  const a = photoGroups.value[src], b = photoGroups.value[gi];
  if (!a || !b || a.si < 0 || b.si < 0) return;
  const from = a.si, to = b.si;
  const [s] = form.value.spots.splice(from, 1);
  form.value.spots.splice(from < to ? to - 1 : to, 0, s);
  afterSpotOrder();
}
function addSpotInline() {
  const n = newSpotName.value.trim();
  if (!n) return;
  newSpotName.value = '';
  if (form.value.spots.some((s) => s.name === n)) return;
  form.value.spots.push({ name: n, attraction_id: null, note: '' });
  afterSpotOrder();
}
function afterSpotOrder() {
  applyPhotoOrder(photoGroups.value.flatMap((g) => g.photos.map((p) => p.id)));
  saveDraft();
}
function spotNote(name) {
  const s = form.value.spots.find((x) => x.name === name);
  return s ? (s.note || '') : '';
}
function setSpotNote(name, v) {
  const s = form.value.spots.find((x) => x.name === name);
  if (s) s.note = String(v).slice(0, 500);
}

// ---- 照片排序：本地顺序 + 服务端 sort（= 正文 photo:N 的编号）一起改 ----
async function applyPhotoOrder(ids) {
  const byId = new Map(photos.value.map((p) => [p.id, p]));
  const next = ids.map((x) => byId.get(x)).filter(Boolean);
  if (next.length !== photos.value.length) return; // 顺序表不完整就不动，宁可不排也不丢图
  photos.value = next;
  await syncPhotoOrder();
}
async function syncPhotoOrder() {
  if (!journalId.value || !photos.value.length) return;
  const ids = photos.value.map((p) => p.id);
  try {
    await api(`/journals/${journalId.value}/photos/order`, { method: 'PUT', body: { ids } });
    ids.forEach((id, i) => { const p = photos.value.find((x) => x.id === id); if (p) p.sort = i + 1; });
  } catch (e) { saveState.value = '照片排序保存失败：' + e.message; }
}
function dropPhoto(gi, pi) {
  const src = dragPhoto.value;
  dragPhoto.value = null;
  if (!src) return;
  const gs = photoGroups.value.map((g) => g.photos.map((p) => p.id));
  if (!gs[src.g] || !gs[gi]) return;
  const [id] = gs[src.g].splice(src.i, 1);
  const t = (src.g === gi && src.i < pi) ? pi - 1 : pi; // 同组内往后放：目标下标左移一位
  gs[gi].splice(Math.max(0, t), 0, id);
  applyPhotoOrder(gs.flat());
}

// ---- 照片 ----
async function uploadPhotos(ev, spotName) {
  const files = [...(ev.target.files || [])];
  ev.target.value = '';
  if (!journalId.value) await saveDraft(true); // 先有游记才能挂照片
  if (!journalId.value) { alert('草稿保存失败，稍后再传'); return; }
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { alert(`${f.name} 超过 8MB，跳过`); continue; }
    const dataUrl = await readAsDataURL(f);
    try {
      const j = await api('/journals/' + journalId.value + '/photos', { method: 'POST', body: { data_url: dataUrl, spot: spotName || '' } });
      photos.value.push({ ...j.photo, aiBusy: false });
    } catch (e) { alert('上传失败：' + e.message); }
  }
  await syncPhotoOrder(); // 服务端按 MAX(sort)+1 编号，跟屏幕上的分组顺序可能不一致——传完统一重编
}
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
async function aiCaption(p, withUser) {
  p.aiBusy = true;
  try {
    const j = await api(`/journals/${journalId.value}/photos/${p.id}/caption-ai`, {
      method: 'POST', body: withUser ? { user_text: p.caption || '' } : {},
    });
    p.caption = j.caption;
    p.caption_by = 'ai';
  } catch (e) { alert('配文失败：' + e.message); } finally { p.aiBusy = false; }
}
// 手写配文失焦落库（AI 配文服务端已存，这里只管手写的）
async function saveCaption(p) {
  try {
    await api(`/journals/${journalId.value}/photos/${p.id}`, { method: 'PUT', body: { caption: p.caption } });
    p.caption_by = '';
  } catch { saveState.value = '配文保存失败：网络异常'; }
}
async function delPhoto(p) {
  if (!confirm('删除这张照片？')) return;
  await api(`/journals/${journalId.value}/photos/${p.id}`, { method: 'DELETE' });
  photos.value = photos.value.filter((x) => x.id !== p.id);
}

// ---- 草稿自动保存（每换一步存一次；失败明说） ----
async function saveDraft(force = false) {
  if (!force && step.value === STEPS.length - 1) return;
  saveState.value = '保存中…';
  const body = { city_id: form.value.city_id, destination: form.value.destination || destQ.value.trim(), meta: form.value.meta, spots: form.value.spots };
  try {
    if (!journalId.value) {
      const j = await api('/journals', { method: 'POST', body });
      journalId.value = j.journal.id;
    } else {
      await api('/journals/' + journalId.value, { method: 'PUT', body });
    }
    saveState.value = '已自动保存 ✓';
    setTimeout(() => { saveState.value = ''; }, 1600);
  } catch (e) {
    saveState.value = '保存失败：' + e.message;
  }
}
async function next() {
  step.value++;
  await saveDraft();
  if (step.value === 12) await loadMyGuides(); // 合并攻略那步才拉列表
}
async function loadMyGuides() {
  try {
    const j = await api('/guides');
    myGuides.value = (j.guides || []).filter((g) => g.status === 'done');
  } catch { myGuides.value = []; }
}

// ---- 生成 ----
async function generate() {
  genErr.value = '';
  if (!form.value.destination.trim() && !form.value.spots.length) { genErr.value = '至少给个目的地或一个景点'; return; }
  generating.value = true;
  try {
    await saveDraft(true);
    await api('/journals/' + journalId.value + '/generate', { method: 'POST', body: { merge_guide_id: mergeGuideId.value || null } });
    location.hash = '#/journal/' + journalId.value;
  } catch (e) {
    genErr.value = e.message;
    generating.value = false;
  }
}

onMounted(async () => {
  // 断点续写：地址带 ?draft=<id> 时载入草稿
  const m = location.hash.match(/draft=(\d+)/);
  if (m) {
    try {
      const j = await api('/journals/' + m[1]);
      const d = j.journal;
      journalId.value = d.id;
      form.value = { city_id: d.city_id, destination: d.destination, meta: { origin: '', days: '', people: '', transport: '', local_transport: '', prefs: [], budget: '', hotel: '', season: '', ...(d.meta || {}) }, spots: d.spots || [] };
      photos.value = (d.photos || []).map((p) => ({ ...p, aiBusy: false }));
      destQ.value = d.destination;
      mergeGuideId.value = d.merge_guide_id || ''; // v1.9.0「回引导修改」回来时不丢原来选的合并攻略
      if (d.city_id) loadSpots();
    } catch { /* 载入失败就当新写 */ }
  }
  try {
    const j = await api('/auth/me');
    quota.value = (j.user && j.user.quota && j.user.quota.journal) || null;
  } catch { /* 401 已跳登录 */ }
});
</script>

<style scoped>
.wiz { max-width: 860px; }
.steps-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 18px; }
.steps-bar .st { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12.5px; background: var(--card2); color: var(--mut); }
.steps-bar .st.on { background: var(--acc-d); color: #fff; }
.steps-bar .st.done { background: color-mix(in srgb, var(--acc-d) 30%, transparent); color: var(--acc-d); }
.q-area h3 { margin: 0 0 4px; }
.q-area { min-height: 130px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 5px 12px; border-radius: 16px; background: var(--card2); cursor: pointer; font-size: 13.5px; user-select: none; }
.chip.on { background: var(--acc-d); color: #fff; }
.chip small { opacity: 0.75; }
.dest-hits { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.nav-row { display: flex; gap: 10px; align-items: center; margin-top: 22px; border-top: 1px solid var(--line); padding-top: 14px; }
.radio-row { display: block; padding: 6px 0; cursor: pointer; }
.photo-groups { display: flex; flex-direction: column; gap: 16px; }
.prow { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.pbox { width: 220px; }
.pbox img { width: 220px; height: 150px; object-fit: cover; border-radius: 8px; display: block; }
.pcap { margin-top: 6px; }
.pcap textarea { width: 100%; box-sizing: border-box; font-size: 13px; }
.pbtns { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.padd { width: 120px; height: 150px; border: 1.5px dashed var(--line); border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--mut); font-size: 13px; }
.padd:hover { border-color: var(--acc-d); color: var(--acc-d); }
/* 景点步：边录边搜 */
.spot-add { position: relative; display: flex; gap: 8px; max-width: 520px; }
.spot-add .input { flex: 1; }
.sug-inline {
  position: absolute; top: calc(100% + 4px); left: 0; right: 90px; z-index: 30;
  background: #fff; border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  box-shadow: 0 8px 24px rgba(60, 80, 60, 0.15);
}
.sug-inline .s { padding: 7px 14px; cursor: pointer; display: flex; justify-content: space-between; font-size: 13.5px; }
.sug-inline .s:hover { background: var(--acc-l); }
.sug-inline .s small { color: var(--mut); }
.spot-list { margin: 12px 0 0; padding: 0 0 0 4px; list-style: none; display: flex; flex-direction: column; gap: 5px; max-width: 520px; }
.spot-list li { display: flex; align-items: center; gap: 7px; font-size: 13.5px; }
.spot-list .sl-idx { width: 20px; height: 20px; border-radius: 50%; background: var(--card2); color: var(--mut); font-size: 11.5px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.xbtn { border: none; background: none; color: var(--mut); cursor: pointer; font-size: 12px; padding: 0 2px; margin-left: auto; }
.xbtn:hover { color: var(--err, #c0504d); }
/* 照片步：景点分组拖动 / 无色上下按钮 / 体会输入 / 图片编号 */
.pgroup { border-top: 1px solid var(--line); padding-top: 10px; }
.pg-head { display: flex; align-items: center; gap: 8px; }
.pg-head.draggable { cursor: grab; user-select: none; }
.pg-head.draggable:active { cursor: grabbing; }
.pg-grip { color: var(--mut); letter-spacing: -2px; font-size: 13px; }
.pg-move { display: inline-flex; gap: 4px; }
.btn-plain {
  border: 1px solid var(--line); background: transparent; color: var(--mut);
  border-radius: 6px; font-size: 12px; line-height: 1; padding: 3px 7px; cursor: pointer;
}
.btn-plain:hover:not(:disabled) { border-color: var(--mut); color: var(--text); }
.btn-plain:disabled { opacity: 0.4; cursor: not-allowed; }
.note-in { max-width: 460px; margin-top: 6px; font-size: 13px; }
.pimg { position: relative; display: block; border-radius: 8px; overflow: hidden; }
.pnum { position: absolute; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.62); color: #fff; font-size: 11px; padding: 1px 7px; border-radius: 8px 0 0 0; letter-spacing: 0.4px; }
.pbox { position: relative; cursor: grab; }
.pbox:active { cursor: grabbing; }
.pg-add { display: flex; gap: 8px; align-items: center; margin-top: 16px; border-top: 1px dashed var(--line); padding-top: 14px; }
.pg-add .input { max-width: 280px; }
</style>
