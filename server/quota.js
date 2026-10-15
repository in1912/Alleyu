// 生成配额：攻略/游记各一条「累计总额」额度，用光为止（用户 2026-10-15 定调）。
//
// 语义
//  - 用户列 quota_guide / quota_journal：-1=跟随系统默认 / -2=不限 / >=0=指定总额
//  - 系统默认存 settings：quota_default_guide / quota_default_journal，空串=不限
//  - 只记「已用」，不记「剩余」（剩余永远现算，改配额立即生效）
//  - 管理员不受限，也不显示剩余
//
// 扣减时机：只有真出成稿（status='done'）才扣 —— 挂在 guideService.run() 与
// journalService.run() 写 done 的那一行之后。AI 失败、断流、内容过短自动重试都不扣。
const { db, getSetting } = require('./db');

const FOLLOW_DEFAULT = -1;
const UNLIMITED = -2;

const KIND = {
  guide: { quotaCol: 'quota_guide', usedCol: 'guide_used', defKey: 'quota_default_guide', label: '攻略' },
  journal: { quotaCol: 'quota_journal', usedCol: 'journal_used', defKey: 'quota_default_journal', label: '游记' },
};

// settings 里的默认次数 → 数字；空/非法一律当「不限」
function defaultLimit(kind) {
  const raw = String(getSetting(KIND[kind].defKey) || '').trim();
  if (!raw) return UNLIMITED;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return UNLIMITED;
  return Math.floor(n);
}

// 单用户额度：admin 恒不限；-1 跟随默认；-2 不限；>=0 指定总额
function limitOf(userRow, kind) {
  if (!userRow) return UNLIMITED;
  if (userRow.role === 'admin') return UNLIMITED;
  const k = KIND[kind];
  const raw = userRow[k.quotaCol];
  const q = raw === null || raw === undefined || raw === '' ? FOLLOW_DEFAULT : Number(raw);
  if (!Number.isFinite(q)) return defaultLimit(kind);
  if (q === UNLIMITED) return UNLIMITED;   // 只有 -2 是不限
  if (q < 0) return defaultLimit(kind);    // -1 与其他脏负值都回落系统默认（宁可少给不可误开）
  return Math.floor(q);
}

const usedOf = (userRow, kind) => {
  const n = Number(userRow && userRow[KIND[kind].usedCol]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// 前端展示用：{ unlimited, limit, used, left }（left 在不限时为 null）
function quotaState(userRow, kind) {
  const limit = limitOf(userRow, kind);
  const used = usedOf(userRow, kind);
  if (limit === UNLIMITED) return { unlimited: true, limit: null, used, left: null };
  return { unlimited: false, limit, used, left: Math.max(0, limit - used) };
}

// 路由闸门：返回错误对象（含 403）或 null=放行
function checkQuota(userRow, kind) {
  const st = quotaState(userRow, kind);
  if (st.unlimited || st.left > 0) return null;
  return {
    status: 403,
    error: `你的${KIND[kind].label}生成次数已用完（共 ${st.limit} 次），请联系管理员增加`,
  };
}

// 成功出稿后 +1。带条件 UPDATE，防并发同时通过闸门时超扣超过 1 次。
function consumeQuota(userId, kind) {
  const k = KIND[kind];
  try {
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!row) return;
    const limit = limitOf(row, kind);
    if (limit === UNLIMITED) return;
    const info = db.prepare(
      `UPDATE users SET ${k.usedCol} = ${k.usedCol} + 1 WHERE id=? AND ${k.usedCol} < ?`
    ).run(userId, limit);
    if (info.changes !== 1) console.warn(`[quota] 用户 ${userId} 的${k.label}已用次数未累加（已到上限或并发）`);
  } catch (e) {
    // 记账失败不该毁掉已经生成好的内容
    console.warn('[quota] 记账失败：' + (e && e.message));
  }
}

module.exports = { KIND, FOLLOW_DEFAULT, UNLIMITED, defaultLimit, limitOf, quotaState, checkQuota, consumeQuota };
