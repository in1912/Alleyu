<template>
  <div class="login-page">
    <div class="split">
      <div class="left">
        <RiderScene />
        <div class="brand">
          <h1>游巷</h1>
          <p>AI 旅行札记 · 攻略与游记</p>
        </div>
      </div>
      <div class="right">
        <div class="card dlg-card">
          <div class="pig">🐰</div>
          <h2>注册账号 <small>需要管理员发的邀请码</small></h2>

          <!-- 库里没有可用邀请码时，直接说清楚，别让人白填五项 -->
          <p v-if="open === false" class="err-text" style="margin: 0 0 10px">
            当前未开放注册（没有可用的邀请码），请联系管理员获取后再来。
          </p>

          <label class="fld">邮箱</label>
          <input v-model="email" class="input" placeholder="you@example.com" autocomplete="email" />

          <label class="fld" style="margin-top: 10px">昵称</label>
          <input v-model="nickname" class="input" placeholder="显示在侧栏与首页的名字（20 字内）" />

          <label class="fld" style="margin-top: 10px">用户名</label>
          <input v-model="username" class="input" placeholder="登录用，3~20 位字母/数字/下划线" autocomplete="username" />

          <label class="fld" style="margin-top: 10px">密码</label>
          <input v-model="password" type="password" class="input" placeholder="至少 6 位" autocomplete="new-password" />

          <label class="fld" style="margin-top: 10px">邀请码</label>
          <input v-model="code" class="input" placeholder="管理员给你的 8 位邀请码" style="text-transform: uppercase" @keyup.enter="doRegister" />

          <p v-if="err" class="err-text">{{ err }}</p>
          <button class="btn" style="width: 100%; margin-top: 16px" :disabled="busy || open === false" @click="doRegister">
            {{ busy ? '注册中…' : '注册并登录' }}
          </button>
          <p class="hint" style="margin-top: 12px">
            已经有账号？<a href="#/login" style="color: var(--acc-d)">去登录</a>
            · <a href="#/" style="color: var(--mut)">先逛逛首页</a>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import RiderScene from '../components/RiderScene.vue';
import { api, setToken } from '../api/index.js';
import { setSession } from '../stores/session.js';

const email = ref('');
const nickname = ref('');
const username = ref('');
const password = ref('');
const code = ref('');
const err = ref('');
const busy = ref(false);
const open = ref(null); // null=还不知道（接口没回）/ true / false

async function doRegister() {
  err.value = '';
  if (!email.value.trim()) { err.value = '请填写邮箱'; return; }
  if (!nickname.value.trim()) { err.value = '请填写昵称'; return; }
  if (!username.value.trim()) { err.value = '请填写用户名'; return; }
  if (!password.value) { err.value = '请填写密码'; return; }
  if (!code.value.trim()) { err.value = '请填写邀请码'; return; }
  busy.value = true;
  try {
    const j = await api('/auth/register', {
      method: 'POST',
      body: {
        email: email.value.trim(), display_name: nickname.value.trim(), username: username.value.trim(),
        password: password.value, invite_code: code.value.trim(),
      },
    });
    setToken(j.token);
    setSession(j.user); // 注册即登录：直接把用户写进共享缓存，省一次 /auth/me
    location.hash = '#/';
  } catch (e) {
    err.value = e.message;
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    const j = await api('/auth/register-open');
    open.value = !!j.open;
  } catch { /* 读不到就不拦人，让提交时由服务端给准确原因 */ }
});
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #edf1ea 0%, #e3e9e0 100%);
}
.split { display: grid; grid-template-columns: 2fr 1fr; min-height: 100vh; }
.left { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.left .brand { position: absolute; left: 34px; bottom: 26px; }
.left .brand h1 { margin: 0; font-size: 30px; color: var(--acc-d); letter-spacing: 2px; }
.left .brand p { margin: 4px 0 0; color: var(--mut); font-size: 13.5px; }
.right { display: flex; align-items: center; justify-content: center; padding: 24px 18px;
  border-left: 1px solid rgba(0,0,0,0.05); background: rgba(255,255,255,0.35); }
.dlg-card { width: min(380px, 92vw); text-align: left; padding: 26px 26px 22px; }
.pig { font-size: 40px; text-align: center; }
h2 { color: var(--acc-d); margin: 6px 0 12px; font-size: 20px; text-align: center; }
h2 small { font-size: 12.5px; color: var(--mut); font-weight: 400; display: block; margin-top: 3px; }
.dlg-card .fld { display: block; }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; } .left { min-height: 30vh; } .right { border-left: none; } }
</style>
