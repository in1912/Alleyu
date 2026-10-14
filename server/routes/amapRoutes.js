// 高德公共通道：地图图片（EXEMPT，<img> 直链）+ 照片代理（EXEMPT，白名单域）。
// key 全程不出服务端；mapimg 按 URL sha 缓存在 data/mapimg/，重复请求零配额消耗。
const express = require('express');
const path = require('path');
const fs = require('fs');
const amap = require('../services/amapService');

const r = express.Router();

const MAPIMG_DIR = () => path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'mapimg');

// 静态地图缓存（/api/amap/mapimg/<sha>.png）——EXEMPT 免登录（图片链接带不了头）
r.get('/mapimg/:key.png', (req, res) => {
  const key = String(req.params.key || '');
  if (!/^[0-9a-f]{6,32}$/.test(key)) return res.status(400).end();
  const file = path.join(MAPIMG_DIR(), `${key}.png`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
});

// POI 照片代理：只转白名单域，防 SSRF
r.get('/photo', async (req, res) => {
  const u = String(req.query.u || '');
  if (!u || !amap.photoHostAllowed(u)) return res.status(403).end();
  try {
    const upstream = await fetch(u, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(502).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length < 100) return res.status(502).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch {
    res.status(502).end();
  }
});

module.exports = r;
