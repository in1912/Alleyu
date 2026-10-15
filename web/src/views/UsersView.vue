<template>
  <div>
    <div class="uv-head">
      <h2 style="margin: 0">👥 用户管理</h2>
      <button class="btn sm" @click="dlg = { ...emptyUser }">＋ 新增用户</button>
    </div>
    <div class="card">
      <table class="tb">
        <thead>
          <tr>
            <th>用户</th><th>角色</th><th>AI</th><th>页面权限</th>
            <th>攻略次数<br /><small class="hint">已用 / 总额</small></th>
            <th>游记次数<br /><small class="hint">已用 / 总额</small></th>
            <th>累计 token<br /><small class="hint">输入 + 输出</small></th>
            <th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>
              <b>{{ u.username }}</b><small v-if="u.display_name" class="hint">（{{ u.display_name }}）</small>
              <div v-if="u.email" class="hint" style="font-size: 12px">{{ u.email }}</div>
            </td>
            <td><span class="badge" :class="u.role === 'admin' ? 'blue' : 'gray'">{{ u.role === 'admin' ? '管理员' : '用户' }}</span></td>
            <td>
              <input type="checkbox" :checked="u.can_use_ai" @change="quickToggle(u, 'can_use_ai', $event.target.checked)" title="允许使用管理员全局 AI Key" />
            </td>
            <td>
              <span v-if="u.role === 'admin'" class="hint">全部</span>
              <span v-else-if="!(u.allowed_pages || []).length" class="hint">攻略 + 天气（未指定）</span>
              <span v-else><span v-for="p in u.allowed_pages" :key="p" class="badge" style="margin-right: 4px">{{ pageName(p) }}</span></span>
            </td>
            <td>
              <span v-if="u.quota.guide.unlimited" class="hint">不限</span>
              <span v-else><b>{{ u.quota.guide.used }}</b> / {{ u.quota.guide.limit }}
                <span class="hint">（剩 {{ u.quota.guide.left }}）</span></span>
              <div class="hint" style="font-size: 12px">{{ quotaLabel(u.quota_guide) }}</div>
            </td>
            <td>
              <span v-if="u.quota.journal.unlimited" class="hint">不限</span>
              <span v-else><b>{{ u.quota.journal.used }}</b> / {{ u.quota.journal.limit }}
                <span class="hint">（剩 {{ u.quota.journal.left }}）</span></span>
              <div class="hint" style="font-size: 12px">{{ quotaLabel(u.quota_journal) }}</div>
            </td>
            <td>
              <b>{{ fmt(u.tokens_total) }}</b>
              <div class="hint" style="font-size: 12px">{{ fmt(u.tokens_in) }} 入 + {{ fmt(u.tokens_out) }} 出</div>
            </td>
            <td class="hint">{{ u.created_at }}</td>
            <td>
              <button class="btn ghost sm" @click="openEdit(u)">编辑</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="del(u)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint" style="margin-top: 10px">
        「AI」勾选 = 允许该用户使用管理员配置的全局 Key。
        次数是<b>累计总额、用光为止</b>（只有生成成功才扣一次）；token 按服务商回包统计，桩模式不记。
      </p>
    </div>

    <div v-if="dlg" class="mask" @click.self="dlg = null">
      <div class="dlg">
        <h3>{{ dlg.id ? '编辑用户 ' + dlg.username : '新增用户' }}</h3>
        <div class="grid2">
          <div><label class="fld">用户名 *</label><input v-model="dlg.username" class="input" :disabled="!!dlg.id" /></div>
          <div><label class="fld">昵称</label><input v-model="dlg.display_name" class="input" /></div>
          <div><label class="fld">邮箱</label><input v-model="dlg.email" class="input" placeholder="选填（自助注册的用户自带）" /></div>
          <div><label class="fld">角色</label>
            <select v-model="dlg.role" class="input"><option value="user">用户</option><option value="admin">管理员</option></select>
          </div>
          <div><label class="fld">密码{{ dlg.id ? '（留空不改）' : ' *（≥6位）' }}</label><input v-model="dlg.password" type="password" class="input" autocomplete="new-password" /></div>
        </div>

        <label class="fld" style="margin-top: 10px"><input type="checkbox" v-model="dlg.can_use_ai" style="vertical-align: -2px" /> 允许使用全局 AI Key</label>

        <label class="fld" style="margin-top: 10px">页面权限（都不勾 = 攻略 + 天气）</label>
        <div class="seg">
          <span v-for="(label, p) in PAGES" :key="p" class="opt" :class="{ on: (dlg.allowed_pages || []).includes(p) }" @click="togglePage(p)">
            {{ label }}
          </span>
        </div>

        <h4 style="margin: 16px 0 6px">生成次数（累计总额，用光为止）</h4>
        <div class="grid2">
          <div>
            <label class="fld">攻略</label>
            <select v-model="dlg.qGuideMode" class="input">
              <option value="default">跟随系统默认</option>
              <option value="unlimited">不限次数</option>
              <option value="custom">指定次数</option>
            </select>
            <input v-if="dlg.qGuideMode === 'custom'" v-model.number="dlg.qGuideNum" type="number" min="0" max="9999" class="input" style="margin-top: 6px" />
            <div v-if="dlg.id" class="hint" style="font-size: 12px">
              已用 {{ dlg.guide_used || 0 }} 次
              <a style="cursor: pointer; margin-left: 6px" @click="dlg.qGuideClearUsed = !dlg.qGuideClearUsed">
                {{ dlg.qGuideClearUsed ? '已标记清零（保存生效）' : '清零？' }}
              </a>
            </div>
          </div>
          <div>
            <label class="fld">游记</label>
            <select v-model="dlg.qJournalMode" class="input">
              <option value="default">跟随系统默认</option>
              <option value="unlimited">不限次数</option>
              <option value="custom">指定次数</option>
            </select>
            <input v-if="dlg.qJournalMode === 'custom'" v-model.number="dlg.qJournalNum" type="number" min="0" max="9999" class="input" style="margin-top: 6px" />
            <div v-if="dlg.id" class="hint" style="font-size: 12px">
              已用 {{ dlg.journal_used || 0 }} 次
              <a style="cursor: pointer; margin-left: 6px" @click="dlg.qJournalClearUsed = !dlg.qJournalClearUsed">
                {{ dlg.qJournalClearUsed ? '已标记清零（保存生效）' : '清零？' }}
              </a>
            </div>
          </div>
        </div>
        <p class="hint" style="margin-bottom: 0">
          累计 token：<b>{{ fmt(dlg.tokens_total || 0) }}</b>（{{ fmt(dlg.tokens_in || 0) }} 入 + {{ fmt(dlg.tokens_out || 0) }} 出）——只读，由服务商回包累加。
        </p>

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

