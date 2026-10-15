<template>
  <div class="plan">
    <div class="card">
      <h2 style="margin: 0 0 4px">🧭 生成旅行攻略</h2>
      <p class="hint" style="margin: 0 0 18px">填完条件提交，AI 按固定九模块框架输出图文攻略（配图自动生成：总览地图 / 每日路线 / 景点实景 / 天气表）</p>

      <div class="grid2">
        <!-- 目的地（边查边搜） -->
        <div style="grid-column: 1 / -1; position: relative">
          <label class="fld">目的地 *（输入搜索城市库）</label>
          <input v-model="form.destination" class="input" placeholder="例如：杭州" @input="searchCity('destination')" @focus="sugFor = 'destination'" @blur="sugFor = ''" />
          <div v-if="sugFor === 'destination' && citySugs.length" class="sug">
            <div v-for="c in citySugs" :key="c.id" class="s" @mousedown.prevent="form.destination = c.name; form.cityId = c.id; citySugs = []; loadAttractions()">
              <span>{{ c.name }}</span><small>{{ c.province }}<span v-if="c.line && c.line !== '国内'"> · {{ c.line }}</span></small>
            </div>
          </div>
        </div>

        <div>
          <label class="fld">出行天数</label>
          <div class="stepper">
            <button class="btn ghost sm" @click="form.days = Math.max(1, form.days - 1)">−</button>
            <span class="days-num">{{ form.days }}</span>
            <button class="btn ghost sm" @click="form.days = Math.min(15, form.days + 1)">＋</button>
            <span class="hint">天（1-15）</span>
          </div>
        </div>

        <div style="position: relative">
          <label class="fld">出发城市（可自由输入）</label>
          <input v-model="form.departure" class="input" placeholder="例如：上海" @input="searchCity('departure')" @focus="sugFor = 'departure'" @blur="sugFor = ''" />
          <div v-if="sugFor === 'departure' && citySugs.length" class="sug">
            <div v-for="c in citySugs" :key="c.id" class="s" @mousedown.prevent="form.departure = c.name; citySugs = []">
              <span>{{ c.name }}</span><small>{{ c.province }}<span v-if="c.line && c.line !== '国内'"> · {{ c.line }}</span></small>
            </div>
          </div>
        </div>

        <div>
          <label class="fld">出行日期（可选； 16 天内出真实预报，更远按同月历史推演）</label>
          <div style="display: flex; gap: 8px">
            <input v-model="form.startDate" type="date" class="input" />
            <input v-model="form.endDate" type="date" class="input" />
          </div>
        </div>

        <div>
          <label class="fld">出行人群</label>
          <div style="display: flex; gap: 8px">
            <select v-model="form.group" class="input"><option value="">不选</option><option v-for="g in GROUPS" :key="g">{{ g }}</option></select>
            <input v-model="form.ages" class="input" style="max-width: 110px" placeholder="年龄(选填)" />
          </div>
        </div>

        <div>
          <label class="fld">预算档位</label>
          <div class="seg">
            <span v-for="b in BUDGETS" :key="b" class="opt" :class="{ on: form.budget === b }" @click="form.budget = b">{{ b }}</span>
          </div>
        </div>

        <div>
          <label class="fld">出行方式</label>
          <div class="seg">
            <span v-for="t in TRANSPORTS" :key="t" class="opt" :class="{ on: form.transport === t }" @click="form.transport = t">{{ t }}</span>
          </div>
        </div>

        <div style="grid-column: 1 / -1">
          <label class="fld">旅行偏好（多选）</label>
          <div class="seg">
            <span v-for="p in PREFS" :key="p" class="opt" :class="{ on: form.preferences.includes(p) }" @click="toggle(form.preferences, p)">{{ p }}</span>
          </div>
        </div>

        <!-- 必去景点 -->
        <div style="grid-column: 1 / -1">
          <label class="fld">必去景点（先选目的地，从该城市景点库勾选；库里没有可单独录入）</label>
          <div v-if="!form.destination" class="hint">↑ 先填目的地</div>
          <div v-else-if="!attractions.length" class="hint">该城市景点库为空，可直接下方录入景点名</div>
          <div v-else class="poi-pool">
            <span v-for="a in attractions" :key="a.id" class="opt" :class="{ on: form.mustVisits.includes(a.name) }" @click="toggle(form.mustVisits, a.name)">
              {{ a.name }}<small v-if="a.must"> ★</small>
            </span>
          </div>
          <div class="poi-add">
            <input v-model="newPoi" class="input" placeholder="边录边搜：输入即查景点库；都没有就按你写的加（回车）" @input="poiTyping" @focus="poiTyping" @blur="hidePoiHits" @keydown.enter.prevent="addPoi" />
            <button class="btn ghost sm" @click="addPoi">添加</button>
            <div v-if="poiSugs.length" class="sug">
              <div v-for="a in poiSugs" :key="a.id" class="s" @mousedown.prevent="pickPoi(a)">
                <span>{{ a.name }}</span>
                <small>{{ a.city }}<span v-if="a.must"> ★</span><span v-if="a.level"> {{ a.level }}</span></small>
              </div>
            </div>
          </div>
          <div v-if="form.mustVisits.length" class="hint" style="margin-top: 8px">已选：{{ form.mustVisits.join('、') }}</div>
        </div>

        <div style="grid-column: 1 / -1">
          <label class="fld">避开（多选）</label>
          <div class="seg">
            <span v-for="a in AVOIDS" :key="a" class="opt" :class="{ on: form.avoid.includes(a) }" @click="toggle(form.avoid, a)">{{ a }}</span>
          </div>
          <input v-model="avoidCustom" class="input" style="margin-top: 8px" placeholder="其他要避开的（回车加入）" @keydown.enter.prevent="addAvoid" />
        </div>

        <div>
          <label class="fld">出行季节 / 月份</label>
          <div style="display: flex; gap: 8px">
            <select v-model="form.season" class="input"><option value="">季节不选</option><option v-for="s in SEASONS" :key="s">{{ s }}</option></select>
            <select v-model="form.month" class="input"><option value="">月份不选</option><option v-for="m in 12" :key="m" :value="String(m)">{{ m }}月</option></select>
          </div>
        </div>

        <div style="grid-column: 1 / -1">
          <label class="fld">其他特殊需求</label>
          <textarea v-model="form.notes" class="input" rows="2" placeholder="例如：早起/慢节奏、不吃辣、需要雨天备用方案、带老人少走路…"></textarea>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 14px; margin-top: 20px; flex-wrap: wrap">
        <button class="btn" :disabled="busy || quotaOut" @click="submit">{{ busy ? '创建中…' : '生成攻略 ✨' }}</button>
        <!-- v1.10.0：把剩余次数摆在按钮边上（用完了按钮置灰并说清找谁） -->
        <span v-if="quotaOut" class="err-text">攻略生成次数已用完（共 {{ quota.limit }} 次），请联系管理员增加</span>
        <span v-else-if="quota" class="hint">
          攻略剩余：<b>{{ quota.unlimited ? '不限' : quota.left + ' 次' }}</b>
          <span v-if="!quota.unlimited">（共 {{ quota.limit }} 次，已用 {{ quota.used }}）</span>
        </span>
        <span v-if="aiMsg" class="err-text">{{ aiMsg }}</span>
      </div>
      <p v-if="err" class="err-text">{{ err }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/index.js';

const GROUPS = ['单人', '情侣', '亲子', '家庭', '老人'];
const BUDGETS = ['经济', '舒适', '轻奢'];
const PREFS = ['人文', '自然风光', '美食', '逛街', '休闲躺平', '拍照打卡'];
const TRANSPORTS = ['高铁', '飞机', '自驾', '当地公共交通'];
const AVOIDS = ['人挤人', '高强度暴走', '收费坑点', '早起', '夜生活'];
const SEASONS = ['春', '夏', '秋', '冬'];

const route = useRoute();
const form = reactive({
  destination: '', cityId: null, days: 3, departure: '', startDate: '', endDate: '',
  group: '', ages: '', budget: '舒适', preferences: [], transport: '',
  mustVisits: [], avoid: [], month: '', season: '', notes: '',
});
const citySugs = ref([]);
const sugFor = ref('');
const attractions = ref([]);
const newPoi = ref('');
const poiSugs = ref([]);
const avoidCustom = ref('');
const busy = ref(false);
const err = ref('');
const aiStatus = ref(null);
// v1.10.0 生成配额：来自 /auth/me 的 quota.guide（管理员 unlimited）
const quota = ref(null);
const aiMsg = ref('');
const quotaOut = computed(() => !!quota.value && !quota.value.unlimited && quota.value.left <= 0);
let sugTimer = 0;
let poiTimer = 0;

function toggle(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1); else arr.push(v);
}
function searchCity(which) {
  clearTimeout(sugTimer);
  sugTimer = setTimeout(async () => {
    const kw = form[which].trim();
    if (which === 'destination') form.cityId = null;
    if (!kw) { citySugs.value = []; return; }
    try {
      const j = await api('/cities?q=' + encodeURIComponent(kw));
      citySugs.value = j.cities.slice(0, 8);
    } catch { citySugs.value = []; }
  }, 180);
}
async function loadAttractions() {
  attractions.value = [];
  if (!form.cityId) {
    // 目的地不在库里 → 尝试按名字匹配
    try {
      const j = await api('/cities?q=' + encodeURIComponent(form.destination));
      const hit = (j.cities || []).find((c) => c.name === form.destination.trim());
      if (hit) form.cityId = hit.id;
    } catch { /* 忽略 */ }
  }
  if (!form.cityId) return;
  try {
    const j = await api('/cities/' + form.cityId + '/attractions');
    attractions.value = j.attractions;
  } catch { /* 忽略 */ }
}
function addPoi() {
  const v = newPoi.value.trim();
  if (v && !form.mustVisits.includes(v)) form.mustVisits.push(v);
  newPoi.value = '';
  poiSugs.value = [];
}
// 边录边搜（v1.9.0）：输入即查景点库（已选目的地就限该城市），点建议=用库里的规范名；
// 搜不到再回车按用户写的文本加——不阻断自输。
function poiTyping() {
  clearTimeout(poiTimer);
  poiTimer = setTimeout(async () => {
    const kw = newPoi.value.trim();
    if (!kw) { poiSugs.value = []; return; }
    try {
      const j = await api('/attractions?q=' + encodeURIComponent(kw) + (form.cityId ? '&city_id=' + form.cityId : '') + '&page_size=8');
      poiSugs.value = (j.attractions || []).filter((a) => !form.mustVisits.includes(a.name));
    } catch { poiSugs.value = []; }
  }, 180);
}
function pickPoi(a) {
  if (!form.mustVisits.includes(a.name)) form.mustVisits.push(a.name);
  newPoi.value = '';
  poiSugs.value = [];
}
function hidePoiHits() {
  setTimeout(() => { poiSugs.value = []; }, 150);
}
function addAvoid() {
  const v = avoidCustom.value.trim();
  if (v && !form.avoid.includes(v)) form.avoid.push(v);
  avoidCustom.value = '';
}
async function submit() {
  err.value = '';
  if (!form.destination.trim()) { err.value = '目的地必填'; return; }
  busy.value = true;
  try {
    const body = { ...form, destination: form.destination.trim() };
    delete body.cityId; // 服务端自己匹配城市
    const j = await api('/guides', { method: 'POST', body });
    location.hash = '#/guide/' + j.id;
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  const d = route.query.destination;
  if (d) {
    form.destination = String(d);
    await loadAttractions();
  }
  try { aiStatus.value = await api('/ai/status'); } catch { /* 忽略 */ }
  try {
    const m = await api('/auth/me');
    quota.value = (m.user && m.user.quota && m.user.quota.guide) || null;
    if (m.user && !m.user.can_use_ai && m.user.role !== 'admin') aiMsg.value = '管理员未给你开通 AI 使用权限';
    else if (aiStatus.value && aiStatus.value.effective_source === 'none') aiMsg.value = '尚无可用 AI 配置：请管理员在「设置 → AI 全局配置」填写接口与 Key';
  } catch { /* 401 已跳登录 */ }
});
</script>

<style scoped>
.plan { max-width: 900px; margin: 0 auto; }
.stepper { display: flex; align-items: center; gap: 10px; }
.days-num { font-size: 20px; font-weight: 700; color: var(--acc-d); min-width: 30px; text-align: center; }
.sug {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
  background: #fff; border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 8px 24px rgba(60, 80, 60, 0.15); overflow: hidden;
}
.sug .s { padding: 8px 16px; cursor: pointer; display: flex; justify-content: space-between; font-size: 14px; }
.sug .s:hover { background: var(--acc-l); }
.sug .s small { color: var(--mut); }
.poi-add { position: relative; display: flex; gap: 8px; margin-top: 10px; max-width: 560px; }
.poi-add .input { flex: 1; }
.poi-add .sug { right: 74px; } /* 给右边「添加」按钮让位，否则建议被按钮压住 */
.poi-pool { display: flex; flex-wrap: wrap; gap: 6px; }
.poi-pool .opt {
  padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line);
  background: #fff; cursor: pointer; font-size: 13px;
}
.poi-pool .opt.on { background: var(--acc); color: #fff; border-color: var(--acc); }
.poi-pool .opt small { opacity: 0.8; }
.seg .opt { user-select: none; }
</style>
