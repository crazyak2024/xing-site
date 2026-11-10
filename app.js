/* 醒 · 前端
 *
 * UX 的核心主张（CY 2026-11-07 06:5x）：**这个网站本身是一张知识地图，搜索是入口之一。**
 * 雅虎模式（点几下就到一个视频集）× Google 模式（直接问）的结合，而且地图不画全世界——
 * 只画"你此刻所在的那一小块"。
 *
 * 一个状态三个字段，页面是它的投影：
 *   state = { q: 搜索词, topic: 选中的主题, node: 选中的问题节点 }
 * 地图区把这个状态画出来，并且本身可点——点一下就是改状态，然后再搜，形成环而不是漏斗。
 *
 * 地图区的三种形态（同一个组件，不是三套导航）：
 *   S0 什么都没选 → 画顶层：4 个主题 × 各自的主要问题节点（两次点击到视频集）
 *   S1 只选了主题 → 画该主题下的全部节点 + 横向可跳的其它主题
 *   S2 搜了词 / 选了节点 → 画**局部地图**：这批结果真实涉及的节点（跨主题，按主题分行）
 *      —— 这是"聪明"的那部分：邻居不是我手写的分类树，是从命中内容反推出来的共现关系
 *
 * 为什么只画有内容的节点：空目录是雅虎之死。节点条数为 0 就不画。
 */

const PLATFORM_CN = { douyin: "抖音", wechat_channels: "视频号" };
/* 可嵌入的平台。视频号官方嵌入只存在于微信小程序里，网页做不到（平台限制，不是我们技术不行）。
 * B站：`player.bilibili.com/player.html` 是**官方外链播放器**（页面 title 自称
 * "External Player - 哔哩哔哩嵌入式外链播放器"），2026-11-07 实测响应头
 * **无 X-Frame-Options、无 CSP frame-ancestors** ⟹ 允许被嵌。横屏 16:9，
 * 所以弹窗宽度不能沿用抖音那套 420px 竖屏尺寸。 */
const EMBED_URL = {
  douyin: (vid) => `https://open.douyin.com/player/video?vid=${vid}&autoplay=1`,
  bilibili: (vid) => `https://player.bilibili.com/player.html?bvid=${vid}&autoplay=0&high_quality=1&danmaku=0`,
};
// 嵌入画面的宽高比：抖音竖屏、B站横屏。弹窗按这个选宽度。
const EMBED_SHAPE = { douyin: "portrait", bilibili: "landscape" };

// 4 个主题 4 个固定色——**不再按分类名哈希**。颜色的单位是主题（4 色封顶），
// 不是问题节点（20+ 色），这正是 CY 说"颜色没逻辑、一眼看花"的根源。
const TOPIC_COLOR = {
  "概念原理": "#2b6cb0",
  "方法实操": "#38a169",
  "误区纠正": "#dd6b20",
  "时效选择": "#805ad5",
};
const TOPIC_HINT = {
  "概念原理": "为什么会这样、里面怎么运转",
  "方法实操": "怎么做、怎么用、从哪上手",
  "误区纠正": "流传的说法到底对不对",
  "时效选择": "现在该选哪个（会过期）",
};

let DATA = [];          // 当前领域内的内容（下面所有渲染都只看这个）
let DATA_LOADED = false; // data.json 到底回来没有——用来分辨"还没到"和"真没有"
let ALL_DATA = [];      // 全部内容（跨领域）
let DATA_EDGES = {};    // 知识地图的边：{节点名: [{type,dst,why}]}，详情页用
let TOPICS = [];
let DOMAIN_LIST = [];   // [{id,label,count}]，只含真有合格内容的领域
const state = { q: "", topic: null, node: null, domain: null };

/* 哪些主题行在 S1/S2 被手动展开过（CY 2026-11-08 10:5x：「section下tag太多了，无法阅读了，
   而且把视频推到太下面」）。不进 state/URL——只是这一屏的临时展示状态，换个主题/搜索词
   就该重新收起，不该跨导航保留。 */
const expandedRows = new Set();
const ROW_CHIP_MAIN = 8; // 单行最多先亮出几个节点，其余折进"其他N条"（S0 同款阈值的行版）

/* 领域切换（fin1 起）：领域是比主题更粗的一级——"AI 与大模型"和"财经基础"下面各有
   自己的 4 个主题。为什么要这一级：不分的话"概念原理"里会同时出现 Transformer 和
   通货膨胀，用户点进去看到的是两个不相干领域搅在一起。
   ⚠️ 只有在**真有 2 个以上领域有内容**时才显示这个切换条——只有一个领域时它是纯噪音。 */
function applyDomain() {
  DATA = state.domain ? ALL_DATA.filter(it => it.domain === state.domain) : ALL_DATA;
  const el = document.getElementById("lib-count");
  if (el) el.textContent = DATA.length;
}
function domainBarHtml() {
  if (DOMAIN_LIST.length < 2) return "";
  const btn = (id, label, n) =>
    `<button class="dchip${(state.domain === id || (!state.domain && id === null)) ? " on" : ""}" ` +
    `data-domain="${id === null ? "" : esc(id)}">${esc(label)}${n ? ` <span class="dn">${n}</span>` : ""}</button>`;
  return `<div class="domain-bar">` + btn(null, "全部领域", ALL_DATA.length) +
    DOMAIN_LIST.map(d => btn(d.id, d.label, d.count)).join("") + `</div>`;
}

/* ---------- 工具 ---------- */
function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}分${sec}秒` : `${sec}秒`;
}
/* 发布时间（CY 2026-11-07 20:52 要求"每一个视频发布的时间得写上去"）。
 * 为什么它不是装饰：这个领域里"2026-02 的模型选型推荐"和"2026-11 的"价值差一个量级，
 * 用户必须能一眼看到新旧，而不是读完才发现讲的是半年前的产品。
 * 拿不到发布时间的（上游没给）**显式写"发布时间未知"**，不留空——留空会被当成"刚发的"。 */
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtAge(s) {
  const d = new Date(s);
  if (!s || isNaN(d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0) return "";
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${(days / 365).toFixed(1)}年前`;
}
function esc(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function topicColor(t) { return TOPIC_COLOR[t] || "#718096"; }
function hitsQuery(it, q) {
  if (!q) return true;
  return (it.title + " " + (it.summary || "") + " " + (it.node || "") + " " + (it.author || "")).toLowerCase().includes(q);
}

/* ---------- 三个层次的集合 ----------
 * matchedByQuery : 只按搜索词过滤 —— 局部地图的取景范围（所以点地图能横跳，不会把自己锁死）
 * filtered       : 搜索词 + 主题 + 节点 —— 结果区真正展示的
 */
function matchedByQuery() { return DATA.filter(it => hitsQuery(it, state.q)); }
function filtered() {
  return matchedByQuery().filter(it =>
    (!state.topic || it.topic === state.topic) && (!state.node || it.node === state.node));
}

/** 地图取景范围：搜了词就以命中集为范围；只选了主题就以该主题为范围；都没有就是全部。
 *  注意**不**把 node 算进来——否则点进一个节点后地图只剩自己，就跳不出去了。 */
function mapScope() {
  if (state.q) return matchedByQuery();
  if (state.topic) return DATA.filter(it => it.topic === state.topic);
  return DATA;
}
function countBy(items, key) {
  const m = new Map();
  for (const it of items) m.set(it[key], (m.get(it[key]) || 0) + 1);
  return m;
}

/* ---------- 状态改写（地图上每一次点击都走这里） ---------- */
function go(patch) {
  // 换节点就把"其余N条"收回去：展开状态属于那一页，不该跟着导航走
  if ("node" in patch && patch.node !== state.node) evExpanded = false;
  Object.assign(state, patch);
  render();
  // BI：他点了地图上的哪一格。只在真的选中某一层时记，取消选择不记（避免噪音）
  if (typeof emit === "function" && (patch.node || patch.topic)) {
    emit("pick", { picked: patch.node ? "node" : "topic" });
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- 面包屑 ---------- */
function renderCrumbs() {
  const el = document.getElementById("crumbs");
  const parts = [`<button class="crumb" data-go="all">全部</button>`];
  if (state.topic) parts.push(`<button class="crumb" data-go="topic" style="color:${topicColor(state.topic)}">${esc(state.topic)}</button>`);
  if (state.node) parts.push(`<span class="crumb current">${esc(state.node)}</span>`);
  if (state.q) parts.push(`<span class="crumb q">搜索「${esc(state.q)}」<button class="crumb-x" data-go="clearq" title="清除搜索词">×</button></span>`);
  el.innerHTML = parts.length > 1 ? parts.join(`<span class="sep">›</span>`) : "";
  el.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.go === "all") go({ topic: null, node: null });
    if (b.dataset.go === "topic") go({ node: null });
    if (b.dataset.go === "clearq") { document.getElementById("q").value = ""; go({ q: "" }); }
  }));
}

