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
/* `t=` 是起播秒数——跳到某一秒 ＝ 换 src 重载整个 iframe（没有拖动条/倍速那套命令协议，
 * 2026-11-11 实测见 notes/xing/嵌入播放器能做到什么…md）。
 * ⚠️ 原来传的 `high_quality=1` 其实不在 B站 player 认的参数表里（`aid cid bvid seasonId
 * episodeId poster autoplay muted t p page danmaku kind refer`），一直被静默忽略，删掉。 */
const EMBED_URL = {
  douyin: (vid) => `https://open.douyin.com/player/video?vid=${vid}&autoplay=1`,
  bilibili: (vid, t) => `https://player.bilibili.com/player.html?bvid=${vid}&autoplay=0&danmaku=0${t ? `&t=${t}` : ""}`,
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

/* ══════════ 首页壳层：shell.json（CY 2026-11-11 05:1x 报「主页是空的」）══════════
 * 他的话：「现在主页是空的，搜一个内容就要等待」。查实：`data.json` 这天已经涨到
 * **3.84MB**（gzip 后约 1.1MB），本机当时网络又恰好很慢（独立验证：绕开代理直连，
 * 12–30KB/s，不是我们代码的锅）—— 但哪怕网络正常，首页那 4 张主题卡（概念原理/
 * 方法实操/误区纠正/时效选择）也要等**全部 1979 条正文**下载解析完才画得出来，
 * 而它们真正需要的只是"名字 + 条数 + 一句静态提示"，**没有一条正文字节是必须的**。
 *
 * 这不是新故障，是旧债——`pipeline/export_site.py` 里原来就写着"彻底的修法是拆包，
 * 这里先把假话去掉"，只是一直没排上。
 *
 * 做法：后端另导出一份 `shell.json`（2–3KB，和 data.json 同一次导出一起生成），
 * 装首页用得到的一切（`topics`/`topic_counts`/`domains`/`families`/`domain_family`/
 * `all_count`），**不含任何一条内容正文**。前端两份并行取，shell 先到就先把首页画出来；
 * `data.json` 继续给搜索结果和详情页用，那部分的逻辑一个字都没动。
 * ⚠️ **只管首页顶层（S0）、未选领域的那条路径**：选了领域 / 搜了词 / 进了问题之后，
 * 该等 `data.json`还是等——那些视图需要的是具体哪几条内容，shell 给不了。 */
let SHELL_LOADED = false;
let TOPIC_COUNTS = {};  // {主题名: 条数}，首页顶层 4 张卡用
let ALL_COUNT = 0;      // 全库合格总数，首页"库内 N 条"/"全部领域 N"在数据到之前先显示这个
const state = { q: "", topic: null, node: null, domain: null, mine: false, asks: false };

/* 哪些主题行在 S1/S2 被手动展开过（CY 2026-11-08 10:5x：「section下tag太多了，无法阅读了，
   而且把视频推到太下面」）。不进 state/URL——只是这一屏的临时展示状态，换个主题/搜索词
   就该重新收起，不该跨导航保留。 */
const expandedRows = new Set();
const ROW_CHIP_MAIN = 8; // 单行最多先亮出几个节点，其余折进"其他N条"（S0 同款阈值的行版）

/* 搜索结果里他正在看哪一个问题（CY 2026-11-11 16:2x：「搜索以后的结果，现在是分问题
   展示的，这些问题应该在上方列出来供用户选择」）。
   为什么不进 state/URL：它**不是一次导航**——选一个问题只是把同一份结果收窄到其中一段，
   随时能按"全部"回去；真要进到那个问题里，点问题名本身（那条路一直在，走的是 go()）。
   换搜索词/换导航就归零，和 expandedRows 同性质。 */
let resultFocus = null;

/* 领域切换（fin1 起）：领域是比主题更粗的一级——"AI 与大模型"和"财经基础"下面各有
   自己的 4 个主题。为什么要这一级：不分的话"概念原理"里会同时出现 Transformer 和
   通货膨胀，用户点进去看到的是两个不相干领域搅在一起。
   ⚠️ 只有在**真有 2 个以上领域有内容**时才显示这个切换条——只有一个领域时它是纯噪音。 */
function applyDomain() {
  DATA = state.domain ? ALL_DATA.filter(it => it.domain === state.domain) : ALL_DATA;
  const el = document.getElementById("lib-count");
  if (!el) return;
  // data.json 没到之前，DATA 是空的——这时"库内 0 条"是假话，宁可先显示 shell 给的
  // 真实总数（选了领域就查那个领域的真实条数，没选就是 all_count）。数据一到，
  // 行为和原来完全一样（DATA.length 本来就该和这两个数相等）。
  if (!DATA_LOADED && SHELL_LOADED) {
    const n = state.domain ? (DOMAIN_LIST.find(d => d.id === state.domain)?.count ?? ALL_COUNT) : ALL_COUNT;
    el.textContent = n;
    return;
  }
  el.textContent = DATA.length;
}
function domainBarHtml() {
  if (DOMAIN_LIST.length < 2) return "";
  const btn = (id, label, n) =>
    `<button class="dchip${(state.domain === id || (!state.domain && id === null)) ? " on" : ""}" ` +
    `data-domain="${id === null ? "" : esc(id)}">${esc(label)}${n ? ` <span class="dn">${n}</span>` : ""}</button>`;
  // 同上：数据没到时用 shell 给的总数，不是 0——这一行本来就该和 lib-count 同一个数。
  const allN = DATA_LOADED ? ALL_DATA.length : ALL_COUNT;
  return `<div class="domain-bar">` + btn(null, "全部领域", allN) +
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
/* 把漏进文案的**内部视频 ID** 换成那条视频的标题（CY 定过的红线：界面上不出现内部名）。
 * 2026-11-10 实测：33 个主题页里 **10 页、35 处**，全在"内容之间有分歧"那一段，长这样
 *   《AI幻觉原理与分类详解》说…UzFfBgAAxLOmbER1 与 UzFfBgAAxMii 则强调…
 * 真因在生成那头：视频号那批内容没有干净标题可引，模型就拿 ID 当名字用了。
 * 这里是**渲染层的兜底**（立刻生效、不用花钱重跑），生成层的机检另外加。
 * 刻意不做"直接删掉"：删了会留下「与　则强调」这种断句，比留着 ID 更难读。 */
const ID_IN_PROSE = /UzFfB[A-Za-z0-9_-]{6,}|\b\d{17,19}\b|\bBV[0-9A-Za-z]{8,}\b/g;

function deIdentify(s) {
  if (!s) return s;
  return String(s).replace(ID_IN_PROSE, tok => {
    // 两件事都要处理：① 文案里的 ID 常被截断 ② 视频号的 video_id 在库里带 `export/` 前缀
    //（`export/UzFfBgAAx…`），拿原串直接比会一条都对不上、全退化成"另一条内容"。
    const hit = (ALL_DATA.length ? ALL_DATA : DATA).find(it => {
      const v = String(it.video_id || "").split("/").pop();
      return v && (v.startsWith(tok) || tok.startsWith(v));
    });
    return hit ? `《${hit.title}》` : "另一条内容";
  });
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

/* ================= 地址栏：每一屏都有自己的地址 =================
 * CY 2026-11-10 15:2x：「所有结果页与视频页都应该有分享链接」「等待页也应该有让用户
 * 晚点回来的入口」。这两件缺的是**同一个东西**：在此之前，这个站从头到尾只有一个网址
 * ——搜什么、点进哪个问题、打开哪条视频，地址栏一个字都不变。于是：
 *   · 想把一条视频发给朋友 ⟹ 只能发首页，朋友落地后还得自己再搜一遍
 *   · 补搜要跑几分钟 ⟹ 用户只能守着那一页，关掉就找不回来了
 * 用 replaceState 而不是 pushState：地址栏永远反映"你正在看什么"（分享要的就是这个），
 * 但不往历史里塞一堆中间态——那会让后退键变成"退一格筛选"，而站上的回退入口
 * 是面包屑和站名，不是浏览器后退。*/
const URL_KEYS = ["d", "q", "topic", "node"];

function shareUrl(videoId, lane) {
  const p = new URLSearchParams();
  if (state.domain) p.set("d", state.domain);
  if (state.q) p.set("q", state.q);
  if (state.topic) p.set("topic", state.topic);
  if (state.node) p.set("node", state.node);
  if (videoId) p.set("v", videoId);
  if (lane) p.set("lane", "1");   // 只有"等待页"给出的地址带它：回来要接着看进度
  if (REL_OPEN) p.set("rel", "1");
  if (state.mine) p.set("mine", "1");  // 更新记录面板也有自己的地址（可以直接发"看我们改了什么"）
  if (state.asks) p.set("asks", "1");  // 「我要补的」也要能用地址回来（他刷新丢掉入口就是这件事）
  const s = p.toString();
  return location.origin + location.pathname + (s ? "?" + s : "");
}

function syncUrl(videoId) {
  try { history.replaceState(null, "", shareUrl(videoId)); } catch (e) { /* 老浏览器就算了 */ }
}

/* 进站时把地址里的状态装回去。**在 data.json 到之前只装进 state，不做任何校验**——
   节点/领域要等数据到了才知道存不存在，这里提前判会把合法链接判成坏链接。 */
let PENDING_VIDEO = null;   // ?v= 指定的视频，等 data.json 到了再打开
let PENDING_LANE = null;    // ?lane=1：他是从"等待页"存的地址回来的
function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.toString()) return;
  if (p.get("d")) state.domain = p.get("d");
  if (p.get("q")) state.q = p.get("q").trim().toLowerCase();
  if (p.get("topic")) state.topic = p.get("topic");
  if (p.get("node")) state.node = p.get("node");
  PENDING_VIDEO = p.get("v") || null;
  PENDING_LANE = p.get("lane") === "1" ? state.q : null;
  PENDING_REL = p.get("rel") === "1";
  if (p.get("mine") === "1") state.mine = true;
  if (p.get("asks") === "1") state.asks = true;
  const box = document.getElementById("q");
  if (box && state.q) box.value = state.q;
}

/* 复制链接。clipboard API 在 https 下才有，GitHub Pages 是 https；
   失败要**看得见地失败**（按钮上写"复制不了，长按地址自己拷"），不能假装复制了。 */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((res, rej) => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand("copy");
    ta.remove();
    ok ? res() : rej(new Error("execCommand failed"));
  });
}

/* 分享按钮。手机上优先用系统分享面板（能直接发给微信/飞书里的人），
   没有就退回复制链接——两条路都要给出可见回执，不能点完没反应。 */
function shareBtnHtml(videoId, label, lane) {
  return `<button class="share-btn" type="button" data-share="${esc(videoId || "")}"
    ${lane ? 'data-share-lane="1"' : ""} title="复制这一页的地址">${esc(label || "分享")}</button>`;
}

function bindShareButtons(root) {
  (root || document).querySelectorAll("[data-share]").forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", async ev => {
      ev.stopPropagation();           // 卡片里的分享按钮不该顺手把卡片点开
      const url = shareUrl(b.dataset.share || null, b.dataset.shareLane === "1");
      const title = document.title;
      /* ⚠️ 这里**故意不记 BI**：云端事件表有 kind 白名单，`share` 不在里面，发过去会被
         静默丢掉（worker.js KINDS）。要记"分享了几次"得先在白名单加一行再部署 Worker
         —— 那是一次生产部署，等 CY 下次批 Worker 部署时顺手加，不在这一版偷偷塞。*/
      if (navigator.share) {
        try { await navigator.share({ title, url }); return; }
        catch (e) { if (e && e.name === "AbortError") return; /* 用户自己取消，别再弹复制 */ }
      }
      try {
        await copyText(url);
        const old = b.textContent;
        b.textContent = "已复制链接";
        b.classList.add("ok");
        setTimeout(() => { b.textContent = old; b.classList.remove("ok"); }, 1800);
      } catch (e) {
        b.textContent = "复制不了，长按地址栏自己拷";
      }
    });
  });
}

