const PLATFORM_CN = { "douyin": "抖音", "wechat_channels": "视频号" };
// 只有抖音有官方iframe播放端点。视频号官方嵌入只存在于微信小程序里，网页做不到。
const EMBED_URL = { douyin: vid => `https://open.douyin.com/player/video?vid=${vid}&autoplay=1` };
// 每个分类固定一个颜色(按分类名哈希选色,同一分类永远同色,刷新/排序不会变)——
// CY要求"颜色要聚块不能乱"：色块只用在卡片左边框+分类标题小圆点,不染卡片主体。
const PALETTE = ["#2b6cb0","#38a169","#d69e2e","#9f7aea","#dd6b20","#319795","#e53e3e","#718096"];
function catColor(cat) {
  let h = 0;
  for (const c of (cat || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

let DATA = [];
let selectedTags = new Set();
let sortMode = "combined";

function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}分${sec}秒`;
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function matchesQuery(it, q) {
  return !q || (it.title + it.summary + (it.author||"")).toLowerCase().includes(q);
}
function relevanceScore(it, q) {
  if (!q) return 0;
  const t = it.title.toLowerCase(), s = (it.summary||"").toLowerCase();
  let score = 0;
  if (t.includes(q)) score += 10;
  if (s.includes(q)) score += 3;
  return score;
}

function currentFiltered() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  let items = DATA.filter(it => matchesQuery(it, q));
  const matchedTags = [...new Set(items.map(it => it.category))];
  if (selectedTags.size) items = items.filter(it => selectedTags.has(it.category));
  return { items, q, matchedTags };
}

function sortWithin(items, q) {
  const cmp = {
    relevance: (a, b) => relevanceScore(b, q) - relevanceScore(a, q) || (a.title||"").localeCompare(b.title||"", "zh"),
    latest: (a, b) => (b.published_at || "").localeCompare(a.published_at || ""),
    combined: (a, b) => (a.title || "").localeCompare(b.title || "", "zh"),
  }[sortMode];
  return [...items].sort(cmp);
}

function buildTagCloud(matchedTags) {
  const cloud = document.getElementById("tag-cloud");
  const allCats = [...new Set(DATA.map(it => it.category))];
  cloud.innerHTML = allCats.map(c => {
    const inResults = matchedTags.includes(c);
    const n = DATA.filter(it => it.category === c && matchesQuery(it, document.getElementById("q").value.trim().toLowerCase())).length;
    return `<button class="tag-btn${selectedTags.has(c) ? ' selected' : ''}" data-cat="${escapeHtml(c)}"
      style="${inResults ? '' : 'opacity:.35'}">${escapeHtml(c)}<span class="count">${n}</span></button>`;
  }).join("");
  cloud.querySelectorAll(".tag-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.cat;
      selectedTags.has(c) ? selectedTags.delete(c) : selectedTags.add(c);
      render();
    });
  });
}

function render() {
  const { items, q, matchedTags } = currentFiltered();
  buildTagCloud(matchedTags);

  document.querySelectorAll(".sort-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.sort === sortMode);
    if (b.dataset.sort === "relevance") b.disabled = !q;
  });
  document.getElementById("result-count").textContent = `共${items.length}条`;

  const sections = document.getElementById("sections");
  if (!items.length) {
    sections.innerHTML = `<div class="empty">没找到匹配内容——当前库还很小，换个词、清空搜索框或取消标签筛选看看全部。</div>`;
    return;
  }
  // 按分类分组展示(CY要求"不是平铺的,要有轻量结构"),组内按当前排序模式排
  const byCat = new Map();
  for (const it of items) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  const catOrder = [...byCat.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  sections.innerHTML = catOrder.map(cat => {
    const list = sortWithin(byCat.get(cat), q);
    const isGap = list[0].category_fit === "gap";
    const color = catColor(cat);
    return `
      <div class="section">
        <div class="section-head">
          <span class="section-dot" style="background:${color}"></span>
          <span class="section-title ${isGap ? 'gap' : ''}">${escapeHtml(cat)}${isGap ? ' · 地图待扩' : ''}</span>
          <span class="section-count">${list.length}条</span>
        </div>
        <div class="grid">
          ${list.map(it => `
            <div class="card" style="--cat-color:${color}" data-idx="${DATA.indexOf(it)}">
              ${it.cover_url ? `<img class="thumb" src="${it.cover_url}" loading="lazy" alt="">` : `<div class="thumb"></div>`}
              <div class="card-body">
                <h3>${escapeHtml(it.title)}</h3>
                <div class="meta">
                  <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
                  ${it.author ? `<span class="author">@${escapeHtml(it.author)}</span> · ` : ""}
                  ${fmtDuration(it.duration_s)}${it.likes ? " · " + it.likes + "赞" : ""}
                </div>
                <div class="summary">${escapeHtml(it.summary || "")}</div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>`;
  }).join("");
  sections.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(DATA[+card.dataset.idx]));
  });
}

function openModal(it) {
  const embedFn = EMBED_URL[it.platform];
  const modalEl = document.getElementById("modal-content");
  modalEl.className = embedFn ? "modal embed-mode" : "modal nolink-mode";
  const transcript = it.asr_text
    ? `<span class="transcript-toggle" id="tt">展开转写全文 ▾</span>
       <div class="transcript-box" id="tb">${escapeHtml(it.asr_text)}</div>`
    : "";
  const body = embedFn
    ? `<iframe class="modal-embed" src="${embedFn(it.video_id)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
       <p class="modal-tip">提示：点进视频播放区域后Escape可能失效（跨站iframe的浏览器限制），用右上角 ✕ 或点弹窗外侧关闭。</p>`
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
      ${transcript}
    </div>
  `;
  document.getElementById("modal-overlay").classList.add("open");
  modalEl.querySelector(".modal-close").addEventListener("click", closeModal);
  const tt = modalEl.querySelector("#tt");
  if (tt) tt.addEventListener("click", () => {
    const box = modalEl.querySelector("#tb");
    box.classList.toggle("open");
    tt.textContent = box.classList.contains("open") ? "收起转写全文 ▴" : "展开转写全文 ▾";
  });
  // 焦点给弹窗容器本身(不是iframe)，这样打开瞬间Escape就能用；
  // 用户主动点进iframe内部交互后，键盘焦点会转移进去，那之后Escape失效是
  // 跨站iframe的浏览器安全限制，前端代码改不了，只能靠✕按钮兜底(已在提示里说明)。
  modalEl.focus();
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
document.querySelectorAll(".sort-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    sortMode = btn.dataset.sort;
    render();
  });
});

fetch("data.json").then(r => r.json()).then(d => {
  DATA = d.items || [];
  render();
});
document.getElementById("q").addEventListener("input", render);
