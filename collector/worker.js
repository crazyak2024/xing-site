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

import { NODES } from "./nodes.gen.js";

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
    // ⚠️ 2026-11-09 真浏览器验收才发现：**所有 BI 事件一条都没进来过**。
    //   `navigator.sendBeacon` 的跨源请求按规范是 credentials mode = include，
    //   而浏览器要求此时响应必须带 `Access-Control-Allow-Credentials: true`
    //   （且 ACAO 不能是 `*`——我们本来就回具体 origin，正好满足）。
    //   少这一行 ⟹ 预检不通过 ⟹ 请求 ERR_FAILED 被丢掉，**而 curl 验收全绿**
    //   （curl 不做预检，也不带凭据）。这就是"自己的判据看不见浏览器看见的"。
    //   承诺不破：我们从不设任何 cookie，所以 include 实际什么也带不出去。
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

// S1 新增三个 kind（2026-11-09）：search_sem = 地图认为他问的是哪个节点（node 列放节点名、
// note 列放 score/n/ms）· search_sem_fail = 语义调用挂了 · sem_pick = 他点了哪条语义建议。
// 白名单仍然保留：这个端点对匿名流量开放，不能变成任意写入口。
// S4 新增 answer = 他看到了某个问题的主题页（node 列放节点名、note 列放骨架/入选/折叠条数）。
// 它是"完成感发生在点出之前"这条设计的唯一读数：答案页被看过多少次 vs 点出去多少次。
const KINDS = new Set(["found", "not_found", "gap_wish", "search", "pick", "open",
                       "search_sem", "search_sem_fail", "sem_pick", "answer", "search_gap",
                       // 第 ④ 屏（2026-11-10）：edge_follow = 顺着哪条关系走的；
                       // not_for_me = 边纠错**唯一**的信号源，note 里带入口边。
                       "edge_follow", "not_for_me"]);