/* ---------- 状态改写（地图上每一次点击都走这里） ---------- */
function go(patch) {
  /* 两个面板（我的收藏 / 我要补的）是**旁路视图**：任何一次真的去看内容的导航都该关掉它们。
     少了这一条就会出现"在收藏页里搜了个词，结果还停在收藏页"——两边各自记得画自己，
     但没人负责在离开时关门。`mine` 本来就有这个毛病，`asks` 进来之前先一起补上。
     显式写了 mine/asks 的调用（比如从首页点进"我要补的"）以调用方为准。 */
  if (["q", "node", "topic", "domain"].some(k => k in patch)) {
    if (!("mine" in patch)) patch.mine = false;
    if (!("asks" in patch)) patch.asks = false;
  }
  // 换节点就把"其余N条"收回去：展开状态属于那一页，不该跟着导航走
  if ("node" in patch && patch.node !== state.node) evExpanded = false;
  mapExpanded = false;   // 地图的展开同理：换了一屏就该重新收起
  resultFocus = null;    // 上一屏选中的那个问题不跟着导航走（同上）
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
  /* 分享按钮挂在面包屑这一行：**凡是面包屑出现的地方，就是"你正在看某一页"**
     （搜索结果 / 主题 / 具体问题三种都算），首页没有面包屑也就不该有分享——
     首页的地址人人都有。这样一个位置就覆盖了"所有结果页"，不必每种视图各加一个。 */
  // 标签写「分享」而不是「分享这一页」：手机 390 宽下长标签会把这颗按钮挤到第二行，
  // 于是分享**独占一行**（体验审查 §2 数到的 13 个区块之一）。它在面包屑行尾，不必自述。
  el.innerHTML = parts.length > 1
    ? parts.join(`<span class="sep">›</span>`) + shareBtnHtml(null, "分享")
    : "";
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

/* 已经决定看什么了吗（搜了词 / 进了某个问题）。准则 10 的触发条件：
   「地图是"还没决定看什么"时的工具；已经决定了，它收成一行」。 */
function decided() { return Boolean(state.node) || Boolean(state.q); }
let mapExpanded = false;   // 折起的地图被手动展开过（属于这一屏，换导航就收回）

/* ?node= 指向库里根本没有的问题（分享链接过期、手敲错）。
   体验审查 §5 实测：原来会把全部 284 个节点铺出一屏、最底下才说"这里还没有内容"
   ——一个坏链接长得像一个巨大的目录页。必须等 data.json 到了才能下这个判断。 */
function nodeMissing() {
  return Boolean(DATA_LOADED && state.node && !ALL_DATA.some(it => it.node === state.node));
}

function renderMap() {
  const el = document.getElementById("map");
  const scope = mapScope();
  let html = "";

  if (nodeMissing()) { el.innerHTML = ""; return; }

  if (!state.q && !state.topic && !state.node && !DATA_LOADED && SHELL_LOADED && !state.domain) {
    /* 🔑 shell 快速路径：data.json 没到，但 shell.json 到了——首页顶层 4 张卡只需要
       "名字+条数+静态提示"，shell 全都有，不必等正文。数据一到，下面那条真实路径
       会重新渲染一遍，行为分毫不差（这是同一份 TOPIC_HINT，只是条数的来源不同）。
       ⚠️ 只接管**未选领域**的顶层视图：选了领域后的拆分，shell 没有这个粒度，
       交给下面原来的逻辑（此时它会照旧显示"还没数据"，那个状态本来就少见）。 */
    html = `<div class="topic-grid">` + TOPICS.filter(t => TOPIC_COUNTS[t]).map(t => `
      <div class="topic-card slim" style="--c:${topicColor(t)}">
          <button class="topic-head" data-topic-only="${esc(t)}">
            <span class="dot"></span><span class="tname">${esc(t)}</span><span class="tn">${TOPIC_COUNTS[t]}条</span>
          </button>
          <div class="thint">${esc(TOPIC_HINT[t] || "")}</div>
        </div>`).join("") + `</div>`;
    // 和下面那条真实路径一样，顶上要带着领域 tab（domainBarHtml 也是 shell 字段驱动的，
    // 数据没到时一样能画对）——漏了这一步的后果是真机点开后"全部领域/AI/财经…"那排消失了，
    // 11-11 05:3x 判据第一次跑就在这里抓到（0 个 .dchip）。
    el.innerHTML = domainBarHtml() + html;
    el.querySelectorAll("[data-domain]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.domain || null;
      const qbox = document.getElementById("q");
      if (qbox) qbox.value = "";
      state.domain = id;
      applyDomain();
      go({ topic: null, node: null, q: "" });
    }));
    el.querySelectorAll("[data-topic-only]").forEach(b => b.addEventListener("click", () => {
      const t = b.dataset.topicOnly;
      go(t === state.topic && !state.node ? { topic: null } : { topic: t, node: null });
    }));
    return;
  }

  if (!state.q && !state.topic && !state.node) {
    /* S0 顶层目录：4 个主题卡。每卡只列 ≥2 条的节点，单条的汇总成"其他"——
       否则首屏就是一堆"1 条"的碎节点，又回到看花眼。 */
    const byTopic = new Map();
    for (const it of DATA) {
      if (!byTopic.has(it.topic)) byTopic.set(it.topic, []);
      byTopic.get(it.topic).push(it);
    }
    /* CY 2026-11-10 17:0x：「文案必须是对用户有价值的话，不要解释与他们无关的事情」。
       这里原来有一句「点一个主题，或直接点下面的问题——两下就到内容…」：它解释的是**怎么操作**，
       而卡片本身已经说明了这件事。判准还是那条——删掉它，用户会做错什么吗？不会。 */
    html = `<div class="topic-grid">` + TOPICS.filter(t => byTopic.has(t)).map(t => {
      const items = byTopic.get(t);
      const nodes = [...countBy(items, "node").entries()].sort((a, b) => b[1] - a[1]);
      const main = nodes.filter(([, n]) => n >= 2).slice(0, 5);
      const restN = nodes.filter(([, n]) => n < 2).reduce((s, [, n]) => s + n, 0);
      /* CY 2026-11-10 16:5x：「四项下面有很多 tag…现在差不多占了四五行，太高了，
         高度控制在两行」。**首页不再铺节点 tag**——进了主题之后局部地图自然会把它们列出来，
         首页摆一遍只是把真正的内容挤到屏幕外（同一个病 11-08 已经犯过一次）。
         首页这块的职责只有一件：让你两下就进到某个主题。所以一张卡 = 名字 + 条数 + 一句
         这主题答的是什么，不多不少。四张卡两列排 ⟹ 整块恰好两行。 */
      return `<div class="topic-card slim" style="--c:${topicColor(t)}">
          <button class="topic-head" data-topic-only="${esc(t)}">
            <span class="dot"></span><span class="tname">${esc(t)}</span><span class="tn">${items.length}条</span>
          </button>
          <div class="thint">${esc(TOPIC_HINT[t] || "")}</div>
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

    /* 标题只说"这是什么"，不解释"点一个就只看它"（体验审查 §6：版面上不写操作说明）。
       原来没有 topic 也没有 q 时会渲染出「 下的问题 —— 点一个进去」这种开头就缺主语
       的句子（真机截到过），所以第三种情况得有自己的说法。 */
    const label = state.q
      ? `围绕「${esc(state.q)}」的问题`
      : state.topic ? `${esc(state.topic)} 下的问题` : `地图上的其他问题`;
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
    if (!rows.length) html = `<div class="map-label">没命中任何问题。换个说法，或点「全部」回地图。</div>`;

    /* ── 决定了之后，整块地图收成一行（体验审查 §2）──
       实测：进「血糖是怎么升上去又降下来的」后，第一张卡之前压着 13 个区块，其中
       领域药丸两行 + 地图说明 + 四组 chips（16 个）就占了 4 块。它们是"还没决定看什么"
       时的工具。折起来 ⟹ 内容上到第一屏；点一下就全回来，一个都没少。
       领域切换条一起折：它比主题更粗的一级入口，而换领域会清掉当前的问题，
       在一个已经选定的问题页上它只是噪音。 */
    if (decided() && !mapExpanded) {
      const n = rows.reduce((s, r) => s + r.nodes.length, 0) - (state.node ? 1 : 0);
      // 这一行的数字说的是"折起来的是什么"，所以三种情况各有说法：搜了词 ⟹ 命中的问题，
      // 只进了节点 ⟹ 同主题的其他问题。说错了用户会以为点开是另一批东西。
      const what = state.q
        ? (state.node ? `命中的其他 ${n} 个问题` : `命中 ${n} 个问题`)
        : `同主题还有 ${n} 个问题`;
      el.innerHTML = n > 0 ? `<button class="map-fold" id="map-more">${what} ▾</button>` : "";
      const more = el.querySelector("#map-more");
      if (more) more.addEventListener("click", () => { mapExpanded = true; renderMap(); });
      return;
    }
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
    // 这一条是**状态**不是解释（体验审查 §6 点名留下的那一句），但写短（原来 13 个字的
    // 「正在…范围内搜索」+「在全部内容里搜」）。
    el.innerHTML = `只在「${esc(state.node || state.topic)}」里搜 ·
      <button class="linklike" id="search-all">搜全部</button>`;
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

/* ---------- 「?」：版面上不写解释句，解释挂在问号后面（CY 2026-11-10 09:4x 批 v2） ----------
 * 他的原话：「整个版面上解释的文字太多了，就看起来很费劲…文字多的地方也应该把它收起来，
 * 变成个问号之类的」「希望用户能够几秒的时间就能看明白整个网页的结构是什么」。
 * ⚠️ 这不和"诚实是功能"冲突：诚实要的是**那句话存在且查得到**，不是糊在他脸上。
 * 判准：删掉这句，用户会做错什么吗？不会 ⟹ 收进 ?。
 */
const HINTS = {};   // key -> 纯文本（渲染时填，因为里面有实时数字）

function hintBtn(key) { return `<button class="qm" data-hint="${esc(key)}" aria-label="说明">?</button>`; }

function closeHint() { document.querySelectorAll(".qpop").forEach(n => n.remove()); }

document.addEventListener("click", e => {
  const b = e.target.closest?.(".qm");
  if (!b) { closeHint(); return; }
  const open = b.nextElementSibling?.classList?.contains("qpop");
  closeHint();
  if (open) return;
  const pop = document.createElement("span");
  pop.className = "qpop";
  pop.textContent = HINTS[b.dataset.hint] || "";
  b.after(pop);
  e.stopPropagation();
});

/* 答案区。v2 起它只有三样东西：区块标题 + 答案本身 + 展开/收起。
   原来摊在这里的两段解释（"下面就是答案，我们读完了…" / "答完了。关掉就行…下面N条是它的证据"）
   一句进了 ?、一句进了页脚灰字行。"证据"这个词整体废弃——那些视频是答案的**来源**，
   不是答案的**验证**（真伪核验走的是 recheck 查外部事实那条路）。 */
const ANSWER_PEEK = 3;      // 默认露几点（CY：「给个3行左右，用户想看就展开」）
let ansExpanded = false;

function renderAnswer() {
  const el = document.getElementById("answer");
  if (!el) return;
  const p = currentPage();
  if (!p || !(p.outline || []).length) { el.innerHTML = ""; lastAnswerNode = null; return; }
  const r = p.receipt || {};
  const pts = p.outline;
  const shown = ansExpanded ? pts : pts.slice(0, ANSWER_PEEK);
  const rest = pts.length - shown.length;
  HINTS.answer = `这 ${pts.length} 点是读完这个问题下全部 ${r.qualified} 条合格内容合并的，`
    + `不是某一条视频的说法。没有热度排序，也没有推荐算法。`;
  el.innerHTML = `<div class="sec" style="--c:${topicColor(topicOfNode(p.node))}">
      <div class="sh"><span class="t">答案</span><span class="n">${pts.length} 点</span>${hintBtn("answer")}</div>
      <div class="ans">
        <ol${ansExpanded ? "" : ' class="peek"'}>${shown.map(x =>
    `<li>${esc(deIdentify(x))}</li>`).join("")}</ol>
        ${pts.length > ANSWER_PEEK
      ? `<button class="ans-more" id="ans-more">${rest
        ? `展开剩下 ${rest} 点 ▾` : "收起 ▴"}</button>` : ""}
      </div>
    </div>`;
  const more = el.querySelector("#ans-more");
  if (more) more.addEventListener("click", () => { ansExpanded = !ansExpanded; renderAnswer(); });
  if (lastAnswerNode !== p.node) {
    lastAnswerNode = p.node;
    emit("answer", { note: `outline=${pts.length} picked=${r.picked} folded=${r.folded || 0}` });
  }
}

/* 相邻的问题 + 页脚那一行灰字。两块都只在主题页出现，排在视频之后（mock v2 的顺序）。 */
function tailHtml(p) {
  const r = p.receipt || {};
  /* 每种关系最多给一条。**不去重会三条全是"它是这个更大问题的一块"**（实测本页就是），
     那等于把"相邻的问题"这块的意义抹掉——它要回答的是"从这里还能往哪三个方向走"，
     不是"列三条边"。四种关系按这个顺序优先：先给向上的大问题，再给前置，再给易混，最后给实例。 */
  const ORDER = ["answers_part_of", "prereq", "confusable_with", "instance_of"];
  const all = ((DATA_EDGES && (DATA_EDGES[p.category] || DATA_EDGES[p.node])) || [])
    .filter(e => EDGE_CN[e.type]);
  const edges = ORDER.map(t => all.find(e => e.type === t)).filter(Boolean).slice(0, 3);
  HINTS.near = "这几条是知识关系（它是谁的一块、要先懂什么、常被和谁搞混），"
    + "不是「看了这个的人还看了」——所以每条都说得出为什么。";
  const near = edges.length ? `<div class="sec">
      <div class="sh"><span class="t">相邻的问题</span>${hintBtn("near")}</div>
      <div class="near">${edges.map(e => `<button class="nb" data-near="${esc(e.dst)}">
        <span class="k">${EDGE_CN[e.type].mark} ${EDGE_CN[e.type].k}</span>
        <span class="nm">${esc(displayNode(e.dst))}</span></button>`).join("")}</div>
    </div>` : "";
  const dis = (p.disputed || []).length;
  HINTS.disputed = dis ? (p.disputed || []).map(d =>
    `· ${deIdentify(d.claim || "")}\n  ${deIdentify(d.sides || "")}`).join("\n\n") : "";
  return `${near}
    <div class="pagefoot">
      ${dis ? `<span class="warn">⚠ ${dis} 处分歧</span>${hintBtn("disputed")}` : ""}
      ${r.rejected ? `<span>${r.rejected} 条没过关，没放上来</span>` : ""}
      <span class="done">答完了，关掉就行。</span>
    </div>`;
}

/* 视频区。**它是这一页的主内容**（CY 2026-11-10 09:4x：「我们找到的这几个视频是这个回答的
 * 主内容，主内容不应该放在右边的 Panel 上」），所以用和搜索结果同一套大卡片，占满主栏。
 * v1 曾把它塞进右侧 400px 的栏——并排的代价是层级消失，左右两栏视觉上天然等权。
 *
 * 每条上面原来那段「对应上面第 1、2 点 · 它负责讲机制 · 只有它讲了…」整段去掉，
 * 换成卡片角上的小圆点徽章（准则 14：能用直观形式表达的，不用文字）。
 * 入选理由没有丢——仍在卡片的 title 上，鼠标停住看得到。 */
function renderEvidence(el, items, page) {
  const byId = new Map(items.map(it => [it.id, it]));
  const staleWhy = new Map((page.stale || []).map(s => [s.id, s.why]));
  const picks = (page.picks || []).filter(p => byId.has(p.id));
  const restRows = (page.order || []).filter(o => o.bucket !== "pick" && byId.has(o.id));

  HINTS.videos = `这 ${picks.length} 条不是用来证明上面那段话的——它们是同一个问题，`
    + `别人讲给你听的版本。每条角上的数字，是它讲到了上面第几点。`
    + `从 ${(page.receipt || {}).qualified || items.length} 条合格内容里挑的，按阅读顺序排，没有热度排序。`;

  const covers = new Map(picks.map(p => [p.id, p.covers || []]));
  const whyOf = (p) => [p.role, p.unique ? `只有它讲了：${p.unique}` : "",
    staleWhy.get(p.id) ? `⏳ 可能过时：${staleWhy.get(p.id)}` : ""].filter(Boolean).join(" · ");

  el.innerHTML = `
    <div class="sec">
      <div class="sh"><span class="t">讲这个问题的视频</span>
        <span class="n">${picks.length} 个</span>${hintBtn("videos")}</div>
      <div class="grid">${picks.map(p =>
    cardHtml(byId.get(p.id), whyOf(p), covers.get(p.id))).join("")}</div>
      ${restRows.length ? (evExpanded
      ? `<div class="grid grid-rest">${restRows.map(o =>
        cardHtml(byId.get(o.id), o.reason)).join("")}</div>`
      : `<button class="vfold" id="ev-more">还有 ${restRows.length} 条讲的是同一件事 ▾</button>`)
    : ""}
    </div>
    ${tailHtml(page)}`;

  const more = el.querySelector("#ev-more");
  if (more) more.addEventListener("click", () => { evExpanded = true; renderResults(); });
  el.querySelectorAll("[data-near]").forEach(b => b.addEventListener("click", () => {
    ENTRY_EDGE = `near:${page.node}`;          // 从答案页顺着边走，和弹窗里那条同一个口径
    emit("edge_follow", { note: ENTRY_EDGE });
    go({ node: b.dataset.near, topic: null, q: "" });
  }));
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

/* covers：这条视频讲到了答案的第几点。用小圆点徽章而不是「对应上面第 1、2 点」那句话
   （CY 2026-11-10：「尽量用一些其他很直观的方式让用户理解这是什么」）。 */
/* 封面加载失败的兜底（2026-11-10 Alpha 前评估修）。
 * 原来写的是 `this.closest('.card-cover')?.remove()||this.remove()` —— DOM 里**没有**
 * `.card-cover` 这个类（真实类名是 `.card-thumb`），所以兜底实际退化成"只删掉 <img>"，
 * 留下一个纯黑 16:9 空框，而不是本来就准备好的"渐变+平台名"占位块。
 * 为什么现在必须修：抖音封面是**签名 URL**，库里 110 条的签名在 2026-11-21 06:00–11:00
 * 集体过期（当日实测），过期后一起 403 —— 那天会有 110 张卡片同时变黑框。
 * 兜底做对了，那天只会退化成占位块，不会"看起来坏了"。 */
function coverFail(img) {
  const box = img.closest(".card-thumb") || img.parentElement;
  img.remove();
  if (!box || box.querySelector(":scope > span:not(.plat-badge):not(.dur-badge)")) return;
  box.classList.add("noimg");
  const plat = box.querySelector(".plat-badge");
  const s = document.createElement("span");
  s.textContent = plat ? plat.textContent : "";
  box.insertBefore(s, box.firstChild);
}
window.coverFail = coverFail;

function cardHtml(it, whyNote, covers) {
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
             onerror="coverFail(this)">`
      : `<span>${esc(PLATFORM_CN[it.platform] || it.platform)}</span>`}
        <span class="plat-badge">${esc(PLATFORM_CN[it.platform] || it.platform)}</span>
        ${bmBtn(it.id, isMarked(it.id))}
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
        ${(covers || []).length
      ? `<div class="pts" title="它讲到了答案的第 ${covers.map(i => i + 1).join("、")} 点">${
        covers.map(i => `<i class="pt">${i + 1}</i>`).join("")}</div>` : ""}
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
  /* 排序规则那一行原来是常驻的长说明句。v2 起收进 `?`（CY：版面上解释的文字太多了）。
     它仍然在页面上、仍然查得到——只是默认不占版面。 */
  const page = currentPage();
  const bar = document.querySelector(".toolbar");
  if (page && !state.q && items.length) {
    HINTS.sort = "这一页的顺序是编辑判断：先给答案，再按阅读顺序给视频。"
      + "每条为什么入选、为什么没入选都有记录。没有热度排序。";
    if (bar) bar.hidden = true;   // 主题页自己带区块标题，不需要这条工具栏
    renderEvidence(el, items, page);
    return;
  }
  HINTS.sort = "同一问题内：B站优先（讲得通常更完整），其余按标题排序；"
    + "有搜索词时标题命中的排前面。没有热度排序，也没有推荐算法。";
  if (bar) {
    bar.hidden = false;
    const note = bar.querySelector(".sort-note");
    if (note) note.innerHTML = `怎么排的${hintBtn("sort")}`;
  }

  // 🔴 **数据还没到 ≠ 我们没有内容**（CY 2026-11-10 08:2x 手机首开实测报的 bug，
  // 11-11 05:1x 又报一次「主页是空的」——那次的病根是"知识地图也绑在这份大文件上"，
  // 已经用 shell.json 拆开，见 loadShell()）。这里剩下的是**结果/详情**那部分：
  // 它们要的是哪几条内容本身，没法靠一份几 KB 的摘要代替，加载中必须老实说加载中。
  // ⚠️ **"约 1MB"这句原来写死一个数字，库从 1620 条长到 1979 条后它已经偏了**——
  // 条数会一直涨，写死的字节数只会越来越不准。改成不量化的说法，不再因为库存变化而漂移。
  if (!DATA_LOADED) {
    el.innerHTML = `<div class="empty"><span class="lane-spin"></span>正在把这部分内容载入…
      <div class="empty-note">上面的分类和问题已经能点——这里要的是具体内容，
      网络慢时会多等一会儿。</div></div>`;
    return;
  }
  /* ══════════ 首页不铺内容（CY 2026-11-10 批体验审查 §1）══════════
   * 量到的：手机 390 宽，首页 `body.scrollHeight = 659,185px`、`.card` **1951 张**
   * ⟹ 844px 一屏算下来是 **780 屏**，第二屏开始就是整屏的平台封面
   * （「12款免费AI生图工具」「全行业覆盖 6600+香蕉提示词」）。
   *
   * 这不是性能问题，是**定位的自我否定**：第一屏印着「不投喂 · 不留你」、页脚印着
   * 「没有无限滚动」，中间夹着 1951 条平台诱饵封面 —— 那两句话当时是假的。
   * 和抖音首页的差别只剩"没有自动播放"。
   *
   * 所以：库里有什么，用**数字 + 入口**表达（四张主题卡的条数、几条真实问题），
   * 要给"可点的证据"（准则 1）就给问题，不给视频。**视频只在用户问过之后出现。**
   */
  if (!state.q && !state.topic && !state.node) {
    el.innerHTML = "";
    document.getElementById("result-count").textContent = "";
    if (bar) bar.hidden = true;
    return;
  }

  /* 坏链接：?node= 指向库里没有的问题。一句话说清，不铺地图（体验审查 §5）。 */
  if (nodeMissing()) {
    el.innerHTML = `<div class="empty">这个问题不在我们库里。
      <div class="empty-q">链接里写的是「${esc(displayNode(state.node))}」</div>
      <div class="empty-acts"><button class="linklike" id="reset-all">回到知识地图</button></div></div>`;
    el.querySelector("#reset-all").addEventListener("click", () => {
      document.getElementById("q").value = "";
      go({ q: "", topic: null, node: null });
    });
    return;
  }

  /* ══════════ 库里有、只是说法对不上 ══════════
   * CY 2026-11-11 06:5x 截图实测：他搜「怎么控制血糖」，结果区写着"这里还没有内容"、
   * 请他按「我要这个」去花钱找；按下去后台环 0 回了一句"其实我们有"（0.841，6 条）。
   * **同一个分数、同一条线**（前端 SUGGEST_SURE 0.75 ＝ 后端 SEM_SURE 0.75），
   * 前台说没有、后台说有。他的原话是「这是搞什么？」。
   *
   * 病根：结果区的过滤从头到尾只有 `hitsQuery` 子串匹配，语义分只拿去画上面那排建议条。
   * 换一种说法就是 0 命中 —— 而我们在说"没有内容"的那一刻，**已经知道答案在哪个节点里**。
   * bz1（11-10）当时只把"我要这个"搬进了这块空白，没有把**内容**搬进来，所以病还在。
   *
   * ⟹ 确信区（≥0.75）且该节点库里真有内容时，直接把那些内容摆出来；
   *    既不先说一句"没有内容"，也不让他为已经有的东西按一次要花钱的按钮。
   *    「都不是？」出口保留：确信区也会认错，认错时他仍要能让我们去找。
   */
  if (!items.length && !state.node) {
    const sure = sureNodeHits();
    if (sure.length) { renderSureHits(el, state.q, sure); return; }
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
    /* 语义还在路上时**不要先断言"没有内容"**——线上实测 `/semantic` 冷启要 9.7 秒，
       而答案可能就在上面那个确信命中分支里。但也**不能把出口一起扣住**：
       按钮照常给，只把那句"没有内容"换成"正在找"，等分数到了会自己重画（见 fetchSemantic）。 */
    const waiting = Boolean(q) && SEM.pending && SEM.q === q;
    /* 🔴 **已经让我们找过的问题，不许再推销一次「我要这个」**（CY 2026-11-11 22:5x）。
     * 他从「我要补的」点进一条已经跑完的，看到的是一块全新的空白 + 一颗
     * 「我要这个 →」，和他从没问过时**一模一样**。他的原话：「点进一个要补的，
     * 没有看到任何结果，又给我『我要这个』的选项。这整个体验是 break 的。」
     * 按钮本身没错，错在它假装这是第一次：我们明明记得他问过、也知道结果是什么。
     * 结论归结论（下面那块 .lane 会说），这里只负责**不装失忆**：
     * 还在跑就说还在跑，跑完了就**把按钮收掉**。
     * ⚠️ 刻意**不给「再找一次」**：云端那份缓存活 24 小时，这颗按钮按下去只会原样
     * 回放同一份结果——一颗假按钮比没有按钮更糟。真要能重试得先给 /rtsearch 加
     * force 参数（要改 Worker 并部署），那是另一轮的事。 */
    const a = q ? findAsk(q) : null;
    const asked = a && !askTerminal(a);        // 这一问我们正在找
    const askedDone = a && askTerminal(a);     // 找过了，结论在下面那块里
    /* 🔴 **"结果在下面"必须真的有下面**（tests/site/asked_before.py 第 ② 条抓到的）。
     * 下面那块 `.lane` 只有 `startLane()` 轮询时才会画，而落到这一屏的路不止一条：
     * 从清单点进来会 startLane，**刷新/存下来的地址/分享链接进来不会** ⟹ 页面说
     * "结果在下面"，下面却什么都没有。比原来那句"这里还没有内容"更糟。
     * 这一跳是**免费的**：云端缓存 24 小时内直接回放，不会再花钱去搜。 */
    if (a && LANE.q !== q) setTimeout(() => startLane(q), 0);
    el.innerHTML = `<div class="empty">${
      asked ? `<span class="lane-spin"></span>正在找「${esc(q)}」…`
      : askedDone ? `我们找过这个了。`
      : waiting ? `<span class="lane-spin"></span>正在找…`
      : "这里还没有内容。"}
      ${q && !asked && !askedDone ? `<div class="empty-q">你搜的是「${esc(q)}」</div>` : ""}
      ${askedDone ? `<div class="empty-q">结果在下面。</div>` : ""}
      <div class="empty-acts">
        ${q && !asked && !askedDone ? `<button class="btn-primary" id="want-this">我要这个 →</button>` : ""}
        <button class="linklike" id="reset-all">回到知识地图</button>
      </div>
      ${SEM.q === q && SEM.top.length && SEM.top[0].score >= SUGGEST_FLOOR
        ? `<div class="empty-note">上面几个是最接近的问题。</div>` : ""}</div>`;
    el.querySelector("#reset-all").addEventListener("click", () => {
      document.getElementById("q").value = "";
      go({ q: "", topic: null, node: null });
    });
    bindWantThis(el, q, "empty");
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
    if (resultFocus && !byNode.has(resultFocus)) resultFocus = null;   // 换了搜索词，上一个选中的问题可能已不在
    const shown = resultFocus ? order.filter(([n]) => n === resultFocus) : order;
    el.innerHTML = qpickHtml(order, items.length) + shown.map(([node, list]) => `
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
    bindQpick(el);
    if (resultFocus) {
      const n = byNode.get(resultFocus).length;
      document.getElementById("result-count").textContent = `${n}条 / 共${items.length}条`;
    }
  }
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(DATA.find(it => it.id === c.dataset.id))));
}

/* ══════════ 结果顶部的问题选择条（CY 2026-11-11 16:2x）══════════
 * 他的话：「搜索以后的结果，现在是分问题展示的，这些问题应该在上方列出来供用户选择」。
 *
 * 原来的样子：一次搜索命中好几个问题，就按问题分段**往下堆**——他要知道有哪几个问题，
 * 只能一路往下滚过每一段的全部卡片。分组是有的，**选择入口没有**。
 *
 * 两种动作要分清，这也是这条为什么不进 URL：
 *   · 点这排里的一个问题 ＝ 把同一份结果**收窄**到其中一段（随时按"全部"回去，不是导航）
 *   · 点段标题里的问题名 ＝ 真的**进到那个问题里**（整页换成那一页，走 go()，原来就有）
 * 上限 12 颗：再多就从"选择条"退化成第二份长列表；超出的在下面照样摆得到。 */
const QPICK_MAX = 12;

function qpickHtml(order, total) {
  const chips = order.slice(0, QPICK_MAX).map(([node, list]) => `
    <button class="qpick-chip${resultFocus === node ? " on" : ""}" data-qpick="${esc(node)}">
      <span class="qpick-dot" style="background:${topicColor(list[0].topic)}"></span>${esc(displayNode(node))}
      <span class="qpick-n">${list.length}</span></button>`).join("");
  return `<div class="qpick">
      <div class="qpick-row">
        <button class="qpick-chip qpick-all${resultFocus ? "" : " on"}" data-qpick="">全部<span class="qpick-n">${total}</span></button>
        ${chips}
      </div>
      ${order.length > QPICK_MAX
      ? `<div class="qpick-more">还有 ${order.length - QPICK_MAX} 个问题，在下面</div>` : ""}
    </div>`;
}

function bindQpick(root) {
  root.querySelectorAll("[data-qpick]").forEach(b => b.addEventListener("click", () => {
    const n = b.dataset.qpick || null;
    resultFocus = (n && n !== resultFocus) ? n : null;   // 再点一次同一颗 = 取消
    renderResults();
    if (resultFocus) emit("pick", { picked: "qpick" });
    document.getElementById("results")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }));
}

/** 「我要这个」：记一笔缺口 + 真的让本机去搜（缺口车道，CY 2026-11-10）。
 *  from 只进 note，用来分辨入口（empty = 空态；sure = 确信命中下面那个"都不是？"）。 */
function bindWantThis(root, q, from) {
  const want = root.querySelector("#want-this");
  if (!want || !q) return;
  want.addEventListener("click", () => {
    recordExit("gap_wish", `${q} [from=${from}]`);
    // 文案一句话就够（CY 2026-11-10 15:3x：「页面上文案需要简洁有力，不要长篇大论」）。
    // 下面的进度条自己会说在干什么，这里再解释一遍流程是重复占版面。
    want.outerHTML = `<span class="want-ok"><b>记下了，正在去找。</b></span>`;
    startLane(q);
  });
}

/** 确信区（≥SUGGEST_SURE）里、库里真有内容的那几个问题节点。
 *  只在"按字面一条都没搜到"时才用得上——字面有命中就说明他已经有东西看了。 */
function sureNodeHits() {
  if (!state.q || SEM.q !== state.q || !SEM.top.length) return [];
  const out = [];
  for (const t of SEM.top) {
    if ((t.score || 0) < SUGGEST_SURE) continue;
    const list = DATA.filter(it => it.node === t.name && (!state.topic || it.topic === state.topic));
    if (list.length) out.push({ name: t.name, items: list });
  }
  return out;
}

/** 把确信命中的节点当结果摆出来。版式和正常结果的分节一模一样——
 *  它们**就是**正常结果，只是入口是语义而不是字面。 */
function renderSureHits(el, q, sure) {
  const total = sure.reduce((n, s) => n + s.items.length, 0);
  const cnt = document.getElementById("result-count");
  if (cnt) cnt.textContent = `${total}条`;
  /* 这一行必须有：他搜的词和下面问题的字面不一样，不说一句他会以为我们答非所问。
     只说对他有用的那部分（这是最接近的问题），不解释我们的检索为什么没对上。 */
  /* 这条路也要有选择条（同 renderResults）：确信命中常常一次命中好几个问题，
     不给选择入口他就只能往下滚。只在真有 ≥2 个问题时出。 */
  const order = sure.map(s => [s.name, s.items]);
  if (resultFocus && !order.some(([n]) => n === resultFocus)) resultFocus = null;
  const shown = (resultFocus ? order.filter(([n]) => n === resultFocus) : order)
    .map(([name, items]) => ({ name, items }));
  el.innerHTML = `<div class="sure-lead">「${esc(q)}」——库里最接近的是下面这${sure.length > 1 ? "几个" : "个"}问题：</div>`
    + (order.length > 1 ? qpickHtml(order, total) : "")
    + shown.map(s => `
      <div class="section">
        <div class="section-head">
          <span class="section-dot" style="background:${topicColor(s.items[0].topic)}"></span>
          <button class="section-title" data-drill="${esc(s.name)}" data-topic="${esc(s.items[0].topic)}">${esc(s.name)}</button>
          <span class="section-count">${s.items.length}条</span>
        </div>
        <div class="grid">${sortItems(s.items).map(it => cardHtml(it)).join("")}</div>
      </div>`).join("")
    + `<div class="sure-acts"><button class="linklike" id="want-this">都不是我要的 → 去找「${esc(q)}」</button></div>`;
  el.querySelectorAll("[data-drill]").forEach(b => b.addEventListener("click", () =>
    go({ node: b.dataset.drill, topic: b.dataset.topic })));
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(DATA.find(it => it.id === c.dataset.id))));
  bindWantThis(el, q, "sure");
  bindQpick(el);   // 重新渲染走的还是 renderResults()，它会再次落到这个分支
  if (resultFocus && cnt) {
    const n = (order.find(([name]) => name === resultFocus) || [, []])[1].length;
    cnt.textContent = `${n}条 / 共${total}条`;
  }
}

/* ---------- 「这块我们不收什么」（CY 2026-11-10 16:3x）----------
 * 他的话：「健康家族『任何治疗方案、用药剂量一律拒收』这样的 msg 应该在页面中展示出来。
 * 其他的知识点可能有类似的规则，如果对用户有价值，应该展示出来。」
 *
 * 为什么这条值得占版面（我们刚砍过一轮文案，这是加回来的那一行）：
 * 这个产品的差异化**全在拒收了什么**上。「我们只收讲机制的，不收用药剂量」是一句
 * 用户可以拿去验的承诺——他随便点开一条，发现有人在教他吃什么药，我们就输了。
 * 判准还是那条：删掉这句，用户会做错什么吗？——**会**。他会以为这里能回答"我该吃什么药"。
 *
 * 只在视线收到一个家族里时出现（选了领域，或进了某个问题）。首页混着三类，
 * 摆一条规则等于谁也不指。长的那段收进 `?`。 */
let FAMILIES = {};        // 家族 id → {label, short, long, count}
let DOMAIN_FAMILY = {};   // 块 id → 家族 id（item.domain 是块，不是家族）

function currentFamily() {
  if (state.domain) return DOMAIN_FAMILY[state.domain] || null;
  if (!state.node && !state.topic) return null;   // 首页不显示
  const fams = new Set(filtered().map(i => DOMAIN_FAMILY[i.domain]).filter(Boolean));
  return fams.size === 1 ? [...fams][0] : null;   // 跨家族的主题（如"概念原理"）不显示
}

function renderFamilyRule() {
  const el = document.getElementById("family-rule");
  if (!el) return;
  const f = currentFamily();
  const r = f && FAMILIES[f];
  if (!r || !r.short) { el.innerHTML = ""; return; }
  HINTS.famrule = r.long || "";
  el.innerHTML = esc(r.short) + (r.long ? hintBtn("famrule") : "");
}

function render() {
  renderCrumbs();
  refreshMarkUI();
  renderLaneFloat();   // 导航要当场更新悬浮提示，别等下一次轮询（最多 1.5s 的滞后）
  renderFamilyRule();
  if (typeof renderSuggest === "function") renderSuggest();
  renderMap();
  renderHomeQuestions();
  renderScopeHint();
  renderAnswer();
  refreshAsksUI();
  if (state.asks) { renderAsks(); } else if (state.mine) { renderMine(); } else { renderResults(); }
  /* 进了一个具体问题 ⟹ 品牌栏和主题标签云让路，主栏居中收窄（准则 10）。
     它们是"还没决定看什么"时的工具；已经决定了，留着只是噪音。 */
  document.body.classList.toggle("mine-mode", Boolean(state.mine || state.asks));
  /* decided：**决定了看什么**（搜了词 / 进了问题）⟹ 品牌栏压成一行、地图折起。
     focused 是它的子集，只在"有主题页且没有搜索词"时额外生效（地图整块让路、
     卡片不重复列要点）——先搜词再点节点那条路径走的是 decided，不是 focused。 */
  document.body.classList.toggle("decided", decided() && !state.mine && !state.asks);
  document.body.classList.toggle("focused", Boolean(currentPage()) && !state.q);
  // 地址栏跟着这一屏走（弹窗自己会再调一次带 ?v= 的）
  syncUrl(document.getElementById("modal-overlay")?.classList.contains("open") ? MODAL_ID : null);
  bindShareButtons();
  /* ✕ 的显隐跟着每一次渲染走。放这儿而不是只放在 input 事件里：清空 `#q` 的地方
     全站有十几处（面包屑的 ×、点领域、点节点、分享回来、补搜改写搜索词…），
     每处各记一遍必然漏——而它们没有一个不走 render()。 */
  if (typeof syncHasQ === "function") syncHasQ();
}

/* ══════════ 回首页：一个动作，三个入口（CY 2026-11-11 22:1x）══════════
 * 他的话：「当我们进行一项搜索后，想退到首页，现在只能通过把搜索栏里的文字一个一个删掉，
 * 非常不直觉，而且浪费算力。」
 *
 * **他是对的，而且比"不直觉"更糟：那时候页面上一个能回去的键都没有。**
 *   · 站名：原来的条件是 `body.focused`，而 focused = `currentPage() && !state.q`
 *     ⟹ **只要有搜索词就恒假**，正好是他抱怨的那一屏。CSS 那边偏偏给了 cursor:pointer
 *     （只在 ≥900 宽），于是"看着能点、点了没反应"——比没有这个入口更伤。
 *   · 面包屑的「全部」：`go({topic:null,node:null})` **不清 q**，还留在搜索结果里。
 *   · 面包屑的 ✕：只清 q、保留当前问题，而且 15px 见方，手机上点不中。
 * 三条路没有一条通到首页 ⟹ 他只能去按退格键。
 *
 * 现在：输入框里的 ✕ / 站名 / Esc 三个入口全走 goHome()。
 * **domain（领域）不清**：选领域是一次明确的范围选择，不是"这次搜索"的一部分；
 * 清掉它会把正在逛财经的人踢回全站。领域药丸一直在页面上，他要换随时能换。 */
function atHome() {
  return !state.q && !state.node && !state.topic && !state.mine && !state.asks;
}

function goHome() {
  const box = document.getElementById("q");
  if (box) {
    box.value = "";
    /* 手机上收起键盘：这个动作的目的是**看首页**，而首页的价值（地图、真实问题）
       正好在键盘遮住的那半屏里。宽屏不 blur——那里没有键盘，留着焦点他能直接重打。 */
    if (window.innerWidth < 900) box.blur();
  }
  cancelPendingSearch();          // 别让已经作废的那次输入在 400ms 后又发一次请求
  go({ q: "", node: null, topic: null, mine: false, asks: false });
  syncHasQ();
}

document.querySelector(".brand-panel h1")?.addEventListener("click", () => {
  if (!atHome()) goHome();
});
document.getElementById("q-clear")?.addEventListener("click", goHome);

/* 输入框里有没有字——决定 ✕ 出不出。挂在 body 上而不是直接改按钮 display，
   是为了让"有搜索词"这件事在 CSS 里可寻址（以后别处要用同一个条件不必再写一遍 JS）。
   ⚠️ 读的是**输入框的实际内容**，不是 state.q：两者在打字的那 160ms 里不同步，
   而 ✕ 要跟着他眼睛看到的字走，不是跟着我们的状态走。 */
function syncHasQ() {
  const box = document.getElementById("q");
  document.body.classList.toggle("has-q", Boolean(box && box.value.length));
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
  host.innerHTML = `<div class="hq-label">也可以直接从这几个问题进去</div>
    <ul class="hq-list">${top.map(([n, c]) =>
      `<li><button class="hq" data-node="${esc(n)}"><span class="hq-q">${esc(displayNode(n))}</span>
        <span class="hq-n">${c} 条</span></button></li>`).join("")}</ul>`;
  host.querySelectorAll(".hq").forEach(b =>
    b.addEventListener("click", () => go({ node: b.dataset.node, q: "", topic: null })));
}

/* 节点名入库时带「07.」这类编号，那是我们的内部排序手段，不该出现在用户眼前 */
function displayNode(n) { return String(n).replace(/^\d+\./, ""); }

/* ══════════ 「从这里看」：按知识点跳转，不做拖动条（CY 2026-11-11 16:4x）══════════
 * 他的话：「我觉得我们就不应该做这个进度条，而是用这个字幕，甚至是主题。就是对每一个
 * 视频，我们按照时间轴列出了几个重要的节点或者是主题，然后用户一点，我们就会跳到那个
 * 相应的主题上…B站的可以先做嘛，因为它本来就有字幕」。
 *
 * 数据来自 pipeline/chapters.py（字幕+时间戳 → LM 切 3-6 个知识点段，带几何/时间校验）。
 * 只有 B站 有（嵌入播放器认 `t=` 起播秒，点一条＝换 iframe src 重载到那一秒）；
 * 抖音/视频号这里不出——给了也点不动，比没有更误导。 */
function chaptersBlockHtml(it) {
  if (it.platform !== "bilibili" || !it.chapters || !it.chapters.length) return "";
  const rows = it.chapters.map((c, i) => `
    <button class="chp-row" data-chp-t="${c.t}" data-chp-i="${i}">
      <span class="chp-t">${Math.floor(c.t / 60)}:${String(c.t % 60).padStart(2, "0")}</span>
      <span class="chp-label">${esc(c.label)}</span>
    </button>`).join("");
  return `<div class="chapters">
      <div class="chp-head">从这里看</div>
      <div class="chp-list">${rows}</div>
    </div>`;
}

function bindChapters(root, it) {
  root.querySelectorAll("[data-chp-t]").forEach(b => b.addEventListener("click", () => {
    const t = +b.dataset.chpT;
    const frame = document.getElementById("modal-iframe");
    if (!frame) return;   // 弹窗已经不是这条了（理论上不会发生，防御一下）
    frame.src = EMBED_URL.bilibili(it.video_id, t);
    root.querySelectorAll(".chp-row").forEach(r => r.classList.toggle("on", r === b));
    emit("chapter_jump", { item: it.id, t });
  }));
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
  /* ══════ 弹窗瘦身（CY 2026-11-10 批体验审查 §3；他的原话是「满屏的压力」）══════
   * 量到的：播放器下方 **736 字**、scrollHeight 1713px，其中 **5 段在解释我们自己**：
   *   ① 播放器是抖音官方的，它自带的按钮我们改不掉…
   *   ② 我们的概括，不是原话…
   *   ③ 这几条都是知识关系，不是"看了这个的人还看了"…
   *   ④ 没有「下一条」。看完回地图，或者直接关掉。
   *   ⑤ 点一下我们才知道做得对不对。这是我们唯一看的指标…
   * 五段逐个过准则 13 那把尺子（删掉它用户会做错什么吗）——**五个都是"不会"**。
   * ⚠️ 这不和"诚实是功能"冲突：诚实要的是**那句话存在且查得到**，不是糊在他脸上。
   * ①③ 收进 `?`（下面的 HINTS），②④⑤ 直接删：
   *   · ② 「我们的概括」这件事由区块标题「这条视频讲了什么」+ 下面那条原视频链接
   *     已经表达完了；
   *   · ④ 没有「下一条」最响的说法是**真的没有那颗按钮**，页脚还留着那句承诺；
   *   · ⑤ 两颗按钮自己就是问句，不需要再解释我们为什么问。点完之后仍然会告诉他
   *     刚刚记了什么（exitSaid 里的隐私说明留着——那是**事后**的交代，不是**事前**的自述）。
   */
  HINTS.kp = "我们读完这条内容自己概括的，不是原话。想看讲述过程，点下面的原视频。";
  const hasPoints = !!(it.key_points && it.key_points.length);
  /* 「入选依据：…」是**判定器的工作记录**，用户不需要它来决定看不看这条
     （体验审查 §3：占版面但不是解释，一样收进 `?`）。它仍然查得到。 */
  HINTS.why = it.reason ? `入选依据：${it.reason}` : "";
  const points = (it.key_points && it.key_points.length)
    ? `<div class="kp"><div class="kp-head">这条视频讲了什么${hintBtn("kp")}</div>
         <ul>${it.key_points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
       </div>`
    : `<div class="kp"><div class="kp-note">这条还没出要点（判定流水线还在补），先看摘要或直接看原视频。</div></div>`;
  const chaptersHtml = chaptersBlockHtml(it);
  const body = embedFn
    ? `<iframe class="modal-embed" id="modal-iframe" src="${embedFn(it.video_id)}" allow="autoplay; fullscreen" allowfullscreen scrolling="no" frameborder="0"></iframe>`
    : `<div class="modal-cover-wrap">
         ${it.cover_url ? `<img class="modal-cover" src="${esc(modalCover(it.cover_url))}" alt=""
              decoding="async" referrerpolicy="no-referrer"
              onerror="this.closest('.modal-cover-wrap')?.remove()||this.remove()">` : ""}
         <div><a class="modal-openlink" href="${it.link}" target="_blank" rel="noopener">在${PLATFORM_CN[it.platform] || it.platform}中打开观看</a></div>
       </div>`;
  m.innerHTML = `
    <div class="modal-head">
      <h2>${esc(it.title)}</h2>
      ${shareBtnHtml(it.id, "分享")}
      <button class="modal-close" aria-label="关闭">&times;</button>
    </div>
    <div class="modal-body">
      ${body}
      ${chaptersHtml}
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
        ${it.reason ? hintBtn("why") : ""}
      </div>
      <!-- 有要点时不再出 summary：两者讲的是同一件事（实测重复），要点扫得更快。
           没有要点的那几条才退回摘要。 -->
      ${hasPoints ? "" : `<div class="modal-summary">${esc(it.summary || "")}</div>`}
      ${points}
      <a class="src" href="${it.link}" target="_blank" rel="noopener">在原平台看原作者的完整内容</a>
      ${edgeBlockHtml(it)}
      <!-- 所有视频站在这个位置放"相关推荐"，我们什么都不放——**没有那颗按钮本身**
           就是这句话最响的说法。原来这里写着「没有「下一条」。看完回地图，或者直接
           关掉。」，页脚那句承诺已经把它说过一遍了（体验审查 §3）。 -->
      ${exitBlockHtml()}
    </div>`;
  document.getElementById("modal-overlay").classList.add("open");
  /* 打开一条视频 ⟹ 地址栏变成这条视频自己的地址（?v=…）。发给朋友，他落地就在这条上，
     不用再搜一遍。关掉时再退回这一页的地址。 */
  MODAL_ID = it.id || null;
  syncUrl(MODAL_ID);
  bindShareButtons(m);
  bindExitButtons(m, it.id);
  bindChapters(m, it);
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
  /* 每种关系最多给一条——和答案页的 tailHtml 同一条规矩，这里原来漏了。
     实测本条内容的 4 条边里**有 3 条都是「它是这个更大问题的一块」**：那等于把这一块的
     意义抹掉（它要回答"从这里还能往哪几个方向走"，不是"列四条边"），还白占 60 字版面。
     顺序：先给向上的大问题，再给前置、易混、实例。 */
  const EDGE_ORDER = ["answers_part_of", "prereq", "confusable_with", "instance_of"];
  const usable = all.filter(e => EDGE_CN[e.type]);
  const shown = EDGE_ORDER.map(t => usable.find(e => e.type === t)).filter(Boolean);
  const rows = shown.map(e => {
    const cn = EDGE_CN[e.type];
    /* 「因为：…」**默认折起**（体验审查 §3）：3 条边就是 3 段长句，而用户在这一步要做的
       决定只是"要不要顺着走"——关系名 + 问题名已经够他决定了。
       理由没有丢，整块的 `?` 里逐条列着（也是被删掉的那句 edge-note 的新家）。 */
    return `<div class="edge-row"><span class="edge-mark">${cn.mark}</span>
      <div><div class="edge-k">${cn.k}</div>
        <button class="edge-nm" data-edge="${esc(e.type)}:${esc(it.category || it.node)}"
                data-edge-dst="${esc(e.dst)}">${esc(displayNode(e.dst))}</button>
      </div></div>`;
  }).join("");
  if (!rows) return "";
  HINTS.edges = '这几条是知识关系（它是谁的一块、要先懂什么、常被和谁搞混），'
    + '不是"看了这个的人还看了"——所以每条都说得出为什么：\n\n'
    + shown.map(e => `${EDGE_CN[e.type].mark} ${displayNode(e.dst)}\n  因为：${e.why || "—"}`).join("\n\n");
  return `<div class="edge-box">
    <div class="edge-head">这个问题在地图上的位置${hintBtn("edges")}</div>
    <div class="edge-self">${esc(displayNode(it.node || it.category || ""))}</div>
    ${rows}
    <button class="edge-nf" id="modal-notfound">这不是我想找的</button>
  </div>`;
}
let MODAL_ID = null;      // 当前打开的是哪条视频（地址栏的 ?v= 跟着它走）
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.getElementById("modal-content").innerHTML = "";
  MODAL_ID = null;
  REL_OPEN = false;   // 更新记录也走这个关闭口，关掉要把 ?rel=1 从地址里撤掉
  syncUrl(null);
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

function recordExit(kind, note, itemId) {
  const extra = {};
  if (note) extra.note = note;
  if (itemId) extra.item = itemId;   // 哪条视频下面按的（v3 把按钮搬进详情页后才有这个）
  emit(kind, Object.keys(extra).length ? extra : undefined);
}

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
// floatDismissedFor：用户关掉过的那个「阶段」的 key（见 laneFloatKey）。只压住那一阶段的
// 提示——建设中那条被关掉，不代表"建好了"那条也不该弹，两件事用户可能都想知道。
let LANE = { q: "", timer: null, t0: 0, state: "", data: null, floatDismissedFor: "" };

/* ══════════ 补搜的页内提示：不用守在这一页（CY 2026-11-10 16:5x）══════════
 * 「只要他用户没有把这个页面关掉，他可以继续浏览…等到我们这个搞定之后呢，就会有个
 * 在这页面里面的弹出提示，这样其实也不涉及 privacy」。
 *
 * 这是**同一个页面里的浮层**，不是系统通知/推送——所以真的不涉及隐私：没有权限弹窗，
 * 没有离开网站也能收到的东西，关掉这个标签页提示就随标签页一起没了，和"存地址晚点回来"
 * （?lane=1）是两件独立的事，这个管的是"没关页面、但逛去别处了"那段时间。
 *
 * 🔴 **这顺手修了一个潜在 bug**：原来 `renderLane()` 每次轮询都无条件把进度框塞进
 * `#results`——用户一旦导航到别的问题/搜索，`#results` 的内容已经被换掉，下一次轮询
 * 会把进度框**接在当前这个不相关的页面底下**，而不是消失或挪地方。现在内联框只在
 * `state.q === LANE.q`（用户仍在看这个搜索）时才渲染；离开了就只走下面的悬浮提示，
 * 不碰 `#results`。 */
function laneFloatKey() {
  const terminal = ["done", "skipped", "failed"].includes(LANE.state) || (LANE.data || {}).budget_exceeded;
  return `${LANE.q}:${terminal ? "done" : "building"}`;
}

function renderLaneFloat() {
  const host = document.getElementById("lane-float");
  if (!host) return;
  if (!LANE.q || state.q === LANE.q || LANE.floatDismissedFor === laneFloatKey()) {
    host.innerHTML = "";
    return;
  }
  const d = LANE.data || {};
  const terminal = ["done", "skipped", "failed"].includes(LANE.state) || d.budget_exceeded;
  const items = (Array.isArray(d.results) ? d.results : []).filter(laneUsable);
  let body;
  if (!terminal) {
    body = `<span class="lane-spin"></span>正在建「${esc(LANE.q)}」…`;
  } else if (d.budget_exceeded) {
    body = `今天的补内容额度用完了`;
  } else if (LANE.state === "failed") {
    body = `没找成「${esc(LANE.q)}」——是我们这边的问题`;
  } else if (LANE.state === "skipped" && !items.length) {
    body = `「${esc(LANE.q)}」不在我们收的范围里`;
  } else {
    body = items.length ? `「${esc(LANE.q)}」建好了，${items.length} 条，点一下去看`
                        : `「${esc(LANE.q)}」没有一条够格`;
  }
  host.innerHTML = `<div class="lane-toast${terminal ? " done" : ""}">
      <button class="lf-body" id="lf-open">${body}</button>
      <button class="lf-close" id="lf-close" aria-label="关闭">&times;</button>
    </div>`;
  host.querySelector("#lf-open").addEventListener("click", () => {
    const box = document.getElementById("q");
    if (box) box.value = LANE.q;
    go({ q: LANE.q, node: null, topic: null });
  });
  host.querySelector("#lf-close").addEventListener("click", () => {
    LANE.floatDismissedFor = laneFloatKey();
    renderLaneFloat();
  });
}

function startLane(q) {
  if (!COLLECT_URL || !q) return;
  if (LANE.timer) clearInterval(LANE.timer);
  LANE = { q, timer: null, t0: Date.now(), state: "new", data: null, floatDismissedFor: "" };
  recordAsk(q);                                        // 落到这台设备上，刷新也还在
  if (state.q === q) renderLane({ state: "new", results: [] });
  const ask = () => {
    fetch(`${COLLECT_URL}/rtsearch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    }).then(r => r.json()).then(d => {
      updateAsk(q, d);                                 // 不管用户还在不在看，清单都要记对
      if (LANE.q !== q) return;                       // 用户已经换了搜索词，丢弃旧响应
      LANE.state = d.state || "";
      LANE.data = d;
      if (state.q === q) renderLane(d);                // 仍在看这个搜索：和原来一样内联
      renderLaneFloat();                                // 任何视图都刷新悬浮提示
      const over = Date.now() - LANE.t0 > LANE_MAX_MS;
      // `done` 但还有条目没判完（note 里有 pending）⟹ **别停**：后台核完会补推一次
      // （pipeline/gap_lane.py 的"收尾补推"），停了就永远停在 0 条。超时闸照旧兜底。
      const stillWorking = d.state === "done" && !(d.results || []).filter(laneUsable).length
        && askPending(d);
      if (over
          || (!stillWorking
              && (["done", "skipped", "failed"].includes(d.state) || d.budget_exceeded))) {
        clearInterval(LANE.timer); LANE.timer = null;
      }
    }).catch(() => { /* 一次网络抖动不该把整条车道掐掉，下一轮再问 */ });
  };
  ask();
  LANE.timer = setInterval(ask, LANE_POLL_MS);
}

/* ══════════ 「我要补的」：请求本身存在这台设备上（CY 2026-11-11 04:1x）══════════
 * 他的话：「我刚刚搜了24小时血压仪有用吗？然后你说给我补，那在左边有一个跳转的入口，
 * 但我刷新一下这现在入口又没有了。按道理如果用同一个 Chrome 的 profile，如果没有去清
 * 我的 cache，这个跳转入口应该都在才对，直到我把它给删掉。否则它就应该在我左边或者
 * 某个地方，被我管理起来，**这是核心的价值啊**」。
 *
 * 他说得对，而且病根很直白：`LANE` 从头到尾只是一个 **JS 变量**（`let LANE = {...}`），
 * 刷新就没了。这不是"提示消失"那么轻——**用户让我们去找一件东西，这件事本身不见了**。
 * 补内容要几分钟，几分钟里他刷新一次、或从别的标签页回来，这条请求就查无此人。
 *
 * ⟹ 请求和收藏同级：**存在这台设备的 localStorage 里，由用户自己删**（同 MARKS 的
 * 三条承诺：只在本机、清浏览器数据会一起清掉、不拿它做任何推荐）。
 *
 * 🔑 **为什么只自动续"刚才还在跑的那些"**：`/rtsearch` 的云端缓存只活 24 小时。
 * 对一条缓存已过期的问题再 POST 一次，等于**重新发起一次真花钱的补搜**。
 * 所以规则是：**自动轮询只给年龄 < `ASK_RESUME_MS` 且还没跑完的**；
 * 已跑完的、或太老的，只显示存下来的状态，**用户点进去才重新发起**
 * ——那时它和他当初点「我要这个」是同一个动作，再花一次钱不是意外。
 */
const ASK_KEY = "xing.asks.v1";
const ASK_RESUME_MS = 30 * 60 * 1000;   // 进站自动续的年龄上限（超过就只显示，不重发）
const ASK_MAX = 50;
let ASKS = [];              // 最近的在前
let ASK_WRITABLE = true;    // 无痕模式/配额满时 localStorage 会抛，要诚实告诉用户

function loadAsks() {
  try {
    const raw = localStorage.getItem(ASK_KEY);
    if (raw) ASKS = JSON.parse(raw);
  } catch (e) { ASK_WRITABLE = false; }
  if (!Array.isArray(ASKS)) ASKS = [];
}
function saveAsks() {
  try { localStorage.setItem(ASK_KEY, JSON.stringify(ASKS.slice(0, ASK_MAX))); }
  catch (e) { ASK_WRITABLE = false; }
}
/** 这一问**还有几条没有结论**（到点交班的 + 判官没跑成的）。
 *  后台把它写在 note 里（见 pipeline/gap_lane.py 的 `pending`）。
 *  🔴 为什么要它：原来只要后台回 `done`，页面就敢说「一条都没过判定」——而那一跑里
 *  常常有 1–5 条**压根还没判过**（240 秒等待上限到了，交给后台继续）。
 *  CY 2026-11-11 22:5x 截图里那三条就是这样：两条写着"跑完了，没有一条够格"，
 *  其中一条的库里此刻正躺着一条已经核好的内容。说"没有一条够格"是**假话**。 */
function askPending(a) {
  const m = /还有\s*(\d+)\s*条还没有结论/.exec((a && a.note) || "");
  return m ? +m[1] : 0;
}
function askTerminal(a) {
  if (a.state === "done" && !a.n && askPending(a)) return false;   // 还有没判完的，不算收尾
  return ["done", "skipped", "failed"].includes(a.state) || a.budget_exceeded;
}
/** 这一问我们查过吗？（用于：别再对一个已经问过的问题重新推销「我要这个」） */
function findAsk(q) { return ASKS.find(a => a.q === q) || null; }
function askCount() { return ASKS.length; }
function asksBuilding() { return ASKS.filter(a => !askTerminal(a)).length; }

function recordAsk(q) {
  const i = ASKS.findIndex(a => a.q === q);
  const prev = i >= 0 ? ASKS[i] : null;
  if (i >= 0) ASKS.splice(i, 1);
  // 重新发起同一个问题：**保留第一次提出的时间**（"我什么时候让你们找的"是用户的记忆锚点），
  // 但状态清回进行中——否则页面会一边转圈一边显示上一次的"建好了"。
  ASKS.unshift({ q, at: prev ? prev.at : Date.now(), touched: Date.now(),
                 state: "new", n: 0, note: "" });
  saveAsks(); refreshAsksUI();
  if (state.asks) renderAsks();
}
function updateAsk(q, d) {
  const a = ASKS.find(x => x.q === q);
  if (!a) return;
  a.state = d.state || a.state;
  a.budget_exceeded = !!d.budget_exceeded;
  a.n = (Array.isArray(d.results) ? d.results : []).filter(laneUsable).length;
  a.note = (d.note || "").slice(0, 120);
  a.touched = Date.now();
  saveAsks(); refreshAsksUI();
  if (state.asks) renderAsks();
}
function removeAsk(q) {
  ASKS = ASKS.filter(a => a.q !== q);
  saveAsks(); refreshAsksUI();
  if (state.asks) renderAsks();
}

/** 一条请求现在该怎么跟用户说。**不合并"还没跑完"和"跑完了但没有"**——
 *  那两件事在用户那里完全不同（一个值得等，一个不值得）。 */
function askStatusText(a) {
  if (a.budget_exceeded) return "今天的补内容额度用完了";
  if (a.state === "failed") return "没找成——是我们这边的问题";
  if (a.state === "skipped") return a.n ? `库里已经有 ${a.n} 条` : "不在我们收的范围里";
  if (a.state === "done" && !a.n && askPending(a)) return `还在核最后 ${askPending(a)} 条`;
  if (a.state === "done") return a.n ? `补好了，${a.n} 条` : "跑完了，没有一条够格";
  // 非终态：区分"正在跑"和"我们没跟上"——后者不该显示成一个永远转的圈
  if ((Date.now() - a.touched) > ASK_RESUME_MS) return "还没跟完，点一下接着看";
  const pr = askProgress(a);
  return pr ? `正在核验 ${pr.done}/${pr.total} 条` : "正在补…";
}

/* ══════════ 一条请求现在是什么颜色（CY 2026-11-11 16:2x）══════════
 * 他的话：「上面说我要补的，这个其实在左边栏会展示，但是你没有展示任何的状态，
 * 就比如说它是一个黄色的，或者有进度条。那完成的时候是绿色的，我觉得这个还是要有的」。
 *
 * 四档，但**不是四种颜色**——全站语义色只有三类（可点/肯定/提醒），
 * 要加第四类之前得说清它和这三类的区别，这里说不清，所以失败那档用**形状**区分（方块）：
 *   building 黄点 + 呼吸（在动的）· done 绿点（补好了，有货）
 *   · none 灰点（跑完了但没有一条够格 / 不在收的范围——结束了，但没东西看）
 *   · fail 黄方块（失败或额度用完：要他知道，但不是"错误"级别）
 * 颜色只在这一个函数里判，渲染处不再判第二遍。 */
function askPhase(a) {
  if (a.budget_exceeded || a.state === "failed") return "fail";
  if (!askTerminal(a)) return "building";           // 含"后台还在核最后几条"
  if (a.state === "skipped" || a.state === "done") return a.n ? "done" : "none";
  return "building";
}

/** 进度条**只在后台真给了分母时才画**（`note` 形如「已核完 3/8｜…」，
 *  见 pipeline/gap_lane.py 那条 progress）。拿不到分母就只给一句"正在补…"——
 *  假进度条（按时间瞎走的那种）比没有进度条更糟：它会在卡住的时候继续骗人。 */
function askProgress(a) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(a.note || "");
  if (!m) return null;
  const done = +m[1], total = +m[2];
  if (!total || done > total) return null;
  return { done, total, pct: Math.max(3, Math.round(done / total * 100)) };
}

function refreshAsksUI() {
  const el = document.getElementById("asks-entry");
  if (!el) return;
  const n = askCount();
  const building = asksBuilding();
  /* 入口上那颗点代表**整份清单现在的状态**：有在补的就黄（而且在动），
     没有在补的就看有没有补到货（绿）还是全都空手而归（灰）。 */
  const ph = building ? "building" : (ASKS.some(a => askPhase(a) === "done") ? "done" : "none");
  el.innerHTML = n
    ? `<button class="mine-btn" id="asks-open"><span class="ask-dot ask-${ph}"></span>
         我要补的 <span class="mine-n">${building ? `${building} 个在补 · 共 ${n}` : n}</span></button>`
    : "";
  const btn = document.getElementById("asks-open");
  if (btn) btn.addEventListener("click", () => go({ asks: true, mine: false, q: "", node: null, topic: null }));
}

function renderAsks() {
  const el = document.getElementById("results");
  const bar = document.querySelector(".toolbar");
  if (bar) bar.hidden = true;
  if (!el) return;
  const head = `<div class="mine-head"><b>我要补的</b>
      <button class="linklike" id="asks-back">回首页</button></div>`;
  const note = `<div class="mine-note">
      这份清单只存在<b>这台设备的浏览器</b>里：我们的服务器上没有它，
      所以也<b>不会</b>拿它给你做任何推荐。<br>
      清掉浏览器数据（或换一台设备、换一个浏览器）它会一起没有。${
        ASK_WRITABLE ? "" : "<br><b>这个浏览器不让我们存东西</b>（无痕模式？），关掉页面就会丢。"}
    </div>`;
  if (!ASKS.length) {
    el.innerHTML = head + `<div class="empty">还没有让我们补过内容。
      <div class="empty-note">搜一个我们还没收的问题，页面上会有一颗「我要这个」。</div></div>` + note;
    document.getElementById("asks-back")?.addEventListener("click", () => go({ asks: false }));
    return;
  }
  const rows = ASKS.map(a => {
    const done = askTerminal(a);
    const ph = askPhase(a);
    const pr = ph === "building" ? askProgress(a) : null;
    return `<div class="ask-row${done ? " done" : ""}">
      <button class="ask-go" data-askgo="${esc(a.q)}">
        <span class="ask-q"><span class="ask-dot ask-${ph}"></span>${esc(a.q)}</span>
        <span class="ask-st">${esc(askStatusText(a))}</span>
        ${pr ? `<span class="ask-bar" role="progressbar" aria-valuenow="${pr.done}"
          aria-valuemin="0" aria-valuemax="${pr.total}"><i style="width:${pr.pct}%"></i></span>` : ""}
      </button>
      <button class="ask-del" data-askdel="${esc(a.q)}" aria-label="删掉这条"
        title="从这台设备上删掉">&times;</button>
    </div>`;
  }).join("");
  el.innerHTML = head + `<div class="ask-list">${rows}</div>` + note;
  document.getElementById("asks-back")?.addEventListener("click", () => go({ asks: false }));
  el.querySelectorAll("[data-askdel]").forEach(b =>
    b.addEventListener("click", () => removeAsk(b.dataset.askdel)));
  el.querySelectorAll("[data-askgo]").forEach(b =>
    b.addEventListener("click", () => {
      const q = b.dataset.askgo;
      const box = document.getElementById("q");
      if (box) box.value = q;
      go({ asks: false, q, node: null, topic: null });
      // 点进去才重新发起：缓存没过期就是免费读一次，过期了就等于他重按一次「我要这个」
      startLane(q);
    }));
}

/** 进站时把"刚才还在跑"的那几条接回来。**这是 CY 报的那个 bug 的正解**：
 *  刷新之后入口还在，而且还在动。太老的不自动重发（见 ASK_RESUME_MS 的注释）。 */
function resumeAsks() {
  if (!COLLECT_URL) return;
  const live = ASKS.filter(a => !askTerminal(a) && (Date.now() - a.touched) < ASK_RESUME_MS);
  if (!live.length) return;
  // 只让**最近那一条**驱动悬浮提示和内联进度框（同一时刻弹两个提示是噪音）；
  // 其余的只把状态拉新，好让清单里的字是真的。
  startLane(live[0].q);
  live.slice(1, 4).forEach(a => {
    fetch(`${COLLECT_URL}/rtsearch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: a.q }),
    }).then(r => r.json()).then(d => updateAsk(a.q, d)).catch(() => { /* 下次进站再说 */ });
  });
}


