// 系统设置（admin）：高德 Key、系统信息。AI 全局 Key 在 /ai 路由。
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const packageJson = require('../../package.json');

const r = express.Router();

function systemInfo(req, res) {
  res.json({
    name: '游巷 Alleyu', version: packageJson.version,
    node: process.version, platform: process.platform,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    guides: db.prepare('SELECT COUNT(*) c FROM guides').get().c,
    cities: db.prepare('SELECT COUNT(*) c FROM cities').get().c,
    attractions: db.prepare('SELECT COUNT(*) c FROM attractions').get().c,
    stub_ai: process.env.ALLEYU_AI_STUB === '1',
  });
}
r.get('/system-info', systemInfo);

r.get('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json({ amap_key_set: !!getSetting('amap_key') });
});

r.put('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { amap_key } = req.body || {};
  if (amap_key !== undefined) {
    if (amap_key && !/^[0-9a-f]{32}$/.test(String(amap_key).trim())) {
      return res.status(400).json({ error: '高德 Key 格式应为 32 位十六进制' });
    }
    setSetting('amap_key', String(amap_key || '').trim());
  }
  res.json({ ok: true });
});

module.exports = r;
module.exports.systemInfo = systemInfo;