export default {
  async fetch(request, env) {
    const CORS = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/rtsearch") return rtSearch(request, env, CORS);
    if (url.pathname === "/semantic") return semantic(request, env, CORS, url);
    // 缺口车道（CY 2026-11-10）：本机守护进程用的两个端点，带 LANE_KEY 鉴权。
    if (url.pathname === "/gaplane/claim") return laneClaim(request, env, CORS);
    if (url.pathname === "/gaplane/result") return laneResult(request, env, CORS);
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
    const dropped = [];   // 被白名单挡下的 kind：**要回报，不能静默**——
    // 2026-11-09 两次踩同一个坑：前端发了新 kind、白名单忘了加，端点照回 ok:true，
    // 于是"事件没落库"和"没人来过"完全同形，只能靠事后查库才发现。回报它，一眼可辨。
    for (const e of events) {
      if (!KINDS.has(e?.kind)) { dropped.push(String(e?.kind).slice(0, 30)); continue; }
      rows.push(stmt.bind(
        e.kind,
        str(e.vid, 40), str(e.q, 120), str(e.topic, 40), str(e.node, 80),
        num(e.results), num(e.lib),
        str(e.note, 200), str(e.item, 80),
        str(e.at, 40), now));
    }
    if (!rows.length) return json(CORS, { ok: true, n: 0, dropped, kinds: KINDS.size });
    try { await env.DB.batch(rows); } catch (e) { return json(CORS, { ok: false, err: "db" }, 500); }
    return json(CORS, { ok: true, n: rows.length, dropped });
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
  //
  // **这同时也是前端的轮询端点**：它要的不只是结果，还有"慢道做到哪了"——CY 2026-11-10
  // 要求页面上必须显示"这个知识点还在完善中，约 5–10 分钟"。所以状态和结果一起回。
  const lane = await env.DB.prepare(
    "SELECT state, note, updated_at FROM gap_lane WHERE q_norm=?").bind(qNorm).first();
  const cached = await env.DB.prepare(
    "SELECT results, cost_usd, created_at FROM rt_cache WHERE q_norm=?").bind(qNorm).first();
  if (cached && (Date.now() - new Date(cached.created_at).getTime()) < CACHE_TTL_MS) {
    return json(CORS, { ok: true, verified: false, cached: true,
                        state: lane ? lane.state : "done", note: lane ? lane.note : null,
                        results: JSON.parse(cached.results) });
  }
  // 已经在队列里但快道还没出结果 ⟹ 直接回当前状态，**不要再入队一次**
  // （同一个人每 1.5 秒轮询一次，每次都 INSERT 会把 updated_at 刷成"永远新鲜"，
  //   上面那条 10 分钟孤儿回收就永远不会触发）。
  if (lane && lane.state !== "new") {
    // ⚠️ building 期间缓存里**已经有**已核完的那几条（守护进程每核完一条就写一次），
    //   这里必须把它们带回去——否则"边跑边给"在前端看起来还是"全跑完才给"。
    //   走到这里说明上面的 TTL 分支没命中（第一条还没落），回空是对的。
    return json(CORS, { ok: true, verified: false, cached: false,
                        state: lane.state, note: lane.note, results: [] });
  }

  // ② 硬预算闸：读当天已花 → 判断 → 不够就直接拒绝，不尝试"先搜后扣"
  const day = today();
  const row = await env.DB.prepare("SELECT spent_usd FROM rt_budget WHERE day=?").bind(day).first();
  const spent = row ? row.spent_usd : 0;
  if (spent >= DAILY_CAP_USD) {
    return json(CORS, { ok: true, verified: false, budget_exceeded: true, results: [] });
  }

  // ③ **入队，而不是在边缘直接搜**（CY 2026-11-10 · 架构改向）
  //
  // 这里原来是「Worker 直接 fetch 本机 Quorum」，**它从第一天起就不可能成功**：
  // Quorum 跑在 CY 那台 Mac 的 127.0.0.1 上，Cloudflare 的边缘节点物理上够不到。
  // 11-09 我把"吞掉失败"修成"大声报 502"，但那只是让假绿变成真红——通路本身仍然是断的。
  // 现在换成：**边缘只负责记下"有人要这个"，由本机守护进程出站来取**（它在 127.0.0.1
  // 这一侧，当然够得到 Quorum）。边缘不再花钱、不再碰上游，预算闸的执行点随之搬到本机。
  //
  // 🔑 **为什么这不会慢**（CY 2026-11-10 07:47 当场纠正了我的 30–90 秒）：拉和推的差别
  // 只是"本机多久问一次"这个参数，不是物理限制。实测本机↔边缘裸往返 0.94–1.49 秒，
  // 守护进程每 1.5 秒问一次 ⟹ 它在 ~1–2.5 秒内就知道有活。真正吃时间的是平台搜索本身
  // （实测抖音 14.8s / B站 6.3s，并行取大者）。端到端 8–17 秒，正是原设计说的 10–15 秒。
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO gap_lane (q_norm, q, state, created_at, updated_at) VALUES (?,?,'new',?,?) " +
    // 已经在队列里就只刷新 updated_at（让"还有人在要"这件事可见），**不要**把 working/done
    // 打回 new——否则同一个人多点两下会让本机重复付费搜同一个词。
    "ON CONFLICT(q_norm) DO UPDATE SET updated_at=excluded.updated_at"
  ).bind(qNorm, qRaw.slice(0, 60), nowIso, nowIso).run();

  const st = await env.DB.prepare(
    "SELECT state FROM gap_lane WHERE q_norm=?").bind(qNorm).first();
  return json(CORS, { ok: true, verified: false, cached: false,
                      state: st ? st.state : "new", results: [] });
}

/* ============ 缺口车道：本机守护进程的两个端点（CY 2026-11-10） ============
 *
 * 为什么要鉴权：这两个端点能读走"有人在要什么"、能往缓存里写内容。事件收集那个端点
 * 对匿名流量开放是刻意的（它只能往 ev 表写白名单 kind），这两个不行。
 * LANE_KEY 用 `wrangler secret put LANE_KEY` 下发，不进仓库、不进 wrangler.toml。
 */
function laneAuth(request, env) {
  const k = request.headers.get("X-Lane-Key") || "";
  return Boolean(env.LANE_KEY) && k === env.LANE_KEY;
}

