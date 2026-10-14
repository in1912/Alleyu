// 渲染自检（Playwright，借用工作台的 node_modules）：
//   NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs
// 断言：登录 → 首页小猪场景在跑 → 输入框打字触发兔跳（bikerRoot transform 出现负 y）
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const URL_BASE = process.env.ALLEYU_URL || 'http://localhost:9610';
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
// 关键回归：SPA 登录后不经整页刷新直达功能页，侧栏菜单必须非空（v1.1.0 修的空菜单 bug）
const navCount = await page.locator('.side .nav-item').count();
ok(navCount >= 5, 'SPA 登录后侧栏菜单非空（修复空菜单）');

// 计划表单元素
await page.waitForSelector('input[placeholder="例如：杭州"]', { timeout: 8000 });
await page.screenshot({ path: path.join(IMG_DIR, '生成攻略.png') });
ok(true, '表单渲染');

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

// 攻略页（桩数据若在）
await page.goto(URL_BASE + '/#/history');
await page.waitForTimeout(800);
const cards = await page.locator('.gcard').count();
if (cards > 0) {
  await page.locator('.gcard').first().click();
  await page.waitForSelector('.md', { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(IMG_DIR, '攻略详情.png'), fullPage: false });
  ok(true, '攻略详情渲染（markdown）');
  const mdText = await page.locator('.md').innerText();
  ok(!/本地桩输出|ALLEYU_AI_STUB/.test(mdText), '攻略正文无桩提示横幅');
} else {
  console.log('  ⚠️ 无历史攻略，跳过详情截图');
}

await browser.close();
console.log(`\n渲染自检：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
