// v1.8.0 游记整理路由。游记按 user_id 严格隔离（admin 也读不到他人的，与攻略同规矩）。
//  - 草稿/编辑：登录即可（问答式录入本来就是本人的游记）
//  - 生成正文/配文/标题：另需 can_use_ai（与攻略生成同一道闸，admin 恒可用）
//  - 图片：base64 JSON 上传（route 级 40mb 解析器），文件落 data/journal_photos/<journal_id>/
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db');
const js = require('../services/journalService');
const { checkQuota } = require('../quota');

const r = express.Router();
const PHOTO_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'journal_photos');
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8MB/张（base64 后 ~10.7MB，route 解析器 40mb 上限够）

function myJournal(req, id) {
  return db.prepare('SELECT * FROM journals WHERE id=? AND user_id=?').get(Number(id), req.user.id);
}
function photoOf(journalId, pid) {
  return db.prepare('SELECT * FROM journal_photos WHERE id=? AND journal_id=?').get(Number(pid), journalId);
}
function rowJson(j) {
  if (!j) return null;
  const photos = db.prepare('SELECT id, spot, caption, caption_by, sort, created_at FROM journal_photos WHERE journal_id=? ORDER BY sort, id').all(j.id);
  // v1.9.0 三套文本：原版/手动版正文不回传给前端（长度可能几十 KB），只给「有没有 + 多少字」，
  // 要恢复走 /content/restore，恢复后的正文由那个接口回。route 是路线图缓存（可能为 null）。
  const out = { ...j, meta: JSON.parse(j.meta_json || '{}'), spots: JSON.parse(j.spots_json || '[]'), photos };
  out.has_original = !!(j.content_original || '').trim();
  out.has_manual = !!(j.content_manual || '').trim();
  out.original_len = (j.content_original || '').length;
  out.manual_len = (j.content_manual || '').length;
  try { out.route = j.route_json ? JSON.parse(j.route_json) : null; } catch { out.route = null; }
  delete out.content_original;
  delete out.content_manual;
  return out;
}
function touch(id) {
  db.prepare("UPDATE journals SET updated_at=datetime('now','localtime') WHERE id=?").run(id);
}
function needAi(req, res) {
  if (req.user.role !== 'admin' && !req.user.can_use_ai) {
    res.status(403).json({ error: '没有 AI 使用权限（找管理员开通 can_use_ai）' });
    return false;
  }
  return true;
}

// ---- 列表 / 详情 ----
r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM journals WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  res.json({
    journals: rows.map((x) => {
      const y = { ...x, meta: JSON.parse(x.meta_json || '{}'), spots: JSON.parse(x.spots_json || '[]') };
      delete y.content_original; // 列表页用不到两套备份正文（详情接口也只给长度不给全文）
      delete y.content_manual;
      return y;
    }),
  });
});

r.post('/', (req, res) => {
  const b = req.body || {};
  const info = db.prepare("INSERT INTO journals(user_id, city_id, destination, meta_json, spots_json) VALUES(?,?,?,?,?)")
    .run(req.user.id, b.city_id ? Number(b.city_id) : null, String(b.destination || '').slice(0, 50),
      JSON.stringify(sanitizeMeta(b.meta)), JSON.stringify(sanitizeSpots(b.spots)));
  res.json({ journal: rowJson(db.prepare('SELECT * FROM journals WHERE id=?').get(info.lastInsertRowid)) });
});

r.get('/:id', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  res.json({ journal: rowJson(j) });
});

