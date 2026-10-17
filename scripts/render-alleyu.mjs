// 渲染自检（Playwright，借用工作台的 node_modules）：
//   NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs
// 默认自起确定性桩服务器（ALLEYU_AI_FORCE_STUB=1，共享 data/ 的城市库与高德 Key（v1.6.3 起
// Key 不内置，库里有才产地图，没有走无图降级断言），独占 9610 端口）——起因 v1.5.0：本机
// data/ 存着用户真 Key，过去 render 的「现场生成」一直在打真实 DeepSeek（首字 20s+、偶发空流），
// 直播流断言随机红。
// 设 ALLEYU_URL 可改打外部已运行的服务器（不自起、不强制桩）。
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const URL_BASE = process.env.ALLEYU_URL || 'http://localhost:9610';
// PDF 下载断言的前提：服务器端有中文字体可出 PDF（无字体时端点回 400，跳过下载事件断言）
let FONTS_OK = false;
try { FONTS_OK = !!require(path.join(ROOT, 'server', 'services', 'pdfService.js')).findFonts(); } catch { /* 依赖缺失当没字体 */ }

let server = null;
if (!process.env.ALLEYU_URL) {
  const portFree = await new Promise((resolve) => {
    const s = net.connect(9610, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
  if (!portFree) {
    console.error('❌ 9610 端口被占用：render 需独占端口自起确定性桩服务器。先停掉现有服务，或设 ALLEYU_URL 指向它。');
    process.exit(1);
  }
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    // ALLEYU_NO_RESTART=1：render 跑在真实仓库根上，万一有人手滑点了「应用升级并重启」，
    // 至少不会有进程被换掉（文件仍会被写——所以下面的用例只预检、绝不点应用）
    // ALLEYU_WIKI_TIMEOUT_MS=1500（v1.11.1）：库页那个「🔌 测试维基连通」是**只读**探针，
    //   但它要真问一次维基。压到 1.5 秒是为了让断言「点完很快出结论」不受国内网络长短影响。
    env: { ...process.env, ALLEYU_AI_FORCE_STUB: '1', ALLEYU_NO_RESTART: '1', ALLEYU_WIKI_TIMEOUT_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {}); // 必须消费，防管道写满阻塞子进程
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  process.on('exit', () => server.kill());
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL_BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* 未就绪 */ }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  if (!up) { console.error('❌ 自起服务器 10s 内未就绪'); process.exit(1); }
  console.log('已自起确定性桩服务器（FORCE_STUB，pid=' + server.pid + '）');
}
const IMG_DIR = path.join(ROOT, 'img');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// v1.10.1：自检不再拿真实库里的管理员登录。
//  起因：真实库 admin 的密码是**用户自己的**（他随时会在「账号」页改掉），一改 render 就红在第一步。
//  做法：自检自建一个专用管理员 render_admin，跑完（含中途崩溃）删掉——真实账号一个都不碰。
const RENDER_ADMIN = 'render_admin';
const RENDER_ADMIN_PWD = 'render-admin-2026';
const db = require(path.join(ROOT, 'server', 'db.js')).db;
function dropRenderAdmin() {
  try {
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=?)').run(RENDER_ADMIN);
    db.prepare('DELETE FROM users WHERE username=?').run(RENDER_ADMIN);
  } catch { /* 退出阶段别抛 */ }
}
{
  const { randomBytes, scryptSync } = require('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(RENDER_ADMIN_PWD, salt, 64).toString('hex');
  db.prepare(`INSERT INTO users(username,password_hash,role,display_name,can_use_ai,allowed_pages)
              VALUES(?,?, 'admin', '渲染自检', 1, '[]')
              ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role='admin', can_use_ai=1`)
    .run(RENDER_ADMIN, `${salt}:${hash}`);
  process.on('exit', dropRenderAdmin);
}

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

// v1.13.0：社区/客服用到的 id，都在**回包里拿**，绝不认列表第一行。
let communityGuidePostId = 0;
let communityJournalPostId = 0;
const renderFeedbackIds = new Set();
// 中途失败（含断言抛错）也要把自检造的行清掉：攻略/游记、它们的社区分享、留言
let renderCleaned = false;
let cleanupJournalId = 0;
let cleanupGuideId = 0;
function dropRenderData() {
  if (renderCleaned) return;
  renderCleaned = true;
  try {
    const community = require(path.join(ROOT, 'server', 'services', 'communityService.js'));
    if (cleanupJournalId) community.removePostsBySource('journal', cleanupJournalId);
    if (cleanupGuideId) community.removePostsBySource('guide', cleanupGuideId);
  } catch { /* 退出阶段别抛 */ }
  try {
    if (cleanupJournalId) {
      fs.rmSync(path.join(ROOT, 'data', 'journal_photos', String(cleanupJournalId)), { recursive: true, force: true });
      db.prepare('DELETE FROM journal_photos WHERE journal_id=?').run(cleanupJournalId);
      db.prepare('DELETE FROM journals WHERE id=?').run(cleanupJournalId);
    }
    if (cleanupGuideId) {
      db.prepare('DELETE FROM shares WHERE guide_id=?').run(cleanupGuideId);
      db.prepare('DELETE FROM guides WHERE id=?').run(cleanupGuideId);
    }
    for (const id of renderFeedbackIds) db.prepare('DELETE FROM feedback WHERE id=?').run(id);
  } catch { /* 尽力 */ }
}
process.on('exit', dropRenderData);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// 登录页（先查占位提示已去掉，再走 SPA 登录——全程不整页刷新）
await page.goto(URL_BASE + '/#/login');
const noPlaceholder = await page.locator('input[placeholder="用户名"], input[placeholder="密码"]').count();
ok(noPlaceholder === 0, '登录框无用户名/密码占位提示');
await page.fill('input[aria-label="用户名"]', RENDER_ADMIN);
await page.fill('input[aria-label="密码"]', RENDER_ADMIN_PWD);
await page.click('button.btn');
await page.waitForURL('**/#/', { timeout: 8000 });
ok(true, '登录成功跳首页');

// 首页场景
await page.waitForSelector('.scene-box svg #bikerRoot', { timeout: 8000 });
ok(true, '骑手场景渲染');
const svgCount = await page.locator('.scene-box svg #riderHeadGroup').count();
ok(svgCount === 1, '兔子+自行车 SVG 结构存在');
const earCount = await page.locator('.scene-box svg #rabbitFrontEar').count();
ok(earCount === 1, '兔耳朵存在');
// v1.6.2：两只眼睛（riderEyeOpen 组内 2 颗深色眼球 + 笑眼 path 两段弧）
const eyeBalls = await page.locator('.scene-box svg #riderEyeOpen circle[fill="#1e293b"]').count();
ok(eyeBalls === 2, '兔子两只眼睛（前眼+后眼）');
const happyArcs = (await page.locator('.scene-box svg #riderEyeHappy').getAttribute('d')) || '';
ok(happyArcs.split('M').length - 1 === 2, '笑眼弧线两段（两只眼都笑）');
const furGrad = await page.locator('.scene-box svg #furGrad').count();
ok(furGrad === 1 && (await page.locator('.scene-box svg #pigSkinGrad').count()) === 0, '乳白毛色渐变（旧猪皮渐变已除）');
const hasSky = await page.locator('.scene-box svg rect[fill="url(#skyGrad)"]').count();
ok(hasSky === 0, '天空已移除（透明融入页面）');
const btns = await page.locator('.scene-box button').count();
ok(btns === 0, '场景内无按钮');

// v1.10.1：兔子两只眼睛一样大（用户点名——后眼原为透视缩小版 4.6，现与前眼同为 5.5）
const bigEyes = await page.locator('.scene-box svg #riderEyeOpen circle[fill="#1e293b"][r="5.5"]').count();
ok(bigEyes === 2, '两只眼睛一样大（都是 r=5.5）', String(bigEyes));
ok((await page.locator('.scene-box svg #riderEyeOpen circle[r="4.6"]').count()) === 0, '后眼的小号眼球已不存在');

// v1.10.1：只改车架颜色（浅粉 #f472b6），整车其余部件必须是原色。
// 上一版把整车刷成粉被用户否掉，这组断言就是防止再发生：先钉死「浅粉恰好出现在这 5 根车架管上」，
// 再钉死黑色轮胎/白色车圈/草编花篮/灰链条/灰车把/灰牙盘/灰脚踏都还在。
const FRAME_PINK = '#f472b6';
ok((await page.locator(`.scene-box svg #bikeFrameGroup path[stroke="${FRAME_PINK}"]`).count()) === 4 &&
   (await page.locator(`.scene-box svg #bikeFrameGroup line[stroke="${FRAME_PINK}"]`).count()) === 1,
  '车架（含两片挡泥板 + 三角形车架 + 上/下管）= 5 根浅粉');
for (const c of ['#be185d', '#db2777', '#9d174d']) {
  const n = await page.locator(`.scene-box svg [stroke="${c}"], .scene-box svg [fill="${c}"]`).count();
  ok(n === 0, `整车没有上一版那种深粉残留（${c}）`, String(n));
}
ok((await page.locator('.scene-box svg circle[stroke="#1e293b"][stroke-width="11"]').count()) === 2,
  '两个车轮还是黑胎');
ok((await page.locator('.scene-box svg circle[stroke="#e2e8f0"][stroke-width="3.5"]').count()) === 2,
  '两个车轮圈还是白的');
ok((await page.locator('.scene-box svg #rearSpokes[stroke="#cbd5e1"]').count()) === 1 &&
   (await page.locator('.scene-box svg #frontSpokes[stroke="#cbd5e1"]').count()) === 1,
  '辐条还是灰的');
ok((await page.locator('.scene-box svg path[stroke="#475569"][stroke-dasharray="5 3"]').count()) === 1,
  '车链还是灰的（虚线）');
ok((await page.locator('.scene-box svg path[fill="#d97706"][stroke="#92400e"]').count()) === 1,
  '花篮还是草编色（琥珀色 + 深棕描边）');
ok((await page.locator('.scene-box svg path[fill="#fbbf24"][stroke="#d97706"]').count()) === 1,
  '车铃还是黄铜色');
ok((await page.locator('.scene-box svg circle[fill="#e2e8f0"][stroke="#64748b"]').count()) === 1,
  '牙盘（绞盘）还是白盘灰边');
ok((await page.locator('.scene-box svg path[stroke="#cbd5e1"][stroke-width="7"]').count()) === 1,
  '车把还是灰的');
ok((await page.locator('.scene-box svg rect[fill="#0f172a"]').count()) === 1 &&
   (await page.locator('.scene-box svg rect[fill="#1e293b"]').count()) === 1,
  '两只脚踏还是深色');

// v1.10.1：首页副标题删掉「每敲一个字，它就兔跳一下」（兔跳本身照旧，只是不写在页面上）
const subTxt = await page.locator('.home-sub').innerText();
ok(subTxt.includes('小兔骑车带你去') && !subTxt.includes('每敲一个字'),
  '首页副标题只留「输入一个目的地，小兔骑车带你去」', JSON.stringify(subTxt));

// 打字触发兔跳：bikerRoot transform translate(0, 负数)
const jumpBefore = await page.locator('#bikerRoot').getAttribute('transform');
await page.fill('.searchbar input', '杭');
await page.waitForTimeout(120);
const jumpMid = await page.locator('#bikerRoot').getAttribute('transform');
await page.waitForTimeout(2000);
const jumpAfter = await page.locator('#bikerRoot').getAttribute('transform');
const negY = (t) => t && /translate\(0, -\d/.test(t);
ok(negY(jumpMid) || (jumpBefore !== jumpMid), '打一个字触发兔跳（transform 变化/出现负 y）', JSON.stringify({ jumpBefore, jumpMid }));
ok(jumpAfter === 'translate(0, 0)', '跳跃落地回原位');

// 搜索建议 + 跳转攻略页
await page.fill('.searchbar input', '杭州');
await page.waitForTimeout(600);
const sugCount = await page.locator('.sug .s').count();
ok(sugCount >= 1, '边查边搜城市建议');
// v1.10.1：底部 ICP 备案号（首页）
const beian = page.locator('.beian a').first();
ok((await beian.innerText()).trim() === '浙ICP备2026080083号-1', '首页底部挂上备案号');
ok((await beian.getAttribute('href')) === 'https://beian.miit.gov.cn/' && (await beian.getAttribute('target')) === '_blank',
  '备案号指向工信部且新窗口打开');
await page.screenshot({ path: path.join(IMG_DIR, '首页.png'), fullPage: false });
await page.click('.searchbar .go');
await page.waitForURL('**/#/plan**', { timeout: 8000 });
ok(true, '回车/做攻略 → 计划表单');
// 关键回归：SPA 登录后不经整页刷新直达功能页，侧栏菜单必须非空（v1.1.0 修的空菜单 bug）。
// me 是路由 watcher 异步拉的——必须等菜单出现再数，立刻数是竞态（首跑曾假失败）
let navOk = true;
try { await page.waitForSelector('.side .nav-item', { timeout: 8000 }); } catch { navOk = false; }
const navCount = navOk ? await page.locator('.side .nav-item').count() : 0;
ok(navCount >= 5, 'SPA 登录后侧栏菜单非空（修复空菜单）');
// v1.1.1：favicon 与侧栏图标去猪化/单色化
const fav = await page.getAttribute('link[rel="icon"]', 'href');
ok(fav && fav.includes('🐰') && !fav.includes('🐷'), 'favicon=兔子（猪头已换）');
const svgNav = await page.locator('.side .nav-item svg').count();
ok(svgNav === navCount, '侧栏图标=单色 SVG（每项一枚）');
const icTexts = await page.locator('.side .nav-item .ic').allInnerTexts();
ok(icTexts.every((t) => !t.trim()), '侧栏图标槽无残留 emoji 文本');

// 计划表单元素
await page.waitForSelector('input[placeholder="例如：杭州"]', { timeout: 8000 });
await page.screenshot({ path: path.join(IMG_DIR, '生成攻略.png') });
ok(true, '表单渲染');

// v1.2.0：现场生成一篇（桩 AI + 真高德配图）——验证单色封面地图 + 总览连线 + 生成来源页脚
const tk = await page.evaluate(() => localStorage.getItem('alleyu_token') || '');
const genRes = await fetch(URL_BASE + '/api/guides', {
  method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
  body: JSON.stringify({ destination: '杭州', days: 2, mustVisits: ['西湖', '灵隐寺'] }),
}).then((r) => r.json()).catch(() => null);
let done = null;
let genbarOk = false, stageTextOk = false, peekOk = false;
if (genRes && genRes.id) {
  cleanupGuideId = genRes.id; // 收尾/崩溃时按这个 id 删，别靠列表顺序猜
  // v1.4.0：趁生成未完先进详情页——进度条 + 阶段说明词必须可见（桩+真高德 enrich 要半分钟，赶得上）
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  try {
    await page.waitForSelector('.genbar .fill', { timeout: 8000 });
    genbarOk = true;
    const label = await page.locator('.status-card b').innerText();
    // 「模型已响应，等待首段内容…」也是真阶段说明词（write 已开始、首段还没落库的窗口）
    stageTextOk = /排队|正在|重试|增强|模型已响应/.test(label);
    await page.screenshot({ path: path.join(IMG_DIR, '生成中.png'), fullPage: false });
    // v1.5.0：3 行实时内容小窗——模型开始返回后里面有真文字
    try {
      await page.waitForFunction(() => { const el = document.querySelector('.peek'); return el && el.textContent.trim().length > 20; }, null, { timeout: 20000 });
      peekOk = true;
    } catch { /* 没赶上流式窗口 */ }
  } catch { /* 没赶上生成窗口 */ }
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(1000);
    const g = await fetch(URL_BASE + '/api/guides/' + genRes.id, { headers: { Authorization: 'Bearer ' + tk } }).then((r) => r.json()).catch(() => null);
    if (g && g.guide && (g.guide.status === 'done' || g.guide.status === 'error')) { done = g.guide; break; }
  }
}
ok(genbarOk, '生成中：进度条可见（.genbar）');
ok(stageTextOk, '生成中：阶段说明词显示（排队/正在/重试/增强）');
ok(peekOk, '生成中：3 行实时内容小窗有模型返回的真文字');
ok(done && done.status === 'done', '桩模式现场生成新攻略（≤240s，高德配图限速串行波动大）');
let detailShotDone = false;
if (done && done.status === 'done') {
  // v1.6.3 起高德 Key 不内置：库里有 Key=完整地图断言；没有=降级断言（无图但不伪造，页脚照常）
  const hasCoverMap = (done.images || []).some((x) => x.type === 'cover');
  if (hasCoverMap) {
    ok(done.content.includes('![封面地图](') && done.content.includes('## 生成来源'), '服务端：封面地图在顶部 + 生成来源页脚');
    await page.goto(URL_BASE + '/#/guide/' + genRes.id);
    await page.waitForSelector('.md img', { timeout: 20000 });
    await page.waitForTimeout(600);
    const firstAlt = await page.locator('.md img').first().getAttribute('alt');
    ok(firstAlt === '封面地图', '详情页第一张图=封面地图（不再用随机照片）');
    const filt = await page.evaluate(() => { const el = document.querySelector('.md img[alt="封面地图"]'); return el ? getComputedStyle(el).filter : ''; });
    ok(/sepia/.test(filt) && /hue-rotate/.test(filt), '封面地图偏蓝单色（sepia+hue-rotate 滤镜，非黑白）');
  } else {
    ok(!done.content.includes('![封面地图](') && done.content.includes('## 生成来源'), '无 Key：正文无封面地图、生成来源页脚仍在');
    await page.goto(URL_BASE + '/#/guide/' + genRes.id);
    await page.waitForSelector('.md', { timeout: 20000 });
    await page.waitForTimeout(600);
    const noCover = await page.locator('.md img[alt="封面地图"]').count();
    ok(noCover === 0, '无 Key：详情页不显示封面地图（不伪造）');
    ok(!(done.images || []).length, '无 Key：images 数组不产任何图（地图/照片全跳过）');
  }
  const mdText2 = await page.locator('.md').innerText();
  ok(/生成来源/.test(mdText2) && /高德开放平台/.test(mdText2) && /Open-Meteo/.test(mdText2), '生成来源+链接渲染在攻略底部');
  // v1.5.0：完整提示词折叠框（生成来源之下的最后一块）
  const pbCount = await page.locator('.promptbox').count();
  ok(pbCount === 1, '提示词折叠框存在（生成来源下方）');
  if (pbCount === 1) {
    const isOpen = await page.locator('.promptbox').evaluate((el) => el.open);
    ok(isOpen === false, '提示词框默认折叠');
    await page.locator('.promptbox summary').click();
    await page.waitForTimeout(200);
    const preLen = await page.locator('.promptbox pre').evaluate((el) => el.textContent.length);
    ok(preLen > 500, '展开显示完整提示词（>500 字符）');
    const cpBtn = await page.locator('.promptbox .pb-bar button').count();
    ok(cpBtn === 1, '提示词框内复制按钮');
    const regenBtn = await page.locator('.gv-head button').filter({ hasText: '重新生成' }).count();
    ok(regenBtn === 1, '「重新生成」按钮在复制全文旁（失败/完成都可见）');
  }
  await page.screenshot({ path: path.join(IMG_DIR, '攻略详情.png'), fullPage: false });
  detailShotDone = true;

  // ---- v1.6.0：分享对话框 + 编辑 Markdown + 匿名分享页 ----
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  await page.waitForSelector('.gv-head button', { timeout: 8000 });
  await page.locator('.gv-head button').filter({ hasText: '分享' }).click();
  await page.waitForSelector('.dlg', { timeout: 4000 });
  const optTexts = await page.locator('.dlg .seg .opt').allInnerTexts();
  ok(optTexts.length === 2 && optTexts.some((t) => t.includes('动态')) && optTexts.some((t) => t.includes('静态')), '分享对话框：动态更新/静态链接两种模式');
  await page.locator('.dlg button').filter({ hasText: '生成分享链接' }).click();
  await page.waitForSelector('.share-row', { timeout: 4000 });
  const shareUrlText = (await page.locator('.share-row .share-url').first().innerText()).trim();
  ok(/\/#\/s\/[0-9a-f]{32}/.test(shareUrlText), '生成 32hex 分享链接（行内可见完整 URL）');
  await page.screenshot({ path: path.join(IMG_DIR, '分享.png'), fullPage: false });

  // ---- v1.10.2：裸 HTTP 下的复制（线上 http://alleyu.in1912.cn 没有 navigator.clipboard）----
  // 用户实测的报错：navigator.clipboard 是 undefined 时，旧代码直接写
  // navigator.clipboard.writeText(...) → 当场抛 "Cannot read properties of undefined (reading 'writeText')"
  // ——「生成分享链接」弹这句、「复制」按钮点了一点反应都没有（异常没人接）。
  // 这里把 clipboard 抠掉（模拟非安全上下文），再把 execCommand / alert 换成探针，
  // 验证真的回落到 textarea + execCommand('copy')，而且复制的内容就是那行链接。
  await page.evaluate(() => {
    window.__probe = { copied: [], alerts: [] };
    window.__orig = {
      exec: document.execCommand,
      alert: window.alert,
      clipDesc: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
    };
    try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); } catch { /* 已经是 undefined 更好 */ }
    document.execCommand = (cmd) => {
      const el = document.activeElement;
      window.__probe.copied.push({ cmd, text: el && 'value' in el ? String(el.value) : '' });
      return true;
    };
    window.alert = (m) => { window.__probe.alerts.push(String(m)); };
  });
  ok((await page.evaluate(() => typeof navigator.clipboard)) === 'undefined', '探针就位：navigator.clipboard 已被拿掉（等价于 http 页面里的 undefined）');
  await page.locator('.share-row button').filter({ hasText: '复制' }).first().click();
  await page.waitForTimeout(300);
  const probe1 = await page.evaluate(() => window.__probe);
  ok(probe1.copied.length === 1 && probe1.copied[0].cmd === 'copy', '无 clipboard 时「复制」回落到 execCommand(\'copy\')（不再抛 undefined.writeText）');
  ok(probe1.copied[0].text === shareUrlText, '回落复制的内容就是那行分享链接（值没串、没截断）');
  ok(probe1.alerts.length === 0, `复制过程不弹英文报错（alert 探针为空：${JSON.stringify(probe1.alerts)}）`);
  ok((await page.locator('.dlg .hint').filter({ hasText: '已复制链接' }).count()) >= 1, '复制成功仍有中文反馈「已复制链接」');
  // 再走一次「生成分享链接」：旧代码在这里是 alert 报错（复制那句在 try 里，异常被 catch 到 alert）
  await page.locator('.dlg button').filter({ hasText: '生成分享链接' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.share-row').length === 2, null, { timeout: 6000 });
  const probe2 = await page.evaluate(() => window.__probe);
  ok(probe2.alerts.every((m) => !/undefined|writeText/i.test(m)), `生成链接不再弹英文异常（探针收到：${JSON.stringify(probe2.alerts)}）`);
  ok(probe2.copied.length === 2, '第二次生成同样走回落复制（两条链接都复制成功）');
  // 还原探针，别把后面的用例带进假环境
  await page.evaluate(() => {
    document.execCommand = window.__orig.exec;
    window.alert = window.__orig.alert;
    if (window.__orig.clipDesc) Object.defineProperty(navigator, 'clipboard', window.__orig.clipDesc);
    else delete navigator.clipboard;
  });
  ok((await page.evaluate(() => typeof navigator.clipboard)) === 'object', '探针已还原（后续断言回到真实环境跑；也反证上面那条 undefined 是真的抠掉了）');

  // ---- v1.10.2：公开访问地址（分享链接域名）----
  // 拿局域网 IP / localhost 打开后台时，复制出去的链接别人打不开 → 管理员可配死域名。
  const ahSet = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  const setBefore = await fetch(URL_BASE + '/api/settings', { headers: ahSet }).then((r) => r.json());
  const putBase = await fetch(URL_BASE + '/api/settings', { method: 'PUT', headers: ahSet, body: JSON.stringify({ public_base_url: 'http://alleyu.in1912.cn' }) });
  ok(putBase.status === 200, `设置「公开访问地址」成功（HTTP ${putBase.status}）`);
  const setNow = await fetch(URL_BASE + '/api/settings', { headers: ahSet }).then((r) => r.json());
  ok(setNow.public_base_url === 'http://alleyu.in1912.cn', `库里真的存上了公开访问地址（${setNow.public_base_url || '空'}）`);
  await page.locator('.dlg button').filter({ hasText: '关闭' }).click();
  ok((await page.locator('.mask').count()) === 0, '分享对话框已关闭（只有重新打开才会用新域名拼链接）');
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  await page.waitForSelector('.gv-head button', { timeout: 8000 });
  const [meResp] = await Promise.all([
    page.waitForResponse((x) => /\/api\/auth\/me$/.test(x.url()), { timeout: 8000 }).catch(() => null),
    page.locator('.gv-head button').filter({ hasText: '分享' }).click(),
  ]);
  ok(!!meResp, '打开分享对话框时真的重新读了 /auth/me（不是吃缓存/复用旧列表）');
  if (meResp) {
    const mj = await meResp.json().catch(() => ({}));
    ok(mj.share_base === 'http://alleyu.in1912.cn', `分享对话框读到的 share_base 是新值（${mj.share_base || '空'}）`);
  }
  await page.waitForSelector('.share-row', { timeout: 6000 });
  const basedUrl = (await page.locator('.share-row .share-url').first().innerText()).trim();
  const pageBase = await page.evaluate(async () => {
    const t = localStorage.getItem('alleyu_token');
    const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' });
    return (await r.json()).share_base;
  });
  ok(pageBase === 'http://alleyu.in1912.cn', `页面里现读到的 share_base 是最新值（${pageBase || '空'}）`);
  ok(basedUrl.startsWith('http://alleyu.in1912.cn/#/s/'), `配了公开访问地址 → 链接照它拼（${basedUrl.slice(0, 42)}…）`);
  ok((await page.locator('.share-row a').filter({ hasText: '打开' }).first().getAttribute('href')) === basedUrl, '链接行「打开」按钮指向同一地址（点开就能验证链接通不通）');
  await fetch(URL_BASE + '/api/settings', { method: 'PUT', headers: ahSet, body: JSON.stringify({ public_base_url: setBefore.public_base_url || '' }) });
  const setAfter = await fetch(URL_BASE + '/api/settings', { headers: ahSet }).then((r) => r.json());
  ok((setAfter.public_base_url || '') === (setBefore.public_base_url || ''), `公开访问地址用后还原（原值「${setBefore.public_base_url || '空'}」，不给真实库留自检残留）`);
  await page.locator('.dlg button').filter({ hasText: '关闭' }).click();

  // ---- v1.13.0：把这篇攻略发布到社区（之后游客要能在社区里看到它）----
  const [gpResp] = await Promise.all([
    page.waitForResponse((x) => /\/api\/community\/publish$/.test(x.url()) && x.request().method() === 'POST', { timeout: 10000 }),
    page.locator('.gv-head button').filter({ hasText: '发布到社区' }).click(),
  ]);
  const gpJ = await gpResp.json().catch(() => ({}));
  communityGuidePostId = (gpJ.post && gpJ.post.id) || 0;
  ok(gpResp.ok() && communityGuidePostId > 0, `攻略页「发布到社区」成功（post #${communityGuidePostId}）`);
  await page.waitForFunction(() => [...document.querySelectorAll('.gv-head button')].some((b) => b.textContent.includes('取消发布')), null, { timeout: 8000 });
  ok(true, '发布后按钮变为「取消发布」（作者能自己撤下）');

  // 编辑模式：改 Markdown 原文并保存
  await page.locator('.gv-head button').filter({ hasText: '编辑' }).click();
  await page.waitForSelector('.editarea', { timeout: 4000 });
  const areaLen = await page.locator('.editarea').evaluate((el) => el.value.length);
  ok(areaLen > 500, '编辑框载入当前 Markdown 原文');
  const marker = '编辑标记段RenderE2E';
  await page.locator('.editarea').evaluate((el, m) => { el.value += '\n\n## ' + m + '\n'; el.dispatchEvent(new Event('input', { bubbles: true })); }, marker);
  await page.locator('.editwrap button').filter({ hasText: '保存修改' }).click();
  await page.waitForTimeout(800);
  const mdAfter = await page.locator('.md').innerText();
  ok(mdAfter.includes(marker), '保存编辑后正文即时更新（含追加段）');

  // v1.6.1：攻略页导出 PDF = 直接下载文件（不再弹打印对话框）
  if (FONTS_OK) {
    const dlP = page.waitForEvent('download', { timeout: 25000 });
    await page.locator('.gv-head button').filter({ hasText: '导出PDF' }).click();
    const dl = await dlP;
    ok((await dl.path()) !== null, '点「导出PDF」直接下载文件（浏览器下载事件）');
    ok(dl.suggestedFilename().endsWith('.pdf'), '下载文件名以 .pdf 结尾（' + dl.suggestedFilename() + '）');
  } else {
    console.log('  ⚠️ 无中文字体，下载事件断言跳过');
  }

  // 匿名新 context（无任何登录态）打开分享链接
  const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const apage = await anon.newPage();
  await apage.goto(shareUrlText);
  await apage.waitForSelector('.share-titlebox h1', { timeout: 8000 });
  ok(apage.url().includes('/#/s/'), '免登录：未被路由守卫弹回登录页');
  const badgeText = await apage.locator('.share-top .badge').innerText();
  ok(badgeText.includes('动态更新'), '分享页模式徽标=动态更新');
  const anonText = await apage.locator('.md').innerText();
  ok(anonText.includes(marker), '动态分享页跟随编辑（匿名读到追加段）');
  ok((await apage.locator('.share-top button').filter({ hasText: '导出 PDF' }).count()) === 1, '分享页有「导出 PDF」按钮');
  ok((await apage.locator('.side').count()) === 0, '分享页无侧栏（整页排版）');
  if (FONTS_OK) {
    const adlP = apage.waitForEvent('download', { timeout: 25000 });
    await apage.locator('.share-top button').filter({ hasText: '导出 PDF' }).click();
    const adl = await adlP;
    ok((await adl.path()) !== null && adl.suggestedFilename().endsWith('.pdf'), '分享页匿名导出 PDF=直接下载文件');
  }
  await apage.screenshot({ path: path.join(IMG_DIR, '分享页.png'), fullPage: false });
  await anon.close();
}

// 其余页面截图（不深度断言，保底可见性）
for (const [hash, sel, name] of [
  ['#/library', '.tabs', '城市景点库'],
  ['#/weather', 'input[placeholder="城市名，回车查询"]', '天气'],
  ['#/settings', '.tabs', '设置'],
  ['#/users', 'table.tb', '用户管理'],
]) {
  await page.goto(URL_BASE + '/' + hash);
  try {
    await page.waitForSelector(sel, { timeout: 6000 });
    await page.screenshot({ path: path.join(IMG_DIR, name + '.png') });
    ok(true, name + ' 页渲染');
  } catch {
    ok(false, name + ' 页渲染（选择器超时）');
  }
}

// v1.6.0 起设置页无「我的 AI」；v1.10.0 加「邀请码」，v1.11.0 加「升级」，v1.12.0 加「维基与补全」
await page.goto(URL_BASE + '/#/settings');
await page.waitForSelector('.tabs .t', { timeout: 6000 });
const setTabs = await page.locator('.tabs .t').allInnerTexts();
ok(setTabs.length === 5 && !setTabs.some((t) => t.includes('我的 AI')), '设置页五页签（AI 全局/邀请码/升级/系统/维基与补全）');
ok(setTabs.some((t) => t.includes('邀请码')), '五页签里有「邀请码」（v1.10.0 新增）');
ok(setTabs.some((t) => t.includes('升级')), '五页签里有「升级」（v1.11.0 新增）');
ok(setTabs.some((t) => t.includes('维基与补全')), '五页签里有「维基与补全」（v1.12.0 新增）');

// ---- v1.12.0：维基与补全页签（两家各一个开关 + 各自「测试连接」，未勾选也允许先测） ----
await page.locator('.tabs .t').filter({ hasText: '维基与补全' }).click();
await page.waitForSelector('.wiki-row', { timeout: 6000 });
const wikiChecks = page.locator('.wiki-row input[type=checkbox]');
ok((await wikiChecks.count()) === 2, '维基与补全：两家站点各一个复选框');
const wikiLabels = (await page.locator('.wiki-row').allInnerTexts()).join(' ');
ok(/维基旅行/.test(wikiLabels) && /维基百科/.test(wikiLabels), '两个复选框分别标明 维基旅行 / 维基百科');
const wikiTestBtns = page.locator('.wiki-row button').filter({ hasText: '测试连接' });
ok((await wikiTestBtns.count()) === 2, '每家站点各有「测试连接」按钮');
// 逐家点（探针只读连通性、不写库）；只断言「12 秒内必出结论」，不预设通或不通。
// ⚠️ 绝不点「保存维基设置」：render 跑在真实库上，那会改掉管理员已配好的开关。
for (let i = 0; i < 2; i++) {
  const t0 = Date.now();
  await wikiTestBtns.nth(i).click();
  let done = false;
  while (!done && Date.now() - t0 < 12000) {
    await page.waitForTimeout(200);
    const res = page.locator('.wiki-row').nth(i).locator('.ok-text, .err-text');
    if ((await res.count()) > 0) {
      const txt = (await res.first().innerText({ timeout: 1500 }).catch(() => '')).trim();
      if (/可达|连不上|未配置|离线|超时/.test(txt)) done = true;
    }
  }
  ok(done, `第 ${i + 1} 家「测试连接」${((Date.now() - t0) / 1000).toFixed(1)}s 内给出结论`);
}
await page.screenshot({ path: path.join(IMG_DIR, '维基与补全.png'), fullPage: false });

// ---- v1.11.0 管理员在线升级页（**只预检，绝不点应用**） ----
// ⚠️ 这段跑在**真实仓库根**上（render 的服务器没改 ALLEYU_UPGRADE_ROOT）——这正是它的价值：
//    下面这条「预检前后 server/ + web/dist 的 sha256 清单未变」证明预检真的一个字节都没写。
//    绝对不要在这里点「应用升级并重启」：那会把开发机上正在用的 server/ 换成包里的内容。
{
  const crypto = await import('node:crypto');
  const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
  // 本段在模块作用域靠前的位置，`ah` 要等下面才声明（TDZ）——自己拼一份管理员头，别引用它。
  const upAh = { Authorization: 'Bearer ' + tk };
  const treeHash = (dirs) => {
    const out = [];
    const walk = (p) => {
      if (fs.statSync(p).isFile()) { out.push(path.relative(ROOT, p).split(path.sep).join('/') + ':' + hex(fs.readFileSync(p))); return; }
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
    };
    for (const d of dirs) walk(d);
    return out.sort().join('\n');
  };
  const REPO_PARTS = [path.join(ROOT, 'server'), path.join(ROOT, 'web', 'dist'), path.join(ROOT, 'package.json')];

  await page.locator('.tabs .t').filter({ hasText: '升级' }).click();
  await page.waitForSelector('.up-msg, input[type=file]', { timeout: 8000 });
  const upCard = page.locator('.card').filter({ hasText: '在线升级' });
  ok((await upCard.locator('table.tb').first().innerText()).includes('正在运行'), '升级页显示「正在运行」的版本状态表');
  const upStatus = await fetch(URL_BASE + '/api/upgrade/status', { headers: upAh }).then((r) => r.json());
  ok(upStatus.upgrade_root === ROOT, `升级根就是本仓库根（${upStatus.upgrade_root}）——这条让「预检只读」的断言不是废话`);
  const sysVer = await fetch(URL_BASE + '/api/system-info').then((r) => r.json());
  ok((await upCard.locator('table.tb').first().innerText()).includes('v' + sysVer.version), '页面上显示的运行版本与 /api/system-info 一致');
  ok((await upCard.locator('input[type=file]').count()) === 1, '升级页有选包输入框');
  await page.screenshot({ path: path.join(IMG_DIR, '升级.png'), fullPage: true });

  const applyBtn = page.locator('button').filter({ hasText: '应用升级并重启' });
  const planBtn = page.locator('button').filter({ hasText: '预检' });
  ok(await applyBtn.isDisabled(), '没选包时「应用升级并重启」是禁用的');

  // 现打一个小包到系统临时目录（**不落仓库**）：整份 server/ 里挑 2 个文件 + 一个全新时间戳的 dist
  const tmpPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alleyu-render-pack-'));
  const zipSvc = require(path.join(ROOT, 'server', 'services', 'zipService.js'));
  const distLatest = (() => {
    const d = path.join(ROOT, 'web', 'dist');
    const all = fs.readdirSync(d).filter((n) => /^\d{8,}$/.test(n)).sort();
    return all[all.length - 1];
  })();
  const ts = String(Number(distLatest) + 1);
  const mkPack = (version, extra = []) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkg.version = version;
    const list = [
      { name: 'server/index.js', data: fs.readFileSync(path.join(ROOT, 'server', 'index.js')) },
      { name: 'server/services/zipService.js', data: fs.readFileSync(path.join(ROOT, 'server', 'services', 'zipService.js')) },
      { name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2)) },
      { name: `web/dist/${ts}/index.html`, data: fs.readFileSync(path.join(ROOT, 'web', 'dist', distLatest, 'index.html')) },
      { name: 'web/dist/.latest', data: Buffer.from(ts) },
      ...extra,
    ];
    list.push({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({
        app: 'alleyu', kind: 'upgrade-pack', version, from_version: sysVer.version,
        built_at: new Date().toISOString(), dist: ts,
        files: list.map((e) => ({ path: e.name, size: e.data.length, sha256: hex(e.data) })),
      }, null, 2)),
    });
    return zipSvc.buildZip(list);
  };

  const beforeHash = treeHash(REPO_PARTS);
  let packPath = path.join(tmpPackDir, 'good.zip');
  fs.writeFileSync(packPath, mkPack('9.9.9-render'));
  await page.locator('input[type=file]').setInputFiles(packPath);
  await page.waitForTimeout(200);
  ok(await applyBtn.isDisabled(), '选了包但还没预检时「应用」仍然禁用（必须先预检）');
  await planBtn.click();
  await page.waitForSelector('details summary', { timeout: 15000 });
  const planText = await upCard.innerText();
  ok(/预检结果：v.+→ v9\.9\.9-render/.test(planText), '预检结果面板渲染出版本跃迁', planText.slice(0, 80));
  ok(/新增/.test(planText) && /覆盖/.test(planText), '预检结果里有新增/覆盖计数');
  ok(/没有写入任何文件/.test(planText), '页面明确告诉管理员「预检没有写入任何文件」');
  ok(!(await applyBtn.isDisabled()), '预检通过后「应用」按钮才可用');
  ok(treeHash(REPO_PARTS) === beforeHash, '预检全程只读：真实仓库 server/ + web/dist + package.json 的 sha256 清单未变');
  await page.screenshot({ path: path.join(IMG_DIR, '升级-预检.png'), fullPage: true });

  // 坏包（写 data/）→ 红字报错，且不出结果面板
  packPath = path.join(tmpPackDir, 'bad.zip');
  fs.writeFileSync(packPath, mkPack('9.9.9-render', [{ name: 'data/alleyu.sqlite', data: Buffer.from('x') }]));
  await page.locator('input[type=file]').setInputFiles(packPath);
  await page.waitForTimeout(200);
  await planBtn.click();
  await page.waitForTimeout(1500);
  const errText = await page.locator('.up-msg').innerText();
  ok(/data\//.test(errText) && /绝不允许/.test(errText), '非法包（试图写 data/）在页面上给出红字原因', errText.slice(0, 80));
  ok((await upCard.locator('details summary').count()) === 0, '预检失败时不出「预检结果」面板（没通过就不给应用的机会）');
  ok(await applyBtn.isDisabled(), '预检失败后「应用」按钮回到禁用（token 为空，没得点）');
  ok(treeHash(REPO_PARTS) === beforeHash, '两次预检之后真实仓库依旧一个字节没变');
  fs.rmSync(tmpPackDir, { recursive: true, force: true }); // 自检造的包只活在系统临时目录里
}

