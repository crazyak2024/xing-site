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
// 只有抖音有官方 iframe 播放端点。视频号官方嵌入只存在于微信小程序里，网页做不到（平台限制）。
const EMBED_URL = { douyin: vid => `https://open.douyin.com/player/video?vid=${vid}&autoplay=1` };

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

let DATA = [];
let TOPICS = [];
const state = { q: "", topic: null, node: null };

/* ---------- 工具 ---------- */
function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}分${sec}秒` : `${sec}秒`;
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
  Object.assign(state, patch);
  render();
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
    html = `<div class="map-label">${label}</div>` + rows.map(r => `
      <div class="map-row">
        <button class="row-topic" data-topic-only="${esc(r.t)}" style="--c:${topicColor(r.t)}">
          <span class="dot"></span>${esc(r.t)}<span class="n">${r.n}</span>
        </button>
        <div class="chips">${r.nodes.map(([node, n]) => nodeChip(node, n, r.t, node === state.node)).join("")}</div>
      </div>`).join("");
    if (!rows.length) html = `<div class="map-label">没有命中任何问题节点，换个说法试试，或点上面的「全部」回到地图。</div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll("[data-node]").forEach(b => b.addEventListener("click", () => {
    const node = b.dataset.node;
    // 点已选中的节点 = 取消它（回到主题范围），不用再去找清除按钮
    go(node === state.node ? { node: null } : { node, topic: b.dataset.topic });
  }));
  el.querySelectorAll("[data-topic-only]").forEach(b => b.addEventListener("click", () => {
    const t = b.dataset.topicOnly;
    go(t === state.topic && !state.node ? { topic: null } : { topic: t, node: null });
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

/* ---------- 结果区 ---------- */
function sortItems(items) {
  const q = state.q;
  return [...items].sort((a, b) => {
    if (q) {
      const sc = it => (it.title.toLowerCase().includes(q) ? 10 : 0) + ((it.summary || "").toLowerCase().includes(q) ? 3 : 0);
      const d = sc(b) - sc(a);
      if (d) return d;
    }
    return (a.title || "").localeCompare(b.title || "", "zh");
  });
}

function cardHtml(it) {
  return `<div class="card" style="--c:${topicColor(it.topic)}" data-id="${esc(it.id)}">
      ${it.cover_url ? `<img class="thumb" src="${it.cover_url}" loading="lazy" alt="">` : `<div class="thumb"></div>`}
      <div class="card-body">
        <h3>${esc(it.title)}</h3>
        <div class="meta">
          <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
          ${it.author ? `<span class="author">@${esc(it.author)}</span> · ` : ""}
          ${fmtDuration(it.duration_s)}${it.likes ? " · " + it.likes + "赞" : ""}
        </div>
        <div class="summary">${esc(it.summary || it.reason || "")}</div>
      </div>
    </div>`;
}

function renderResults() {
  const el = document.getElementById("results");
  const items = filtered();
  document.getElementById("result-count").textContent = items.length ? `${items.length}条` : "";

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
    el.innerHTML = `<div class="grid">${sortItems(items).map(cardHtml).join("")}</div>`;
  } else {
    const order = [...byNode.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
    el.innerHTML = order.map(([node, list]) => `
      <div class="section">
        <div class="section-head">
          <span class="section-dot" style="background:${topicColor(list[0].topic)}"></span>
          <button class="section-title" data-drill="${esc(node)}" data-topic="${esc(list[0].topic)}">${esc(node)}</button>
          <span class="section-count">${list.length}条</span>
        </div>
        <div class="grid">${sortItems(list).map(cardHtml).join("")}</div>
      </div>`).join("");
    el.querySelectorAll("[data-drill]").forEach(b => b.addEventListener("click", () =>
      go({ node: b.dataset.drill, topic: b.dataset.topic })));
  }
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(DATA.find(it => it.id === c.dataset.id))));
}

function render() {
  renderCrumbs();
  renderMap();
  renderScopeHint();
  renderResults();
}

/* ---------- 弹窗 ---------- */
function openModal(it) {
  if (!it) return;
  const embedFn = EMBED_URL[it.platform];
  const m = document.getElementById("modal-content");
  m.className = embedFn ? "modal embed-mode" : "modal nolink-mode";
  const transcript = it.asr_text
    ? `<span class="transcript-toggle" id="tt">展开转写全文 ▾</span>
       <div class="transcript-box" id="tb">${esc(it.asr_text)}</div>` : "";
  const body = embedFn
    ? `<iframe class="modal-embed" src="${embedFn(it.video_id)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
       <p class="modal-tip">播放器是抖音官方的，它自带的点赞/评论/引导条我们改不掉。点进播放区后 Escape 可能失效（跨站 iframe 限制），用右上角 ✕ 关闭。</p>`
    : `<div class="modal-cover-wrap">
         ${it.cover_url ? `<img class="modal-cover" src="${it.cover_url}" alt="">` : ""}
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
      </div>
      <div class="modal-summary">${esc(it.summary || "")}</div>
      ${it.reason ? `<div class="modal-reason">入选依据：${esc(it.reason)}</div>` : ""}
      <a class="src" href="${it.link}" target="_blank" rel="noopener">在原平台看原作者的完整内容</a>
      ${transcript}
    </div>`;
  document.getElementById("modal-overlay").classList.add("open");
  m.querySelector(".modal-close").addEventListener("click", closeModal);
  // 弹窗里也能跳地图——看完一条顺着它所在的位置继续找，是这个产品的主循环
  m.querySelectorAll("[data-jump-topic]").forEach(b => b.addEventListener("click", () => {
    closeModal(); go({ topic: b.dataset.jumpTopic, node: null });
  }));
  m.querySelectorAll("[data-jump-node]").forEach(b => b.addEventListener("click", () => {
    closeModal(); go({ node: b.dataset.jumpNode, topic: b.dataset.topic });
  }));
  const tt = m.querySelector("#tt");
  if (tt) tt.addEventListener("click", () => {
    const box = m.querySelector("#tb");
    box.classList.toggle("open");
    tt.textContent = box.classList.contains("open") ? "收起转写全文 ▴" : "展开转写全文 ▾";
  });
  m.focus();
}
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.getElementById("modal-content").innerHTML = "";
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
  qTimer = setTimeout(() => { state.q = v; render(); }, 160);
});

/* data.json 已经 ~800KB（转写全文都在里面），实测网络不稳时会**半截下载却仍回 200**，
   JSON.parse 直接抛 → 页面全白。宁可给一句能看懂的话加一个重试按钮，
   也不要让人对着空白页猜。（根治是把 asr_text 拆成按需加载，见 ledger 下一步） */
function loadData(attempt = 1) {
  fetch("data.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => {
      DATA = d.items || [];
      TOPICS = d.topics || [...new Set(DATA.map(i => i.topic))];
      document.getElementById("lib-count").textContent = DATA.length;
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
loadData();
