<template>
  <div>
    <h2 style="margin: 0 0 14px">⚙️ 设置</h2>
    <div class="tabs">
      <div class="t" :class="{ on: tab === 'global' }" @click="tab = 'global'">AI 全局配置</div>
      <div class="t" :class="{ on: tab === 'invite' }" @click="tab = 'invite'">邀请码</div>
      <div class="t" :class="{ on: tab === 'sys' }" @click="tab = 'sys'">系统</div>
    </div>

    <!-- AI 全局（admin，v1.6.0 起全站唯一一份 Key）。v1.10.0：本页整页仅管理员可达 -->
    <div v-if="tab === 'global'" class="card">
      <p class="hint" style="margin-top: 0">
        全站共用这一份 AI Key（v1.6.0 起个人配置已下线）：开通「允许使用 AI」的用户都用它生成攻略。
        兼容 OpenAI 接口格式（/v1/chat/completions），填基地址即可，例如 https://api.xxx.com 或 https://api.xxx.com/v1。
        生成请求已默认关闭思考链（推理模型把 token 预算吃进思考会导致正文极短或为空）。
      </p>
      <div class="grid2">
        <div><label class="fld">接口地址</label><input v-model="g.baseUrl" class="input" placeholder="https://api.example.com/v1" /></div>
        <div><label class="fld">模型名</label><input v-model="g.model" class="input" /></div>
        <div style="grid-column: 1 / -1">
          <label class="fld">API Key{{ g.has_key ? '（已保存，留空不修改）' : '' }}</label>
          <input v-model="g.key" type="password" class="input" autocomplete="new-password" />
          <p v-if="g.key && !/^sk-/.test(g.key.trim())" class="hint" style="margin: 4px 0 0">⚠️ 多数服务商 Key 以 sk- 开头——当前输入不是，检查是否粘贴完整（丢前缀会报 401 且报错里看不出差别）</p>
        </div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" @click="saveG">保存全局配置</button>
        <button class="btn ghost" @click="testG">测试连通</button>
        <span v-if="gMsg" :class="gOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ gMsg }}</span>
      </div>
      <div v-if="testModels && testModels.length" class="hint" style="margin-top: 8px">
        服务商可用模型（前 20）：{{ testModels.slice(0, 20).join('、') }}
      </div>
      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <div class="grid2">
        <div>
          <label class="fld">高德 Web 服务 Key{{ g.amapSet ? '（已配置）' : '' }}</label>
          <input v-model="g.amapKey" class="input" placeholder="32 位十六进制（留空可测已保存的）" />
        </div>
        <div style="align-self: end; display: flex; gap: 8px; flex-wrap: wrap">
          <button class="btn ghost" @click="saveAmap">保存</button>
          <button class="btn ghost" @click="testAmap">测试连通</button>
          <button class="btn ghost" @click="resetAmap">清空</button>
        </div>
      </div>
      <p v-if="amapMsg" :class="amapOk ? 'ok-text' : 'err-text'" style="margin: 8px 0 0; font-size: 13px">
        {{ amapMsg }}
      </p>
      <p class="hint">注意：必须是「Web服务」类型的 Key，「Web端(JS API)」类型调不了 REST 接口（会报 10009）。测试连通会给出具体原因。</p>
      <p class="hint">用户级授权与生成次数在「用户管理」里按人设置。</p>
    </div>

    <!-- 邀请码（v1.10.0）：注册的唯一入口凭证。可设使用次数、可备注、可一次性、可停用 -->
    <div v-if="tab === 'invite'" class="card">
      <p class="hint" style="margin-top: 0">
        注册必须凭邀请码。可生成一次性码（使用次数 1）或多人共用的码；
        已用过的码建议「停用」而不是删除（保留谁邀请了谁的线索）；库里没有任何可用码时，
        注册页会直接显示「当前未开放注册」。
      </p>
      <div class="grid3">
        <div><label class="fld">生成个数</label><input v-model.number="ng.count" type="number" min="1" max="50" class="input" /></div>
        <div><label class="fld">每个可用次数</label><input v-model.number="ng.maxUses" type="number" min="1" max="9999" class="input" /></div>
        <div><label class="fld">备注（谁用/用途）</label><input v-model="ng.note" class="input" placeholder="例如：给老王 / 部门同事" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" :disabled="ngBusy" @click="makeInvites">{{ ngBusy ? '生成中…' : '生成邀请码' }}</button>
        <button class="btn ghost" @click="ng.maxUses = 1">一次性码</button>
        <span v-if="ngMsg" :class="ngOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ ngMsg }}</span>
      </div>

      <table class="tb" style="margin-top: 16px">
        <thead><tr><th>邀请码</th><th>使用次数</th><th>已用</th><th>备注</th><th>状态</th><th>生成时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in invites" :key="c.id">
            <td>
              <b style="letter-spacing: 1px">{{ c.code }}</b>
              <button class="btn ghost sm" style="margin-left: 6px" @click="copy(c.code)">复制</button>
            </td>
            <td>{{ c.max_uses === 1 ? '一次性' : c.max_uses + ' 次' }}</td>
            <td>{{ c.used_count }} / {{ c.max_uses }}</td>
            <td class="hint">{{ c.note || '—' }}</td>
            <td>
              <span class="badge" :class="c.enabled && c.used_count < c.max_uses ? 'blue' : 'gray'">
                {{ !c.enabled ? '已停用' : (c.used_count >= c.max_uses ? '已用完' : '可用') }}
              </span>
            </td>
            <td class="hint">{{ c.created_at }}</td>
            <td>
              <button class="btn ghost sm" @click="toggleInvite(c)">{{ c.enabled ? '停用' : '启用' }}</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="delInvite(c)">删除</button>
            </td>
          </tr>
          <tr v-if="!invites.length"><td colspan="7" class="hint">还没有邀请码 —— 生成一个才能让别人注册</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 系统：版本信息 + 系统默认生成次数 -->
    <div v-if="tab === 'sys'" class="card">
      <table class="tb" style="max-width: 520px" v-if="sys">
        <tbody>
          <tr><td>名称 / 版本</td><td><b>{{ sys.name }}</b> v{{ sys.version }}</td></tr>
          <tr><td>Node</td><td>{{ sys.node }}（{{ sys.platform }}）</td></tr>
          <tr><td>用户 / 攻略</td><td>{{ sys.users }} / {{ sys.guides }}</td></tr>
          <tr><td>城市 / 景点</td><td>{{ sys.cities }} / {{ sys.attractions }}</td></tr>
          <tr><td>AI 通道</td><td>{{ sys.stub_ai ? 'ALLEYU_AI_STUB=1（未配置 Key 时本地桩兜底，配了 Key 一律走真接口）' : '真实接口' }}</td></tr>
        </tbody>
      </table>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 18px 0" />
      <h3 style="margin-top: 0">系统默认生成次数</h3>
      <p class="hint" style="margin-top: 0">
        新用户、以及把次数设成「跟随默认」的用户按这里的值算。<b>留空 = 不限</b>；
        累计总额、用光为止（不做每月重置）。只有真的生成成功才扣一次，失败/重试不扣。
        单独给某人加次数或设成不限，在「用户管理」里改。
      </p>
      <div class="grid2" style="max-width: 520px">
        <div><label class="fld">攻略次数（留空 = 不限）</label><input v-model="q.guide" class="input" placeholder="例如 3；留空不限" /></div>
        <div><label class="fld">游记次数（留空 = 不限）</label><input v-model="q.journal" class="input" placeholder="例如 3；留空不限" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" @click="saveQuota">保存默认次数</button>
        <span v-if="qMsg" :class="qOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ qMsg }}</span>
      </div>
      <p class="hint" style="margin-bottom: 0">管理员账号不受次数限制，但用量（token）照样统计。</p>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api/index.js';