// v1.3.0：国际线路筛选 pill（库页）
await page.goto(URL_BASE + '/#/library');
await page.waitForSelector('.liblines .opt', { timeout: 8000 });
const pillCount = await page.locator('.liblines .opt').count();
ok(pillCount === 6, '库页线路筛选 pill=6（国内+五国际线）');
await page.locator('.liblines .opt').filter({ hasText: '欧洲线' }).click();
await page.waitForTimeout(900);
const parisCell = await page.locator('.tb td').filter({ hasText: '巴黎' }).count();
ok(parisCell >= 1, '欧洲线筛选出巴黎');
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库.png'), fullPage: false });

// v1.10.1：城市页签「各线路 拉取旅游城市」按钮组（缺额 0 → 显示 ✓ 且置灰）
const pullBtn = page.locator('.pull-row button');
const pullCount = await pullBtn.count();
const pullTexts = (await pullBtn.allInnerTexts()).map((t) => t.trim());
ok(pullCount === 6, `城市页签有 6 个「拉取旅游城市」按钮（实际 ${pullCount}）`);
ok(pullTexts.every((t) => /^(国内|欧洲线|中亚线|东亚线|北美线|南美线)\s*(\+\d+|✓)$/.test(t)), `按钮文案=线路名+还缺几座（${pullTexts.join(' / ')}）`);
let pullInvariant = true;
for (let i = 0; i < pullCount; i++) {
  const dis = await pullBtn.nth(i).isDisabled();
  if (/✓$/.test(pullTexts[i]) !== dis) pullInvariant = false; // 「✓」⇔ 置灰：没得补就点不动
}
ok(pullInvariant, '缺 0 座的线路按钮显示 ✓ 且置灰（✓ 与 disabled 一一对应）');

