<template>
  <div>
    <h2 style="margin: 0 0 14px">⚙️ 设置</h2>
    <div class="tabs">
      <div v-if="isAdmin" class="t" :class="{ on: tab === 'global' }" @click="tab = 'global'">AI 全局配置（管理员）</div>
      <div class="t" :class="{ on: tab === 'pwd' }" @click="tab = 'pwd'">修改密码</div>
      <div v-if="isAdmin" class="t" :class="{ on: tab === 'sys' }" @click="tab = 'sys'">系统</div>
    </div>

    <!-- AI 全局（admin，v1.6.0 起全站唯一一份 Key） -->
    <div v-if="tab === 'global' && isAdmin" class="card">
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
          <button class="btn ghost" @click="resetAmap">恢复内置</button>
        </div>
      </div>
      <p v-if="amapMsg" :class="amapOk ? 'ok-text' : 'err-text'" style="margin: 8px 0 0; font-size: 13px">
        {{ amapMsg }}
      </p>
      <p class="hint">注意：必须是「Web服务」类型的 Key，「Web端(JS API)」类型调不了 REST 接口（会报 10009）。测试连通会给出具体原因。</p>
      <p class="hint">用户级授权在「用户管理」里按人勾选「允许使用 AI」。</p>
    </div>

    <!-- 密码 -->
    <div v-if="tab === 'pwd'" class="card" style="max-width: 460px">
      <label class="fld">原密码</label>
      <input v-model="pwd.old" type="password" class="input" autocomplete="current-password" />
      <label class="fld" style="margin-top: 10px">新密码（≥6 位）</label>
      <input v-model="pwd.neu" type="password" class="input" autocomplete="new-password" />
      <div style="margin-top: 14px; display: flex; gap: 10px; align-items: center">
        <button class="btn" @click="savePwd">修改密码</button>
        <span v-if="pwdMsg" :class="pwdOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ pwdMsg }}</span>
      </div>
    </div>

    <!-- 系统 -->
    <div v-if="tab === 'sys' && isAdmin && sys" class="card">
      <table class="tb" style="max-width: 480px">
        <tbody>
          <tr><td>名称 / 版本</td><td><b>{{ sys.name }}</b> v{{ sys.version }}</td></tr>
          <tr><td>Node</td><td>{{ sys.node }}（{{ sys.platform }}）</td></tr>
          <tr><td>用户 / 攻略</td><td>{{ sys.users }} / {{ sys.guides }}</td></tr>
          <tr><td>城市 / 景点</td><td>{{ sys.cities }} / {{ sys.attractions }}</td></tr>
          <tr><td>AI 通道</td><td>{{ sys.stub_ai ? 'ALLEYU_AI_STUB=1（未配置 Key 时本地桩兜底，配了 Key 一律走真接口）' : '真实接口' }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api/index.js';

const me = ref(null);
const isAdmin = computed(() => me.value?.role === 'admin');
const tab = ref('pwd');

const g = reactive({ baseUrl: '', model: '', key: '', has_key: false, amapSet: false, amapKey: '' });
const pwd = reactive({ old: '', neu: '' });

const gMsg = ref(''); const gOk = ref(false);
const pwdMsg = ref(''); const pwdOk = ref(false);
const amapMsg = ref(''); const amapOk = ref(false);
const testModels = ref([]);
const sys = ref(null);

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
  if (!confirm('恢复为项目内置的高德 Key？（自己配的 Key 会被覆盖）')) return;
  try {
    await api('/settings/amap/reset', { method: 'POST' });
    g.amapSet = true; g.amapKey = '';
    amapOk.value = true; amapMsg.value = '已恢复内置 Key';
  } catch (e) { amapOk.value = false; amapMsg.value = e.message; }
}
async function savePwd() {
  pwdMsg.value = '';
  try {
    await api('/auth/password', { method: 'POST', body: { oldPassword: pwd.old, newPassword: pwd.neu } });
    pwdOk.value = true; pwdMsg.value = '密码已修改';
    pwd.old = ''; pwd.neu = '';
  } catch (e) { pwdOk.value = false; pwdMsg.value = e.message; }
}
onMounted(async () => {
  me.value = (await api('/auth/me')).user;
  if (isAdmin.value) {
    tab.value = 'global';
    const gc = await api('/ai/global');
    g.baseUrl = gc.base_url; g.model = gc.model; g.has_key = gc.has_key;
    const st = await api('/settings');
    g.amapSet = !!st.amap_key_set;
    sys.value = await api('/system-info');
  }
});
</script>