/* ---------- 地图区 ---------- */
function nodeChip(node, n, topic, isCurrent) {
  return `<button class="chip${isCurrent ? " current" : ""}" data-node="${esc(node)}" data-topic="${esc(topic)}"
    style="--c:${topicColor(topic)}">${esc(node)}<span class="n">${n}</span></button>`;
}

function renderMap() {
  const el = document.getElementById("map");
  const scope = mapScope();
  let html = "";

  if (!state.q && !state.topic && !state.node) {
    /* S0 顶层目录：4 个主题卡。每卡只列 ≥2 条的节点，单条的汇总成"其他"——
       否则首屏就是一堆"1 条"的碎节点，又回到看花眼。 */
    const byTopic = new Map();
    for (const it of DATA) {
      if (!byTopic.has(it.topic)) byTopic.set(it.topic, []);
      byTopic.get(it.topic).push(it);
    }
    html = `<div class="map-intro">点一个主题，或直接点下面的问题——两下就到内容。也可以用上面的搜索框直接问。</div>
      <div class="topic-grid">` + TOPICS.filter(t => byTopic.has(t)).map(t => {
      const items = byTopic.get(t);
      const nodes = [...countBy(items, "node").entries()].sort((a, b) => b[1] - a[1]);
      const main = nodes.filter(([, n]) => n >= 2).slice(0, 5);
      const restN = nodes.filter(([, n]) => n < 2).reduce((s, [, n]) => s + n, 0);
      return `<div class="topic-card" style="--c:${topicColor(t)}">
          <button class="topic-head" data-topic-only="${esc(t)}">
            <span class="dot"></span><span class="tname">${esc(t)}</span><span class="tn">${items.length}条</span>
          </button>
          <div class="thint">${esc(TOPIC_HINT[t] || "")}</div>
          <div class="chips">
            ${main.map(([node, n]) => nodeChip(node, n, t, false)).join("")}
            ${restN ? `<button class="chip more" data-topic-only="${esc(t)}">其他 ${restN} 条…</button>` : ""}
          </div>
        </div>`;
    }).join("") + `</div>`;
  } else {
    /* S1 / S2 局部地图：把取景范围里真实存在的节点按主题分行画出来。
       搜了词 → 这是"围绕这个搜索的知识地图"；只选了主题 → 这是该主题的目录。 */
    const rows = TOPICS.map(t => {
      const its = scope.filter(it => it.topic === t);
      if (!its.length) return null;
      const nodes = [...countBy(its, "node").entries()].sort((a, b) => b[1] - a[1]);
      return { t, n: its.length, nodes };
    }).filter(Boolean);

    const label = state.q
      ? `围绕「${esc(state.q)}」的知识地图 —— 命中内容落在这些问题上，点一个就只看它`
      : `${esc(state.topic || "")} 下的问题 —— 点一个进去`;
    html = `<div class="map-label">${label}</div>` + rows.map(r => {
      // 一行最多先亮出 ROW_CHIP_MAIN 个节点，其余折进"其他N条"——不然标签把视频挤到看不见
      // （CY 2026-11-08 10:5x 截图实锤：一个主题 25+ 个节点原样铺开，视频区要滚好几屏才到）。
      // 当前选中的节点若被挤进"其他"里，强制拉回主列表，不能让高亮的东西自己藏起来。
      const expanded = expandedRows.has(r.t);
      let main = r.nodes, rest = [];
      if (!expanded && r.nodes.length > ROW_CHIP_MAIN) {
        main = r.nodes.slice(0, ROW_CHIP_MAIN);
        rest = r.nodes.slice(ROW_CHIP_MAIN);
        if (state.node && rest.some(([node]) => node === state.node)) {
          const idx = rest.findIndex(([node]) => node === state.node);
          main = [...main, rest[idx]];
          rest = rest.filter((_, i) => i !== idx);
        }
      }
      const restN = rest.reduce((s, [, n]) => s + n, 0);
      return `
      <div class="map-row">
        <button class="row-topic" data-topic-only="${esc(r.t)}" style="--c:${topicColor(r.t)}">
          <span class="dot"></span>${esc(r.t)}<span class="n">${r.n}</span>
        </button>
        <div class="chips">
          ${main.map(([node, n]) => nodeChip(node, n, r.t, node === state.node)).join("")}
          ${restN ? `<button class="chip more" data-expand-row="${esc(r.t)}">其他 ${restN} 条…</button>` : ""}
        </div>
      </div>`;
    }).join("");
    if (!rows.length) html = `<div class="map-label">没有命中任何问题节点，换个说法试试，或点上面的「全部」回到地图。</div>`;
  }

  el.innerHTML = domainBarHtml() + html;
  el.querySelectorAll("[data-domain]").forEach(b => b.addEventListener("click", () => {
    // 换领域 = 清掉主题/节点/搜索词：旧的选择在新领域里多半不存在，留着只会显示空结果
    const id = b.dataset.domain || null;
    const qbox = document.getElementById("q");
    if (qbox) qbox.value = "";
    state.domain = id;
    applyDomain();
    go({ topic: null, node: null, q: "" });
  }));
  el.querySelectorAll("[data-node]").forEach(b => b.addEventListener("click", () => {
    const node = b.dataset.node;
    // 点已选中的节点 = 取消它（回到主题范围），不用再去找清除按钮
    go(node === state.node ? { node: null } : { node, topic: b.dataset.topic });
  }));
  el.querySelectorAll("[data-topic-only]").forEach(b => b.addEventListener("click", () => {
    const t = b.dataset.topicOnly;
    go(t === state.topic && !state.node ? { topic: null } : { topic: t, node: null });
  }));
  // 原地展开"其他N条"——不导航（已经在这个主题里了，没有别处可去），只重画地图区
  el.querySelectorAll("[data-expand-row]").forEach(b => b.addEventListener("click", () => {
    expandedRows.add(b.dataset.expandRow);
    renderMap();
  }));
}

/* ---------- 搜索范围提示 ---------- */
function renderScopeHint() {
  const el = document.getElementById("scope-hint");
  if (state.q && (state.topic || state.node)) {
    el.innerHTML = `正在「${esc(state.node || state.topic)}」范围内搜索 ·
      <button class="linklike" id="search-all">在全部内容里搜</button>`;
    el.querySelector("#search-all").addEventListener("click", () => go({ topic: null, node: null }));
  } else {
    el.innerHTML = "";
  }
}

/* ---------- 主题页（S4 · CY 批 vr2 第五件，2026-11-09） ----------
 * R9 的那一刀：**完成感必须发生在点出之前**。用户点开抖音/B站链接那一刻他已经在别人的
 * app 里了，微信内没有回来的路径 ⟹ 指望他"看完视频觉得搞懂了"是指望一件我们看不见也
 * 影响不到的事。所以主题页自己把答案给完：答案在前 → 视频退居证据位 → 页尾明确说可以关了。
 * R9 还指出：真正的落地页是**节点页**，不是搜索框。这就是那个页。
 *
 * 数据来自 pages.json（pipeline/render_pages.py 确定性渲染，顺序取自审计表 map_log）。
 * 前端**不重排** picks：顺序是编辑判断过、逐条有理由可回查的那一份，不是前端当时算出来的。
 * pages.json 拿不到就安静退回原来的列表视图——答案区是增强，不是前提。
 */
let PAGES = new Map();      // node -> page
let evExpanded = false;     // 「其余N条」是否已展开；换节点时重置
let lastAnswerNode = null;  // 只在节点变化时记一次 BI，不是每次重绘

/* pages.json 的 node 用的是**展示名**（和 data.json 同一套，编号/「地图缺口」已剥掉），
   所以这里直接用 state.node 查就行，前端不再做第二次名字规整——两端各自规整是
   "join 不上但两边都不报错"那类 bug 的温床（本次真浏览器验收就撞到一次）。 */
function currentPage() { return state.node ? PAGES.get(state.node) : null; }
function topicOfNode(n) {
  const hit = ALL_DATA.find(it => it.node === n);
  return hit ? hit.topic : null;
}

function renderAnswer() {
  const el = document.getElementById("answer");
  if (!el) return;
  const p = currentPage();
  if (!p || !(p.outline || []).length) { el.innerHTML = ""; lastAnswerNode = null; return; }
  const r = p.receipt || {};
  const disputed = (p.disputed || []).length ? `
    <div class="ans-disputed">
      <div class="dh">这个问题上，内容之间有分歧——我们不替你选边</div>
      <ul>${p.disputed.map(d => `<li>${esc(d.claim || "")}
        ${d.sides ? `<div class="sides">${esc(d.sides)}</div>` : ""}</li>`).join("")}</ul>
    </div>` : "";
  el.innerHTML = `<div class="ans" style="--c:${topicColor(topicOfNode(p.node))}">
      <p class="ans-q">${esc(p.node)}</p>
      <p class="ans-lead">下面就是答案。我们读完了这个问题下全部 ${r.qualified} 条合格内容，
        把它们讲的合并成一份——不是某一条视频的说法。</p>
      <ol>${p.outline.map(x => `<li>${esc(x)}</li>`).join("")}</ol>
      ${disputed}
      <p class="ans-foot"><b>答完了。关掉就行。</b>
        还想看讲述过程，下面 ${r.picked} 条视频是它的证据——我们从 ${r.qualified} 条里挑的，
        ${r.folded ? `另有 ${r.folded} 条讲的是同一件事，默认折起来了` : "没有多余的重复"}${
    r.rejected ? `；还有 ${r.rejected} 条没过关，没放上来` : ""}。</p>
    </div>`;
  if (lastAnswerNode !== p.node) {
    lastAnswerNode = p.node;
    emit("answer", { note: `outline=${p.outline.length} picked=${r.picked} folded=${r.folded || 0}` });
  }
}

