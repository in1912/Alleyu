// 城市库 + 每城市景点库（全局共享，管理员主导维护）：
//  - 查询：登录即可（攻略表单的「边查边搜」靠它）
//  - 景点增改：登录即可（用户补录自己知道的景点）
//  - 城市增删改 / 景点删除 / 高德导入回填：admin
const express = require('express');
const { db } = require('../db');
const amap = require('../services/amapService');

const r = express.Router();

// ---- 城市 ----
r.get('/cities', (req, res) => {
  const q = String(req.query.q || '').trim();
  const list = q
    ? db.prepare('SELECT * FROM cities WHERE name LIKE ? OR province LIKE ? ORDER BY hot DESC, id LIMIT 30').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM cities ORDER BY hot DESC, id LIMIT 200').all();
  res.json({ cities: list });
});

r.post('/cities', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '城市新增仅管理员' });
  const { name, province, adcode, lng, lat, hot } = req.body || {};
  if (!name) return res.status(400).json({ error: '城市名必填' });
  if (db.prepare('SELECT id FROM cities WHERE name=?').get(String(name).trim())) return res.status(400).json({ error: '城市已存在' });
  let coord = { lng: null, lat: null };
  if (lng != null && lat != null) coord = { lng: Number(lng), lat: Number(lat) };
  const info = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot) VALUES(?,?,?,?,?,?)')
    .run(String(name).trim(), String(province || ''), String(adcode || ''), coord.lng, coord.lat, hot ? 1 : 0);
  res.json({ city: db.prepare('SELECT * FROM cities WHERE id=?').get(info.lastInsertRowid) });
});

r.put('/cities/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '城市修改仅管理员' });
  const c = db.prepare('SELECT * FROM cities WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '城市不存在' });
  const b = req.body || {};
  db.prepare('UPDATE cities SET name=?, province=?, adcode=?, lng=?, lat=?, hot=? WHERE id=?')
    .run(b.name !== undefined ? String(b.name).trim() : c.name, b.province !== undefined ? String(b.province) : c.province,
      b.adcode !== undefined ? String(b.adcode) : c.adcode,
      b.lng !== undefined ? (b.lng === null || b.lng === '' ? null : Number(b.lng)) : c.lng,
      b.lat !== undefined ? (b.lat === null || b.lat === '' ? null : Number(b.lat)) : c.lat,
      b.hot !== undefined ? (b.hot ? 1 : 0) : c.hot, c.id);
  res.json({ city: db.prepare('SELECT * FROM cities WHERE id=?').get(c.id) });
});

r.delete('/cities/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '城市删除仅管理员' });
  db.prepare('DELETE FROM cities WHERE id=?').run(Number(req.params.id)); // 级联删景点
  res.json({ ok: true });
});

// ---- 景点 ----
r.get('/cities/:id/attractions', (req, res) => {
  const rows = db.prepare('SELECT * FROM attractions WHERE city_id=? ORDER BY must DESC, id').all(Number(req.params.id));
  res.json({ attractions: rows });
});

r.post('/attractions', (req, res) => {
  const { city_id, name, type, level, ticket, hours, must, note } = req.body || {};
  if (!city_id || !name) return res.status(400).json({ error: '城市与景点名必填' });
  const c = db.prepare('SELECT id FROM cities WHERE id=?').get(Number(city_id));
  if (!c) return res.status(404).json({ error: '城市不存在' });
  if (db.prepare('SELECT id FROM attractions WHERE city_id=? AND name=?').get(Number(city_id), String(name).trim())) {
    return res.status(400).json({ error: '该城市下已有同名景点' });
  }
  const info = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must,note) VALUES(?,?,?,?,?,?,?,?)')
    .run(Number(city_id), String(name).trim(), String(type || '景点'), String(level || ''), String(ticket || ''), String(hours || ''), must ? 1 : 0, String(note || ''));
  const row = db.prepare('SELECT * FROM attractions WHERE id=?').get(info.lastInsertRowid);
  // 新录入的景点顺手解析坐标（失败不影响录入）
  amap.backfillAttraction(row.id).catch(() => {});
  res.json({ attraction: row });
});

r.put('/attractions/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attractions WHERE id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: '景点不存在' });
  const b = req.body || {};
  db.prepare('UPDATE attractions SET name=?, type=?, level=?, ticket=?, hours=?, must=?, note=? WHERE id=?')
    .run(b.name !== undefined ? String(b.name).trim() : a.name, b.type !== undefined ? String(b.type) : a.type,
      b.level !== undefined ? String(b.level) : a.level, b.ticket !== undefined ? String(b.ticket) : a.ticket,
      b.hours !== undefined ? String(b.hours) : a.hours, b.must !== undefined ? (b.must ? 1 : 0) : a.must,
      b.note !== undefined ? String(b.note) : a.note, a.id);
  res.json({ attraction: db.prepare('SELECT * FROM attractions WHERE id=?').get(a.id) });
});

r.delete('/attractions/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '景点删除仅管理员' });
  db.prepare('DELETE FROM attractions WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// 高德检索（补录参考 / 导入）。限频：简单节流即可
r.get('/poi', async (req, res) => {
  const kw = String(req.query.q || '').trim();
  const city = String(req.query.city || '').trim();
  if (!kw) return res.json({ pois: [] });
  try {
    const pois = await amap.searchPoi({ keywords: kw, city, offset: 8 });
    res.json({ pois });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 一键导入高德检索结果为景点（admin）
r.post('/import-poi', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { city_id, poi } = req.body || {};
  if (!city_id || !poi || !poi.name) return res.status(400).json({ error: '参数不完整' });
  if (db.prepare('SELECT id FROM attractions WHERE city_id=? AND name=?').get(Number(city_id), String(poi.name))) {
    return res.status(400).json({ error: '该城市下已有同名景点' });
  }
  const loc = poi.location || null;
  const info = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must,lng,lat,amap_poi_id) VALUES(?,?,?,?,?,?,0,?,?,?)')
    .run(Number(city_id), String(poi.name), String(poi.type || '景点').split(';')[0], '', String(poi.ticket || ''), '',
      loc ? loc.lng : null, loc ? loc.lat : null, String(poi.id || ''));
  res.json({ attraction: db.prepare('SELECT * FROM attractions WHERE id=?').get(info.lastInsertRowid) });
});

module.exports = r;
