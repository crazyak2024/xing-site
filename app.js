const PLATFORM_CN = { "douyin": "抖音", "wechat_channels": "视频号" };
// 只有抖音有官方iframe播放端点（CY 2026-11-07 要求：能嵌入就不跳走）。
// 视频号官方嵌入只存在于微信小程序里，网页做不到，弹窗里退化为"封面+打开原片"。
const EMBED_URL = { douyin: vid => `https://open.douyin.com/player/video?vid=${vid}` };

let DATA = [];
let activeCat = "全部";

function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}分${sec}秒`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// 排序规则明确、确定性：按分类分组后，组内按标题排序——不是伪装成"智能推荐"，
// 就是字面意思的字典序，免得看着像有隐藏算法在打分。
function sortedItems(items) {
  return [...items].sort((a, b) =>
    (a.category || "").localeCompare(b.category || "", "zh") ||
    (a.title || "").localeCompare(b.title || "", "zh"));
}

function render() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const main = document.getElementById("main");
  let items = DATA;
  if (activeCat !== "全部") items = items.filter(it => it.category === activeCat);
  if (q) {
    items = items.filter(it =>
      (it.title + it.summary + (it.author||"")).toLowerCase().includes(q));
  }
  items = sortedItems(items);
  document.getElementById("sort-note").textContent =
    `共${items.length}条 · 排序：按分类，同分类内按标题排序（不是按热度或推荐算法）`;
  if (!items.length) {
    main.innerHTML = `<div class="empty">没找到匹配内容——当前库还很小，换个词或清空搜索框看看全部。</div>`;
    return;
  }
  main.innerHTML = items.map(it => `
    <div class="card" data-idx="${DATA.indexOf(it)}">
      ${it.cover_url ? `<img class="thumb" src="${it.cover_url}" loading="lazy" alt="">` : `<div class="thumb"></div>`}
      <div class="card-body">
        <span class="cat-chip ${it.category_fit === 'gap' ? 'gap' : ''}">${it.category}${it.category_fit === 'gap' ? ' · 地图待扩' : ''}</span>
        <h3>${escapeHtml(it.title)}</h3>
        <div class="meta">
          <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
          ${it.author ? `<span class="author">@${escapeHtml(it.author)}</span> · ` : ""}
          ${fmtDuration(it.duration_s)}${it.likes ? " · " + it.likes + "赞" : ""}
        </div>
        <div class="summary">${escapeHtml(it.summary || "")}</div>
      </div>
    </div>
  `).join("");
  main.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(DATA[+card.dataset.idx]));
  });
}

function openModal(it) {
  const embedFn = EMBED_URL[it.platform];
  const modalEl = document.getElementById("modal-content");
  modalEl.className = embedFn ? "modal embed-mode" : "modal nolink-mode";
  const body = embedFn
    ? `<iframe class="modal-embed" src="${embedFn(it.video_id)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
       <p class="modal-tip">提示：视频播放区域内无法用Escape关闭（跨站iframe的浏览器限制），点右上角 ✕ 或弹窗外侧关闭。</p>`
    : `<div class="modal-cover-wrap">
         ${it.cover_url ? `<img class="modal-cover" src="${it.cover_url}" alt="">` : ""}
         <div><a class="modal-openlink" href="${it.link}" target="_blank" rel="noopener">在${PLATFORM_CN[it.platform] || it.platform}中打开观看</a></div>
         <p class="modal-tip">${PLATFORM_CN[it.platform] || it.platform}的官方嵌入只支持微信小程序内，网页做不到，这是平台限制。</p>
       </div>`;
  modalEl.innerHTML = `
    <div class="modal-head">
      <h2>${escapeHtml(it.title)}</h2>
      <button class="modal-close" aria-label="关闭">&times;</button>
    </div>
    <div class="modal-body">
      ${body}
      <div class="modal-meta">
        <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
        ${it.author ? ` · @${escapeHtml(it.author)}` : ""}
        ${fmtDuration(it.duration_s) ? " · " + fmtDuration(it.duration_s) : ""}
      </div>
      <div class="modal-summary">${escapeHtml(it.summary || "")}</div>
      <a class="src" href="${it.link}" target="_blank" rel="noopener">在原平台观看</a>
    </div>
  `;
  document.getElementById("modal-overlay").classList.add("open");
  modalEl.querySelector(".modal-close").addEventListener("click", closeModal);
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.getElementById("modal-content").innerHTML = "";
}

document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target.id === "modal-overlay") closeModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

function buildCatNav() {
  const cats = ["全部", ...new Set(DATA.map(it => it.category))];
  const nav = document.getElementById("cat-nav");
  nav.innerHTML = cats.map(c =>
    `<button class="cat-btn${c === activeCat ? ' active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join("");
  nav.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeCat = btn.dataset.cat;
      buildCatNav();
      render();
    });
  });
}

fetch("data.json").then(r => r.json()).then(d => {
  DATA = d.items || [];
  buildCatNav();
  render();
});

document.getElementById("q").addEventListener("input", render);