/** 证据区：picks 按审计顺序一条条给，每条上面写清它在这个答案里负责哪一段。 */
function renderEvidence(el, items, page) {
  const byId = new Map(items.map(it => [it.id, it]));
  const staleWhy = new Map((page.stale || []).map(s => [s.id, s.why]));
  const picks = (page.picks || []).filter(p => byId.has(p.id));
  const restRows = (page.order || []).filter(o => o.bucket !== "pick" && byId.has(o.id));

  const evBlock = (p) => {
    const it = byId.get(p.id);
    const cov = (p.covers || []).length
      ? `<span class="cov">对应上面第 ${p.covers.map(i => i + 1).join("、")} 点</span> · ` : "";
    const why = staleWhy.get(p.id);
    return `<div class="ev">
        <p class="ev-role">${cov}${esc(p.role || "")}${
      p.unique ? `<br>只有它讲了：${esc(p.unique)}` : ""}
        ${why ? `<div class="ev-stale">⏳ 可能过时：${esc(why)}</div>` : ""}</p>
        <div class="grid">${cardHtml(it)}</div>
      </div>`;
  };

  el.innerHTML = `
    <div class="ev-head"><span class="t">证据</span>
      <span class="n">${picks.length} 条，按读的顺序</span></div>
    ${picks.map(evBlock).join("")}
    ${restRows.length ? (evExpanded
      ? `<div class="ev-head"><span class="t">这个问题下其余的内容</span>
           <span class="n">${restRows.length} 条</span></div>
         <p class="ev-foldnote">没入选不代表不好——多数是和上面某一条讲的同一件事。
           每条都有一句为什么没入选，鼠标停在卡片上能看到。</p>
         <div class="grid">${restRows.map(o =>
        cardHtml(byId.get(o.id), o.reason)).join("")}</div>`
      : `<button class="ev-more" id="ev-more">其余 ${restRows.length} 条（多数与上面重复）…</button>`)
    : ""}`;

  const more = el.querySelector("#ev-more");
  if (more) more.addEventListener("click", () => { evExpanded = true; renderResults(); });
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(DATA.find(it => it.id === c.dataset.id))));
}

/* ---------- 结果区 ---------- */
/* 平台优先级（CY 2026-11-07 21:27 定）：「B站的视频质量会高一些，如果有B站的视频的话，
 * 我都会倾向于优先放B站的视频」。这是**明确的编辑方针，不是热度排序**——所以它排在
 * 标题字典序之前、但排在搜索命中度之后（搜得准仍然优先于平台偏好）。
 * 有实测支撑：B站均时长 1112s（抖音 340 / 视频号 234），是三站唯一的长讲解形态，
 * 且 87% 自带官方字幕（证据可追溯到逐句原文），这两点都指向"讲得更完整"。 */
const PLATFORM_RANK = { bilibili: 0, douyin: 1, wechat_channels: 2 };

function sortItems(items) {
  const q = state.q;
  return [...items].sort((a, b) => {
    if (q) {
      const sc = it => (it.title.toLowerCase().includes(q) ? 10 : 0) + ((it.summary || "").toLowerCase().includes(q) ? 3 : 0);
      const d = sc(b) - sc(a);
      if (d) return d;
    }
    const pd = (PLATFORM_RANK[a.platform] ?? 9) - (PLATFORM_RANK[b.platform] ?? 9);
    if (pd) return pd;
    return (a.title || "").localeCompare(b.title || "", "zh");
  });
}

/* 卡片 v2（CY 2026-11-07 反馈后重做）：带缩略图+互动数+要点式摘要。
 * DoD（CY原话）："视觉体验好，内容效率高，用户看到3-5秒就大概知道这个视频的主题，
 * 并决定是否要点开"。三处具体改动对应他的三条反馈：
 *  1. 互动数（藏+评）上卡——只在数据真实存在时显示，不拿 null 冒充 0（691/634=69%有封面，
 *     但 collects/comments 现在只覆盖 douyin+bilibili，wechat 整体还没有，缺的就不显示）
 *  2. 缩略图拿回来——用 CSS object-fit 控制显示尺寸，不改 URL 本身，不触发 403，
 *     浏览器默认的降采样也不会有锯齿；没有封面的用主题色渐变占位，不用灰方块
 *  3. 摘要换成要点式——从 key_points 里取前 2-3 条短句，比一段话扫得快
 */
