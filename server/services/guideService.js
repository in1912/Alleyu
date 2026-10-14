// 攻略生成编排：固定九模块框架提示词（用户提供的原文模板）→ AI 流式输出 →
// 图文增强（天气表 / 总览地图 / 每日路线图 / 景点实景照片，全部经高德生成）。
// 原则：增强失败绝不连累攻略本身——AI 正文生成成功即算成功，每步增强独立 try/catch。
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const ai = require('./aiService');
const amap = require('./amapService');
const weather = require('./weatherService');

// ---------- 固定输出框架（用户原文，逐字保留） ----------
const FRAMEWORK = `# 【目的地】X日游完整攻略
## 一、旅行总览
1.旅行主题
2.最佳出行月份、天气提醒
3.总预算参考（拆分：交通、住宿、吃饭、门票、其他）
4.路线逻辑说明（不走回头路原则）

## 二、交通指南
1.大交通：抵达站点、往返建议
2.当地内部交通：地铁/公交/打车/自驾要点，景点之间车程、耗时
3.省钱交通小技巧

## 三、住宿建议
1.推荐住宿片区（优势+适合人群）
2.避坑片区
3.选房小贴士、预订时机

## 四、每日详细行程（Day1‑Day X）
>每一天结构：【当日主题】
-上午：景点｜游玩时长｜门票预约｜看点提示
-午餐：美食街区/店铺类型、特色菜
-下午：景点｜游玩时长｜门票预约｜看点提示
-晚餐：本地特色美食推荐
-晚上：夜景/夜市/休闲活动
-✅当日小贴士：走路多少、预约、雨天备选方案

## 五、美食清单
必吃本地菜、特色小吃；推荐区域；避雷餐饮；饮食注意

## 六、门票&预约提醒
哪些景点必须提前预约；购票渠道；优惠证件；闭馆时间

## 七、行前准备清单
证件、衣物、随身物品；手机APP；必备工具

## 八、避坑&安全贴士
常见套路、消费坑；出行安全；本地习俗提醒

## 九、可选拓展
时间多可以去哪里；时间紧张可以砍掉哪些景点`;

const SYSTEM_PROMPT = '你是专业旅行规划师，根据以下条件生成一份完整实用旅游攻略。严格使用固定结构输出，markdown排版，信息落地可直接照着出行，不要空洞抒情，增加预约、耗时、避坑信息。';

// ---------- 提示词组装 ----------
function paramsBlock(p) {
  const lines = [
    `目的地：${p.destination}`,
    `出行天数：${p.days}天`,
    `出发城市：${p.departure || '未指定'}`,
    `出行人群：${[p.group, p.ages].filter(Boolean).join('，') || '未指定'}`,
    `预算档位：${p.budget || '舒适'}`,
    `旅行偏好：${(p.preferences || []).join('、') || '未指定'}`,
    `出行方式：${p.transport || '未指定'}`,
    `必去景点：${(p.mustVisits || []).join('、') || '由你推荐'}`,
    `避开：${(p.avoid || []).join('、') || '无特别要求'}`,
    `出行季节/月份：${p.month || p.season || '未指定'}`,
    `其他特殊需求：${p.notes || '无'}`,
  ];
  if (p.startDate) lines.splice(2, 0, `出行日期：${p.startDate}${p.endDate ? ` 至 ${p.endDate}` : ''}`);
  return lines.join('\n');
}

// 城市景点库上下文：优先用户勾选的必去景点 + 该城市全部库内景点（供 AI 排线参考）
function libraryBlock(cityId) {
  if (!cityId) return '';
  const rows = db.prepare('SELECT name,type,level,ticket,hours,must FROM attractions WHERE city_id=? ORDER BY must DESC, id').all(cityId);
  if (!rows.length) return '';
  const list = rows.map((r) => `- ${r.name}（${r.type}${r.level ? '｜' + r.level : ''}${r.ticket ? '｜门票' + r.ticket : ''}${r.hours ? '｜建议' + r.hours : ''}）`).join('\n');
  return `\n\n【目的地景点库（门票/时长为库内维护值，写作时可直接引用）】\n${list}`;
}

