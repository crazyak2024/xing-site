/* 醒 · BI 收集端点（Cloudflare Worker + D1）
 *
 * 为什么是这个形状：
 * - **第一方**。我们自己的 20 行代码、我们自己的域，不是嵌一段别人家的统计脚本。
 *   这件事很重要——站上明写着「没有第三方脚本」，接 GA/友盟那类东西等于当场作废那句话。
 * - **零成本**。Workers 免费额度 10万请求/天，D1 免费额度 5GB；这个站的量级连千分之一都用不到。
 * - vectorherd.com 已经整域托在 Cloudflare（实测：NS 是 tom/elma.ns.cloudflare.com，
 *   notes 子域走 Zero Trust tunnel），所以不需要新买域名、不需要新账号。
 *
 * **匿名口径（部署前请再读一遍）**：前端送来的 vid 存在 sessionStorage，关标签页即失效，
 * 跨访问拼不出个人档案。这里**不要**落 IP、不要落 User-Agent、不要发 Set-Cookie——
 * charter 明文禁止观看行为画像，而且那行"不认识你"就挂在用户眼前。
 *
 * 部署（CY 本人跑，需要 Cloudflare 登录态）：
 *   npm i -g wrangler && wrangler login
 *   cd site/collector
 *   wrangler d1 create xing-bi                      # 把返回的 database_id 填进 wrangler.toml
 *   wrangler d1 execute xing-bi --remote --file=schema.sql
 *   wrangler deploy                                  # 输出一个 https://xing-bi.<账号>.workers.dev
 * 然后把那个地址填进 site/app.js 的 COLLECT_URL，推一次即生效。
 *
 * 看数（不用建后台，先用命令行就够）：
 *   wrangler d1 execute xing-bi --remote --command \
 *     "SELECT kind, COUNT(*) FROM ev GROUP BY 1"
 *   wrangler d1 execute xing-bi --remote --command \
 *     "SELECT q, COUNT(*) n FROM ev WHERE kind='search' AND results=0 GROUP BY 1 ORDER BY n DESC LIMIT 30"
 *   ↑ 第二条就是**内容缺口清单**：用户搜了、我们一条都没有的词。
 */

// 只放行我们自己的来源，不开 `*`。现在站点在 GitHub Pages；live.vozo.ai 先放进来，
// 迁站那天少一步（多一个允许的来源不增加风险，少一个会在迁站当天静默报 CORS 错）。
const ALLOWED = new Set([
  "https://crazyak2024.github.io",
  "https://live.vozo.ai",
]);

