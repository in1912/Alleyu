// v1.13.0 社区：把攻略/游记发布成公开快照。这是**唯一碰 db 的一层**。
//
// 设计要点：
//  - 发布那一刻做快照：正文归一化成公开 HTML、游记照片冻结成 {sort,filename,width,height}。
//    之后原作者改攻略/游记不会改动社区内容；重复发布=更新快照，但 published_at 不刷新。
//  - 照片文件不复制（只有封面复制到 data/community/<post_id>/cover.<ext>）：
//    公开照片路由只认快照里的文件名，原游记里单删某张后该图会自动退化成「图片已删除」。
//  - 原攻略/游记被删除时由路由调用 removePostsBySource() 级联撤下。
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db');
const { cleanGuideMd, extractGuideCover, renderCommunityHtml, journalToMarkdown } = require('./communityHtml');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'journal_photos');
const COMMUNITY_DIR = path.join(DATA_DIR, 'community');
const MAX_CONTENT_BYTES = 1024 * 1024; // 快照正文上限 1 MB
const KIND = ['guide', 'journal'];
const COVER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

class PublicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function plainTitle(t, fallback) {
  const s = String(t || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || String(fallback || '旅行记录')).slice(0, 120);
}

function authorOf(user) {
  return String((user && (user.display_name || user.username)) || '旅行者').slice(0, 40);
}

function coverUrlOf(row) {
  if (row.cover_file) return '/api/community/feed/' + row.id + '/cover';
  return row.cover_url || '';
}

function postSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    author_name: row.author_name,
    cover_url: coverUrlOf(row),
    published_at: row.published_at,
  };
}

function readPhotos(journalId) {
  const rows = db.prepare(
    'SELECT id, filename, sort, width, height FROM journal_photos WHERE journal_id=? ORDER BY sort, id',
  ).all(journalId);
  const dir = path.join(PHOTO_DIR, String(journalId));
  return rows.filter((p) => {
    try { return fs.existsSync(path.join(dir, path.basename(p.filename))); } catch { return false; }
  });
}

function snapshotPhotos(rows) {
  return rows.map((p) => ({
    sort: Number(p.sort) || 0,
    filename: path.basename(String(p.filename || '')),
    width: Number(p.width) || 0,
    height: Number(p.height) || 0,
  }));
}

function removeCoverDir(postId) {
  try { fs.rmSync(path.join(COMMUNITY_DIR, String(postId)), { recursive: true, force: true }); } catch { /* 尽力 */ }
}

function writeCover(postId, srcFile) {
  const dir = path.join(COMMUNITY_DIR, String(postId));
  removeCoverDir(postId);
  if (!srcFile) return '';
  const ext = path.extname(String(srcFile)).toLowerCase();
  if (!COVER_EXT.has(ext)) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(srcFile, path.join(dir, 'cover' + ext));
    return 'cover' + ext;
  } catch {
    return '';
  }
}

