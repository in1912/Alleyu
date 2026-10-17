<template>
  <div>
    <h2 style="margin: 0 0 14px">🗺️ 城市景点库</h2>
    <div class="tabs">
      <div class="t" :class="{ on: tab === 'cities' }" @click="tab = 'cities'">城市（{{ cities.length }}）</div>
      <div class="t" :class="{ on: tab === 'attractions' }" @click="tab = 'attractions'">景点（{{ pager.total }}）</div>
    </div>

    <!-- 城市 -->
    <div v-if="tab === 'cities'" class="card">
      <div class="seg liblines" style="margin-bottom: 14px">
        <div v-for="ln in allLines" :key="ln" class="opt" :class="{ on: line === ln }" @click="setLine(ln)">{{ ln }}（{{ lineCount[ln] || 0 }}）</div>
      </div>
      <!-- v1.10.1：各线路「拉取旅游城市」（管理员）——补的是「库里还没有的内置种子城市」，
           已有城市一律跳过、不改动。按钮上的 +N = 该线路种子还缺几座，0 时置灰显示 ✓。 -->
      <div v-if="isAdmin && seedStat.length" class="pull-row">
        <span class="hint">拉取旅游城市：</span>
        <button
          v-for="s in seedStat"
          :key="s.line"
          class="btn ghost sm"
          :disabled="pullBusy || !s.missing"
          :title="s.missing
            ? `把「${s.line}」内置的 ${s.missing} 座城市补进来（库里已有的 ${s.have} 座跳过，不改动任何现有数据）`
            : `「${s.line}」内置的 ${s.total} 座城市库里都有了`"
          @click="pullLine(s)"
        >{{ s.line }} {{ s.missing ? '+' + s.missing : '✓' }}</button>
      </div>
      <p v-if="pullMsg" class="hint" style="margin: 0 0 12px">{{ pullMsg }}</p>
      <div style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap">
        <input v-model="cityQ" class="input" style="max-width: 260px" placeholder="搜索城市/国家" @input="loadCities" />
        <button v-if="isAdmin" class="btn sm" @click="cityDlg = { ...emptyCity, line }">＋ 新增城市</button>
      </div>
      <table class="tb">
        <thead><tr><th>城市</th><th>省份/国家</th><th>线路</th><th>坐标</th><th>热门</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="c in cities" :key="c.id" :class="{ sel: c.id === curCity }">
            <td><a @click="pickCity(c)" style="cursor: pointer; font-weight: 600">{{ c.name }}</a></td>
            <td>{{ c.province }}<span class="hint"> {{ c.adcode }}</span></td>
            <td><span class="badge" :class="{ gray: (c.line || '国内') !== '国内' }">{{ c.line || '国内' }}</span></td>
            <td class="hint">{{ c.lng != null ? c.lng.toFixed(3) + ',' + c.lat.toFixed(3) : (c.line && c.line !== '国内' ? '已按市中心定位' : '未定位（首次使用自动解析）') }}</td>
            <td><span v-if="c.hot" class="badge">热门</span><span v-else class="badge gray">-</span></td>
            <td v-if="isAdmin">
              <button class="btn ghost sm" @click="cityDlg = { ...c }">改</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="delCity(c)">删</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 景点：先选线路 → 再选城市（不选=全部），分页浏览（v1.7.0） -->
    <div v-if="tab === 'attractions'" class="card">
      <div class="seg liblines" style="margin-bottom: 14px">
        <div class="opt" :class="{ on: attrLine === '' }" @click="setAttrLine('')">全部线路</div>
        <div v-for="ln in allLines" :key="ln" class="opt" :class="{ on: attrLine === ln }" @click="setAttrLine(ln)">{{ ln }}</div>
      </div>
      <div style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center">
        <select v-model="curCity" class="input" style="max-width: 180px" @change="page = 1; loadAttrs()">
          <option :value="null">全部城市</option>
          <option v-for="c in cityOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <input v-model="attrQ" class="input" style="max-width: 180px" placeholder="搜景点名" @input="page = 1; loadAttrs()" />
        <select v-model.number="pageSize" class="input" style="max-width: 110px" @change="page = 1; loadAttrs()">
          <option v-for="n in [10, 20, 30, 50]" :key="n" :value="n">每页 {{ n }}</option>
        </select>
        <button class="btn sm" :disabled="!curCity" :title="curCity ? '' : '先选城市'" @click="attrDlg = { ...emptyAttr, city_id: curCity }">＋ 新增景点</button>
        <button v-if="isAdmin" class="btn ghost sm" :disabled="!curCity" @click="poiOpen = !poiOpen">🔍 高德检索导入</button>
        <button v-if="isAdmin" class="btn ghost sm" :disabled="!curCity || backfillBusy" @click="backfillCity">⚡ 一键补全本城市</button>
        <button v-if="isAdmin" class="btn ghost sm" :disabled="backfillBusy" :title="backfillTitle" @click="backfillAll">🔄 补全全部缺景点城市</button>
        <button v-if="isAdmin && backfillBusy" class="btn ghost sm" @click="backfillStop = true">■ 停止</button>
        <button v-if="isAdmin" class="btn ghost sm" :disabled="backfillBusy || probeBusy" title="只读检测：这台服务器现在能不能连上维基（不写任何数据）——「介绍补不上」到底是连不上还是没有条目，一点就知道" @click="probeWiki">🔌 测试维基连通</button>
      </div>

      <div v-if="poiOpen" style="margin-bottom: 14px; padding: 12px; background: var(--card2); border-radius: 10px">
        <div style="display: flex; gap: 8px">
          <input v-model="poiQ" class="input" placeholder="输入景点名，回车检索高德" @keydown.enter.prevent="searchPoi" />
          <button class="btn sm" @click="searchPoi">搜</button>
        </div>
        <div v-for="(p, i) in poiHits" :key="i" style="display: flex; justify-content: space-between; padding: 7px 4px; border-bottom: 1px dashed var(--line); font-size: 13.5px">
          <span>{{ p.name }} <small class="hint">{{ (p.type || '').split(';')[0] }} {{ p.address }}</small></span>
          <button class="btn ghost sm" @click="importPoi(p)">导入</button>
        </div>
      </div>

      <p v-if="backfillMsg" class="hint backfill-msg" style="margin: 0 0 10px">
        {{ backfillMsg }}<span v-if="backfillBusy" style="margin-left: 6px; color: var(--mut)">· 已用 {{ backfillSec }} 秒</span>
      </p>

      <div v-if="!pager.total && !attrLoading" class="empty">没有匹配的景点{{ curCity ? '' : '（未选城市时展示全部，可按线路/城市/名字筛选）' }}</div>
      <table v-else class="tb">
        <thead><tr><th>景点</th><th>城市</th><th>类型</th><th>等级</th><th>门票</th><th>建议时长</th><th>必去</th><th>介绍</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in attractions" :key="a.id">
            <td><b>{{ a.name }}</b></td>
            <td><span class="hint">{{ a.city }}</span></td>
            <td>{{ a.type }}</td>
            <td>{{ a.level || '-' }}</td>
            <td class="hint">{{ a.ticket || '-' }}</td>
            <td class="hint">{{ a.hours || '-' }}</td>
            <td><span v-if="a.must" class="badge">★</span></td>
            <td class="intro-cell">
              <span v-if="a.intro_source" class="badge gray" style="margin-right: 4px">{{ a.intro_source }}</span>
              <span class="hint" :title="a.intro">{{ introSnippet(a) }}</span>
            </td>
            <td>
              <button class="btn ghost sm" @click="attrDlg = { ...a }">改</button>
              <button v-if="isAdmin" class="btn ghost sm" style="margin-left: 6px" :disabled="backfillBusy" @click="enrichIntro(a)">介</button>
              <button v-if="isAdmin" class="btn ghost sm" style="margin-left: 6px" @click="delAttr(a)">删</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="pager.total" class="pager-row">
        <button class="btn ghost sm" :disabled="pager.page <= 1" @click="goPage(pager.page - 1)">← 上一页</button>
        <span class="hint">第 {{ pager.page }} / {{ pager.pages }} 页 · 共 {{ pager.total }} 条</span>
        <button class="btn ghost sm" :disabled="pager.page >= pager.pages" @click="goPage(pager.page + 1)">下一页 →</button>
      </div>
      <p class="hint" style="margin-top: 10px">未选城市时默认展示全部景点（可前后翻页）；「一键补全」= 高德风景名胜检索导入 + 已开启的维基站点补介绍（含 CC BY-SA 署名）。坐标为空的景点生成攻略时自动经高德解析。景点所有登录用户都可新增/修改，删除仅管理员。<br />「🔄 补全全部缺景点城市」处理<b>景点数少于 {{ backfillLimit }}</b>（可在「设置 → 维基与补全」调整）的国内城市，已有景点的一律跳过、不重复拉取；「拉取旅游城市」在<b>城市</b>页签，按线路把内置种子里库里还缺的城市补进来。<br />维基介绍默认<b>两家都关闭</b>（设置 → 维基与补全）：关着就不会发起任何维基请求，补全只导入景点并如实说明介绍未补。开启后介绍来自境外维基站点，<b>国内网络常常连不上</b>——那时「补介绍」会如实说连不上并跳过（每座城市十几秒内必有结果，不会一直转），景点本身照常导入；要点「🔌 测试维基连通」可当场确认是连不上还是真的没有条目。</p>
    </div>

    <!-- 城市弹窗 -->
    <div v-if="cityDlg" class="mask" @click.self="cityDlg = null">
      <div class="dlg">
        <h3>{{ cityDlg.id ? '编辑城市' : '新增城市' }}</h3>
        <div class="grid2">
          <div><label class="fld">城市名 *</label><input v-model="cityDlg.name" class="input" /></div>
          <div><label class="fld">省份/国家</label><input v-model="cityDlg.province" class="input" /></div>
          <div><label class="fld">线路（可直接输入新线路）</label>
            <input v-model="cityDlg.line" class="input" list="line-suggest" />
            <datalist id="line-suggest"><option v-for="ln in allLines" :key="ln" :value="ln" /></datalist>
          </div>
          <div><label class="fld">热门</label><select v-model="cityDlg.hot" class="input"><option :value="1">是</option><option :value="0">否</option></select></div>
          <div><label class="fld">经度（可空，国内自动解析）</label><input v-model="cityDlg.lng" class="input" /></div>
          <div><label class="fld">纬度</label><input v-model="cityDlg.lat" class="input" /></div>
        </div>
        <p v-if="dlgErr" class="err-text">{{ dlgErr }}</p>
        <div style="margin-top: 16px; display: flex; gap: 10px; justify-content: flex-end">
          <button class="btn ghost" @click="cityDlg = null">取消</button>
          <button class="btn" @click="saveCity">保存</button>
        </div>
      </div>
    </div>

    <!-- 景点弹窗 -->
    <div v-if="attrDlg" class="mask" @click.self="attrDlg = null">
      <div class="dlg">
        <h3>{{ attrDlg.id ? '编辑景点' : '新增景点' }}</h3>
        <div class="grid2">
          <div><label class="fld">景点名 *</label><input v-model="attrDlg.name" class="input" /></div>
          <div><label class="fld">类型</label>
            <select v-model="attrDlg.type" class="input"><option v-for="t in typeOptions" :key="t">{{ t }}</option></select>
          </div>
          <div><label class="fld">等级</label><input v-model="attrDlg.level" class="input" placeholder="5A / 4A / -" /></div>
          <div><label class="fld">门票</label><input v-model="attrDlg.ticket" class="input" placeholder="免费 / 60 / 旺季60 淡季40" /></div>
          <div><label class="fld">建议时长</label><input v-model="attrDlg.hours" class="input" placeholder="2-3小时" /></div>
          <div><label class="fld">必去</label><select v-model="attrDlg.must" class="input"><option :value="1">是</option><option :value="0">否</option></select></div>
          <div style="grid-column: 1 / -1"><label class="fld">备注</label><input v-model="attrDlg.note" class="input" /></div>
          <div style="grid-column: 1 / -1">
            <label class="fld">景点介绍（可手填；「介」按钮自动抓维基）</label>
            <textarea v-model="attrDlg.intro" class="input" rows="4" style="resize: vertical"></textarea>
            <p v-if="attrDlg.intro_url" class="hint" style="margin: 4px 0 0">介绍来源：{{ attrDlg.intro_source }} · <a :href="attrDlg.intro_url" target="_blank" rel="noopener">原条目</a>（CC BY-SA 4.0）</p>
          </div>
        </div>
        <p v-if="dlgErr" class="err-text">{{ dlgErr }}</p>
        <div style="margin-top: 16px; display: flex; gap: 10px; justify-content: flex-end">
          <button class="btn ghost" @click="attrDlg = null">取消</button>
          <button class="btn" @click="saveAttr">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api/index.js';
