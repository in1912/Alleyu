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
    env: { ...process.env, ALLEYU_AI_FORCE_STUB: '1' },
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
  await fetch(URL_BASE + '/api/settings', { method: 'PUT', headers: ahSet, body: JSON.stringify({ public_base_url: 'http://alleyu.in1912.cn' }) });
  await page.locator('.dlg button').filter({ hasText: '关闭' }).click();
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  await page.waitForSelector('.gv-head button', { timeout: 8000 });
  await page.locator('.gv-head button').filter({ hasText: '分享' }).click();
  await page.waitForSelector('.share-row', { timeout: 6000 });
  const basedUrl = (await page.locator('.share-row .share-url').first().innerText()).trim();
  ok(basedUrl.startsWith('http://alleyu.in1912.cn/#/s/'), `配了公开访问地址 → 链接照它拼（${basedUrl.slice(0, 42)}…）`);
  ok((await page.locator('.share-row a').filter({ hasText: '打开' }).first().getAttribute('href')) === basedUrl, '链接行「打开」按钮指向同一地址（点开就能验证链接通不通）');
  await fetch(URL_BASE + '/api/settings', { method: 'PUT', headers: ahSet, body: JSON.stringify({ public_base_url: setBefore.public_base_url || '' }) });
  const setAfter = await fetch(URL_BASE + '/api/settings', { headers: ahSet }).then((r) => r.json());
  ok((setAfter.public_base_url || '') === (setBefore.public_base_url || ''), `公开访问地址用后还原（原值「${setBefore.public_base_url || '空'}」，不给真实库留自检残留）`);
  await page.locator('.dlg button').filter({ hasText: '关闭' }).click();

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

// v1.6.0：设置页只有三页签（个人 AI 配置已下线，全站唯一全局 Key）
await page.goto(URL_BASE + '/#/settings');
await page.waitForSelector('.tabs .t', { timeout: 6000 });
const setTabs = await page.locator('.tabs .t').allInnerTexts();
ok(setTabs.length === 3 && !setTabs.some((t) => t.includes('我的 AI')), '设置页三页签（AI 全局/邀请码/系统，个人配置与改密码已下线）');
ok(setTabs.some((t) => t.includes('邀请码')), '三页签里有「邀请码」（v1.10.0 新增）');

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
// v1.10.1：批量补全只挑「零景点」城市——按钮 title 与页脚说明都要写明「跳过」
const bfAllBtn = page.locator('button', { hasText: '补全全部缺景点城市' });
ok((await bfAllBtn.count()) === 1, '景点页签有「补全全部缺景点城市」按钮');
ok(/跳过/.test((await bfAllBtn.first().getAttribute('title')) || ''), '批量补全按钮标题写明「已有景点的城市一律跳过」');
const libTail = await page.locator('.card .hint').last().innerText();
ok(/一个景点都没有/.test(libTail) && /跳过/.test(libTail), '页脚说明写明只补「一个景点都没有」的城市、已有景点的一律跳过');
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库-景点.png'), fullPage: false });

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
// 侧栏入口在「我的攻略」下方
const jNav = page.locator('.side .nav-item').filter({ hasText: '游记整理' });
ok((await jNav.count()) === 1, '侧栏「游记整理」入口存在');
await jNav.click();
await page.waitForURL('**/#/journals', { timeout: 8000 });
await page.waitForSelector('.tb', { timeout: 6000 });
ok(true, '游记列表页渲染');
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
// 二次编辑：自动保存 → 保存一版 → 恢复原版 → 恢复一版
await page.locator('.jd-head button').filter({ hasText: '编辑' }).click();
await page.waitForSelector('.editarea', { timeout: 6000 });
const jMarker = '游记编辑标记RenderE2E';
await page.locator('.editarea').evaluate((el, m) => { el.value += '\n\n## ' + m + '\n'; el.dispatchEvent(new Event('input', { bubbles: true })); }, jMarker);
await page.waitForFunction(() => /已自动保存/.test((document.querySelector('.pb-btns') || {}).innerText || ''), null, { timeout: 10000 });
ok(true, '编辑自动保存（防抖 1.2s 后自己落库，不点按钮）');
await page.locator('.pb-bar button').filter({ hasText: '保存一版' }).click();
await page.waitForFunction(() => /已保存一版/.test((document.querySelector('.pb-btns') || {}).innerText || ''), null, { timeout: 10000 });
ok(true, '【保存一版】把手动版单独留档（旧名「保存修改」）');
ok(await page.locator('.pb-bar button').filter({ hasText: '恢复一版' }).isEnabled(), '【恢复一版】可用（手动版已存在）');
ok(await page.locator('.pb-bar button').filter({ hasText: '恢复原版' }).isEnabled(), '【恢复原版】可用（系统生成版已留档）');
page.once('dialog', (d) => d.accept());
await page.locator('.pb-bar button').filter({ hasText: '恢复原版' }).click();
await page.waitForFunction((m) => !document.querySelector('.editarea').value.includes(m), jMarker, { timeout: 10000 });
ok(true, '【恢复原版】回到系统自动生成的那一份（编辑标记消失）');
page.once('dialog', (d) => d.accept());
await page.locator('.pb-bar button').filter({ hasText: '恢复一版' }).click();
await page.waitForFunction((m) => document.querySelector('.editarea').value.includes(m), jMarker, { timeout: 10000 });
ok(true, '【恢复一版】回到手动保存的那一份（编辑标记回来）');
await page.locator('.pb-bar button').filter({ hasText: '取消' }).click();
await page.waitForSelector('.jr-md', { timeout: 6000 });
ok((await page.locator('.jr-md').innerText()).includes(jMarker), '取消编辑后正文即时更新');
// 导出三件：PNG（canvas）+ PDF A4 + PDF 长图
const pngDlP = page.waitForEvent('download', { timeout: 20000 });
await page.locator('.jd-head button').filter({ hasText: '导出PNG' }).click();
const pngDl = await pngDlP;
ok(pngDl.suggestedFilename().endsWith('.png'), '导出 PNG 长图直接下载（' + pngDl.suggestedFilename() + '）');
if (FONTS_OK) {
  const a4DlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·A4打印' }).click();
  const a4Dl = await a4DlP;
  ok(a4Dl.suggestedFilename().endsWith('.pdf') && /A4/.test(a4Dl.suggestedFilename()), '导出 PDF·A4（文件名含 A4）');
  const longDlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·长图分享' }).click();
  const longDl = await longDlP;
  ok(longDl.suggestedFilename().endsWith('.pdf') && /长图/.test(longDl.suggestedFilename()), '导出 PDF·长图（文件名含 长图）');
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
const jRow = page.locator('.tb td').filter({ hasText: jTitle });
ok((await jRow.count()) >= 1, '游记列表出现刚生成的一篇');
await page.screenshot({ path: path.join(IMG_DIR, '游记-列表.png'), fullPage: false });
if (jidCreated) {
  const del = await fetch(URL_BASE + '/api/journals/' + jidCreated, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tk } });
  console.log(`  （清理 render 生成的游记 #${jidCreated}：HTTP ${del.status}）`);
  if (!del.ok) console.log('  ⚠️ 没删掉，手工删 journals 里这一行 + data/journal_photos/' + jidCreated + '/');
}

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
await page.locator('button').filter({ hasText: '生成邀请码' }).click();
// ⚠️ 别拿 `.tb tbody tr` 的 .first() 当自己那行：真实库里可能已经有用户自己的邀请码，
//    列表在 POST 回包前就渲染好了，`waitForSelector('.tb tbody tr td b')` 会立刻命中**旧行**，
//    于是读到——并在收尾按码反查 id 时**删掉**——别人的邀请码。认准自己填的那条备注。
//    （v1.10.1 自检真踩过：删掉了真实库里一个 500 次的老码，靠 sqlite 回收页把原值捞回来才复原。）
const invRow = page.locator('.tb tbody tr').filter({ hasText: INV_NOTE }).first();
await invRow.waitFor({ timeout: 8000 });
const inviteCode = (await invRow.locator('td b').innerText()).trim();
ok(/^[A-HJ-NP-Z2-9]{8}$/.test(inviteCode), `生成 8 位邀请码（字母表去过易混字符）：${inviteCode}`);
const invTxt = (await invRow.innerText()).replace(/\s+/g, ' ');
ok(/一次性/.test(invTxt) && /0 \/ 1/.test(invTxt) && new RegExp(INV_NOTE).test(invTxt), `列表显示 一次性 / 已用 0/1 / 备注（${invTxt.slice(0, 50)}）`);
await page.screenshot({ path: path.join(IMG_DIR, '邀请码.png'), fullPage: false });
const invList = await fetch(URL_BASE + '/api/invites', { headers: ah }).then((x) => x.json()).catch(() => ({ invites: [] }));
// 按**自己那条备注**反查 id（不用码——码只是转手，真正独一无二的是备注）；顺带自证：查到的那行码必须与我读到的一致
const mine = (invList.invites || []).find((x) => x.note === INV_NOTE);
ok(!!mine && mine.code === inviteCode, '收尾定位到自己生成的邀请码（按备注反查，不会误删别人的码）');
rInviteId = (mine || {}).id || 0;
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

