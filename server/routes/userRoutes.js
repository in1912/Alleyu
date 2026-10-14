// 用户管理（仅 admin）：增删改、权限页/页签勾选、can_use_ai 开关。
// 权限语义与工作台一致：allowed_pages 空 = 全开放；非空 = 白名单；页签同理。
const express = require('express');
const { db } = require('../db');
const { hashPassword, PAGES } = require('../auth');

const r = express.Router();

r.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可管理用户' });
  next();
});

function rowOut(u) {
  return {
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    allowed_pages: JSON.parse(u.allowed_pages || '[]'), allowed_tabs: JSON.parse(u.allowed_tabs || '{}'),
    can_use_ai: !!u.can_use_ai, has_personal_ai: !!(u.ai_base_url && u.ai_model),
    created_at: u.created_at,
  };
}

r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(rowOut), pages: PAGES });
});

r.post('/', (req, res) => {
  const { username, password, display_name, role, allowed_pages, allowed_tabs, can_use_ai } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim())) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  const info = db.prepare('INSERT INTO users(username,password_hash,role,display_name,allowed_pages,allowed_tabs,can_use_ai) VALUES(?,?,?,?,?,?,?)')
    .run(String(username).trim(), hashPassword(password), role === 'admin' ? 'admin' : 'user', String(display_name || ''),
      JSON.stringify(Array.isArray(allowed_pages) ? allowed_pages : []), JSON.stringify(allowed_tabs && typeof allowed_tabs === 'object' ? allowed_tabs : '{}'),
      can_use_ai ? 1 : 0);
  res.json({ user: rowOut(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)) });
});

r.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const b = req.body || {};
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), id);
  }
  const role = b.role === 'admin' || b.role === 'user' ? b.role : u.role;
  // 不能把自己降级成 user 后失去唯一管理员
  if (u.role === 'admin' && role === 'user' && u.id === req.user.id) {
    return res.status(400).json({ error: '不能取消自己的管理员角色' });
  }
  db.prepare('UPDATE users SET role=?, display_name=?, allowed_pages=?, allowed_tabs=?, can_use_ai=? WHERE id=?')
    .run(role, b.display_name !== undefined ? String(b.display_name) : u.display_name,
      JSON.stringify(Array.isArray(b.allowed_pages) ? b.allowed_pages : JSON.parse(u.allowed_pages || '[]')),
      JSON.stringify(b.allowed_tabs && typeof b.allowed_tabs === 'object' ? b.allowed_tabs : JSON.parse(u.allowed_tabs || '{}')),
      b.can_use_ai === undefined ? (u.can_use_ai ? 1 : 0) : (b.can_use_ai ? 1 : 0), id);
  res.json({ user: rowOut(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

r.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1) {
    return res.status(400).json({ error: '至少保留一名管理员' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM guides WHERE user_id=?').run(id);
  res.json({ ok: true });
});

module.exports = r;
