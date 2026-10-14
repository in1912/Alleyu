// 天气查询：城市名/坐标 → 预报或历史推演。页面直查 + 攻略生成共用同一服务。
const express = require('express');
const { db } = require('../db');
const weather = require('../services/weatherService');
const amap = require('../services/amapService');

const r = express.Router();

async function resolveCoords(q) {
  // 优先城市库（含坐标），否则高德检索
  const city = db.prepare('SELECT * FROM cities WHERE name=?').get(q)
    || db.prepare('SELECT * FROM cities WHERE name LIKE ? ORDER BY hot DESC LIMIT 1').get(`%${q}%`);
  if (city && city.lng != null && city.lat != null) return { name: city.name, lng: city.lng, lat: city.lat };
  if (city) {
    try {
      const hit = await amap.resolvePoi(city.name, city.name);
      if (hit && hit.location) {
        db.prepare('UPDATE cities SET lng=?, lat=? WHERE id=?').run(hit.location.lng, hit.location.lat, city.id);
        return { name: city.name, lng: hit.location.lng, lat: hit.location.lat };
      }
    } catch { /* 落到高德直查 */ }
  }
  try {
    const hit = await amap.resolvePoi(q, '');
    if (hit && hit.location) return { name: q, lng: hit.location.lng, lat: hit.location.lat };
  } catch (e) {
    throw new Error(`无法定位「${q}」：${e.message}`);
  }
  throw new Error(`无法定位「${q}」`);
}

// GET /api/weather?q=杭州&mode=auto|forecast|history&month=10&days=7
r.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '缺少城市参数' });
  const mode = String(req.query.mode || 'auto');
  try {
    const c = await resolveCoords(q);
    if (mode === 'history' || (mode === 'auto' && req.query.month)) {
      const month = String(req.query.month || '').padStart(2, '0');
      const stats = await weather.monthStats(c.lat, c.lng, month);
      return res.json({ city: c.name, lng: c.lng, lat: c.lat, mode: 'history', stats });
    }
    const days = Math.min(Math.max(Number(req.query.days) || 16, 1), 16);
    const f = await weather.forecast(c.lat, c.lng, days);
    res.json({ city: c.name, lng: c.lng, lat: c.lat, mode: 'forecast', daily: f.daily, advisories: weather.advise(f.daily) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = r;