function cors(request) {
  const o = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(o) ? o : "https://crazyak2024.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const KINDS = new Set(["found", "not_found", "gap_wish", "search", "pick", "open"]);

export default {
  async fetch(request, env) {
    const CORS = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/rtsearch") return rtSearch(request, env, CORS);
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

    let body;
    try { body = await request.json(); } catch (e) { return json(CORS, { ok: false, err: "bad json" }, 400); }
    const events = Array.isArray(body?.events) ? body.events.slice(0, 200) : [];
    if (!events.length) return json(CORS, { ok: true, n: 0 });

    // 服务端时间戳独立记一列：客户端的钟不可信（时区/手动改过都见过）
    const now = new Date().toISOString();
    const stmt = env.DB.prepare(
      "INSERT INTO ev (kind, vid, q, topic, node, results, lib, note, item, client_at, server_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)");

    const rows = [];
    for (const e of events) {
      if (!KINDS.has(e?.kind)) continue;          // 未知事件类型直接丢，别让端点变成任意写入口
      rows.push(stmt.bind(
        e.kind,
        str(e.vid, 40), str(e.q, 120), str(e.topic, 40), str(e.node, 80),
        num(e.results), num(e.lib),
        str(e.note, 200), str(e.item, 80),
        str(e.at, 40), now));
    }
    if (!rows.length) return json(CORS, { ok: true, n: 0 });
    try { await env.DB.batch(rows); } catch (e) { return json(CORS, { ok: false, err: "db" }, 500); }
    return json(CORS, { ok: true, n: rows.length });
  },
};

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const num = v => (Number.isFinite(v) ? Math.trunc(v) : null);
const json = (CORS, o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ============ rt1：实时补搜两速原型（CY 2026-11-07 21:45 批「推荐做」） ============
 *
 * 只做"快道"：3-8 秒内给用户刚从平台拿到的**未核验**结果（标题/封面/链接），不做 ASR、
 * 不做核验、不写进 content_work——那是"慢道"，仍然要靠本机 Python 流水线，这个 Worker
 * 不碰。rt_cache 命中 = 下一个问同样问题的人直接免费拿缓存（不是免费，是摊薄）。
 *
 * ⚠️ 这是今天新上的功能，**只部署了端点，前端还没接**——app.js 目前不会调用它。
 * 接入搜索 UI（命中为 0 时才触发、怎么展示"未核验"标签）是下一步，故意没有在同一轮里
 * 一次性接完：那一步会改变真实用户看到的东西，值得单独测过再上。
 *
 * 硬预算闸（服务端强制，不是前端配合）：每天 $DAILY_CAP，打满直接回"未搜索"，
 * 不会因为闸失效而超支——闸本身就是"读当天花费→判断→执行→落账"四步在一次 D1 事务里，
 * Workers 单请求天然串行执行同一隔离环境内的代码，不会有并发竞态把闸冲穿。
 */
const DAILY_CAP_USD = 0.50;      // 极度保守的起始值：先验证机制对不对，不是先验证能撑多大量
const PLATFORMS_FAST = ["bilibili", "douyin"];  // B站 最便宜+有字幕，抖音次之；视频号$0.02/条太贵不进快道
const CACHE_TTL_MS = 24 * 3600 * 1000;

// 与 pipeline/discover.py 的 cheap_filter 同一套判据，**这里是 JS 口径，必须跟 Python 手动对齐**
// ——两份实现是本设计已知的技术债，不是忽略了可以共享一份代码（Worker 不能 import Python）。
const ANXIETY_BAIT = /不学.{0,6}被淘汰|淘汰了|再不.{0,6}就晚了|必须立刻|再不学|失业|落后的人|你还在.{0,6}吗/;
const AD_BAIT = /下方.{0,4}链接|点击.{0,4}购买|优惠.{0,4}券|限时.{0,4}折扣|加.{0,4}微信.{0,4}领/;
const DRAMA_BAIT = /短剧|穿越|重生|虐恋|逆袭|爽文|霸道总裁|豪门|甜宠/;

function cheapFilterJs(title, duration_s, likes) {
  const text = title || "";
  const stripped = text.replace(/#\S+/g, "");
  if (ANXIETY_BAIT.test(text)) return false;
  if (AD_BAIT.test(text)) return false;
  if (DRAMA_BAIT.test(stripped)) return false;
  if (typeof likes === "number" && likes === 0) return false;
  if (typeof duration_s === "number" && duration_s > 0 && duration_s < 30) return false;
  return true;
}

function today() { return new Date().toISOString().slice(0, 10); }

async function rtSearch(request, env, CORS) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json(CORS, { ok: false, err: "POST only" }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json(CORS, { ok: false, err: "bad json" }, 400); }
  const qRaw = (body?.q || "").trim();
  if (!qRaw || qRaw.length > 60) return json(CORS, { ok: false, err: "bad q" }, 400);
  const qNorm = qRaw.toLowerCase();

  // ① 缓存命中：免费，且是"归一化到问题"而不是"归一化到字面"——这正是线㉚ 说的真正杠杆，
  //    但这一版只做了字面 trim+lower 的归一化，没有做语义归并（那需要 LLM，快道等不起）。
  const cached = await env.DB.prepare(
    "SELECT results, cost_usd, created_at FROM rt_cache WHERE q_norm=?").bind(qNorm).first();
  if (cached && (Date.now() - new Date(cached.created_at).getTime()) < CACHE_TTL_MS) {
    return json(CORS, { ok: true, verified: false, cached: true,
                        results: JSON.parse(cached.results) });
  }

  // ② 硬预算闸：读当天已花 → 判断 → 不够就直接拒绝，不尝试"先搜后扣"
  const day = today();
  const row = await env.DB.prepare("SELECT spent_usd FROM rt_budget WHERE day=?").bind(day).first();
  const spent = row ? row.spent_usd : 0;
  if (spent >= DAILY_CAP_USD) {
    return json(CORS, { ok: true, verified: false, budget_exceeded: true, results: [] });
  }

  // ③ 真实调用 Quorum（只打快道两站，不碰视频号——它取流贵、这里又不取流只搜索，没必要碰）
  let totalCost = 0;
  const results = [];
  for (const platform of PLATFORMS_FAST) {
    try {
      const r = await fetch(`${env.QUORUM_URL}/v1/search/videos`, {
        method: "POST",
        headers: { "X-API-Key": env.QUORUM_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ platform, keyword: qRaw }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      // 真实响应形状（curl 实测）：{schema_version, data:[...items], meta:{cost_usd,...}}
      // ——不是 python SDK SearchPage 的 .items/.cost_usd 属性名，那是客户端包装后的名字。
      totalCost += data?.meta?.cost_usd || 0;
      for (const it of (data?.data || []).slice(0, 8)) {
        const title = it.caption || it.title || "";
        const dur = it.duration_s;
        const likes = it.stats?.likes;
        if (!cheapFilterJs(title, dur, likes)) continue;
        results.push({ platform, title: title.slice(0, 80), link: it.url || "",
                       cover: it.media?.cover_url || "", duration_s: dur || null });
      }
    } catch (e) { /* 单站失败不拖垮另一站，宁可少一半结果也别整体失败 */ }
  }

  // ④ 落账：缓存结果 + 记花费（即使零结果也要记，因为搜索调用已经花了钱）
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rt_cache (q_norm, results, cost_usd, created_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(q_norm) DO UPDATE SET results=excluded.results, cost_usd=excluded.cost_usd, created_at=excluded.created_at"
    ).bind(qNorm, JSON.stringify(results), totalCost, new Date().toISOString()),
    env.DB.prepare(
      "INSERT INTO rt_budget (day, spent_usd) VALUES (?,?) " +
      "ON CONFLICT(day) DO UPDATE SET spent_usd = spent_usd + ?"
    ).bind(day, totalCost, totalCost),
  ]);

  return json(CORS, { ok: true, verified: false, cached: false, cost_usd: totalCost, results });
}