function buildMessages(p, weatherCtx) {
  const user = `${paramsBlock(p)}${libraryBlock(p.cityId)}

${weather.weatherTextForPrompt(weatherCtx)}

严格使用下面固定结构输出，markdown排版，信息落地可直接照着出行，不要空洞抒情，增加预约、耗时、避坑信息。每日详细行程里的每个一天用「### Day N｜当日主题」作小节标题。不要输出任何图片链接（配图由系统自动插入）。

${FRAMEWORK}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---------- 生成主流程（fire-and-forget，进度落库，SSE 轮询读库） ----------
function generateGuide(guideId) {
  run(guideId).catch((e) => {
    try {
      db.prepare("UPDATE guides SET status='error', error=?, updated_at=datetime('now','localtime') WHERE id=?").run(String(e.message || e), guideId);
    } catch { /* 最后兜底也失败则无能为力 */ }
  });
}

async function run(guideId) {
  const g = db.prepare('SELECT * FROM guides WHERE id=?').get(guideId);
  if (!g || g.status === 'done') return;
  const params = JSON.parse(g.params_json || '{}');
  let cfg = ai.resolveConfig(g.user_id);
  if (!cfg && process.env.ALLEYU_AI_STUB === '1') cfg = { source: 'stub', baseUrl: '', model: 'stub', key: '' };
  if (!cfg) {
    throw new Error('当前没有可用的 AI 配置：请先在「设置→AI 配置」填写自己的接口，或联系管理员配置全局 Key 并开通使用权限');
  }

  // 天气上下文（生成前抓一次，流式期间与增强共用）
  const weatherCtx = await weather.buildWeatherContext({
    lat: params._lat, lng: params._lng, startDate: params.startDate, endDate: params.endDate,
    month: params.month,
  }).catch(() => ({ mode: 'none' }));

  db.prepare("UPDATE guides SET status='generating', model=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(cfg.model, guideId);

  // 流式生成，增量节流落库
  let content = '';
  let lastSave = Date.now();
  const save = (force) => {
    const now = Date.now();
    if (!force && now - lastSave < 600) return;
    lastSave = now;
    db.prepare("UPDATE guides SET content=?, updated_at=datetime('now','localtime') WHERE id=?").run(content, guideId);
  };
  for await (const delta of ai.streamChat(cfg, buildMessages(params, weatherCtx), { maxTokens: 9000 })) {
    content += delta;
    save(false);
  }
  save(true);
  if (!content.trim()) throw new Error('AI 返回了空内容（请检查模型名是否正确）');

  // 图文增强（每步独立容错）
  const enrichResult = await enrichGuide(guideId, params, content, weatherCtx).catch((e) => {
    console.warn('[guide] 增强失败（不影响攻略）:', e.message);
    return { content, images: [] };
  });

  // 生成来源页脚：无论增强成败都固定追加（每篇攻略都要交代内容和数据从哪来）
  const finalContent = enrichResult.content + sourceFooter(cfg);

  db.prepare("UPDATE guides SET content=?, images_json=?, status='done', error='', updated_at=datetime('now','localtime') WHERE id=?")
    .run(finalContent, JSON.stringify(enrichResult.images), guideId);
}

// 生成来源块：AI 模型出处 + 地图/天气数据来源链接（v1.2.0 用户要求）
function sourceFooter(cfg) {
  const srcLabel = { personal: '我的个人接口', global: '管理员全局接口', stub: '本地桩输出，非真实攻略' }[cfg.source] || '未知来源';
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  return `\n\n---\n\n## 生成来源\n\n- **AI 模型**：\`${cfg.model || '未知'}\`（${srcLabel}，OpenAI 兼容格式）\n- **地图与点位**：[高德开放平台](https://lbs.amap.com)（POI 检索 · 静态地图 · 实景照片）\n- **天气数据**：[Open-Meteo](https://open-meteo.com)（16 天预报 + 历史同月推演）\n- 内容由 AI 生成，请以实地与官方信息为准。生成时间：${ts}\n`;
}

// ---------- 图文增强 ----------
const MAPIMG_DIR = () => {
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'mapimg');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