/* 补搜结果的**形状闸**。
 * 云端那份缓存活 24 小时 —— 比写它的那版代码活得久。CY 2026-11-10 15:1x 实测：
 * 搜「如何控制血压」点「我要这个」**秒出 6 张卡**（＝缓存命中，没真去搜），
 * 但「都是空图片，不能点击」。真因是那 6 条是当天 08:0x 旧版（"快道先给未核验线索"
 * 那一版，08:22 已被推翻）写进缓存的**旧形状**：封面字段叫 `cover` 不叫 `cover_url`，
 * 而且整条**没有 `id`** ⟹ cardHtml 认不出封面（退化成灰底平台名占位块）、
 * `data-id="undefined"` ⟹ 点击时 `openModal(undefined)` 第一行就 return。
 * 一张死卡，而上面那句还在说"下面这些都过了质量判定"。
 *
 * 判据做成机械的：**渲染不出完整卡片的条目，一条都不渲染**。
 * 旧缓存、将来再改字段、上游少给一列，都只会让它少显示、不会显示成死卡。
 * 并且"全被挡下"要**说出来**（走下面那个"我们这边的问题"分支），不能静默变成"没有内容"
 * ——那会和"真的没有"同形。*/
const LANE_REQUIRED = ["id", "platform", "title", "link"];
function laneUsable(it) {
  return !!it && LANE_REQUIRED.every(k => typeof it[k] === "string" && it[k].length > 0);
}