// v1.10.0：可分配的页只剩攻略/天气——城市景点库、设置（含用户管理与邀请码）都是管理员专属
const PAGES = { guides: '攻略', weather: '天气' };
const emptyUser = { username: '', display_name: '', email: '', role: 'user', password: '', can_use_ai: false, allowed_pages: [], qGuideMode: 'default', qGuideNum: 3, qJournalMode: 'default', qJournalNum: 3 };
const users = ref([]);
const dlg = ref(null);
const dlgErr = ref('');

function fmt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
function pageName(p) { return PAGES[p] || p; }
// 配额列的副标题：说清这个用户是按什么规则算的
function quotaLabel(v) {
  if (v === -2) return '不限次数';
  if (v === -1) return '跟随系统默认';
  return '指定 ' + v + ' 次';
}
function togglePage(p) {
  const arr = dlg.value.allowed_pages || [];
  const i = arr.indexOf(p);
  if (i >= 0) arr.splice(i, 1); else arr.push(p);
}
function modeOf(v) { return v === -2 ? 'unlimited' : (v === -1 ? 'default' : 'custom'); }
function openEdit(u) {
  dlg.value = {
    ...u,
    password: '',
    qGuideMode: modeOf(u.quota_guide), qGuideNum: u.quota_guide >= 0 ? u.quota_guide : 3,
    qJournalMode: modeOf(u.quota_journal), qJournalNum: u.quota_journal >= 0 ? u.quota_journal : 3,
    qGuideClearUsed: false, qJournalClearUsed: false,
  };
}
function quotaOf(mode, num) {
  if (mode === 'unlimited') return -2;
  if (mode === 'default') return -1;
  const n = Math.floor(Number(num));
  return Number.isFinite(n) && n >= 0 ? Math.min(9999, n) : 0;
}
async function load() {
  const j = await api('/users');
  users.value = j.users;
}
async function quickToggle(u, key, val) {
  try {
    await api('/users/' + u.id, { method: 'PUT', body: { [key]: val } });
    u[key] = val;
  } catch (e) { alert(e.message); load(); }
}
async function save() {
  dlgErr.value = '';
  const d = dlg.value;
  const b = {
    display_name: d.display_name, email: d.email, role: d.role,
    can_use_ai: !!d.can_use_ai, allowed_pages: d.allowed_pages || [],
    quota_guide: quotaOf(d.qGuideMode, d.qGuideNum),
    quota_journal: quotaOf(d.qJournalMode, d.qJournalNum),
  };
  if (d.password) b.password = d.password;
  if (d.qGuideClearUsed) b.guide_used = 0;
  if (d.qJournalClearUsed) b.journal_used = 0;
  try {
    if (d.id) await api('/users/' + d.id, { method: 'PUT', body: b });
    else {
      if (!d.username || !d.password) { dlgErr.value = '用户名和密码必填'; return; }
      await api('/users', { method: 'POST', body: { ...b, username: d.username, password: d.password } });
    }
    dlg.value = null;
    load();
  } catch (e) { dlgErr.value = e.message; }
}
async function del(u) {
  if (!confirm(`删除用户「${u.username}」？其攻略与游记（含照片文件）一并删除。`)) return;
  try {
    await api('/users/' + u.id, { method: 'DELETE' });
    load();
  } catch (e) { alert(e.message); }
}
onMounted(load);
</script>

<style scoped>
.uv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.tb th small { font-weight: 400; }
</style>
