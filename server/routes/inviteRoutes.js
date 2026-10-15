// 邀请码管理（v1.10.0）：只有管理员能看/能改。注册侧用码的原子占用在 authRoutes 的 /register 里。
// 双保险：全局中间件已按 pageForPath('/invites') → 'settings' 页拦住非管理员；这里再拦一次。
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');

const r = express.Router();
r.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '邀请码管理仅管理员' });
  next();
});

// 字母表去掉容易看错的 0/O/1/I/l：邀请码是要手抄给别人的
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len = 8) {
  const buf = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

const rowOut = (x) => ({
  id: x.id,
  code: x.code,
  max_uses: x.max_uses,
  used_count: x.used_count,
  note: x.note,
  enabled: !!x.enabled,
  created_at: x.created_at,
});

// 列表：用过的排后面一点看，默认按 id 倒序（最新生成的在前）
r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM invite_codes ORDER BY id DESC').all().map(rowOut);
  res.json({ invites: rows });
});

// 生成：count 个码，每个可用 max_uses 次（1 = 一次性），带备注
r.post('/', (req, res) => {
  const b = req.body || {};
  const count = Math.min(50, Math.max(1, Number(b.count) || 1));
  const maxUses = Number(b.max_uses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 9999) {
    return res.status(400).json({ error: '使用次数要是 1~9999 的整数（1 = 一次性）' });
  }
  const note = String(b.note || '').slice(0, 100);
  const ins = db.prepare('INSERT INTO invite_codes(code,max_uses,used_count,note,enabled,created_by) VALUES(?,?,0,?,1,?)');
  const made = [];
  for (let i = 0; i < count; i++) {
    let ok = false;
    for (let t = 0; t < 6 && !ok; t++) {           // 撞 UNIQUE 就重抽（8 位 31 字母表，实战不会撞）
      const code = makeCode(8);
      try { ins.run(code, maxUses, note, req.user.id); made.push(code); ok = true; } catch { /* 重试 */ }
    }
    if (!ok) return res.status(500).json({ error: '邀请码生成失败（连续重码），请重试' });
  }
  const rows = db.prepare(`SELECT * FROM invite_codes WHERE code IN (${made.map(() => '?').join(',')}) ORDER BY id DESC`).all(...made).map(rowOut);
  res.json({ ok: true, codes: made, invites: rows });
});

// 改：停用/启用、备注、使用次数（不能小于已用次数，否则与已发出的码语义矛盾）
r.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM invite_codes WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '邀请码不存在' });
  const b = req.body || {};
  const next = {
    enabled: b.enabled === undefined ? row.enabled : (b.enabled ? 1 : 0),
    note: b.note === undefined ? row.note : String(b.note).slice(0, 100),
    max_uses: row.max_uses,
  };
  if (b.max_uses !== undefined) {
    const n = Number(b.max_uses);
    if (!Number.isInteger(n) || n < 1 || n > 9999) return res.status(400).json({ error: '使用次数要是 1~9999 的整数' });
    if (n < row.used_count) return res.status(400).json({ error: `已被使用 ${row.used_count} 次，使用次数不能小于这个数` });
    next.max_uses = n;
  }
  db.prepare('UPDATE invite_codes SET enabled=?, note=?, max_uses=? WHERE id=?')
    .run(next.enabled, next.note, next.max_uses, id);
  res.json({ ok: true, invite: rowOut(db.prepare('SELECT * FROM invite_codes WHERE id=?').get(id)) });
});

// 删：已用过的码建议只停用（保留「谁邀请了谁」的线索），所以要显式说明能删
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM invite_codes WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '邀请码不存在' });
  db.prepare('DELETE FROM invite_codes WHERE id=?').run(id);
  res.json({ ok: true });
});

module.exports = r;
