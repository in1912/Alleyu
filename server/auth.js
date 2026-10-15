// 鉴权与权限：仿工作台 auth.js 的三层模型 —— 登录 → 页权限（PAGES/pageForPath）→ tab 权限（TAB_PATHS）。
// 令牌通道：Authorization: Bearer 头为主，?token= 查询参数兜底（<img>/EventSource 直链场景）。
const crypto = require('crypto');
const { db } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

const SESSION_DAYS = 7;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions(token,user_id,expires_at)
     VALUES(?,?,datetime('now','localtime','+${SESSION_DAYS} days'))`
  ).run(token, userId);
  return token;
}
function resolveUser(req) {
  const header = req.headers.authorization || '';
  const candidates = [];
  if (header.startsWith('Bearer ')) candidates.push(header.slice(7));
  const q = req.query.token;
  if (typeof q === 'string') candidates.push(q);
  else if (Array.isArray(q)) candidates.push(...q.filter(Boolean).map(String));
  for (const token of candidates) {
    if (!token) continue;
    const row = db.prepare(
      `SELECT u.id, u.username, u.role, u.display_name, u.allowed_pages, u.allowed_tabs, u.can_use_ai
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token=? AND s.expires_at > datetime('now','localtime')`
    ).get(token);
    if (row) return {
      ...row,
      can_use_ai: !!row.can_use_ai,
      allowed_pages: JSON.parse(row.allowed_pages || '[]'),
      allowed_tabs: JSON.parse(row.allowed_tabs || '{}'),
    };
  }
  return null;
}
function destroySession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (typeof req.query.token === 'string' ? req.query.token : '');
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')").run();
}

// ---------- 页权限 ----------
// 页 key → 侧栏入口。攻略生成另有 can_use_ai 闸（路由内检查，admin 恒可用）。
const PAGES = ['guides', 'library', 'weather', 'settings'];

function pageForPath(p) {
  if (p.startsWith('/guides') || p.startsWith('/guide') || p.startsWith('/plan') || p.startsWith('/history') || p.startsWith('/journals') || p.startsWith('/journal')) return 'guides';
  if (p.startsWith('/cities') || p.startsWith('/attractions') || p.startsWith('/library') || p.startsWith('/poi') || p.startsWith('/import-poi')) return 'library';
  if (p.startsWith('/weather')) return 'weather';
  if (p.startsWith('/ai') || p.startsWith('/users') || p.startsWith('/settings')) return 'settings';
  return null; // /amap 共享通道（登录即可）：图片代理给 <img> 直链用
}

// 页 → [{tab, [API前缀]}]（相对 /api；相等或 前缀+/ 开头）
const TAB_PATHS = {
  settings: [
    ['ai', ['/ai', '/settings']],
    ['users', ['/users']],
  ],
};

function tabForPath(page, p) {
  const defs = TAB_PATHS[page];
  if (!defs) return null;
  for (const [tab, prefixes] of defs) {
    for (const pre of prefixes) {
      if (p === pre || p.startsWith(pre + '/')) return tab;
    }
  }
  return null;
}

function canAccess(user, page, tab) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!page) return true;
  const allowed = user.allowed_pages || [];
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (!allowed.includes(page)) return false;
    if (tab) {
      const tabs = user.allowed_tabs || {};
      if (tabs && typeof tabs === 'object' && page in tabs) {
        const list = tabs[page];
        if (Array.isArray(list) && !list.includes(tab)) return false;
      }
    }
  }
  return true;
}

// ---------- 初始管理员 ----------
function initAdmin() {
  cleanupSessions();
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count === 0) {
    const uname = process.env.DEFAULT_ADMIN || 'admin';
    const upass = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    db.prepare("INSERT INTO users(username,password_hash,role,can_use_ai,allowed_pages) VALUES(?,?,?,1,'[]')")
      .run(uname, hashPassword(upass), 'admin');
    console.log(`[auth] 已创建初始管理员 ${uname}（密码 ${upass}，请登录后立即修改）`);
  }
}

module.exports = {
  hashPassword, verifyPassword, createSession, resolveUser, destroySession,
  PAGES, pageForPath, canAccess, tabForPath, TAB_PATHS, initAdmin,
};