import { pickBackfillCities, backfillThreshold, DEFAULT_BACKFILL_THRESHOLD } from '../libraryFilter.js';

const TYPES = ['人文', '自然风光', '美食', '逛街', '休闲', '拍照打卡', '亲子', '景点'];
const SEED_LINES = ['国内', '欧洲线', '中亚线', '东亚线', '北美线', '南美线'];
const tab = ref('cities');
const cities = ref([]);
const cityQ = ref('');
const line = ref('国内');
const lineCount = ref({});

// 景点页签（v1.7.0）：线路 → 城市 → 分页
const attrLine = ref('');
const curCity = ref(null);
const attrQ = ref('');
const page = ref(1);
const pageSize = ref(10);
const pager = ref({ total: 0, page: 1, pages: 1 });
const attractions = ref([]);
const attrLoading = ref(false);
const backfillMsg = ref('');
// v1.12.0：批量补全的城市筛选阈值（设置 → 维基与补全，默认 6），onMounted 现读
const backfillLimit = ref(DEFAULT_BACKFILL_THRESHOLD);
const backfillTitle = computed(() => `只处理景点数少于 ${backfillLimit.value} 的国内城市；已有景点的一律跳过，不重复拉取；维基介绍未开启或连不上时会如实说明，不会再卡住`);
const backfillBusy = ref(false);
// v1.11.1：下面三件都是为了让「正在跑」看得见、停得下——
// 老版本的毛病是点了批量补全之后界面一个字都不动（服务端在为一个请求空转 20 分钟），
// 用户没法区分「在跑」和「死了」。
const backfillStop = ref(false); // 「■ 停止」：在轮次/城市之间检查，不打断正在飞的那个请求
const backfillSec = ref(0);
const probeBusy = ref(false);
let backfillTimer = 0;
function backfillStart() {
  backfillBusy.value = true; backfillStop.value = false; backfillSec.value = 0;
  clearInterval(backfillTimer);
  backfillTimer = setInterval(() => { backfillSec.value++; }, 1000);
}
function backfillDone() {
  backfillBusy.value = false;
  clearInterval(backfillTimer); backfillTimer = 0;
}

