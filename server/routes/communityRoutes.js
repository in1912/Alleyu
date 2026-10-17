// v1.13.0 社区路由。
// 公开只读在 /feed（EXEMPT 免登录，见 index.js）；发布/撤下需要登录，且每个写接口自己校验归属。
// 公开响应只给展示需要的字段：绝不回 user_id / source_id / prompt。
const express = require('express');
const path = require('node:path');
const { db } = require('../db');
const svc = require('../services/communityService');

const r = express.Router();

// ---------- 公开只读（游客可访问） ----------
r.get('/feed', (req, res) => {
  const posts = svc.listFeed(req.query.limit, req.query.before || 0);
  res.set('Cache-Control', 'no-cache'); // 撤下要立刻生效，别让中间层缓存列表
  res.json({ posts });
});

r.get('/feed/:id', (req, res) => {
  const post = svc.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: '分享不存在或已撤下' });
  res.json({ post: svc.postDetail(post) });
});

r.get('/feed/:id/cover', (req, res) => {
  const post = svc.getPost(req.params.id);
  if (!post || !post.cover_file) return res.status(404).json({ error: '没有封面' });
  const file = path.join(svc.COMMUNITY_DIR, String(post.id), path.basename(post.cover_file));
  res.set('Cache-Control', 'public, max-age=86400'); // 文件名固定 + 内容随重发布变化 → 用 1 天，够用
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '没有封面' });
  });
});

r.get('/feed/:id/photos/:sort/file', (req, res) => {
  const post = svc.getPost(req.params.id);
  const file = svc.publicPhoto(post, req.params.sort);
  if (!file) return res.status(404).json({ error: '图片不存在' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// ---------- 登录后 ----------
function sourceOwned(user, kind, sourceId) {
  if (kind === 'guide') {
    return !!db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(sourceId, user.id);
  }
  if (kind === 'journal') {
    return !!db.prepare('SELECT id FROM journals WHERE id=? AND user_id=?').get(sourceId, user.id);
  }
  return false;
}

// 该来源是否已分享（作者本人用；别人一律 404，不泄露「这条 id 存不存在」）
r.get('/by-source', (req, res) => {
  const kind = String(req.query.kind || '');
  const sourceId = Number(req.query.source_id);
  if (!svc.KIND.includes(kind) || !sourceId) return res.status(400).json({ error: '参数不合法' });
  if (!sourceOwned(req.user, kind, sourceId)) return res.status(404).json({ error: '内容不存在' });
  const post = db.prepare('SELECT * FROM community_posts WHERE kind=? AND source_id=?').get(kind, sourceId);
  res.json({ shared: !!post, post: post ? svc.postSummary(post) : null });
});

r.post('/publish', (req, res) => {
  const kind = String((req.body || {}).kind || '');
  const sourceId = Number((req.body || {}).source_id);
  if (!svc.KIND.includes(kind) || !sourceId) return res.status(400).json({ error: '参数不合法' });
  try {
    const out = kind === 'guide'
      ? svc.publishFromGuide(req.user, sourceId)
      : svc.publishFromJournal(req.user, sourceId);
    res.json({ post: { id: out.postId, kind }, created: out.created });
  } catch (e) {
    if (e instanceof svc.PublicError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

r.get('/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM community_posts WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  res.json({ posts: rows.map((p) => ({ ...svc.postSummary(p), updated_at: p.updated_at })) });
});

r.delete('/posts/:id', (req, res) => {
  const post = svc.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: '分享不存在' });
  if (post.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能撤下自己发布的分享' });
  }
  svc.removeCommunityPost(post.id);
  res.json({ ok: true });
});

module.exports = r;
