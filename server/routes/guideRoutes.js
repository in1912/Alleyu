// 攻划：创建（解析城市坐标 + 天气上下文落 params）、列表、详情、删除、SSE 流式、
// 编辑正文与分享链接（v1.6.0）。SSE 实现为「轮询读库」：生成进度由 guideService 节流写库，
// 断线重连可续看，无需常驻订阅。
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { generateGuide } = require('../services/guideService');
const { renderGuidePdf } = require('../services/pdfService');
const { globalConfig } = require('../services/aiService');
const { checkQuota } = require('../quota');
const community = require('../services/communityService');

const r = express.Router();

function guideOut(g) {
  return {
    id: g.id, title: g.title, destination: g.destination, days: g.days, status: g.status,
    stage: g.stage || '', error: g.error, model: g.model, created_at: g.created_at, updated_at: g.updated_at,
    content_len: g.content ? g.content.length : 0,
    images: JSON.parse(g.images_json || '[]'),
  };
}

// 参数清洗（前端传原始表单）
function sanitizeParams(b) {
  return {
    destination: String(b.destination || '').trim(),
    days: Math.min(Math.max(Number(b.days) || 3, 1), 15),
    departure: String(b.departure || '').trim(),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.startDate || '')) ? b.startDate : '',
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.endDate || '')) ? b.endDate : '',
    group: String(b.group || '').trim(),
    ages: String(b.ages || '').trim(),
    budget: String(b.budget || '').trim(),
    preferences: Array.isArray(b.preferences) ? b.preferences.map(String).slice(0, 8) : [],
    transport: String(b.transport || '').trim(),
    mustVisits: Array.isArray(b.mustVisits) ? b.mustVisits.map(String).slice(0, 20) : [],
    avoid: Array.isArray(b.avoid) ? b.avoid.map(String).slice(0, 10) : [],
    month: String(b.month || '').trim(),
    season: String(b.season || '').trim(),
    notes: String(b.notes || '').trim().slice(0, 500),
  };
}

r.post('/', async (req, res) => {
  // AI 闸门：admin 恒可，普通用户看 can_use_ai；且必须有可用配置（自己或全局）
  const gate = req.user.role === 'admin' || req.user.can_use_ai;
  if (!gate) return res.status(403).json({ error: '管理员未给你开通 AI 使用权限' });
  // 生成次数闸门（v1.10.0）：这里只拦「开跑」，扣数在 guideService 真写出成稿后（失败/重试不扣）
  const q = checkQuota(req.user, 'guide');
  if (q) return res.status(q.status).json({ error: q.error });
  const stubbed = process.env.ALLEYU_AI_STUB === '1' || process.env.ALLEYU_AI_FORCE_STUB === '1';
  if (!stubbed && !globalConfig()) {
    return res.status(400).json({ error: '尚无可用 AI 配置：请管理员在「设置→全局配置」填写接口与 Key' });
  }
  const p = sanitizeParams(req.body || {});
  if (!p.destination) return res.status(400).json({ error: '目的地必填' });

  // 城市匹配 + 坐标（天气/地图中心要用；匹配不上也能生成，只是没有图文增强定位）
  const city = db.prepare('SELECT * FROM cities WHERE name=?').get(p.destination)
    || db.prepare('SELECT * FROM cities WHERE name LIKE ? ORDER BY hot DESC LIMIT 1').get(`%${p.destination}%`);
  const _ctx = { _lng: city ? city.lng : null, _lat: city ? city.lat : null, cityId: city ? city.id : null, cityCoordsSource: city ? 'library' : 'none' };
  // 库里没有坐标 → 现场高德解析一次并回填库（城市级，低频）
  if (city && (city.lng == null || city.lat == null)) {
    try {
      const { resolvePoi } = require('../services/amapService');
      const hit = await resolvePoi(city.name, city.name);
      if (hit && hit.location) {
        db.prepare('UPDATE cities SET lng=?, lat=? WHERE id=?').run(hit.location.lng, hit.location.lat, city.id);
        _ctx._lng = hit.location.lng; _ctx._lat = hit.location.lat;
      }
    } catch { /* 定位失败不拦生成 */ }
  }
  const params = { ...p, ..._ctx };
  const title = `${p.destination}${p.days}日游`;
  const info = db.prepare('INSERT INTO guides(user_id,title,destination,city_id,days,params_json,status) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, title, p.destination, city ? city.id : null, p.days, JSON.stringify(params), 'pending');
  generateGuide(info.lastInsertRowid); // fire-and-forget
  res.json({ id: info.lastInsertRowid });
});

r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM guides WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ guides: rows.map(guideOut) });
});

