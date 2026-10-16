// 游巷自检：离线桩模式（ALLEYU_AI_STUB=1）跑全链路 API 断言。
// 用法：node scripts/check-alleyu.mjs [--online]
//  --online 追加真实外网断言（高德 POI/静态地图、Open-Meteo），消耗少量配额。
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
  env: { ...process.env, ALLEYU_AI_STUB: '1', PORT: String(PORT), DATA_DIR: dataDir, ALLEYU_WIKI_OFFLINE: '1' },
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
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'wpqadmin', password: 'wrong' } });
  ok(r.status === 401, '错误密码 401');
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'wpqadmin', password: 'admin123' } });
  ok(r.status === 200 && r.j.token, 'admin 登录');
  const admin = r.j.token;
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'wpqadmin', password: 'admin123' } });
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
  // v1.10.0 语义变更：城市/景点库的**只读** API 不再挂 library 页（library 已废，页面级管理员专属），
  // 因为攻略表单的目的地联想、游记向导的「边录边搜」都要用它，而普通用户只有 guides 页。
  // 写操作仍有行内 admin 闸门（下面 :133/:136 那组断言就是护栏）。设置/用户管理才是硬拒的。
  r = await req('/api/cities', { token: u1 });
  ok(r.status === 200, 'v1.10.0：景点库只读 API 对登录用户开放（攻略/游记表单依赖）');
  r = await req('/api/settings', { token: u1 });
  ok(r.status === 403, 'u1 被收窄后访问设置页 403（非管理员硬拒）');
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

  // ---- 景点分页浏览 + 信息扩容（v1.7.0：先线路后城市、未选城市=全部、分页 10/20/30/50） ----
  console.log('== 景点分页与信息扩容（v1.7.0） ==');
  r = await req('/api/attractions', { token: u1 });
  ok(r.status === 200 && r.j.page === 1 && r.j.page_size === 10 && r.j.attractions.length === 10, '未选城市默认展示全部，每页 10 条');
  ok(r.j.total > 100 && r.j.pages === Math.ceil(r.j.total / 10), `总数/页数自洽（${r.j.total} 条 ${r.j.pages} 页）`);
  ok(r.j.attractions.every((a) => a.city && a.line && 'intro' in a && 'intro_source' in a && 'intro_url' in a && 'address' in a && 'rating' in a), '行带城市/线路 + 介绍/署名/地址/评分字段');
  const p1ids = r.j.attractions.map((a) => a.id);
  r = await req('/api/attractions?page=2', { token: u1 });
  ok(r.j.page === 2 && r.j.attractions.length === 10 && !r.j.attractions.some((a) => p1ids.includes(a.id)), '第 2 页与第 1 页无重叠（可前后翻页）');
  r = await req('/api/attractions?page_size=50', { token: u1 });
  ok(r.j.page_size === 50 && r.j.attractions.length === 50, '每页 50 条生效');
  r = await req('/api/attractions?page_size=999', { token: u1 });
  ok(r.j.page_size === 100, '每页上限钳到 100');
  r = await req('/api/attractions?page=9999', { token: u1 });
  ok(r.j.page === r.j.pages && r.j.attractions.length <= 100, '越界页钳到最后一页');
  r = await req('/api/attractions?line=' + encodeURIComponent('欧洲线'), { token: u1 });
  ok(r.j.attractions.length > 0 && r.j.attractions.every((a) => a.line === '欧洲线') && r.j.total > 20, '线路过滤：只回欧洲线城市景点');
  r = await req('/api/attractions?city_id=' + parisId, { token: u1 });
  ok(r.j.attractions.length > 0 && r.j.attractions.every((a) => a.city === '巴黎' && a.city_id === parisId), '城市过滤：只回巴黎');
  r = await req('/api/attractions?q=' + encodeURIComponent('西湖'), { token: u1 });
  ok(r.j.total > 0 && r.j.attractions.every((a) => a.name.includes('西湖')), '景点名模糊搜索');
  r = await req('/api/cities', { token: u1 });
  ok(r.j.cities.some((c) => c.name === '杭州' && c.attr_count >= 6), '/cities 带每城景点数 attr_count');
  // 介绍编辑：登录用户可写介绍、不动署名字段；admin 显式传才改署名（页脚致谢数据源）
  r = await req(`/api/cities/${hz.id}/attractions`, { token: admin });
  ok(r.j.attractions.length >= 5, '杭州景点列表可读（编辑前情）');
  const xihu = r.j.attractions.find((a) => a.name === '西湖');
  ok(!!xihu, '找到西湖种子景点');
  r = await req(`/api/attractions/${xihu.id}`, { method: 'PUT', token: u1, body: { intro: '杭州西湖，世界文化遗产，湖光山色。' } });
  ok(r.status === 200 && r.j.attraction && r.j.attraction.intro === '杭州西湖，世界文化遗产，湖光山色。' && r.j.attraction.intro_source === '', '登录用户可编辑介绍（默认不动署名字段）', `status=${r.status} text=${(r.text || '').slice(0, 300)}`);
  r = await req(`/api/attractions/${xihu.id}`, { method: 'PUT', token: admin, body: { intro_source: '维基百科', intro_url: 'https://zh.wikipedia.org/wiki/%E8%A5%BF%E6%B9%96' } });
  ok(r.status === 200 && r.j.attraction && r.j.attraction.intro_source === '维基百科' && r.j.attraction.intro_url.includes('wikipedia.org'), 'admin 显式设置署名（CC BY-SA 署名进库）', `status=${r.status} body=${(r.text || '').slice(0, 300)}`);
  // 离线模式（ALLEYU_WIKI_OFFLINE=1）：补介绍优雅失败、话里说明离线——防「离线测试偷跑真网」（高德的老教训）
  r = await req(`/api/attractions/${xihu.id}/enrich-intro`, { method: 'POST', token: u1 });
  ok(r.status === 403, '普通用户补介绍 403');
  r = await req(`/api/attractions/${xihu.id}/enrich-intro`, { method: 'POST', token: admin });
  ok(r.status === 502 && /离线/.test(r.j.error || ''), '离线模式补介绍 502 且说明离线');
  r = await req(`/api/cities/${hz.id}/backfill`, { method: 'POST', token: u1 });
  ok(r.status === 403, '普通用户一键补全 403');
  r = await req(`/api/cities/${hz.id}/backfill`, { method: 'POST', token: admin });
  ok(r.status === 200 && r.j.imported === 0 && /高德/.test(r.j.intro_error || '') && /离线/.test(r.j.intro_error || ''), '离线+无Key 一键补全：不崩，高德/维基失败原因都交代');

  // ---- 动态线路（v1.7.0）：线路不再白名单——新线路名直接入库、可改可查 ----
  r = await req('/api/cities', { method: 'POST', token: admin, body: { name: '迪拜', province: '阿联酋', line: '中东线' } });
  ok(r.status === 200 && r.j.city && r.j.city.line === '中东线', '新增城市可用白名单外新线路（中东线）');
  const dubaiId = r.j.city.id;
  r = await req('/api/cities/lines', { token: u1 });
  ok(r.j.lines.some((x) => x.line === '中东线'), '/cities/lines 动态回传新线路');
  r = await req(`/api/cities/${dubaiId}`, { method: 'PUT', token: admin, body: { line: '非洲线' } });
  ok(r.status === 200 && r.j.city.line === '非洲线', '城市可重新分配线路（中东线→非洲线）');
  r = await req('/api/attractions', { method: 'POST', token: u1, body: { city_id: dubaiId, name: '哈利法塔' } });
  ok(r.status === 200, '新线路城市可录景点');
  r = await req('/api/attractions?line=' + encodeURIComponent('非洲线'), { token: u1 });
  ok(r.j.total >= 1 && r.j.attractions.every((a) => a.line === '非洲线' && a.city === '迪拜'), '景点跨城市接口按新线路过滤');

  // ---- 按线路拉取旅游城市（v1.10.1）：只补库里没有的种子城市，已有的一律跳过不改动 ----
  console.log('== 拉取旅游城市（v1.10.1） ==');
  r = await req('/api/cities/seed', { token: admin });
  ok(r.status === 200 && Array.isArray(r.j.lines) && r.j.lines.length >= 6, '/cities/seed 回六条线路的种子统计');
  ok(r.j.lines.every((s) => typeof s.total === 'number' && typeof s.have === 'number' && s.have + s.missing === s.total), '每条线路 total = have + missing 自洽');
  const seedDom = r.j.lines.find((s) => s.line === '国内');
  ok(seedDom && seedDom.total >= 40 && seedDom.missing === 0, `种子库齐全时国内缺 0 座（total=${seedDom && seedDom.total}）`);
  ok(r.j.lines.filter((s) => s.line !== '国内').every((s) => s.total >= 5), '五条国际线种子各 ≥5 座');
  r = await req('/api/cities/pull', { method: 'POST', token: u1, body: { line: '国内' } });
  ok(r.status === 403, '普通用户拉取城市 403（仅 admin）');
  r = await req('/api/cities/pull', { method: 'POST', token: admin, body: { line: '非洲线' } });
  ok(r.status === 200 && r.j.total === 0 && r.j.added === 0 && /没有内置种子/.test(r.j.note || ''), '自建线路（非洲线）无种子：如实回 0 并说明');
  // 删掉一座有种子景点的国内城市 → 拉取应把它连同种子景点一起补回
  r = await req('/api/cities?q=' + encodeURIComponent('成都'), { token: admin });
  const chengdu = r.j.cities.find((c) => c.name === '成都' && (c.line || '国内') === '国内');
  ok(!!chengdu && chengdu.attr_count >= 3, `找到成都且带种子景点（${chengdu && chengdu.attr_count} 条）`);
  const chengduAttrs = chengdu.attr_count;
  r = await req(`/api/cities/${chengdu.id}`, { method: 'DELETE', token: admin });
  ok(r.status === 200, '删掉成都（拉取前的缺口）');
  r = await req('/api/cities/seed', { token: admin });
  ok(r.j.lines.find((s) => s.line === '国内').missing === 1, '缺 1 座时 /cities/seed 如实报 missing=1');
  r = await req('/api/cities/pull', { method: 'POST', token: admin, body: { line: '国内' } });
  ok(r.status === 200 && r.j.added === 1 && r.j.added_names.includes('成都') && r.j.skipped === r.j.total - 1, '拉取只补缺失的城市（added=1，其余全跳过）');
  ok(r.j.attrs >= chengduAttrs, `新城市连带种子景点一起入库（attrs=${r.j.attrs}）`);
  r = await req('/api/cities?q=' + encodeURIComponent('成都'), { token: admin });
  const cd2 = r.j.cities.find((c) => c.name === '成都');
  ok(cd2 && cd2.province === '四川省' && (cd2.line || '国内') === '国内' && cd2.attr_count === chengduAttrs, '补回的成都：省份/线路/景点数与种子一致');
  r = await req('/api/cities/pull', { method: 'POST', token: admin, body: { line: '国内' } });
  ok(r.j.added === 0 && r.j.skipped === r.j.total, '再拉一次幂等：全跳过、added=0');
  // 已有城市**绝不覆盖**：手改省份后再拉，值不变
  await req(`/api/cities/${cd2.id}`, { method: 'PUT', token: admin, body: { province: '手改省' } });
  r = await req('/api/cities/pull', { method: 'POST', token: admin, body: { line: '国内' } });
  ok(r.j.added === 0, '城市已存在时不重复插入');
  r = await req('/api/cities?q=' + encodeURIComponent('成都'), { token: admin });
  ok(r.j.cities.find((c) => c.name === '成都').province === '手改省', '拉取不改动已存在城市的数据（手改的省份保留）');
  await req(`/api/cities/${cd2.id}`, { method: 'PUT', token: admin, body: { province: '四川省' } });

  // ---- AI 配置（v1.6.0 起全站只有管理员全局一份，个人配置已下线） ----
  console.log('== AI 配置（全局唯一 + 个人配置下线） ==');
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: 'https://api.example.com/v1', model: 'test-model', key: 'sk-global-test' } });
  ok(r.status === 200, 'admin 写全局 AI 配置');
  r = await req('/api/ai/global', { token: admin });
  ok(r.j.has_key === true && !JSON.stringify(r.j).includes('sk-global-test'), '全局配置回读只报 has_key，不回明文');
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: 'https://api.example.com/v1', model: 'test-model', key: '  sk-global-test \n' } });
  ok(r.status === 200, 'Key 带首尾空白/换行也收（cleanKey 全剥离）');
  r = await req('/api/ai/global', { token: u1 });
  ok(r.status === 403, '普通用户读全局配置 403');
  // 个人配置端点已删（v1.6.0）：全部 404
  r = await req('/api/ai/config', { method: 'PUT', token: admin, body: { base_url: 'https://personal.example.com/v1', model: 'my-model', key: 'sk-personal-test' } });
  ok(r.status === 404, '个人配置 PUT 已下线（404）');
  r = await req('/api/ai/config', { method: 'GET', token: admin });
  ok(r.status === 404, '个人配置 GET 已下线（404）');
  // v1.10.0：/ai/* 属设置页，非管理员在全局中间件就被 403（个人配置早已下线，这里是权限收口的证据）
  r = await req('/api/ai/config', { token: u1 });
  ok(r.status === 403, 'v1.10.0：普通用户连 /ai/* 都进不来（设置页收口）');
  r = await req('/api/ai/test', { method: 'POST', token: admin, body: {} });
  ok(r.status === 404, '个人配置 /ai/test 已下线（404）');
  r = await req('/api/ai/status', { token: admin });
  ok(r.status === 200 && r.j.effective_source === 'global' && r.j.personal === undefined, 'status 只认全局（无 personal 字段）');
  r = await req('/api/auth/me', { token: u1 });
  ok(r.j.user && r.j.user.has_personal_ai === undefined, '用户对象不再暴露 has_personal_ai');

  // ---- 高德 Key 设置 ----
  console.log('== 高德 Key 设置 ==');
  r = await req('/api/settings', { token: u1 });
  ok(r.status === 403, '普通用户读设置 403');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { amap_key: 'not-hex-zzz' } });
  ok(r.status === 400, '高德 Key 非法格式 400');
  r = await req('/api/settings/amap/reset', { method: 'POST', token: admin });
  ok(r.status === 200 && r.j.ok === true && r.j.amap_key_set === false, '清空高德 Key（v1.6.3 起无内置默认）');
  // v1.6.3 起无内置 Key：地图断言分两支——env AMAP_KEY 注入=完整地图链路（真实外网）；
  // 未注入=无 Key 优雅降级（攻略照常完成、不伪造任何地图图）。上面 reset 会清掉 env 种子，这里补回。
  const envAmapKey = String(process.env.AMAP_KEY || '').trim();
  if (envAmapKey) {
    await req('/api/settings', { method: 'PUT', token: admin, body: { amap_key: envAmapKey } });
  }
  const amapReady = !!envAmapKey;

  // v1.1.0 起桩是「无配置时兜底」：配了真实 Key 一律走真接口。
  // 下面攻略生成要走桩，必须先清掉全局配置（上面写入的是假地址 example.com）
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });
  ok(r.status === 200, '清空全局 AI 配置（让桩兜底生效）');
  r = await req('/api/ai/status', { token: admin });
  ok(r.j.effective_source === 'none', '清空后 effective_source=none');

  // ---- 攻略生成（桩） ----
  console.log('== 攻略生成（桩 AI 全链路） ==');
  // u1 全程给「不限次数」（-2）：本套件前面后面要为别的事生成十几篇，撞上默认 3 次会连锁失败；
  // 配额本身的行为由专门的「生成配额」组用一个新注册用户验证。
  await req(`/api/users/${u1id}`, { method: 'PUT', token: admin, body: { allowed_pages: [], can_use_ai: true, quota_guide: -2, quota_journal: -2 } });
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
    if (amapReady) {
      ok((guide.images || []).some((x) => x.type === 'cover' && String(x.url).includes('/api/amap/mapimg/')), '封面=全程路线地图（非随机照片）');
      ok(guide.content.includes('![封面地图]('), '封面地图插在正文顶部');
      ok((guide.images || []).some((x) => x.type === 'overview'), '总览地图');
      ok((guide.images || []).some((x) => x.type === 'route'), '每日路线图');
      ok((guide.images || []).some((x) => x.type === 'photo'), '景点实景照片');
    } else {
      ok(!(guide.images || []).some((x) => String(x.url).includes('/api/amap/mapimg/')), '无 Key：不产任何地图图（不伪造）');
      ok(!guide.content.includes('![封面地图]('), '无 Key：正文不插封面地图');
      ok(!(guide.images || []).some((x) => x.type === 'overview'), '无 Key：无总览图');
      ok(!(guide.images || []).some((x) => x.type === 'route'), '无 Key：无路线图');
      ok(!(guide.images || []).some((x) => x.type === 'photo'), '无 Key：无实景照片');
    }
    ok(guide.content.includes('## 生成来源') && guide.content.includes('https://lbs.amap.com') && guide.content.includes('https://open-meteo.com'), '页脚生成来源+来源链接');
    ok(guide.content.includes('景点介绍引用') && guide.content.includes('维基百科') && guide.content.includes('CC BY-SA'), '库内有维基介绍时页脚致谢（CC BY-SA 署名行）');
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
  if (amapReady) {
    ok(resetText.includes('![封面地图](') && resetText.indexOf('![封面地图](') < 100, '快照含顶部封面地图（守在页上看完生成也拿得到）');
  } else {
    ok(!resetText.includes('![封面地图]('), '无 Key：快照无封面地图（与降级口径一致）');
  }

  // ---- 生成中直播流（v1.5.0）----
  // v1.4.0 快照协议只对「已完成」攻略验证过 reset/done；生成中的 delta 直播从未直接验过
  // （render 曾在真 Key 环境跑，真实模型首字 20s+，直播断言形同虚设）。这里用慢速假 AI
  // 把 write 阶段拉长到 ~4s，直连 SSE 断言 stage/delta 真的在流里滚动。
  // 无人城=不在城市库 → 无坐标无月份 → 天气立即 mode:none，enrich 也无图可插，全程离线。
  console.log('== 生成中直播流（慢速假 AI） ==');
  let thinkingSeen = false; // v1.6.0：请求体必须带 thinking.type=disabled（推理模型把 token 吃进思考链 → 正文空）
  const fakeAiSlow = http.createServer((qreq, res) => {
    let raw = '';
    qreq.on('data', (c) => { raw += c; });
    qreq.on('end', () => {
      try { const b = JSON.parse(raw); if (b.thinking && b.thinking.type === 'disabled') thinkingSeen = true; } catch { /* 忽略 */ }
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const body = '# 【无人城】2日游完整攻略\n## 一、旅行总览\n' + '直播流慢速正文，逐段抵达。'.repeat(140) + '\n\n## 九、可选拓展\n收尾。\n';
    const parts = body.match(/[\s\S]{1,60}/g) || [];
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      } else {
        clearInterval(t);
        res.end('data: [DONE]\n\n');
      }
    }, 150);
  });
  await new Promise((resolve) => fakeAiSlow.listen(0, '127.0.0.1', resolve));
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${fakeAiSlow.address().port}`, model: 'fake-slow-model', key: 'sk-fake-slow' } });
  ok(r.status === 200, '全局配置指向慢速假 AI');
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '无人城', days: 2 } });
  const lgid = r.j.id;
  ok(r.status === 200 && lgid, '创建无人城攻略（慢速假 AI，无坐标全离线）');
  const live = await sseCollect(`/api/guides/${lgid}/stream?token=${encodeURIComponent(u1)}`, 9000);
  const stageEvs = live.filter(([nm]) => nm === 'stage').map(([, d]) => { try { return JSON.parse(d).stage; } catch { return ''; } });
  const deltas = live.filter(([nm]) => nm === 'delta').map(([, d]) => { try { return JSON.parse(d).text; } catch { return ''; } });
  const resetEv = live.find(([nm]) => nm === 'reset');
  ok(stageEvs.includes('write'), '直播流里看到 write 阶段事件', '见到：' + stageEvs.join(','));
  ok(deltas.length >= 2, '直播流 delta 事件成串滚动（600ms 节流落库→逐段推送）', `delta=${deltas.length}`);
  const assembled = (resetEv ? JSON.parse(resetEv[1]).text : '') + deltas.join('');
  ok(assembled.includes('直播流慢速正文') && assembled.length >= 300, 'reset+delta 拼回正文（believed 基线协议）', `len=${assembled.length}`);
  let lg = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${lgid}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { lg = g.j.guide; break; }
  }
  ok(lg && lg.status === 'done' && lg.content.length >= 1200, '慢速假 AI 攻略完成且够长');
  ok(thinkingSeen, '生成请求体带 thinking.type=disabled（推理模型思考链根治）');
  fakeAiSlow.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });

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
      // 分段各隔 400ms：让 write 阶段持续 >1s，轮询才能观察到（一次性吐完只有几毫秒）。
      // 内容要 ≥1200 字（v1.5.0 过短闸门：days=1 下限 1200，短稿会被当废稿重试）
      const parts = ['# 【东京】1日游完整攻略\n## 一、旅行总览\n', '重试后拿到的正文。', '东京一日走完浅草与涩谷。'.repeat(120) + '\n'];
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

  // ---- 过短内容自动重试 + 重新生成 + 提示词落库（v1.5.0） ----
  // 复现用户实测「北京 7 日游只生成 600 字」：流正常结束但严重偏短=废稿，必须重试；
  // 3 次全短 → error（详情页出现「重新生成」按钮）→ 原参数重跑成功。
  console.log('== 过短重试 + 重新生成 + 提示词（假 AI） ==');
  let mode = 'short'; // short=过短稿 / empty=永远空 / full=合格长文
  let hits2 = 0;
  const fakeAi2 = http.createServer((qreq, res) => {
    hits2++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    if (mode === 'empty') { res.end('data: [DONE]\n\n'); return; }
    const body = mode === 'short'
      ? '# 【东京】1日游完整攻略\n## 一、旅行总览\n只有几句话，模拟北京那种被网关截断的废稿。\n'
      : '# 【东京】1日游完整攻略\n## 一、旅行总览\n' + '行程正文，浅草到涩谷。'.repeat(200) + '\n\n## 九、可选拓展\n收尾。\n';
    const parts = body.match(/[\s\S]{1,300}/g) || [];
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      } else {
        clearInterval(t);
        res.end('data: [DONE]\n\n');
      }
    }, 120);
  });
  await new Promise((resolve) => fakeAi2.listen(0, '127.0.0.1', resolve));
  r = await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${fakeAi2.address().port}`, model: 'fake-short-model', key: 'sk-fake-short' } });
  ok(r.status === 200, '全局配置指向第二个假 AI');
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '东京', days: 1 } });
  const sgid = r.j.id;
  ok(r.status === 200 && sgid, '创建东京攻略（过短场景）');
  let sg = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${sgid}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { sg = g.j.guide; break; }
  }
  ok(hits2 === 3, '过短稿自动重试满 3 次（不存废稿）', `hits2=${hits2}`);
  ok(sg && sg.status === 'error' && /不完整|过短/.test(sg.error || ''), '3 次全短 → 报错且话里带原因', sg ? sg.error : '超时');
  // 提示词已随首次尝试落库（即使失败也交代发了什么）
  ok(sg && sg.prompt && sg.prompt.includes('专业旅行规划师') && sg.prompt.includes('东京'), '完整提示词落库（详情接口可见）');
  r = await req('/api/guides', { token: u1 });
  ok(!('prompt' in (r.j.guides[0] || {})), '列表接口不背提示词（只有详情给）');
  // 重新生成：换 full 模式，原参数原地重跑
  mode = 'full';
  r = await req(`/api/guides/${sgid}/regenerate`, { method: 'POST', token: u1 });
  ok(r.status === 200, 'POST /regenerate 接受（失败攻略）');
  let rg2 = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${sgid}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { rg2 = g.j.guide; break; }
  }
  ok(rg2 && rg2.status === 'done' && rg2.content.includes('行程正文'), '重新生成后出合格长文', rg2 ? rg2.error : '超时');
  r = await req(`/api/guides/${sgid}/regenerate`, { method: 'POST', token: u1 });
  ok(r.status === 200 || r.status === 409, '对已完成攻略可重生成（409=正好还在收尾）', `status=${r.status}`);
  fakeAi2.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });

  // ---- 分享链接 + 正文编辑（v1.6.0）----
  // 用最早那份桩生成的杭州攻略 gid（done，之后无人再动它；sgid 在上一节被二次
  // regenerate 后假 AI 已关，状态不可靠）
  console.log('== 分享链接与正文编辑（v1.6.0） ==');
  r = await req(`/api/guides/${gid}`, { token: u1 });
  ok(r.status === 200 && r.j.guide.status === 'done' && r.j.guide.content.length > 500, '分享对象=桩生成的 done 攻略');
  const baseContent = r.j.guide.content;
  r = await req(`/api/guides/${gid}/shares`, { token: u1 });
  ok(r.status === 200 && r.j.shares.length === 0, '分享列表初始为空');
  r = await req(`/api/guides/${gid}/shares`, { token: u1, method: 'POST', body: { mode: 'dynamic' } });
  ok(r.status === 200 && /^[0-9a-f]{32}$/.test(r.j.token) && r.j.mode === 'dynamic' && r.j.url === '/#/s/' + r.j.token, '创建动态分享（32hex 能力链接 + url）');
  const dynTok = r.j.token;
  r = await req(`/api/guides/${gid}/shares`, { token: u1, method: 'POST', body: { mode: 'static' } });
  ok(r.status === 200 && r.j.mode === 'static' && r.j.snapshot_len > 100, '创建静态分享（创建即落快照）');
  const stTok = r.j.token;
  r = await req(`/api/guides/${gid}/shares`, { token: u1, method: 'POST', body: { mode: '乱填' } });
  ok(r.status === 200 && r.j.mode === 'dynamic', '非法 mode 兜底为 dynamic');

  // 公开访问：EXEMPT 免登录通道，响应只给标题/模式/正文/时间
  r = await req('/api/share/' + dynTok);
  ok(r.status === 200 && r.j.title.includes('杭州') && r.j.mode === 'dynamic' && r.j.content.length > 500, '公开页免登录读动态分享');
  ok(!('prompt' in r.j) && !('images' in r.j) && !('params' in r.j) && !('destination' in r.j), '公开响应不带参数/提示词/图集（最小暴露）');
  r = await req('/api/share/' + stTok);
  ok(r.status === 200 && r.j.content.length > 500, '公开页读静态快照');

  // 编辑正文：动态跟随、静态冻结、可手动刷新
  const edited = baseContent + '\n\n## 编辑标记段\n这是手动编辑后追加的内容。\n';
  r = await req(`/api/guides/${gid}`, { token: u1, method: 'PUT', body: { content: edited } });
  ok(r.status === 200 && r.j.ok === true, '保存编辑后的 Markdown 原文');
  r = await req('/api/share/' + dynTok);
  ok(r.j.content && r.j.content.includes('编辑标记段'), '动态链接自动跟随编辑');
  r = await req('/api/share/' + stTok);
  ok(r.j.content && !r.j.content.includes('编辑标记段'), '静态快照冻结不动');
  r = await req(`/api/guides/${gid}/shares/${stTok}`, { token: u1, method: 'PUT' });
  ok(r.status === 200 && r.j.snapshot_len === edited.length, '手动刷新静态快照（回新 snapshot_len）');
  r = await req('/api/share/' + stTok);
  ok(r.j.content && r.j.content.includes('编辑标记段'), '刷新后快照追上当前内容');

  // ---- 导出 PDF（v1.6.1）：服务端 pdfkit 直出附件下载 ----
  // 字体探针与本机环境走同一套（check 进程没有 DATA_DIR，系统字体路径是绝对的，够判可用性）
  console.log('== 导出 PDF（v1.6.1） ==');
  const requirePdf = createRequire(path.join(ROOT, 'package.json'));
  let fontsAvail = false;
  try { fontsAvail = !!requirePdf('./server/services/pdfService.js').findFonts(); } catch { /* 依赖缺失当没字体 */ }
  if (!fontsAvail) {
    console.log('  ⚠️ 本机无可用中文字体，PDF 断言跳过（端点逻辑由 401/404/409 部分覆盖）');
  } else {
    r = await req(`/api/guides/${gid}/pdf`, { token: u1 });
    ok(r.status === 200 && r.text.startsWith('%PDF') && r.text.length > 8000, '本人导出 PDF（%PDF 文件 >8KB）');
    ok((r.headers.get('content-type') || '').includes('application/pdf'), 'Content-Type: application/pdf');
    const cd = r.headers.get('content-disposition') || '';
    ok(cd.includes('attachment') && cd.includes("filename*=UTF-8''"), 'Content-Disposition 附件直下（attachment + filename*）');
    r = await req(`/api/guides/${gid}/pdf`);
    ok(r.status === 401, '未登录导出 PDF 401');
    r = await req(`/api/guides/${gid}/pdf`, { token: admin2 });
    ok(r.status === 404, '他人导出 PDF 404（攻略仅本人）');
    r = await req('/api/share/' + dynTok + '/pdf');
    ok(r.status === 200 && r.text.startsWith('%PDF') && (r.headers.get('content-disposition') || '').includes('attachment'), '分享页免登录导出 PDF（动态）');
    r = await req('/api/share/' + stTok + '/pdf');
    ok(r.status === 200 && r.text.startsWith('%PDF'), '分享页导出 PDF（静态快照）');
    r = await req('/api/share/deadbeefdeadbeefdeadbeefdeadbeef/pdf');
    ok(r.status === 404, '瞎编 token 要 PDF 404');
  }

  // 越权与非法
  r = await req(`/api/guides/${gid}`, { token: admin2, method: 'PUT', body: { content: 'x'.repeat(100) } });
  ok(r.status === 404, '他人编辑攻略 404（admin 也不行，攻略仅本人）');
  r = await req(`/api/guides/${gid}`, { token: u1, method: 'PUT', body: { content: '   ' } });
  ok(r.status === 400, '空内容编辑 400');
  r = await req(`/api/guides/${gid}/shares`, { method: 'POST', body: { mode: 'dynamic' } });
  ok(r.status === 401, '未登录建分享 401');
  r = await req(`/api/guides/${gid}/shares`, { token: admin2 });
  ok(r.status === 404, '他人看分享列表 404');
  r = await req(`/api/guides/${gid}/shares/${dynTok}`, { token: admin2, method: 'DELETE' });
  ok(r.status === 404, '他人撤销分享 404');

  // ---- v1.10.2：公开访问地址（分享链接域名）----
  // 起因：线上是裸 HTTP，navigator.clipboard 不存在 → 复制分享链接报
  // "Cannot read properties of undefined (reading 'writeText')"。前端已改成带回落的 copyText；
  // 这里管服务端这半：域名可配 + 所有登录用户都能读到（拼链接的不止管理员）。
  console.log('== 公开访问地址 / 分享链接域名（v1.10.2） ==');
  r = await req('/api/settings', { token: admin });
  ok(r.status === 200 && r.j.public_base_url === '', '设置页回传公开访问地址（默认空 = 跟随当前地址）');
  r = await req('/api/auth/me', { token: u1 });
  ok(r.status === 200 && r.j.share_base === '', '普通用户的 /auth/me 也带 share_base（默认空）');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { public_base_url: 'http://alleyu.in1912.cn/' } });
  ok(r.status === 200, 'admin 保存公开访问地址（末尾斜杠会被去掉）');
  r = await req('/api/settings', { token: admin });
  ok(r.j.public_base_url === 'http://alleyu.in1912.cn', '回读一致且已去尾斜杠');
  r = await req('/api/auth/me', { token: u1 });
  ok(r.j.share_base === 'http://alleyu.in1912.cn', '普通用户读到配好的 share_base（分享链接用得上）');
  r = await req('/api/auth/me');
  ok(r.status === 401, '未登录访问 /auth/me 仍 401（没因为加了 share_base 就放行）');
  for (const bad of ['alleyu.in1912.cn', 'ftp://x.com', 'http://a b.com']) {
    r = await req('/api/settings', { method: 'PUT', token: admin, body: { public_base_url: bad } });
    ok(r.status === 400, `非法公开访问地址 400（${bad}）`);
  }
  r = await req('/api/settings', { method: 'PUT', token: u1, body: { public_base_url: 'http://evil.test' } });
  ok(r.status === 403, '普通用户改公开访问地址 403');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { public_base_url: '' } });
  ok(r.status === 200, '留空可就地清掉（回落当前地址）');
  r = await req('/api/settings', { token: admin });
  ok(r.j.public_base_url === '', '清空后回读为空');

  // 生成中的攻略不能编辑/分享（409）：挂一只永不响应的假 AI 把攻略钉在 generating
  const fakeHang = http.createServer(() => { /* 收下请求，永不响应 */ });
  await new Promise((resolve) => fakeHang.listen(0, '127.0.0.1', resolve));
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${fakeHang.address().port}`, model: 'hang-model', key: 'sk-hang' } });
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '无人城', days: 1 } });
  const hgid = r.j.id;
  await sleep(1500);
  r = await req(`/api/guides/${hgid}`, { token: u1, method: 'PUT', body: { content: '编辑生成中的攻略'.repeat(30) } });
  ok(r.status === 409, '生成中的攻略编辑 409');
  r = await req(`/api/guides/${hgid}/shares`, { token: u1, method: 'POST', body: { mode: 'dynamic' } });
  ok(r.status === 409, '生成中的攻略建分享 409');
  r = await req(`/api/guides/${hgid}/pdf`, { token: u1 });
  ok(r.status === 409, '生成中的攻略导出 PDF 409');
  await req(`/api/guides/${hgid}`, { token: u1, method: 'DELETE' }); // 清掉挂死攻略
  fakeHang.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });

  // 撤销 + 删攻略级联
  r = await req(`/api/guides/${gid}/shares/${stTok}`, { token: u1, method: 'DELETE' });
  ok(r.status === 200 && r.j.revoked === true, '撤销静态分享');
  r = await req('/api/share/' + stTok);
  ok(r.status === 404, '撤销后公开访问 404');
  r = await req('/api/share/deadbeefdeadbeefdeadbeefdeadbeef');
  ok(r.status === 404, '瞎编的 token 404');
  r = await req(`/api/guides/${gid}/shares`, { token: u1 });
  ok(r.j.shares.length === 2, '列表剩 2 条（动态 + 兜底 dynamic）');
  await req(`/api/guides/${gid}`, { token: u1, method: 'DELETE' });
  r = await req('/api/share/' + dynTok);
  ok(r.status === 404, '删攻略后分享一并失效（手动级联）');

  // ---- 地图视野自适应（mapFit 纯函数，v1.5.0） ----
  console.log('== 地图视野自适应 ==');
  const require2 = createRequire(import.meta.url);
  const { fitView } = require2(path.join(ROOT, 'server', 'services', 'mapFit.js'));
  const bj = fitView([
    { lng: 116.024, lat: 40.359 }, // 八达岭长城（北京散点最北）
    { lng: 116.414, lat: 39.883 }, // 天坛（最南）
  ]);
  ok(bj && bj.zoom <= 10 && bj.zoom >= 4, '北京南北散点 → zoom 自适应到 ≤10（固定 11 裁点的老问题）', JSON.stringify(bj));
  ok(bj && Math.abs(bj.center.lat - (40.359 + 39.883) / 2) < 0.01, '中心=包围盒中心（不再钉在城市中心）');
  const single = fitView([{ lng: 116.4, lat: 39.9 }]);
  ok(single && single.zoom === 16, '单点 → 顶格 zoom16（最小跨度防失焦）', JSON.stringify(single));
  ok(fitView([]) === null, '空点位 → null（调用方回落）');

  // ---- 游记整理（v1.8.0）：CRUD/照片/配文/生成 SSE/标题封面/PDF/权限 ----
  console.log('== 游记整理（v1.8.0） ==');
  r = await req('/api/journals', {
    method: 'POST', token: u1,
    body: {
      destination: '杭州', city_id: null,
      meta: { origin: '上海', days: '3', people: '2 人', transport: '高铁', local_transport: '地铁公交', prefs: ['人文', '美食'], budget: '约3000元', hotel: '舒适连锁', season: '秋' },
      spots: [{ name: '西湖', attraction_id: null, note: '' }],
    },
  });
  ok(r.status === 200 && r.j.journal && r.j.journal.status === 'draft', '建游记草稿', JSON.stringify(r.j).slice(0, 200));
  const jid = r.j.journal.id;
  r = await req('/api/journals', { token: u1 });
  ok(r.status === 200 && r.j.journals.some((x) => x.id === jid) && r.j.journals[0].meta, '列表含新游记（meta 已展开）');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { meta: { origin: '上海虹桥', days: '4' }, spots: [{ name: '西湖' }, { name: '灵隐寺' }] } });
  ok(r.status === 200 && r.j.journal.meta.days === '4' && r.j.journal.spots.length === 2, 'PUT 草稿保存（meta/spots 更新）');

  // 照片：1x1 真 PNG
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await req(`/api/journals/${jid}/photos`, { method: 'POST', token: u1, body: { data_url: png1x1, spot: '西湖' } });
  ok(r.status === 200 && r.j.photo && r.j.photo.sort === 1, '上传 PNG 照片（sort=1）', JSON.stringify(r.j).slice(0, 200));
  const pid1 = r.j.photo.id;
  // 声明 png 实为 JPEG 字节 → magic byte 拦下
  const jpgAsPng = 'data:image/png;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64');
  r = await req(`/api/journals/${jid}/photos`, { method: 'POST', token: u1, body: { data_url: jpgAsPng } });
  ok(r.status === 400, '伪造扩展名照片 400（magic byte 校验）');
  // 超 8MB → 拒
  const big = Buffer.alloc(8 * 1024 * 1024 + 16, 7); big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  r = await req(`/api/journals/${jid}/photos`, { method: 'POST', token: u1, body: { data_url: 'data:image/png;base64,' + big.toString('base64') } });
  ok(r.status === 400, '超 8MB 照片 400');
  // 手写配文 / AI 配文（桩）
  r = await req(`/api/journals/${jid}/photos/${pid1}`, { method: 'PUT', token: u1, body: { caption: '清晨的湖面' } });
  ok(r.status === 200 && r.j.photo.caption === '清晨的湖面' && r.j.photo.caption_by === '', '手写配文落库（caption_by 空）');
  r = await req(`/api/journals/${jid}/photos/${pid1}/caption-ai`, { method: 'POST', token: u1, body: {} });
  ok(r.status === 200 && r.j.caption && r.j.caption_by === 'ai', 'AI 配文（桩 ~30 字）');
  r = await req(`/api/journals/${jid}/photos/${pid1}/caption-ai`, { method: 'POST', token: u1, body: { user_text: '风很大，帽子差点飞了' } });
  ok(r.status === 200 && r.j.caption_by === 'ai' && r.j.caption.length > 0, 'AI 参考用户稿重写配文');
  // 照片直链：带 token 200 / 不带 401
  r = await req(`/api/journals/${jid}/photos/${pid1}/file?token=${encodeURIComponent(u1)}`);
  ok(r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && r.text.length > 20, '照片直链（query token）');
  r = await req(`/api/journals/${jid}/photos/${pid1}/file`);
  ok(r.status === 401, '照片直链不带 token 401');

  // 无 AI 权用户：配文/生成被闸，草稿照常
  r = await req('/api/users', { method: 'POST', token: admin, body: { username: 'u2', password: 'u123456', display_name: '用户二' } });
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'u2', password: 'u123456' } });
  const u2 = r.j.token;
  r = await req('/api/journals', { method: 'POST', token: u2, body: { destination: '南京' } });
  const jid2 = r.j.journal.id;
  r = await req(`/api/journals/${jid2}/photos`, { method: 'POST', token: u2, body: { data_url: png1x1, spot: '' } });
  ok(r.status === 200, '无 AI 权用户可建草稿传照片');
  r = await req(`/api/journals/${jid2}/photos/${r.j.photo.id}/caption-ai`, { method: 'POST', token: u2, body: {} });
  ok(r.status === 403, '无 AI 权配文 403');
  r = await req(`/api/journals/${jid2}/generate`, { method: 'POST', token: u2, body: {} });
  ok(r.status === 403 && /权限/.test(r.j.error || ''), '无 AI 权生成 403');
  r = await req(`/api/journals/${jid}/generate`, { method: 'POST', token: u1, body: { merge_guide_id: 999999 } });
  ok(r.status === 400, '合并不存在的攻略 400');

  // 生成 → SSE 到 done → 终态断言
  r = await req(`/api/journals/${jid}/generate`, { method: 'POST', token: u1, body: {} });
  ok(r.status === 202, '提交生成 202（fire-and-forget）');
  const jsse = await sseCollect(`/api/journals/${jid}/stream?token=${encodeURIComponent(u1)}`, 8000);
  ok(jsse.some(([nm]) => nm === 'done'), '游记 SSE 终态 done');
  const jdone = jsse.find(([nm]) => nm === 'done');
  const jcontent = jdone ? JSON.parse(jdone[1]).content : '';
  ok(jcontent.includes('## ') && jcontent.length > 200, 'done 事件带全文（含小节标题）', `len=${jcontent.length}`);
  r = await req(`/api/journals/${jid}`, { token: u1 });
  const jd = r.j.journal;
  ok(jd.status === 'done' && jd.content.includes('photo:1'), '终态 done + 正文含 photo:1 占位（照片进上下文）');
  ok(jd.title && jd.title.length <= 20, `AI 标题 ≤20 字（「${jd.title}」）`);
  ok(jd.subtitle.includes('杭州') && jd.subtitle.includes('4'), '副标题带出行基础信息（目的地+天数）');
  ok(jd.cover_photo_id === pid1, '未手选封面 → 自动随机选一（本例唯一一张）');
  ok(jd.model === 'stub', '桩模式 model=stub（诚实披露）');

  // 二次编辑 / 标题 / 封面 / 配色
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { content: '# 手改版\n\n写完又改了两句。' } });
  ok(r.status === 200 && r.j.journal.content.startsWith('# 手改版'), '二次编辑正文');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { title: '手写的题' } });
  ok(r.status === 200 && r.j.journal.title === '手写的题', '手改标题');
  r = await req(`/api/journals/${jid}/title`, { method: 'POST', token: u1 });
  ok(r.status === 200 && r.j.title && r.j.title !== '手写的题' && r.j.title.length <= 20, `AI 重起标题（「${r.j.title}」）`);
  r = await req(`/api/journals/${jid}/cover`, { method: 'PUT', token: u1, body: { photo_id: pid1 } });
  ok(r.status === 200 && r.j.journal.cover_photo_id === pid1, '手选封面');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { palette: 99 } });
  ok(r.status === 200 && r.j.journal.palette === 5, '配色越界钳到 5');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { palette: 0 } });
  ok(r.status === 200 && r.j.journal.palette === 1, '配色 0 钳到 1');

  // ---- v1.9.0：三套文本 / 照片排序 / 景点体会 / 路线图 ----
  console.log('== 游记 v1.9.0（三套文本 · 排序 · 体会 · 路线） ==');
  // ① 三套文本：系统自动生成版（首次生成留档）+ 实时版（PUT 即存）+ 手动版（保存一版）
  r = await req(`/api/journals/${jid}`, { token: u1 });
  ok(r.j.journal.has_original === true && r.j.journal.original_len > 200, '系统生成版留档（「恢复原版」有料）', `len=${r.j.journal.original_len}`);
  ok(r.j.journal.content_original === undefined && r.j.journal.content_manual === undefined, '详情不回传两套备份全文（只给有无+字数）');
  ok(r.j.journal.has_manual === false, '没点过「保存一版」→ has_manual=false（前端置灰）');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { content: '# 实时版\n\n我又改了三句。' } });
  ok(r.status === 200 && r.j.journal.content.startsWith('# 实时版'), '实时版：编辑即存（自动保存走 PUT content）');
  r = await req(`/api/journals/${jid}/content/save-version`, { method: 'POST', token: u1, body: { content: '# 实时版\n\n我又改了三句。' } });
  ok(r.status === 200 && r.j.manual_len > 0, '保存一版 → 手动版单独存一份');
  r = await req(`/api/journals/${jid}`, { token: u1 });
  ok(r.j.journal.has_manual === true && r.j.journal.content === '# 实时版\n\n我又改了三句。', '保存一版不动实时版本身');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { content: '# 实时版\n\n又又又改了。' } });
  r = await req(`/api/journals/${jid}/content/restore`, { method: 'POST', token: u1, body: { which: 'manual' } });
  ok(r.status === 200 && r.j.content.includes('我又改了三句') && r.j.which === 'manual', '恢复一版 → 回到手动保存的那一份');
  r = await req(`/api/journals/${jid}`, { token: u1 });
  ok(r.j.journal.content.includes('我又改了三句'), '恢复后的正文已落库（刷新还在）');
  r = await req(`/api/journals/${jid}/content/restore`, { method: 'POST', token: u1, body: { which: 'original' } });
  ok(r.status === 200 && r.j.content.length > 200 && r.j.content.includes('## '), '恢复原版 → 回到系统最初生成的那份', `len=${(r.j.content || '').length}`);
  r = await req(`/api/journals/${jid}/content/restore`, { method: 'POST', token: u1, body: { which: 'nope' } });
  ok(r.status === 400, '恢复参数非法 400（which 只认 manual/original）');
  r = await req(`/api/journals/${jid2}/content/restore`, { method: 'POST', token: u2, body: { which: 'manual' } });
  ok(r.status === 400 && /保存/.test(r.j.error || ''), '没存过手动版 → 恢复失败但是人话 400');
  r = await req(`/api/journals/${jid2}/content/save-version`, { method: 'POST', token: u2, body: { content: '   ' } });
  ok(r.status === 400, '全空正文不许存一版');
  r = await req(`/api/journals/${jid}/content/save-version`, { method: 'POST', token: u1, body: {} });
  ok(r.status === 200 && r.j.manual_len > 200, '不带 content 则用库内实时版存一版（覆盖旧手动版）');

  // ② 照片排序：ids 必须恰好不重不漏，排完按新顺序重编 1..N（= photo:N 编号）
  r = await req(`/api/journals/${jid}/photos`, { method: 'POST', token: u1, body: { data_url: png1x1, spot: '灵隐寺' } });
  const pid2 = r.j.photo.id;
  ok(r.status === 200 && r.j.photo.sort === 2, '第二张照片 sort=2', JSON.stringify(r.j).slice(0, 160));
  r = await req(`/api/journals/${jid}/photos/order`, { method: 'PUT', token: u1, body: {} });
  ok(r.status === 400, '排序缺 ids 400');
  r = await req(`/api/journals/${jid}/photos/order`, { method: 'PUT', token: u1, body: { ids: [pid2] } });
  ok(r.status === 400, '排序漏传照片 400（防丢图）');
  r = await req(`/api/journals/${jid}/photos/order`, { method: 'PUT', token: u1, body: { ids: [pid1, pid1] } });
  ok(r.status === 400, '排序重复 id 400');
  r = await req(`/api/journals/${jid}/photos/order`, { method: 'PUT', token: u1, body: { ids: [pid1, 999999] } });
  ok(r.status === 400, '排序含不存在/他人照片 400');
  r = await req(`/api/journals/${jid}/photos/order`, { method: 'PUT', token: u1, body: { ids: [pid2, pid1] } });
  ok(r.status === 200 && r.j.photos[0].id === pid2 && r.j.photos[0].sort === 1 && r.j.photos[1].sort === 2,
    '换序后按新顺序重编 1..N（前台 photo:N 跟着变）', JSON.stringify(r.j.photos));
  r = await req(`/api/journals/${jid2}/photos/order`, { method: 'PUT', token: u2, body: { ids: [pid1, pid2] } });
  ok(r.status === 400, '排序不能跨篇（他人照片 id 进自己篇 400）');

  // ③ 景点体会：落库 + 进提示词（buildMessages 是纯函数，但 require 它会连带打开库——
  //    所以另起子进程把 DATA_DIR 指到临时目录跑，绝不碰真实 data/）
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { spots: [{ name: '西湖', note: '断桥边坐了一小时，柳絮吹了满脸' }, { name: '灵隐寺', note: '' }] } });
  ok(r.status === 200 && r.j.journal.spots[0].note.startsWith('断桥边'), '景点体会（note）落库并回传');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { spots: [{ name: '西湖', note: 'x'.repeat(900) }] } });
  ok(r.j.journal.spots[0].note.length === 500, '体会超长截断到 500 字');
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alleyu-prompt-'));
  let jsPrompt = '';
  try {
    jsPrompt = execFileSync(process.execPath, ['-e', `
      const js = require(${JSON.stringify(path.join(ROOT, 'server', 'services', 'journalService.js'))});
      const m = js.buildMessages({ destination: '杭州', meta_json: '{}', spots_json: JSON.stringify([
        { name: '西湖', note: '断桥边坐了一小时，柳絮吹了满脸' }, { name: '灵隐寺' }]) }, [], '');
      process.stdout.write(m.find((x) => x.role === 'user').content);
    `], { env: { ...process.env, DATA_DIR: probeDir, ALLEYU_WIKI_OFFLINE: '1' }, encoding: 'utf8' });
  } catch (e) {
    jsPrompt = '';
    console.log('  ⚠️ 提示词探针子进程失败：' + e.message);
  }
  fs.rmSync(probeDir, { recursive: true, force: true });
  ok(jsPrompt.includes('景点体会') && jsPrompt.includes('断桥边坐了一小时'), '景点体会进提示词（AI 融合素材）');
  ok(jsPrompt.includes('所到景点（按用户排定的顺序'), '景点顺序按用户排定喂给 AI（大纲顺序 = 正文分节顺序）');

  // ④ 路线连线：≥2 个有坐标的点才画；无 Key 时如实回原因而不是 500
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { spots: [{ name: '西湖' }, { name: '灵隐寺' }] } });
  r = await req(`/api/journals/${jid}/route`, { method: 'POST', token: u1 });
  if (amapReady) {
    ok(r.status === 200 && r.j.ok === true && r.j.url && /→/.test(r.j.summary || ''), '路线图：高德连线出图 + 文字摘要', JSON.stringify(r.j).slice(0, 240));
  } else {
    ok(r.status === 200 && r.j.ok === false && /高德 Key/.test(r.j.reason || ''), '无 Key：路线接口如实回原因（不 500）', JSON.stringify(r.j).slice(0, 200));
  }
  r = await req(`/api/journals/${jid}`, { token: u1 });
  ok(r.j.journal.route && r.j.journal.route.at && r.j.journal.route.ok === amapReady, '路线结果（含失败原因）缓存进 route_json——开页面不重打高德');
  r = await req(`/api/journals/${jid}`, { method: 'PUT', token: u1, body: { spots: [{ name: '西湖' }] } });
  r = await req(`/api/journals/${jid}/route`, { method: 'POST', token: u1 });
  ok(r.status === 200 && r.j.ok === false && /至少要 2 个景点/.test(r.j.reason || ''), '单景点不硬连线（如实说至少要 2 个）');
  r = await req('/api/cities', { method: 'POST', token: admin, body: { name: '测试海外城', province: '', line: '测试海外线' } });
  ok(r.status === 200 && r.j.city && r.j.city.line === '测试海外线', '建国际线路测试城市（线路不做白名单）');
  const intlCity = r.j.city.id;
  r = await req('/api/journals', { method: 'POST', token: u1, body: { destination: '测试海外城', city_id: intlCity, spots: [{ name: '甲' }, { name: '乙' }] } });
  const jid3 = r.j.journal.id;
  r = await req(`/api/journals/${jid3}/route`, { method: 'POST', token: u1 });
  ok(r.status === 200 && r.j.ok === false && /国际线路/.test(r.j.reason || ''), '国际线路：不画连线并说清原因（高德无海外底图）', JSON.stringify(r.j).slice(0, 200));
  r = await req('/api/cities/' + intlCity, { method: 'DELETE', token: admin });

  // 隔离 + PDF
  r = await req(`/api/journals/${jid}`, { token: admin2 });
  ok(r.status === 404, '游记按用户隔离（他人 404）');
  if (fontsAvail) {
    r = await req(`/api/journals/${jid}/pdf?mode=a4`, { token: u1 });
    ok(r.status === 200 && r.text.startsWith('%PDF') && r.text.length > 5000, '游记 PDF·A4（%PDF >5KB）');
    r = await req(`/api/journals/${jid}/pdf?mode=long`, { token: u1 });
    ok(r.status === 200 && r.text.startsWith('%PDF') && r.text.length > 5000, '游记 PDF·长图（%PDF >5KB）');
    r = await req(`/api/journals/${jid}/pdf`, { token: admin2 });
    ok(r.status === 404, '他人导出游记 PDF 404');
    r = await req(`/api/journals/${jid2}/pdf?mode=a4`, { token: u2 });
    ok(r.status === 409, '未完成的游记导 PDF 409');
  } else {
    console.log('  ⚠️ 无中文字体，游记 PDF 断言跳过');
  }

  // 删除：照片一并清
  r = await req(`/api/journals/${jid}`, { method: 'DELETE', token: u1 });
  ok(r.status === 200, '删除游记');
  r = await req(`/api/journals/${jid}/photos/${pid1}/file?token=${encodeURIComponent(u1)}`);
  ok(r.status === 404, '删除后照片直链 404');

  // ---- v1.10.0：邀请码与自助注册 ----
  console.log('== 邀请码与注册（v1.10.0） ==');
  r = await req('/api/invites', { method: 'POST', token: admin, body: { count: 1, max_uses: 1, note: '一次性-自检' } });
  ok(r.status === 200 && r.j.codes.length === 1 && /^[A-Z2-9]{8}$/.test(r.j.codes[0]), 'admin 生成一次性邀请码（8 位，去易混字符）');
  const onceCode = r.j.codes[0];
  ok(r.j.invites[0].max_uses === 1 && r.j.invites[0].used_count === 0 && r.j.invites[0].note === '一次性-自检' && r.j.invites[0].enabled === true,
    '邀请码回包带 使用次数/已用/备注/启用 四项');
  r = await req('/api/invites', { method: 'POST', token: admin, body: { count: 1, max_uses: 3, note: '三次码' } });
  const multiCode = r.j.codes[0];
  ok(r.j.invites[0].max_uses === 3, '可重复使用的邀请码（3 次）');
  r = await req('/api/invites', { method: 'POST', token: admin, body: { count: 2, max_uses: 5 } });
  ok(r.status === 200 && r.j.codes.length === 2 && new Set(r.j.codes).size === 2, '批量生成 2 个码且互不重复');
  r = await req('/api/invites', { method: 'POST', token: admin, body: { max_uses: 0 } });
  ok(r.status === 400, '使用次数 0 → 400（最小 1 = 一次性）');
  r = await req('/api/invites', { token: u1 });
  ok(r.status === 403, '普通用户读邀请码列表 403');
  r = await req('/api/invites', { method: 'POST', token: u1, body: { max_uses: 1 } });
  ok(r.status === 403, '普通用户生成邀请码 403');
  r = await req('/api/auth/register-open');
  ok(r.status === 200 && r.j.open === true, 'register-open 免登录可读，有可用码时 open=true');

  // 注册校验：五项全必填（用户定调），逐项给 400
  const goodReg = { username: 'reg_user_1', password: 'regpass123', email: 'reg1@example.com', display_name: '注册用户一', invite_code: onceCode };
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: '' } });
  ok(r.status === 400, '注册缺用户名 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'a b' } });
  ok(r.status === 400 && /用户名/.test(r.j.error || ''), '用户名非法字符 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, password: '123' } });
  ok(r.status === 400 && /密码/.test(r.j.error || ''), '注册密码太短 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, email: 'not-an-email' } });
  ok(r.status === 400 && /邮箱/.test(r.j.error || ''), '注册邮箱格式错 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, display_name: '' } });
  ok(r.status === 400 && /昵称/.test(r.j.error || ''), '注册缺昵称 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, invite_code: '' } });
  ok(r.status === 400 && /邀请码/.test(r.j.error || ''), '注册缺邀请码 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, invite_code: 'ZZZZZZZZ' } });
  ok(r.status === 400 && /无效|停用/.test(r.j.error || ''), '不存在的邀请码 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, invite_code: onceCode.toLowerCase() } });
  ok(r.status === 200 && r.j.token && r.j.user.role === 'user', '邀请码大小写不敏感 + 注册即登录（回 token）');
  const regU = r.j.token;
  const regUid = r.j.user.id;
  ok(r.j.user.username === 'reg_user_1' && r.j.user.display_name === '注册用户一' && r.j.user.email === 'reg1@example.com', '注册资料原样落库（用户名/昵称/邮箱）');
  ok(Array.isArray(r.j.user.allowed_pages) && r.j.user.allowed_pages.includes('guides') && r.j.user.allowed_pages.includes('weather') && r.j.user.can_use_ai === true,
    '新用户默认能用攻略+游记（can_use_ai=1）');
  ok(r.j.user.quota && r.j.user.quota.guide && typeof r.j.user.quota.guide.left === 'number', '/auth/me 带配额快照（生成页显示剩余次数用）');
  r = await req('/api/auth/login', { method: 'POST', body: { username: 'reg_user_1', password: 'regpass123' } });
  ok(r.status === 200 && r.j.token, '注册出来的账号能正常登录');
  // 注意：换一个用户名/邮箱——否则先撞「用户名已存在」，测不到码的语义
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'reg_once2', email: 'reg_once2@example.com' } });
  ok(r.status === 400 && /用完/.test(r.j.error || ''), '一次性码用过即废（同码再注册 400）');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'reg_user_2', email: 'reg2@example.com', invite_code: 'ZZZZZZZZ' } });
  ok(r.status === 400 && /无效/.test(r.j.error || ''), '换个用户名用错码照样 400（码不因用户名撞车而误判）');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'reg_user_1', email: 'other@example.com', invite_code: multiCode } });
  ok(r.status === 400 && /用户名已存在/.test(r.j.error || ''), '重复用户名 400');
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'reg_user_3', email: 'reg1@example.com', invite_code: multiCode } });
  ok(r.status === 400 && /邮箱/.test(r.j.error || ''), '重复邮箱 400');
  // 多次码：连用 3 次，第 4 次才拒
  let multiOk = 0;
  for (let i = 1; i <= 4; i++) {
    const rr = await req('/api/auth/register', { method: 'POST', body: { username: `reg_m${i}`, password: 'regpass123', email: `regm${i}@example.com`, display_name: `多次码${i}`, invite_code: multiCode } });
    if (rr.status === 200) multiOk++;
  }
  ok(multiOk === 3, '3 次码恰好可用 3 次（第 4 次被拒）', `成功 ${multiOk} 次`);
  r = await req('/api/auth/register', { method: 'POST', body: { ...goodReg, username: 'reg_m9', email: 'regm9@example.com', invite_code: multiCode } });
  ok(r.status === 400 && /用完/.test(r.j.error || ''), '用完的多次码明确回「已被用完」');
  r = await req('/api/invites', { token: admin });
  const usedMulti = (r.j.invites || []).find((x) => x.code === multiCode);
  ok(usedMulti && usedMulti.used_count === 3, '列表如实显示已用 3 次（管理员看得到谁用了几次）');
  // 停用 → 立刻不可注册
  r = await req('/api/invites', { method: 'POST', token: admin, body: { count: 1, max_uses: 2, note: '待停用' } });
  const offCode = r.j.codes[0];
  const offId = r.j.invites[0].id;
  r = await req('/api/invites', { method: 'PUT', token: admin, body: { enabled: false, note: '停用了' } });
  ok(r.status === 404, 'PUT 邀请码缺 id 落到别的路径（404 兜底，不误改）');
  r = await req(`/api/invites/${offId}`, { method: 'PUT', token: admin, body: { enabled: false, note: '停用了' } });
  ok(r.status === 200 && r.j.invite.enabled === false && r.j.invite.note === '停用了', '停用邀请码 + 改备注');
  r = await req('/api/auth/register', { method: 'POST', body: { username: 'reg_off', password: 'regpass123', email: 'regoff@example.com', display_name: '停用码', invite_code: offCode } });
  ok(r.status === 400 && /无效|停用/.test(r.j.error || ''), '停用后的码注册 400');
  r = await req(`/api/invites/${offId}`, { method: 'PUT', token: admin, body: { max_uses: 1 } });
  ok(r.status === 200 && r.j.invite.max_uses === 1, '已用 0 次的码可以把使用次数改成 1（合法）');
  r = await req(`/api/invites/${usedMulti.id}`, { method: 'PUT', token: admin, body: { max_uses: 1 } });
  ok(r.status === 400 && /不能小于/.test(r.j.error || ''), '已用 3 次的码不允许把上限降到 1（防语义矛盾）');
  r = await req(`/api/invites/${offId}`, { method: 'DELETE', token: admin });
  ok(r.status === 200, '删除邀请码');
  // 全部关掉 → 关注册（这是「库里无可用码就关注册」的核心行为）
  r = await req('/api/invites', { token: admin });
  const liveCodes = r.j.invites.filter((x) => x.enabled && x.used_count < x.max_uses);
  for (const c of liveCodes) await req(`/api/invites/${c.id}`, { method: 'PUT', token: admin, body: { enabled: false } });
  r = await req('/api/auth/register-open');
  ok(r.j.open === false, '无可用码时 register-open 回 false（注册页直接显示关注册提示）');
  r = await req('/api/auth/register', { method: 'POST', body: { username: 'reg_closed', password: 'regpass123', email: 'closed@example.com', display_name: '关注册', invite_code: 'ABCDEFGH' } });
  ok(r.status === 400 && /未开放注册/.test(r.j.error || ''), '关注册时注册请求 400 且说清「未开放注册」');
  for (const c of liveCodes) await req(`/api/invites/${c.id}`, { method: 'PUT', token: admin, body: { enabled: true } });
  r = await req('/api/auth/register-open');
  ok(r.j.open === true, '重新启用后又可注册（管理员一键开关）');

  // ---- v1.10.0：生成配额 ----
  console.log('== 生成配额（v1.10.0） ==');
  r = await req('/api/settings', { token: admin });
  ok(r.status === 200 && r.j.quota_default_guide !== undefined && r.j.quota_default_journal !== undefined, '设置页回传系统默认生成次数两项');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { quota_default_guide: '2', quota_default_journal: '4' } });
  ok(r.status === 200, 'admin 改系统默认次数');
  r = await req('/api/settings', { token: admin });
  ok(r.j.quota_default_guide === '2' && r.j.quota_default_journal === '4', '默认次数回读一致（攻略 2 / 游记 4）');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { quota_default_guide: 'abc' } });
  ok(r.status === 400, '默认次数非数字 400');
  r = await req('/api/settings', { method: 'PUT', token: admin, body: { quota_default_guide: '99999' } });
  ok(r.status === 400, '默认次数超上限 400（0~9999）');
  r = await req('/api/users', { token: admin });
  const regRow = (r.j.users || []).find((x) => x.id === regUid);
  ok(regRow && regRow.quota.guide.limit === 2 && regRow.quota.journal.limit === 4, '跟随默认的用户按系统默认算额度（2/4）');
  ok(regRow && regRow.guide_used === 0 && regRow.journal_used === 0 && regRow.tokens_total === 0, '用户管理列表带 已用次数 与 累计 token 字段');
  const adminRow = (r.j.users || []).find((x) => x.role === 'admin');
  ok(adminRow && adminRow.quota.guide.unlimited === true, '管理员自己恒不限次数（列表也这么显示）');

  // 失败不扣次数：假 AI 服务器恒回 500
  let badHits = 0;
  const badAi = http.createServer((qreq, res) => { badHits++; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); });
  await new Promise((resolve) => badAi.listen(0, '127.0.0.1', resolve));
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${badAi.address().port}`, model: 'fake-500', key: 'sk-fake-500' } });
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_guide: 1 } });
  ok(r.status === 200 && r.j.user.quota_guide === 1 && r.j.user.quota.guide.left === 1, 'admin 给单个用户设 1 次攻略额度');
  r = await req('/api/guides', { method: 'POST', token: regU, body: { destination: '苏州', days: 1 } });
  ok(r.status === 200 && r.j.id, '有名额时创建成功（闸门只拦超额的）');
  const bgid = r.j.id;
  let bg = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${bgid}`, { token: regU });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { bg = g.j.guide; break; }
  }
  ok(bg && bg.status === 'error', 'AI 全挂 → 攻略标记 error（不是无声失败）', bg ? bg.status : '超时');
  r = await req('/api/users', { token: admin });
  const afterFail = (r.j.users || []).find((x) => x.id === regUid);
  ok(afterFail.guide_used === 0 && afterFail.quota.guide.left === 1, '生成失败不扣次数（用户定调：成功才扣）');
  badAi.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });

  // ---- v1.10.0：累计 token 记账（本机 mock SSE 服务回 usage） ----
  console.log('== token 记账（v1.10.0） ==');
  // mock：正文分 4 段吐出，最后一拍按 OpenAI 兼容约定单独回 usage（choices 为空）
  const USAGE_IN = 137, USAGE_OUT = 512;
  const aiHits = [];
  const usageAi = http.createServer((qreq, res) => {
    aiHits.push(1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const body = '# 【苏州】1日游完整攻略\n\n## 一、旅行总览\n' + '行程正文，园林与水巷的走法。'.repeat(90) + '\n\n## 九、可选拓展\n收尾。\n';
    const parts = body.match(/[\s\S]{1,600}/g) || [];
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      } else {
        clearInterval(t);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: USAGE_IN, completion_tokens: USAGE_OUT } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    }, 100);
  });
  await new Promise((resolve) => usageAi.listen(0, '127.0.0.1', resolve));
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: `http://127.0.0.1:${usageAi.address().port}`, model: 'fake-usage', key: 'sk-fake-usage' } });
  r = await req('/api/users', { token: admin });
  const beforeTok = (r.j.users || []).find((x) => x.id === regUid);
  r = await req('/api/guides', { method: 'POST', token: regU, body: { destination: '扬州', days: 1 } });
  const tgid = r.j.id;
  ok(r.status === 200 && tgid, '配额还剩 1 次 → 正常创建（走 mock 真接口）');
  let tg = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${tgid}`, { token: regU });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { tg = g.j.guide; break; }
  }
  ok(tg && tg.status === 'done', 'mock AI 出稿（真接口，非桩）', tg ? tg.error : '超时');
  ok(tg && !tg.content.includes('AI 桩输出'), '正文来自 mock（不是桩兜底）', tg ? tg.content.slice(0, 40) : '无');
  r = await req('/api/users', { token: admin });
  const afterTok = (r.j.users || []).find((x) => x.id === regUid);
  ok(afterTok.tokens_in - beforeTok.tokens_in === USAGE_IN && afterTok.tokens_out - beforeTok.tokens_out === USAGE_OUT,
    `累计 token 恰好等于服务商报的数（+${afterTok.tokens_in - beforeTok.tokens_in}/+${afterTok.tokens_out - beforeTok.tokens_out}）`);
  ok(afterTok.tokens_total === afterTok.tokens_in + afterTok.tokens_out, '列表的 tokens_total = in + out（自洽）');
  ok(afterTok.guide_used === 1 && afterTok.quota.guide.left === 0, '这次成功才扣 1 次 → 剩余 0');
  r = await req('/api/guides', { method: 'POST', token: regU, body: { destination: '南京', days: 1 } });
  ok(r.status === 403 && /已用完/.test(r.j.error || '') && /共 1 次/.test(r.j.error || ''), '额度用尽 → 403 且话里带「已用完（共 1 次）」', r.j.error);
  r = await req(`/api/guides/${tgid}/regenerate`, { method: 'POST', token: regU });
  ok(r.status === 403, '用尽后重新生成同样 403（不能绕闸）');
  r = await req(`/api/guides/${tgid}`, { token: regU });
  ok(r.j.guide.status === 'done' && r.j.guide.content.includes('园林与水巷'), '被拒的请求没动已有攻略（原地重跑也没发生）');
  // 管理员自己也记 token（用户点名：包括管理员自己）
  r = await req('/api/users', { token: admin });
  const aBefore = (r.j.users || []).find((x) => x.role === 'admin');
  r = await req('/api/guides', { method: 'POST', token: admin, body: { destination: '镇江', days: 1 } });
  const agid = r.j.id;
  let ag = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/guides/${agid}`, { token: admin });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { ag = g.j.guide; break; }
  }
  r = await req('/api/users', { token: admin });
  const aAfter = (r.j.users || []).find((x) => x.role === 'admin');
  ok(ag && ag.status === 'done' && aAfter.tokens_out - aBefore.tokens_out === USAGE_OUT, '管理员自己的用量也记在列表上（+1 篇 ≈ +' + (aAfter.tokens_out - aBefore.tokens_out) + '）');
  ok(aAfter.quota.guide.unlimited === true && aAfter.guide_used === aBefore.guide_used, '管理员不受次数限制（已用数依然记账）');
  usageAi.close();
  await req('/api/ai/global', { method: 'PUT', token: admin, body: { base_url: '', model: '', key: '' } });
  // 桩模式不记 token（诚实边界：没有 usage 就什么都不写，绝不估算）
  r = await req('/api/users', { token: admin });
  const sBefore = (r.j.users || []).find((x) => x.id === u1id);
  r = await req('/api/guides', { method: 'POST', token: u1, body: { destination: '温州', days: 1 } });
  const sgid2 = r.j.id;
  let sg2 = null;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const g = await req(`/api/guides/${sgid2}`, { token: u1 });
    if (g.j.guide && (g.j.guide.status === 'done' || g.j.guide.status === 'error')) { sg2 = g.j.guide; break; }
  }
  r = await req('/api/users', { token: admin });
  const sAfter = (r.j.users || []).find((x) => x.id === u1id);
  ok(sg2 && sg2.status === 'done', '桩模式兜底生成完成（这套件全程桩）', sg2 ? sg2.error : '超时');
  ok(sAfter.tokens_in === sBefore.tokens_in && sAfter.tokens_out === sBefore.tokens_out, '桩模式不记 token（不估算、不编造）');

  // ---- v1.10.0：游记配额 ----
  console.log('== 游记配额（v1.10.0） ==');
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_journal: 0 } });
  ok(r.status === 200 && r.j.user.quota.journal.left === 0, 'admin 把游记额度设为 0');
  r = await req('/api/journals', { method: 'POST', token: regU, body: { destination: '杭州' } });
  const qjid = r.j.journal.id;
  r = await req(`/api/journals/${qjid}/generate`, { method: 'POST', token: regU, body: {} });
  ok(r.status === 403 && /游记生成次数已用完/.test(r.j.error || ''), '0 次 → 游记生成 403（文案点名游记）', r.j.error);
  r = await req(`/api/journals/${qjid}`, { method: 'PUT', token: regU, body: { meta: { days: '2' } } });
  ok(r.status === 200, '配额用尽不影响草稿编辑（只有生成/重新生成被闸）');
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_journal: 1 } });
  r = await req(`/api/journals/${qjid}/generate`, { method: 'POST', token: regU, body: {} });
  ok(r.status === 202, '给 1 次后可以生成');
  let jq = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const g = await req(`/api/journals/${qjid}`, { token: regU });
    if (g.j.journal && g.j.journal.status === 'done') { jq = g.j.journal; break; }
  }
  ok(!!jq, '游记生成完成（桩）');
  r = await req('/api/users', { token: admin });
  const jRow = (r.j.users || []).find((x) => x.id === regUid);
  ok(jRow.journal_used === 1 && jRow.quota.journal.left === 0, '游记成功才扣 1 次（已用 1 / 剩余 0）');
  r = await req(`/api/journals/${qjid}/regenerate`, { method: 'POST', token: regU, body: {} });
  ok(r.status === 403, '游记用尽后重新生成 403');
  r = await req(`/api/journals/${qjid}/title`, { method: 'POST', token: regU, body: {} });
  ok(r.status === 200 && r.j.title, 'AI 标题不受配额闸门限制（配额只管生成/重新生成，标题不扣次数）', `status=${r.status} ${r.j && r.j.error ? r.j.error : ''}`);
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_journal: -2 } });
  ok(r.status === 200 && r.j.user.quota.journal.unlimited === true && r.j.user.quota.journal.left === null, '设 -2 = 不限（left 为 null，前端显示「不限」）');
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_guide: -5 } });
  ok(r.status === 400, '脏配额值 -5 被拒（只认 -2/-1/0~9999）');
  r = await req(`/api/users/${regUid}`, { method: 'PUT', token: admin, body: { quota_guide: -1, guide_used: 0 } });
  ok(r.status === 200 && r.j.user.quota_guide === -1 && r.j.user.guide_used === 0 && r.j.user.quota.guide.limit === 2, '管理员可把用户清零并改回跟随默认（额度随即变 2）');

  // ---- 在线（真实外网） ----
  if (ONLINE) {
    console.log('== 在线真实接口 ==');
    if (amapReady) {
      r = await req('/api/poi?q=' + encodeURIComponent('西湖') + '&city=' + encodeURIComponent('杭州'), { token: admin });
      ok(r.status === 200 && r.j.pois.length > 0 && r.j.pois[0].location, '高德 POI 检索（env AMAP_KEY 真连）');
      r = await req('/api/settings/amap/test', { method: 'POST', token: admin, body: {} });
      ok(r.status === 200 && r.j.ok === true, '高德 Key 连通测试（env AMAP_KEY 真连）');
    } else {
      r = await req('/api/poi?q=' + encodeURIComponent('西湖') + '&city=' + encodeURIComponent('杭州'), { token: admin });
      ok(r.status !== 500 && !(r.j && r.j.pois && r.j.pois.length), '无 Key：POI 接口优雅拒绝（不 500、不返回假数据）');
      r = await req('/api/settings/amap/test', { method: 'POST', token: admin, body: {} });
      ok(r.status === 200 && r.j.ok === false && /尚未配置/.test(r.j.info || ''), '无 Key：连通测试如实回「尚未配置 Key」');
    }
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
