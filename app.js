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
let ALL_DATA = [];      // 全部内容（跨领域）
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
      ? `<img src="${esc(it.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
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

  if (!items.length) {
    el.innerHTML = `<div class="empty">这里还没有内容。<br>
      <button class="linklike" id="reset-all">回到知识地图</button> 看看现在有什么。
      <div class="empty-note">内容库还在扩充中——只有通过质量判定的才会上线，宁可少不放水。</div></div>`;
    el.querySelector("#reset-all").addEventListener("click", () => {
      document.getElementById("q").value = "";
      go({ q: "", topic: null, node: null });
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
  renderMap();
  renderScopeHint();
  renderAnswer();
  renderResults();
}

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
         ${it.cover_url ? `<img class="modal-cover" src="${it.cover_url}" alt=""
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
  m.focus();
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
// 低于这个相似度就不摆"你也许想问"——摆了是噪音，不是帮助。端点自己的 threshold 也是 0.6，
// 但判断权留在前端：是我们决定"什么时候闭嘴"，不是端点替我们决定。
const SUGGEST_FLOOR = 0.60;
let SEM = { q: "", top: [], ms: 0, pending: false, err: "" };
let semSeq = 0;
let lastGapQ = null;   // 同一句话只记一次缺口，别让一次输入刷出一串事件

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
    if (lastGapQ !== state.q) { lastGapQ = state.q; emit("search_gap", { note: `top=${SEM.top[0].score}` }); }
    return;
  }

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
    `<div class="sg-label">你想问的，也许是这几个问题：</div>
     <div class="chips">${chips}</div>` +
    (allGap ? `<div class="sg-note">这些问题很重要，但我们现在还没有干净的答案，会继续寻找。</div>` : "");
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
      TOPICS = d.topics || [...new Set(ALL_DATA.map(i => i.topic))];
      DOMAIN_LIST = d.domains || [];
      applyDomain();
      render();
    })
    .catch(err => {
      if (attempt < 3) return setTimeout(() => loadData(attempt + 1), 800 * attempt);
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