// v1.7.0：景点页签=先线路后城市 + 分页浏览 + 介绍列
await page.locator('.tabs .t').filter({ hasText: '景点' }).click();
await page.waitForSelector('.liblines .opt', { timeout: 8000 });
const attrPills = await page.locator('.liblines .opt').allInnerTexts();
ok(attrPills[0].includes('全部线路') && attrPills.some((t) => t.includes('国内')) && attrPills.some((t) => t.includes('欧洲线')), '景点页签线路 pill：全部线路+种子线路');
await page.waitForSelector('.tb tbody tr', { timeout: 8000 });
await page.waitForTimeout(600);
const rows1 = await page.locator('.tb tbody tr').count();
ok(rows1 === 10, `未选城市默认每页 10 条（实际 ${rows1}）`);
const pagerText = await page.locator('.pager-row .hint').innerText();
ok(/第 1 \/ \d+ 页 · 共 \d+ 条/.test(pagerText), `分页条自洽（${pagerText.trim()}）`);
const firstPage1 = await page.locator('.tb tbody tr td b').first().innerText();
await page.locator('.pager-row button', { hasText: '下一页' }).click();
await page.waitForTimeout(700);
const firstPage2 = await page.locator('.tb tbody tr td b').first().innerText();
ok(firstPage1 !== firstPage2, '下一页翻页生效（首页行变化）');
await page.locator('select.input').filter({ hasText: '每页' }).first().selectOption('50');
await page.waitForTimeout(700);
const rows50 = await page.locator('.tb tbody tr').count();
ok(rows50 === 50, `每页 50 切换生效（实际 ${rows50}）`);
const introHeads = await page.locator('.tb thead th').allInnerTexts();
ok(introHeads.some((h) => h.includes('介绍')) && introHeads.some((h) => h.includes('城市')), '表格带介绍列与城市列');
// v1.12.0：批量补全从「零景点」改成「景点数少于 N」（N 默认 6，可在设置里改）——title 与页脚都要写明
const bfAllBtn = page.locator('button', { hasText: '补全全部缺景点城市' });
ok((await bfAllBtn.count()) === 1, '景点页签有「补全全部缺景点城市」按钮');
const bfTitle = (await bfAllBtn.first().getAttribute('title')) || '';
ok(/少于 6/.test(bfTitle) && /跳过/.test(bfTitle), '批量补全按钮标题写明「景点数少于 6」与「已有景点跳过」', bfTitle.slice(0, 80));
const libTail = await page.locator('.card .hint').last().innerText();
ok(/少于 6/.test(libTail) && /跳过/.test(libTail), '页脚说明写明只补「景点数少于 6」的国内城市、已有景点的一律跳过', libTail.slice(0, 120));
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库-景点.png'), fullPage: false });