const tab = ref('global');

const g = reactive({ baseUrl: '', model: '', key: '', has_key: false, amapSet: false, amapKey: '' });
const gMsg = ref(''); const gOk = ref(false);
const amapMsg = ref(''); const amapOk = ref(false);
const testModels = ref([]);
const sys = ref(null);

// 邀请码
const invites = ref([]);
const ng = reactive({ count: 1, maxUses: 1, note: '' });
const ngMsg = ref(''); const ngOk = ref(false); const ngBusy = ref(false);

// 系统默认次数
const q = reactive({ guide: '', journal: '' });
const qMsg = ref(''); const qOk = ref(false);

async function loadInvites() {
  const j = await api('/invites');
  invites.value = j.invites || [];
}
async function makeInvites() {
  ngMsg.value = '';
  ngBusy.value = true;
  try {
    const j = await api('/invites', { method: 'POST', body: { count: ng.count, max_uses: ng.maxUses, note: ng.note } });
    ngOk.value = true;
    ngMsg.value = `已生成 ${j.codes.length} 个：${j.codes.join('、')}`;
    ng.note = '';
    await loadInvites();
  } catch (e) { ngOk.value = false; ngMsg.value = e.message; } finally { ngBusy.value = false; }
}
async function toggleInvite(c) {
  try {
    await api(`/invites/${c.id}`, { method: 'PUT', body: { enabled: !c.enabled } });
    await loadInvites();
  } catch (e) { alert(e.message); }
}
async function delInvite(c) {
  if (!confirm(`删除邀请码 ${c.code}？${c.used_count > 0 ? '（已被用过，建议改用「停用」保留线索）' : ''}`)) return;
  try {
    await api(`/invites/${c.id}`, { method: 'DELETE' });
    await loadInvites();
  } catch (e) { alert(e.message); }
}
function copy(code) {
  navigator.clipboard?.writeText(code).then(
    () => { ngOk.value = true; ngMsg.value = `已复制 ${code}`; },
    () => { ngOk.value = false; ngMsg.value = '复制失败，请手动选中'; },
  );
}
async function saveQuota() {
  qMsg.value = '';
  try {
    await api('/settings', { method: 'PUT', body: { quota_default_guide: q.guide, quota_default_journal: q.journal } });
    qOk.value = true; qMsg.value = '已保存（对新用户与「跟随默认」的用户立即生效）';
  } catch (e) { qOk.value = false; qMsg.value = e.message; }
}