r.get('/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  res.json({ guide: { ...guideOut(g), content: g.content, params: JSON.parse(g.params_json || '{}'), prompt: g.prompt || '' } });
});

// 重新生成（v1.5.0）：失败/不满意的攻略用原参数重跑（详情页「复制全文」旁的入口）。
// 原地重置不新建行（历史列表不膨胀）；权限与配置闸门和创建一致。
r.post('/:id/regenerate', async (req, res) => {
  const g = db.prepare('SELECT id, status FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  if (g.status === 'pending' || g.status === 'generating') {
    return res.status(409).json({ error: '这篇攻略正在生成中，稍候' });
  }
  const gate = req.user.role === 'admin' || req.user.can_use_ai;
  if (!gate) return res.status(403).json({ error: '管理员未给你开通 AI 使用权限' });
  const q = checkQuota(req.user, 'guide');
  if (q) return res.status(q.status).json({ error: q.error });
  const stubbed = process.env.ALLEYU_AI_STUB === '1' || process.env.ALLEYU_AI_FORCE_STUB === '1';
  if (!stubbed && !globalConfig()) {
    return res.status(400).json({ error: '尚无可用 AI 配置：请管理员在「设置→全局配置」填写接口与 Key' });
  }
  db.prepare("UPDATE guides SET status='pending', content='', images_json='[]', error='', stage='', model='', updated_at=datetime('now','localtime') WHERE id=?").run(g.id);
  generateGuide(g.id);
  res.json({ id: g.id });
});

r.delete('/:id', (req, res) => {
  const g = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  // v1.13.0：原攻略删除 → 社区里对应的分享自动撤下
  try { community.removePostsBySource('guide', g.id); } catch { /* 社区清理失败不拦删除 */ }
  db.prepare('DELETE FROM shares WHERE guide_id=?').run(g.id); // SQLite 默认不强制 FK，手动清
  db.prepare('DELETE FROM guides WHERE id=?').run(g.id);
  res.json({ ok: true });
});