function upsertPost(user, kind, sourceId, title, coverUrl, photos, contentHtml) {
  const existing = db.prepare('SELECT id FROM community_posts WHERE kind=? AND source_id=?')
    .get(kind, sourceId);
  if (existing) {
    db.prepare(`UPDATE community_posts
      SET user_id=?, title=?, author_name=?, cover_url=?, content_html=?, photos_json=?,
          updated_at=datetime('now','localtime')
      WHERE id=?`)
      .run(user.id, title, authorOf(user), coverUrl || '', contentHtml, JSON.stringify(photos), existing.id);
    return { id: existing.id, created: false };
  }
  const info = db.prepare(`INSERT INTO community_posts
    (user_id, kind, source_id, title, author_name, cover_url, content_html, photos_json)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(user.id, kind, sourceId, title, authorOf(user), coverUrl || '', contentHtml, JSON.stringify(photos));
  return { id: Number(info.lastInsertRowid), created: true };
}

function publishFromGuide(user, guideId) {
  const g = db.prepare('SELECT * FROM guides WHERE id=? AND user_id=?').get(Number(guideId), user.id);
  if (!g) throw new PublicError(404, '攻略不存在');
  if (g.status !== 'done') throw new PublicError(409, '攻略还没生成完，暂时不能发布');
  const content = String(g.content || '');
  if (!content.trim()) throw new PublicError(409, '攻略正文是空的');

  const md = cleanGuideMd(content);
  const html = renderCommunityHtml(md);
  if (Buffer.byteLength(html, 'utf8') > MAX_CONTENT_BYTES) {
    throw new PublicError(400, '正文太长（超过 1 MB），不能发布到社区');
  }
  const title = plainTitle(g.title, String(g.destination || '') + ' ' + (Number(g.days) || 3) + ' 日攻略');
  const cover = extractGuideCover(g.images_json, md);
  const r = upsertPost(user, 'guide', g.id, title, cover, [], html);
  // 攻略帖一定是 URL 封面；清掉可能残留的本地封面文件
  if (!r.created) {
    const row = db.prepare('SELECT cover_file FROM community_posts WHERE id=?').get(r.id);
    if (row && row.cover_file) {
      removeCoverDir(r.id);
      db.prepare("UPDATE community_posts SET cover_file='' WHERE id=?").run(r.id);
    }
  }
  return { postId: r.id, created: r.created };
}

function publishFromJournal(user, journalId) {
  const j = db.prepare('SELECT * FROM journals WHERE id=? AND user_id=?').get(Number(journalId), user.id);
  if (!j) throw new PublicError(404, '游记不存在');
  if (j.status !== 'done') throw new PublicError(409, '游记还没生成完，暂时不能发布');
  const content = String(j.content || '');
  if (!content.trim()) throw new PublicError(409, '游记正文是空的');

  const html = renderCommunityHtml(journalToMarkdown(content));
  if (Buffer.byteLength(html, 'utf8') > MAX_CONTENT_BYTES) {
    throw new PublicError(400, '正文太长（超过 1 MB），不能发布到社区');
  }
  const photos = readPhotos(j.id);
  const title = plainTitle(j.title, j.destination || '旅行游记');
  const r = upsertPost(user, 'journal', j.id, title, '', snapshotPhotos(photos), html);

  // 封面：手选的 cover_photo_id，否则第一张；复制到社区目录（原图后续被删也不影响卡片）
  const coverRow = photos.find((p) => Number(p.id) === Number(j.cover_photo_id)) || photos[0] || null;
  const coverFile = coverRow
    ? writeCover(r.id, path.join(PHOTO_DIR, String(j.id), path.basename(String(coverRow.filename))))
    : (removeCoverDir(r.id), '');
  db.prepare('UPDATE community_posts SET cover_file=? WHERE id=?').run(coverFile, r.id);
  return { postId: r.id, created: r.created };
}

function removeCommunityPost(postId) {
  const row = db.prepare('SELECT id FROM community_posts WHERE id=?').get(Number(postId));
  if (!row) return false;
  db.prepare('DELETE FROM community_posts WHERE id=?').run(row.id);
  removeCoverDir(row.id);
  return true;
}

function removePostsBySource(kind, sourceId) {
  const rows = db.prepare('SELECT id FROM community_posts WHERE kind=? AND source_id=?').all(kind, Number(sourceId));
  for (const r of rows) removeCommunityPost(r.id);
  return rows.length;
}

function removePostsByUser(userId) {
  const rows = db.prepare('SELECT id FROM community_posts WHERE user_id=?').all(Number(userId));
  for (const r of rows) removeCommunityPost(r.id);
  return rows.length;
}

function getPost(postId) {
  return db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(postId)) || null;
}

function listFeed(limit, before) {
  const n = Math.max(1, Math.min(100, Number(limit) || 60));
  const rows = before
    ? db.prepare('SELECT * FROM community_posts WHERE id<? ORDER BY id DESC LIMIT ?').all(Number(before), n)
    : db.prepare('SELECT * FROM community_posts ORDER BY id DESC LIMIT ?').all(n);
  return rows.map(postSummary);
}

function postDetail(row) {
  if (!row) return null;
  let photos = [];
  try {
    const v = JSON.parse(row.photos_json || '[]');
    if (Array.isArray(v)) photos = v;
  } catch { /* 坏 JSON 就当没有 */ }
  const srcDir = path.join(PHOTO_DIR, String(row.source_id));
  photos = photos.filter((p) => {
    try { return fs.existsSync(path.join(srcDir, path.basename(String(p.filename || '')))); } catch { return false; }
  }).map((p) => ({ sort: Number(p.sort) || 0, width: Number(p.width) || 0, height: Number(p.height) || 0 }));
  return {
    ...postSummary(row),
    content_html: row.content_html || '',
    photos,
  };
}

function publicPhoto(row, sort) {
  if (!row) return null;
  let photos = [];
  try {
    const v = JSON.parse(row.photos_json || '[]');
    if (Array.isArray(v)) photos = v;
  } catch { return null; }
  const p = photos.find((x) => Number(x.sort) === Number(sort));
  if (!p) return null;
  const name = path.basename(String(p.filename || ''));
  if (!name) return null;
  const file = path.join(PHOTO_DIR, String(row.source_id), name);
  try {
    if (!fs.existsSync(file)) return null;
  } catch { return null; }
  return file;
}

module.exports = {
  PublicError,
  KIND,
  postSummary,
  postDetail,
  listFeed,
  getPost,
  publishFromGuide,
  publishFromJournal,
  removeCommunityPost,
  removePostsBySource,
  removePostsByUser,
  publicPhoto,
  coverUrlOf,
  COMMUNITY_DIR,
};
