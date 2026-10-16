// 城市库 + 每城市景点库（全局共享，管理员主导维护）：
//  - 查询：登录即可（攻略表单的「边查边搜」靠它）
//  - 景点增改：登录即可（用户补录自己知道的景点）
//  - 城市增删改 / 景点删除 / 高德导入回填 / 一键补全：admin
const express = require('express');
const { db, seedCityStats, seedLines, pullSeedCities } = require('../db');
const amap = require('../services/amapService');
const wiki = require('../services/wikiService');
const { runIntroBackfill } = require('../services/introBackfill');

const r = express.Router();

// 线路不做白名单（v1.7.0 起软校验）：任意非空线路名收（≤20 字），空=国内；
// 种子六线只是前端建议项，新增线路（如「中东线」）直接入库，/cities/lines 动态回传。
function normLine(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 20);
  return s || '国内';
}

// ---- 城市 ----
// 线路汇总（库页的线路筛选 pill 计数）
r.get('/cities/lines', (req, res) => {
  const rows = db.prepare('SELECT line, COUNT(*) c FROM cities GROUP BY line ORDER BY CASE line WHEN \'国内\' THEN 0 ELSE 1 END, line').all();
  res.json({ lines: rows });
});

// v1.10.1：各线路种子城市统计（库页「拉取旅游城市」按钮显示「还缺 N 座」；0 就置灰）
// 国内=SEED_CITIES、国际五线=SEED_INTL；用户自建线路不在种子里，不会出现在这个列表。
r.get('/cities/seed', (req, res) => {
  res.json({ lines: seedCityStats() });
});

// v1.10.1：按线路拉取旅游城市（admin）——把种子里库中没有的城市补进来（已有城市一律跳过、不改动），
// 新城市连带它的种子景点一起入库。body: { line }（缺省=国内）。
r.post('/cities/pull', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '拉取城市仅管理员' });
  const line = normLine((req.body || {}).line);
  if (!seedLines().includes(line)) {
    return res.json({ line, total: 0, added: 0, skipped: 0, attrs: 0, added_names: [], note: '该线路没有内置种子城市，无需拉取' });
  }
  res.json(pullSeedCities(line));
});