function fmtNum(n) {
  if (n == null) return null;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
/* ---------- 封面图瘦身（CY 2026-11-10 报"结果页图片加载有点慢"后实测） ----------
 * 实测同一张 B站 封面（i0.hdslb.com/bfs/archive/...jpg，直连不带 Referer）：
 *   原图（我们一直在用的）**377.6KB** · @320w 11.0KB · @480w **17.4KB**
 *   · @672w 24.8KB · @960w 35.8KB  ⟹ 带缩放参数省 **95%**。
 * 而 B站 占 959/1208 = 68% 的卡片，卡片显示宽度最多 ~380px（layout max-width 1180 / 3 列）
 * ——也就是说**我们一直在下载 4-8 倍于显示尺寸的图，再让浏览器缩小**。这是慢的主因，
 * 不是网络差。
 * 做法：B站 走 srcset 三档让浏览器自己按 DPR×显示宽选最小够用的那档；抖音 URL 本身已带
 * `tplv-dy-resize...:540:q75.webp`（实测 16.3KB，已压过）不动；视频号 `wxapp.tc.qq.com
 * /stodownload` 是微信带签名的下载端点，**没有缩放参数可加**（加任何 query 都会破坏
 * encfilekey 签名），只能原样用。
 * ⚠️ 不做"我们自己转存一份缩略图"：那是把别人的图托管到自己站上，撞项目自己定的
 * "不自行托管内容"边界。加参数只是让**对方的 CDN** 给我们小一点的那份。
 */
const BILI_SRCSET = [480, 672, 960];
/** B站 封面 → srcset/sizes 属性串；非 B站 返回空串（原样用 src）。 */
function coverSrcset(url) {
  // 只认 hdslb.com 的 /bfs/ 原图路径，且 URL 里还没有 `@` 参数段（有就是上游已处理过）
  if (!/^https?:\/\/i\d+\.hdslb\.com\/bfs\//.test(url) || url.includes("@")) return "";
  const set = BILI_SRCSET.map(w => `${esc(url)}@${w}w_${Math.round(w * 9 / 16)}h_1c.webp ${w}w`).join(", ");
  // sizes 必须和 .grid 的断点一致（index.html: 640px→2列, 1080px→3列），否则浏览器会选错档
  return ` srcset="${set}" sizes="(min-width:1080px) 380px, (min-width:640px) 50vw, 100vw"`;
}
/** 弹窗里的大图：CSS 限 max-height 50vh，960w 足够（35.8KB vs 原图 377.6KB）。 */
function modalCover(url) {
  if (!/^https?:\/\/i\d+\.hdslb\.com\/bfs\//.test(url) || url.includes("@")) return url;
  return url + "@960w_540h_1c.webp";
}
/* 首屏那几张不该 lazy——lazy 对**视口内**的图只是多一次布局往返，
   而它们正是用户唯一在等的东西。只给前 N 张 eager+high，其余照旧 lazy。 */
const EAGER_COVERS = 6;
let coverSeq = 0;

function cardHtml(it, whyNote) {
  const dur = fmtDuration(it.duration_s);
  const hasImg = !!it.cover_url;
  const kps = (it.key_points || []).slice(0, 3);
  const body = kps.length
    ? `<ul class="kp-mini">${kps.map(k => `<li>${esc(k)}</li>`).join("")}</ul>`
    : `<div class="summary">${esc(it.summary || it.reason || "")}</div>`;
  const eng = [];
  if (it.collects != null) eng.push(`<span class="eng" title="收藏数">⭐${fmtNum(it.collects)}</span>`);
  if (it.comments != null) eng.push(`<span class="eng" title="评论数">💬${fmtNum(it.comments)}</span>`);
  // whyNote：主题页里"为什么没入选"的那句审计理由，挂 title 上（不占版面，但可查）
  return `<div class="card" style="--c:${topicColor(it.topic)}" data-id="${esc(it.id)}"
      ${whyNote ? `title="${esc(whyNote)}"` : ""}>
      <div class="card-thumb${hasImg ? "" : " noimg"}">
        ${hasImg
      ? `<img src="${esc(it.cover_url)}"${coverSrcset(it.cover_url)} alt=""
             ${coverSeq++ < EAGER_COVERS ? `loading="eager" fetchpriority="high"` : `loading="lazy"`}
             decoding="async" referrerpolicy="no-referrer"
             onerror="this.closest('.card-cover')?.remove()||this.remove()">`
      : `<span>${esc(PLATFORM_CN[it.platform] || it.platform)}</span>`}
        <span class="plat-badge">${esc(PLATFORM_CN[it.platform] || it.platform)}</span>
        ${dur ? `<span class="dur-badge">${dur}</span>` : ""}
      </div>
      <div class="card-body">
        <h3>${esc(it.title)}</h3>
        <div class="meta">
          ${fmtDate(it.published_at)
      ? `<span class="pub" title="发布于 ${esc(fmtDate(it.published_at))}">${esc(fmtDate(it.published_at))}</span>`
      : `<span class="pub unknown" title="上游平台没给发布时间">发布时间未知</span>`}
          ${eng.join("")}
          ${it.author ? `<span class="author">@${esc(it.author)}</span>` : ""}
        </div>
        ${body}
      </div>
    </div>`;
}

function renderResults() {
  const el = document.getElementById("results");
  const items = filtered();
  coverSeq = 0;   // 每次重渲染都重新数"前 6 张"，否则翻几次筛选后全部退回 lazy
  document.getElementById("result-count").textContent = items.length ? `${items.length}条` : "";

  /* 主题页命中时走证据视图。只在**没有搜索词**时走——有搜索词说明他在这个节点里再找
     某个具体说法，那时该按命中度排，不该按编辑顺序排。 */
  const page = currentPage();
  const sortNote = document.querySelector(".sort-note");
  if (page && !state.q && items.length) {
    // 列表视图那句"B站优先/按标题排"在这一页是错的：这里的顺序是编辑判断过的阅读序
    if (sortNote) sortNote.textContent =
      "这一页的顺序是编辑判断：先给答案，再按阅读顺序给证据。每条为什么入选、为什么没入选都有记录。没有热度排序。";
    renderEvidence(el, items, page);
    return;
  }
  if (sortNote) sortNote.textContent =
    "同一问题内：B站优先（讲得通常更完整），其余按标题排序；有搜索词时标题命中的排前面。没有热度排序，也没有推荐算法。";

  // 🔴 **数据还没到 ≠ 我们没有内容**（CY 2026-11-10 08:2x 手机首开实测报的 bug）。
  // data.json 压缩后 960KB，从美西机器直连都要 2.9 秒；他在飞书内置浏览器里等的那段时间，
  // 页面上写的是"这里还没有内容"——**库里有 1620 条，这句话是在替我们自己撒谎**，
  // 而且和"真的搜不到"长得一模一样（他的原话：好像需要我输入一个搜索词内容才会出来）。
  // 加载中必须说加载中。彻底的修法是拆包（首屏只要地图，不要 1620 条正文），那属于
  // 首页改版，这里先把假话去掉。
  if (!DATA_LOADED) {
    el.innerHTML = `<div class="empty"><span class="lane-spin"></span>正在把内容载入…
      <div class="empty-note">第一次打开要下载整个内容库（约 1MB），网络慢时要等几秒。
      这里一会儿就会出现知识地图。</div></div>`;
    return;
  }
  if (!items.length) {
    /* 空态的主按钮是「我要这个」（CY 2026-11-10 选 bz1 第二件）。
     * 病例：他 11-09 21:46 搜「如何控制血糖」，语义分 0.838、库里真有 42 条，但结果区
     * 按字面过滤后是 0 条 —— 而空态里唯一的出路是"回到知识地图"。想告诉我们"我要这个"
     * 的入口在**左栏**那个「没找到，我走」里，不在他眼睛看的地方。
     * ⟹ 把缺口入口搬到他真正盯着的那块空白上，并且做成主按钮而不是链接。
     * 注意：这里 emit 的是 `gap_wish`（和左栏同一个事件类型，后台已有消费形状），
     * note 带 `from=empty` 以便区分来源——不新造事件名，省掉一次 schema 变更。 */
    const q = state.q;
    el.innerHTML = `<div class="empty">这里还没有内容。
      ${q ? `<div class="empty-q">你搜的是「${esc(q)}」</div>` : ""}
      <div class="empty-acts">
        ${q ? `<button class="btn-primary" id="want-this">我要这个 →</button>` : ""}
        <button class="linklike" id="reset-all">回到知识地图</button>
      </div>
      <div class="empty-note">内容库还在扩充中——只有通过质量判定的才会上线，宁可少不放水。
        ${SEM.q === q && SEM.top.length && SEM.top[0].score >= SUGGEST_FLOOR
        ? `上面列出了我们认为最接近的几个问题，点一下就能看。` : ""}</div></div>`;
    el.querySelector("#reset-all").addEventListener("click", () => {
      document.getElementById("q").value = "";
      go({ q: "", topic: null, node: null });
    });
    const want = el.querySelector("#want-this");
    if (want) want.addEventListener("click", () => {
      recordExit("gap_wish", `${q} [from=empty]`);
      want.outerHTML = `<span class="want-ok"><b>记下了，正在去找。</b>
        我们会去找能正面回答它的内容，<b>核对过事实才会放上来</b>——
        所以是分钟级的，每核完一条就会出现一条。</span>`;
      // 缺口车道（CY 2026-11-10）：按钮不再只是"记一笔"，它真的会让本机去搜。
      startLane(q);
    });
    return;
  }

  // 结果内按问题节点分 section——**只在真有 ≥2 个不同节点时才分**，
  // 单一节点就直接平铺，不制造"一个 section 一条内容"的噪音。
  const byNode = new Map();
  for (const it of items) {
    if (!byNode.has(it.node)) byNode.set(it.node, []);
    byNode.get(it.node).push(it);
  }
  if (byNode.size < 2) {
    // ⚠️ 不能写 .map(cardHtml)：Array.map 会把下标当第二个参数传进去，
    // cardHtml 的第二参是 whyNote ⟹ esc(数字) 当场抛 TypeError（真浏览器里抓到的）
    el.innerHTML = `<div class="grid">${sortItems(items).map(it => cardHtml(it)).join("")}</div>`;
  } else {
    const order = [...byNode.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
    el.innerHTML = order.map(([node, list]) => `
      <div class="section">
        <div class="section-head">
          <span class="section-dot" style="background:${topicColor(list[0].topic)}"></span>
          <button class="section-title" data-drill="${esc(node)}" data-topic="${esc(list[0].topic)}">${esc(node)}</button>
          <span class="section-count">${list.length}条</span>
        </div>
        <div class="grid">${sortItems(list).map(it => cardHtml(it)).join("")}</div>
      </div>`).join("");
    el.querySelectorAll("[data-drill]").forEach(b => b.addEventListener("click", () =>
      go({ node: b.dataset.drill, topic: b.dataset.topic })));
  }
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(DATA.find(it => it.id === c.dataset.id))));
}

function render() {
  renderCrumbs();
  if (typeof renderSuggest === "function") renderSuggest();
  renderHomeQuestions();
  renderMap();
  renderScopeHint();
  renderAnswer();
  renderResults();
  renderExitVisibility();
}

/* 退出反馈只在**他已经看到东西之后**出现（CY 2026-11-10）。
   在首页就摆着两颗"你走了吗"按钮，是在他还没有体验时请他评价体验。 */
function renderExitVisibility() {
  const el = document.getElementById("exit");
  if (!el) return;
  const engaged = Boolean(state.q || state.node || state.topic);
  el.hidden = !(engaged && DATA_LOADED);
}

/* 首屏的「最近有人在问」：宣言是主张，可点的真实问题才是证据。
   取的是**真实节点 + 真实条数**，按条数排——不是编出来的示例问句。
   刻意只在"什么都还没点"的首页出现；一旦开始搜/点，这块就让位给结果。 */
function renderHomeQuestions() {
  const host = document.getElementById("home-q");
  if (!host) return;
  if (state.q || state.node || state.topic || !DATA_LOADED) { host.innerHTML = ""; return; }
  const byNode = new Map();
  for (const it of DATA) {
    if (!it.node) continue;
    byNode.set(it.node, (byNode.get(it.node) || 0) + 1);
  }
  // 🔴 只按条数排会把「AI工具使用教程」「AI内容创作工具工作流」这类**不是问句**的节点顶上来
  //   （2026-11-10 真机截图当场看到）。它们是判定器归类时开的类目名，不是人会问的问题。
  //   首屏要的是"可点的真问题"，所以两道筛：
  //   ① 优先有主题页的节点（那 31 个是真整理过答案骨架的，质量最高）
  //   ② 其次才看名字是不是问句形状（怎么/为什么/能不能/…吗）
  const isQuestion = n => /怎么|如何|为什么|什么|哪个|哪些|能不能|会不会|要不要|值不值|靠不靠|是不是|吗$|\?|？/.test(n);
  const scored = [...byNode.entries()]
    // 「(地图缺口)…」是判定器自动开的临时名，不是给人看的问题，首屏不摆
    .filter(([n]) => !/地图缺口/.test(n))
    .map(([n, c]) => ({ n, c, hasPage: PAGES.has(n), q: isQuestion(n) }))
    // 有主题页的最优先 → 问句形状的次之 → 同档内才按条数
    .sort((a, b) => (b.hasPage - a.hasPage) || (b.q - a.q) || (b.c - a.c));
  const top = scored.filter(x => x.hasPage || x.q).slice(0, 6).map(x => [x.n, x.c]);
  if (!top.length) { host.innerHTML = ""; return; }
  host.innerHTML = `<div class="hq-label">这里已经答得比较全的问题</div>
    <ul class="hq-list">${top.map(([n, c]) =>
      `<li><button class="hq" data-node="${esc(n)}"><span class="hq-q">${esc(displayNode(n))}</span>
        <span class="hq-n">${c} 条</span></button></li>`).join("")}</ul>`;
  host.querySelectorAll(".hq").forEach(b =>
    b.addEventListener("click", () => go({ node: b.dataset.node, q: "", topic: null })));
}

/* 节点名入库时带「07.」这类编号，那是我们的内部排序手段，不该出现在用户眼前 */
function displayNode(n) { return String(n).replace(/^\d+\./, ""); }

/* ---------- 弹窗 ---------- */
function openModal(it) {
  if (!it) return;
  const embedFn = EMBED_URL[it.platform];
  const m = document.getElementById("modal-content");
  const shape = EMBED_SHAPE[it.platform] || "portrait";
  m.className = embedFn ? `modal embed-mode embed-${shape}` : "modal nolink-mode";
  /* 要点取代了原来的「展开转写全文」（CY 2026-11-07 批 tx2）。
     逐字稿是把原作者的内容整篇复制出来公开，撞我们自己定的边界；要点是我们的概括。
     **这几条是产品真正的交付物**：读完多数情况就不必看视频了，省下的时间就是价值。
     所以它不是折叠的附属品，而是弹窗里排在最前、默认展开的主体。 */
  const points = (it.key_points && it.key_points.length)
    ? `<div class="kp"><div class="kp-head">这条视频讲了什么</div>
         <ul>${it.key_points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
         <div class="kp-note">我们的概括，不是原话。读完还想看讲述过程，再点下面的原视频。</div>
       </div>`
    : `<div class="kp"><div class="kp-note">这条还没出要点（判定流水线还在补），先看摘要或直接看原视频。</div></div>`;
  const body = embedFn
    ? `<iframe class="modal-embed" src="${embedFn(it.video_id)}" allow="autoplay; fullscreen" allowfullscreen scrolling="no" frameborder="0"></iframe>
       <p class="modal-tip">播放器是${PLATFORM_CN[it.platform] || it.platform}官方的，它自带的那些按钮我们改不掉。点进播放区后 Escape 可能失效（跨站 iframe 限制），用右上角 ✕ 关闭。</p>`
    : `<div class="modal-cover-wrap">
         ${it.cover_url ? `<img class="modal-cover" src="${esc(modalCover(it.cover_url))}" alt=""
              decoding="async" referrerpolicy="no-referrer"
              onerror="this.closest('.modal-cover-wrap')?.remove()||this.remove()">` : ""}
         <div><a class="modal-openlink" href="${it.link}" target="_blank" rel="noopener">在${PLATFORM_CN[it.platform] || it.platform}中打开观看</a></div>
         <p class="modal-tip">视频号的官方嵌入只支持微信小程序内，网页做不到，这是平台限制。</p>
       </div>`;
  m.innerHTML = `
    <div class="modal-head">
      <h2>${esc(it.title)}</h2>
      <button class="modal-close" aria-label="关闭">&times;</button>
    </div>
    <div class="modal-body">
      ${body}
      <div class="modal-where">
        <button class="linklike" data-jump-topic="${esc(it.topic)}" style="color:${topicColor(it.topic)}">${esc(it.topic)}</button>
        <span class="sep">›</span>
        <button class="linklike" data-jump-node="${esc(it.node)}" data-topic="${esc(it.topic)}">${esc(it.node)}</button>
      </div>
      <div class="modal-meta">
        <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
        ${it.author ? ` · @${esc(it.author)}` : ""}
        ${fmtDuration(it.duration_s) ? " · " + fmtDuration(it.duration_s) : ""}
        ${fmtDate(it.published_at)
      ? ` · 发布于 ${esc(fmtDate(it.published_at))}${fmtAge(it.published_at) ? `（${esc(fmtAge(it.published_at))}）` : ""}`
      : " · 发布时间未知"}
      </div>
      <div class="modal-summary">${esc(it.summary || "")}</div>
      ${points}
      ${it.reason ? `<div class="modal-reason">入选依据：${esc(it.reason)}</div>` : ""}
      <a class="src" href="${it.link}" target="_blank" rel="noopener">在原平台看原作者的完整内容</a>
      ${edgeBlockHtml(it)}
      <!-- 所有视频站在这个位置放"相关推荐"。我们在这个位置放一句"没有下一条"。
           这是整个产品最结构性的一处叛逆：连播的入口被我们拿掉了，不是忘了做。 -->
      <p class="no-next">没有「下一条」。看完回地图，或者直接关掉。</p>
    </div>`;
  document.getElementById("modal-overlay").classList.add("open");
  emit("open", { item: it.id, has_points: !!(it.key_points && it.key_points.length) });
  m.querySelector(".modal-close").addEventListener("click", closeModal);
  // 弹窗里也能跳地图——看完一条顺着它所在的位置继续找，是这个产品的主循环
  m.querySelectorAll("[data-jump-topic]").forEach(b => b.addEventListener("click", () => {
    closeModal(); go({ topic: b.dataset.jumpTopic, node: null });
  }));
  m.querySelectorAll("[data-jump-node]").forEach(b => b.addEventListener("click", () => {
    closeModal(); go({ node: b.dataset.jumpNode, topic: b.dataset.topic });
  }));
  // 顺着一条关系走：**记下他是从哪条边进去的**（见下面 ENTRY_EDGE 的注释）
  m.querySelectorAll("[data-edge]").forEach(b => b.addEventListener("click", () => {
    ENTRY_EDGE = b.dataset.edge;
    emit("edge_follow", { note: b.dataset.edge });
    closeModal(); go({ node: b.dataset.edgeDst, q: "", topic: null });
  }));
  // 「这不是我想找的」：边纠错**唯一**的信号源
  const nf = m.querySelector("#modal-notfound");
  if (nf) nf.addEventListener("click", () => {
    emit("not_for_me", { note: `${ENTRY_EDGE || "直接进入"} → ${it.node || ""}`, item: it.id });
    nf.outerHTML = `<span class="nf-ok">记下了。我们会去查：把你带到这儿的那条关系是不是连错了。</span>`;
  });
  m.focus();
}

/* 他是顺着**哪条关系**走到当前节点的。设计文档 v3 砍掉了人工边复核队列，
   改成「用户否定驱动」：按下「这不是我想找的」时记录 (入口边 · 当前节点 · 原问句)，
   只有被否定命中的边才送 LM 复核。⟹ 不记这个，那条按钮就只是礼貌用语，
   整个边纠错回路没有输入。 */
let ENTRY_EDGE = "";

/* 四种边翻成人话。**界面上永远不出现 answers_part_of 这类内部名**——
   用户没有"边"这个概念，他只需要知道"顺着这条走会到哪、为什么"。 */
const EDGE_CN = {
  answers_part_of: { k: "它是这个更大问题的一块", mark: "↑" },
  prereq:          { k: "先懂这个会更容易",       mark: "↓" },
  confusable_with: { k: "常被当成同一个问题",     mark: "↔" },
  instance_of:     { k: "具体到某个东西上",       mark: "•" },
};

function edgeBlockHtml(it) {
  const all = (DATA_EDGES && (DATA_EDGES[it.category] || DATA_EDGES[it.node])) || [];
  // 一条边没有就整块不出现——空着一个"相关问题"标题比没有更糟
  if (!all.length) return "";
  const rows = all.slice(0, 5).map(e => {
    const cn = EDGE_CN[e.type];
    if (!cn) return "";
    return `<div class="edge-row"><span class="edge-mark">${cn.mark}</span>
      <div><div class="edge-k">${cn.k}</div>
        <button class="edge-nm" data-edge="${esc(e.type)}:${esc(it.category || it.node)}"
                data-edge-dst="${esc(e.dst)}">${esc(displayNode(e.dst))}</button>
        <div class="edge-why">因为：${esc(e.why)}</div></div></div>`;
  }).join("");
  if (!rows) return "";
  return `<div class="edge-box">
    <div class="edge-head">这个问题在地图上的位置</div>
    <div class="edge-self">${esc(displayNode(it.node || it.category || ""))}</div>
    ${rows}
    <p class="edge-note">这几条都是<b>知识关系</b>，不是"看了这个的人还看了"——
      所以每条后面都说得出"因为"。</p>
    <button class="edge-nf" id="modal-notfound">这不是我想找的</button>
  </div>`;
}
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.getElementById("modal-content").innerHTML = "";
}

/* ---------- 两种离开 ----------
 * CY 2026-11-07 07:2x：「成功 = 用户找到了想要的，然后离开。失败 = 找了一圈没找到，
 * 然后离开。两种离开都以关窗结束，但是两个完全不同的 signal。」
 *
 * 传统视频网站分不出这两种，也不在乎——它们数的是停留时长，两种离开都只是"会话结束"。
 * 我们只认一种成功，所以必须问。这两颗按钮同时是**产品的成绩单**和**价值观最响的一句话**。
 *
 * 这是 BI，按 BI 做（CY 2026-11-07 07:3x：「当做BI来做，BI我们总是要做的呀」）。
 * 我上一轮把"现在还没有后端"说成了"收不到"，那是两件事——收集端是我们自己写的
 * 20 行，不是做不到。
 *
 * **匿名口径（和墙上那行"不认识你"必须一致，不然就是自己打自己脸）**：
 * 访客 id 存在 **sessionStorage**，关掉标签页就没了。这足够回答 BI 要回答的问题
 * （"这一次来访，他搜了什么、点了哪颗按钮"），但**跨访问拼不出一个人的档案**——
 * charter 明文禁止观看行为画像。用 localStorage 存持久 id 就越界了，别改。
 *
 * **端点**：COLLECT_URL 为空时事件只排在本地队列里，不发任何请求（也就不存在
 * "偷偷发出去"这回事）。填上我们自己的 Worker 地址后，队列会随下次事件一起补发。
 * 刻意不接任何第三方统计脚本——那会直接作废墙上那行"没有第三方脚本"。
 */
const COLLECT_URL = "https://bi.vectorherd.com";  // 2026-11-07 已部署并端到端验过(写入+读回)

function visitorId() {
  try {
    let v = sessionStorage.getItem("xing_vid");
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 12);
      sessionStorage.setItem("xing_vid", v);
    }
    return v;
  } catch (e) { return "no-storage"; }
}