// 需求 6：普通用户看不到 城市景点库/设置/用户管理，多一个「我的账号」
const ql = (await upage.locator('.quick-links a').allInnerTexts()).map((t) => t.trim());
ok(!ql.some((t) => /城市景点库|设置|用户管理/.test(t)), `普通用户首页入口已去掉 城市景点库/设置/用户管理（${ql.length} 项）`);
ok(ql.some((t) => t.includes('我的账号')), '普通用户首页多出「我的账号」入口');
await upage.goto(URL_BASE + '/#/account');
await upage.waitForSelector('.side .nav-item', { timeout: 8000 });
const uNav = (await upage.locator('.side .nav-item .txt').allInnerTexts()).map((t) => t.trim());
ok(!uNav.some((t) => /设置|用户管理|城市景点库/.test(t)), `普通用户侧栏没有 设置/用户管理/城市景点库（${uNav.join(' / ')}）`);
ok(uNav.includes('账号'), '普通用户侧栏有「账号」');
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
await uctx.close();

// 收尾：把 render 自己造的邀请码与用户从真实库里删掉（别留自检垃圾）
// v1.10.2：攻略也一并删——以前只删游记，真实库里攒了 5 篇桩攻略（id 111~115：111~113 挂在管理员名下、
//          114/115 的作者账号已删），用户看到列表里一堆「杭州 3 天」的假数据。
if (genRes && genRes.id) {
  const d = await fetch(URL_BASE + '/api/guides/' + genRes.id, { method: 'DELETE', headers: ah });
  console.log(`  （清理 render 生成的攻略 #${genRes.id}：HTTP ${d.status}）`);
  if (!d.ok) console.log(`  ⚠️ 没删掉，手工删 guides 里 id=${genRes.id} 这一行`);
}
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

await browser.close();
if (server) server.kill();
console.log(`\n渲染自检：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
