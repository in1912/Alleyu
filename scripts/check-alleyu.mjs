// 游巷自检：离线桩模式（ALLEYU_AI_STUB=1）跑全链路 API 断言。
// 用法：node scripts/check-alleyu.mjs [--online]
//  --online 追加真实外网断言（高德 POI/静态地图、Open-Meteo），消耗少量配额。
import { spawn } from 'node:child_process';
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
  // SSE 轮询读终态
  let guide = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const g = await req(`/api/guides/${gid}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { guide = g.j.guide; break; }
  }
  ok(guide && guide.status === 'done', '攻略生成完成（不超 90s）', guide ? guide.error : '超时');
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
