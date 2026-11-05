import { db, getSettings, setSetting, resetSettings } from './db.js';
import { openBook, makeCover, sniff, extOf, SUPPORTED_EXT } from './archive.js';
import { openReader } from './reader.js';
import { summary, fmtDuration } from './stats.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  open: '<svg viewBox="0 0 24 24"><path d="M5 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H5zM19 4h-5"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 1 3 6.2M4 19v-5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// ---------------- theme ----------------
function applyTheme() {
  const s = getSettings();
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty('--accent', s.accent);
  const bg = { dark: '#0e0f13', amoled: '#000000', light: '#f4f5f9', sepia: '#f1e7d3' }[s.theme];
  $('meta[name=theme-color]').setAttribute('content', bg);
}
applyTheme();

// ---------------- toast / busy / sheets ----------------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2200);
}

function openSheet(html, { onMount, dismissable = true } = {}) {
  const root = $('#sheet-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const sh = document.createElement('div');
  sh.className = 'sheet';
  sh.innerHTML = `<div class="sheet-grab"></div>${html}`;
  root.append(scrim, sh);
  requestAnimationFrame(() => { scrim.classList.add('in'); sh.classList.add('in'); });
  const close = () => {
    scrim.classList.remove('in');
    sh.classList.remove('in');
    setTimeout(() => { scrim.remove(); sh.remove(); }, 220);
  };
  if (dismissable) scrim.onclick = close;
  onMount?.(sh, close);
  return { el: sh, close };
}

function actionSheet(title, subtitle, actions) {
  const html = `<h3>${esc(title)}</h3>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}` +
    actions.map((a, i) => `<button class="action ${a.danger ? 'danger' : ''}" data-i="${i}">${a.icon || ''}<span>${esc(a.label)}</span></button>`).join('');
  openSheet(html, {
    onMount: (sh, close) => $$('.action', sh).forEach((b) => (b.onclick = () => { close(); actions[Number(b.dataset.i)].run(); })),
  });
}

function confirmSheet(title, text, okLabel, onOk, danger = true) {
  openSheet(`<h3>${esc(title)}</h3><p class="sub">${esc(text)}</p><button class="btn wide ${danger ? 'danger' : ''}" id="ok">${esc(okLabel)}</button><button class="btn wide ghost" id="no">Cancel</button>`, {
    onMount: (sh, close) => { $('#ok', sh).onclick = () => { close(); onOk(); }; $('#no', sh).onclick = close; },
  });
}

function promptSheet(title, value, placeholder, onSave) {
  openSheet(`<h3>${esc(title)}</h3><input class="field" id="f" value="${esc(value)}" placeholder="${esc(placeholder || '')}"><button class="btn wide" id="ok">Save</button>`, {
    onMount: (sh, close) => {
      const f = $('#f', sh);
      setTimeout(() => f.focus(), 250);
      const go = () => { close(); onSave(f.value.trim()); };
      $('#ok', sh).onclick = go;
      f.onkeydown = (e) => e.key === 'Enter' && go();
    },
  });
}

function busySheet(text) {
  const s = openSheet(`<div class="busy-card"><div class="spin"></div><div id="bt">${esc(text)}</div><div class="meter"><i id="bm"></i></div></div>`, { dismissable: false });
  return {
    set(t, frac) { $('#bt', s.el).textContent = t; if (frac != null) $('#bm', s.el).style.width = Math.round(frac * 100) + '%'; },
    close: s.close,
  };
}

// ---------------- state ----------------
let books = [];
const coverUrls = new Map();
const ui = { filter: 'all', tag: null, sort: 'recent', q: '' };

async function loadBooks() {
  books = await db.all('books');
}

function coverUrl(b) {
  if (!b.cover) return null;
  if (!coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover));
  return coverUrls.get(b.id);
}

// ---------------- library ----------------
const pct = (b) => (b.pageCount > 1 ? Math.min(100, Math.round((((b.finished ? b.pageCount - 1 : b.page) || 0) / (b.pageCount - 1)) * 100)) : 0);