async function fetchMapImage(spec) {
  const buf = await amap.fetchStaticMap(spec);
  const sha = crypto.createHash('sha1').update(amap.buildStaticMapUrl(spec)).digest('hex').slice(0, 24);
  const file = path.join(MAPIMG_DIR(), `${sha}.png`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { url: `/api/amap/mapimg/${sha}.png`, file };
}

// 从正文找景点库里的名字（按名字长度降序，避免「故宫」先于「故宫博物院」截胡）
function libraryAttractions(cityId) {
  if (!cityId) return [];
  return db.prepare('SELECT name,lng,lat,amap_poi_id FROM attractions WHERE city_id=?').all(cityId)
    .sort((a, b) => b.name.length - a.name.length);
}
function findPoiMentions(text, lib) {
  const found = [];
  for (const a of lib) {
    const at = text.indexOf(a.name);
    if (at >= 0 && !found.some((f) => f.name === a.name)) found.push({ ...a, at });
  }
  // 按正文首次出现顺序排＝行程顺序，全程连线按它走
  return found.sort((x, y) => x.at - y.at);
}
// 未在库中的名字不猜——路线图只画能定位的点。

// 坐标补全：库里没有坐标的，现场高德检索（不回填库，游客临时点位不污染库）
async function ensureCoords(pois, cityName) {
  const out = [];
  for (const p of pois) {
    if (p.lng != null && p.lat != null) { out.push(p); continue; }
    try {
      const hit = await amap.resolvePoi(p.name, cityName);
      if (hit && hit.location) out.push({ ...p, lng: hit.location.lng, lat: hit.location.lat, photo: hit.photo || '', ticket: hit.ticket || '' });
    } catch { /* 单点失败跳过 */ }
  }
  return out;
}

function weatherTableBlock(ctx) {
  if (!ctx) return '';
  if (ctx.mode === 'forecast' && ctx.daily && ctx.daily.length) {
    const rows = ctx.daily.map((d) => `| ${d.date.slice(5)} | ${d.emoji}${d.text} | ${d.tmin}~${d.tmax}℃ | ${d.rainProb == null ? '-' : d.rainProb + '%'} | ${d.wind}km/h |`).join('\n');
    let block = `\n\n| 出行日 | 天气 | 气温 | 降水概率 | 风速 |\n|---|---|---|---|---|\n${rows}\n`;
    if (ctx.advisories && ctx.advisories.length) {
      block += '\n**⚠️ 天气研判提醒**（基于预报数据的规则研判，非官方预警，出行前请复核）\n' + ctx.advisories.map((a) => `- ${a.text}`).join('\n');
    }
    return block;
  }
  if (ctx.mode === 'history' && ctx.stats) {
    const s = ctx.stats;
    return `\n\n> 🌤️ **出行期天气推演**（超出 16 天预报窗口，基于近 ${s.years} 年同月历史，样本 ${s.sampleDays} 天）：平均 ${s.tminAvg}~${s.tmaxAvg}℃，降雨日占比约 ${Math.round((s.rainDays / Math.max(s.sampleDays, 1)) * 100)}%${s.extremes ? `，极值高温 ${s.extremes.tmaxMax}℃/低温 ${s.extremes.tminMin}℃` : ''}。临近出行请再核实实时预报。\n`;
  }
  return '';
}

function photoLine(name, url) {
  return `![${name}实景](${url})`;
}
function proxiedPhoto(u) {
  return `/api/amap/photo?u=${encodeURIComponent(u)}`;
}

// 全程连接线：优先真实驾车路线；高德失败也必须有线——直连折线兜底
async function journeyLine(pois) {
  const pts = pois.map((p) => ({ lng: p.lng, lat: p.lat }));
  try {
    return await amap.drivingPolyline(pts);
  } catch {
    return pts.map((p) => [p.lng, p.lat]);
  }
}

// 按天切块：以「### Day」为界
function splitDays(content) {
  const lines = content.split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s*Day\s*\d+/i.test(lines[i])) {
      if (cur) cur.end = i - 1;
      cur = { start: i, end: lines.length - 1 };
      blocks.push(cur);
    }
  }
  return blocks;
}

