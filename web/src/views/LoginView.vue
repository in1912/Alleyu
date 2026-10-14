<template>
  <div class="login-page">
    <div class="card dlg-card">
      <div class="pig">🐷</div>
      <h2>游巷 <small>AI 旅行札记</small></h2>
      <label class="fld">用户名</label>
      <input v-model="username" class="input" placeholder="用户名" @keyup.enter="doLogin" />
      <label class="fld" style="margin-top: 12px">密码</label>
      <input v-model="password" type="password" class="input" placeholder="密码" @keyup.enter="doLogin" />
      <p v-if="err" class="err-text">{{ err }}</p>
      <button class="btn" style="width: 100%; margin-top: 16px" :disabled="busy" @click="doLogin">
        {{ busy ? '登录中…' : '登录' }}
      </button>
      <p class="hint" style="margin-top: 12px">多租户系统：账号由管理员分配；首次部署默认 admin / admin123</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { api, setToken } from '../api/index.js';

const username = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);

async function doLogin() {
  if (!username.value || !password.value) { err.value = '请输入用户名和密码'; return; }
  busy.value = true;
  err.value = '';
  try {
    const j = await api('/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
    setToken(j.token);
    location.hash = '#/';
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #edf1ea 0%, #e3e9e0 100%);
}
.dlg-card { width: min(380px, 92vw); text-align: center; padding: 34px 30px; }
.pig { font-size: 52px; }
h2 { color: var(--acc-d); margin: 6px 0 20px; }
h2 small { font-size: 13px; color: var(--mut); font-weight: 400; display: block; margin-top: 2px; }
</style>