async function laneClaim(request, env, CORS) {
  if (!laneAuth(request, env)) return json(CORS, { ok: false, err: "unauthorized" }, 401);
  if (request.method !== "POST") return json(CORS, { ok: false, err: "POST only" }, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { /* 空 body 等于默认值 */ }
  const max = Math.min(Math.max(parseInt(body?.max, 10) || 3, 1), 20);

  // 认领 = 先读后改，中间不能被另一个守护进程插进来。D1 单请求内串行，且我们按 q_norm
  // 精确 UPDATE ... WHERE state='new'，拿到的行数就是真正归自己的那几行。
  // 同时把 **卡住的 working 行放回 new**（本机被 kill / 断网 / run 被 90 分钟上限掐掉都会
  // 留下孤儿）——10 分钟没动静就当它死了，否则那个问题会永远停在 working，而用户侧看起来
  // 是"一直在找"，这正是"0 件和本来就没有同形"的那类静默失败。
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE gap_lane SET state='new' WHERE state='working' AND updated_at < ?").bind(stale).run();
  // 卡住的 fast_done（快道已出结果、慢道死在半路）**不回 new**——那会让本机重新付费搜同一个词。
  // 改成直接收尾成 done：宁可少说一句"还在完善"，不可让页面永远显示"5–10 分钟后回来"。
  const staleSlow = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE gap_lane SET state='done', note=COALESCE(note,'')||' [建到一半超时，先收尾]' " +
    "WHERE state IN ('building','fast_done') AND updated_at < ?").bind(staleSlow).run();

  const rows = await env.DB.prepare(
    "SELECT q_norm, q, created_at FROM gap_lane WHERE state='new' ORDER BY created_at LIMIT ?"
  ).bind(max).all();
  const items = rows?.results || [];
  if (items.length) {
    const nowIso = new Date().toISOString();
    await env.DB.batch(items.map(r => env.DB.prepare(
      "UPDATE gap_lane SET state='working', updated_at=? WHERE q_norm=? AND state='new'"
    ).bind(nowIso, r.q_norm)));
  }
  return json(CORS, { ok: true, n: items.length, items });
}

async function laneResult(request, env, CORS) {
  if (!laneAuth(request, env)) return json(CORS, { ok: false, err: "unauthorized" }, 401);
  if (request.method !== "POST") return json(CORS, { ok: false, err: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json(CORS, { ok: false, err: "bad json" }, 400); }
  const qNorm = (body?.q_norm || "").trim();
  if (!qNorm) return json(CORS, { ok: false, err: "q_norm required" }, 400);
  const results = Array.isArray(body?.results) ? body.results.slice(0, 12) : [];
  const cost = Number.isFinite(body?.cost_usd) ? body.cost_usd : 0;
  // 状态机（CY 2026-11-10 07:5x 追加要求：慢道的进度必须让用户在页面上看得到）：
  //   new       刚有人要
  //   working   本机认领了，正在跑快道
  //   building  正在为这个问题建知识点：**已核完的已经推上去了**，还有几条在处理
  //             （CY 2026-11-10 08:22 推翻了原来的 fast_done ——那是"先给未核验的"，
  //              他的原话：「不能因为快就给差的内容…可以边跑边给，只是全跟不全的差别」。
  //              ⟹ 变的是**完整度**不是**质量**，results 里永远只有已核验的。）
  //   fast_done 旧名，等价于 building，保留只为了不让在途的旧守护进程写入失败
  //   done      慢道也完成（核验过的内容已上站）
  //   skipped   判定不值得补（撞禁区 / 库里本来就有），没花钱
  //   failed    上游挂了，不是"没有结果"
  const state = ["working", "building", "fast_done", "done", "skipped", "failed"].includes(body?.state)
    ? body.state : "done";
  const note = str(body?.note, 200);
  const nowIso = new Date().toISOString();

  const ops = [
    env.DB.prepare(
      "UPDATE gap_lane SET state=?, note=?, updated_at=? WHERE q_norm=?"
    ).bind(state, note, nowIso, qNorm),
  ];
  // failed 不写缓存：否则一次瞬时故障会在 24h TTL 内把这个词钉死成"没有结果"
  // （这正是 11-09 修过的那个坑，换个位置会再咬一次）。
  if (state !== "failed") {
    ops.push(env.DB.prepare(
      "INSERT INTO rt_cache (q_norm, results, cost_usd, created_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(q_norm) DO UPDATE SET results=excluded.results, cost_usd=excluded.cost_usd, created_at=excluded.created_at"
    ).bind(qNorm, JSON.stringify(results), cost, nowIso));
  }
  if (cost > 0) {
    ops.push(env.DB.prepare(
      "INSERT INTO rt_budget (day, spent_usd) VALUES (?,?) " +
      "ON CONFLICT(day) DO UPDATE SET spent_usd = spent_usd + ?"
    ).bind(today(), cost, cost));
  }
  await env.DB.batch(ops);
  return json(CORS, { ok: true, state, n: results.length });
}

/* ============ 语义搜索（CY 2026-11-09 01:15「能用就用」批 Workers AI） ============
 *
 * 做什么：把用户打的字和 35 个知识节点（ai1 23 + fin1 12）比语义相似度，返回最接近的
 * 三个节点。**不替代**前端现有的关键词匹配——向量擅长"换句话说"，不擅长专有名词精确
 * 匹配（实测「ElevenLabs怎么用」最高只到 0.542，比离题问句高不了多少）。两层并存：
 * 关键词负责"打对了名字"，语义负责"说的是人话但没打中词"。
 *
 * 为什么用 Workers AI 而不是 OpenAI embedding：同一个 Cloudflare 账号、零新凭据、
 * 不出 Cloudflare 网（少一跳出站），免费层 10,000 neurons/天 ≈ 9.3M input tokens/天，
 * 按一次查询十几个 token 算是 40 万次/天量级，这个站用不到千分之一。
 * 实测（2026-11-09，35 节点 / 13 条留出问法）：节点名+典型问法索引命中 12/13。
 *
 * ⚠️ 同 rtsearch：**只上端点，前端没接**，app.js 现在不会调用它。接进搜索框
 * （什么时候触发、怎么跟关键词结果合并、"没有好答案"怎么说）会改变用户看到的东西，
 * 单独一轮做、单独验。
 */
const EMBED_MODEL = "@cf/baai/bge-m3";
// 判「这个问题我们地图上没有对应节点」的下限。实测分隔度（n=15）：离题问句最高 0.542，
// 正确命中最低 0.656 —— 0.60 落在这条缝里。样本小，上线后要用真实查询重标，别当定数。
const SEM_MIN = 0.60;
const EMBED_BATCH = 50;          // 一次 AI.run 不喂太多条，避免撞上模型侧的批量上限

// 模块级缓存：同一 isolate 内复用节点向量。冷启动要多花一次 ~1-2s 把 105 条索引文本
// 向量化，之后每次请求只向量化用户那一句。**故意不落 D1/KV**——节点表会改，缓存越持久
// 越容易指向旧节点；isolate 生命周期天然就是"部署一次失效一次"，正好是我们要的语义。
let VEC_CACHE = null;

async function embedTexts(env, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const r = await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + EMBED_BATCH) });
    const d = r?.data;
    if (!Array.isArray(d)) throw new Error("embed: unexpected shape");
    out.push(...d);
  }
  return out;
}