// v1.11.1：只读的「🔌 测试维基连通」——「介绍补不上」到底是连不上还是真没条目，一点就知道。
// 注意：**只点这个只读探针，绝不点补全按钮**（render 跑在真实 data/ 库上，补全会真写库、真拉外网）。
// 也不断言"一定连不上"——用户挂代理跑自检时它就该是「可达」，这里只断言「8 秒内必定有结论」。
const probeBtn = page.locator('button', { hasText: '测试维基连通' });
ok((await probeBtn.count()) === 1, '景点页签有只读的「测试维基连通」按钮');
const tProbe = Date.now();
await probeBtn.first().click();
let probeTxt = '';
// 两个坑（v1.11.1 第一次跑自己踩的，render 被卡了 20 分钟）：
// ①结论行是 `v-if="backfillMsg"`，**点击前根本不存在** → `innerText()` 每次白等 30 秒才抛；必须先 count() 再看；
// ②循环条件带时钟，无论页面怎么变都在 9 秒内退出（这条断言的语义本来就是「9 秒内必出结论」）。
for (let i = 0; i < 60 && !probeTxt && Date.now() - tProbe < 9000; i++) {
  await page.waitForTimeout(200);
  const msg = page.locator('.backfill-msg').first();
  if ((await msg.count()) === 0) continue;
  const txt = (await msg.innerText({ timeout: 2000 }).catch(() => '')).trim();
  if (/可达|连不上/.test(txt)) probeTxt = txt;
}
ok(!!probeTxt && Date.now() - tProbe < 9000,
  `连通探针 ${((Date.now() - tProbe) / 1000).toFixed(1)}s 内给出结论（不再是一个字不动）`, probeTxt.slice(0, 80));
ok(/维基旅行/.test(probeTxt) && /维基百科/.test(probeTxt), '结论行点名两家站点（排障时知道是哪家不通）', probeTxt.slice(0, 80));
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库-维基连通.png'), fullPage: false });

// 攻略页（桩数据若在）
await page.goto(URL_BASE + '/#/history');
await page.waitForTimeout(800);
const cards = await page.locator('.gcard').count();
if (cards > 0) {
  await page.locator('.gcard').first().click();
  await page.waitForSelector('.md', { timeout: 20000 });
  await page.waitForTimeout(500);
  // 详情截图只认「现场新生成」那篇（旧攻略是照片封面）；生成失败才用历史第一条兜底
  if (!detailShotDone) await page.screenshot({ path: path.join(IMG_DIR, '攻略详情.png'), fullPage: false });
  ok(true, '攻略详情渲染（markdown）');
  const mdText = await page.locator('.md').innerText();
  // 桩模式下「生成来源」页脚如实标注「本地桩输出」是应该的；这里防的是正文顶部的桩横幅
  const mdHtml = await page.locator('.md').innerHTML();
  ok(!mdHtml.includes('alleyu:stub') && !/这是\s*ALLEYU_AI_STUB/.test(mdText), '攻略正文无桩提示横幅（来源页脚的如实标注除外）');
  // 生成中转圈图标：从已加载的 GuideView chunk 里验证是兔不是猪
  const gvUrl = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((u) => /GuideView-[\w-]+\.js$/.test(u)));
  if (gvUrl) {
    const txt = await (await page.evaluate((u) => fetch(u).then((r) => r.text()), gvUrl));
    ok(txt.includes('🐰') && !txt.includes('🐷'), '生成中转圈图标=兔子（非猪）');
  }
} else {
  console.log('  ⚠️ 无历史攻略，跳过详情截图');
}

// ---- v1.8.0 游记整理：侧栏入口 + 向导 UI 全流程 + 详情（封面/配色/编辑/导出） ----
console.log('== v1.8.0 游记整理 ==');
// 侧栏入口在「我的攻略」下方（v1.12.0 改名：游记整理 → 生成游记）
const jNav = page.locator('.side .nav-item').filter({ hasText: '生成游记' });
ok((await jNav.count()) === 1, '侧栏「生成游记」入口存在（原「游记整理」）');
await jNav.click();
await page.waitForURL('**/#/journals', { timeout: 8000 });
await page.waitForSelector('.grid3, .empty', { timeout: 6000 });
ok(true, '游记列表页渲染（方框卡片，不再是表格）');
ok((await page.locator('.tb').count()) === 0, '游记列表没有表格（v1.12.0 改成卡片）');
ok((await page.locator('.gv-head').innerText()).includes('生成游记'), '列表页标题是「生成游记」');
const newBtn = page.locator('button').filter({ hasText: '写游记（引导式）' });
ok((await newBtn.count()) === 1, '列表页「＋写游记」按钮');

