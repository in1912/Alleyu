// 系统设置（admin）：高德 Key、系统信息。AI 全局 Key 在 /ai 路由。
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { wikiSettingsJson, isBoolInput, MAX_ATTRS_LIMIT } = require('../services/wikiSettings');
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

// 生成次数默认值：空串=不限；否则 0~9999 的整数（v1.10.0）
function quotaSetting(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { val: '' };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return { bad: true };
  return { val: String(n) };
}

// 公开访问地址（v1.10.2）：拼分享链接用的域名。留空 = 前端跟随 location（老行为）。
// 只允许 http(s):// 开头、无空格、可带端口；末尾斜杠会被去掉（拼接时还会再兜一次）。
function baseUrlSetting(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\/+$/, '');
  if (!v) return { val: '' };
  if (!/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(v)) return { bad: true };
  return { val: v };
}

r.get('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json({
    amap_key_set: !!getSetting('amap_key'),
    quota_default_guide: String(getSetting('quota_default_guide') || ''),
    quota_default_journal: String(getSetting('quota_default_journal') || ''),
    public_base_url: String(getSetting('public_base_url') || ''),
    upgrade_keep_backups: String(getSetting('upgrade_keep_backups') || ''),
    upgrade_keep_dist: String(getSetting('upgrade_keep_dist') || ''),
    // v1.12.0：两家维基站点各一个开关（缺省全关）+ 批量补全阈值
    ...wikiSettingsJson(),
  });
});

// 在线升级保留份数（v1.11.0）：留空 = 用默认值（备份 5 份 / 前端目录 2 份）。
// 只认 1~20 的整数：0 会让「刚升完就把回滚材料删了」，没有意义。
function keepSetting(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { val: '' };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 20) return { bad: true };
  return { val: String(n) };
}

r.put('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { amap_key } = req.body || {};
  for (const key of ['upgrade_keep_backups', 'upgrade_keep_dist']) {
    if (req.body && req.body[key] !== undefined) {
      const k = keepSetting(req.body[key]);
      if (k.bad) return res.status(400).json({ error: '升级保留份数要留空（用默认）或填 1~20 的整数' });
      setSetting(key, k.val);
    }
  }
  if (amap_key !== undefined) {
    if (amap_key && !/^[0-9a-f]{32}$/.test(String(amap_key).trim())) {
      return res.status(400).json({ error: '高德 Key 格式应为 32 位十六进制' });
    }
    setSetting('amap_key', String(amap_key || '').trim());
  }
  // 系统默认生成次数：留空 = 不限（也正是老库升级后的语义，不会被这次改动掐住）
  for (const key of ['quota_default_guide', 'quota_default_journal']) {
    if (req.body && req.body[key] !== undefined) {
      const q = quotaSetting(req.body[key]);
      if (q.bad) return res.status(400).json({ error: '默认生成次数要留空（不限）或填 0~9999 的整数' });
      setSetting(key, q.val);
    }
  }
  // 公开访问地址（v1.10.2）：留空 = 清掉（前端回落 location）
  if (req.body && req.body.public_base_url !== undefined) {
    const b = baseUrlSetting(req.body.public_base_url);
    if (b.bad) return res.status(400).json({ error: '公开访问地址要留空，或以 http:// 或 https:// 开头的完整地址（例如 http://alleyu.in1912.cn）' });
    setSetting('public_base_url', b.val);
  }
  // 维基分站开关（v1.12.0）：只收布尔语义，存 '1' / ''。缺省 = 关。
  for (const key of ['wiki_voyage_enabled', 'wiki_pedia_enabled']) {
    if (req.body && req.body[key] !== undefined) {
      if (!isBoolInput(req.body[key])) return res.status(400).json({ error: '维基开关只接受开/关' });
      const on = req.body[key] === true || req.body[key] === 1 || req.body[key] === '1';
      setSetting(key, on ? '1' : '');
    }
  }
  // 批量补全阈值：留空 = 恢复默认 6；否则 0~100 的整数
  if (req.body && req.body.backfill_max_attrs !== undefined) {
    const s = String(req.body.backfill_max_attrs === null ? '' : req.body.backfill_max_attrs).trim();
    if (!s) setSetting('backfill_max_attrs', '');
    else {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > MAX_ATTRS_LIMIT) {
        return res.status(400).json({ error: `补全阈值必须是 0~${MAX_ATTRS_LIMIT} 的整数（留空 = 默认 6）` });
      }
      setSetting('backfill_max_attrs', String(n));
    }
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