function queued(ev) {
  let q = [];
  try { q = JSON.parse(localStorage.getItem("xing_q") || "[]"); } catch (e) { /* 隐私模式 */ }
  if (ev) q.push(ev);
  return q.slice(-200);
}

function emit(kind, extra) {
  const ev = Object.assign({
    v: 1, kind, vid: visitorId(),
    q: state.q || "", topic: state.topic || "", node: state.node || "",
    results: filtered().length, lib: DATA.length,
    at: new Date().toISOString(),
  }, extra || {});
  const q = queued(ev);
  try { localStorage.setItem("xing_q", JSON.stringify(q)); } catch (e) { /* ignore */ }
  if (!COLLECT_URL) return;
  // sendBeacon 在页面关闭过程中也能发出去——"用户点完就关窗"正是我们最常见的路径
  const payload = JSON.stringify({ events: q });
  const sent = navigator.sendBeacon
    ? navigator.sendBeacon(COLLECT_URL, new Blob([payload], { type: "application/json" }))
    : false;
  if (sent) { try { localStorage.setItem("xing_q", "[]"); } catch (e) { /* ignore */ } return; }
  fetch(COLLECT_URL, { method: "POST", body: payload, keepalive: true,
                       headers: { "Content-Type": "application/json" } })
    .then(() => { try { localStorage.setItem("xing_q", "[]"); } catch (e) { /* ignore */ } })
    .catch(() => { /* 发不出去就留在队列里，下次补发；绝不因为 BI 影响用户 */ });
}

