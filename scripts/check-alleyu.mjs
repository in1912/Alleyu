// 游巷自检：离线桩模式（ALLEYU_AI_STUB=1）跑全链路 API 断言。
// 用法：node scripts/check-alleyu.mjs [--online]
//  --online 追加真实外网断言（高德 POI/静态地图、Open-Meteo），消耗少量配额。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = 9690;
const BASE = `http://localhost:${PORT}`;
const ONLINE = process.argv.includes('--online');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? `：${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* png 等 */ }
  return { status: res.status, j, text, headers: res.headers };
}

// 极简 SSE 客户端（Node 无全局 EventSource）：收事件到流结束或超时
function sseCollect(urlPath, ms) {
  return new Promise((resolve) => {
    const events = [];
    const rq = http.get({ host: 'localhost', port: PORT, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          events.push([ev, data]);
        }
      });
      res.on('end', () => resolve(events));
    });
    rq.on('error', () => resolve(events));
    setTimeout(() => { rq.destroy(); resolve(events); }, ms);
  });
}

// ---- 起服务（独立 DATA_DIR，不碰真实数据） ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alleyu-check-'));
const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, ALLEYU_AI_STUB: '1', PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 未起 */ }
    await sleep(300);
  }
  return false;
}

try {
  console.log('== 启动（桩 AI，独立数据目录） ==');
  ok(await waitUp(), '服务启动 + /api/health');

  // ---- 鉴权 ----
  console.log('== 鉴权与免登录通道 ==');
  let r = await req('/api/cities');
  ok(r.status === 401, '未登录访问业务接口 401');
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  ok(r.status === 401, '错误密码 401');
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.j.token, 'admin 登录');
  const admin = r.j.token;
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const admin2 = r.j.token;
  r = await req('/api/amap/mapimg/deadbeefdeadbeefdeadbeef.png');
  ok(r.status === 404, 'EXEMPT：免登录图片直链（不存在→404 而非 401）');

  // ---- 用户/权限 ----
  console.log('== 用户与多租户权限 ==');
  r = await req('/api/users', { method: 'POST', token: admin, body: { username: 'u1', password: 'u123456', display_name: '用户一' } });
  ok(r.status === 200 && r.j.user && r.j.user.can_use_ai === false, 'admin 建普通用户 u1（默认无 AI 权）');
  const u1id = r.j.user.id;
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'u1', password: 'u123456' } });
  ok(r.status === 200 && r.j.token, 'u1 登录');
  const u1 = r.j.token;
  r = await req('/api/users', { token: u1 });
  ok(r.status === 403, 'u1 访问用户管理 403');
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '杭州', days: 2 } });
  ok(r.status === 403 && /权限/.test(r.j.error), 'u1 未开通 AI 生成攻略 403');

  // 页面权限白名单
  r = await req(`/api/users/${u1id}`, { method: 'PUT', token: admin, body: { allowed_pages: ['guides'] } });
  ok(r.status === 200 && r.j.user.allowed_pages.includes('guides'), 'admin 收窄 u1 页权限为 [guides]');
  r = await req('/api/cities', { token: u1 });
  ok(r.status === 403, 'u1 被收回 library 页 → /cities 403');
  r = await req('/api/guides', { token: u1 });
  ok(r.status === 200, 'u1 仍有 guides 页');

  // ---- 城市/景点库 ----
  console.log('== 城市景点库 ==');
  // 上面收窄过页权限，先恢复全开放再测库操作
  await req(`/api/users/${u1id}`, { method: 'PUT', token: admin, body: { allowed_pages: [] } });
  r = await req('/api/cities?q=' + encodeURIComponent('杭'), { token: admin });
  ok(r.status === 200 && r.j.cities.some((c) => c.name === '杭州'), '城市边查边搜「杭」命中杭州');
  const hz = r.j.cities.find((c) => c.name === '杭州');
  r = await req(`/api/cities/${hz.id}/attractions`, { token: admin });
  ok(r.status === 200 && r.j.attractions.length >= 5, '杭州景点库种子加载');
  r = await req('/api/attractions', { method: 'POST', token: u1, body: { city_id: hz.id, name: '测试景点XYZ', type: '人文', ticket: '免费' } });
  ok(r.status === 200 && r.j.attraction, '普通用户可补录景点');
  const testAttrId = r.j.attraction.id;
  r = await req(`/api/attractions/${testAttrId}`, { method: 'DELETE', token: u1 });
  ok(r.status === 403, '普通用户删景点 403（仅 admin）');
  r = await req(`/api/attractions/${testAttrId}`, { method: 'DELETE', token: admin });
  ok(r.status === 200, 'admin 删景点');
  r = await req('/api/cities', { method: 'POST', token: u1, body: { name: '测试市' } });
  ok(r.status === 403, '普通用户增城市 403（仅 admin）');

  // ---- 国际线路（v1.3.0 五线种子） ----
  console.log('== 国际线路种子 ==');
  r = await req('/api/cities/lines', { token: admin });
  const lineMap = {};
  for (const x of r.j.lines || []) lineMap[x.line] = x.c;
  ok(['欧洲线', '中亚线', '东亚线', '北美线', '南美线'].every((ln) => (lineMap[ln] || 0) >= 5), '五条国际线路城市数≥5（' + Object.entries(lineMap).map(([k, v]) => k + v).join(' ') + '）');
  r = await req('/api/cities?q=' + encodeURIComponent('巴黎') + '&line=' + encodeURIComponent('欧洲线'), { token: admin });
  ok(r.status === 200 && r.j.cities.length === 1 && r.j.cities[0].province === '法国' && r.j.cities[0].line === '欧洲线', '欧洲线检索巴黎（国家/线路字段）');
  const parisId = r.j.cities[0].id;
  r = await req(`/api/cities/${parisId}/attractions`, { token: admin });
  ok(r.j.attractions.length >= 4, '巴黎著名景点直接入库（≥4）');

  // ---- AI 配置与 Key 优先级 ----
  console.log('== AI 配置（加密 + 优先级） ==');
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: 'https://api.example.com/v1', model: 'test-model', key: 'sk-global-test' } });
  ok(r.status === 200, 'admin 写全局 AI 配置');
  r = await req('/api/ai/global', { token: admin });
  ok(r.j.has_key === true && !JSON.stringify(r.j).includes('sk-global-test'), '全局配置回读只报 has_key，不回明文');
  r = await req('/api/ai/config', { method: 'PUT', token: admin, body: { base_url: 'https://personal.example.com/v1', model: 'my-model', key: 'sk-personal-test' } });
  ok(r.status === 200, '写个人 AI 配置');
  r = await req('/api/ai/status', { token: admin });
  ok(r.j.personal && r.j.effective_source === 'personal', 'Key 优先级：个人优先');
  r = await req('/api/ai/config', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });
  r = await req('/api/ai/status', { token: admin });
  ok(r.j.effective_source === 'global', '清空个人后回落全局');
  r = await req('/api/ai/global', { token: u1 });
  ok(r.status === 403, '普通用户读全局配置 403');
  r = await req('/api/ai/config', { token: u1 });
  ok(r.status === 200 && r.j.has_key === false && r.j.base_url === '', '普通用户读自己配置（空）');

  // ---- 高德 Key 设置 ----
  console.log('== 高德 Key 设置 ==');
  r = await req('/api/settings', { token: u1 });
  ok(r.status === 403, '普通用户读设置 403');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { amap_key: 'not-hex-zzz' } });
  ok(r.status === 400, '高德 Key 非法格式 400');
  r = await req('/api/settings/amap/reset', { method: 'POST', token: admin });
  ok(r.status === 200 && r.j.ok === true, '恢复内置高德 Key');

  // v1.1.0 起桩是「无配置时兜底」：配了真实 Key 一律走真接口。
  // 下面攻略生成要走桩，必须先清掉全局配置（上面写入的是假地址 example.com）
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });
  ok(r.status === 200, '清空全局 AI 配置（让桩兜底生效）');
  r = await req('/api/ai/status', { token: admin });
  ok(r.j.effective_source === 'none', '清空后 effective_source=none');

  // ---- 攻略生成（桩） ----
  console.log('== 攻略生成（桩 AI 全链路） ==');
  await req(`/api/users/${u1id}`, { method: 'PUT', token: admin, body: { allowed_pages: [], can_use_ai: true } });
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '杭州', days: 3, mustVisits: ['西湖', '灵隐寺'], month: '10', group: '家庭' } });
  ok(r.status === 200 && r.j.id, '开通权限后 u1 创建攻略');
  const gid = r.j.id;
  // SSE 轮询读终态（顺带记录 stage 流水，v1.4.0 进度条数据源）
  let guide = null;
  const stagesSeen = [];
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const g = await req(`/api/guides/${gid}`, { token: u1 });
    if (g.j.guide && g.j.guide.stage && !stagesSeen.includes(g.j.guide.stage)) stagesSeen.push(g.j.guide.stage);
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { guide = g.j.guide; break; }
  }
  ok(guide && guide.status === 'done', '攻略生成完成（不超 90s）', guide ? guide.error : '超时');
  ok(stagesSeen.length > 0, '生成过程暴露 stage 阶段（详情接口可见）', '见到：' + stagesSeen.join(','));
  if (guide && guide.status === 'done') {
    ok(guide.content.includes('## 一、旅行总览') && guide.content.includes('## 九、可选拓展'), '固定九模块框架齐');
    ok(/### Day 1｜/.test(guide.content), 'Day 小节标题格式');
    ok(guide.content.includes('天气推演') || guide.content.includes('天气研判') || guide.content.includes('逐日预报'), '天气块已插入');
    ok((guide.images || []).some((x) => x.type === 'cover' && String(x.url).includes('/api/amap/mapimg/')), '封面=全程路线地图（非随机照片）');
    ok(guide.content.includes('![封面地图]('), '封面地图插在正文顶部');
    ok((guide.images || []).some((x) => x.type === 'overview'), '总览地图');
    ok((guide.images || []).some((x) => x.type === 'route'), '每日路线图');
    ok((guide.images || []).some((x) => x.type === 'photo'), '景点实景照片');
    ok(guide.content.includes('## 生成来源') && guide.content.includes('https://lbs.amap.com') && guide.content.includes('https://open-meteo.com'), '页脚生成来源+来源链接');
  }
  // 多租户隔离：admin 看不到 u1 的攻略详情？——管理员也无权读他人攻略（本设计 guides 仅本人）
  r = await req(`/api/guides/${gid}`, { token: admin2 });
  ok(r.status === 404, '攻略按用户隔离（admin 也读不到 u1 的）');
  r = await req('/api/guides', { token: u1 });
  ok(r.j.guides.some((g) => g.id === gid), 'u1 列表含自己的攻略');

  // v1.4.0 SSE 快照协议：对已完成攻略开流，首拍必须是 reset 全文快照而非 delta 追加
  // （enrich 会在顶部前插封面地图——纯追加协议推不出封面还会重复中段；重连同理必须快照）
  const sseEvents = await sseCollect(`/api/guides/${gid}/stream?token=${encodeURIComponent(u1)}`, 8000);
  const firstContent = sseEvents.find(([nm]) => nm === 'reset' || nm === 'delta');
  ok(firstContent && firstContent[0] === 'reset', 'SSE 首拍=reset 全文快照（前插封面/重连不丢不重）');
  ok(sseEvents.some(([nm]) => nm === 'done'), 'SSE 终态 done 事件');
  const resetText = firstContent ? JSON.parse(firstContent[1]).text : '';
  ok(resetText.includes('![封面地图](') && resetText.indexOf('![封面地图](') < 100, '快照含顶部封面地图（守在页上看完生成也拿得到）');

  // ---- 国际线攻略（高德无海外底图 → 不插图，其余照常） ----
  console.log('== 国际线攻略（巴黎，桩 AI） ==');
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '巴黎', days: 2, mustVisits: ['卢浮宫', '埃菲尔铁塔'] } });
  ok(r.status === 200 && r.j.id, '创建国际线攻略（巴黎）');
  const igid = r.j.id;
  let ig = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const g = await req(`/api/guides/${igid}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { ig = g.j.guide; break; }
  }
  ok(ig && ig.status === 'done', '国际线攻略生成完成（不超 90s）', ig ? ig.error : '超时');
  if (ig && ig.status === 'done') {
    ok((ig.images || []).length === 0, '国际线不插高德图（无海外底图，护栏生效）');
    ok(ig.content.includes('## 生成来源') && ig.content.includes('国际线路目的地'), '国际线：生成来源页脚 + 无图说明行');
    ok(/卢浮宫/.test(ig.content) && /埃菲尔铁塔/.test(ig.content), '库内景点进 AI 上下文（正文含卢浮宫/埃菲尔铁塔）');
  }

  // ---- 空返回自动重试（v1.4.0） ----
  // 假 AI 服务器：第 1 次请求只回 [DONE]（空流），第 2 次才吐内容。
  // 复刻用户报障「AI 返回了空内容红字，再点一次就好了」→ 服务端必须自己重试而不是把错误甩给用户。
  console.log('== 空返回自动重试（假 AI 服务器） ==');
  let hits = 0;
  const fakeAi = http.createServer((qreq, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    if (hits === 1) {
      res.end('data: [DONE]\n\n'); // 首连即空：复现偶发故障
    } else {
      // 分 3 段各隔 400ms：让 write 阶段持续 >1s，轮询才能观察到（一次性吐完只有几毫秒）
      const parts = ['## 一、旅行总览\n', '重试后拿到的正文。', '东京一日走完浅草与涩谷。\n'];
      let i = 0;
      const t = setInterval(() => {
        if (i < parts.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
        } else {
          clearInterval(t);
          res.end('data: [DONE]\n\n');
        }
      }, 400);
    }
  });
  await new Promise((resolve) => fakeAi.listen(0, '127.0.0.1', resolve));
  const fakePort = fakeAi.address().port;
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${fakePort}`, model: 'fake-retry-model', key: 'sk-fake-retry' } });
  ok(r.status === 200, '全局配置指向假 AI 服务器');
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '东京', days: 1 } });
  ok(r.status === 200 && r.j.id, '创建东京攻略（走假 AI）');
  const rgid = r.j.id;
  let rg = null;
  const retryStages = [];
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${rgid}`, { token: u1 });
    if (g.j.guide && g.j.guide.stage && !retryStages.includes(g.j.guide.stage)) retryStages.push(g.j.guide.stage);
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { rg = g.j.guide; break; }
  }
  ok(hits === 2, '空返回后服务端自动重发（请求恰好 2 次，非 1 次报错也非 3 次）', `hits=${hits}`);
  ok(rg && rg.status === 'done', '重试后攻略完成', rg ? rg.error : '超时');
  if (rg && rg.status === 'done') {
    ok(rg.content.includes('重试后拿到的正文'), '正文来自第 2 次请求（真内容非桩）');
    ok(rg.stage === '', '完成后 stage 清空（进度条收尾）');
    ok(retryStages.includes('retry2'), '重试期间可见 retry2 阶段（前端会显示「自动重试中」）', '见到：' + retryStages.join(','));
    ok(retryStages.includes('write'), '写作阶段可见');
  }
  fakeAi.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });
  r = await req('/api/ai/status', { token: admin });
  ok(r.j.effective_source === 'none', '清空假配置（不影响后续段落）');

  // ---- 在线（真实外网） ----
  if (ONLINE) {
    console.log('== 在线真实接口 ==');
    r = await req('/api/poi?q=' + encodeURIComponent('西湖') + '&city=' + encodeURIComponent('杭州'), { token: admin });
    ok(r.status === 200 && r.j.pois.length > 0 && r.j.pois[0].location, '高德 POI 检索（真实 Key）');
    r = await req('/api/settings/amap/test', { method: 'POST', token: admin, body: {} });
    ok(r.status === 200 && r.j.ok === true, '高德 Key 连通测试（种子 Key 真连）');
    r = await req('/api/weather?q=' + encodeURIComponent('杭州') + '&mode=forecast&days=5', { token: admin });
    ok(r.status === 200 && r.j.daily && r.j.daily.length >= 4, 'Open-Meteo 预报');
    r = await req('/api/weather?q=' + encodeURIComponent('昆明') + '&mode=history&month=3', { token: admin });
    ok(r.status === 200 && r.j.stats && r.j.stats.sampleDays >= 20, '历史同月推演（样本≥20 天）');
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) {
    console.log('失败项：\n' + fails.map((f) => '  - ' + f).join('\n'));
    console.log('\n服务端日志（尾部）：\n' + serverLog.slice(-2000));
  }
} finally {
  child.kill();
}
process.exit(fail ? 1 : 0);
