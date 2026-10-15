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

// 高德 Key 常见错误码 → 人话提示（真实踩坑：JS API 类型的 Key 调 REST 必报 10009）
const AMAP_HINTS = {
  '10001': 'Key 不存在或已被删除——到 lbs.amap.com 控制台核对',
  '10003': '这个 Key 今日配额已用完（明日重置，或换 Key）',
  '10006': '请求 IP 不在 Key 的白名单里——控制台 Key 管理里改白名单，或填 0.0.0.0/0 关闭限制',
  '10009': 'Key 类型不匹配：这是「Web端(JS API)」类型的 Key，调不了 REST 服务接口。到控制台创建「Web服务」类型的 Key 再试',
  '10021': '并发超限（免费 Key 3 QPS）——几秒后重试',
};

// 高德连通测试：body.key 传待保存值先行验证；不传则测当前已保存的 Key。
// 永远回 200 + {ok}，错误细节放响应体（前端要展示原因，不是 throw）
r.post('/amap/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const key = String((req.body && req.body.key) || '').trim() || getSetting('amap_key') || '';
  if (!key) return res.json({ ok: false, info: '尚未配置 Key', hint: '先在上面填写并保存高德 Web 服务 Key' });
  if (!/^[0-9a-f]{32}$/.test(key)) {
    return res.json({ ok: false, info: 'Key 格式不是 32 位十六进制', hint: '高德 Key 是 32 位十六进制串，到 lbs.amap.com 控制台复制' });
  }
  try {
    const u = `https://restapi.amap.com/v3/place/text?key=${key}&keywords=${encodeURIComponent('公园')}&offset=1&page=1`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(10000) })).json();
    if (j.status === '1') return res.json({ ok: true });
    const infocode = String(j.infocode || '');
    return res.json({ ok: false, infocode, info: j.info || '未知错误', hint: AMAP_HINTS[infocode] || '到 lbs.amap.com 控制台核对 Key 状态/类型/配额' });
  } catch (e) {
    return res.json({ ok: false, info: '网络请求失败：' + (e.message || e), hint: '本机访问 restapi.amap.com 失败，检查网络/代理' });
  }
});

// 清空高德 Key（v1.6.3 起没有内置默认值，清空后到设置页重新配置）
r.post('/amap/reset', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  setSetting('amap_key', '');
  res.json({ ok: true, amap_key_set: false });
});

module.exports = r;
module.exports.systemInfo = systemInfo;
