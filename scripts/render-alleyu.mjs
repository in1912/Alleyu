// 渲染自检（Playwright，借用工作台的 node_modules）：
//   NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs
// 默认自起确定性桩服务器（ALLEYU_AI_FORCE_STUB=1，共享 data/ 的真实高德 Key 与城市库，
// 独占 9610 端口）——起因 v1.5.0：本机 data/ 存着用户真 Key，过去 render 的「现场生成」
// 一直在打真实 DeepSeek（首字 20s+、偶发空流），直播流断言随机红。
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

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// 登录页（先查占位提示已去掉，再走 SPA 登录——全程不整页刷新）
await page.goto(URL_BASE + '/#/login');
const noPlaceholder = await page.locator('input[placeholder="用户名"], input[placeholder="密码"]').count();
ok(noPlaceholder === 0, '登录框无用户名/密码占位提示');
await page.fill('input[aria-label="用户名"]', 'admin');
await page.fill('input[aria-label="密码"]', 'admin123');
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
const furGrad = await page.locator('.scene-box svg #furGrad').count();
ok(furGrad === 1 && (await page.locator('.scene-box svg #pigSkinGrad').count()) === 0, '乳白毛色渐变（旧猪皮渐变已除）');
const hasSky = await page.locator('.scene-box svg rect[fill="url(#skyGrad)"]').count();
ok(hasSky === 0, '天空已移除（透明融入页面）');
const btns = await page.locator('.scene-box button').count();
ok(btns === 0, '场景内无按钮');

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
  ok(done.content.includes('![封面地图](') && done.content.includes('## 生成来源'), '服务端：封面地图在顶部 + 生成来源页脚');
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  await page.waitForSelector('.md img', { timeout: 20000 });
  await page.waitForTimeout(600);
  const firstAlt = await page.locator('.md img').first().getAttribute('alt');
  ok(firstAlt === '封面地图', '详情页第一张图=封面地图（不再用随机照片）');
  const filt = await page.evaluate(() => { const el = document.querySelector('.md img[alt="封面地图"]'); return el ? getComputedStyle(el).filter : ''; });
  ok(/sepia/.test(filt) && /hue-rotate/.test(filt), '封面地图偏蓝单色（sepia+hue-rotate 滤镜，非黑白）');
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

await browser.close();
if (server) server.kill();
console.log(`\n渲染自检：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