// 向导：目的地联想 → 选杭州 → 跳到照片步
await newBtn.click();
await page.waitForURL('**/#/journals/new', { timeout: 8000 });
await page.waitForSelector('.wiz', { timeout: 6000 });
ok((await page.locator('.steps-bar .st').count()) === 14, '向导 14 步步骤条');
await page.fill('.q-area input.input', '杭');
await page.waitForSelector('.dest-hits .chip', { timeout: 6000 });
await page.locator('.dest-hits .chip').first().click();
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click(); // 步1存草稿（POST 建）
await page.waitForTimeout(400);
// 逐问「跳过」直奔景点步（步 2~10 都可跳）
for (let i = 0; i < 9; i++) {
  await page.locator('.nav-row button').filter({ hasText: '跳过' }).click();
}
await page.waitForSelector('.q-area .chip-row .chip', { timeout: 6000 });
const spotChipTxt = await page.locator('.q-area .chip-row .chip').first().innerText();
ok(spotChipTxt.trim().length > 0, `景点步：城市库备选可见（首选 ${spotChipTxt.trim().slice(0, 10)}）`);
await page.locator('.q-area .chip-row .chip').first().click();
ok((await page.locator('.q-area .chip.on').count()) >= 1, '勾选景点高亮');
// v1.9.0 边录边搜（需求 8）：输入即出库内建议；搜不到就按用户写的文本加
await page.locator('.spot-add input').fill('西');
await page.waitForSelector('.sug-inline .s', { timeout: 6000 });
const sugTxt = (await page.locator('.sug-inline .s').first().innerText()).trim();
ok(sugTxt.length > 0, `景点步边录边搜：输入「西」即出建议（${sugTxt.replace(/\s+/g, ' ').slice(0, 16)}）`);
await page.locator('.spot-add input').fill('手工景点Render');
await page.waitForTimeout(400);
await page.locator('.spot-add button').click();
await page.waitForFunction(() => document.querySelectorAll('.spot-list li').length === 2, null, { timeout: 6000 });
ok(true, '景点步：库内勾选 + 手输新增共 2 个（顺序即路线顺序）');
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 照片步：真上传一张 1x1 PNG + AI 配文（桩）
await page.waitForSelector('.padd', { timeout: 6000 });
const tmpPng = path.join(require('node:os').tmpdir(), 'alleyu-render-1x1.png');
fs.writeFileSync(tmpPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
ok((await page.locator('.pgroup').count()) === 2, '照片步按景点分组（2 个景点 2 组）');
ok((await page.locator('.pgroup .btn-plain').count()) === 4, '每个景点名后有无色上下按钮（2×2）');
const pgOrder1 = await page.locator('.pg-head b').allInnerTexts();
await page.locator('.pgroup').nth(1).locator('.btn-plain').first().click(); // ↑ 上移第二组
await page.waitForTimeout(700);
const pgOrder2 = await page.locator('.pg-head b').allInnerTexts();
ok(pgOrder2[0] === pgOrder1[1] && pgOrder2[1] === pgOrder1[0], `↑ 按钮真的换了景点顺序（${pgOrder1.join(' / ')} → ${pgOrder2.join(' / ')}）`);
await page.locator('.pgroup').first().locator('.note-in').fill('第一站的体会：风把柳絮吹了满脸');
await page.locator('.pgroup').first().locator('.note-in').press('Tab'); // 失焦落库
await page.waitForTimeout(400);
ok(true, '每景点名后留体会输入框（AI 融合素材）');
await page.locator('.q-area input[type=file]').first().setInputFiles(tmpPng);
await page.waitForSelector('.pbox img', { timeout: 8000 });
ok(true, '照片上传成功渲染');
const wpnum = (await page.locator('.pbox .pnum').first().innerText()).trim();
ok(/^\(photo:\d+\)$/.test(wpnum), `照片右下角标出正文占位编号（${wpnum}）`);
await page.screenshot({ path: path.join(IMG_DIR, '游记-向导.png'), fullPage: false });
await page.locator('.pbtns button').filter({ hasText: 'AI 写' }).click();
await page.waitForFunction(() => {
  const ta = document.querySelector('.pcap textarea');
  return ta && ta.value.trim().length > 0;
}, null, { timeout: 8000 });
ok(true, 'AI 配文（桩）填入体验说明');
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 合并步：默认纯旅行记录
await page.waitForSelector('.radio-row input[type=radio]', { timeout: 6000 });
const radioCount = await page.locator('.radio-row input[type=radio]').count();
ok(radioCount >= 1, `合并步：攻略选项渲染（${radioCount} 个）`);
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 生成 → 详情页 SSE 到 done
await page.locator('.nav-row button').filter({ hasText: '生成游记' }).click();
await page.waitForURL(/#\/journal\/\d+/, { timeout: 8000 });
const jidCreated = Number(((page.url().match(/journal\/(\d+)/) || [])[1])); // 收尾按这个 id 删，别靠列表顺序猜
cleanupJournalId = jidCreated;
await page.waitForFunction(() => {
  const t = document.querySelector('.cvr-title');
  return t && t.textContent.trim().length > 0;
}, null, { timeout: 20000 });
ok(true, '生成完成进详情页（封面标题就位）');
const jTitle = (await page.locator('.cvr-title').innerText()).trim();
ok(jTitle.length > 0 && jTitle.length <= 20, `AI 标题 ≤20 字（「${jTitle}」）`);
const jSub = await page.locator('.cvr-sub').innerText();
ok(jSub.includes('杭州'), '封面副标题含目的地');
ok((await page.locator('.pal').count()) === 5, '莫兰迪配色 5 套可选');
await page.locator('.pal').nth(1).click();
await page.waitForTimeout(400);
ok((await page.locator('.pal.on').innerText()).includes('豆沙粉'), '切换配色=豆沙粉');
// v1.9.0 需求 5：封面下的照片条默认折叠，展开后每张右下角标 (photo:N)
ok((await page.locator('.strip').count()) === 0, '照片条默认折叠（封面下方不铺图）');
ok((await page.locator('.thumb.on .cov-badge').count()) === 0, '折叠时看不到封面徽标（图没渲染）');
await page.locator('.strip-wrap button').filter({ hasText: '展开照片' }).click();
await page.waitForSelector('.thumb', { timeout: 6000 });
ok((await page.locator('.thumb.on .cov-badge').count()) === 1, '展开后：当前封面有徽标');
const dpnum = (await page.locator('.thumb .pnum').first().innerText()).trim();
ok(/^\(photo:\d+\)$/.test(dpnum), `照片右下角显示正文占位编号（${dpnum}）`);
await page.waitForSelector('.jr-md img', { timeout: 8000 });
ok(true, '正文 photo:N 占位换成真图');
// v1.9.0 需求 2：左侧大纲（景点排序 + 新增），需求 6：标题下方路线卡
ok((await page.locator('.out-item').count()) === 2, '左侧大纲列出全部景点');
const outOrder = await page.locator('.out-item .out-name').allInnerTexts();
ok(outOrder[0] === pgOrder2[0] && outOrder[1] === pgOrder2[1], `大纲顺序=向导里排定的顺序（${outOrder.join(' / ')}）`);
ok((await page.locator('.out-item .out-name[title*="风把柳絮"]').count()) === 1, '景点体会跟着大纲留存（hover 可见）');
await page.locator('.out-add input').fill('大纲新增点');
await page.locator('.out-add button').click();
await page.waitForFunction(() => document.querySelectorAll('.out-item').length === 3, null, { timeout: 6000 });
ok(true, '大纲可手输新增景点（落库回读）');
// 路线卡：服务端配了高德 Key 就真出图（会打外网，给足时间），没配就如实说明画不了
const routeAppear = await page.waitForSelector('.route-card', { timeout: 25000 }).then(() => true).catch(() => false);
ok(routeAppear, '标题下方出现景点路线卡（≥2 个景点自动算）');
const routeTxt = routeAppear ? (await page.locator('.route-card').innerText()).replace(/\s+/g, ' ').trim() : '';
const routeImg = routeAppear && (await page.locator('.route-img').count()) === 1;
ok(routeImg || /没画出连线/.test(routeTxt), routeImg ? `路线图出图 + 文字摘要（${routeTxt.slice(0, 70)}）` : `路线不可用时如实说明（${routeTxt.slice(0, 70)}）`);
await page.screenshot({ path: path.join(IMG_DIR, '游记-详情.png'), fullPage: false });
// v1.12.0：编辑前先导一次 PNG——此时正文还是 Markdown（覆盖旧管线），编辑后再导一次覆盖 HTML 管线
{
  const pngBeforeP = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('.jd-head button').filter({ hasText: '导出PNG' }).click();
  const pngBefore = await pngBeforeP;
  ok(pngBefore.suggestedFilename().endsWith('.png'), '编辑前（Markdown 正文）导出 PNG 成功（' + pngBefore.suggestedFilename() + '）');
}

// 二次编辑（v1.12.0 富文本）：contenteditable + 工具栏，正文图片直接显示
await page.locator('.jd-head button').filter({ hasText: '编辑' }).click();
await page.waitForSelector('.rt-editor', { timeout: 6000 });
const rtImgs0 = await page.locator('.rt-editor .rt-img').count();
ok(rtImgs0 >= 1, `富文本编辑器直接显示正文图片（${rtImgs0} 张，不再是 ![](photo:N) 文本）`);
const cap0 = (await page.locator('.rt-editor .rt-cap').first().innerText()).trim();
ok(/1×1/.test(cap0) && /(KB|B)/.test(cap0), `图片下方标注像素尺寸与体积（${cap0}）`);
ok((await page.locator('.rt-tools .rtb').count()) >= 6, '富文本工具栏（H2/H3/加粗/斜体/列表/引用/插图/撤销）');

// v1.12.1：用户点名「游记修改的富文本框内的编辑内容要有滚动条」——超长正文不许把编辑框撑到无限高
const scrollProbe = await page.locator('.rt-editor').evaluate((el) => {
  const before = el.innerHTML;
  el.innerHTML = before + new Array(60).fill('<p>滚动测试行 滚动测试行 滚动测试行</p>').join('');
  const over = el.scrollHeight > el.clientHeight + 4;
  const st = getComputedStyle(el);
  el.innerHTML = before; // 不派发 input，不触发自动保存
  return { over, oy: st.overflowY, mh: st.maxHeight };
});
ok(scrollProbe.oy === 'auto' && scrollProbe.mh !== 'none', `编辑区有高度上限并按需滚动（overflow-y:${scrollProbe.oy}，max-height:${scrollProbe.mh}）`);
ok(scrollProbe.over, '正文超出上限时编辑框内出现滚动条（scrollHeight > clientHeight）');

const jMarker = '游记编辑标记RenderE2E';
await page.locator('.rt-editor').evaluate((el, m) => {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.execCommand('insertHTML', false, '<h2>' + m + '</h2><p>富文本里加的一段。</p>');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, jMarker);
await page.waitForFunction(() => /已自动保存/.test((document.querySelector('.pb-btns') || {}).innerText || ''), null, { timeout: 10000 });
ok(true, '编辑自动保存（防抖 1.2s 后自己落库，不点按钮）');
const savedJ = await fetch(URL_BASE + '/api/journals/' + jidCreated, { headers: { Authorization: 'Bearer ' + tk } })
  .then((x) => x.json()).catch(() => ({}));
const savedContent = (savedJ.journal && savedJ.journal.content) || '';
ok(savedContent.trim().startsWith('<') && savedContent.includes(jMarker),
  '自动保存落库的是 HTML（content 首字符 <）——用户拍板「改存 HTML」', savedContent.slice(0, 80));
ok(/data-photo="\d+"/.test(savedContent) && !/\/photos\/\d+\/file/.test(savedContent),
  '入库的图片引用是 photo:N（带 token 的 URL 绝不落库）', savedContent.slice(0, 200));

// 插图来源一：从游记已上传的照片里选，并按 75% 显示
const imgCount1 = await page.locator('.rt-editor .rt-img').count();
await page.locator('.rt-tools button').filter({ hasText: '插图' }).click();
await page.waitForSelector('.img-dlg .pick', { timeout: 6000 });
await page.locator('.w-row button').filter({ hasText: '75%' }).click();
const pickMeta = (await page.locator('.img-dlg .pick .pk-meta').first().innerText()).trim();
ok(/1×1/.test(pickMeta), `照片选择器列出已上传照片与尺寸（${pickMeta}）`);
await page.locator('.img-dlg .pick').first().click();
await page.waitForFunction((n) => document.querySelectorAll('.rt-editor .rt-img').length > n, imgCount1, { timeout: 6000 });
ok(true, '从已上传照片插入：编辑区多出一张图');
ok((await page.locator('.rt-editor .rt-img').last().getAttribute('data-w')) === '75',
  '选定 75% 后插入的图片带 data-w=75（可调显示宽度）');

// 插图来源二：从本机/手机现传一张 1×1 PNG（沿用现有 base64 上传通道）
const imgCount2 = await page.locator('.rt-editor .rt-img').count();
await page.locator('.rt-tools button').filter({ hasText: '插图' }).click();
await page.waitForSelector('.img-dlg', { timeout: 6000 });
await page.locator('.img-tabs button').filter({ hasText: '本机/手机' }).click();
await page.locator('.img-dlg input[type=file]').setInputFiles(tmpPng);
await page.waitForFunction((n) => document.querySelectorAll('.rt-editor .rt-img').length > n, imgCount2, { timeout: 12000 });
const rtCaps = await page.locator('.rt-editor .rt-cap').allInnerTexts();
ok(rtCaps.some((t) => /1×1/.test(t)), '从本机上传的图也立刻显示并标注尺寸');
await page.screenshot({ path: path.join(IMG_DIR, '游记-富文本编辑.png'), fullPage: false });

await page.locator('.pb-bar button').filter({ hasText: '保存一版' }).click();
await page.waitForFunction(() => /已保存一版/.test((document.querySelector('.pb-btns') || {}).innerText || ''), null, { timeout: 10000 });
ok(true, '【保存一版】把手动版单独留档（旧名「保存修改」）');
ok(await page.locator('.pb-bar button').filter({ hasText: '恢复一版' }).isEnabled(), '【恢复一版】可用（手动版已存在）');
ok(await page.locator('.pb-bar button').filter({ hasText: '恢复原版' }).isEnabled(), '【恢复原版】可用（系统生成版已留档）');
page.once('dialog', (d) => d.accept());
await page.locator('.pb-bar button').filter({ hasText: '恢复原版' }).click();
await page.waitForFunction((m) => !document.querySelector('.rt-editor').innerText.includes(m), jMarker, { timeout: 10000 });
ok(true, '【恢复原版】回到系统自动生成的那一份（编辑标记消失）');
page.once('dialog', (d) => d.accept());
await page.locator('.pb-bar button').filter({ hasText: '恢复一版' }).click();
await page.waitForFunction((m) => document.querySelector('.rt-editor').innerText.includes(m), jMarker, { timeout: 10000 });
ok(true, '【恢复一版】回到手动保存的那一份（编辑标记回来）');
await page.locator('.pb-bar button').filter({ hasText: '取消' }).click();
await page.waitForSelector('.jr-md', { timeout: 6000 });
ok((await page.locator('.jr-md').innerText()).includes(jMarker), '取消编辑后正文即时更新');
ok((await page.locator('.jr-md .rt-img').count()) >= 1, '只读态正文图片照常显示（不显示尺寸标注）');

// ---- v1.13.0：把这篇游记发布到社区 ----
const [jpResp] = await Promise.all([
  page.waitForResponse((x) => /\/api\/community\/publish$/.test(x.url()) && x.request().method() === 'POST', { timeout: 10000 }),
  page.locator('.jd-head button').filter({ hasText: '发布到社区' }).click(),
]);
const jpJ = await jpResp.json().catch(() => ({}));
communityJournalPostId = (jpJ.post && jpJ.post.id) || 0;
ok(jpResp.ok() && communityJournalPostId > 0, `游记页「发布到社区」成功（post #${communityJournalPostId}）`);
await page.waitForFunction(() => [...document.querySelectorAll('.jd-head button')].some((b) => b.textContent.includes('取消发布')), null, { timeout: 8000 });
ok(true, '游记发布后按钮变为「取消发布」');

// 导出三件（此时正文是 HTML）：PNG（canvas）+ PDF A4 + PDF 长图
const pngDlP = page.waitForEvent('download', { timeout: 20000 });
await page.locator('.jd-head button').filter({ hasText: '导出PNG' }).click();
const pngDl = await pngDlP;
ok(pngDl.suggestedFilename().endsWith('.png'), 'HTML 正文导出 PNG 长图直接下载（' + pngDl.suggestedFilename() + '）');
if (FONTS_OK) {
  const a4DlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·A4打印' }).click();
  const a4Dl = await a4DlP;
  ok(a4Dl.suggestedFilename().endsWith('.pdf') && /A4/.test(a4Dl.suggestedFilename()), 'HTML 正文导出 PDF·A4（文件名含 A4）');
  const longDlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·长图分享' }).click();
  const longDl = await longDlP;
  ok(longDl.suggestedFilename().endsWith('.pdf') && /长图/.test(longDl.suggestedFilename()), 'HTML 正文导出 PDF·长图（文件名含 长图）');
}
// v1.9.0 需求 10：成稿后的右上角不是「重新跑一遍提示词」，而是回引导模式改答案再走一遍
ok((await page.locator('.jd-head button').filter({ hasText: '重新生成' }).count()) === 0, '成稿后不再有「重新生成」（不会原地重跑 AI）');
ok((await page.locator('.jd-head button').filter({ hasText: '回引导修改' }).count()) === 1, '成稿页右上角=「回引导修改」');
page.once('dialog', (d) => d.accept());
await page.locator('.jd-head button').filter({ hasText: '回引导修改' }).click();
await page.waitForURL(/journals\/new\?draft=\d+/, { timeout: 8000 });
await page.waitForSelector('.wiz', { timeout: 6000 });
await page.waitForFunction(() => document.querySelector('.q-area input.input') && document.querySelector('.q-area input.input').value, null, { timeout: 6000 });
ok((await page.locator('.q-area input.input').inputValue()) === '杭州', '回引导：填好的内容留着（草稿续写，不用重填）');
ok((await page.locator('.steps-bar .st').count()) === 14, '回引导后仍在 14 步向导里（可继续走完步骤）');

// 列表回看 + 清理（render 桩服务器共用真实 data/，测完删掉这篇）
await page.goto(URL_BASE + '/#/journals');
await page.waitForTimeout(800);
const jRow = page.locator('.gcard').filter({ hasText: jTitle });
ok((await jRow.count()) >= 1, '游记列表出现刚生成的一篇（方框卡片）');
ok((await page.locator('.gv-head button').filter({ hasText: '写游记（引导式）' }).count()) === 1, '卡片列表页仍有「＋ 写游记（引导式）」');
await page.screenshot({ path: path.join(IMG_DIR, '游记-列表.png'), fullPage: false });
// v1.13.0：这篇游记发布到了社区，游客测试还要用它 → 删除挪到脚本最后（连社区一起清）

// ---- v1.10.0：邀请码 / 自助注册 / 生成配额 / 权限收口 ----
// 这一组会在**真实 data/** 里造一个邀请码和一个用户，收尾必须删干净（见段末清理）。
console.log('== v1.10.0 邀请码 / 注册 / 配额 ==');
// 自检造的那条数据的唯一标记：一切「读自己那行 / 删自己那行」都认这条备注，绝不认「列表第一行」
const INV_NOTE = 'render 自检码';
const ah = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
const rnd = Math.random().toString(36).slice(2, 7); // 每次跑换新名，失败重跑不会撞用户名/邮箱唯一约束
const rUser = 'rr_' + rnd;
const rMail = 'render_' + rnd + '@example.com';
const rNick = '渲染自检' + rnd;
let rUid = 0, rInviteId = 0;

// 管理员：设置页「邀请码」页签 → 生成一个一次性码
await page.goto(URL_BASE + '/#/settings');
await page.waitForSelector('.tabs .t', { timeout: 8000 });
ok((await page.locator('.tabs .t').filter({ hasText: '邀请码' }).count()) === 1, '设置页有「邀请码」页签');
await page.locator('.tabs .t').filter({ hasText: '邀请码' }).click();
await page.waitForSelector('.grid3 input[type=number]', { timeout: 6000 });
await page.locator('button').filter({ hasText: '一次性码' }).click();
await page.fill('.grid3 input[placeholder^="例如：给老王"]', INV_NOTE);
// ⚠️ 别拿列表顺序/备注当自己那行的唯一凭据：真实库里可能已经有用户自己的邀请码、
//    也可能有**上次崩溃留下的同备注旧行**；列表还会在 POST 回包前就渲染。唯一可信的是
//    **本次 POST 的回包**（codes + invites 带 id）。读到后按码精确找行。
//    （v1.10.1 自检真踩过：认列表第一行删掉了真实库一个 500 次的老码，靠 sqlite 回收页才捞回。）
const [invResp] = await Promise.all([
  page.waitForResponse((x) => /\/api\/invites$/.test(x.url()) && x.request().method() === 'POST', { timeout: 10000 }),
  page.locator('button').filter({ hasText: '生成邀请码' }).click(),
]);
const invJson = await invResp.json().catch(() => ({}));
const inviteCode = String((invJson.codes || [])[0] || '');
rInviteId = Number(((invJson.invites || [])[0] || {}).id) || 0;
ok(/^[A-HJ-NP-Z2-9]{8}$/.test(inviteCode) && rInviteId > 0, `生成 8 位邀请码（字母表去过易混字符）：${inviteCode}`);
const invRow = page.locator('.tb tbody tr').filter({ hasText: inviteCode }).first();
await invRow.waitFor({ timeout: 8000 });
const invTxt = (await invRow.innerText()).replace(/\s+/g, ' ');
ok(/一次性/.test(invTxt) && /0 \/ 1/.test(invTxt) && new RegExp(INV_NOTE).test(invTxt), `列表显示 一次性 / 已用 0/1 / 备注（${invTxt.slice(0, 50)}）`);
await page.screenshot({ path: path.join(IMG_DIR, '邀请码.png'), fullPage: false });
const invList = await fetch(URL_BASE + '/api/invites', { headers: ah }).then((x) => x.json()).catch(() => ({ invites: [] }));
// 顺带自证：服务端按 id 反查到的行，码必须与我读到的一致
const mine = (invList.invites || []).find((x) => x.id === rInviteId);
ok(!!mine && mine.code === inviteCode, '收尾定位到自己生成的邀请码（认 POST 回包 id，不信列表顺序）');
if (!rInviteId) console.log('  ⚠️ 没定位到自检码，真实库里可能留了一条备注为「' + INV_NOTE + '」的邀请码，请手工删');

// v1.10.2：设置 → 系统 里的「公开访问地址」（分享链接域名）
await page.locator('.tabs .t').filter({ hasText: '系统' }).click();
const baseInput = page.locator('input[placeholder^="留空 = 跟随当前地址"]');
await baseInput.waitFor({ timeout: 6000 });
ok((await baseInput.count()) === 1, '设置→系统 有「公开访问地址」输入框（分享链接域名）');
const sysSettings = await fetch(URL_BASE + '/api/settings', { headers: ah }).then((r) => r.json());
ok((await baseInput.inputValue()) === (sysSettings.public_base_url || ''), `输入框载入的是库里存的值（当前「${sysSettings.public_base_url || '空 = 跟随当前地址'}」，不是写死的占位）`);

// 用户管理列表：次数列 + 累计 token 列（管理员自己也在列表里）
await page.goto(URL_BASE + '/#/users');
await page.waitForSelector('table.tb thead th', { timeout: 8000 });
const uHeads = (await page.locator('table.tb thead th').allInnerTexts()).map((t) => t.replace(/\s+/g, ''));
ok(uHeads.some((h) => h.includes('攻略次数')) && uHeads.some((h) => h.includes('游记次数')), '用户管理列表有「攻略次数/游记次数」列（已用 / 总额）');
ok(uHeads.some((h) => h.includes('累计token')), '用户管理列表有「累计 token」列');
await page.screenshot({ path: path.join(IMG_DIR, '用户管理.png'), fullPage: false });

// 普通用户视角：匿名 context 走一遍「注册 → 自动登录 → 自助改账号」
const uctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const upage = await uctx.newPage();
await upage.goto(URL_BASE + '/#/register');
await upage.waitForSelector('.dlg-card', { timeout: 8000 });
ok((await upage.locator('.dlg-card input').count()) === 5, '注册页五项表单（邮箱/昵称/用户名/密码/邀请码）');
ok(!(await upage.locator('.dlg-card button.btn').isDisabled()), '库里有可用码 → 注册按钮可点（register-open=true）');
// v1.10.1：底部 ICP 备案号（注册页）
const rbeian = upage.locator('.beian a').first();
ok((await rbeian.innerText()).trim() === '浙ICP备2026080083号-1', '注册页底部挂上备案号');
ok((await rbeian.getAttribute('href')) === 'https://beian.miit.gov.cn/' && (await rbeian.getAttribute('target')) === '_blank',
  '注册页备案号指向工信部且新窗口打开');
ok(!(await upage.locator('body').innerText()).includes('每敲一个字'), '注册页没有「每敲一个字，它就兔跳一下」这句');
await upage.screenshot({ path: path.join(IMG_DIR, '注册.png'), fullPage: false });
await upage.locator('.dlg-card button.btn').click();
ok((await upage.locator('.dlg-card .err-text').last().innerText()).includes('请填写邮箱'), '空提交：客户端先拦「请填写邮箱」（五项都必填）');
await upage.locator('.dlg-card input').nth(0).fill(rMail);
await upage.locator('.dlg-card input').nth(1).fill(rNick);
await upage.locator('.dlg-card input').nth(2).fill(rUser);
await upage.locator('.dlg-card input').nth(3).fill('renderpwd123');
await upage.locator('.dlg-card input').nth(4).fill('ZZZZZZZZ');
await upage.locator('.dlg-card button.btn').click();
await upage.waitForFunction(() => /邀请码/.test((document.querySelector('.dlg-card .err-text') || {}).innerText || ''), null, { timeout: 8000 });
ok(true, '错邀请码：服务端拒绝并回「邀请码无效或已停用」');
await upage.locator('.dlg-card input').nth(4).fill(inviteCode);
await upage.locator('.dlg-card button.btn').click();
await upage.waitForURL('**/#/', { timeout: 10000 });
await upage.waitForSelector('.corner .who', { timeout: 8000 });
ok((await upage.locator('.corner .who').innerText()).includes(rNick), '注册成功即登录（首页右上角显示昵称）');

// 需求 6：普通用户看不到 城市景点库/设置/用户管理，多一个「我的」（v1.12.0 由「我的账号」改名）
const ql = (await upage.locator('.quick-links a').allInnerTexts()).map((t) => t.trim());
ok(!ql.some((t) => /城市景点库|设置|用户管理/.test(t)), `普通用户首页入口已去掉 城市景点库/设置/用户管理（${ql.length} 项）`);
ok(ql.some((t) => /^👤\s*我的$/.test(t)), '普通用户首页多出「我的」入口（原「我的账号」）');
await upage.goto(URL_BASE + '/#/account');
await upage.waitForSelector('.side .nav-item', { timeout: 8000 });
const uNav = (await upage.locator('.side .nav-item .txt').allInnerTexts()).map((t) => t.trim());
ok(!uNav.some((t) => /设置|用户管理|城市景点库/.test(t)), `普通用户侧栏没有 设置/用户管理/城市景点库（${uNav.join(' / ')}）`);
ok(uNav.includes('我的'), '普通用户侧栏有「我的」（原「账号」）');
ok((await upage.locator('h2').first().innerText()).includes('我的'), '账号页标题=「我的」');
ok((await upage.locator('.acct-foot a').filter({ hasText: '回首页' }).count()) === 1
  && (await upage.locator('.acct-foot a').filter({ hasText: '退出登录' }).count()) === 1,
  '账号页底部有「回首页 / 退出登录」（手机端没有「更多」时的出口）');
ok((await upage.locator('.card').first().innerText()).includes(rUser), '账号页只读显示用户名（登录凭据不可改）');

// 需求 6：普通用户自己改昵称与密码
await upage.locator('.card').nth(2).locator('input').fill('自检改名' + rnd);
await upage.locator('.card').nth(2).locator('button').click();
await upage.waitForFunction(() => /昵称已更新/.test(document.body.innerText), null, { timeout: 8000 });
ok(true, '普通用户能自助改昵称（不必进管理员设置页）');
await upage.locator('.card').nth(3).locator('input').nth(0).fill('renderpwd123');
await upage.locator('.card').nth(3).locator('input').nth(1).fill('rendernew456');
await upage.locator('.card').nth(3).locator('button').click();
await upage.waitForFunction(() => /密码已修改/.test(document.body.innerText), null, { timeout: 8000 });
ok(true, '普通用户能自助改密码（原密码校验通过）');
const relog = await fetch(URL_BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: rUser, password: 'rendernew456' }) });
ok(relog.ok, '改完密码用新密码真能登录（服务端行为探针，不是只看界面提示）');
await upage.screenshot({ path: path.join(IMG_DIR, '账号.png'), fullPage: false });