function cardHtml(b) {
  const url = coverUrl(b);
  const p = pct(b);
  const sub = b.finished ? 'Finished' : b.page > 0 ? `${p}% · p.${b.page + 1}/${b.pageCount}` : `${b.pageCount} pages`;
  return `<div class="card" data-id="${b.id}">
    <div class="cover">
      ${url ? `<img src="${url}" alt="" loading="lazy">` : `<div class="noimg">${esc((b.title || '?').slice(0, 1).toUpperCase())}</div>`}
      <span class="badge">${esc(b.kind)}</span>
      ${b.favorite ? '<span class="favmark">♥</span>' : ''}
      ${b.finished ? '<span class="done-mark">✓</span>' : ''}
      ${p > 0 && !b.finished ? `<div class="pbar"><i style="width:${p}%"></i></div>` : ''}
    </div>
    <div class="t">${esc(b.title)}</div>
    <div class="s">${esc(sub)}</div>
  </div>`;
}

function visibleBooks() {
  const q = ui.q.toLowerCase();
  let list = books.filter((b) => {
    if (q && !(b.title.toLowerCase().includes(q) || (b.tags || []).some((t) => t.toLowerCase().includes(q)))) return false;
    if (ui.tag && !(b.tags || []).includes(ui.tag)) return false;
    switch (ui.filter) {
      case 'reading': return b.page > 0 && !b.finished;
      case 'unread': return !b.page && !b.finished;
      case 'finished': return b.finished;
      case 'fav': return b.favorite;
      default: return true;
    }
  });
  const cmp = {
    recent: (a, b) => (b.lastRead || b.added) - (a.lastRead || a.added),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
    added: (a, b) => b.added - a.added,
    progress: (a, b) => pct(b) - pct(a),
  }[ui.sort];
  return list.sort(cmp);
}

function renderChips() {
  const tags = [...new Set(books.flatMap((b) => b.tags || []))].sort();
  const base = [['all', 'All'], ['reading', 'Reading'], ['unread', 'Unread'], ['finished', 'Finished'], ['fav', '♥ Favorites']];
  $('#chips').innerHTML =
    base.map(([k, l]) => `<button class="chip ${ui.filter === k && !ui.tag ? 'on' : ''}" data-f="${k}">${l}</button>`).join('') +
    tags.map((t) => `<button class="chip ${ui.tag === t ? 'on' : ''}" data-tag="${esc(t)}"># ${esc(t)}</button>`).join('');
}

function renderLibrary() {
  renderChips();
  const empty = books.length === 0;
  $('#empty').hidden = !empty;
  $('#grid').hidden = empty;
  $('#all-title').hidden = empty;
  $('#chips').hidden = empty;
  $('.search').hidden = empty;
  $('#btn-sort').hidden = empty;

  const cont = books.filter((b) => b.page > 0 && !b.finished).sort((a, b) => b.lastRead - a.lastRead).slice(0, 10);
  const showCont = cont.length > 0 && !ui.q && ui.filter === 'all' && !ui.tag;
  $('#continue-wrap').hidden = !showCont;
  $('#continue').innerHTML = cont.map(cardHtml).join('');

  const list = visibleBooks();
  $('#all-title').textContent = ui.q || ui.filter !== 'all' || ui.tag ? `${list.length} result${list.length === 1 ? '' : 's'}` : `All books · ${list.length}`;
  $('#grid').innerHTML = list.map(cardHtml).join('');
}

async function refreshLibrary() {
  await loadBooks();
  renderLibrary();
}