async function testG() {
  gMsg.value = ''; testModels.value = [];
  try {
    const body = { base_url: g.baseUrl, model: g.model };
    if (g.key) body.key = g.key;
    const j = await api('/ai/global/test', { method: 'POST', body });
    gOk.value = true; gMsg.value = '✅ 连通成功';
    testModels.value = j.models || [];
  } catch (e) {
    gOk.value = false; gMsg.value = e.message;
  }
}
async function saveG() {
  gMsg.value = '';
  try {
    await api('/ai/global', { method: 'PUT', body: { base_url: g.baseUrl, model: g.model, key: g.key } });
    g.has_key = !!(g.key || g.has_key);
    g.key = '';
    gOk.value = true; gMsg.value = '已保存';
  } catch (e) { gOk.value = false; gMsg.value = e.message; }
}
async function saveAmap() {
  try {
    await api('/settings', { method: 'PUT', body: { amap_key: g.amapKey } });
    g.amapSet = !!g.amapKey;
    amapOk.value = true; amapMsg.value = '高德 Key 已保存';
  } catch (e) { amapOk.value = false; amapMsg.value = e.message; }
}
async function testAmap() {
  amapMsg.value = '测试中…'; amapOk.value = false;
  try {
    const j = await api('/settings/amap/test', { method: 'POST', body: { key: g.amapKey } });
    if (j.ok) { amapOk.value = true; amapMsg.value = '✅ 高德连通正常'; }
    else amapMsg.value = `❌ ${j.info}${j.infocode ? `（${j.infocode}）` : ''}${j.hint ? '——' + j.hint : ''}`;
  } catch (e) { amapMsg.value = e.message; }
}
async function resetAmap() {
  if (!confirm('清空已保存的高德 Key？（之后需要重新配置才能用地图功能）')) return;
  try {
    await api('/settings/amap/reset', { method: 'POST' });
    g.amapSet = false; g.amapKey = '';
    amapOk.value = true; amapMsg.value = '高德 Key 已清空，请到 lbs.amap.com 申请自己的 Key 后在上方填入';
  } catch (e) { amapOk.value = false; amapMsg.value = e.message; }
}

onMounted(async () => {
  const gc = await api('/ai/global');
  g.baseUrl = gc.base_url; g.model = gc.model; g.has_key = gc.has_key;
  const st = await api('/settings');
  g.amapSet = !!st.amap_key_set;
  q.guide = st.quota_default_guide || '';
  q.journal = st.quota_default_journal || '';
  sys.value = await api('/system-info');
  await loadInvites();
});
</script>

<style scoped>
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 12px; }
@media (max-width: 760px) { .grid3 { grid-template-columns: 1fr; } }
</style>