// 需求 5：管理员给这个用户定死次数 → 生成页显示剩余；用光后置灰（真实服务端回包驱动）
const ulist = await fetch(URL_BASE + '/api/users', { headers: ah }).then((x) => x.json());
const nUser = (ulist.users || []).find((u) => u.username === rUser);
rUid = nUser ? nUser.id : 0;
ok(!!nUser && nUser.role === 'user' && nUser.email === rMail, '用户管理列表出现注册出来的用户（角色=user，带邮箱）');
ok(!!nUser && nUser.quota_guide === -1 && nUser.quota_journal === -1, '新注册用户配额=跟随系统默认（-1）');
ok(!!nUser && nUser.can_use_ai === true, '自助注册用户默认开通「使用全局 AI Key」');
ok(!!nUser && (nUser.allowed_pages || []).includes('guides') && (nUser.allowed_pages || []).includes('weather'), '注册用户默认页面=攻略+天气');
await fetch(URL_BASE + '/api/users/' + rUid, { method: 'PUT', headers: ah, body: JSON.stringify({ quota_guide: 2, quota_journal: 1 }) });
await upage.goto(URL_BASE + '/#/plan');
await upage.waitForSelector('input[placeholder="例如：杭州"]', { timeout: 8000 });
await upage.waitForFunction(() => /攻略剩余/.test(document.body.innerText), null, { timeout: 8000 });
const planQuota = (await upage.locator('.card span.hint').filter({ hasText: '攻略剩余' }).first().innerText()).replace(/\s+/g, '');
ok(/攻略剩余：2次/.test(planQuota), `生成攻略页给用户看剩余次数（${planQuota}）`);
await fetch(URL_BASE + '/api/users/' + rUid, { method: 'PUT', headers: ah, body: JSON.stringify({ quota_guide: 0 }) });
// 必须 reload 而不是再 goto 同一个 #/plan（URL 没变 = 没有导航，Vue 不会重新挂载，配额还是旧的 2）
await upage.reload();
await upage.waitForSelector('input[placeholder="例如：杭州"]', { timeout: 8000 });
await upage.waitForFunction(() => /已用完/.test(document.body.innerText), null, { timeout: 8000 });
ok(await upage.locator('button').filter({ hasText: '生成攻略' }).first().isDisabled(), '次数用完后「生成攻略 ✨」置灰');
ok((await upage.locator('.card .err-text').first().innerText()).includes('请联系管理员'), '用完时给出可行动的话（找管理员加次数）');
await upage.goto(URL_BASE + '/#/journals/new');
await upage.waitForSelector('.wiz', { timeout: 8000 });
await upage.waitForFunction(() => /游记剩余/.test(document.body.innerText), null, { timeout: 8000 });
const jQuota = (await upage.locator('.nav-row').first().innerText()).replace(/\s+/g, '');
ok(/游记剩余：1次/.test(jQuota), `写游记页给用户看剩余次数（${jQuota.slice(0, 40)}）`);