// 问答各步保存（草稿自动落库）+ 二次编辑正文
r.put('/:id', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  if (j.status === 'pending') return res.status(409).json({ error: '生成中，稍后再改' });
  const b = req.body || {};
  const meta = b.meta !== undefined ? sanitizeMeta(b.meta) : JSON.parse(j.meta_json || '{}');
  const spots = b.spots !== undefined ? sanitizeSpots(b.spots) : JSON.parse(j.spots_json || '[]');
  const doneGuard = j.status === 'done' && b.content !== undefined && !String(b.content).trim() ? j.content : (b.content !== undefined ? String(b.content).slice(0, 200000) : j.content);
  db.prepare(`UPDATE journals SET city_id=?, destination=?, meta_json=?, spots_json=?, content=?, title=?, palette=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(b.city_id !== undefined ? (b.city_id ? Number(b.city_id) : null) : j.city_id,
      b.destination !== undefined ? String(b.destination).slice(0, 50) : j.destination,
      JSON.stringify(meta), JSON.stringify(spots), doneGuard,
      b.title !== undefined ? String(b.title).slice(0, 40) : j.title,
      b.palette !== undefined ? Math.min(5, Math.max(1, Number(b.palette) || 1)) : j.palette,
      j.id);
  res.json({ journal: rowJson(myJournal(req, j.id)) });
});

r.delete('/:id', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const dir = path.join(PHOTO_DIR, String(j.id));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  db.prepare('DELETE FROM journal_photos WHERE journal_id=?').run(j.id);
  db.prepare('DELETE FROM journals WHERE id=?').run(j.id);
  res.json({ ok: true });
});

// ---- 照片：上传（base64）/ 读文件 / 配文 / 删除 / 排序 ----
// 上传走 route 级解析器：主 json 上限 2mb 装不下照片
const photoJson = express.json({ limit: '40mb' });
r.post('/:id/photos', photoJson, (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const { data_url, spot } = req.body || {};
  const m = /^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/.exec(String(data_url || ''));
  if (!m) return res.status(400).json({ error: '只支持 PNG/JPEG/WEBP 图片（dataURL）' });
  const ext = m[1] === 'image/png' ? 'png' : (m[1] === 'image/webp' ? 'webp' : 'jpg');
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return res.status(400).json({ error: '图片数据为空' });
  if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: `图片太大（${(buf.length / 1048576).toFixed(1)}MB > 8MB 上限）` });
  if (ext === 'png' && !(buf[0] === 0x89 && buf[1] === 0x50)) return res.status(400).json({ error: '不是有效的 PNG 数据' });
  if (ext === 'jpg' && !(buf[0] === 0xff && buf[1] === 0xd8)) return res.status(400).json({ error: '不是有效的 JPEG 数据' });
  const dir = path.join(PHOTO_DIR, String(j.id));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  const nextSort = (db.prepare('SELECT MAX(sort) s FROM journal_photos WHERE journal_id=?').get(j.id).s || 0) + 1;
  const info = db.prepare('INSERT INTO journal_photos(journal_id, spot, filename, sort) VALUES(?,?,?,?)')
    .run(j.id, String(spot || '').slice(0, 50), filename, nextSort);
  touch(j.id);
  res.json({ photo: { id: info.lastInsertRowid, spot: String(spot || ''), caption: '', caption_by: '', sort: nextSort } });
});

// 图片本体：<img> 直链（query token 鉴权，走主中间件即可，不进 EXEMPT）
r.get('/:id/photos/:pid/file', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const p = photoOf(j.id, req.params.pid);
  if (!p) return res.status(404).json({ error: '照片不存在' });
  const file = path.join(PHOTO_DIR, String(j.id), p.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '照片文件缺失' });
  const type = p.filename.endsWith('.png') ? 'image/png' : (p.filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(file).pipe(res);
});

// 照片整体排序（v1.9.0：向导里拖图/拖景点/上下按钮都调它）。sort 即正文里的 photo:N 编号，
// 所以重排是「按新顺序重编 1..N」——必须恰好不重不漏地包含本篇全部照片，防前端漏传。
r.put('/:id/photos/order', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const raw = (req.body || {}).ids;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'ids 必须是数组' });
  const ids = raw.map(Number).filter(Number.isFinite);
  const mine = db.prepare('SELECT id FROM journal_photos WHERE journal_id=?').all(j.id).map((x) => x.id);
  if (ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((x) => !mine.includes(x))) {
    return res.status(400).json({ error: '排序列表必须恰好包含本篇全部照片 id（不重不漏）' });
  }
  const upd = db.prepare('UPDATE journal_photos SET sort=? WHERE id=?');
  ids.forEach((pid, i) => upd.run(i + 1, pid));
  touch(j.id);
  res.json({ ok: true, photos: db.prepare('SELECT id, spot, caption, caption_by, sort FROM journal_photos WHERE journal_id=? ORDER BY sort, id').all(j.id) });
});

// 手写/保存配文
r.put('/:id/photos/:pid', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const p = photoOf(j.id, req.params.pid);
  if (!p) return res.status(404).json({ error: '照片不存在' });
  const caption = String((req.body || {}).caption ?? p.caption).slice(0, 2000);
  db.prepare("UPDATE journal_photos SET caption=?, caption_by='' WHERE id=?").run(caption, p.id);
  touch(j.id);
  res.json({ photo: { ...p, caption, caption_by: '' } });
});

r.delete('/:id/photos/:pid', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const p = photoOf(j.id, req.params.pid);
  if (!p) return res.status(404).json({ error: '照片不存在' });
  try { fs.rmSync(path.join(PHOTO_DIR, String(j.id), p.filename), { force: true }); } catch { /* 尽力 */ }
  db.prepare('DELETE FROM journal_photos WHERE id=?').run(p.id);
  if (j.cover_photo_id === p.id) db.prepare('UPDATE journals SET cover_photo_id=NULL WHERE id=?').run(j.id);
  touch(j.id);
  res.json({ ok: true });
});

// AI 配文：short=30 字润色 / user=参考用户草稿重写（重写=再调一次，天然支持）
r.post('/:id/photos/:pid/caption-ai', async (req, res) => {
  if (!needAi(req, res)) return;
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const p = photoOf(j.id, req.params.pid);
  if (!p) return res.status(404).json({ error: '照片不存在' });
  const userText = String((req.body || {}).user_text || '').slice(0, 1000);
  try {
    let text = '';
    const cfg = require('../services/aiService').resolveConfig();
    if (!cfg || cfg.source === 'stub') text = js.stubCaption(p.spot, userText);
    else {
      // 配文不扣生成次数，但要计 token（v1.10.0 用户点名：累计用量含这些小调用）
      text = await js.aiText(js.captionMessages(p.spot, userText), userText ? 500 : 80, js.usageSink(req.user.id, cfg));
      if (!text) throw new Error('AI 返回为空');
    }
    db.prepare("UPDATE journal_photos SET caption=?, caption_by='ai' WHERE id=?").run(text.slice(0, 2000), p.id);
    touch(j.id);
    res.json({ caption: text, caption_by: 'ai' });
  } catch (e) {
    res.status(502).json({ error: '配文生成失败：' + e.message });
  }
});

// ---- 生成 ----
// fire-and-forget（与攻略同构）：立即回 202，进程内跑，进度走 GET /:id/stream
r.post('/:id/generate', (req, res) => {
  if (!needAi(req, res)) return;
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  if (j.status === 'pending') return res.status(409).json({ error: '正在生成中' });
  // 生成次数闸门（v1.10.0）：404/409 都得先于 403 —— 否则拿别人的 id 会看到「次数已用完」这种莫名其妙的提示
  const q = checkQuota(req.user, 'journal');
  if (q) return res.status(q.status).json({ error: q.error });
  const mergeGuideId = (req.body || {}).merge_guide_id;
  if (mergeGuideId) {
    const g = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(mergeGuideId), req.user.id);
    if (!g) return res.status(400).json({ error: '要合并的攻略不存在' });
  }
  db.prepare('UPDATE journals SET merge_guide_id=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
    .run(mergeGuideId ? Number(mergeGuideId) : null, j.id);
  js.run(j.id); // 不 await
  res.status(202).json({ ok: true });
});

// 重新生成（done/error 均可；保留标题与封面选择）
r.post('/:id/regenerate', (req, res) => {
  if (!needAi(req, res)) return;
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  if (j.status === 'pending') return res.status(409).json({ error: '正在生成中' });
  const q = checkQuota(req.user, 'journal');
  if (q) return res.status(q.status).json({ error: q.error });
  js.run(j.id);
  res.status(202).json({ ok: true });
});

// SSE 进度（轮询写库内容，与攻略同构：增量 delta / 重置 reset / 阶段 stage）
r.get('/:id/stream', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let believed = '';
  let sentStage = '';
  let closed = false;
  const send = (ev, data) => { if (!closed) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const timer = setInterval(async () => {
    try {
      const row = db.prepare('SELECT content, stage, status, error FROM journals WHERE id=?').get(j.id);
      if (!row) { send('error', { error: '游记不存在' }); return finish(); }
      if (row.stage && row.stage !== sentStage) { sentStage = row.stage; send('stage', { stage: row.stage, content_len: row.content ? row.content.length : 0 }); }
      const c = row.content || '';
      if (c !== believed) {
        if (c.startsWith(believed)) { send('delta', { text: c.slice(believed.length) }); believed = c; }
        else { believed = c; send('reset', { content: c }); }
      }
      if (row.status === 'done') { send('done', { content: c }); return finish(); }
      if (row.status === 'error') { send('error', { error: row.error || '生成失败' }); return finish(); }
    } catch { /* 单次读失败继续 */ }
  }, 400);
  function finish() {
    clearInterval(timer);
    if (!closed) res.end();
    closed = true;
  }
  req.on('close', finish);
});

// ---- 标题 / 封面 / 副标题 ----
r.post('/:id/title', async (req, res) => {
  if (!needAi(req, res)) return;
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  try {
    let t = '';
    const cfg = require('../services/aiService').resolveConfig();
    if (!cfg || cfg.source === 'stub') t = js.stubTitle(j);
    else {
      t = await js.aiText(js.titleMessages(j), 120, js.usageSink(req.user.id, cfg));
      if (!t) throw new Error('AI 返回为空');
    }
    t = t.replace(/["「」《》\s]/g, '').slice(0, 20);
    if (!t) throw new Error('标题生成为空');
    db.prepare("UPDATE journals SET title=?, updated_at=datetime('now','localtime') WHERE id=?").run(t, j.id);
    res.json({ title: t });
  } catch (e) {
    res.status(502).json({ error: '标题生成失败：' + e.message });
  }
});

r.put('/:id/cover', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const pid = (req.body || {}).photo_id;
  if (pid) {
    const p = photoOf(j.id, pid);
    if (!p) return res.status(400).json({ error: '封面照片不存在' });
    db.prepare("UPDATE journals SET cover_photo_id=?, updated_at=datetime('now','localtime') WHERE id=?").run(p.id, j.id);
  } else {
    db.prepare("UPDATE journals SET cover_photo_id=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(j.id);
  }
  res.json({ journal: rowJson(myJournal(req, j.id)) });
});

// ---- v1.9.0 三套文本 ----
// 自动保存走的是 PUT /:id（写 content=实时版）；这里只管另外两套备份的存与恢复。
// 「保存一版」= 把当前实时版拷成手动版；恢复一版/原版 = 把备份拷回实时版（覆盖当前正文，前端有确认）。
r.post('/:id/content/save-version', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const b = req.body || {};
  const text = String(b.content !== undefined ? b.content : j.content).slice(0, 200000);
  if (!text.trim()) return res.status(400).json({ error: '正文是空的，没有可保存的版本' });
  db.prepare("UPDATE journals SET content=?, content_manual=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, text, j.id);
  res.json({ ok: true, content: text, manual_len: text.length });
});

r.post('/:id/content/restore', (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  const which = String((req.body || {}).which || '');
  if (which !== 'manual' && which !== 'original') {
    return res.status(400).json({ error: 'which 只能是 manual（手动保存版）或 original（系统生成版）' });
  }
  const text = which === 'manual' ? j.content_manual : j.content_original;
  if (!String(text || '').trim()) {
    return res.status(400).json({ error: which === 'manual' ? '还没有手动保存过的版本（先点「保存一版」）' : '还没有系统生成版（这篇没走 AI 生成）' });
  }
  db.prepare("UPDATE journals SET content=?, updated_at=datetime('now','localtime') WHERE id=?").run(text, j.id);
  res.json({ ok: true, content: text, which });
});

// ---- v1.9.0 景点连线路线图 ----
// 点位顺序=spots_json 顺序（大纲/照片步排定的），坐标取景点库；库里没有就现场高德检索。
// 结果（含失败原因）缓存进 route_json——前端不用每次开页面都重打高德。
r.post('/:id/route', async (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  try {
    const out = await js.buildRoute(j);
    db.prepare("UPDATE journals SET route_json=?, updated_at=datetime('now','localtime') WHERE id=?").run(JSON.stringify(out), j.id);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: '路线生成失败：' + e.message });
  }
});

// ---- PDF 导出：mode=a4（分页打印）/ long（纯图不分页单页长条，网络分享） ----
// 正文里的 ![alt](photo:N) 占位换成本地文件 Buffer；封面=cover_photo_id 指的照片。
r.get('/:id/pdf', async (req, res) => {
  const j = myJournal(req, req.params.id);
  if (!j) return res.status(404).json({ error: '游记不存在' });
  if (j.status !== 'done') return res.status(409).json({ error: '游记还没生成完成' });
  const mode = req.query.mode === 'long' ? 'long' : 'a4';
  try {
    const photos = db.prepare('SELECT * FROM journal_photos WHERE journal_id=? ORDER BY sort, id').all(j.id);
    const extraImages = {};
    for (const p of photos) {
      const f = path.join(PHOTO_DIR, String(j.id), p.filename);
      try { if (fs.existsSync(f)) extraImages['photo:' + p.sort] = fs.readFileSync(f); } catch { /* 单图缺失不拦 */ }
    }
    let coverBuf = null;
    const coverRow = j.cover_photo_id ? photos.find((p) => p.id === j.cover_photo_id) : photos[0];
    if (coverRow) {
      const f = path.join(PHOTO_DIR, String(j.id), coverRow.filename);
      try { if (fs.existsSync(f)) coverBuf = fs.readFileSync(f); } catch { /* 无封面照常 */ }
    }
    const buf = await require('../services/pdfService').renderJournalPdf({
      title: j.title || j.destination || '旅行游记', subtitle: j.subtitle || '',
      markdown: j.content, palette: j.palette, mode, coverBuf, extraImages,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(((j.title || '游记') + (mode === 'long' ? '-长图' : '-A4')) + '.pdf')}`);
    res.end(buf);
  } catch (e) {
    console.error('journal pdf failed:', e.message);
    if (e.code === 'NO_FONT') return res.status(400).json({ error: e.message, code: 'NO_FONT' });
    res.status(500).json({ error: 'PDF 生成失败：' + e.message });
  }
});

// ---- 参数规整 ----
function sanitizeMeta(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ['origin', 'days', 'people', 'transport', 'local_transport', 'budget', 'hotel', 'season']) {
    if (m[k] !== undefined && m[k] !== null && String(m[k]) !== '') out[k] = String(m[k]).slice(0, 30);
  }
  if (Array.isArray(m.prefs)) out.prefs = m.prefs.map((x) => String(x).slice(0, 10)).filter(Boolean).slice(0, 6);
  return out;
}
function sanitizeSpots(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map((s) => ({
    name: String((s && s.name) || '').trim().slice(0, 40),
    attraction_id: s && s.attraction_id ? Number(s.attraction_id) : null,
    note: String((s && s.note) || '').slice(0, 500), // v1.9.0 景点体会（写进提示词的素材），放宽到 500 字
  })).filter((s) => s.name);
}

module.exports = r;
