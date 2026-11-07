const PLATFORM_CN = { "抖音": "抖音", "视频号": "视频号", "douyin": "抖音", "wechat_channels": "视频号" };

let DATA = [];
let activeCat = "全部";

function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}分${sec}秒`;
}

function render() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const main = document.getElementById("main");
  let items = DATA;
  if (activeCat !== "全部") items = items.filter(it => it.category === activeCat);
  if (q) {
    items = items.filter(it =>
      (it.title + it.summary).toLowerCase().includes(q));
  }
  if (!items.length) {
    main.innerHTML = `<div class="empty">没找到匹配内容——当前库还很小（M1阶段仅5条），换个词或清空搜索框看看全部。</div>`;
    return;
  }
  main.innerHTML = items.map(it => `
    <div class="card">
      <span class="cat-chip ${it.category_fit === 'gap' ? 'gap' : ''}">${it.category}${it.category_fit === 'gap' ? ' · 地图待扩' : ''}</span>
      <h3>${escapeHtml(it.title)}</h3>
      <div class="meta">
        <span class="plat">${PLATFORM_CN[it.platform] || it.platform}</span>
        ${fmtDuration(it.duration_s)}${it.likes ? " · " + it.likes + "赞" : ""}
      </div>
      <div class="summary">${escapeHtml(it.summary || "")}</div>
      <div class="reason">${escapeHtml(it.reason || "")}</div>
      <a class="src" href="${it.link}" target="_blank" rel="noopener">在原平台观看</a>
    </div>
  `).join("");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

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