// ---- v1.12.0：手机端底部浮栏（390×844，普通用户 + 管理员两组） ----
// 复用上面这个已登录的普通用户，不新造账号；底栏四项必须是 <a>（button 会抢走
// 页面里「生成攻略」按钮的 locator，见 CLAUDE.md）。
console.log('== 手机端导航与游记卡片（v1.12.0） ==');
await upage.setViewportSize({ width: 390, height: 844 });
// 首页是整页布局（.full，没有侧栏也没有底栏），底栏只在「功能页」的 .shell 里出现
await upage.goto(URL_BASE + '/#/history');
await upage.waitForSelector('.m-nav a.m-item', { timeout: 8000 });
ok(await upage.locator('.m-nav').isVisible(), '手机端（390 宽）底部浮栏可见');
ok(!(await upage.locator('.side').isVisible().catch(() => false)), '手机端左侧栏隐藏');
const mLabels = (await upage.locator('.m-nav a.m-item .mtxt').allInnerTexts()).map((t) => t.trim());
ok(mLabels.length === 5 && mLabels.join('|') === '生成攻略|我的攻略|生成游记|社区|我的', `手机底栏恰好五项（v1.13.0 加「社区」）：${mLabels.join(' / ')}`);
ok((await upage.locator('.m-nav .m-more').count()) === 0, '普通用户手机端没有「更多」（管理员才有）');
const padB = await upage.locator('.main').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom) || 0);
ok(padB >= 60, `页面底部为浮栏留了位置（padding-bottom ${padB}px）`);
await upage.locator('.m-nav a.m-item[href="#/journals"]').click();
await upage.waitForURL('**/#/journals', { timeout: 8000 });
await upage.waitForSelector('.grid3, .empty', { timeout: 8000 });
ok((await upage.locator('.gv-head').innerText()).includes('生成游记'), '手机端点「生成游记」→ 生成游记页（标题已改名）');
ok((await upage.locator('.tb').count()) === 0, '游记列表是方框卡片，没有表格（.tb 为 0）');
await upage.locator('.m-nav a.m-item[href="#/account"]').click();
await upage.waitForURL('**/#/account', { timeout: 8000 });
await upage.waitForSelector('.acct-foot', { timeout: 8000 });
ok((await upage.locator('h2').first().innerText()).includes('我的'), '手机端点「我的」→ 账号页（标题已改名）');
await upage.screenshot({ path: path.join(IMG_DIR, 'mobile-我的游记.png'), fullPage: false });

