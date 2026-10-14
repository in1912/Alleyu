<template>
  <div>
    <h2 style="margin: 0 0 14px">🗺️ 城市景点库</h2>
    <div class="tabs">
      <div class="t" :class="{ on: tab === 'cities' }" @click="tab = 'cities'">城市（{{ cities.length }}）</div>
      <div class="t" :class="{ on: tab === 'attractions' }" @click="tab = 'attractions'">景点（{{ attractions.length }}）</div>
    </div>

    <!-- 城市 -->
    <div v-if="tab === 'cities'" class="card">
      <div style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap">
        <input v-model="cityQ" class="input" style="max-width: 260px" placeholder="搜索城市/省份" @input="loadCities" />
        <button v-if="isAdmin" class="btn sm" @click="cityDlg = { ...emptyCity }">＋ 新增城市</button>
      </div>
      <table class="tb">
        <thead><tr><th>城市</th><th>省份</th><th>adcode</th><th>坐标</th><th>热门</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="c in cities" :key="c.id" :class="{ sel: c.id === curCity }">
            <td><a @click="pickCity(c)" style="cursor: pointer; font-weight: 600">{{ c.name }}</a></td>
            <td>{{ c.province }}</td>
            <td>{{ c.adcode }}</td>
            <td class="hint">{{ c.lng != null ? c.lng.toFixed(3) + ',' + c.lat.toFixed(3) : '未定位（首次使用自动解析）' }}</td>
            <td><span v-if="c.hot" class="badge">热门</span><span v-else class="badge gray">-</span></td>
            <td v-if="isAdmin">
              <button class="btn ghost sm" @click="cityDlg = { ...c }">改</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="delCity(c)">删</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 景点 -->
    <div v-if="tab === 'attractions'" class="card">
      <div style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center">
        <select v-model="curCity" class="input" style="max-width: 200px" @change="loadAttrs">
          <option :value="null">选择城市</option>
          <option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button class="btn sm" :disabled="!curCity" @click="attrDlg = { ...emptyAttr, city_id: curCity }">＋ 新增景点</button>
        <button v-if="isAdmin" class="btn ghost sm" :disabled="!curCity" @click="poiOpen = !poiOpen">🔍 高德检索导入</button>
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

      <div v-if="!curCity" class="empty">← 先选一座城市</div>
      <table v-else class="tb">
        <thead><tr><th>景点</th><th>类型</th><th>等级</th><th>门票</th><th>建议时长</th><th>必去</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in attractions" :key="a.id">
            <td><b>{{ a.name }}</b></td>
            <td>{{ a.type }}</td>
            <td>{{ a.level || '-' }}</td>
            <td class="hint">{{ a.ticket || '-' }}</td>
            <td class="hint">{{ a.hours || '-' }}</td>
            <td><span v-if="a.must" class="badge">★</span></td>
            <td>
              <button class="btn ghost sm" @click="attrDlg = { ...a }">改</button>
              <button v-if="isAdmin" class="btn ghost sm" style="margin-left: 6px" @click="delAttr(a)">删</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint" style="margin-top: 10px">坐标为空的景点，在生成攻略时自动经高德检索解析。景点所有登录用户都可新增/修改，删除仅管理员。</p>
    </div>

    <!-- 城市弹窗 -->
    <div v-if="cityDlg" class="mask" @click.self="cityDlg = null">
      <div class="dlg">
        <h3>{{ cityDlg.id ? '编辑城市' : '新增城市' }}</h3>
        <div class="grid2">
          <div><label class="fld">城市名 *</label><input v-model="cityDlg.name" class="input" /></div>
          <div><label class="fld">省份</label><input v-model="cityDlg.province" class="input" /></div>
          <div><label class="fld">adcode</label><input v-model="cityDlg.adcode" class="input" /></div>
          <div><label class="fld">热门</label><select v-model="cityDlg.hot" class="input"><option :value="1">是</option><option :value="0">否</option></select></div>
          <div><label class="fld">经度（可空，自动解析）</label><input v-model="cityDlg.lng" class="input" /></div>
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
            <select v-model="attrDlg.type" class="input"><option v-for="t in TYPES" :key="t">{{ t }}</option></select>
          </div>
          <div><label class="fld">等级</label><input v-model="attrDlg.level" class="input" placeholder="5A / 4A / -" /></div>
          <div><label class="fld">门票</label><input v-model="attrDlg.ticket" class="input" placeholder="免费 / 60 / 旺季60 淡季40" /></div>
          <div><label class="fld">建议时长</label><input v-model="attrDlg.hours" class="input" placeholder="2-3小时" /></div>
          <div><label class="fld">必去</label><select v-model="attrDlg.must" class="input"><option :value="1">是</option><option :value="0">否</option></select></div>
          <div style="grid-column: 1 / -1"><label class="fld">备注</label><input v-model="attrDlg.note" class="input" /></div>
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
const tab = ref('cities');
const cities = ref([]);
const cityQ = ref('');
const curCity = ref(null);
const attractions = ref([]);
const cityDlg = ref(null);
const attrDlg = ref(null);
const dlgErr = ref('');
const poiOpen = ref(false);
const poiQ = ref('');
const poiHits = ref([]);
const me = ref(null);
const emptyCity = { name: '', province: '', adcode: '', hot: 0, lng: '', lat: '' };
const emptyAttr = { name: '', type: '人文', level: '', ticket: '', hours: '', must: 0, note: '' };
const isAdmin = computed(() => me.value?.role === 'admin');

async function loadCities() {
  const j = await api('/cities?q=' + encodeURIComponent(cityQ.value.trim()));
  cities.value = j.cities;
}
async function loadAttrs() {
  if (!curCity.value) { attractions.value = []; return; }
  const j = await api('/cities/' + curCity.value + '/attractions');
  attractions.value = j.attractions;
}
function pickCity(c) {
  curCity.value = c.id;
  tab.value = 'attractions';
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
  } catch (e) { dlgErr.value = e.message; }
}
async function delCity(c) {
  if (!confirm(`删除城市「${c.name}」及其全部景点？`)) return;
  try {
    await api('/cities/' + c.id, { method: 'DELETE' });
    if (curCity.value === c.id) { curCity.value = null; attractions.value = []; }
    loadCities();
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
    const city = cities.value.find((c) => c.id === curCity.value);
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
onMounted(async () => {
  try { me.value = (await api('/auth/me')).user; } catch { /* 忽略 */ }
  await loadCities();
});
</script>

<style scoped>
tr.sel td { background: var(--acc-l); }
</style>
