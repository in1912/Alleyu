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
        <button v-if="isAdmin" class="btn ghost sm" :disabled="backfillBusy" @click="backfillAll">🔄 补全全部缺景点城市</button>
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

      <p v-if="backfillMsg" class="hint" style="margin: 0 0 10px">{{ backfillMsg }}</p>

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
      <p class="hint" style="margin-top: 10px">未选城市时默认展示全部景点（可前后翻页）；「一键补全」= 高德风景名胜检索导入 + 维基旅行/维基百科补介绍（含 CC BY-SA 署名）。坐标为空的景点生成攻略时自动经高德解析。景点所有登录用户都可新增/修改，删除仅管理员。</p>
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
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/index.js';

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
const backfillBusy = ref(false);

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
// 单个景点补维基介绍（行内「介」按钮）
async function enrichIntro(a) {
  backfillMsg.value = `正在抓取「${a.name}」的介绍…`;
  try {
    const j = await api('/attractions/' + a.id + '/enrich-intro', { method: 'POST' });
    backfillMsg.value = j.miss ? `「${a.name}」维基旅行/维基百科暂无条目` : `「${a.name}」已补介绍（${j.source}）`;
    loadAttrs();
  } catch (e) { backfillMsg.value = '介绍抓取失败：' + e.message; }
}
// 一键补全当前城市：高德风景名胜导入 + 缺介绍的补维基
async function backfillCity() {
  const city = citiesAll.value.find((c) => c.id === curCity.value) || cities.value.find((c) => c.id === curCity.value);
  if (!city) return;
  if (!confirm(`补全「${city.name}」？\n国内城市：高德「风景名胜」检索导入（最多50条）+ 全市景点补维基介绍；国际城市只补介绍。\n串行执行约 10~30 秒，期间请勿关页。`)) return;
  backfillBusy.value = true;
  backfillMsg.value = `正在补全「${city.name}」…（高德导入 + 维基介绍，串行约 10~30 秒）`;
  try {
    const j = await api('/cities/' + city.id + '/backfill', { method: 'POST' });
    const parts = [];
    parts.push(`导入 ${j.imported} 条（重复跳过 ${j.skipped}）`);
    parts.push(`补介绍 ${j.intro_ok} 条${j.intro_miss ? `，无条目 ${j.intro_miss}` : ''}${j.intro_left ? `，剩 ${j.intro_left} 条未补（再点一次继续）` : ''}`);
    if (j.intro_error) parts.push(`⚠️ ${j.intro_error}`);
    backfillMsg.value = `「${j.city}」补全完成：${parts.join('；')}`;
    loadAttrs();
  } catch (e) {
    backfillMsg.value = '补全失败：' + e.message;
  } finally {
    backfillBusy.value = false;
  }
}
// 批量：给全部「景点数不足」的国内城市逐个补全（前端串行驱动，能看进度也能随时停）
async function backfillAll() {
  const list = citiesAll.value.filter((c) => (c.line || '国内') === '国内' && (cityAttrCount[c.id] ?? 0) < 6);
  if (!list.length) { backfillMsg.value = '国内城市景点都够了（阈值 6 条/城）'; return; }
  if (!confirm(`将补全 ${list.length} 座景点不足的国内城市（高德导入+维基介绍）。\n串行执行约 ${Math.ceil(list.length * 0.4)} 分钟，期间请勿关页。`)) return;
  backfillBusy.value = true;
  let ok = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      backfillMsg.value = `批量补全 ${i + 1}/${list.length}：${c.name}…`;
      try {
        await api('/cities/' + c.id + '/backfill', { method: 'POST' });
        ok++;
      } catch { /* 单城失败继续下一城 */ }
    }
    backfillMsg.value = `批量补全完成：${ok}/${list.length} 座城市处理成功`;
    loadAttrs();
  } finally {
    backfillBusy.value = false;
  }
}
onMounted(async () => {
  try { me.value = (await api('/auth/me')).user; } catch { /* 忽略 */ }
  await Promise.all([loadCities(), loadAllCities(), loadLines(), loadAttrs()]);
});
</script>

<style scoped>
tr.sel td { background: var(--acc-l); }
.intro-cell { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pager-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
</style>