// v1.13.0：底栏第五项「社区」能到（手机一列）
await upage.locator('.m-nav a.m-item[href="#/community"]').click();
await upage.waitForURL('**/#/community', { timeout: 8000 });
await upage.waitForSelector('.com-grid .com-card', { timeout: 8000 });
const mVals = await upage.locator('.com-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/));
ok(mVals.length === 1, `手机端（390）社区卡片只有一列（grid 轨道数 ${mVals.length}）`);
const mXs = new Set();
for (const b of await upage.locator('.com-grid .com-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))) mXs.add(b);
ok(mXs.size === 1, '手机端所有社区卡片左边对齐（同一列）');
await upage.screenshot({ path: path.join(IMG_DIR, 'mobile-社区.png'), fullPage: false });

// 管理员手机端：多一个「更多」，浮层里收着其余页签
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
const mpage = await mctx.newPage();
await mpage.goto(URL_BASE + '/#/history');
await mpage.waitForSelector('.m-nav .m-more', { timeout: 10000 });
ok(true, '管理员手机端底栏多出「更多」');
await mpage.locator('.m-nav .m-more').click();
await mpage.waitForSelector('.m-sheet', { timeout: 6000 });
const sheetTxt = (await mpage.locator('.m-sheet').innerText()).replace(/\s+/g, ' ');
ok(/城市景点库/.test(sheetTxt) && /用户管理/.test(sheetTxt) && /设置/.test(sheetTxt) && /回首页/.test(sheetTxt) && /退出登录/.test(sheetTxt),
  `「更多」浮层含 城市景点库/用户管理/设置/回首页/退出登录（${sheetTxt.slice(0, 30)}）`);
ok(!/生成攻略|我的攻略|生成游记|社区/.test(sheetTxt), '「更多」浮层不重复底栏那五项');
await mpage.locator('.m-sheet .m-sheet-item').filter({ hasText: '设置' }).click();
await mpage.waitForURL('**/#/settings', { timeout: 8000 });
await mpage.waitForSelector('.tabs .t', { timeout: 8000 });
ok((await mpage.locator('.tabs .t').filter({ hasText: '维基与补全' }).count()) === 1, '手机端从「更多」进设置，能看到「维基与补全」页签');
await mpage.screenshot({ path: path.join(IMG_DIR, 'mobile-设置.png'), fullPage: false });
await mctx.close();

// ---- v1.13.0：社区卡片（电脑多列）+ 客服悬浮按钮 + 留言闭环 ----
console.log('== 社区多列 / 客服悬浮按钮 / 留言闭环（v1.13.0） ==');
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(URL_BASE + '/#/community');
await page.waitForSelector('.com-grid .com-card', { timeout: 8000 });
const dVals = await page.locator('.com-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/));
ok(dVals.length >= 2, `电脑端（1280）社区卡片多列（grid 轨道数 ${dVals.length}）`);
// 卡片四要素：首图（或占位）、标题、用户名、分享日期 —— 只认我们刚发布的那两张
for (const pid of [communityGuidePostId, communityJournalPostId]) {
  const card = page.locator('.com-card[href="#/community/' + pid + '"]');
  ok((await card.count()) === 1, `社区里能按 id 找到自己发布的卡片 #${pid}`);
  if ((await card.count()) === 1) {
    const txt = (await card.innerText()).replace(/\s+/g, ' ');
    ok(/\d{4}-\d{2}-\d{2}/.test(txt), `卡片 #${pid} 有分享日期（${txt.slice(0, 40)}）`);
    ok((await card.locator('.com-author').innerText()).trim().length > 0, `卡片 #${pid} 有用户名`);
    ok((await card.locator('.com-cover img, .com-cover .ph').count()) === 1, `卡片 #${pid} 有首图或占位`);
  }
}
await page.screenshot({ path: path.join(IMG_DIR, '社区.png'), fullPage: false });

// FAB：桌面功能页可见 → 点击进留言页 → 留言页自身隐藏
await page.goto(URL_BASE + '/#/history');
await page.waitForSelector('.fab-feedback', { timeout: 8000 });
ok(await page.locator('.fab-feedback').isVisible(), '电脑端功能页右下角有客服悬浮按钮');
await page.locator('.fab-feedback').click();
await page.waitForURL('**/#/feedback', { timeout: 8000 });
await page.waitForSelector('.fb-form', { timeout: 8000 });
ok((await page.locator('.fab-feedback').count()) === 0, '留言页本身不显示悬浮按钮（不挡内容）');

// 普通用户手机端：FAB 抬到手机底栏之上，不重叠
await upage.goto(URL_BASE + '/#/history');
await upage.waitForSelector('.fab-feedback', { timeout: 8000 });
await upage.waitForSelector('.m-nav', { timeout: 8000 });
const fabBox = await upage.locator('.fab-feedback').boundingBox();
const mnavBox = await upage.locator('.m-nav').boundingBox();
ok(!!fabBox && !!mnavBox && fabBox.y + fabBox.height <= mnavBox.y + 1,
  `手机端 FAB 在底栏之上不重叠（fab 底 ${Math.round((fabBox || {}).y + (fabBox || {}).height)} / 底栏顶 ${Math.round((mnavBox || {}).y)}）`);

// 留言闭环：普通用户提交 → 回复框明说「管理员还没有回复」→ 管理员回复 → 用户刷新看到（字面 <b> 不当标签渲染）
await upage.locator('.fab-feedback').click();
await upage.waitForURL('**/#/feedback', { timeout: 8000 });
await upage.waitForSelector('.fb-form', { timeout: 8000 });
const fbIdTxt = (await upage.locator('.fb-identity').innerText()).replace(/\s+/g, ' ');
ok(fbIdTxt.includes('自检改名' + rnd) && /\d{4}-\d{2}-\d{2}/.test(fbIdTxt), `留言页身份行有当前用户名与日期（${fbIdTxt}）`);
const fbBody = 'render 自检留言 ' + rnd + '：请管理员回复';
await upage.locator('#fb-body').fill(fbBody);
const [fbResp] = await Promise.all([
  upage.waitForResponse((x) => /\/api\/feedback$/.test(x.url()) && x.request().method() === 'POST', { timeout: 10000 }),
  upage.locator('.fb-form button').click(),
]);
const fbJ = await fbResp.json().catch(() => ({}));
const fbId = (fbJ.feedback && fbJ.feedback.id) || 0;
if (fbId) renderFeedbackIds.add(fbId);
ok(fbResp.ok() && fbId > 0, `普通用户提交留言成功（feedback #${fbId}）`);
await upage.waitForFunction((id) => {
  const el = document.querySelector('.fb-item[data-id="' + id + '"] .fb-reply-empty');
  return el && el.textContent.includes('管理员还没有回复');
}, fbId, { timeout: 8000 });
ok(true, '管理员未回复时，只读回复框明确写「管理员还没有回复」');
const fbReply = '已收到 <b>加急</b> ' + rnd;
const putResp = await fetch(URL_BASE + '/api/feedback/' + fbId + '/reply', {
  method: 'PUT', headers: ah, body: JSON.stringify({ reply: fbReply }),
});
ok(putResp.ok, `管理员回复成功（HTTP ${putResp.status}）`);
await upage.reload();
await upage.waitForSelector('.fb-item[data-id="' + fbId + '"] .fb-reply-text', { timeout: 8000 });
const replyTxt = await upage.locator('.fb-item[data-id="' + fbId + '"] .fb-reply-text').innerText();
ok(replyTxt.includes('<b>加急</b>'), `用户刷新后看到管理员回复原文（${replyTxt}）`);
ok((await upage.locator('.fb-item[data-id="' + fbId + '"] .fb-reply b').count()) === 0, '回复里的 <b> 按纯文本显示，没有被当 HTML 渲染');
await upage.screenshot({ path: path.join(IMG_DIR, '客服留言.png'), fullPage: false });

await uctx.close();

// 收尾：把 render 自己造的邀请码与用户从真实库里删掉（别留自检垃圾）
// 攻略/游记（以及它们在社区里的帖子）要等游客/社区测试跑完再删 —— 见脚本最后。
if (rInviteId) {
  const d = await fetch(URL_BASE + '/api/invites/' + rInviteId, { method: 'DELETE', headers: ah });
  console.log(`  （清理 render 生成的邀请码 ${inviteCode}：HTTP ${d.status}）`);
}
if (rUid) {
  const d = await fetch(URL_BASE + '/api/users/' + rUid, { method: 'DELETE', headers: ah });
  console.log(`  （清理 render 注册的用户 ${rUser}：HTTP ${d.status}）`);
  if (!d.ok) console.log('  ⚠️ 没删掉，手工删 users 里 ' + rUser + ' 这一行');
}

// ---- v1.8.0 游客模式 + 登录页分栏（匿名 context） ----
console.log('== v1.8.0 游客模式与登录页 ==');
const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const gpage = await guest.newPage();
await gpage.goto(URL_BASE + '/#/');
await gpage.waitForSelector('.corner', { timeout: 8000 });
ok(gpage.url().includes('#/'), '游客进首页不被弹回登录页');
const cornerTxt = await gpage.locator('.corner').innerText();
ok(cornerTxt.includes('游客模式'), '右上角游客标识（' + cornerTxt.replace(/\s+/g, ' ').trim() + '）');
ok((await gpage.locator('.corner button').filter({ hasText: '登录' }).count()) === 1, '右上角登录按钮');
// v1.10.0：登录按钮旁多一个注册入口
ok((await gpage.locator('.corner button').filter({ hasText: '注册' }).count()) === 1, '游客首页右上角「登录」旁有「注册」按钮');
await gpage.screenshot({ path: path.join(IMG_DIR, '首页-游客.png'), fullPage: false });
ok((await gpage.locator('.quick-links').count()) === 0, '游客不见快捷入口（登录后才有）');

// ---- v1.13.0：游客进社区（免登录整页布局） ----
ok(await gpage.locator('.guest-community').isVisible(), '游客首页有「逛逛社区（无需登录）」入口');
await gpage.locator('.guest-community').click();
await gpage.waitForURL('**/#/community', { timeout: 8000 });
await gpage.waitForSelector('.com-grid .com-card', { timeout: 8000 });
ok((await gpage.locator('.side').count()) === 0 && (await gpage.locator('.m-nav').count()) === 0, '游客的社区页是整页布局（没有侧栏/底栏）');
ok((await gpage.locator('.com-guest-head').count()) === 1, '游客社区页自带品牌头与登录/注册入口');
const gJCard = gpage.locator('.com-card[href="#/community/' + communityJournalPostId + '"]');
ok((await gJCard.count()) === 1, `游客能看到刚发布的游记卡片 #${communityJournalPostId}`);
await gJCard.click();
await gpage.waitForURL('**/#/community/' + communityJournalPostId, { timeout: 8000 });
await gpage.waitForSelector('.com-md', { timeout: 8000 });
const gDetail = await gpage.locator('.com-md').innerText();
ok(gDetail.includes(jMarker), '游客点开游记详情，正文含编辑标记（快照内容完整）');
await gpage.waitForFunction(() => {
  const imgs = [...document.querySelectorAll('.com-md img')];
  return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
}, null, { timeout: 12000 });
ok(true, '社区详情里的游记照片公开可看（naturalWidth > 0）');
await gpage.screenshot({ path: path.join(IMG_DIR, '社区-详情.png'), fullPage: false });

// ---- v1.13.0：游客留言（游客编号 + 管理员回复可见） ----
await gpage.goto(URL_BASE + '/#/feedback');
await gpage.waitForSelector('.fb-form', { timeout: 8000 });
await gpage.waitForFunction(() => /游客 #[0-9A-F]{4}/.test(document.querySelector('.fb-identity')?.innerText || ''), null, { timeout: 8000 });
const gIdent = (await gpage.locator('.fb-identity').innerText()).replace(/\s+/g, ' ');
ok(/游客 #[0-9A-F]{4}/.test(gIdent) && /\d{4}-\d{2}-\d{2}/.test(gIdent), `游客留言页身份=游客编号 + 当前日期（${gIdent}）`);
await gpage.locator('#fb-body').fill('游客留言 render ' + rnd);
const [gFbResp] = await Promise.all([
  gpage.waitForResponse((x) => /\/api\/feedback\/open$/.test(x.url()) && x.request().method() === 'POST', { timeout: 10000 }),
  gpage.locator('.fb-form button').click(),
]);
const gFbJ = await gFbResp.json().catch(() => ({}));
const gFbId = (gFbJ.feedback && gFbJ.feedback.id) || 0;
if (gFbId) renderFeedbackIds.add(gFbId);
ok(gFbResp.ok() && gFbId > 0, `游客提交留言成功（feedback #${gFbId}）`);
const gFbReply = '游客的回复 render ' + rnd;
const gPut = await fetch(URL_BASE + '/api/feedback/' + gFbId + '/reply', {
  method: 'PUT', headers: ah, body: JSON.stringify({ reply: gFbReply }),
});
ok(gPut.ok, '管理员能回复游客留言');
await gpage.reload();
await gpage.waitForSelector('.fb-item[data-id="' + gFbId + '"] .fb-reply-text', { timeout: 8000 });
ok((await gpage.locator('.fb-item[data-id="' + gFbId + '"] .fb-reply-text').innerText()).includes(gFbReply), '游客刷新后看到管理员回复（凭 localStorage 里的游客凭证）');

await gpage.goto(URL_BASE + '/#/');
await gpage.waitForSelector('.corner', { timeout: 8000 });
await gpage.locator('.searchbar .journal-go').click();
await gpage.waitForURL('**/#/login', { timeout: 6000 });
ok(true, '游客点「写游记」→ 引导登录');
await gpage.waitForSelector('.split', { timeout: 6000 });
ok((await gpage.locator('.split .left svg').count()) >= 1, '登录页左 2/3 骑车动画');
ok((await gpage.locator('.split .left .brand h1').innerText()).includes('游巷'), '登录页左下品牌字');
ok((await gpage.locator('.split .right .dlg-card').count()) === 1, '登录页右 1/3 登录框');
ok((await gpage.locator('.dlg-card button').filter({ hasText: '注册' }).count()) === 1, '登录页登录按钮下方有「注册」按钮');
// v1.10.1：底部 ICP 备案号（登录页）
const lbeian = gpage.locator('.beian a').first();
ok((await lbeian.innerText()).trim() === '浙ICP备2026080083号-1', '登录页底部挂上备案号');
ok((await lbeian.getAttribute('href')) === 'https://beian.miit.gov.cn/', '登录页备案号指向工信部');
ok(!(await gpage.locator('body').innerText()).includes('每敲一个字'), '登录页没有「每敲一个字，它就兔跳一下」这句');
await gpage.screenshot({ path: path.join(IMG_DIR, '登录页.png'), fullPage: false });
await gpage.locator('.dlg-card button').filter({ hasText: '注册' }).click();
await gpage.waitForURL('**/#/register', { timeout: 6000 });
// 目标页是懒加载 chunk：waitForURL 只保证 hash 变了，新页可能还没挂载（此时数到的还是登录页那 2 个输入框）
let regFields = 0;
try {
  await gpage.waitForFunction(() => document.querySelectorAll('.dlg-card input').length === 5, null, { timeout: 8000 });
  regFields = 5;
} catch { regFields = await gpage.locator('.dlg-card input').count(); }
ok(regFields === 5, `登录页「注册」跳进注册页（五项表单就位，实际 ${regFields}）`);
await guest.close();

// ---- v1.13.0 收尾：删来源（社区帖子应自动撤下）→ 删自检留言 → 标记已清理 ----
console.log('== 收尾：删除自检数据（社区分享随来源一起撤下） ==');
let cleanOk = true;
if (jidCreated) {
  const d = await fetch(URL_BASE + '/api/journals/' + jidCreated, { method: 'DELETE', headers: ah });
  console.log(`  （清理 render 生成的游记 #${jidCreated}：HTTP ${d.status}）`);
  cleanOk = cleanOk && d.ok;
}
if (genRes && genRes.id) {
  const d = await fetch(URL_BASE + '/api/guides/' + genRes.id, { method: 'DELETE', headers: ah });
  console.log(`  （清理 render 生成的攻略 #${genRes.id}：HTTP ${d.status}）`);
  cleanOk = cleanOk && d.ok;
}
// 删来源后，社区里对应的分享必须自动消失（详情 404 + feed 里没有这个 id）
const feedNow = await fetch(URL_BASE + '/api/community/feed').then((x) => x.json()).catch(() => ({ posts: [] }));
const feedIds = (feedNow.posts || []).map((p) => p.id);
for (const pid of [communityJournalPostId, communityGuidePostId]) {
  if (!pid) continue;
  const det = await fetch(URL_BASE + '/api/community/feed/' + pid);
  ok(det.status === 404 && !feedIds.includes(pid), `删掉原文章后社区分享 #${pid} 自动撤下（详情 404、feed 里没有）`);
  cleanOk = cleanOk && det.status === 404;
}
for (const id of renderFeedbackIds) {
  const d = await fetch(URL_BASE + '/api/feedback/' + id, { method: 'DELETE', headers: ah });
  if (!d.ok) cleanOk = false;
}
console.log(`  （清理 render 自检留言 ${renderFeedbackIds.size} 条）`);
if (!cleanOk) console.log('  ⚠️ 有自检数据没删干净，退出钩子会再试一次（community/feedback/journals/guides 直连库删）');
renderCleaned = cleanOk;

await browser.close();
if (server) server.kill();
console.log(`\n渲染自检：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
