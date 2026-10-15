// 入口：Express + 静态前端 + API。架构仿工作台 index.js：
//  - EXEMPT 免登录前缀（login/health/系统信息/图片直链）
//  - 其余走 resolveUser → 页/tab 三层权限（401 未登录 / 403 无权限，均为 JSON）
//  - 前端走 web/dist 最新时间戳目录 + SPA 兜底
const express = require('express');
const path = require('path');
const fs = require('fs');
const { resolveUser, pageForPath, tabForPath, canAccess, initAdmin } = require('./auth');

const app = express();
app.disable('x-powered-by');
// 上限 12mb：游记照片走 base64 JSON 上传（8MB 照片 base64 后 ~10.7mb，route 级再按真实字节数卡 8MB/张；
// 全局 parser 先跑，限太低会在到达 route 校验前就 413——journalRoutes 里的 40mb 解析器实际是兜底）
app.use(express.json({ limit: '12mb' }));

// 免登录通道（前缀匹配，相对 /api 挂载点的路径）：登录、健康检查、系统信息、图片直链（<img>/EventSource 带不了头）、分享公开读
const EXEMPT = ['auth/login', 'health', 'system-info', 'amap/mapimg', 'amap/photo', 'share'];

// /api/system-info 挂在根上（免登录的版本探针）
app.get('/api/system-info', require('./routes/settingsRoutes').systemInfo);

app.use('/api', (req, res, next) => {
  const rel = req.path.replace(/^\/+/, '');
  if (EXEMPT.some((pre) => rel === pre || rel.startsWith(pre + '/'))) return next();

  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;

  const page = pageForPath(req.path);
  const tab = page ? tabForPath(page, req.path) : null;
  if (page && !canAccess(user, page, tab)) return res.status(403).json({ error: '没有该页面的访问权限' });
  next();
});

// 路由挂载（需登录；顺序无讲究，路径不重叠）
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api', require('./routes/cityRoutes'));      // /api/cities /api/attractions /api/poi /api/import-poi
app.use('/api/guides', require('./routes/guideRoutes'));
app.use('/api/journals', require('./routes/journalRoutes')); // v1.8.0 游记整理
app.use('/api/share', require('./routes/shareRoutes')); // 公开分享读（EXEMPT：token 即凭证）
app.use('/api/amap', require('./routes/amapRoutes'));
app.use('/api/weather', require('./routes/weatherRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 兼容挂载在子路径（如 NAS 反代 /alleyu/）
app.set('trust proxy', true);

// ---------- 前端静态 ----------
const webRoot = path.join(__dirname, '..', 'web');
function latestDist() {
  const dir = path.join(webRoot, 'dist');
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir).filter((n) => /^\d{8,}$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  return entries.length ? path.join(dir, entries[entries.length - 1]) : null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  const dist = latestDist();
  if (!dist) return next();
  if (req.path === '/' || req.path === '/index.html') {
    return res.sendFile(path.join(dist, 'index.html'));
  }
  const file = path.join(dist, req.path.replace(/^\/+/, ''));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return res.sendFile(file);
  }
  res.sendFile(path.join(dist, 'index.html')); // SPA 兜底
});

// 404 JSON（API 未命中）
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 错误兜底：永远回 JSON（前端按 JSON 解析）
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server]', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

initAdmin();

const PORT = Number(process.env.PORT) || 9610;
app.listen(PORT, () => {
  console.log(`[游巷 Alleyu] http://localhost:${PORT}  (admin 初始密码见启动日志)`);
});