// 编辑正文（v1.6.0）：已完成的攻略可直接改 markdown；动态分享链接自动跟着更新。
r.put('/:id', (req, res) => {
  const g = db.prepare('SELECT id, status FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  if (g.status !== 'done') return res.status(409).json({ error: '生成中/失败的攻略不能编辑（失败请用重新生成）' });
  const content = String((req.body || {}).content || '');
  if (!content.trim()) return res.status(400).json({ error: '正文不能为空' });
  db.prepare("UPDATE guides SET content=?, updated_at=datetime('now','localtime') WHERE id=?").run(content, g.id);
  res.json({ ok: true });
});

// ---- 导出 PDF（v1.6.1）：服务端 pdfkit 直出下载文件（用户明确不要浏览器打印）----
// Content-Disposition: attachment → 前端 fetch→blob→a[download]，点击即得 .pdf 文件。
r.get('/:id/pdf', async (req, res) => {
  const g = db.prepare('SELECT id, title, content, status FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  if (g.status !== 'done') return res.status(409).json({ error: '生成完成后才能导出' });
  try {
    const buf = await renderGuidePdf(g.title || '攻略', g.content || '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((g.title || '攻略') + '.pdf')}`);
    res.send(buf);
  } catch (e) {
    if (e && e.code === 'NO_FONT') return res.status(400).json({ error: e.message, code: 'NO_FONT' });
    console.error('pdf export failed:', e);
    res.status(500).json({ error: 'PDF 生成失败：' + (e.message || e) });
  }
});

// ---- 分享链接（v1.6.0）：token 即能力凭证（32hex，可作废）----
// mode: dynamic=打开时读攻略当前内容（跟随编辑/重新生成）；static=分享那一刻的全文快照，
// 之后原文怎么改都不动，可手动「更新快照」。公开读端点在 shareRoutes（EXEMPT 免登录）。
function shareOut(s) {
  return { token: s.token, mode: s.mode, created_at: s.created_at, updated_at: s.updated_at, snapshot_len: s.snapshot ? s.snapshot.length : 0 };
}

r.get('/:id/shares', (req, res) => {
  const g = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  const rows = db.prepare('SELECT * FROM shares WHERE guide_id=? ORDER BY id DESC').all(g.id);
  res.json({ shares: rows.map(shareOut) });
});

r.post('/:id/shares', (req, res) => {
  const g = db.prepare('SELECT id, title, content, status FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  if (g.status !== 'done') return res.status(409).json({ error: '攻略还没生成完成，不能分享' });
  const mode = (req.body || {}).mode === 'static' ? 'static' : 'dynamic';
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO shares(guide_id, token, mode, snapshot) VALUES(?,?,?,?)')
    .run(g.id, token, mode, mode === 'static' ? g.content : '');
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(token);
  res.json({ ...shareOut(s), url: '/#/s/' + token });
});

// 静态分享刷新快照到当前正文（动态分享无需刷新）
r.put('/:id/shares/:token', (req, res) => {
  const g = db.prepare('SELECT id, content FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  const s = db.prepare('SELECT * FROM shares WHERE token=? AND guide_id=?').get(String(req.params.token || ''), g.id);
  if (!s) return res.status(404).json({ error: '分享不存在' });
  db.prepare("UPDATE shares SET snapshot=?, updated_at=datetime('now','localtime') WHERE id=?").run(g.content, s.id);
  res.json({ ok: true, ...shareOut(db.prepare('SELECT * FROM shares WHERE id=?').get(s.id)) });
});

r.delete('/:id/shares/:token', (req, res) => {
  const g = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  const info = db.prepare('DELETE FROM shares WHERE token=? AND guide_id=?').run(String(req.params.token || ''), g.id);
  res.json({ ok: true, revoked: info.changes > 0 });
});

// SSE：创建后前端 EventSource 直连；状态 done/error 后发终态并关闭。
// 兼容 ?token= 查询参数鉴权（EventSource 无法带自定义头）——EXEMPT 之外由全局中间件解析。
r.get('/:id/stream', (req, res) => {
  const g0 = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g0) return res.status(404).json({ error: '攻略不存在' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // 内容基线协议（v1.4.0）：believed = 认为客户端手上已有的精确内容。
  //  - 正文追加（正常流式）→ delta 推增量；
  //  - 内容被改写（enrich 会在顶部插封面地图=前插，非追加）或本连接首拍/断线重连 → reset 推全文快照。
  // 旧纯 slice(sent) 协议在前插场景会把中段文本当增量推出、封面永远到不了前端，重连还会整篇重复。
  let believed = null;
  let sentStage = null;
  let closed = false;
  const tick = () => {
    if (closed) return;
    const g = db.prepare('SELECT * FROM guides WHERE id=?').get(Number(req.params.id));
    if (!g) { send('error', { error: '攻略已被删除' }); return end(); }
    // 阶段事件（v1.4.0 进度条数据源）：阶段变化才推，断线重连首拍也会补当前阶段
    if (g.stage && g.stage !== sentStage) {
      sentStage = g.stage;
      send('stage', { stage: g.stage, content_len: g.content ? g.content.length : 0 });
    }
    const c = g.content || '';
    if (believed === null || !c.startsWith(believed)) {
      send('reset', { text: c });
    } else if (c.length > believed.length) {
      send('delta', { text: c.slice(believed.length) });
    }
    believed = c;
    if (g.status === 'done') {
      send('done', { id: g.id, images: JSON.parse(g.images_json || '[]'), content_len: g.content.length });
      return end();
    }
    if (g.status === 'error') {
      send('error', { error: g.error || '生成失败' });
      return end();
    }
    timer = setTimeout(tick, 400);
  };
  let timer = setTimeout(tick, 50);
  const end = () => { closed = true; clearTimeout(timer); res.end(); };
  req.on('close', end);
});

module.exports = r;