// 城市下拉按线路过滤；全部线路时给全部城市（用 citiesAll，不是城市页签筛选后的 cities）
const cityOptions = computed(() => attrLine.value ? citiesAll.value.filter((c) => (c.line || '国内') === attrLine.value) : citiesAll.value);
// 每城市景点数（来自 /cities 的 attr_count 子查询），「补全全部缺景点城市」按它挑城市
const cityAttrCount = computed(() => Object.fromEntries(citiesAll.value.map((c) => [c.id, c.attr_count ?? 0])));
const citiesAll = ref([]);

const cityDlg = ref(null);
const attrDlg = ref(null);
const dlgErr = ref('');
// 线路动态（v1.7.0）：种子六线 + 库内现存线路合并——新线路入库即出现在两处筛选里
const allLines = computed(() => {
  const extra = [...new Set(citiesAll.value.map((c) => c.line || '国内'))]
    .filter((ln) => ln !== '国内' && !SEED_LINES.includes(ln)).sort();
  return [...SEED_LINES, ...extra];
});
const poiOpen = ref(false);
const poiQ = ref('');
const poiHits = ref([]);
const me = ref(null);
const emptyCity = { name: '', province: '', adcode: '', hot: 0, lng: '', lat: '', line: '国内' };
const emptyAttr = { name: '', type: '人文', level: '', ticket: '', hours: '', must: 0, note: '', intro: '' };
const isAdmin = computed(() => me.value?.role === 'admin');
// 类型下拉：高德导入的类型（如「风景名胜」）不在预设里时补进选项，避免编辑弹窗显示空白
const typeOptions = computed(() => {
  const t = attrDlg.value && attrDlg.value.type;
  return t && !TYPES.includes(t) ? [...TYPES, t] : TYPES;
});

