import { db, getSettings, setSetting } from './db.js';
import { openBook } from './archive.js';
import { ReadingTimer, fmtDuration } from './stats.js';

const $ = (s, r = document) => r.querySelector(s);

class PageCache {
  constructor(arch) { this.arch = arch; this.map = new Map(); }
  url(i) {
    if (i < 0 || i >= this.arch.count) return null;
    let e = this.map.get(i);
    if (!e) {
      e = {};
      e.p = this.arch.getPage(i).then((b) => (e.url = URL.createObjectURL(b)));
      e.p.catch(() => this.map.delete(i));
      this.map.set(i, e);
    }
    return e.p;
  }
  trim(keep) {
    for (const [i, e] of this.map) {
      if (!keep.has(i)) {
        e.p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
        this.map.delete(i);
      }
    }
  }
  dispose() { this.trim(new Set()); }
}

const loadImg = (url) =>
  new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = url;
  });

export async function openReader(book, hooks = {}) {
  const root = $('#reader');
  const stage = $('#rd-stage');
  const top = $('#rd-top');
  const bottom = $('#rd-bottom');
  const slider = $('#rd-slider');
  const titleEl = $('#rd-title');
  const subEl = $('#rd-sub');
  const dimEl = $('#rd-dim');
  const busy = $('#rd-busy');

  root.hidden = false;
  busy.hidden = false;
  busy.textContent = 'Opening…';

  const blob = await db.get('files', book.id);
  if (!blob) throw new Error('File data is missing');
  let arch;
  try {
    arch = await openBook(blob, book.filename);
  } catch (e) {
    root.hidden = true;
    throw e;
  }
  busy.hidden = true;

  const cache = new PageCache(arch);
  const dims = new Map();
  const S = getSettings();
  let mode = book.mode || S.mode;
  let idx = Math.min(Math.max(book.finished ? 0 : book.page || 0, 0), arch.count - 1);
  let maxSeen = book.maxPage || 0;
  let sessionMax = idx;
  let uiVisible = true;
  let closed = false;
  let shown = 1; // pages currently displayed in paged mode
  let saveT = null;
  let wake = null;

  titleEl.textContent = book.title;
  slider.min = 1;
  slider.max = arch.count;
  const timer = new ReadingTimer(book.id, () => updateSub());
  timer.start();

  const isRtl = () => mode === 'paged-rtl';
  const updateSub = () => {
    const shownEnd = Math.min(arch.count, idx + shown);
    const pageTxt = shown > 1 ? `${idx + 1}-${shownEnd}` : `${idx + 1}`;
    subEl.textContent = `${pageTxt} / ${arch.count}  ·  ${fmtDuration(timer.session)} this session`;
    slider.value = idx + 1;
    slider.style.direction = isRtl() ? 'rtl' : 'ltr';
  };

  const applyLook = () => {
    const s = getSettings();
    root.dataset.bg = s.readerBg;
    dimEl.style.opacity = s.dim;
    root.dataset.fit = s.fit;
  };
  applyLook();

  const saveProgress = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      const finished = book.finished || idx >= arch.count - 1;
      await db.update('books', book.id, (b) => {
        if (!b) return undefined;
        b.page = idx;
        b.maxPage = Math.max(b.maxPage || 0, maxSeen);
        b.lastRead = Date.now();
        b.finished = finished;
        b.mode = mode;
        return b;
      });
      book.finished = finished;
    }, 400);
  };

  const noteIndex = (i) => {
    idx = i;
    maxSeen = Math.max(maxSeen, i);
    if (i > sessionMax) {
      timer.addPages(i - sessionMax);
      sessionMax = i;
    }
    timer.poke();
    updateSub();
    saveProgress();
  };

  // ---------------- UI show/hide ----------------
  const setUi = (v) => {
    uiVisible = v;
    root.classList.toggle('ui-hidden', !v);
  };

  // ---------------- PAGED MODE ----------------
  let scale = 1, tx = 0, ty = 0;
  let wrap = null;
  const spreadOn = () => getSettings().spread && window.innerWidth > window.innerHeight && mode !== 'webtoon';

  function applyTransform() {
    if (!wrap) return;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const maxX = Math.max(0, (wrap.offsetWidth * scale - sw) / 2);
    const maxY = Math.max(0, (wrap.offsetHeight * scale - sh) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
    wrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function resetZoom() {
    scale = 1; tx = 0; ty = 0;
    // fit-width pages taller than the screen start aligned to the top
    if (wrap && getSettings().fit === 'width') {
      const extra = (wrap.offsetHeight - stage.clientHeight) / 2;
      if (extra > 0) ty = extra;
    }
    applyTransform();
  }
  const pageIsTall = () => wrap && wrap.offsetHeight > stage.clientHeight + 2;

  async function showPaged(i, dir = 1) {
    if (closed) return;
    idx = Math.min(Math.max(i, 0), arch.count - 1);
    busy.hidden = false;
    let imgs = [];
    try {
      const first = await cache.url(idx);
      const im1 = await loadImg(first);
      dims.set(idx, { w: im1.naturalWidth, h: im1.naturalHeight });
      imgs = [{ url: first, im: im1 }];
      if (spreadOn() && idx > 0 && idx + 1 < arch.count && !(im1.naturalWidth > im1.naturalHeight * 1.05)) {
        const u2 = await cache.url(idx + 1);
        const im2 = await loadImg(u2);
        dims.set(idx + 1, { w: im2.naturalWidth, h: im2.naturalHeight });
        if (!(im2.naturalWidth > im2.naturalHeight * 1.05)) imgs.push({ url: u2, im: im2 });
      }
    } catch {
      busy.textContent = 'Could not load this page';
      return;
    }
    if (closed) return;
    busy.hidden = true;
    busy.textContent = 'Loading…';
    shown = imgs.length;
    const ordered = isRtl() ? [...imgs].reverse() : imgs;
    stage.innerHTML = '';
    wrap = document.createElement('div');
    wrap.className = 'pg-wrap';
    for (const { url } of ordered) {
      const img = document.createElement('img');
      img.src = url;
      img.draggable = false;
      img.className = 'pg-img';
      wrap.appendChild(img);
    }
    stage.appendChild(wrap);
    resetZoom();
    noteIndex(idx);

    // preload neighbours, release the rest
    const keep = new Set([idx - 1, idx, idx + 1, idx + 2, idx + 3, idx - 2].filter((n) => n >= 0 && n < arch.count));
    cache.trim(keep);
    [idx + shown, idx + shown + 1, idx - 1].forEach((n) => cache.url(n)?.catch(() => {}));
  }

  function nextPaged() {
    if (idx + shown >= arch.count) { hooks.toast?.('Last page'); return; }
    showPaged(idx + shown, 1);
  }
  function prevPaged() {
    if (idx <= 0) { hooks.toast?.('First page'); return; }
    let step = 1;
    if (spreadOn() && idx - 2 >= 1) {
      const a = dims.get(idx - 1), b = dims.get(idx - 2);
      const wide = (d) => d && d.w > d.h * 1.05;
      if (!wide(a) && !wide(b)) step = 2;
    }
    showPaged(idx - step, -1);
  }
  // direction-aware helpers: "right" tap/swipe
  const goForward = () => (mode === 'webtoon' ? scrollBy(0.85) : nextPaged());
  const goBackward = () => (mode === 'webtoon' ? scrollBy(-0.85) : prevPaged());

  // pointer gestures (paged mode)
  const ptrs = new Map();
  let pinch0 = null;
  let down = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let uiTimer = null;

  function onPointerDown(e) {
    if (mode === 'webtoon') return;
    timer.poke();
    stage.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) down = { x: e.clientX, y: e.clientY, t: Date.now(), tx, ty, moved: false };
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx, ty };
      down = null;
    }
  }
  function onPointerMove(e) {
    if (mode === 'webtoon' || !ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ns = Math.min(5, Math.max(1, pinch0.scale * (d / pinch0.d)));
      const r = stage.getBoundingClientRect();
      const px = pinch0.cx - r.left - r.width / 2;
      const py = pinch0.cy - r.top - r.height / 2;
      const k = ns / pinch0.scale;
      tx = px - (px - pinch0.tx) * k;
      ty = py - (py - pinch0.ty) * k;
      scale = ns;
      applyTransform();
    } else if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) down.moved = true;
      if (scale > 1.02) {
        tx = down.tx + dx;
        ty = down.ty + dy;
        applyTransform();
      } else if (pageIsTall() && Math.abs(dy) > Math.abs(dx)) {
        // scroll a tall (fit-width) page vertically
        ty = down.ty + dy;
        applyTransform();
      }
    }
  }
  function onPointerUp(e) {
    if (mode === 'webtoon') return;
    const had = ptrs.delete(e.pointerId);
    if (!had) return;
    if (ptrs.size < 2) pinch0 = null;
    if (!down) return;
    const d = down;
    down = null;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.moved) {
      if (scale <= 1.02 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        // swipe: finger moves left = turn forward in LTR, backward in RTL
        const forward = isRtl() ? dx > 0 : dx < 0;
        forward ? goForward() : goBackward();
      }
      return;
    }
    // tap
    const r = stage.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    const invert = getSettings().invertTaps;
    if (rel < 0.28 || rel > 0.72) {
      let forward = rel > 0.72;
      if (isRtl()) forward = !forward;
      if (invert) forward = !forward;
      forward ? goForward() : goBackward();
      return;
    }
    // centre: single tap toggles UI, double tap zooms
    const now = Date.now();
    if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(uiTimer);
      lastTap.t = 0;
      if (scale > 1.05) resetZoom();
      else {
        const px = e.clientX - r.left - r.width / 2;
        const py = e.clientY - r.top - r.height / 2;
        scale = 2.5;
        tx = px - px * scale;
        ty = py - py * scale;
        applyTransform();
      }
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      uiTimer = setTimeout(() => setUi(!uiVisible), 260);
    }
  }
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);

  // ---------------- WEBTOON MODE ----------------
  let io = null;
  let wtItems = [];
  let scrollRaf = 0;

  function scrollBy(frac) {
    stage.scrollBy({ top: stage.clientHeight * frac, behavior: 'smooth' });
  }

  function buildWebtoon(startAt) {
    stage.innerHTML = '';
    wrap = null;
    const list = document.createElement('div');
    list.className = 'wt-list';
    const ph = Math.round(stage.clientWidth * 1.4) || 600;
    wtItems = [];
    for (let i = 0; i < arch.count; i++) {
      const item = document.createElement('div');
      item.className = 'wt-item';
      item.dataset.i = i;
      item.style.minHeight = ph + 'px';
      const img = document.createElement('img');
      img.draggable = false;
      item.appendChild(img);
      list.appendChild(item);
      wtItems.push(item);
    }
    stage.appendChild(list);
    io?.disconnect();
    io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && loadWt(Number(en.target.dataset.i))),
      { root: stage, rootMargin: '150% 0px' }
    );
    wtItems.forEach((it) => io.observe(it));
    idx = startAt;
    wtItems[startAt]?.scrollIntoView();
    updateSub();
  }

  async function loadWt(i) {
    const item = wtItems[i];
    const img = item?.firstChild;
    if (!img || img.getAttribute('src')) return;
    try {
      const url = await cache.url(i);
      if (closed || img.getAttribute('src')) return;
      img.onload = () => { item.style.minHeight = '0'; item.style.height = ''; };
      img.src = url;
    } catch {
      item.classList.add('wt-error');
    }
  }

  function trimWebtoon() {
    const keep = new Set();
    for (let i = idx - 6; i <= idx + 8; i++) if (i >= 0 && i < arch.count) keep.add(i);
    wtItems.forEach((item, i) => {
      if (keep.has(i)) return;
      const img = item.firstChild;
      if (img.getAttribute('src')) {
        item.style.minHeight = item.offsetHeight + 'px';
        img.removeAttribute('src');
      }
    });
    cache.trim(keep);
  }

  function onWtScroll() {
    timer.poke();
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const mid = stage.scrollTop + stage.clientHeight * 0.35;
      let i = Math.min(idx, wtItems.length - 1);
      while (i > 0 && wtItems[i].offsetTop > mid) i--;
      while (i < wtItems.length - 1 && wtItems[i].offsetTop + wtItems[i].offsetHeight < mid) i++;
      const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 8;
      if (atEnd) i = wtItems.length - 1;
      if (i !== idx) { noteIndex(i); trimWebtoon(); }
    });
  }
  stage.addEventListener('scroll', () => mode === 'webtoon' && onWtScroll(), { passive: true });
  let wtDown = null;
  stage.addEventListener('pointerdown', (e) => { if (mode === 'webtoon') wtDown = { x: e.clientX, y: e.clientY }; timer.poke(); });
  stage.addEventListener('pointerup', (e) => {
    if (mode !== 'webtoon' || !wtDown) return;
    if (Math.hypot(e.clientX - wtDown.x, e.clientY - wtDown.y) < 8) setUi(!uiVisible);
    wtDown = null;
  });

  // ---------------- mode / navigation ----------------
  function applyMode(startAt = idx) {
    root.dataset.mode = mode;
    stage.classList.toggle('webtoon', mode === 'webtoon');
    io?.disconnect();
    if (mode === 'webtoon') {
      buildWebtoon(startAt);
    } else {
      stage.scrollTop = 0;
      showPaged(startAt);
    }
  }

  function goTo(i) {
    i = Math.min(Math.max(i, 0), arch.count - 1);
    if (mode === 'webtoon') {
      wtItems[i]?.scrollIntoView();
      noteIndex(i);
      trimWebtoon();
      loadWt(i);
    } else {
      showPaged(i);
    }
  }

  slider.oninput = () => { subEl.textContent = `Go to page ${slider.value} / ${arch.count}`; };
  slider.onchange = () => goTo(Number(slider.value) - 1);

  // ---------------- settings sheet ----------------
  const sheet = $('#rd-sheet');
  function renderSheet() {
    const s = getSettings();
    sheet.innerHTML = `
      <div class="sheet-grab"></div>
      <h3>Reading settings</h3>
      <label class="row-label">Mode</label>
      <div class="seg" data-key="mode">
        <button data-v="paged-rtl" class="${mode === 'paged-rtl' ? 'on' : ''}">Manga<small>right → left</small></button>
        <button data-v="paged-ltr" class="${mode === 'paged-ltr' ? 'on' : ''}">Comic<small>left → right</small></button>
        <button data-v="webtoon" class="${mode === 'webtoon' ? 'on' : ''}">Webtoon<small>vertical</small></button>
      </div>
      <label class="row-label">Page fit</label>
      <div class="seg" data-key="fit">
        ${[['screen', 'Fit screen'], ['width', 'Fit width'], ['height', 'Fit height']].map(([v, l]) => `<button data-v="${v}" class="${s.fit === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <label class="row-label">Background</label>
      <div class="seg" data-key="readerBg">
        ${[['black', 'Black'], ['gray', 'Gray'], ['white', 'White']].map(([v, l]) => `<button data-v="${v}" class="${s.readerBg === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <label class="row-label">Dim screen <span id="dimv">${Math.round(s.dim * 100)}%</span></label>
      <input type="range" id="dim-range" min="0" max="70" value="${Math.round(s.dim * 100)}">
      <div class="toggle-row"><span>Double-page spread in landscape</span><button class="switch ${s.spread ? 'on' : ''}" data-toggle="spread"></button></div>
      <div class="toggle-row"><span>Swap tap zones</span><button class="switch ${s.invertTaps ? 'on' : ''}" data-toggle="invertTaps"></button></div>
      <button class="btn wide" id="sheet-close">Done</button>`;
    sheet.querySelectorAll('.seg').forEach((seg) =>
      seg.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          const key = seg.dataset.key;
          if (key === 'mode') {
            mode = b.dataset.v;
            book.mode = mode;
            applyMode(idx);
          } else {
            setSetting(key, b.dataset.v);
            applyLook();
            if (key === 'fit') resetZoom();
          }
          renderSheet();
        })
      )
    );
    sheet.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.toggle;
        setSetting(k, !getSettings()[k]);
        if (k === 'spread') showPaged(idx);
        renderSheet();
      })
    );
    $('#dim-range', sheet).oninput = (e) => {
      const v = Number(e.target.value) / 100;
      setSetting('dim', v);
      applyLook();
      $('#dimv', sheet).textContent = Math.round(v * 100) + '%';
    };
    $('#sheet-close', sheet).onclick = () => (sheet.hidden = true);
  }
  $('#rd-gear').onclick = () => { renderSheet(); sheet.hidden = !sheet.hidden; };

  // ---------------- close ----------------
  async function close(fromPop = false) {
    if (closed) return;
    closed = true;
    clearTimeout(saveT);
    clearTimeout(uiTimer);
    await timer.stop();
    await db.update('books', book.id, (b) => {
      if (!b) return undefined;
      b.page = idx;
      b.maxPage = Math.max(b.maxPage || 0, maxSeen);
      b.lastRead = Date.now();
      b.finished = b.finished || idx >= arch.count - 1;
      b.mode = mode;
      b.pageCount = arch.count;
      return b;
    });
    io?.disconnect();
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerUp);
    cache.dispose();
    arch.close();
    try { await wake?.release(); } catch {}
    document.removeEventListener('visibilitychange', onVis);
    stage.innerHTML = '';
    sheet.hidden = true;
    root.hidden = true;
    root.classList.remove('ui-hidden');
    if (!fromPop && history.state?.view === 'reader') history.back();
    hooks.onClose?.();
  }

  const onVis = async () => {
    if (document.visibilityState === 'hidden') { await timer.flush(); saveProgress(); }
    else if (getSettings().keepAwake) requestWake();
  };
  document.addEventListener('visibilitychange', onVis);

  async function requestWake() {
    try { if ('wakeLock' in navigator && !closed) wake = await navigator.wakeLock.request('screen'); } catch {}
  }
  if (getSettings().keepAwake) requestWake();

  $('#rd-back').onclick = () => close();
  history.pushState({ view: 'reader' }, '');
  const onPop = () => { window.removeEventListener('popstate', onPop); close(true); };
  window.addEventListener('popstate', onPop);

  setUi(true);
  applyMode(idx);
  // hide the chrome shortly after opening so the first page is clean
  setTimeout(() => !closed && setUi(false), 1800);
}
