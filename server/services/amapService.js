// 高德 Web 服务 API 封装：key 只在服务端使用，绝不下发前端（图片走 /api/amap/* 代理）。
// 覆盖：POI 检索（含实景照片）、驾车路线（途径点链）、静态地图（路线图/总览图）。
const { db, getSetting } = require('../db');

const AMAP_BASE = 'https://restapi.amap.com';
const STATIC_BASE = 'https://restapi.amap.com/v3/staticmap';

// 免费 Key 限 3 QPS：全局串行门闩，任意两次高德调用间隔 ≥350ms（实测连发第 4 发即 10021）
let _lastCall = 0;
async function throttle() {
  const wait = _lastCall + 350 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCall = Date.now();
}

function apiKey() {
  return getSetting('amap_key') || process.env.AMAP_KEY || '';
}

async function call(pathname, params = {}, timeoutMs = 8000) {
  await throttle();
  const key = apiKey();
  if (!key) throw new Error('未配置高德 Key（设置页可配置）');
  const qs = new URLSearchParams({ key, ...params });
  const res = await fetch(`${AMAP_BASE}${pathname}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json();
  if (j.status !== '1') {
    throw new Error(`高德接口错误 ${j.infocode || ''}：${j.info || '未知错误'}`);
  }
  return j;
}

function parseLocation(loc) {
  if (!loc || typeof loc !== 'string' || !loc.includes(',')) return null;
  const [lng, lat] = loc.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

// POI 检索。extensions=all 时部分 POI 带 photos[{title,url}] 与 biz_ext（门票/评分）。
// types：高德 POI 分类码（如 110000=风景名胜），与 keywords 至少给一个（v1.7.0 批量导入用）。
async function searchPoi({ keywords, city = '', citylimit = true, offset = 10, page = 1, extensions = 'all', types = '' }) {
  const qs = {
    keywords, city: city || '', citylimit: citylimit ? 'true' : 'false',
    offset: String(offset), page: String(page), extensions,
  };
  if (types) qs.types = types; // 空串不发：keywords/types 至少一个，空参数不给高德留解释空间
  const j = await call('/v3/place/text', qs);
  return (j.pois || []).map((p) => ({
    id: p.id, name: p.name, type: p.type || '', address: p.address || '',
    location: parseLocation(p.location),
    photo: (p.photos && p.photos[0] && p.photos[0].url) || '',
    ticket: (p.biz_ext && p.biz_ext.ticket && String(p.biz_ext.ticket)) || '',
    rating: (p.biz_ext && p.biz_ext.rating && String(p.biz_ext.rating)) || '',
  }));
}

// 景点坐标解析：按「名称 + 城市」搜第一个带坐标的 POI，可选回填 attractions 表。
async function resolvePoi(name, cityName) {
  const list = await searchPoi({ keywords: name, city: cityName, offset: 5 });
  const hit = list.find((p) => p.location) || list[0];
  return hit || null;
}

async function backfillAttraction(attrId, cityName) {
  const row = db.prepare('SELECT a.id, a.name, a.lng, a.lat, c.name city FROM attractions a JOIN cities c ON c.id=a.city_id WHERE a.id=?').get(attrId);
  if (!row || (row.lng !== undefined && row.lng !== null)) return false; // 已有坐标
  const hit = await resolvePoi(row.name, row.city);
  if (!hit || !hit.location) return false;
  db.prepare('UPDATE attractions SET lng=?, lat=?, amap_poi_id=?, ticket=CASE WHEN ticket=\'\' THEN ? ELSE ticket END WHERE id=?')
    .run(hit.location.lng, hit.location.lat, hit.id, hit.ticket || '', attrId);
  return true;
}

// 驾车路线（含途径点）。返回折线点序列 [[lng,lat],...]（含全部途径点，供静态地图描线）。
async function drivingPolyline(points) {
  if (!points || points.length < 2) return points || [];
  const [origin, ...rest] = points;
  const destination = rest.pop();
  const params = {
    origin: `${origin.lng},${origin.lat}`,
    destination: `${destination.lng},${destination.lat}`,
    extensions: 'base', strategy: '32',
  };
  if (rest.length) params.waypoints = rest.map((p) => `${p.lng},${p.lat}`).join('|');
  const j = await call('/v3/direction/driving', params, 10000);
  const route = j.route && j.route.paths && j.route.paths[0];
  if (!route) return points;
  const out = [];
  for (const step of route.steps || []) {
    for (const seg of String(step.polyline || '').split(';')) {
      const loc = parseLocation(seg);
      if (loc) out.push([loc.lng, loc.lat]);
    }
  }
  return out.length >= 2 ? out : points.map((p) => [p.lng, p.lat]);
}

// 折线降采样：静态地图 URL 有长度上限，保留首尾 + 均匀抽样。
function downsample(line, maxPoints = 60) {
  if (line.length <= maxPoints) return line;
  const step = (line.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(line[Math.round(i * step)]);
  return out;
}

// 静态地图 URL 组装（key 服务端补，不出网）。markers: [{lng,lat,label}]
// paths: [[ [lng,lat], ... ]]（经纬度序列，每元素一条折线）
// ink=true 时用蓝墨色（配合前端 sepia+hue-rotate 滤镜做「偏蓝单色」封面图，用户定调不要黑白）
// 高德分隔符规则（官方 REST 文档）：markers 多个用 | 分隔；paths 多条用 | 分隔，
// 但「一条折线内部的点」用 ; 分隔——与 markers 不同，这里是最容易踩的坑。
// size 上限实测到 1200*800 仍正常出图（2026-10 curl 验证），默认取 1000*580。
function buildStaticMapUrl({ center, zoom = 11, size = '1000*580', markers = [], paths = [], traffic = false, ink = false }) {
  const params = new URLSearchParams();
  if (center) params.set('location', `${center.lng},${center.lat}`);
  params.set('zoom', String(zoom));
  params.set('size', size);
  params.set('scale', '2');
  if (markers.length) {
    const mc = ink ? '0x0d47a8' : '0x2f6b45';
    params.set('markers', markers.map((m) => `large,${mc},${m.label}:${m.lng},${m.lat}`).join('|'));
  }
  if (paths.length) {
    const pc = ink ? '0x1565d8' : '0x3f7d5c';
    params.set('paths', paths.map((line) => {
      const pts = line.map((p) => `${p[0]},${p[1]}`).join(';');
      return `8,${pc},0.9,,:${pts}`; // 实测：fillcolor 后必须带冒号，点用 ; 分隔（2026-10 curl 验证）
    }).join('|'));
  }
  if (traffic) params.set('traffic', '1');
  return `${STATIC_BASE}?key=${apiKey()}&${params}`;
}

async function fetchStaticMap(spec) {
  await throttle();
  const url = buildStaticMapUrl(spec);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`静态地图 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error('静态地图返回的不是 PNG（检查 key 或参数）');
  }
  return buf;
}

// 照片代理白名单：高德系 CDN。出现在别的域时（现场观察）再扩。
const PHOTO_HOST_SUFFIXES = ['amap.com', 'autonavi.com', 'mypeople.com.cn', 'gaode.com'];
function photoHostAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return PHOTO_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
  } catch {
    return false;
  }
}

module.exports = {
  apiKey, searchPoi, resolvePoi, backfillAttraction, drivingPolyline, downsample,
  buildStaticMapUrl, fetchStaticMap, photoHostAllowed,
};
