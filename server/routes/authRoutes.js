// 登录态：login/logout/me/password + v1.10.0 自助注册/申请开通探针/账号自助（profile）。
// 注意：/register 与 /register-open 在 server/index.js 的 EXEMPT 里（免登录），
// 那两个 handler 里 **req.user 一定是 undefined**，不能引用。
const express = require('express');
const { db, getSetting } = require('../db');
const { verifyPassword, hashPassword, createSession, destroySession } = require('../auth');
const { quotaState } = require('../quota');

const r = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 用户名：字母数字下划线（3~20）。不用中文，避免与邀请码/邮箱混在一起时难看错。
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// 只有全新注册的用户默认带哪些页：攻略（含游记）+ 天气。城市景点库/设置/用户管理是管理员页。
const DEFAULT_PAGES = ['guides', 'weather'];

function publicUser(u) {
  return {
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    email: u.email || '',
    allowed_pages: u.allowed_pages, allowed_tabs: u.allowed_tabs, can_use_ai: u.can_use_ai,
    // 配额快照（生成页显示「剩余 X 次」用；管理员恒不限）
    quota: { guide: quotaState(u, 'guide'), journal: quotaState(u, 'journal') },
    tokens: { in: Number(u.tokens_in) || 0, out: Number(u.tokens_out) || 0 },
    created_at: u.created_at || '',
  };
}

// 库里还有没有能用的邀请码（enabled 且没被用光）
function hasOpenInvite() {
  return db.prepare('SELECT COUNT(*) c FROM invite_codes WHERE enabled=1 AND used_count < max_uses').get().c > 0;
}

function normUser(row) {
  return { ...row, allowed_pages: JSON.parse(row.allowed_pages || '[]'), allowed_tabs: JSON.parse(row.allowed_tabs || '{}'), can_use_ai: !!row.can_use_ai };
}

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = createSession(u.id);
  res.json({ token, user: publicUser(normUser(u)) });
});

// 注册页用：库里没有可用邀请码时，页面直接显示「请联系管理员获取邀请码」，别让用户白填一遍
r.get('/register-open', (req, res) => {
  res.json({ open: hasOpenInvite() });
});

r.post('/register', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const email = String(b.email || '').trim();
  const nickname = String(b.display_name || b.nickname || '').trim();
  const code = String(b.invite_code || b.invite || '').trim().toUpperCase();

  // 先判「有没有可用的码」，再逐项校验 —— 这样关掉注册时给出的是最能行动的那句话
  if (!hasOpenInvite()) return res.status(400).json({ error: '当前未开放注册，请联系管理员获取邀请码' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: '用户名 3~20 位，只能用字母、数字、下划线' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不对' });
  if (!nickname || nickname.length > 20) return res.status(400).json({ error: '请填写昵称（20 字以内）' });
  if (!code) return res.status(400).json({ error: '请填写邀请码' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return res.status(400).json({ error: '用户名已存在' });
  if (db.prepare('SELECT id FROM users WHERE lower(email)=lower(?) AND email<>\'\'').get(email)) return res.status(400).json({ error: '该邮箱已被注册' });

  const invite = db.prepare('SELECT * FROM invite_codes WHERE UPPER(code)=? AND enabled=1').get(code);
  if (!invite) return res.status(400).json({ error: '邀请码无效或已停用' });

  // 事务：占码 + 建号，任一步失败都不留半截（码不会被白扣）
  db.exec('BEGIN');
  try {
    const used = db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE id=? AND enabled=1 AND used_count < max_uses').run(invite.id);
    if (used.changes !== 1) { db.exec('ROLLBACK'); return res.status(400).json({ error: '该邀请码已被用完' }); }
    const info = db.prepare(
      `INSERT INTO users(username,password_hash,role,display_name,email,allowed_pages,allowed_tabs,can_use_ai)
       VALUES(?,?,'user',?,?,?,'{}',1)`
    ).run(username, hashPassword(password), nickname, email, JSON.stringify(DEFAULT_PAGES));
    db.exec('COMMIT');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    const token = createSession(u.id);
    res.json({ token, user: publicUser(normUser(u)) });   // 注册即登录
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    res.status(500).json({ error: '注册失败：' + (e && e.message ? e.message : '未知错误') });
  }
});

r.post('/logout', (req, res) => {
  destroySession(req);
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  // share_base（v1.10.2）：管理员配的「公开访问地址」，前端拼分享链接用；
  // 放在这里是因为分享链接所有登录用户都会生成，而 /api/settings 只有管理员能读。
  res.json({ user: req.user ? publicUser(req.user) : null, share_base: String(getSetting('public_base_url') || '') });
});

r.post('/password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(oldPassword || '', row.password_hash)) return res.status(400).json({ error: '原密码不正确' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

// 账号自助（v1.10.0）：普通用户改自己的昵称与密码。用户名是登录凭据，这里**不允许改**（用户定调）。
// 改密码必须验原密码；只改昵称可以不填原密码。
r.post('/profile', (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!row) return res.status(401).json({ error: '账号不存在' });

  const patch = {};
  if (b.display_name !== undefined) {
    const nick = String(b.display_name).trim();
    if (!nick || nick.length > 20) return res.status(400).json({ error: '昵称要 1~20 个字' });
    patch.display_name = nick;
  }
  if (b.newPassword !== undefined && String(b.newPassword) !== '') {
    if (String(b.newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    if (!verifyPassword(b.oldPassword || '', row.password_hash)) return res.status(400).json({ error: '原密码不正确' });
    patch.password_hash = hashPassword(b.newPassword);
  }
  const keys = Object.keys(patch);
  if (!keys.length) return res.status(400).json({ error: '没有要修改的内容' });
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => patch[k]), row.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
  res.json({ ok: true, user: publicUser(normUser(u)) });
});

module.exports = r;
