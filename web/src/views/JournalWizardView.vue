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

        <!-- 所到景点：城市景点库备选 + 自输新增 -->
        <template v-else-if="step === 10">
          <p v-if="!form.city_id" class="hint">没有选目的地城市：只能手动输入景点名（选了城市会有库内景点备选）。</p>
          <div v-if="form.city_id && spotOptions.length" class="chip-row" style="margin-bottom: 10px">
            <span v-for="a in spotOptions" :key="a.id" class="chip" :class="{ on: !!form.spots.find((s) => s.attraction_id === a.id) }" @click="toggleSpot(a)">{{ a.name }}<small v-if="a.must"> ★</small></span>
          </div>
          <div style="display: flex; gap: 8px; max-width: 380px">
            <input v-model="spotInput" class="input" placeholder="库里没有的景点，输入名字回车添加" @keydown.enter.prevent="addSpotInput" />
            <button class="btn sm ghost" @click="addSpotInput">添加</button>
          </div>
          <div v-if="form.spots.length" class="chip-row" style="margin-top: 10px">
            <span v-for="(s, i) in form.spots" :key="i" class="chip on" @click="form.spots.splice(i, 1)">{{ s.name }} ✕</span>
          </div>
        </template>

        <!-- 照片与体验说明 -->
        <template v-else-if="step === 11">
          <p class="hint">给去过的景点配照片（≤8MB/张，PNG/JPG/WEBP）。每张可写体验说明，或让 AI 写一句（~30 字，可重写；你先写几个字，AI 会参考你的话再润色，不限字数）。</p>
          <div class="photo-groups">
            <div v-for="g in photoGroups" :key="g.name" class="pgroup">
              <b>{{ g.name || '（未分景点）' }}</b>
              <div class="prow">
                <div v-for="p in g.photos" :key="p.id" class="pbox">
                  <img :src="withToken('/api/journals/' + journalId + '/photos/' + p.id + '/file')" />
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
        <span style="flex: 1"></span>
        <button class="btn ghost" v-if="STEPS[step].skippable" @click="step++">跳过 →</button>
        <button v-if="step < STEPS.length - 1" class="btn" @click="next">{{ '下一问 →' }}</button>
        <button v-else class="btn" :disabled="generating" @click="generate">{{ generating ? '提交中…' : '生成游记 ✍️' }}</button>
      </div>
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
const destQ = ref('');
const destHits = ref([]);
const spotOptions = ref([]);
const spotInput = ref('');
const photos = ref([]);
const myGuides = ref([]);
const mergeGuideId = ref('');
let destTimer = 0;

const photoGroups = computed(() => {
  const groups = [];
  // 未归景点的照片（或一个景点都没选时）单列一组，保证总有传图入口
  const orphan = photos.value.filter((p) => !p.spot);
  if (orphan.length || !form.value.spots.length) groups.push({ name: '', photos: orphan });
  for (const s of form.value.spots) {
    groups.push({ name: s.name, photos: photos.value.filter((p) => p.spot === s.name) });
  }
  // 照片归的景点后来被取消勾选了——照片还在，保留那组（不丢内容）
  const known = new Set(form.value.spots.map((s) => s.name));
  for (const n of [...new Set(photos.value.filter((p) => p.spot && !known.has(p.spot)).map((p) => p.spot))]) {
    groups.push({ name: n, photos: photos.value.filter((p) => p.spot === n) });
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
      if (d.city_id) loadSpots();
    } catch { /* 载入失败就当新写 */ }
  }
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
</style>