async function loadCities() {
  const j = await api('/cities?q=' + encodeURIComponent(cityQ.value.trim()) + '&line=' + encodeURIComponent(line.value));
  cities.value = j.cities;
}
// 景点页签要跨线路选城市 → 单独拉全量（库就百来座城市，一次拉全不心疼）
async function loadAllCities() {
  try {
    const j = await api('/cities');
    citiesAll.value = j.cities;
  } catch { /* 沿用旧列表 */ }
}
async function loadLines() {
  try {
    const j = await api('/cities/lines');
    lineCount.value = Object.fromEntries((j.lines || []).map((x) => [x.line, x.c]));
  } catch { /* 计数缺省 0 */ }
}
function setLine(ln) {
  if (line.value === ln) return;
  line.value = ln;
  loadCities();
}
function setAttrLine(ln) {
  if (attrLine.value === ln) return;
  attrLine.value = ln;
  curCity.value = null; // 换线路后原城市多半不在新线路里
  page.value = 1;
  loadAttrs();
}
async function loadAttrs() {
  attrLoading.value = true;
  try {
    const qs = new URLSearchParams({
      line: attrLine.value, city_id: curCity.value || '', q: attrQ.value.trim(),
      page: String(page.value), page_size: String(pageSize.value),
    });
    const j = await api('/attractions?' + qs);
    pager.value = { total: j.total, page: j.page, pages: j.pages };
    attractions.value = j.attractions;
  } catch (e) {
    alert(e.message);
  } finally {
    attrLoading.value = false;
  }
}
function goPage(n) {
  if (n < 1 || n > pager.value.pages) return;
  page.value = n;
  loadAttrs();
}
function introSnippet(a) {
  if (!a.intro) return '-';
  return a.intro.length > 24 ? a.intro.slice(0, 24) + '…' : a.intro;
}
function pickCity(c) {
  attrLine.value = c.line || '国内';
  curCity.value = c.id;
  tab.value = 'attractions';
  page.value = 1;
  loadAttrs();
}
async function saveCity() {
  dlgErr.value = '';
  if (!cityDlg.value.name.trim()) { dlgErr.value = '城市名必填'; return; }
  try {
    if (cityDlg.value.id) await api('/cities/' + cityDlg.value.id, { method: 'PUT', body: cityDlg.value });
    else await api('/cities', { method: 'POST', body: cityDlg.value });
    cityDlg.value = null;
    loadCities();
    loadAllCities();
    loadLines();
  } catch (e) { dlgErr.value = e.message; }
}
async function delCity(c) {
  if (!confirm(`删除城市「${c.name}」及其全部景点？`)) return;
  try {
    await api('/cities/' + c.id, { method: 'DELETE' });
    if (curCity.value === c.id) { curCity.value = null; }
    loadCities();
    loadAllCities();
    loadAttrs();
  } catch (e) { alert(e.message); }
}
async function saveAttr() {
  dlgErr.value = '';
  if (!attrDlg.value.name.trim()) { dlgErr.value = '景点名必填'; return; }
  try {
    if (attrDlg.value.id) await api('/attractions/' + attrDlg.value.id, { method: 'PUT', body: attrDlg.value });
    else await api('/attractions', { method: 'POST', body: attrDlg.value });
    attrDlg.value = null;
    loadAttrs();
  } catch (e) { dlgErr.value = e.message; }
}
async function delAttr(a) {
  if (!confirm(`删除景点「${a.name}」？`)) return;
  try {
    await api('/attractions/' + a.id, { method: 'DELETE' });
    loadAttrs();
  } catch (e) { alert(e.message); }
}
async function searchPoi() {
  if (!poiQ.value.trim()) return;
  try {
    const city = citiesAll.value.find((c) => c.id === curCity.value) || cities.value.find((c) => c.id === curCity.value);
    const j = await api('/poi?q=' + encodeURIComponent(poiQ.value.trim()) + '&city=' + encodeURIComponent(city ? city.name : ''));
    poiHits.value = j.pois;
  } catch (e) { alert(e.message); }
}
async function importPoi(p) {
  try {
    await api('/import-poi', { method: 'POST', body: { city_id: curCity.value, poi: p } });
    loadAttrs();
  } catch (e) { alert(e.message); }
}
// 单个景点补维基介绍（行内「介」按钮）。
// v1.11.1：服务端现在会区分「维基连不上」和「两家都没这条」——前者回 502 并说清是网络问题，
// 这里照抄它的原话，绝不再把连不上说成「暂无条目」。
async function enrichIntro(a) {
  backfillMsg.value = `正在抓取「${a.name}」的介绍…`;
  try {
    const j = await api('/attractions/' + a.id + '/enrich-intro', { method: 'POST' });
    backfillMsg.value = j.miss ? `「${a.name}」维基旅行/维基百科暂无条目` : `「${a.name}」已补介绍（${j.source}）`;
    loadAttrs();
  } catch (e) { backfillMsg.value = '介绍抓取失败：' + e.message; }
}
// 只读连通探针：分清「维基连不上」和「景点没条目」。服务端不写库。
async function probeWiki() {
  probeBusy.value = true;
  backfillMsg.value = '正在测维基连通（只读，不写任何数据）…';
  try {
    const j = await api('/wiki/probe');
    const seg = (j.sites || []).map((s) => `${s.label} ${s.ok ? `可达（${s.ms}ms）` : (s.error || `连不上（${s.ms}ms）`)}`);
    backfillMsg.value = `维基连通：${seg.join('；')} → ${j.reachable
      ? '至少一家可达，景点介绍能抓'
      : '两家都连不上（这台服务器访问不到境外维基），介绍抓不了——这不是「景点没条目」'}`;
  } catch (e) { backfillMsg.value = '连通探测失败：' + e.message; }
  finally { probeBusy.value = false; }
}
// 单城补全的**轮次驱动**（v1.11.1）：服务端的介绍段有「时间预算」（每次请求最多十几秒必返回），
// 没补完的部分由前端接着点，不再要求用户自己「再点一次继续」。
// 第 2 轮起带 only_intro（只补介绍，不重复跑高德）；skipIntro=维基整片连不上时只导入景点。
// 返回 { parts, wikiDown, imported, introOk, introLeft }。
async function runBackfillCity(city, { skipIntro = false } = {}) {
  let imported = 0, skipped = 0, introOk = 0, introMiss = 0, introLeft = 0, wikiDown = false, rounds = 0;
  let wikiOff = false;    // v1.12.0：管理员在设置里把维基两家都关了 —— 这不是「连不上」，说法要分开
  const errs = [];        // 服务端如实说的介绍段情况（未开启/连不上/预算用尽…），随 parts 一起给人看
  const hardErrs = [];    // 这一城**整个请求失败**（网络/HTTP/服务端 500）——调用方要按失败计数，不能算成功
  try {
    for (;;) {
      const body = rounds === 0 ? (skipIntro ? { skip_intro: true } : undefined) : { only_intro: true };
      const j = await api('/cities/' + city.id + '/backfill', { method: 'POST', body });
      rounds++;
      imported += j.imported || 0;
      skipped += j.skipped || 0;
      introOk += j.intro_ok || 0;
      introMiss += j.intro_miss || 0;
      introLeft = j.intro_left || 0;
      if (j.intro_error) errs.push(j.intro_error);
      if (j.wiki_disabled) { wikiOff = true; break; }   // 开关关着：再轮次也不会抓，立刻停
      if (j.wiki_unreachable) { wikiDown = true; break; }
      // 继续的条件：还有没补的 **且** 这一轮真补到了东西（全 miss 说明剩下的大概率本来就没条目，
      // 再点只是把同样的 40 条重查一遍）；最多 3 轮，并且尊重「■ 停止」。
      if (!(introLeft > 0 && (j.intro_ok || 0) > 0 && rounds < 3)) break;
      if (backfillStop.value) break;
    }
  } catch (e) { hardErrs.push(e.message); }
  const parts = [`导入 ${imported} 条${skipped ? `（重复跳过 ${skipped}）` : ''}`];
  if (skipIntro) parts.push('介绍本次跳过（维基连不上）');
  else if (wikiOff) parts.push('介绍未补：维基介绍未开启（设置 → 维基与补全）');
  else parts.push(`补介绍 ${introOk} 条${introMiss ? `，维基无条目 ${introMiss}` : ''}`);
  if (introLeft && !skipIntro && !wikiOff) parts.push(`还剩 ${introLeft} 条未补`);
  if (errs.length) parts.push('⚠️ ' + [...new Set(errs)].join('；'));
  if (hardErrs.length) parts.push('❌ 失败：' + hardErrs.join('；'));
  return { parts, wikiDown, wikiOff, imported, introOk, introLeft, hardErrs };
}
// 一键补全当前城市：高德风景名胜导入 + 缺介绍的补维基
async function backfillCity() {
  const city = citiesAll.value.find((c) => c.id === curCity.value) || cities.value.find((c) => c.id === curCity.value);
  if (!city) return;
  if (!confirm(`补全「${city.name}」？\n国内城市：高德「风景名胜」检索导入（最多50条）+ 全市景点补维基介绍；国际城市只补介绍。\n每座城市十几秒内必有结果（维基连不上会如实报错，不会一直转）。`)) return;
  backfillStart();
  backfillMsg.value = `正在补全「${city.name}」…（高德导入 + 维基介绍）`;
  try {
    const j = await runBackfillCity(city, {});
    backfillMsg.value = `「${city.name}」补全完成：${j.parts.join('；')}`;
    loadAttrs();
  } catch (e) {
    backfillMsg.value = '补全失败：' + e.message;
  } finally {
    backfillDone();
  }
}
// v1.10.1：各线路「拉取旅游城市」（管理员）——服务端按线路把内置种子里「库里还没有」的城市补进来。
// seedStat 给按钮显示还缺几座（0 就置灰），拉完刷新城市列表/线路计数。
const seedStat = ref([]);
const pullBusy = ref(false);
const pullMsg = ref('');
async function loadSeedStat() {
  try { seedStat.value = (await api('/cities/seed')).lines || []; } catch { /* 拉不到就不显示按钮 */ }
}
async function pullLine(s) {
  if (!confirm(`拉取「${s.line}」的旅游城市？\n将补入库里还没有的 ${s.missing} 座（系统内置种子城市），已有的城市一律跳过、不改动任何现有数据。`)) return;
  pullBusy.value = true;
  pullMsg.value = `正在拉取「${s.line}」…`;
  try {
    const j = await api('/cities/pull', { method: 'POST', body: { line: s.line } });
    if (j.added) {
      pullMsg.value = `「${j.line}」补入 ${j.added} 座城市：${j.added_names.join('、')}（连带种子景点 ${j.attrs} 条）；已有 ${j.skipped} 座跳过。`;
    } else if (j.total) {
      pullMsg.value = `「${j.line}」内置的 ${j.total} 座城市库里都有了，没有需要补的。`;
    } else {
      pullMsg.value = j.note || `「${j.line}」没有内置种子城市，无需拉取。`;
    }
    await Promise.all([loadCities(), loadAllCities(), loadLines(), loadSeedStat(), loadAttrs()]);
  } catch (e) {
    pullMsg.value = '拉取失败：' + e.message;
  } finally {
    pullBusy.value = false;
  }
}
// 批量：给「景点数少于 N」的国内城市逐个补全（N=设置里的阈值，默认 6；已有景点的不重复拉高德，
// 要给某座城市加量用上面的「一键补全本城市」）。前端串行驱动，能看进度也能随时停。
// v1.11.1：① 单城失败**必须说出来**（老版本 catch{} 把失败全吞了，用户只看到一句「完成：0/5」）；
//          ② 连续 2 座报「维基连不上」→ 认定维基整片不可达，后续城市只导入景点（省掉每城十几秒的
//             白等），并在结束语里如实说明「介绍没补、因为连不上，不是没有条目」。
// v1.12.0：筛选条件从 `attr_count === 0` 改成 `attr_count < N`；维基开关全关时如实说「未开启」。
async function backfillAll() {
  const N = backfillLimit.value;
  const list = pickBackfillCities(citiesAll.value, N);
  if (!list.length) { backfillMsg.value = `没有景点数少于 ${N} 的国内城市了（已有景点的一律跳过，不重复拉取；要给某座城市加量请用「一键补全本城市」）`; return; }
  if (!confirm(`将补全 ${list.length} 座「景点数少于 ${N}」的国内城市（高德风景名胜导入 + 维基介绍），已有景点的城市一律跳过、不重复拉取。\n每座城市十几秒内必有结果；维基介绍未开启或连不上时会如实告知并跳过，不会再卡住。`)) return;
  backfillStart();
  let done = 0, imported = 0, introOk = 0, leftTotal = 0, wikiFail = 0, wikiDown = false, stopped = false, wikiOff = false;
  const errs = [];
  try {
    for (let i = 0; i < list.length; i++) {
      if (backfillStop.value) { stopped = true; break; }
      const c = list[i];
      backfillMsg.value = `批量补全 ${i + 1}/${list.length}：${c.name}${wikiDown ? '（只导入景点）' : ''}…`;
      try {
        const j = await runBackfillCity(c, { skipIntro: wikiDown });
        if (j.wikiOff) wikiOff = true;
        // 这一城整个请求失败（runBackfillCity 把异常收进 hardErrs）就**不能算「处理成功」**——
        // 老版本正是在这里把失败吞成「完成：0/5」，用户只看到一句没头没尾的结论。
        if (j.hardErrs.length) errs.push(`${c.name}：${j.hardErrs.join('；')}`);
        else done++;
        imported += j.imported;
        introOk += j.introOk;
        leftTotal += j.introLeft;
        if (j.wikiDown) { wikiFail++; if (wikiFail >= 2) wikiDown = true; } else wikiFail = 0;
      } catch (e) {
        errs.push(`${c.name}：${e.message}`); // 兜底：单城失败继续下一城，但要说出来，不再吞掉
      }
    }
    const msg = [`批量补全${stopped ? '已停止' : '完成'}：${done}/${list.length} 座城市处理成功（景点导入 ${imported} 条）`];
    if (introOk) msg.push(`补介绍 ${introOk} 条`);
    if (leftTotal > 0) {
      msg.push(wikiOff
        ? `维基介绍未开启（设置 → 维基与补全），剩 ${leftTotal} 条介绍没补——勾选站点后再跑一次即可`
        : (wikiDown
          ? `维基连不上（境外站点，这台服务器访问不到），剩 ${leftTotal} 条介绍没补——等能连上维基时再点一次即可`
          : `还剩 ${leftTotal} 条介绍没补（维基无对应条目）`));
    }
    if (stopped) msg.push(`已在第 ${done} 座之后停下`);
    if (errs.length) msg.push('⚠️ 失败 ' + errs.length + ' 座：' + errs.slice(0, 3).join('；') + (errs.length > 3 ? ' …' : ''));
    backfillMsg.value = msg.join('；');
    loadAttrs();
  } finally {
    backfillDone();
  }
}
onMounted(async () => {
  try { me.value = (await api('/auth/me')).user; } catch { /* 忽略 */ }
  // 阈值只影响这一个副本的筛选：读不到就用默认 6，绝不因此挡住页面
  try {
    const st = await api('/settings');
    backfillLimit.value = backfillThreshold(st.backfill_max_attrs);
  } catch { /* 非管理员/读取失败 → 默认值 */ }
  await Promise.all([loadCities(), loadAllCities(), loadLines(), loadSeedStat(), loadAttrs()]);
});
onUnmounted(() => clearInterval(backfillTimer)); // 秒表不能在切页之后还转
</script>

<style scoped>
tr.sel td { background: var(--acc-l); }
.intro-cell { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pager-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
/* 各线路「拉取旅游城市」按钮组：跟线路 pill 一样换行排布 */
.pull-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.pull-row .btn.sm:disabled { opacity: 0.55; }
</style>
