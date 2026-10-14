<template>
  <div>
    <div class="uv-head">
      <h2 style="margin: 0">👥 用户管理</h2>
      <button class="btn sm" @click="dlg = { ...emptyUser }">＋ 新增用户</button>
    </div>
    <div class="card">
      <table class="tb">
        <thead><tr><th>用户</th><th>角色</th><th>AI</th><th>页面权限</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td><b>{{ u.username }}</b><small v-if="u.display_name" class="hint">（{{ u.display_name }}）</small></td>
            <td><span class="badge" :class="u.role === 'admin' ? 'blue' : 'gray'">{{ u.role === 'admin' ? '管理员' : '用户' }}</span></td>
            <td>
              <input type="checkbox" :checked="u.can_use_ai" @change="quickToggle(u, 'can_use_ai', $event.target.checked)" title="允许使用管理员全局 AI Key" />
            </td>
            <td>
              <span v-if="u.role === 'admin'" class="hint">全部</span>
              <span v-else-if="!(u.allowed_pages || []).length" class="hint">全部（未限制）</span>
              <span v-else><span v-for="p in u.allowed_pages" :key="p" class="badge" style="margin-right: 4px">{{ pageName(p) }}</span></span>
            </td>
            <td class="hint">{{ u.created_at }}</td>
            <td>
              <button class="btn ghost sm" @click="dlg = { ...u, password: '' }">编辑</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="del(u)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint" style="margin-top: 10px">「AI」勾选 = 允许该用户使用管理员配置的全局 Key（v1.6.0 起全站只有这一份 Key，个人配置已下线）。</p>
    </div>

    <div v-if="dlg" class="mask" @click.self="dlg = null">
      <div class="dlg">
        <h3>{{ dlg.id ? '编辑用户 ' + dlg.username : '新增用户' }}</h3>
        <div class="grid2">
          <div><label class="fld">用户名 *</label><input v-model="dlg.username" class="input" :disabled="!!dlg.id" /></div>
          <div><label class="fld">显示名</label><input v-model="dlg.display_name" class="input" /></div>
          <div><label class="fld">角色</label>
            <select v-model="dlg.role" class="input"><option value="user">用户</option><option value="admin">管理员</option></select>
          </div>
          <div><label class="fld">密码{{ dlg.id ? '（留空不改）' : ' *（≥6位）' }}</label><input v-model="dlg.password" type="password" class="input" autocomplete="new-password" /></div>
        </div>
        <label class="fld" style="margin-top: 10px"><input type="checkbox" v-model="dlg.can_use_ai" style="vertical-align: -2px" /> 允许使用全局 AI Key</label>
        <label class="fld" style="margin-top: 10px">页面权限（都不勾 = 全部开放）</label>
        <div class="seg">
          <span v-for="(label, p) in PAGES" :key="p" class="opt" :class="{ on: (dlg.allowed_pages || []).includes(p) }" @click="togglePage(p)">
            {{ label }}
          </span>
        </div>
        <p v-if="dlgErr" class="err-text">{{ dlgErr }}</p>
        <div style="margin-top: 18px; display: flex; gap: 10px; justify-content: flex-end">
          <button class="btn ghost" @click="dlg = null">取消</button>
          <button class="btn" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/index.js';

const PAGES = { guides: '攻略', library: '城市景点库', weather: '天气', settings: '设置' };
const emptyUser = { username: '', display_name: '', role: 'user', password: '', can_use_ai: false, allowed_pages: [] };
const users = ref([]);
const dlg = ref(null);
const dlgErr = ref('');

function pageName(p) { return PAGES[p] || p; }
function togglePage(p) {
  const arr = dlg.value.allowed_pages || [];
  const i = arr.indexOf(p);
  if (i >= 0) arr.splice(i, 1); else arr.push(p);
}
async function load() {
  const j = await api('/users');
  users.value = j.users;
  // 后端没有随行 PAGES 中文 → 前端固定
}
async function quickToggle(u, key, val) {
  try {
    await api('/users/' + u.id, { method: 'PUT', body: { [key]: val } });
    u[key] = val;
  } catch (e) { alert(e.message); load(); }
}
async function save() {
  dlgErr.value = '';
  const b = { display_name: dlg.value.display_name, role: dlg.value.role, can_use_ai: !!dlg.value.can_use_ai, allowed_pages: dlg.value.allowed_pages || [] };
  if (dlg.value.password) b.password = dlg.value.password;
  try {
    if (dlg.value.id) await api('/users/' + dlg.value.id, { method: 'PUT', body: b });
    else {
      if (!dlg.value.username || !dlg.value.password) { dlgErr.value = '用户名和密码必填'; return; }
      await api('/users', { method: 'POST', body: { ...b, username: dlg.value.username, password: dlg.value.password } });
    }
    dlg.value = null;
    load();
  } catch (e) { dlgErr.value = e.message; }
}
async function del(u) {
  if (!confirm(`删除用户「${u.username}」？其攻略一并删除。`)) return;
  try {
    await api('/users/' + u.id, { method: 'DELETE' });
    load();
  } catch (e) { alert(e.message); }
}
onMounted(load);
</script>

<style scoped>
.uv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
</style>
