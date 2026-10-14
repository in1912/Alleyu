// 攻划：创建（解析城市坐标 + 天气上下文落 params）、列表、详情、删除、SSE 流式。
// SSE 实现为「轮询读库」：生成进度由 guideService 节流写库，断线重连可续看，无需常驻订阅。
const express = require('express');
const { db } = require('../db');
const { generateGuide } = require('../services/guideService');
const { personalConfig, globalConfig } = require('../services/aiService');

const r = express.Router();

function guideOut(g) {
  return {
    id: g.id, title: g.title, destination: g.destination, days: g.days, status: g.status,
    error: g.error, model: g.model, created_at: g.created_at, updated_at: g.updated_at,
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
  if (process.env.ALLEYU_AI_STUB !== '1' && !personalConfig(req.user.id) && !globalConfig()) {
    return res.status(400).json({ error: '尚无可用 AI 配置：可在「设置→AI 配置」填自己的接口，或等管理员配置全局 Key' });
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
  res.json({ guide: { ...guideOut(g), content: g.content, params: JSON.parse(g.params_json || '{}') } });
});

r.delete('/:id', (req, res) => {
  const g = db.prepare('SELECT id FROM guides WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!g) return res.status(404).json({ error: '攻略不存在' });
  db.prepare('DELETE FROM guides WHERE id=?').run(g.id);
  res.json({ ok: true });
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
  let sent = 0;
  let closed = false;
  const tick = () => {
    if (closed) return;
    const g = db.prepare('SELECT * FROM guides WHERE id=?').get(Number(req.params.id));
    if (!g) { send('error', { error: '攻略已被删除' }); return end(); }
    if (g.content && g.content.length > sent) {
      send('delta', { text: g.content.slice(sent) });
      sent = g.content.length;
    }
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