// ---------------- import ----------------
async function importFiles(fileList) {
  const files = [...fileList].filter((f) => SUPPORTED_EXT.includes(extOf(f.name)));
  const skipped = fileList.length - files.length;
  if (!files.length) { toast('No supported comic files selected'); return; }
  try { await navigator.storage?.persist?.(); } catch {}

  const busy = busySheet('Importing…');
  let ok = 0;
  const failed = [];
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    busy.set(`(${n + 1}/${files.length}) ${f.name}`, n / files.length);
    try {
      if (books.some((b) => b.filename === f.name && b.size === f.size)) { failed.push(`${f.name} (already added)`); continue; }
      const kind = (await sniff(f, f.name)) === 'pdf' ? 'PDF' : extOf(f.name).toUpperCase();
      const arch = await openBook(f, f.name);
      const cover = await makeCover(await arch.getPage(0));
      const id = crypto.randomUUID();
      const title = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
      await db.put('files', f, id);
      await db.put('books', {
        id, title, filename: f.name, size: f.size, kind, pageCount: arch.count,
        page: 0, maxPage: 0, added: Date.now(), lastRead: 0, finished: false,
        favorite: false, tags: [], cover, seconds: 0,
      });
      arch.close();
      ok++;
    } catch (e) {
      console.error(e);
      failed.push(`${f.name} (${e.message || 'failed'})`);
    }
  }
  busy.close();
  await refreshLibrary();
  if (ok) toast(`Added ${ok} ${ok === 1 ? 'book' : 'books'}${failed.length ? ` · ${failed.length} skipped` : ''}`);
  if (failed.length) setTimeout(() => openSheet(`<h3>Some files were skipped</h3><p class="sub">${failed.map(esc).join('<br>')}${skipped ? `<br>${skipped} unsupported file type(s)` : ''}</p>`), ok ? 2400 : 300);
}

// ---------------- book actions ----------------
async function open(id) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  try {
    await openReader(b, { toast, onClose: refreshLibrary });
  } catch (e) {
    console.error(e);
    toast(`Couldn't open: ${e.message || e}`);
  }
}

function bookMenu(id) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  const upd = (fn) => db.update('books', id, (x) => { if (x) fn(x); return x; }).then(refreshLibrary);
  actionSheet(b.title, `${b.kind} · ${b.pageCount} pages · ${fmtDuration(b.seconds || 0)} read`, [
    { icon: ICON.open, label: b.page > 0 && !b.finished ? 'Continue reading' : 'Read', run: () => open(id) },
    { icon: ICON.heart, label: b.favorite ? 'Remove from favorites' : 'Add to favorites', run: () => upd((x) => (x.favorite = !x.favorite)) },
    b.finished || b.page > 0
      ? { icon: ICON.reset, label: 'Mark as unread', run: () => upd((x) => { x.page = 0; x.maxPage = 0; x.finished = false; }) }
      : { icon: ICON.check, label: 'Mark as finished', run: () => upd((x) => { x.finished = true; x.page = x.pageCount - 1; }) },
    { icon: ICON.edit, label: 'Rename', run: () => promptSheet('Rename', b.title, 'Title', (v) => v && upd((x) => (x.title = v))) },
    { icon: ICON.tag, label: 'Edit tags / collection', run: () => promptSheet('Tags (comma separated)', (b.tags || []).join(', '), 'e.g. shonen, ongoing', (v) => upd((x) => (x.tags = [...new Set(v.split(',').map((t) => t.trim()).filter(Boolean))]))) },
    { icon: ICON.trash, label: 'Delete from device', danger: true, run: () => confirmSheet('Delete this book?', 'The stored copy and its reading progress will be removed from Inkpage. Your original file is untouched.', 'Delete', async () => {
      await db.del('books', id);
      await db.del('files', id);
      if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
      await refreshLibrary();
      toast('Deleted');
    }) },
  ]);
}