function recordExit(kind, note) { emit(kind, note ? { note } : undefined); }

/* ======================= 缺口车道（CY 2026-11-10 批「把补搜做起来」） =======================
 *
 * 点「我要这个」之后真的会发生事情：
 *   前端 POST /rtsearch → 云端只记一行"有人要这个" → **CY 那台 Mac 上的守护进程**每 1.5 秒
 *   来认领 → 它够得到数据网关（Cloudflare 边缘够不到，11-08 实测）→ 搜 B站/抖音 →
 *   结果写回云端 → 这里轮询到就显示。
 *
 * 为什么前端要轮询而不是等一个长请求：中间那一跳在**另一台机器**上，一个挂着的 HTTP
 * 请求扛不住本机重启/断网/被回收。轮询的代价只是每 1.5 秒一个小请求，而好处是任何一端
 * 挂掉都只表现为"状态停住"，不是"页面一直转圈"。
 *
 * 实测时间（2026-11-10 首跑）：**首条线索 7.4 秒**（B站 先回），两站全到 20.9 秒，$0.021。
 *
 * ⚠️ 视觉纪律：快道给的是**未核验**内容，必须套在 .lane 那个琥珀色框里、并明说还没核过。
 * 站上写着"不装懂"，把未核验的东西混进已核验卡片流里就是当场作废那句话。
 */
const LANE_POLL_MS = 1500;
const LANE_MAX_MS = 6 * 60 * 1000;   // 6 分钟后停止轮询：慢道再久也不该让页面一直转
let LANE = { q: "", timer: null, t0: 0, state: "" };

