<template>
  <div>
    <h2 style="margin: 0 0 14px">👤 我的</h2>

    <div class="card" style="max-width: 560px">
      <table class="tb">
        <tbody>
          <tr><td style="width: 120px">用户名</td><td><b>{{ u.username }}</b> <span class="hint">（登录凭据，不可修改）</span></td></tr>
          <tr><td>邮箱</td><td>{{ u.email || '—' }}</td></tr>
          <tr><td>角色</td><td><span class="badge" :class="u.role === 'admin' ? 'blue' : 'gray'">{{ u.role === 'admin' ? '管理员' : '用户' }}</span></td></tr>
          <tr><td>注册时间</td><td class="hint">{{ u.created_at || '—' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card" style="max-width: 560px">
      <h3 style="margin-top: 0">生成次数</h3>
      <table class="tb">
        <tbody>
          <tr>
            <td style="width: 120px">攻略</td>
            <td>
              <b v-if="u.quota?.guide?.unlimited">不限</b>
              <b v-else>剩余 {{ u.quota?.guide?.left ?? '—' }} 次</b>
              <span class="hint">（共 {{ u.quota?.guide?.limit ?? '—' }} 次，已用 {{ u.quota?.guide?.used ?? 0 }}）</span>
            </td>
          </tr>
          <tr>
            <td>游记</td>
            <td>
              <b v-if="u.quota?.journal?.unlimited">不限</b>
              <b v-else>剩余 {{ u.quota?.journal?.left ?? '—' }} 次</b>
              <span class="hint">（共 {{ u.quota?.journal?.limit ?? '—' }} 次，已用 {{ u.quota?.journal?.used ?? 0 }}）</span>
            </td>
          </tr>
          <tr>
            <td>累计消耗 token</td>
            <td>
              <b>{{ fmt(u.tokens?.in) }}</b> 输入 · <b>{{ fmt(u.tokens?.out) }}</b> 输出
              <span class="hint">（合计 {{ fmt((u.tokens?.in || 0) + (u.tokens?.out || 0)) }}，由服务商回包统计）</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint" style="margin-bottom: 0">
        次数用完了找管理员加（生成失败不扣次数，只有真的出稿才算一次）；
        管理员账号不受次数限制。
      </p>
    </div>

    <div class="card" style="max-width: 560px">
      <h3 style="margin-top: 0">改昵称</h3>
      <label class="fld">昵称（1~20 字，显示在侧栏与首页）</label>
      <input v-model="nick" class="input" />
      <div style="margin-top: 12px; display: flex; gap: 10px; align-items: center">
        <button class="btn" :disabled="busyNick" @click="saveNick">保存昵称</button>
        <span v-if="nickMsg" :class="nickOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ nickMsg }}</span>
      </div>
    </div>

    <div class="card" style="max-width: 560px">
      <h3 style="margin-top: 0">改密码</h3>
      <label class="fld">原密码</label>
      <input v-model="oldPwd" type="password" class="input" autocomplete="current-password" />
      <label class="fld" style="margin-top: 10px">新密码（≥6 位）</label>
      <input v-model="newPwd" type="password" class="input" autocomplete="new-password" />
      <div style="margin-top: 12px; display: flex; gap: 10px; align-items: center">
        <button class="btn" :disabled="busyPwd" @click="savePwd">修改密码</button>
        <span v-if="pwdMsg" :class="pwdOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ pwdMsg }}</span>
      </div>
    </div>

    <!-- v1.12.0：手机端普通用户没有「更多」浮层，回首页/退出放在这里 -->
    <div class="acct-foot">
      <a href="#/">← 回首页</a>
      <a style="cursor: pointer" @click="logout">退出登录</a>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api, setToken } from '../api/index.js';
import { setSession, clearSession } from '../stores/session.js';

const emit = defineEmits(['refresh-me']);

const u = ref({});
const nick = ref('');
const oldPwd = ref('');
const newPwd = ref('');
const nickMsg = ref(''); const nickOk = ref(false); const busyNick = ref(false);
const pwdMsg = ref(''); const pwdOk = ref(false); const busyPwd = ref(false);

function fmt(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('en-US');
}
async function load() {
  const j = await api('/auth/me');
  u.value = j.user || {};
  nick.value = u.value.display_name || '';
  setSession(j.user);
}
async function saveNick() {
  nickMsg.value = '';
  if (!nick.value.trim()) { nickOk.value = false; nickMsg.value = '昵称不能为空'; return; }
  busyNick.value = true;
  try {
    const j = await api('/auth/profile', { method: 'POST', body: { display_name: nick.value.trim() } });
    u.value = j.user;
    setSession(j.user);
    emit('refresh-me'); // 侧栏的显示名跟着换
    nickOk.value = true; nickMsg.value = '昵称已更新';
  } catch (e) { nickOk.value = false; nickMsg.value = e.message; } finally { busyNick.value = false; }
}
async function savePwd() {
  pwdMsg.value = '';
  if (!newPwd.value) { pwdOk.value = false; pwdMsg.value = '请填写新密码'; return; }
  busyPwd.value = true;
  try {
    await api('/auth/profile', { method: 'POST', body: { oldPassword: oldPwd.value, newPassword: newPwd.value } });
    pwdOk.value = true; pwdMsg.value = '密码已修改';
    oldPwd.value = ''; newPwd.value = '';
  } catch (e) { pwdOk.value = false; pwdMsg.value = e.message; } finally { busyPwd.value = false; }
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  setToken('');
  clearSession(); // 不清共享缓存，路由守卫会拿着上一个账号的角色放行
  location.hash = '#/login';
}
onMounted(load);
</script>

<style scoped>
.acct-foot { max-width: 560px; display: flex; justify-content: center; gap: 22px; font-size: 13px; color: var(--mut); padding: 8px 0 4px; }
.acct-foot a { color: var(--acc-d); }
</style>
