<template>
  <div>
    <h2 style="margin: 0 0 14px">⚙️ 设置</h2>
    <div class="tabs">
      <div class="t" :class="{ on: tab === 'me' }" @click="tab = 'me'">我的 AI 配置</div>
      <div v-if="isAdmin" class="t" :class="{ on: tab === 'global' }" @click="tab = 'global'">全局配置（管理员）</div>
      <div class="t" :class="{ on: tab === 'pwd' }" @click="tab = 'pwd'">修改密码</div>
      <div v-if="isAdmin" class="t" :class="{ on: tab === 'sys' }" @click="tab = 'sys'">系统</div>
    </div>

    <!-- 个人 AI -->
    <div v-if="tab === 'me'" class="card">
      <p class="hint" style="margin-top: 0">
        自己的接口优先使用；留空则用管理员配置的全局 Key（前提是管理员给你开通了使用权限）。
        兼容 OpenAI 接口格式（/v1/chat/completions），填基地址即可，例如 https://api.xxx.com 或 https://api.xxx.com/v1。
      </p>
      <div class="grid2">
        <div><label class="fld">接口地址 Base URL</label><input v-model="p.baseUrl" class="input" placeholder="https://api.example.com/v1" /></div>
        <div><label class="fld">模型名</label><input v-model="p.model" class="input" placeholder="例如 gpt-4o-mini / deepseek-chat / kimi-for-coding" /></div>
        <div style="grid-column: 1 / -1">
          <label class="fld">API Key{{ p.has_key ? '（已保存，留空不修改）' : '' }}</label>
          <input v-model="p.key" type="password" class="input" placeholder="sk-…" autocomplete="new-password" />
        </div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 16px; align-items: center">
        <button class="btn" @click="saveP">保存</button>
        <button class="btn ghost" @click="test(false)">测试连通</button>
        <span v-if="pMsg" :class="pOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ pMsg }}</span>
      </div>
      <div v-if="testModels && testModels.length" class="hint" style="margin-top: 8px">
        服务商可用模型（前 20）：{{ testModels.slice(0, 20).join('、') }}
      </div>
    </div>

    <!-- 全局（admin） -->
    <div v-if="tab === 'global' && isAdmin" class="card">
      <p class="hint" style="margin-top: 0">全局 AI Key：未配置个人接口的用户在开通 can_use_ai 后使用这份。Key 加密存库、界面不回显。</p>
      <div class="grid2">
        <div><label class="fld">接口地址</label><input v-model="g.baseUrl" class="input" placeholder="https://api.example.com/v1" /></div>
        <div><label class="fld">模型名</label><input v-model="g.model" class="input" /></div>
        <div style="grid-column: 1 / -1"><label class="fld">API Key{{ g.has_key ? '（已保存，留空不修改）' : '' }}</label><input v-model="g.key" type="password" class="input" autocomplete="new-password" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" @click="saveG">保存全局配置</button>
        <button class="btn ghost" @click="test(true)">测试连通</button>
        <span v-if="gMsg" :class="gOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ gMsg }}</span>
      </div>
      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <div class="grid2">
        <div>
          <label class="fld">高德 Web 服务 Key{{ g.amapSet ? '（已配置）' : '' }}</label>
          <input v-model="g.amapKey" class="input" placeholder="32 位十六进制 Key（地图/图片/POI 用）" />
        </div>
        <div style="align-self: end"><button class="btn ghost" @click="saveAmap">保存高德 Key</button></div>
      </div>
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
          <tr><td>AI 通道</td><td>{{ sys.stub_ai ? '⚠️ 桩模式（ALLEYU_AI_STUB=1，非真实模型）' : '真实接口' }}</td></tr>
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
const tab = ref('me');

const p = reactive({ baseUrl: '', model: '', key: '', has_key: false });
const g = reactive({ baseUrl: '', model: '', key: '', has_key: false, amapSet: false, amapKey: '' });
const pwd = reactive({ old: '', neu: '' });

const pMsg = ref(''); const pOk = ref(false);
const gMsg = ref(''); const gOk = ref(false);
const pwdMsg = ref(''); const pwdOk = ref(false);
const testModels = ref([]);
const sys = ref(null);

async function saveP() {
  pMsg.value = '';
  try {
    await api('/ai/config', { method: 'PUT', body: { base_url: p.baseUrl, model: p.model, key: p.key } });
    p.has_key = !!(p.key || p.has_key);
    p.key = '';
    pOk.value = true; pMsg.value = '已保存（Key 加密存库）';
  } catch (e) { pOk.value = false; pMsg.value = e.message; }
}
async function test(isGlobal) {
  const tgt = isGlobal ? g : p;
  const msg = isGlobal ? 'gMsg' : 'pMsg';
  const ok = isGlobal ? 'gOk' : 'pOk';
  testModels.value = [];
  try {
    const body = { base_url: tgt.baseUrl, model: tgt.model };
    if (tgt.key) body.key = tgt.key;
    const j = await api(isGlobal ? '/ai/global/test' : '/ai/test', { method: 'POST', body });
    refs[ok].value = true;
    refs[msg].value = '✅ 连通成功';
    testModels.value = j.models || [];
  } catch (e) {
    refs[ok].value = false;
    refs[msg].value = e.message;
  }
}
const refs = { pMsg, gMsg, pOk, gOk };
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
    alert('高德 Key 已保存');
  } catch (e) { alert(e.message); }
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
  const pc = await api('/ai/config');
  p.baseUrl = pc.base_url; p.model = pc.model; p.has_key = pc.has_key;
  if (isAdmin.value) {
    const gc = await api('/ai/global');
    g.baseUrl = gc.base_url; g.model = gc.model; g.has_key = gc.has_key;
    const st = await api('/settings');
    g.amapSet = !!st.amap_key_set;
    sys.value = await api('/system-info');
  }
});
</script>
