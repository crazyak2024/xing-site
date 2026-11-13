/* Approved homepage: story + local TagCanvas. No tracking, external calls or autoplay media. */
(() => {
  'use strict';
  const host = document.getElementById('home-experience');
  if (!host) return;
  const canvas = host.querySelector('canvas');
  const links = document.getElementById('sphere-tags');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const button = host.querySelector('.motion-toggle');
  let paused = false, timer = null, frame = 0, started = false;
  const frames = [...host.querySelectorAll('.frame')];
  const dots = [...host.querySelectorAll('.reel i')];
  function show(n) {
    frame = n;
    frames.forEach((f, i) => { f.classList.toggle('on', i === n); f.setAttribute('aria-hidden', String(i !== n)); });
    dots.forEach((d, i) => d.classList.toggle('on', i === n));
  }
  // Decorative cards; deterministic positions avoid layout shifts.
  ['grid1', 'grid2'].forEach((id, j) => {
    const grid = document.getElementById(id);
    grid.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 28; i++) {
      const card = document.createElement('i');
      card.style.animationDelay = `${((i * 7) % 10) / 10}s`;
      if (j) { card.style.opacity = 1; if (i % 3) card.className = 'junk'; }
      grid.appendChild(card);
    }
  });
  const sieve = document.getElementById('sieve');
  sieve.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 14; i++) {
    const card = document.createElement('i');
    card.className = i < 5 ? 'keep' : 'drop';
    card.style.left = `${i < 5 ? 12 + i * 44 : 6 + (i - 5) * 26}px`;
    card.style.animationDelay = `${i % 5 * .12}s`;
    sieve.appendChild(card);
  }
  function home() { return typeof atHome === 'function' ? atHome() : !location.search; }
  function stop() {
    clearInterval(timer); timer = null;
    if (started) window.TagCanvas.Pause('wc');
  }
  function sync() {
    document.body.classList.toggle('home-mode', home());
    button.hidden = motion.matches;
    if (!home() || document.hidden || motion.matches) { stop(); return; }
    if (started && !links.contains(document.activeElement)) {
      // Freeze rotation, not hit-testing: a paused sphere must remain clickable.
      const tc = window.TagCanvas.tc.wc;
      tc.minSpeed = paused ? 0 : .003;
      tc.maxSpeed = paused ? 0 : .018;
      window.TagCanvas.SetSpeed('wc', paused ? [0, 0] : [.22, -.06]);
      window.TagCanvas.Resume('wc');
    }
    if (paused) { clearInterval(timer); timer = null; }
    else if (!timer) timer = setInterval(() => show((frame + 1) % 4), 2000);
  }
  function draw() {
    if (started) window.TagCanvas.Delete('wc');
    started = false;
    links.classList.remove('visually-hidden');
    canvas.style.display = 'none';
    if (motion.matches || !window.TagCanvas || !home()) { sync(); return; }
    const w = Math.floor(host.clientWidth), ratio = Math.min(devicePixelRatio || 1, 2);
    if (!w) return;
    canvas.width = w * ratio; canvas.height = 300 * ratio;
    canvas.style.width = `${w}px`; canvas.style.height = '300px'; canvas.style.display = 'block';
    const palette = ['#2b6cb0', '#274c66', '#516675'];
    [...links.children].forEach((a, i) => { a.style.color = palette[i % 3]; });
    try {
      window.TagCanvas.Start('wc', 'sphere-tags', {
        textColour: null, textFont: 'PingFang SC,system-ui,sans-serif', textHeight: 18 * ratio,
        outlineMethod: 'colour', outlineColour: '#b7791f', initial: [.22, -.06],
        maxSpeed: .018, minSpeed: .003, depth: .55, radiusX: .85, radiusY: .85, radiusZ: .85,
        minBrightness: .25, wheelZoom: false, freezeActive: true, frontSelect: true,
        shuffleTags: false, hideTags: false, shadowBlur: 0
      });
      started = true;
    } catch (_) { started = false; }
    if (started) links.classList.add('visually-hidden');
    else canvas.style.display = 'none';
    sync();
  }
  links.addEventListener('focusin', () => { links.classList.remove('visually-hidden'); if (started) window.TagCanvas.Pause('wc'); });
  links.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (typeof go === 'function') {
      e.preventDefault();
      const node = new URL(a.href).searchParams.get('node');
      document.getElementById('q').value = '';
      go({node, q:'', topic:null, domain:'', mine:false, asks:false});
      sync();
    }
  });
  button.addEventListener('click', () => {
    paused = !paused;
    button.textContent = paused ? '播放动效' : '暂停动效';
    button.setAttribute('aria-pressed', String(paused));
    host.classList.toggle('motion-paused', paused);
    sync();
  });
  document.querySelector('.brand-panel h1').setAttribute('tabindex', '0');
  document.querySelector('.brand-panel h1').setAttribute('role', 'button');
  document.querySelector('.brand-panel h1').setAttribute('aria-label', '醒，回首页');
  document.querySelector('.brand-panel h1').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
  });
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 150); });
  addEventListener('xing:render', () => { sync(); if (home() && !started) draw(); });
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', draw);
  show(0); draw();
})();