function renderLane(d) {
  const host = document.getElementById("results");
  if (!host) return;
  let box = document.getElementById("lane");
  if (!box) { box = document.createElement("div"); box.id = "lane"; host.appendChild(box); }
  const raw = Array.isArray(d.results) ? d.results : [];
  const items = raw.filter(laneUsable);
  const secs = Math.round((Date.now() - LANE.t0) / 1000);
  const step = (d.note || "").split("｜").slice(-1)[0] || "";

  // 有结果、但一条都渲染不出来 ⟹ 是我们这边的问题（旧缓存/字段漂移），照实说。
  // 不能掉进下面的分支——那些会说成"这个我们不打算收"或"没有一条过得了判定"，
  // 两句都把我们的 bug 说成了内容的问题。
  if (raw.length && !items.length) {
    box.innerHTML = `<div class="lane"><div class="lane-head">我们这边出了点问题</div>
      <div class="lane-sub">结果我们自己读不出来了。刷新再点一次。</div></div>`;
    return;
  }

  if (d.budget_exceeded) {
    box.innerHTML = `<div class="lane"><div class="lane-head">今天的补内容额度用完了</div>
      <div class="lane-sub">找一次要花钱，每天有硬上限。明天继续，你这句话已记下。</div></div>`;
    return;
  }
  // 库里本来就有（环 0 命中）。
  // ⚠️ 2026-11-10 第三方评审实测：这里原写"下面这些都已经核对过事实"——但环0给的是**存量
  // 库内容**，不是刚核完的新内容；第二道事实复核只覆盖了库里约一半（见 index.html 页脚）。
  // 口径要和"慢道新建内容"（下面 building/done 分支，那里确实逐条新核过）分开说清。
  if (d.state === "skipped" && items.length) {
    // 解释句收进 `?`（版面上只留结论）：已知的事实错误会被挡掉，但不是每条都逐句复核过。
    HINTS.laneok = "这些是库里已有的内容，都过了质量判定。已知的事实错误会被挡住，"
      + "但库里只有一半多做过第二道逐句事实复核。";
    /* 标题只说结论。原来写的是"其实我们有——是我们的搜索没搭上你的说法"：
       那半句在跟用户解释我们的检索怎么回事，对他没有用（CY 2026-11-10 17:0x 文案铁律）。
       而且他看到这句之前，页面刚说过"这里还没有内容"——两句话自相矛盾，
       根因已在 renderResults 里修掉（确信命中直接给内容，不再先说没有）。 */
    box.innerHTML = `<div class="lane ok"><div class="lane-head">这个我们有</div>
      <div class="lane-sub">${esc(d.note || "")}。都过了质量判定${hintBtn("laneok")}</div>
      <div class="lane-cards grid">${items.map(laneCardHtml).join("")}</div></div>`;
    bindLaneCards(box);
    return;
  }
  if (d.state === "skipped") {
    box.innerHTML = `<div class="lane"><div class="lane-head">这个我们不打算收</div>
      <div class="lane-sub">${esc(d.note || "它不在「醒」要做的范围里")}。</div></div>`;
    return;
  }
  if (d.state === "failed") {
    box.innerHTML = `<div class="lane"><div class="lane-head">没找成——是我们这边的问题</div>
      <div class="lane-sub">去平台搜那一跳挂了，不是没有内容。已记下，会重试。</div></div>`;
    return;
  }

  /* 建设中 / 建完。⚠️ 这里的每一条**都是已核验的**（CY 2026-11-10 08:22 推翻了
     "先给未核验线索"那一版）：变的是"现在几条 / 最后几条"，不是"核没核"。
     所以它们用的是和平时一样的卡片，没有琥珀框、没有"还没核过"这类话术。 */
  /* 文案一律短句（CY 2026-11-10 15:3x：「页面上文案需要简洁有力，不要长篇大论」）。
     判准：**这一句他拿来干什么**——进度要一眼看出"还在动、到哪了"，结果要一眼看出
     "有没有、几条"。流程怎么跑、为什么慢，是解释，不占版面。 */
  const building = d.state !== "done";
  /* 🔴 **还没判完就别宣判**（2026-11-11 23:2x）。用户的等待有 240 秒硬上限，到点没判完的
     条目交给后台继续——可那时页面照样打出"一条都没过判定 / 找到了内容，但没有一条够格"。
     CY 那三条里，深圳那一问 8 条中有 5 条**根本没判过**就被这句话判了死刑。
     后台把剩余条数写在 note 里，这里据它说实话。 */
  const pending = askPending(d);
  const head = building
    ? `<div class="lane-head"><span class="lane-spin"></span>正在建这个知识点</div>
       <div class="lane-sub">${items.length ? `已核完 <b>${items.length}</b> 条。` : `还在核第一条。`}
          ${step ? `${esc(step)}（${secs} 秒）` : ""}</div>`
    : (!items.length && pending)
      ? `<div class="lane-head"><span class="lane-spin"></span>还在核最后 ${pending} 条</div>
         <div class="lane-sub">前面几条都没够格。剩下的几分钟内会出现在这里。</div>`
      : `<div class="lane-head">${items.length ? "建好了" : "一条都没过判定"}</div>
         <div class="lane-sub">${items.length
            ? `${items.length} 条，已核对事实，已进地图。${pending ? `还有 ${pending} 条在核。` : ""}`
            : `找到了内容，但没有一条够格。不凑数。`}</div>`;
  /* 「晚点回来」的入口（CY 2026-11-10 15:2x：「等待页也应该有让用户晚点回来的入口」）。
   * 建一个知识点是分钟级的，**不该要求人守在这一页**——而在此之前关掉页面就等于白等：
   * 地址栏没有这个问题的任何痕迹，回来只能从头搜一遍、还不知道上次跑到哪了。
   * 现在给的是**这一问的专属地址**（带 lane=1）：存下来、几分钟后打开，它会自己接着
   * 显示进度或结果。刻意不做"留邮箱通知你"——这个产品没有账户、不建档案，
   * 一个地址是我们能给的、最轻也最诚实的东西。*/
  const live = building || (!items.length && pending);   // 还有结论没出来 = 还在动
  const back = live
    ? `<div class="lane-back">${shareBtnHtml(null, "复制地址，晚点回来", true)}
         <span class="lane-back-note">不用守着。</span></div>`
    : "";
  box.innerHTML = `<div class="lane ${live ? "" : "ok"}">${head}
    ${items.length ? `<div class="lane-cards grid">${items.map(laneCardHtml).join("")}</div>` : ""}
    ${back}</div>`;
  bindLaneCards(box);
  bindShareButtons(box);
}

