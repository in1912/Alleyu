// v1.13.0 客服留言。
//  - 游客走 /open（EXEMPT 免登录）：首次提交服务端发 32hex key，之后凭 key 读自己的线程；
//    显示名是「游客 #XXXX」（key 末 4 位），不是数据库 id，不泄露别人的编号。
//  - 登录用户走 /（全局中间件已解析 req.user），作者名取 display_name || username。
//  - 管理员接口在本文件里逐个查 role==='admin'（pageForPath 对未知路径默认放行登录用户）。
// 留言与回复一律当**纯文本**存、纯文本显示，前端不 v-html。
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');

const r = express.Router();
const MAX_LEN = 4000;

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

function validKey(k) {
  return /^[0-9a-f]{32}$/.test(String(k || ''));
}

function guestName(key) {
  return '游客 #' + String(key).slice(-4).toUpperCase();
}

function cleanBody(raw) {
  const s = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (!s) return { error: '留言内容不能为空' };
  if (s.length > MAX_LEN) return { error: `留言最多 ${MAX_LEN} 字` };
  return { value: s };
}

function cleanReply(raw) {
  const s = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (s.length > MAX_LEN) return { error: `回复最多 ${MAX_LEN} 字` };
  return { value: s };
}

// 10 秒内同一个作者发同一句话 → 429（只防手滑连点；不影响追加不同内容）
function tooSoon(where, args, body) {
  const row = db.prepare(
    `SELECT id FROM feedback WHERE ${where} AND body=? AND created_at > datetime('now','localtime','-10 seconds') LIMIT 1`,
  ).get(...args, body);
  return !!row;
}

function threadCount(where, args) {
  return db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE ${where}`).get(...args).n;
}

function itemOut(f) {
  return {
    id: f.id, author_name: f.author_name, body: f.body, reply: f.reply,
    replied_at: f.replied_at, created_at: f.created_at,
  };
}

function adminItemOut(f) {
  return {
    ...itemOut(f),
    user_id: f.user_id,
    guest_tag: f.guest_key ? String(f.guest_key).slice(-4).toUpperCase() : '',
    replied_by: f.replied_by,
  };
}

// ---------- 游客（免登录） ----------
r.post('/open', (req, res) => {
  const b = req.body || {};
  const c = cleanBody(b.body);
  if (c.error) return res.status(400).json({ error: c.error });

  let key = b.key == null || b.key === '' ? '' : String(b.key);
  if (key && !validKey(key)) return res.status(400).json({ error: '游客凭证不合法' });
  if (!key) key = crypto.randomBytes(16).toString('hex');
  const name = guestName(key);

  if (threadCount('guest_key=?', [key]) >= 100) {
    return res.status(429).json({ error: '这个游客编号的留言条数已达上限' });
  }
  if (tooSoon('guest_key=?', [key], c.value)) {
    return res.status(429).json({ error: '刚刚已经提交过同样内容，请稍后再试' });
  }

  const info = db.prepare('INSERT INTO feedback(user_id, guest_key, author_name, body) VALUES(0,?,?,?)')
    .run(key, name, c.value);
  const row = db.prepare('SELECT * FROM feedback WHERE id=?').get(info.lastInsertRowid);
  res.json({ key, author_name: name, feedback: itemOut(row) });
});

r.get('/open', (req, res) => {
  const key = String(req.query.key || '');
  if (!validKey(key)) return res.status(400).json({ error: '游客凭证不合法' });
  const rows = db.prepare('SELECT * FROM feedback WHERE guest_key=? ORDER BY id ASC LIMIT 200').all(key);
  res.json({ author_name: guestName(key), items: rows.map(itemOut) });
});

// ---------- 登录用户 ----------
r.post('/', (req, res) => {
  const c = cleanBody((req.body || {}).body);
  if (c.error) return res.status(400).json({ error: c.error });
  const name = String(req.user.display_name || req.user.username || '用户').slice(0, 40);
  if (threadCount('user_id=?', [req.user.id]) >= 100) {
    return res.status(429).json({ error: '留言条数已达上限' });
  }
  if (tooSoon('user_id=?', [req.user.id], c.value)) {
    return res.status(429).json({ error: '刚刚已经提交过同样内容，请稍后再试' });
  }
  const info = db.prepare('INSERT INTO feedback(user_id, author_name, body) VALUES(?,?,?)')
    .run(req.user.id, name, c.value);
  const row = db.prepare('SELECT * FROM feedback WHERE id=?').get(info.lastInsertRowid);
  res.json({ author_name: name, feedback: itemOut(row) });
});

r.get('/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ items: rows.map(itemOut) });
});

// ---------- 管理员 ----------
r.get('/admin', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可查看全部留言' });
  const n = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const before = Number(req.query.before) || 0;
  const rows = before
    ? db.prepare('SELECT * FROM feedback WHERE id<? ORDER BY id DESC LIMIT ?').all(before, n)
    : db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(n);
  res.json({ items: rows.map(adminItemOut) });
});

r.put('/:id/reply', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可回复' });
  const f = db.prepare('SELECT * FROM feedback WHERE id=?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: '留言不存在' });
  const c = cleanReply((req.body || {}).reply);
  if (c.error) return res.status(400).json({ error: c.error });
  const by = String(req.user.display_name || req.user.username || '管理员').slice(0, 40);
  if (!c.value) {
    db.prepare("UPDATE feedback SET reply='', replied_at=NULL, replied_by='', updated_at=datetime('now','localtime') WHERE id=?")
      .run(f.id);
  } else {
    db.prepare("UPDATE feedback SET reply=?, replied_at=datetime('now','localtime'), replied_by=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(c.value, by, f.id);
  }
  res.json({ ok: true, feedback: itemOut(db.prepare('SELECT * FROM feedback WHERE id=?').get(f.id)) });
});

r.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可删除留言' });
  const info = db.prepare('DELETE FROM feedback WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true, deleted: info.changes > 0 });
});

module.exports = r;
