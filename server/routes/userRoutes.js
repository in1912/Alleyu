// 用户管理（仅 admin）：增删改、权限页/页签勾选、can_use_ai 开关、生成配额与用量。
// v1.10.0：可分配的页只剩 guides/weather（library 与 settings 是管理员专属，见 auth.js canAccess）；
//          新增 email 与 quota_*/guide_used/journal_used/tokens_*，列表直接展示次数与累计 token。
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db } = require('../db');
const { hashPassword, PAGES } = require('../auth');
const { quotaState } = require('../quota');
const community = require('../services/communityService');

const r = express.Router();

const PHOTO_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'journal_photos');

r.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可管理用户' });
  next();
});

// 配额合法值：-2=不限 / -1=跟随系统默认 / 0..9999=指定总额。其它一律拒（防 -5 这类脏值被当「不限」）
function quotaVal(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) return { bad: true };
  if (n === -2 || n === -1) return { val: n };
  if (n >= 0 && n <= 9999) return { val: n };
  return { bad: true };
}

function rowOut(u) {
  return {
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    email: u.email || '',
    allowed_pages: JSON.parse(u.allowed_pages || '[]'), allowed_tabs: JSON.parse(u.allowed_tabs || '{}'),
    can_use_ai: !!u.can_use_ai,
    quota_guide: Number(u.quota_guide), quota_journal: Number(u.quota_journal),
    guide_used: Number(u.guide_used) || 0, journal_used: Number(u.journal_used) || 0,
    // 现算的剩余（管理员恒不限）——前端表格直接显示，不用自己算
    quota: { guide: quotaState({ ...u, role: u.role }, 'guide'), journal: quotaState({ ...u, role: u.role }, 'journal') },
    tokens_in: Number(u.tokens_in) || 0, tokens_out: Number(u.tokens_out) || 0,
    tokens_total: (Number(u.tokens_in) || 0) + (Number(u.tokens_out) || 0),
    created_at: u.created_at,
  };
}

r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(rowOut), pages: PAGES });
});

r.post('/', (req, res) => {
  const { username, password, display_name, email, role, allowed_pages, allowed_tabs, can_use_ai } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim())) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  const gq = quotaVal(req.body && req.body.quota_guide !== undefined ? req.body.quota_guide : -1);
  const jq = quotaVal(req.body && req.body.quota_journal !== undefined ? req.body.quota_journal : -1);
  if (gq.bad || jq.bad) return res.status(400).json({ error: '生成次数只能是 -2（不限）、-1（跟随默认）或 0~9999' });
  const mail = String(email || '').trim();
  if (mail && db.prepare("SELECT id FROM users WHERE lower(email)=lower(?) AND email<>''").get(mail)) {
    return res.status(400).json({ error: '该邮箱已被注册' });
  }
  const info = db.prepare('INSERT INTO users(username,password_hash,role,display_name,email,allowed_pages,allowed_tabs,can_use_ai,quota_guide,quota_journal) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(String(username).trim(), hashPassword(password), role === 'admin' ? 'admin' : 'user', String(display_name || ''), mail,
      JSON.stringify(Array.isArray(allowed_pages) ? allowed_pages : []), JSON.stringify(allowed_tabs && typeof allowed_tabs === 'object' ? allowed_tabs : '{}'),
      can_use_ai ? 1 : 0, gq.val, jq.val);
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
  // 可选字段就地合并
  let gq = Number(u.quota_guide), jq = Number(u.quota_journal);
  if (b.quota_guide !== undefined) { const t = quotaVal(b.quota_guide); if (t.bad) return res.status(400).json({ error: '攻略次数只能是 -2（不限）、-1（跟随默认）或 0~9999' }); gq = t.val; }
  if (b.quota_journal !== undefined) { const t = quotaVal(b.quota_journal); if (t.bad) return res.status(400).json({ error: '游记次数只能是 -2（不限）、-1（跟随默认）或 0~9999' }); jq = t.val; }
  // 已用次数：只在显式传时改（管理员的「清零」按钮）
  const gUsed = b.guide_used === undefined ? (Number(u.guide_used) || 0) : Math.max(0, Math.floor(Number(b.guide_used) || 0));
  const jUsed = b.journal_used === undefined ? (Number(u.journal_used) || 0) : Math.max(0, Math.floor(Number(b.journal_used) || 0));
  const mail = b.email === undefined ? (u.email || '') : String(b.email).trim();
  if (mail && db.prepare("SELECT id FROM users WHERE lower(email)=lower(?) AND email<>'' AND id<>?").get(mail, id)) {
    return res.status(400).json({ error: '该邮箱已被其他用户使用' });
  }
  db.prepare('UPDATE users SET role=?, display_name=?, email=?, allowed_pages=?, allowed_tabs=?, can_use_ai=?, quota_guide=?, quota_journal=?, guide_used=?, journal_used=? WHERE id=?')
    .run(role, b.display_name !== undefined ? String(b.display_name) : u.display_name, mail,
      JSON.stringify(Array.isArray(b.allowed_pages) ? b.allowed_pages : JSON.parse(u.allowed_pages || '[]')),
      JSON.stringify(b.allowed_tabs && typeof b.allowed_tabs === 'object' ? b.allowed_tabs : JSON.parse(u.allowed_tabs || '{}')),
      b.can_use_ai === undefined ? (u.can_use_ai ? 1 : 0) : (b.can_use_ai ? 1 : 0),
      gq, jq, gUsed, jUsed, id);
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
  // v1.13.0：社区分享、客服留言随用户一起删（先撤社区，再删照片目录）
  try { community.removePostsByUser(id); } catch { /* 尽力 */ }
  db.prepare('DELETE FROM feedback WHERE user_id=?').run(id);
  // 游记（v1.8.0）此前没跟着删：行留着、data/journal_photos/<id>/ 的照片也留在盘上 —— 一并清掉
  for (const j of db.prepare('SELECT id FROM journals WHERE user_id=?').all(id)) {
    db.prepare('DELETE FROM journal_photos WHERE journal_id=?').run(j.id);
    try { fs.rmSync(path.join(PHOTO_DIR, String(j.id)), { recursive: true, force: true }); } catch { /* 目录不存在也无所谓 */ }
  }
  db.prepare('DELETE FROM journals WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM guides WHERE user_id=?').run(id);
  res.json({ ok: true });
});

module.exports = r;
