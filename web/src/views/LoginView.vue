<template>
  <div class="login-page">
    <!-- v1.8.0：左 2/3 兔子骑车动画 + 右 1/3 登录框；登录后回兔子首页 -->
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
          <h2>欢迎回来 <small>登录后写攻略 / 写游记</small></h2>
          <label class="fld">用户名</label>
          <input v-model="username" class="input" aria-label="用户名" autocomplete="username" @keyup.enter="doLogin" />
          <label class="fld" style="margin-top: 12px">密码</label>
          <input v-model="password" type="password" class="input" aria-label="密码" autocomplete="current-password" @keyup.enter="doLogin" />
          <p v-if="err" class="err-text">{{ err }}</p>
          <button class="btn" style="width: 100%; margin-top: 16px" :disabled="busy" @click="doLogin">
            {{ busy ? '登录中…' : '登录' }}
          </button>
          <!-- v1.10.0：登录按钮正下方给注册入口（需要邀请码，注册页会自己说清） -->
          <button class="btn ghost" style="width: 100%; margin-top: 10px" @click="goRegister">没有账号？注册</button>
          <p class="hint" style="margin-top: 12px">
            <a href="#/" style="color: var(--mut)">← 先逛逛首页（游客模式）</a>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import RiderScene from '../components/RiderScene.vue';
import { api, setToken } from '../api/index.js';
import { setSession } from '../stores/session.js';

const username = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);

function goRegister() {
  location.hash = '#/register';
}
async function doLogin() {
  if (!username.value || !password.value) { err.value = '请输入用户名和密码'; return; }
  busy.value = true;
  err.value = '';
  try {
    const j = await api('/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
    setToken(j.token);
    setSession(j.user); // 共享缓存里立刻有角色，路由守卫不用再等一次 /auth/me
    location.hash = '#/'; // 登录后回兔子首页（写攻略/写游记都从首页进）
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}
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
.dlg-card { width: min(360px, 92vw); text-align: center; padding: 30px 26px; }
.pig { font-size: 46px; }
h2 { color: var(--acc-d); margin: 6px 0 18px; font-size: 20px; }
h2 small { font-size: 12.5px; color: var(--mut); font-weight: 400; display: block; margin-top: 3px; }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; } .left { min-height: 34vh; } .right { border-left: none; } }
</style>
