// 分享公开读端点（EXEMPT 免登录——分享链接发给谁，谁不登录也能看）。
// 只回标题/模式/正文/时间——params、prompt、images 元数据一律不出（能力链接只授「读这一篇」）。
const express = require('express');
const { db } = require('../db');

const r = express.Router();

r.get('/:token', (req, res) => {
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(String(req.params.token || ''));
  if (!s) return res.status(404).json({ error: '分享不存在或已失效' });
  const g = db.prepare('SELECT id, title, content, status, updated_at FROM guides WHERE id=?').get(s.guide_id);
  if (!g) return res.status(404).json({ error: '分享不存在或已失效' }); // 指南被删（shares 已同步清，双保险）
  if (s.mode === 'static') {
    return res.json({ title: g.title, mode: 'static', content: s.snapshot || '', updated_at: s.updated_at });
  }
  // 动态：跟随攻略当前内容（编辑/重新生成后打开即最新）；生成中途打开=当时的半成品也如实展示
  if (g.status !== 'done' && g.status !== 'generating') {
    return res.status(404).json({ error: '原攻略已失效（可能被重新生成中），稍后再试' });
  }
  res.json({ title: g.title, mode: 'dynamic', content: g.content || '', updated_at: g.updated_at });
});

module.exports = r;
