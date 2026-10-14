// 登录态：login/logout/me/password。仿工作台三通道令牌（头/查询参数）。
const express = require('express');
const { db } = require('../db');
const { verifyPassword, hashPassword, createSession, destroySession } = require('../auth');

const r = express.Router();

function publicUser(u) {
  return {
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    allowed_pages: u.allowed_pages, allowed_tabs: u.allowed_tabs, can_use_ai: u.can_use_ai,
  };
}

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = createSession(u.id);
  res.json({ token, user: publicUser({ ...u, allowed_pages: JSON.parse(u.allowed_pages || '[]'), allowed_tabs: JSON.parse(u.allowed_tabs || '{}'), can_use_ai: !!u.can_use_ai }) });
});

r.post('/logout', (req, res) => {
  destroySession(req);
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

r.post('/password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(oldPassword || '', row.password_hash)) return res.status(400).json({ error: '原密码不正确' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

module.exports = r;