/* 补搜出来的内容：**用的就是结果列表那张卡片**（CY 2026-11-10 09:2x 报
   「我顶上去为什么会跳出呢？应该还是跟其他的一样，嵌入到我们的网页上才对呀」）。
   原来这里自己写了一张卡、标题是个 `target=_blank` 的外链 ⟹ 点一下人就离开站了，
   而站内明明有内嵌播放器（B站/抖音都能嵌，只有视频号不行）。
   补搜来的内容不在 data.json 里（那份要刷新页面才更新），所以单独记一份 id→item，
   否则点开时 `DATA.find()` 找不到它、弹窗会是空的。 */
const LANE_ITEMS = new Map();

function laneCardHtml(it) {
  if (it && it.id) LANE_ITEMS.set(String(it.id), it);
  return cardHtml(it);
}

/* 补搜卡片的点击：先查补搜自己那份，再退回 DATA（环 0 命中的内容两边都有） */
function bindLaneCards(box) {
  box.querySelectorAll(".card").forEach(c => c.addEventListener("click", () =>
    openModal(LANE_ITEMS.get(String(c.dataset.id)) || DATA.find(it => it.id === c.dataset.id))));
}

/* ---------- 「这个问题解决了 / 没找到我要的」 ----------
 * 位置变过两次，第二次是 CY 2026-11-10 09:2x 定的：
 *   v1 左侧栏常驻   → 他还没开始用就请他评价（我们的度量需求摆在他的需求前面）
 *   v2 结果列表下面 → **补搜还在跑、一条结果都没给**，底下就问他"解决了吗"
 *   v3（现在）只在详情页底部 —— 他的原话：「他点开某个视频，观看完了之后才有这两个
 *       Button 给出来」。判准很简单：**问之前，我们得先真的给过他东西。**
 * 所以它跟着弹窗生成、跟着弹窗消失，不再是一个常驻的页面元素。 */