// long-press + tap on cards
function wireCards(container) {
  let timer = null, startX = 0, startY = 0, longFired = false;
  container.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    longFired = false;
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => { longFired = true; navigator.vibrate?.(15); bookMenu(card.dataset.id); }, 480);
  });
  const cancel = () => clearTimeout(timer);
  container.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); });
  container.addEventListener('pointerup', cancel);
  container.addEventListener('pointercancel', cancel);
  container.addEventListener('contextmenu', (e) => e.preventDefault());
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card || longFired) { longFired = false; return; }
    open(card.dataset.id);
  });
}
wireCards($('#grid'));
wireCards($('#continue'));

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.tag) { ui.tag = ui.tag === b.dataset.tag ? null : b.dataset.tag; ui.filter = 'all'; }
  else { ui.filter = b.dataset.f; ui.tag = null; }
  renderLibrary();
});
$('#search').addEventListener('input', (e) => { ui.q = e.target.value.trim(); renderLibrary(); });
$('#btn-sort').onclick = () => {
  const mk = (key, label) => ({ label: (ui.sort === key ? '● ' : '○ ') + label, run: () => { ui.sort = key; renderLibrary(); } });
  actionSheet('Sort by', '', [mk('recent', 'Recently read'), mk('added', 'Recently added'), mk('title', 'Title A–Z'), mk('progress', 'Progress')]);
};

const picker = $('#picker');
const pick = () => picker.click();
$('#fab').onclick = pick;
$('#empty-add').onclick = pick;
picker.onchange = async () => { const fs = [...picker.files]; picker.value = ''; if (fs.length) await importFiles(fs); };

// ---------------- stats ----------------
async function renderStats() {
  const s = await summary(getSettings().dailyGoal);
  const frac = Math.min(1, s.todaySeconds / s.goalSeconds);
  const C = 2 * Math.PI * 46;
  const max = Math.max(60, ...s.last7.map((d) => d.seconds));
  const msg = frac >= 1 ? 'Daily goal reached 🎉' : `${fmtDuration(s.goalSeconds - s.todaySeconds)} to go`;
  $('#stats-body').innerHTML = `
    <div class="stat-hero">
      <div class="ring"><svg viewBox="0 0 112 112"><circle class="bg" cx="56" cy="56" r="46"/><circle class="fg" cx="56" cy="56" r="46" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
        <div class="mid"><b>${fmtDuration(s.todaySeconds)}</b><span>today</span></div></div>
      <div class="hero-txt"><h3>${msg}</h3><p>Goal: ${getSettings().dailyGoal} min / day</p></div>
    </div>
    <div class="tiles">
      <div class="tile"><b>${s.streak} day${s.streak === 1 ? '' : 's'}</b><span>Reading streak</span></div>
      <div class="tile"><b>${fmtDuration(s.weekSeconds)}</b><span>Last 7 days</span></div>
      <div class="tile"><b>${fmtDuration(s.totalSeconds)}</b><span>Total reading time</span></div>
      <div class="tile"><b>${s.totalPages.toLocaleString()}</b><span>Pages read</span></div>
      <div class="tile"><b>${s.finished}</b><span>Books finished</span></div>
      <div class="tile"><b>${books.length}</b><span>In library</span></div>
    </div>
    <div class="panel"><h4>This week</h4><div class="bars">
      ${s.last7.map((d, i) => `<div class="col ${i === 6 ? 'today' : ''}"><em>${d.seconds >= 60 ? Math.round(d.seconds / 60) + 'm' : ''}</em><i style="height:${Math.max(4, (d.seconds / max) * 100)}%"></i><small>${esc(d.label)}</small></div>`).join('')}
    </div></div>
    ${s.top.length ? `<div class="panel"><h4>Most read</h4><div class="toplist">${s.top.map((b) => `<div class="toprow"><span>${esc(b.title)}</span><span>${fmtDuration(b.seconds)}</span></div>`).join('')}</div></div>` : ''}`;
}

// ---------------- settings ----------------
const ACCENTS = ['#7c9cff', '#ff7a90', '#46d3a7', '#ffb454', '#c58bff', '#4fc3f7'];