function startLane(q) {
  if (!COLLECT_URL || !q) return;
  if (LANE.timer) clearInterval(LANE.timer);
  LANE = { q, timer: null, t0: Date.now(), state: "new" };
  renderLane({ state: "new", results: [] });
  const ask = () => {
    fetch(`${COLLECT_URL}/rtsearch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    }).then(r => r.json()).then(d => {
      if (LANE.q !== q) return;                       // 用户已经换了搜索词，丢弃旧响应
      LANE.state = d.state || "";
      renderLane(d);
      const over = Date.now() - LANE.t0 > LANE_MAX_MS;
      if (["done", "skipped", "failed"].includes(d.state) || d.budget_exceeded || over) {
        clearInterval(LANE.timer); LANE.timer = null;
      }
    }).catch(() => { /* 一次网络抖动不该把整条车道掐掉，下一轮再问 */ });
  };
  ask();
  LANE.timer = setInterval(ask, LANE_POLL_MS);
}


function renderLane(d) {
  const host = document.getElementById("results");
  if (!host) return;
  let box = document.getElementById("lane");
  if (!box) { box = document.createElement("div"); box.id = "lane"; host.appendChild(box); }
  const items = Array.isArray(d.results) ? d.results : [];
  const secs = Math.round((Date.now() - LANE.t0) / 1000);
  const step = (d.note || "").split("｜").slice(-1)[0] || "";

  if (d.budget_exceeded) {
    box.innerHTML = `<div class="lane"><div class="lane-head">今天的补内容额度用完了</div>
      <div class="lane-sub">这不是搪塞：去平台找一次要真花钱，我们给它设了每天的硬上限，
      宁可明天继续也不超支。你这句话已经记下了。</div></div>`;
    return;
  }
  // 库里本来就有（环 0 命中）
  if (d.state === "skipped" && items.length) {
    box.innerHTML = `<div class="lane ok"><div class="lane-head">其实我们有——是我们的搜索没搭上你的说法</div>
      <div class="lane-sub">${esc(d.note || "")}。下面这些都已经核对过事实。</div>
      <div class="lane-cards">${items.map(laneCardHtml).join("")}</div></div>`;
    return;
  }
  if (d.state === "skipped") {
    box.innerHTML = `<div class="lane"><div class="lane-head">这个我们不打算收</div>
      <div class="lane-sub">${esc(d.note || "它不在「醒」要做的范围里")}。
      与其给你一堆沾边的，不如说清楚我们没有。</div></div>`;
    return;
  }
  if (d.state === "failed") {
    box.innerHTML = `<div class="lane"><div class="lane-head">没找成——是我们这边的问题</div>
      <div class="lane-sub">去平台搜的那一跳失败了，不是"这个问题没有内容"。
      已经记下，稍后会自己重试。</div></div>`;
    return;
  }

  /* 建设中 / 建完。⚠️ 这里的每一条**都是已核验的**（CY 2026-11-10 08:22 推翻了
     "先给未核验线索"那一版）：变的是"现在几条 / 最后几条"，不是"核没核"。
     所以它们用的是和平时一样的卡片，没有琥珀框、没有"还没核过"这类话术。 */
  const building = d.state !== "done";
  const head = building
    ? `<div class="lane-head"><span class="lane-spin"></span>正在为你建这个知识点</div>
       <div class="lane-sub">${items.length
          ? `已经核完 <b>${items.length}</b> 条，放在下面了。`
          : `还没有核完的——每核完一条就会出现一条。`}
          ${step ? `当前：${esc(step)}（已等 ${secs} 秒）` : ""}<br>
          核一条要取视频、转成文字、判断讲得对不对、再核对事实，所以是分钟级的。</div>`
    : `<div class="lane-head">这个知识点建好了</div>
       <div class="lane-sub">${items.length
          ? `${items.length} 条，全部核对过事实。它们已经进了知识地图，下次直接搜得到。`
          : `我们找了一圈，<b>没有一条过得了判定</b>——不是没找到，是找到的都不够格。
             与其凑数给你，不如说实话。`}</div>`;
  box.innerHTML = `<div class="lane ${building ? "" : "ok"}">${head}
    ${items.length ? `<div class="lane-cards">${items.map(laneCardHtml).join("")}</div>` : ""}
    </div>`;
}

/* 已核验内容的卡片：刻意和结果列表里的卡片同一个样子——它们是同一等公民 */
function laneCardHtml(it) {
  const site = { bilibili: "B站", douyin: "抖音", wechat_channels: "视频号" }[it.platform] || it.platform;
  const mins = it.duration_s ? ` · ${Math.round(it.duration_s / 60)} 分钟` : "";
  const who = it.author ? ` · ${esc(it.author)}` : "";
  const link = it.link
    ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>`
    : esc(it.title);
  return `<div class="lane-card">${it.cover
      ? `<img class="lane-thumb" src="${esc(it.cover)}" alt="" loading="lazy" decoding="async">` : ""}
    <div><div class="lane-ct">${link}</div>
      <div class="lane-cm">${site}${who}${mins}</div></div></div>`;
}

function exitSaid(html, cls) {
  document.getElementById("exit").innerHTML =
    `<p class="exit-said ${cls || ""}">${html}</p>
     <p class="exit-note">${COLLECT_URL ? "匿名记一条到我们自己的服务器（这台设备这次访问的编号，关掉网页就失效，拼不出你是谁）。" : "只记在你这台设备上，没有上传——这一版还没有后端。"}</p>`;
}

document.getElementById("exit-ok").addEventListener("click", () => {
  recordExit("found");
  exitSaid(`<b>记下了。</b><br>这是我们唯一的成功。<br>不用收藏，有下一个问题再来。`);
});

document.getElementById("exit-no").addEventListener("click", () => {
  recordExit("not_found");
  document.getElementById("exit").innerHTML =
    `<p class="exit-said bad"><b>记下了——这是我们的失败，不是你的。</b><br>你想找的是什么？</p>
     <div class="exit-ask">
       <input id="exit-want" type="text" placeholder="一句话就行" maxlength="80">
       <button id="exit-send">送出</button>
     </div>
     <p class="exit-note">它会进我们的内容缺口清单${COLLECT_URL ? "（匿名，只认这次访问的设备编号，拼不出你是谁）" : "——只记在你这台设备上，没有上传，这一版还没有后端"}。</p>`;
  const input = document.getElementById("exit-want");
  const send = () => {
    recordExit("gap_wish", input.value.trim());
    exitSaid(`<b>收到。</b><br>这句话比一万次点击有用。`, "bad");
  };
  document.getElementById("exit-send").addEventListener("click", send);
  input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
  input.focus();
});

/* ---------- 语义搜索接入（S1 · CY 批 vr2 第二件，2026-11-09） ----------
 * 为什么必须接：前台原来只做关键词子串匹配，用户换个说法就 0 命中
 * （"通胀是什么" vs 节点名"通货膨胀是怎么发生的"），而 /semantic 端点 11-09 02:0x
 * 就上线了、一直没人调用。接它同时解掉另一件事：**搜索事件里从此带上"地图认为他问的是
 * 哪个节点"**——那是自动升级闸（"搜索次数够多"）和地图残缺度判断的输入。
 * 刻意忽略端点返回的 `confident` 布尔：那是在让向量做判定（v3 §6.1 已决定撤掉）；
 * 前台不说"我们有/没有"，只列最接近的几个问题。
 */
const SEMANTIC_URL = COLLECT_URL + "/semantic";
/* 相似度两档地板（CY 2026-11-10 选 bz1 后改；原来只有一个 0.60）。
 * 为什么必须分两档：他 11-09 21:43 真机搜「如何控制血压」，实测最近节点 **0.636**
 * ——刚好过了旧地板 ⟹ 走 chips 分支，于是①一条缺口都没记（库里其实完全没有血压内容）
 * ②把**血糖**的节点当建议摆了出来，跨病种假自信，正好违反项目"不装懂"的招牌。
 * 一个阈值要同时回答两个不同的问题，必然有一边错：
 *   < FLOOR(0.60)        我们**没听懂** → 什么都不摆，记缺口
 *   FLOOR..SURE(0.75)    我们**听懂了但库里多半没有** → 摆最接近的，但明说没把握，**同时记缺口**
 *   >= SURE(0.75)        我们**有把握** → 正常摆建议，不记缺口
 * 0.75 这个数是从实测挑的：「如何控制血糖」0.838（库里真有 42 条）要落在确信区，
 * 「如何控制血压」0.636（库里没有）要落在没把握区。两个真实样本把这条线夹在中间。
 */
const SUGGEST_FLOOR = 0.60;
const SUGGEST_SURE = 0.75;
let SEM = { q: "", top: [], ms: 0, pending: false, err: "" };
let semSeq = 0;

/* ---------- 缺口只记完整问句（bz1 第三件） ----------
 * 病例：11-09 的缺口表里记进了 `如何k血压 0.564` / `如何kong zhi血压 0.535` /
 * `如何控制xue t 0.504` —— 全是中文输入法拼一半时 debounce 触发的中间态。
 * 缺口清单的用途是"去补什么内容"，喂进去的若是打字碎片，补搜就会去搜不存在的词
 * ⟹ **清单在收集噪音、同时漏掉真问题**（他真正打完的那两句一条没记）。
 * 三道闸，缺一不可：
 *  ① 静默期 1.2s（不是 chips 那个 160ms）——人打完一句话到按回车/停手，远长于 1.2s；
 *     打字中间态活不过 1.2s。这是最有效的一道。
 *  ② 长度 ≥ 4（"血糖"两个字不是问句，是关键词）
 *  ③ 中文里混着裸拉丁串 ⟹ 拼音中间态，拒。但技术词是合法的（"AI是什么"），
 *     所以走白名单：混排时每个拉丁片段都得在白名单里才放行。
 * ④ 延迟期满还要复核 q 仍等于 state.q——否则记的是一句已经被改掉的话。
 */
const GAP_QUIET_MS = 1200;
const GAP_MIN_LEN = 4;
// 中文语境里合法的裸拉丁词（会继续加；不在表里的混排一律当拼音中间态拒掉）
const LATIN_OK = new Set(["ai", "agi", "llm", "gpt", "chatgpt", "claude", "api", "mcp", "rag",
  "sql", "python", "js", "css", "html", "etf", "roe", "roi", "pe", "pb", "gdp", "cpi", "ppi",
  "pmi", "reits", "qdii", "ipo", "cto", "ceo", "cfo", "hr", "okr", "kpi", "crm",
  "saas", "app", "ui", "ux", "seo", "nas", "vpn", "usb", "cpu", "gpu", "ssd", "ram", "iphone",
  "ios", "mac", "windows", "linux", "excel", "ppt", "word", "notion", "obsidian"]);
/* ⚠️ 单字母**一律**不进白名单（第一版放了 "a"/"k" 想照顾「A股」「K线」，单测当场抓到
   「如何k血压」被放行——那正是 CY 缺口表里的碎片之一：拼音首字母和这些写法同形）。
   正解是把固定搭配整体当中文剔掉，再要求剩下的裸拉丁串长度 ≥2 且在白名单里。 */
const CJK_LATIN_PAIRS = /[aA]股|[kK]线|[bB]站|[tT]恤|[xX]光|[nN]号|[pP]图/g;

/** 这串输入看起来是一句打完的话，而不是输入法中间态？ */
function looksComplete(q) {
  const s = (q || "").trim();
  if (s.length < GAP_MIN_LEN) return false;
  const hasCJK = /[一-龥]/.test(s);
  const latins = (s.replace(CJK_LATIN_PAIRS, "").match(/[a-zA-Z]+/g)) || [];
  // 中文里夹着裸拉丁串：每段都得 ≥2 字母且是认得的词，否则就是拼音没上屏
  if (hasCJK && latins.length && !latins.every(w => w.length >= 2 && LATIN_OK.has(w.toLowerCase()))) return false;
  // 末尾挂着单个字母（"如何控制xue t" 的 t）——即便前面都认得，也是正在打的状态
  if (hasCJK && /(^|[^a-zA-Z])[a-zA-Z]$/.test(s)) return false;
  return true;
}

let gapTimer = null;
let lastGapQ = null;   // 同一句话只记一次缺口，别让一次输入刷出一串事件
/** 想记一条内容缺口——过完三道闸、静默 1.2s 后才真的 emit。band 让后台能分级消费。 */
function maybeRecordGap(q, score, band) {
  clearTimeout(gapTimer);
  if (!looksComplete(q) || q === lastGapQ) return;
  gapTimer = setTimeout(() => {
    // 复核：这 1.2s 里他可能又改了话，也可能已经被别的分支记过
    if (q !== state.q || q === lastGapQ) return;
    lastGapQ = q;
    emit("search_gap", { note: `top=${score} band=${band}` });
  }, GAP_QUIET_MS);
}

function fetchSemantic(q) {
  if (!q || q.length > 60) { SEM = { q: "", top: [], ms: 0, pending: false, err: "" }; renderSuggest(); return; }
  const seq = ++semSeq;
  SEM = { q, top: [], ms: 0, pending: true, err: "" };
  renderSuggest();
  fetch(SEMANTIC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ q }) })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(d => {
      if (seq !== semSeq) return;            // 用户还在打字，过期响应直接丢掉
      if (!d || d.ok !== true) throw new Error((d && d.err) || "bad payload");
      SEM = { q, top: (d.top || []).slice(0, 5), ms: d.ms || 0, pending: false, err: "" };
      renderSuggest();
      const t0 = SEM.top[0];
      // 落进现有 ev 表不加列：node 列正好就是节点名，细节塞 note。
      // （加列要改 D1 schema，而这条信息的形状本来就跟 node 对得上。）
      if (t0) emit("search_sem", { node: t0.name,
                                   note: `score=${t0.score} n=${t0.n || 0} ms=${SEM.ms}` });
    })
    .catch(e => {
      if (seq !== semSeq) return;
      // 失败就安静退回关键词匹配（绝不因为一个附加能力影响用户），但**必须留痕**——
      // 不留痕就会变成 /rtsearch 那种"自报成功的空结果"。
      SEM = { q, top: [], ms: 0, pending: false, err: String((e && e.message) || e) };
      renderSuggest();
      emit("search_sem_fail", { note: SEM.err });
    });
}