const PRIVACY_NOTE = COLLECT_URL
  ? "匿名记一条到我们自己的服务器（这台设备这次访问的编号，关掉网页就失效，拼不出你是谁）。"
  : "只记在你这台设备上，没有上传——这一版还没有后端。";

/* 两颗按钮下面原来还有一段「点一下我们才知道做得对不对。这是我们唯一看的指标——找到
   答案就走，对我们是成功，不是流失。」——那是**我们的度量需求**，不是他的下一步
   （体验审查 §3）。按钮本身就是问句。他点完之后仍会看到我们记了什么（exitSaid）。 */
function exitBlockHtml() {
  return `<div class="exit" id="exit">
    <div class="exit-btns">
      <button class="exit-btn ok" id="exit-ok">这个问题解决了</button>
      <button class="exit-btn no" id="exit-no">没找到我要的</button>
    </div>
  </div>`;
}

function exitSaid(html, cls, withAnother) {
  const el = document.getElementById("exit");
  if (!el) return;
  el.innerHTML = `<p class="exit-said ${cls || ""}">${html}</p>
     ${withAnother ? `<div class="exit-again"><button class="linklike" id="exit-again">再问一个 →</button></div>` : ""}
     <p class="exit-note">${PRIVACY_NOTE}</p>`;
  const again = document.getElementById("exit-again");
  if (again) again.addEventListener("click", askAnother);
}