async function renderSettings() {
  const s = getSettings();
  let storage = '';
  try {
    const e = await navigator.storage.estimate();
    storage = `${(e.usage / 1048576).toFixed(0)} MB used`;
  } catch {}
  const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${s[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  $('#settings-body').innerHTML = `
    <div class="group"><h4>Appearance</h4>
      <div class="srow" style="display:block">${seg('theme', [['dark', 'Dark'], ['amoled', 'AMOLED'], ['light', 'Light'], ['sepia', 'Sepia']])}</div>
      <div class="srow"><span>Accent colour</span><div class="swatches">${ACCENTS.map((c) => `<button class="swatch ${s.accent === c ? 'on' : ''}" data-accent="${c}" style="background:${c}"></button>`).join('')}</div></div>
    </div>
    <div class="group"><h4>Reading defaults</h4>
      <div class="srow" style="display:block"><div style="margin-bottom:8px">Reading mode</div>${seg('mode', [['paged-rtl', 'Manga'], ['paged-ltr', 'Comic'], ['webtoon', 'Webtoon']])}</div>
      <div class="srow" style="display:block"><div style="margin-bottom:8px">Page fit</div>${seg('fit', [['screen', 'Screen'], ['width', 'Width'], ['height', 'Height']])}</div>
      <div class="srow"><span>Double-page spread<small>Landscape only</small></span><button class="switch ${s.spread ? 'on' : ''}" data-toggle="spread"></button></div>
      <div class="srow"><span>Swap tap zones</span><button class="switch ${s.invertTaps ? 'on' : ''}" data-toggle="invertTaps"></button></div>
      <div class="srow"><span>Keep screen on while reading</span><button class="switch ${s.keepAwake ? 'on' : ''}" data-toggle="keepAwake"></button></div>
    </div>
    <div class="group"><h4>Goals</h4>
      <div class="srow"><span>Daily reading goal</span><div class="stepper"><button data-goal="-5">−</button><b>${s.dailyGoal} min</b><button data-goal="5">+</button></div></div>
    </div>
    <div class="group"><h4>Data</h4>
      <div class="srow"><span>Storage<small>${esc(storage)} · ${books.length} books</small></span></div>
      <div class="srow"><button class="btn danger" id="wipe">Delete all books &amp; stats</button></div>
    </div>
    <p class="about">Inkpage keeps everything on this device.<br>No ads · No accounts · No subscriptions · No tracking.<br>Supports CBZ, CBR, CB7, CBT, PDF and EPUB.</p>`;

  $$('#settings-body .seg').forEach((sg) => $$('button', sg).forEach((b) => (b.onclick = () => { setSetting(sg.dataset.key, b.dataset.v); applyTheme(); renderSettings(); })));
  $$('#settings-body [data-accent]').forEach((b) => (b.onclick = () => { setSetting('accent', b.dataset.accent); applyTheme(); renderSettings(); }));
  $$('#settings-body [data-toggle]').forEach((b) => (b.onclick = () => { setSetting(b.dataset.toggle, !getSettings()[b.dataset.toggle]); renderSettings(); }));
  $$('#settings-body [data-goal]').forEach((b) => (b.onclick = () => { setSetting('dailyGoal', Math.min(240, Math.max(5, getSettings().dailyGoal + Number(b.dataset.goal)))); renderSettings(); }));
  $('#wipe').onclick = () => confirmSheet('Delete everything?', 'All stored books, progress and reading stats will be removed. This cannot be undone.', 'Delete everything', async () => {
    await Promise.all(['books', 'files', 'days', 'kv'].map((st) => db.clear(st)));
    coverUrls.forEach((u) => URL.revokeObjectURL(u));
    coverUrls.clear();
    resetSettings();
    applyTheme();
    await refreshLibrary();
    renderSettings();
    toast('Everything deleted');
  });
}

// ---------------- tabs ----------------
function showTab(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#fab').classList.toggle('gone', name !== 'library');
  $('#views').scrollTop = 0;
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
  if (name === 'library') renderLibrary();
}
$$('#tabbar button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------------- boot ----------------
refreshLibrary().catch((e) => { console.error(e); toast('Could not load library'); });