/** 这个问题节点在库里有内容吗？有就返回它的 topic/domain（用于跳转），没有返回 null。 */
function nodeInLib(name) {
  const hit = ALL_DATA.find(it => it.node === name);
  return hit ? { topic: hit.topic, domain: hit.domain } : null;
}

function renderSuggest() {
  const el = document.getElementById("suggest");
  if (!el) return;
  if (!state.q || SEM.q !== state.q) { el.innerHTML = ""; return; }
  const localHits = matchedByQuery().length;
  if (SEM.pending) {
    // 关键词已经有命中时不打扰（他已经有东西看了）；0 命中时才告诉他我们在想
    el.innerHTML = localHits ? "" : `<div class="sg-label">正在理解你这句话…</div>`;
    return;
  }
  if (!SEM.top.length) { el.innerHTML = ""; return; }
  const localNodes = new Set(matchedByQuery().map(it => it.node));
  // 关键词命中的就是语义最近的那个节点 ⟹ 没有新信息，不打扰
  if (localHits && localNodes.has(SEM.top[0].name)) { el.innerHTML = ""; return; }

  /* 相似度地板（2026-11-09 补）。实测「血糖怎么控制」的最近节点是
     「如何构建稳定现金流」0.527、「怎么写提示词才能少踩坑」0.512——**这不是建议，是噪音**，
     把它摆出来等于告诉用户"我们没听懂还装懂"。
     ⚠️ 这和"刻意忽略 confident 布尔"不矛盾：那条是不让向量去做**判定**（有没有答案），
     这条是不让向量去**瞎猜**（这几个问题跟你问的根本不是一回事）。用原始分数、
     地板写在前端，是为了这个数字看得见、能调。 */
  if (SEM.top[0].score < SUGGEST_FLOOR) {
    el.innerHTML =
      `<div class="sg-label">这个问题我们还没有。</div>
       <div class="sg-note">已经记下来了，正在去找合适的内容——我们要先看一遍、核对关键事实，
         才会放上来，所以不会马上有。过一会儿回来搜同一句话就知道。</div>`;
    // 记一条"库里没有这个问题"——这是内容缺口清单，也是补搜的触发输入。
    maybeRecordGap(state.q, SEM.top[0].score, "none");
    return;
  }

  /* 没把握区（0.60–0.75）：听懂了、但库里多半不是他要的那个。
     既然没把握就**说出来**——摆建议但措辞下调，且一样记缺口。
     这是"不装懂"在代码里的落点：同样的 chips，换一句不同的开场白。 */
  const unsure = SEM.top[0].score < SUGGEST_SURE;
  if (unsure) maybeRecordGap(state.q, SEM.top[0].score, "weak");

  const chips = SEM.top.map(t => {
    const where = nodeInLib(t.name);
    if (!where) {
      return `<span class="chip gap" title="这个问题还没有合格内容">${esc(t.name)}</span>`;
    }
    return `<button class="chip" data-sg="${esc(t.name)}" data-sg-topic="${esc(where.topic)}"
      data-sg-domain="${esc(where.domain || "")}">${esc(t.name)}<span class="n">${t.n || ""}</span></button>`;
  }).join("");
  const allGap = SEM.top.every(t => !nodeInLib(t.name));
  el.innerHTML =
    (unsure
      ? `<div class="sg-label unsure">你问的这个，我们没有直接的答案。下面这几个问题<b>可能</b>沾边，
           也可能不是一回事——你自己判断：</div>`
      : `<div class="sg-label">你想问的，也许是这几个问题：</div>`) +
    `<div class="chips">${chips}</div>` +
    (allGap ? `<div class="sg-note">这些问题很重要，但我们现在还没有干净的答案，会继续寻找。</div>`
      : unsure ? `<div class="sg-note">你那句话已经记进内容缺口清单了，我们会去找正面回答它的内容。</div>` : "");
  el.querySelectorAll("[data-sg]").forEach(b => b.addEventListener("click", () => {
    const d = b.dataset.sgDomain || null;
    if (d && state.domain && d !== state.domain) { state.domain = d; applyDomain(); }
    // 跳过去时清掉搜索词：他的原话已经完成任务了（我们已经把他路由到对的问题上），
    // 留着只会把结果再按字面过滤一遍，又变成 0 条。
    document.getElementById("q").value = "";
    emit("sem_pick", { node: b.dataset.sg });
    go({ q: "", node: b.dataset.sg, topic: b.dataset.sgTopic });
  }));
}

/* ---------- 绑定 ---------- */
document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target.id === "modal-overlay") closeModal();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

let qTimer = null;
document.getElementById("q").addEventListener("input", e => {
  clearTimeout(qTimer);
  const v = e.target.value.trim().toLowerCase();
  qTimer = setTimeout(() => {
    state.q = v;
    render();
    // 只在停下打字后记一次（不是每个按键）。**搜了什么 + 命中几条**是这个产品
    // 最该看的 BI：命中 0 的词就是内容缺口清单。
    if (v) emit("search");
    // 语义搜索：关键词命中与否都要问一次——它不只是兜底，还负责把
    // "地图认为他问的是哪个节点"记进事件表（自动升级闸要吃这个）。
    fetchSemantic(v);
  }, 160);
});

/* 实测过一次：data.json 当时 ~800KB（转写全文都在里面），网络不稳时会**半截下载却仍回
   HTTP 200**，JSON.parse 直接抛 → 页面全白。tx2 把转写全文移出 data.json 后体积掉了
   一个数量级，但这个兜底留着——"200 + 残缺 body"是这台机器上反复出现的形状，
   不该靠文件小来避免它。 */
function loadData(attempt = 1) {
  fetch("data.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => {
      ALL_DATA = d.items || [];
      DATA_EDGES = d.edges || {};
      DATA_LOADED = true;
      TOPICS = d.topics || [...new Set(ALL_DATA.map(i => i.topic))];
      DOMAIN_LIST = d.domains || [];
      applyDomain();
      render();
    })
    .catch(err => {
      if (attempt < 3) return setTimeout(() => loadData(attempt + 1), 800 * attempt);
      DATA_LOADED = true;   // 别卡在"加载中"——失败要说失败
      document.getElementById("results").innerHTML =
        `<div class="empty">内容没加载出来（${esc(String(err.message || err))}）。<br>
         <button class="linklike" onclick="location.reload()">重新加载</button>
         <div class="empty-note">多半是网络半途断了。内容本身没事，刷一下就好。</div></div>`;
    });
}

/* 主题页数据。**失败是非致命的**：拿不到就退回原来的列表视图，不弹错、不挡内容——
   答案区是增强层，不是前提（和 /semantic 同样的姿势）。 */
function loadPages() {
  fetch("pages.json", { cache: "no-cache" })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(d => {
      PAGES = new Map((d.pages || []).map(p => [p.node, p]));
      render();
    })
    .catch(() => { /* 没有主题页就当没有，列表视图照常工作 */ });
}

loadData();
loadPages();