/* 「再问一个」：CY 2026-11-11 16:1x 拍定 qd1 时那句话的产品面——
 *   「『用完即走』是目标，但是用户经常会用完一个，又想到另一个需求，所以未必会走。」
 * 原来这两颗按钮按下去之后，唯一的收尾话是"有下一个问题再来"——那句话假定他**先离开**、
 * 以后某天再回来；而他说的恰恰是：下一个问题常常就在此刻。那就别让他自己去找回搜索框
 * （弹窗要关、旧节点要退、输入框要清，三步都在我们这边）。
 *
 * ⚠️ 这不是"再看一个"：没有推荐、没有自动续播、不摆任何我们挑的内容——
 * 下一个问题由他自己打出来。给的是**同一个搜索框**，不是一条流。
 * 为什么要清掉 node/topic：留着旧节点，他新打的问题会被当前节点再过滤一遍，
 * 多半 0 条（§filtered 的老毛病）。新问题要从整张地图问起。 */
function askAnother() {
  closeModal();
  const box = document.getElementById("q");
  if (box) box.value = "";
  go({ q: "", node: null, topic: null });
  if (box) box.focus({ preventScroll: true });
}

/* itemId：现在这两颗按钮长在某条视频下面，所以要记下是**哪条**让他解决/没解决的。
   原来在页面级时记不到这个，只知道"他在这一页按了"。 */
function bindExitButtons(root, itemId) {
  const ok = root.querySelector("#exit-ok");
  const no = root.querySelector("#exit-no");
  if (!ok || !no) return;
  ok.addEventListener("click", () => {
    recordExit("found", "", itemId);
    /* 原来这里是「记下了。这是我们唯一的成功。不用收藏，有下一个问题再来。」
       去掉中间那句：那是**我们的记分牌**，不是对他有用的话（文案铁律，CY 11-10 17:0x）；
       末句换成一颗真能按的「再问一个」（qd1，CY 11-11 16:1x）。 */
    exitSaid(`<b>记下了。</b>`, "", true);
  });
  no.addEventListener("click", () => {
    recordExit("not_found", "", itemId);
    const el = document.getElementById("exit");
    el.innerHTML =
      `<p class="exit-said bad"><b>记下了——这是我们的失败，不是你的。</b><br>你想找的是什么？</p>
       <div class="exit-ask">
         <input id="exit-want" type="text" placeholder="一句话就行" maxlength="80">
         <button id="exit-send">送出</button>
       </div>
       <p class="exit-note">它会进我们的内容缺口清单${COLLECT_URL ? "（匿名，只认这次访问的设备编号，拼不出你是谁）" : "——只记在你这台设备上，没有上传，这一版还没有后端"}。</p>`;
    const input = document.getElementById("exit-want");
    const send = () => {
      recordExit("gap_wish", input.value.trim(), itemId);
      // 没找到的那条路也给同一个出口：他的问题没解决，但下一个问题照样可能就在此刻
      exitSaid(`<b>收到。</b><br>这句话比一万次点击有用。`, "bad", true);
    };
    document.getElementById("exit-send").addEventListener("click", send);
    input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
    input.focus();
  });
}

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
 *
 * ⚠️ **2026-11-11：上面那两个标定样本里，血压那个已经失效了，别再照它推理。**
 * hea2 11-10 上线后库里**真有**血压内容（3 个节点 15 条），而 11-11 实测
 * 「如何控制血压」→ `血压怎么测才测得准` **0.822**，落在确信区——这正是它该去的地方。
 * 也就是说当初那条"0.636 必须落在没把握区"的理由（**库里没有**）已经不成立了。
 * 0.75 这条线本身没动，继续由血糖那个样本（0.838 确信）和真正的没听懂样本守着；
 * 这里记下来只为一件事：**标定样本是会随库存变化而失效的**，
 * 下次调这个阈值前先重测一遍样本的现状，别拿两天前的分数当常量。
 * （病根与机器闸见 `tests/pipeline/semantic_index_fresh.py`。）
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

/* 在飞的那次向量化请求。`semSeq` 只负责**丢掉过期响应**，Worker 那边照样把 bge-m3
   跑完了（花的是 Workers AI 的 neuron）⟹ 真要省算力必须 abort，让 Cloudflare 那侧
   在 fetch 断开时就停。两个一起留着：abort 失败/老浏览器没有它时 seq 还兜着。 */
let semAbort = null;
function abortSemantic() {
  if (semAbort) { try { semAbort.abort(); } catch (e) { /* 老浏览器没有就算了 */ } semAbort = null; }
}

function fetchSemantic(q) {
  abortSemantic();
  if (!q || q.length > 60) { SEM = { q: "", top: [], ms: 0, pending: false, err: "" }; renderSuggest(); return; }
  const seq = ++semSeq;
  SEM = { q, top: [], ms: 0, pending: true, err: "" };
  renderSuggest();
  // 同理（见下面 .then 里那一句）：字面 0 命中时先把结果区换成"正在找…"，
  // 别让"这里还没有内容"先闪一下——那句话有一半概率在几百毫秒后被自己推翻。
  if (state.q === q && !state.mine && !state.asks && !matchedByQuery().length) renderResults();
  semAbort = typeof AbortController === "function" ? new AbortController() : null;
  fetch(SEMANTIC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ q }), signal: semAbort ? semAbort.signal : undefined })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(d => {
      if (seq !== semSeq) return;            // 用户还在打字，过期响应直接丢掉
      if (!d || d.ok !== true) throw new Error((d && d.err) || "bad payload");
      SEM = { q, top: (d.top || []).slice(0, 5), ms: d.ms || 0, pending: false, err: "" };
      renderSuggest();
      // 语义是异步到的，而结果区在它到之前已经画过一遍了（那时只有字面匹配，可能是 0 条）。
      // 字面 0 命中时必须重画一次——否则确信命中的内容要等他再动一下页面才出现。
      if (state.q === q && !state.mine && !state.asks && !matchedByQuery().length) renderResults();
      const t0 = SEM.top[0];
      // 落进现有 ev 表不加列：node 列正好就是节点名，细节塞 note。
      // （加列要改 D1 schema，而这条信息的形状本来就跟 node 对得上。）
      if (t0) emit("search_sem", { node: t0.name,
                                   note: `score=${t0.score} n=${t0.n || 0} ms=${SEM.ms}` });
    })
    .catch(e => {
      if (seq !== semSeq) return;
      /* 我们自己掐掉的（他清空了搜索框 / 回了首页）**不是失败**。不单独认出来的话
         BI 里会多出一串 `search_sem_fail: The user aborted a request`，
         而那正好会把真正的向量化故障埋在噪音里。 */
      if (e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")))) {
        SEM = { q: "", top: [], ms: 0, pending: false, err: "" };
        renderSuggest();
        return;
      }
      // 失败就安静退回关键词匹配（绝不因为一个附加能力影响用户），但**必须留痕**——
      // 不留痕就会变成 /rtsearch 那种"自报成功的空结果"。
      SEM = { q, top: [], ms: 0, pending: false, err: String((e && e.message) || e) };
      renderSuggest();
      // 失败也要把"正在找…"收掉，退回原来的空态——否则转圈会一直转下去。
      if (state.q === q && !state.mine && !state.asks && !matchedByQuery().length) renderResults();
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
    // 2026-11-10 第三方评审(fable/xhigh)实测抓到：这里原来写"已经记下来了，正在去找合适的
    // 内容……过一会儿回来搜同一句话就知道"——但这个分支只 emit `search_gap`，全代码库没有
    // 任何东西消费这张表；真正触发本机守护进程去搜的是下面「我要这个」按钮打的 /rtsearch。
    // 用户照它说的"过一会儿回来"，看到的还是一样的结果——这就是页面在替我们撒谎。
    el.innerHTML =
      `<div class="sg-label">这个问题我们还没有。</div>
       <div class="sg-note">想现在就要，点下面的「我要这个」。</div>`;
    // 记一条"库里没有这个问题"——仅用于内容缺口清单，不会触发搜索（见上）。
    maybeRecordGap(state.q, SEM.top[0].score, "none");
    return;
  }

  /* 没把握区（0.60–0.75）：听懂了、但库里多半不是他要的那个。
     既然没把握就**说出来**——摆建议但措辞下调，且一样记缺口。
     这是"不装懂"在代码里的落点：同样的 chips，换一句不同的开场白。 */
  const unsure = SEM.top[0].score < SUGGEST_SURE;
  if (unsure) maybeRecordGap(state.q, SEM.top[0].score, "weak");

  /* 下面结果区已经把确信命中的节点**连内容一起**摆出来了（renderSureHits）⟹
     这里再摆一遍同样的问题名就是重复占版面。只留它没摆的那几个。
     条件要和 renderResults 里那个分支逐字一致，否则两处会各说各话。 */
  const shown = new Set((!localHits && !state.node) ? sureNodeHits().map(s => s.name) : []);
  const rest = SEM.top.filter(t => !shown.has(t.name));
  if (shown.size && !rest.length) { el.innerHTML = ""; return; }

  const chips = (shown.size ? rest : SEM.top).map(t => {
    const where = nodeInLib(t.name);
    if (!where) {
      return `<span class="chip gap" title="这个问题还没有合格内容">${esc(t.name)}</span>`;
    }
    return `<button class="chip" data-sg="${esc(t.name)}" data-sg-topic="${esc(where.topic)}"
      data-sg-domain="${esc(where.domain || "")}">${esc(t.name)}<span class="n">${t.n || ""}</span></button>`;
  }).join("");
  const allGap = (shown.size ? rest : SEM.top).every(t => !nodeInLib(t.name));
  el.innerHTML =
    (unsure
      ? `<div class="sg-label unsure">你问的这个，我们没有直接的答案。下面这几个问题<b>可能</b>沾边，
           也可能不是一回事——你自己判断：</div>`
      : shown.size
        ? `<div class="sg-label">还可以看：</div>`
        : `<div class="sg-label">你想问的，也许是这几个问题：</div>`) +
    `<div class="chips">${chips}</div>` +
    (allGap ? `<div class="sg-note">这些还没有干净的答案，我们在找。</div>`
      : unsure ? `<div class="sg-note">已记进缺口清单。</div>` : "");
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
/* Esc：弹窗开着就关弹窗，否则退回首页（第三个回去的入口，见 goHome 那段注释）。
   顺序不能反——弹窗是更靠上的一层，一次 Esc 只该收掉一层。 */
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.getElementById("modal-overlay")?.classList.contains("open")) { closeModal(); return; }
  if (!atHome()) goHome();
});

/* ══════════ 两个节拍，不是一个（CY 2026-11-11 22:1x「浪费算力」那半句）══════════
 * 原来一个 160ms 的 timer 同时管三件事：本地过滤、BI 事件、**语义搜索的网络请求**。
 * 后者在 Cloudflare Workers AI 上真跑一次 bge-m3 向量化（isolate 冷的时候还要先把
 * 105 条索引文本全量向量化一遍）⟹ 按退格键删 8 个字 = 最多 8 次向量化 + 8 条
 * 「他搜了什么」的 BI 事件，而那 8 个前缀（"如何控制血"、"如何控制"、"如何控"…）
 * **没有一个是他真正想问的问题**。缺口清单被前缀污染，比多花的那点算力更贵。
 *
 * 拆成两档：
 *   · 本地过滤（纯内存 filter，零成本）→ 还是 160ms，手感不变；
 *   · 网络 + BI → 等一个**真正的停顿**；而且**删字时等更久**，因为变短的输入永远是
 *     过路状态，不是目的地（没人把一句话删掉一半当成自己要问的问题）。 */
const Q_RENDER_MS = 160;
const Q_NET_MS = 420;         // 打字停下
const Q_NET_DEL_MS = 700;     // 正在删字：再等久一点，大概率他还要继续删
let qTimer = null, qNetTimer = null, qPrev = "";

function cancelPendingSearch() {
  clearTimeout(qTimer); clearTimeout(qNetTimer);
  qPrev = "";
  abortSemantic();            // 在飞的那次请求直接掐掉，别让 Worker 白算完
}

document.getElementById("q").addEventListener("input", e => {
  clearTimeout(qTimer); clearTimeout(qNetTimer);
  const v = e.target.value.trim().toLowerCase();
  const deleting = v.length < qPrev.length;
  qPrev = v;
  syncHasQ();                 // ✕ 跟着字走，不等 debounce
  qTimer = setTimeout(() => {
    state.q = v;
    mapExpanded = false;   // 换了搜索词就把折起的地图收回去（和 go() 同一个规矩）
    render();
  }, Q_RENDER_MS);
  // 清空到空串：本地那一跳照走（回到首页的列表），但没有任何可问的东西 ⟹ 不发请求、不记事件。
  if (!v) { abortSemantic(); SEM = { q: "", top: [], ms: 0, pending: false, err: "" }; return; }
  qNetTimer = setTimeout(() => {
    // 只在停下打字后记一次（不是每个按键）。**搜了什么 + 命中几条**是这个产品
    // 最该看的 BI：命中 0 的词就是内容缺口清单。
    emit("search");
    // 语义搜索：关键词命中与否都要问一次——它不只是兜底，还负责把
    // "地图认为他问的是哪个节点"记进事件表（自动升级闸要吃这个）。
    fetchSemantic(v);
  }, deleting ? Q_NET_DEL_MS : Q_NET_MS);
});


