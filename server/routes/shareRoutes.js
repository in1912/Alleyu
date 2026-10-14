// 分享公开读端点（EXEMPT 免登录——分享链接发给谁，谁不登录也能看）。
// 只回标题/模式/正文/时间——params、prompt、images 元数据一律不出（能力链接只授「读这一篇」）。
// v1.6.1 加 /:token/pdf：分享页也能直接下载 PDF 文件（token 即凭证，同样免登录）。
const express = require('express');
const { db } = require('../db');
const { renderGuidePdf } = require('../services/pdfService');

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

// 分享页导出 PDF：内容口径与上面 GET /:token 完全一致（静态=快照、动态=现读），附件直下。
r.get('/:token/pdf', async (req, res) => {
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(String(req.params.token || ''));
  if (!s) return res.status(404).json({ error: '分享不存在或已失效' });
  const g = db.prepare('SELECT id, title, status FROM guides WHERE id=?').get(s.guide_id);
  if (!g) return res.status(404).json({ error: '分享不存在或已失效' });
  let content, title;
  if (s.mode === 'static') {
    content = s.snapshot || ''; title = g.title;
  } else {
    if (g.status !== 'done' && g.status !== 'generating') {
      return res.status(404).json({ error: '原攻略已失效（可能被重新生成中），稍后再试' });
    }
    content = g.content || ''; title = g.title;
  }
  try {
    const buf = await renderGuidePdf(title || '攻略', content);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((title || '攻略') + '.pdf')}`);
    res.send(buf);
  } catch (e) {
    if (e && e.code === 'NO_FONT') return res.status(400).json({ error: e.message, code: 'NO_FONT' });
    console.error('share pdf failed:', e);
    res.status(500).json({ error: 'PDF 生成失败：' + (e.message || e) });
  }
});

module.exports = r;
