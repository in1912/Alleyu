// 「补维基介绍」的调度逻辑（v1.11.1）：把「时间预算」和「连不上就立刻停」从路由里抽出来，
// 做成纯函数（零 require、不碰 db、不 require wikiService）——这样自检能注入假 fetch + 假时钟，
// **零真实耗时**地钉死行为（mapFit.js / zipService.js 同款待遇）。
//
// 为什么要有它：生产上「一键补全全部城市景点」卡着不动的根因就是这段循环**没有上限**——
// 40 个景点 × 单条最坏 32 秒 ≈ 21 分钟，塞在一个 HTTP 请求里，反代 60 秒就断，
// 前端把失败默默吞掉，界面只剩「批量补全 1/5：城市…」定格。现在的规矩是：
//  ① 每条之前查预算，超了就停（budget_out）——请求耗时因此有上限；
//  ② 一整条景点**所有站点都连不上**（netFail）就立刻停（unreachable）——被墙拦住时下一条结果
//     一模一样，再烧预算只是让用户多等；
//  ③ fetch 抛错（离线模式 / 配置错）如实记下并停（stopped_by_error），**绝不伪装成「没这条」**。
//
// 返回 { tried, ok, miss, unreachable, budget_out, stopped_by_error, error, elapsed_ms }。
// 注意本函数不查数据库：剩余多少条（intro_left）由调用方在**无论成败都要执行**的位置去数。
async function runIntroBackfill({ need, fetch, budgetMs = 20000, onHit, now = Date.now } = {}) {
  const rows = Array.isArray(need) ? need : [];
  const t0 = now();
  const out = {
    tried: 0, ok: 0, miss: 0,
    unreachable: false, budget_out: false, stopped_by_error: false, error: '', elapsed_ms: 0,
  };
  for (const row of rows) {
    if (budgetMs > 0 && now() - t0 >= budgetMs) { out.budget_out = true; break; }
    out.tried++;
    let got;
    try {
      got = await fetch(row.name);
    } catch (e) {
      out.stopped_by_error = true;
      out.error = e && e.message ? e.message : String(e);
      break;
    }
    if (got && got.netFail) { out.unreachable = true; break; }
    if (got && got.hit) {
      if (onHit) onHit(row, got.hit);
      out.ok++;
    } else out.miss++;
  }
  out.elapsed_ms = now() - t0;
  return out;
}

module.exports = { runIntroBackfill };