async function nodeVecs(env) {
  if (VEC_CACHE) return VEC_CACHE;
  const texts = [], owner = [];
  NODES.forEach((n, i) => n.texts.forEach(t => { texts.push(t); owner.push(i); }));
  const vecs = await embedTexts(env, texts);
  VEC_CACHE = { vecs, owner };
  return VEC_CACHE;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function semantic(request, env, CORS, url) {
  const t0 = Date.now();
  let q = "", domain = "";
  if (request.method === "GET") {
    q = (url.searchParams.get("q") || "").trim();
    domain = url.searchParams.get("domain") || "";
  } else if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json(CORS, { ok: false, err: "bad json" }, 400); }
    q = (body?.q || "").trim();
    domain = body?.domain || "";
  } else {
    return json(CORS, { ok: false, err: "GET or POST" }, 405);
  }
  if (!q || q.length > 60) return json(CORS, { ok: false, err: "bad q" }, 400);

  let idx, qv;
  try {
    idx = await nodeVecs(env);
    [qv] = await embedTexts(env, [q]);
  } catch (e) {
    // 向量化挂了就老实说挂了，别回一个空结果让前端以为"地图上没有"
    return json(CORS, { ok: false, err: "embed failed" }, 502);
  }

  const best = new Map();                       // 节点下标 → 该节点所有索引文本里的最高相似度
  for (let j = 0; j < idx.vecs.length; j++) {
    const i = idx.owner[j];
    if (domain && NODES[i].domain !== domain) continue;
    const s = cosine(qv, idx.vecs[j]);
    if (s > (best.get(i) ?? -2)) best.set(i, s);
  }
  const top = [...best.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    // `n` = 该节点下已核验内容条数，`kind` = map（正式地图节点）/ gap（判定器自动开的）。
    // 前端要用 n 来区分"有货"和"地图上有这个问题但一条内容都没有"——两种话术不一样。
    .map(([i, s]) => ({ domain: NODES[i].domain, id: NODES[i].id, kind: NODES[i].kind,
                        name: NODES[i].name, n: NODES[i].n,
                        score: Math.round(s * 1000) / 1000 }));

  return json(CORS, {
    ok: true, q, model: EMBED_MODEL, ms: Date.now() - t0,
    confident: top.length > 0 && top[0].score >= SEM_MIN,   // false ⟹ 地图上大概没有这个问题
    threshold: SEM_MIN, top,
  });
}