r.get('/cities', (req, res) => {
  const q = String(req.query.q || '').trim();
  const line = String(req.query.line || '').trim();
  const cond = [];
  const args = [];
  if (q) { cond.push('(name LIKE ? OR province LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (line) { cond.push('line=?'); args.push(line); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const limit = q || line ? 300 : 200;
  // attr_count：每城市景点数（v1.7.0 库页「补全全部缺景点城市」按它挑）
  const list = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM attractions a WHERE a.city_id=c.id) attr_count FROM cities c ${where} ORDER BY c.hot DESC, c.id LIMIT ${limit}`).all(...args);
  res.json({ cities: list });
});

r.post('/cities', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '城市新增仅管理员' });
  const { name, province, adcode, lng, lat, hot, line } = req.body || {};
  if (!name) return res.status(400).json({ error: '城市名必填' });
  if (db.prepare('SELECT id FROM cities WHERE name=?').get(String(name).trim())) return res.status(400).json({ error: '城市已存在' });
  let coord = { lng: null, lat: null };
  if (lng != null && lat != null) coord = { lng: Number(lng), lat: Number(lat) };
  const info = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot,line) VALUES(?,?,?,?,?,?,?)')
    .run(String(name).trim(), String(province || ''), String(adcode || ''), coord.lng, coord.lat, hot ? 1 : 0, normLine(line));
  res.json({ city: db.prepare('SELECT * FROM cities WHERE id=?').get(info.lastInsertRowid) });
});

r.put('/cities/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '城市修改仅管理员' });
  const c = db.prepare('SELECT * FROM cities WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '城市不存在' });
  const b = req.body || {};
  db.prepare('UPDATE cities SET name=?, province=?, adcode=?, lng=?, lat=?, hot=?, line=? WHERE id=?')
    .run(b.name !== undefined ? String(b.name).trim() : c.name, b.province !== undefined ? String(b.province) : c.province,
      b.adcode !== undefined ? String(b.adcode) : c.adcode,
      b.lng !== undefined ? (b.lng === null || b.lng === '' ? null : Number(b.lng)) : c.lng,
      b.lat !== undefined ? (b.lat === null || b.lat === '' ? null : Number(b.lat)) : c.lat,
      b.hot !== undefined ? (b.hot ? 1 : 0) : c.hot,
      b.line !== undefined && b.line !== '' ? normLine(b.line) : c.line, c.id);
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

// 跨城市分页浏览（v1.7.0 库页景点 tab 改造：先选线路再选城市、未选城市=全部）。
// 参数：line（线路白名单值）/ city_id / q（景点名模糊）/ page（1 起）/ page_size（默认 10，上限 100）
r.get('/attractions', (req, res) => {
  const line = String(req.query.line || '').trim();
  const cityId = Number(req.query.city_id || 0);
  const q = String(req.query.q || '').trim();
  let page = Math.max(1, Number(req.query.page) || 1);
  let pageSize = Number(req.query.page_size) || 10;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
  pageSize = Math.min(100, Math.floor(pageSize));

  const cond = ['1=1'];
  const args = [];
  if (line) { cond.push('c.line=?'); args.push(line); }
  if (cityId) { cond.push('a.city_id=?'); args.push(cityId); }
  if (q) { cond.push('a.name LIKE ?'); args.push(`%${q}%`); }
  const where = 'WHERE ' + cond.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM attractions a JOIN cities c ON c.id=a.city_id ${where}`).get(...args).c;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) page = pages;
  const rows = db.prepare(`
    SELECT a.*, c.name city, c.line line FROM attractions a JOIN cities c ON c.id=a.city_id
    ${where}
    ORDER BY a.must DESC, c.line='国内' DESC, c.id LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ total, page, page_size: pageSize, pages, attractions: rows });
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
  // 新录入的景点顺手解析坐标（失败不影响录入）；国际线路城市没有高德数据，跳过
  const cityRow = db.prepare('SELECT line FROM cities WHERE id=?').get(Number(city_id));
  if (!cityRow || cityRow.line === '国内') amap.backfillAttraction(row.id).catch(() => {});
  res.json({ attraction: row });
});

r.put('/attractions/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attractions WHERE id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: '景点不存在' });
  const b = req.body || {};
  db.prepare('UPDATE attractions SET name=?, type=?, level=?, ticket=?, hours=?, must=?, note=?, intro=?, intro_source=?, intro_url=? WHERE id=?')
    .run(b.name !== undefined ? String(b.name).trim() : a.name, b.type !== undefined ? String(b.type) : a.type,
      b.level !== undefined ? String(b.level) : a.level, b.ticket !== undefined ? String(b.ticket) : a.ticket,
      b.hours !== undefined ? String(b.hours) : a.hours, b.must !== undefined ? (b.must ? 1 : 0) : a.must,
      b.note !== undefined ? String(b.note) : a.note,
      b.intro !== undefined ? String(b.intro).slice(0, 2000) : a.intro,
      // 署名字段显式传才改（手工修介绍默认沿用原条目来源；CC BY-SA 要求署名跟随文本）
      b.intro_source !== undefined ? String(b.intro_source).slice(0, 50) : a.intro_source,
      b.intro_url !== undefined ? String(b.intro_url).slice(0, 500) : a.intro_url,
      a.id);
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
  const info = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must,lng,lat,amap_poi_id,address,rating) VALUES(?,?,?,?,?,?,0,?,?,?,?,?)')
    .run(Number(city_id), String(poi.name), String(poi.type || '景点').split(';')[0], '', String(poi.ticket || ''), '',
      loc ? loc.lng : null, loc ? loc.lat : null, String(poi.id || ''), String(poi.address || ''), String(poi.rating || ''));
  res.json({ attraction: db.prepare('SELECT * FROM attractions WHERE id=?').get(info.lastInsertRowid) });
});

// ---- v1.7.0 景点信息补全（admin）----
// 高德 POI 落库（有则跳过同名，无则新增；已有行只补空字段，不覆盖管理员维护值）
function upsertPoi(cityId, p) {
  const name = String(p.name || '').trim();
  if (!name || !p.location) return 'skip';
  const exist = db.prepare('SELECT id FROM attractions WHERE city_id=? AND name=?').get(cityId, name);
  if (exist) return 'skip';
  db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must,lng,lat,amap_poi_id,address,rating) VALUES(?,?,?,?,?,?,0,?,?,?,?,?)')
    .run(cityId, name, String(p.type || '景点').split(';')[0], '', String(p.ticket || ''), '',
      p.location.lng, p.location.lat, String(p.id || ''), String(p.address || ''), String(p.rating || ''));
  return 'insert';
}

// 站点名串（错误文案里点名是哪些站点连不上，别让用户以为「维基」是个抽象概念）
function wikiSiteNames() {
  return (wiki.SITES || []).map((s) => s.label).join(' / ');
}

// 单个景点补介绍（维基旅行→维基百科）。v1.11.1 起三种结局说三句不同的话：
//   命中 → 200 带 intro/source/url；两家都答「没这条」→ 200 miss:true；
//   两家都**连不上** → 502「维基连不上」——老版本这里回的是 miss:true，界面显示「暂无条目」，
//   等于把网络问题骗成内容问题（国内访问不到维基，于是每条都显示「暂无条目」）。
r.post('/attractions/:id/enrich-intro', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const a = db.prepare('SELECT * FROM attractions WHERE id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: '景点不存在' });
  let got;
  try {
    got = await wiki.fetchIntroEx(a.name);
  } catch (e) {
    return res.status(502).json({ error: '介绍抓取失败：' + e.message });
  }
  if (got.netFail) {
    return res.status(502).json({
      error: `维基连不上（${wikiSiteNames()} 在这台服务器上访问不到）——不是「这条没条目」，等网络能连上时再试`,
      code: 'WIKI_UNREACHABLE',
    });
  }
  if (got.hit) {
    db.prepare('UPDATE attractions SET intro=?, intro_source=?, intro_url=? WHERE id=?')
      .run(got.hit.text, got.hit.source, got.hit.url, a.id);
    return res.json({ ok: true, source: got.hit.source, url: got.hit.url, intro: got.hit.text });
  }
  res.json({ ok: true, source: '', url: '', intro: '', miss: true });
});

// 只读连通探针（admin）：分清「维基连不上」和「这条景点真没条目」。**不写库**。
r.get('/wiki/probe', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '维基连通探测仅管理员' });
  res.json(await wiki.probeSites(String((req.query || {}).q || '故宫博物院')));
});

// 城市一键补全（admin）：国内=高德「风景名胜」分类检索导入（两页共 50 条，去重留新）+
// 全市缺介绍的景点补维基介绍；国际线=只补介绍（高德无海外数据）。
// v1.11.1：介绍段**有预算、连不上就快停**（见 services/introBackfill.js）。老版本这里是
// 「最多 40 条 × 单条最坏 32 秒 ≈ 21 分钟」塞在一个 HTTP 请求里 → 反代 60 秒就断，
// 前端把失败吞掉，界面永远等不到结果（这就是「一键补全卡着不动」）。
// body 可选两个开关（都是前端轮次驱动用的，不传就是老行为）：
//   { skip_intro: true }  只导入景点、不做介绍（前端判定维基整片连不上后，后续城市省掉每城十几秒白等）
//   { only_intro: true }  只补介绍、不再跑高德（第 2 轮起，避免重复拉同一批 POI）
r.post('/cities/:id/backfill', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const c = db.prepare('SELECT * FROM cities WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '城市不存在' });
  const skipIntro = !!(req.body || {}).skip_intro;
  const onlyIntro = !!(req.body || {}).only_intro;
  const t0 = Date.now();
  const out = {
    city: c.name, line: c.line || '国内', imported: 0, skipped: 0,
    intro_ok: 0, intro_miss: 0, intro_tried: 0, intro_error: '', intro_left: 0,
    wiki_unreachable: false, intro_budget_out: false, skip_intro: skipIntro, only_intro: onlyIntro, elapsed_ms: 0,
  };
  const addErr = (m) => { out.intro_error = out.intro_error ? out.intro_error + '；' + m : m; };

  // ① 高德批量导入（仅国内——高德无海外 POI 数据）
  if (!onlyIntro && (c.line || '国内') === '国内') {
    try {
      for (const page of [1, 2]) {
        const pois = await amap.searchPoi({ keywords: '', city: c.name, offset: 25, page, types: '110000' });
        for (const p of pois) {
          const r = upsertPoi(c.id, p);
          out[r === 'insert' ? 'imported' : 'skipped']++;
        }
        if (pois.length < 25) break;
      }
    } catch (e) {
      addErr('高德导入失败：' + e.message); // 高德挂了不拦介绍补全
    }
  }

  // ② 维基介绍：该城市缺介绍的景点（上限 40 条/次），预算内能补几条补几条
  if (!skipIntro) {
    try {
      const need = db.prepare("SELECT id,name FROM attractions WHERE city_id=? AND intro='' ORDER BY must DESC, id LIMIT 40").all(c.id);
      const sum = await runIntroBackfill({
        need,
        fetch: (name) => wiki.fetchIntroEx(name),
        budgetMs: Number(process.env.ALLEYU_INTRO_BUDGET_MS) || 20000,
        onHit: (row, hit) => db.prepare('UPDATE attractions SET intro=?, intro_source=?, intro_url=? WHERE id=?')
          .run(hit.text, hit.source, hit.url, row.id),
      });
      out.intro_ok = sum.ok;
      out.intro_miss = sum.miss;
      out.intro_tried = sum.tried;
      out.wiki_unreachable = sum.unreachable;
      out.intro_budget_out = sum.budget_out;
      if (sum.stopped_by_error) addErr('介绍抓取失败：' + sum.error);
      else if (sum.unreachable) addErr(`维基连不上（${wikiSiteNames()} 在这台服务器上访问不到），剩余 ${Math.max(0, need.length - sum.tried)} 条介绍本次跳过——景点已导入`);
      else if (sum.budget_out) addErr(`时间预算用尽，本次只试了 ${sum.tried} 条介绍，可再点一次继续`);
    } catch (e) {
      addErr('介绍抓取失败：' + e.message);
    }
  }

  // 「还剩多少条没补」**无论上面成败都要如实数出来**（老版本只在成功路径里数，抛错时恒为 0，是假话）
  try {
    out.intro_left = db.prepare("SELECT COUNT(*) n FROM attractions WHERE city_id=? AND intro=''").get(c.id).n;
  } catch { /* 数不出来就别编数字 */ }
  out.elapsed_ms = Date.now() - t0;
  res.json(out);
});

module.exports = r;