/* ══════════ 收藏：存在你自己的浏览器里（CY 2026-11-10 16:5x）══════════
 * 他的话：「知识的 bookmark 跟积累非常重要…虽然我们没有账号系统，但用户不用登录，
 * 在他自己的 Chrome 的 memory 里面，我们就可以帮他做 bookmark…将来如果要升级账户系统
 * 也可以做，只是这账户系统几乎就是匿名的，用户只要记住个 ID 就可以了。」
 *
 * 为什么这件事和"不要账户、不认识你"不冲突：**收藏从头到尾没离开过这台设备**。
 * 我们的服务器上没有这份名单，所以也无从拿它做推荐——这不是承诺，是做不到。
 * 三句话必须写在用户看得见的地方（他点名要提示的那三条）：
 *   ① 只在这台设备上 ② 清浏览器数据会一起清掉 ③ 不会用来给你做任何推荐
 *
 * 存什么：只存 id + 当时的标题/作者（够在列表里显示），不存观看记录、不存时间线。
 * 存标题是因为内容可能下架——那时要能诚实地说"这条已经不在库里了"，
 * 而不是让收藏夹里凭空少一行（"少了一行"和"我记错了"在用户那里完全同形）。
 */
const MARK_KEY = "xing.marks.v1";
let MARKS = { items: {}, nodes: {} };
let MARK_WRITABLE = true;   // 无痕模式/配额满时 localStorage 会抛，要诚实告诉用户

function loadMarks() {
  try {
    const raw = localStorage.getItem(MARK_KEY);
    if (raw) MARKS = Object.assign({ items: {}, nodes: {} }, JSON.parse(raw));
  } catch (e) { MARK_WRITABLE = false; }
}
function saveMarks() {
  try { localStorage.setItem(MARK_KEY, JSON.stringify(MARKS)); } catch (e) { MARK_WRITABLE = false; }
}
function markCount() { return Object.keys(MARKS.items).length + Object.keys(MARKS.nodes).length; }
function isMarked(id) { return !!MARKS.items[id]; }
function isNodeMarked(n) { return !!MARKS.nodes[n]; }

function toggleMark(id) {
  if (MARKS.items[id]) delete MARKS.items[id];
  else {
    const it = ALL_DATA.find(x => x.id === id);
    MARKS.items[id] = { title: it ? it.title : "", author: it ? it.author : "",
                        node: it ? it.node : "", platform: it ? it.platform : "" };
  }
  saveMarks(); afterMarkChange();
}
function toggleNodeMark(n) {
  if (MARKS.nodes[n]) delete MARKS.nodes[n]; else MARKS.nodes[n] = { title: n };
  saveMarks(); afterMarkChange();
}

/* 收藏按钮。**不画星星**：星星在短视频平台等于"点赞/喜欢"，而这里的动作是"存起来以后看"。
   用书签旗形，和标识一样是截断的几何。 */
function bmBtn(id, on) {
  return `<button class="bm${on ? " on" : ""}" data-bm="${esc(id)}"
    aria-label="${on ? "取消收藏" : "收藏"}" title="${on ? "已收藏，点一下取消" : "收藏到这台设备"}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-5-6 5z"/></svg></button>`;
}

/* 捕获阶段拦截：卡片本身也绑了 click（三处），不在捕获阶段挡住，点收藏会顺手把弹窗打开 */
document.addEventListener("click", e => {
  const b = e.target.closest?.("[data-bm]");
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  (b.dataset.bmKind === "node" ? toggleNodeMark : toggleMark)(b.dataset.bm);
}, true);

function refreshMarkUI() {
  document.querySelectorAll("[data-bm]").forEach(b => {
    const on = b.dataset.bmKind === "node" ? isNodeMarked(b.dataset.bm) : isMarked(b.dataset.bm);
    b.classList.toggle("on", on);
    b.setAttribute("aria-label", on ? "取消收藏" : "收藏");
  });
  const e1 = document.getElementById("mine-entry");
  if (e1) {
    const n = markCount();
    e1.innerHTML = n
      ? `<button class="mine-btn" id="mine-open">我的收藏 <span class="mine-n">${n}</span></button>`
      : "";
    const btn = document.getElementById("mine-open");
    if (btn) btn.addEventListener("click", () => go({ mine: true, q: "", node: null, topic: null }));
  }
  /* ⚠️ 这里**不许**调 renderMine()：renderMine 结尾会调 refreshMarkUI，
     两边互相调就是无限递归（17:1x 真撞到，浏览器报 Maximum call stack size exceeded，
     顺带把 syncUrl 也一起带崩，地址栏的 ?mine=1 永远写不上）。
     职责切开：本函数只刷按钮状态和计数；收藏页要不要重画，由**改动收藏的那一方**决定。 */
}

/** 收藏发生变化后的统一出口：刷按钮 + 如果正停在收藏页就重画它 */
function afterMarkChange() {
  refreshMarkUI();
  if (state.mine) renderMine();
}

function renderMine() {
  const el = document.getElementById("results");
  const bar = document.querySelector(".toolbar");
  if (bar) bar.hidden = true;
  const ids = Object.keys(MARKS.items);
  const nodes = Object.keys(MARKS.nodes);
  const live = ids.map(id => ALL_DATA.find(x => x.id === id)).filter(Boolean);
  const gone = ids.filter(id => !ALL_DATA.some(x => x.id === id));
  const note = `<div class="mine-note">
      收藏只存在<b>这台设备的浏览器</b>里：我们的服务器上没有这份名单，
      所以也<b>不会</b>拿它给你做任何推荐。<br>
      清掉浏览器数据（或换一台设备、换一个浏览器）收藏会一起没有。
      ${MARK_WRITABLE ? "" : "<br><b>这个浏览器不让我们存东西</b>（无痕模式？），现在收的这次关掉页面就没了。"}
    </div>`;
  if (!ids.length && !nodes.length) {
    el.innerHTML = `<div class="mine-head"><b>我的收藏</b>
      <button class="linklike" id="mine-back0">回首页</button></div><div class="empty">还没有收藏。<div class="empty-note">
      在任意一条视频或问题上点那个书签就收进来了。</div></div>${note}`;
    document.getElementById("mine-back0")?.addEventListener("click", () => go({ mine: false }));
    return;
  }
  const nodeList = nodes.length ? `<div class="sec"><div class="sh"><span class="t">收藏的问题</span>
      <span class="n">${nodes.length}</span></div>
      <ul class="hq-list">${nodes.map(n => `<li><button class="hq" data-node="${esc(n)}">
        <span class="hq-q">${esc(displayNode(n))}</span>${bmBtn(n, true).replace("<button", '<button data-bm-kind="node"')}
      </button></li>`).join("")}</ul></div>` : "";
  const goneList = gone.length ? `<div class="mine-gone">有 ${gone.length} 条收藏的内容已经不在库里了
      （下架或没通过复核）：${gone.map(id => esc(MARKS.items[id].title || id)).join("、")}
      <button class="linklike" id="mine-clean">清掉这几条</button></div>` : "";
  const head = `<div class="mine-head"><b>我的收藏</b>
      <button class="linklike" id="mine-back">回首页</button></div>`;
  el.innerHTML = head + nodeList
    + (live.length ? `<div class="sec"><div class="sh"><span class="t">收藏的视频</span>
        <span class="n">${live.length}</span></div><div class="cards">${live.map(it => cardHtml(it)).join("")}</div></div>` : "")
    + goneList + note;
  el.querySelectorAll(".hq").forEach(b => b.addEventListener("click", () =>
    go({ mine: false, node: b.dataset.node })));
  el.querySelectorAll(".card").forEach(c => c.addEventListener("click", () => {
    const it = ALL_DATA.find(x => x.id === c.dataset.id); if (it) openModal(it);
  }));
  document.getElementById("mine-back")?.addEventListener("click", () => go({ mine: false }));
  const cl = document.getElementById("mine-clean");
  if (cl) cl.addEventListener("click", () => { gone.forEach(id => delete MARKS.items[id]); saveMarks(); renderMine(); });
  refreshMarkUI();
}

/* ---------- 版本号与更新记录（CY 2026-11-10 16:2x 要）----------
 * 他要的三件：① 首页有个入口 ② 能看历史、有价值感 ③ 他自己能一眼 check 当前版本。
 * 加上他紧跟的两条约束：**必须 user facing**、**未必每个版本都有 release note**。
 *
 * 编号规则（我定的，写在面板底部给用户看，不只是内部约定）：
 *   **用户能感知的变化才升一号**；页面变快、修个 bug、后台换实现——不升号、不写记录。
 * 这条规则把他第二、第三条约束同时消掉：既然只有"你下次来会发现不一样"才升号，那
 * **"没有记录的版本"根本不存在**，不需要给它留例外；而"必须 user facing"也就不是
 * 写作要求而是**结构要求**——写不出一句"你会发现什么不一样"的改动，压根拿不到号。
 * ⚠️ 文案只放在 releases.json 里，不在这里写死：两处各一份必然漂移。
 * 面板里**不放**"我们修了哪些 bug / 重构了什么"——那是给我自己看的，对用户是噪音。 */
let REL = null;           // releases.json 的内容（点开才需要，但进站就取：它 ~2KB）
let REL_OPEN = false;     // 更新记录面板开着没（地址栏的 ?rel=1 跟着它走）
let PENDING_REL = false;  // 带 ?rel=1 落地的：等 releases.json 到了再打开

function loadReleases() {
  fetch("releases.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => {
      REL = d;
      renderVersionLine();
      if (PENDING_REL) { PENDING_REL = false; openReleases(); }
    })
    // 取不到就**什么都不显示**：显示一个猜的版本号比不显示更糟（页面会撒谎）。
    .catch(() => { REL = null; });
}

function renderVersionLine() {
  const el = document.getElementById("verline");
  if (!el || !REL) return;
  const cur = (REL.entries || []).find(e => e.v === REL.current) || (REL.entries || [])[0];
  if (!cur) return;
  el.innerHTML = `版本 v${esc(cur.v)} · ${esc(cur.date)} ·`
    + `<button class="verbtn" id="rel-open">更新记录</button>`;
  document.getElementById("rel-open").addEventListener("click", openReleases);
}

function openReleases() {
  if (!REL) return;
  const m = document.getElementById("modal-content");
  const items = (REL.entries || []).map(e => `
    <div class="rel-item">
      <div class="rel-top">
        <span class="rel-v">v${esc(e.v)}</span>
        ${e.v === REL.current ? `<span class="rel-cur">现在用的</span>` : ""}
        <span class="rel-date">${esc(e.date)}</span>
      </div>
      <p class="rel-t">${esc(e.title)}</p>
      <ul>${(e.points || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul>
    </div>`).join("");
  m.className = "modal";
  m.innerHTML = `
    <div class="modal-head">
      <span class="modal-where">更新记录</span>
      <button class="modal-close" aria-label="关闭">&times;</button>
    </div>
    <div class="rel-wrap">
      <p class="rel-h">这个站改过什么</p>
      <p class="rel-sub">${esc(REL.scheme_short || "")}</p>
      ${items}
      <p class="rel-rule">${esc(REL.scheme_long || "")}</p>
    </div>`;
  document.getElementById("modal-overlay").classList.add("open");
  REL_OPEN = true;
  syncUrl(null);            // 地址变成 ?rel=1（见 shareUrl）：这一页也能发给人
  m.querySelector(".modal-close").addEventListener("click", closeModal);
  m.focus?.();
  // **刻意不记 BI**：Worker 的 kind 白名单里没有 releases，发过去会被静默丢掉。
  // 和 15:3x 的分享按钮同一处理——要记就先改白名单再部署 Worker，不在这版偷偷塞。
}

/* shell.json 只有几 KB，和 data.json 并行取、谁先到谁先画。失败就安静重试几次——
   它不影响"有没有内容"（data.json 落地后一样能补上同一批字段），只影响首页能多快
   看到真实数字而不是"库内 0 条"那种假话。*/
function loadShell(attempt = 1) {
  fetch("shell.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => {
      TOPICS = d.topics || TOPICS;
      TOPIC_COUNTS = d.topic_counts || {};
      DOMAIN_LIST = d.domains || DOMAIN_LIST;
      FAMILIES = d.families || FAMILIES;
      DOMAIN_FAMILY = d.domain_family || DOMAIN_FAMILY;
      ALL_COUNT = d.all_count || 0;
      SHELL_LOADED = true;
      if (!DATA_LOADED) { applyDomain(); render(); }   // 先刷"库内 N 条"，再把首页画出来
    })
    .catch(() => {
      if (attempt < 3) setTimeout(() => loadShell(attempt + 1), 500 * attempt);
      // 三次都没拿到就算了：data.json 迟早会带着同一批字段落地，首页会在那时才画出来
      // ——退回原来的行为，不是新的失败模式。
    });
}

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
      FAMILIES = d.families || {};
      DOMAIN_FAMILY = d.domain_family || {};
      applyDomain();
      render();
      /* 地址里带 ?v= ⟹ 把那条视频直接打开（分享链接的落点）。
         **必须等 data.json 到了才找得到**，所以放在这里而不是进站时。
         找不到就安静地留在它所在的那一页——别弹错，链接可能指向已下架的内容。 */
      if (PENDING_VIDEO) {
        const it = ALL_DATA.find(x => x.id === PENDING_VIDEO);
        PENDING_VIDEO = null;
        if (it) openModal(it);
      }
      /* ?lane=1 ⟹ 他是从"等待页"存的地址回来的：接着显示那一问的进度/结果。
         （后端对已在队列里的问题只回状态、不会再花钱搜一遍。） */
      if (PENDING_LANE) { const q = PENDING_LANE; PENDING_LANE = null; startLane(q); }
      /* 刷新/重新进站时，把"刚才还在补"的那几条接回来（CY 2026-11-11 04:1x 报的
         「刷新一下这入口又没有了」）。放在这里而不是启动时：它会渲染内联进度框，
         那要等 data.json 到了页面才成形。 */
      else resumeAsks();
    })
    .catch(err => {
      if (attempt < 3) return setTimeout(() => loadData(attempt + 1), 800 * attempt);
      DATA_LOADED = true;   // 别卡在"加载中"——失败要说失败
      /* 数据没取到**不代表**用户那几条请求该失联：它们是两件独立的事
         （清单来自本机 localStorage，进度来自我们的 Worker）。 */
      refreshAsksUI(); resumeAsks();
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

loadMarks();
loadAsks();     // 「我要补的」要在 restoreFromUrl 之前装好：?asks=1 一进来就要画得出
/* 入口**不等 data.json**：它画的是用户自己的清单，和库里有什么内容无关。
   原来它只在 render() 里刷，而 render() 要等数据到——data.json 慢一秒、或者干脆没取到，
   左栏就有一秒（或永远）看不到"我要补的"。而这正是 CY 报的那个症状的形状，
   判据第一次跑就在这里红了。 */
refreshAsksUI();
restoreFromUrl();   // 必须在 loadData 之前：它一回来就 render，那时 state 得已经是地址里的样子
loadShell();    // 几 KB，和 loadData 并行——首页那 4 张卡不该等 data.json 那几 MB
loadData();
loadPages();
loadReleases();   // ~2KB，取不到就不显示版本行（页面宁可少说，不许猜一个版本号出来）
