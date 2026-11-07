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
