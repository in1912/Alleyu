// 累计 token 记账（v1.10.0，用户点名：用户管理列表要能看到每人累计消耗，管理员自己也算）。
//
// 诚实边界（重要）：
//  - 只在服务商回包真的带 usage 时累加。没有 usage 就什么都不记——不估算、不编造。
//  - 桩模式（cfg.source==='stub'）不记：否则本地自检会把 token 数字刷成假的。
//  - 只记 token，不落任何对话内容（日志与库里都不出现正文）。
const { db } = require('../db');

// usage 形如 { prompt_tokens, completion_tokens }（OpenAI 兼容口径）
function recordUsage(userId, usage) {
  if (!userId || !usage) return;
  const pin = Number(usage.prompt_tokens);
  const pout = Number(usage.completion_tokens);
  const tin = Number.isFinite(pin) && pin > 0 ? Math.floor(pin) : 0;
  const tout = Number.isFinite(pout) && pout > 0 ? Math.floor(pout) : 0;
  if (!tin && !tout) return; // 服务商给的是空/怪值 → 不记
  try {
    db.prepare('UPDATE users SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id=?')
      .run(tin, tout, userId);
  } catch (e) {
    console.warn('[usage] token 记账失败：' + (e && e.message));
  }
}

module.exports = { recordUsage };