async function enrichGuide(guideId, params, content, weatherCtx) {
  const images = [];
  const cityName = params.destination;
  const lib = libraryAttractions(params.cityId);

  // 1) 天气表插到「一、旅行总览」段末（「## 二、」之前）
  try {
    const wt = weatherTableBlock(weatherCtx);
    if (wt) {
      const idx = content.indexOf('\n## 二、');
      if (idx >= 0) content = content.slice(0, idx) + wt + content.slice(idx);
    }
  } catch (e) { console.warn('[enrich] 天气表失败:', e.message); }

  // 2) 全文景点识别 + 坐标
  let pois = [];
  try {
    pois = await ensureCoords(findPoiMentions(content, lib).slice(0, 12), cityName);
  } catch (e) { console.warn('[enrich] 景点定位失败:', e.message); }

  // 3) 总览地图（全部点位打标 + 全程路线连接线）
  if (pois.length >= 1) {
    try {
      const center = params._lng != null ? { lng: params._lng, lat: params._lat } : { lng: pois[0].lng, lat: pois[0].lat };
      const markers = pois.slice(0, 10).map((p, i) => ({ lng: p.lng, lat: p.lat, label: String(i + 1) }));
      let paths = [];
      if (pois.length >= 2) {
        const line = await journeyLine(pois);
        if (line.length >= 2) paths = [amap.downsample(line, 70)];
      }
      const img = await fetchMapImage({ center, zoom: 11, markers, paths });
      images.push({ type: 'overview', url: img.url });
      const idx = content.indexOf('\n## 二、');
      const anchor = idx >= 0 ? idx : content.length;
      content = content.slice(0, anchor) + `\n\n**📍 全程点位总览**（数字即下方行程顺序参考，连线为全程走向）\n\n${photoLine('路线总览', img.url)}\n` + content.slice(anchor);
    } catch (e) { console.warn('[enrich] 总览地图失败:', e.message); }
  }

  // 4) 每日路线图 + 当日景点实景（图比文多主要靠这里）
  if (pois.length >= 2) {
    const days = splitDays(content);
    for (let di = 0; di < days.length; di++) {
      const d = days[di];
      const dayText = content.split('\n').slice(d.start, d.end + 1).join('\n');
      const dayPois = await ensureCoords(findPoiMentions(dayText, lib).slice(0, 6), cityName).catch(() => []);
      if (!dayPois.length) continue;
      let insert = '';
      try {
        // 实景照片：每个点位最多 1 张，当日最多 3 张
        let photos = 0;
        for (const p of dayPois) {
          if (photos >= 3) break;
          let pu = p.photo || '';
          if (!pu) {
            const hits = await amap.searchPoi({ keywords: p.name, city: cityName, offset: 3 }).catch(() => []);
            pu = (hits.find((h) => h.photo) || {}).photo || '';
          }
          if (pu && amap.photoHostAllowed(pu)) {
            insert += `${photoLine(p.name, proxiedPhoto(pu))}\n`;
            images.push({ type: 'photo', day: di + 1, poi: p.name, url: proxiedPhoto(pu) });
            photos++;
          }
        }
      } catch (e) { console.warn(`[enrich] Day${di + 1} 照片失败:`, e.message); }
      try {
        if (dayPois.length >= 2) {
          const line = await amap.drivingPolyline(dayPois.map((p) => ({ lng: p.lng, lat: p.lat })));
          const pts = amap.downsample(line, 50);
          const cLat = dayPois.reduce((s, p) => s + p.lat, 0) / dayPois.length;
          const cLng = dayPois.reduce((s, p) => s + p.lng, 0) / dayPois.length;
          const img = await fetchMapImage({
            center: { lng: cLng, lat: cLat }, zoom: 12,
            markers: dayPois.map((p, i) => ({ lng: p.lng, lat: p.lat, label: String(i + 1) })),
            paths: [pts],
          });
          insert += `\n**🗺️ 当日路线**（${dayPois.map((p) => p.name).join(' → ')}）\n\n${photoLine('当日路线', img.url)}\n`;
          images.push({ type: 'route', day: di + 1, url: img.url, pois: dayPois.map((p) => p.name) });
        }
      } catch (e) { console.warn(`[enrich] Day${di + 1} 路线图失败:`, e.message); }
      if (insert) {
        const lines = content.split('\n');
        const at = Math.min(d.end + 1, lines.length);
        lines.splice(at, 0, insert.trimEnd());
        content = lines.join('\n');
        // 后续天块的位置因插入而偏移，重算
        for (let dj = di + 1; dj < days.length; dj++) { days[dj].start += insert.split('\n').length; days[dj].end += insert.split('\n').length; }
      }
    }
  }

  // 5) 封面（v1.2.0 起弃用随机搜的地标照片）：单色全程路线地图，
  //    所有要去的点位按行程顺序连线，前端以 grayscale 滤镜显示为单色
  if (pois.length >= 2) {
    try {
      const line = await journeyLine(pois);
      const center = params._lng != null
        ? { lng: params._lng, lat: params._lat }
        : {
            lng: pois.reduce((s, p) => s + p.lng, 0) / pois.length,
            lat: pois.reduce((s, p) => s + p.lat, 0) / pois.length,
          };
      const img = await fetchMapImage({
        center, zoom: 11, ink: true,
        markers: pois.slice(0, 10).map((p, i) => ({ lng: p.lng, lat: p.lat, label: String(i + 1) })),
        paths: line.length >= 2 ? [amap.downsample(line, 70)] : [],
      });
      const firstLineEnd = content.indexOf('\n');
      content = content.slice(0, firstLineEnd) + `\n\n![封面地图](${img.url})\n` + content.slice(firstLineEnd);
      images.unshift({ type: 'cover', url: img.url });
    } catch (e) { console.warn('[enrich] 封面地图失败:', e.message); }
  }

  return { content, images };
}

module.exports = { generateGuide, buildMessages, splitDays, findPoiMentions, FRAMEWORK };
