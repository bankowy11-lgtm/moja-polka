// Czytnik: dzieli rozdział na strony (kolumny CSS) i przewraca kartki w 3D.
// Na ekranie istnieją naraz najwyżej dwie strony, więc nawet gruba książka działa płynnie.
import { db } from './db.js';

const $ = id => document.getElementById(id);
const GAP = 40;                       // odstęp między kolumnami (stronami) w px
const SETTINGS_KEY = 'mp-settings';

const ui = {
  reader: $('reader'), stage: $('stage'), measure: $('measure'),
  title: $('rTitle'), seek: $('seek'), seekInfo: $('seekInfo'),
  bmBtn: $('bmBtn'), tocPanel: $('tocPanel'), setPanel: $('setPanel'),
  tocList: $('tocList'), bmList: $('bmList'), fnPop: $('fnPop'), fnText: $('fnText'),
  fontVal: $('fontVal'),
};

/* ---------- Ustawienia ---------- */

function loadSettings() {
  const def = { fontSize: innerWidth < 600 ? 20 : 21, theme: 'light', font: 'serif', lh: '1.65' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return def; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* bez zapisu */ }
}
const S = loadSettings();

/* ---------- Stan ---------- */

let book = null, content = null, coverUrl = null;
let opts = {};
let geo = null;            // wymiary strony
let counts = [];           // liczba stron w każdym rozdziale (liczona na żądanie)
let templates = [];        // gotowe szablony rozdziałów
let prefix = [], total = 1;// znaki – do procentu przeczytania
let pos = { ch: 0, pg: 0 };
let curEl = null;
let flip = null;           // trwające przewracanie
let saveTimer = 0;

/* ---------- Geometria i podział na strony ---------- */

function applyLook() {
  ui.reader.dataset.theme = S.theme;
  ui.reader.style.setProperty('--fs', S.fontSize + 'px');
  ui.reader.style.setProperty('--lh', S.lh);
  ui.reader.style.setProperty('--ff', S.font === 'sans'
    ? 'system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif'
    : 'Georgia, "Noto Serif", "Droid Serif", "Times New Roman", serif');
  ui.fontVal.textContent = S.fontSize;
  for (const [segId, val] of [['themeSeg', S.theme], ['fontSeg', S.font], ['lhSeg', S.lh]]) {
    for (const b of $(segId).querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === val);
  }
}

function computeGeometry() {
  const vw = innerWidth, vh = innerHeight;
  const wide = vw >= 700;
  const pageW = Math.floor(wide ? Math.min(vw - 48, 680) : vw);
  const pageH = Math.floor(wide ? Math.min(vh - 40, 1100) : vh);
  const padX = Math.round(Math.min(48, Math.max(20, pageW * 0.065)));
  const padTop = wide ? 40 : 26, padBottom = 46;
  geo = {
    pageW, pageH, padX, padTop, padBottom,
    W: pageW - 2 * padX,
    H: pageH - padTop - padBottom,
  };
  const st = ui.reader.style;
  st.setProperty('--pw', pageW + 'px');
  st.setProperty('--ph', pageH + 'px');
  st.setProperty('--px', padX + 'px');
  st.setProperty('--pt', padTop + 'px');
  st.setProperty('--pb', padBottom + 'px');
  st.setProperty('--cw', geo.W + 'px');
  st.setProperty('--chh', geo.H + 'px');
  st.setProperty('--gap', GAP + 'px');
  counts = [];
}

function chapterNode(ch) {
  if (!templates[ch]) {
    const t = document.createElement('template');
    t.innerHTML = `<div class="cols" lang="${book.lang || 'pl'}">${content.chapters[ch].html}</div>`;
    templates[ch] = t;
  }
  return templates[ch].content.firstElementChild.cloneNode(true);
}

function count(ch) {
  if (ch < 0) return 1;
  if (counts[ch] == null) {
    const node = chapterNode(ch);
    node.style.overflow = 'hidden';
    ui.measure.replaceChildren(node);
    counts[ch] = Math.max(1, Math.round((node.scrollWidth + GAP) / (geo.W + GAP)));
    ui.measure.replaceChildren();
  }
  return counts[ch];
}

const hasCover = () => true; // zawsze pokazujemy okładkę (z pliku albo wygenerowaną)

function nextPos(p) {
  if (p.ch < 0) return { ch: 0, pg: 0 };
  if (p.pg + 1 < count(p.ch)) return { ch: p.ch, pg: p.pg + 1 };
  if (p.ch + 1 < content.chapters.length) return { ch: p.ch + 1, pg: 0 };
  return null;
}
function prevPos(p) {
  if (p.ch < 0) return null;
  if (p.pg > 0) return { ch: p.ch, pg: p.pg - 1 };
  if (p.ch > 0) return { ch: p.ch - 1, pg: count(p.ch - 1) - 1 };
  return hasCover() ? { ch: -1, pg: 0 } : null;
}

// Miejsce w rozdziale zapisujemy jako ułamek (początek strony), więc po zmianie
// wielkości liter wracamy dokładnie do tego samego fragmentu tekstu.
const fracOf = p => (p.ch < 0 ? 0 : p.pg / count(p.ch));
const pageAt = (ch, frac) => Math.max(0, Math.min(count(ch) - 1, Math.floor((frac || 0) * count(ch) + 1e-6)));
function percentOf(p) {
  if (p.ch < 0) return 0;
  const n = count(p.ch);
  const inCh = n > 1 ? p.pg / n : 0;
  const isLast = p.ch === content.chapters.length - 1 && p.pg === n - 1;
  return isLast ? 100 : Math.min(99, Math.floor(((prefix[p.ch] + content.chapters[p.ch].chars * inCh) / total) * 100));
}

/* ---------- Budowanie strony ---------- */

function isBookmarked(p) {
  return p.ch >= 0 && (book.bookmarks || []).some(b => b.ch === p.ch && pageAt(b.ch, b.frac) === p.pg);
}

function buildPage(p) {
  const page = document.createElement('div');
  page.className = 'page';
  if (p.ch < 0) {
    page.classList.add('cover-page');
    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = 'Okładka: ' + book.title;
      page.appendChild(img);
    } else {
      page.innerHTML = `<div class="gen-cover" style="--hue:${book.hue || 140}"><div><h2></h2><p></p></div></div>`;
      page.querySelector('h2').textContent = book.title;
      page.querySelector('p').textContent = book.author || '';
    }
    const hint = document.createElement('div');
    hint.className = 'cover-hint';
    hint.textContent = 'Przesuń palcem w lewo, aby zacząć czytać';
    page.appendChild(hint);
    return page;
  }
  const box = document.createElement('div');
  box.className = 'page-box';
  const cols = chapterNode(p.ch);
  cols.style.transform = `translateX(${-p.pg * (geo.W + GAP)}px)`;
  box.appendChild(cols);
  const foot = document.createElement('div');
  foot.className = 'page-foot';
  const left = document.createElement('span');
  left.textContent = content.chapters[p.ch].title;
  const right = document.createElement('span');
  right.textContent = `${p.pg + 1} / ${count(p.ch)}`;
  foot.append(left, right);
  page.append(box, foot);
  if (isBookmarked(p)) {
    const r = document.createElement('div');
    r.className = 'ribbon';
    page.appendChild(r);
  }
  return page;
}

let anchor = null; // miejsce czytania sprzed zmiany wyglądu – chroni przed „uciekaniem” strony

function show(p, keepAnchor = false) {
  if (!keepAnchor) anchor = null;
  pos = p;
  curEl = buildPage(p);
  ui.stage.replaceChildren(curEl);
  afterMove();
}

function afterMove() {
  const pc = percentOf(pos);
  ui.seek.value = Math.round(pc * 10);
  ui.seekInfo.textContent = pos.ch < 0 ? 'Okładka' : `${content.chapters[pos.ch].title} · ${pc}%`;
  ui.bmBtn.classList.toggle('on', isBookmarked(pos));
  book.progress = { ch: pos.ch, frac: anchor ?? fracOf(pos), percent: pc };
  book.lastOpened = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.putBook(book).catch(() => {}), 400);
}

/* ---------- Przewracanie kartek ---------- */

function startFlip(dir) {
  if (flip) finishNow();
  const target = dir > 0 ? nextPos(pos) : prevPos(pos);
  if (!target) {
    if (dir > 0 && pos.ch >= 0) opts.toast?.('To już koniec książki!');
    return null;
  }
  const other = buildPage(target);
  const flipper = document.createElement('div');
  flipper.className = 'flipper';
  const back = document.createElement('div');
  back.className = 'face back';
  const shade = document.createElement('div');
  shade.className = 'flip-shade';
  const underShade = document.createElement('div');
  underShade.className = 'under-shade';
  let under, front;
  if (dir > 0) {               // bieżąca kartka odchodzi w lewo, pod nią następna
    under = other; front = curEl;
    ui.stage.prepend(under);
    curEl.replaceWith(flipper);
  } else {                     // poprzednia kartka wraca z lewej na bieżącą
    under = curEl; front = other;
    ui.stage.appendChild(flipper);
  }
  front.classList.add('face', 'front');
  front.appendChild(shade);
  under.appendChild(underShade);
  flipper.append(front, back);
  flip = { dir, target, flipper, front, under, shade, underShade, edge: dir > 0 ? geo.pageW : -geo.pageW, raf: 0 };
  setEdge(flip.edge);
  return flip;
}

// edge = położenie wolnego brzegu kartki względem grzbietu (od +szerokości do −szerokości)
function setEdge(edge) {
  const w = geo.pageW;
  const x = Math.max(-1, Math.min(1, edge / w));
  flip.edge = x * w;
  const deg = -Math.acos(x) * 180 / Math.PI;
  const t = -deg / 180;                       // 0 = leży płasko, 1 = przewrócona
  flip.flipper.style.transform = `rotateY(${deg}deg)`;
  flip.shade.style.opacity = (t * 0.55).toFixed(3);
  flip.underShade.style.opacity = ((1 - t) * 0.7).toFixed(3);
  flip.flipper.style.setProperty('--lift', Math.sin(t * Math.PI).toFixed(3));
}

function animateTo(complete, duration) {
  const f = flip;
  const from = f.edge;
  const w = geo.pageW;
  const to = f.dir > 0 ? (complete ? -w : w) : (complete ? w : -w);
  const dist = Math.abs(to - from) / (2 * w);
  const dur = duration ?? 140 + 420 * dist;
  const t0 = performance.now();
  const ease = duration ? (k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)) : (k => 1 - Math.pow(1 - k, 3));
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    setEdge(from + (to - from) * ease(k));
    if (k < 1) f.raf = requestAnimationFrame(step);
    else endFlip(complete);
  };
  f.complete = complete;
  f.raf = requestAnimationFrame(step);
  // Zabezpieczenie: gdy przeglądarka wstrzyma animację (np. ekran zgaśnie), kartka i tak się dokończy.
  f.timer = setTimeout(() => { if (flip === f) endFlip(complete); }, dur + 200);
}

function endFlip(complete) {
  const f = flip;
  if (!f) return;
  cancelAnimationFrame(f.raf);
  clearTimeout(f.timer);
  flip = null;
  f.shade.remove();
  f.underShade.remove();
  f.front.classList.remove('face', 'front');
  // dalej: zostaje następna (pod spodem); wstecz: zostaje poprzednia (przewracana)
  const keep = complete ? (f.dir > 0 ? f.under : f.front) : (f.dir > 0 ? f.front : f.under);
  curEl = keep;
  ui.stage.replaceChildren(keep);
  if (complete) { pos = f.target; anchor = null; afterMove(); }
}

function finishNow() { if (flip) endFlip(flip.complete ?? true); }

function turn(dir) {
  hideBars();
  if (startFlip(dir)) animateTo(true, 620);
}

/* ---------- Dotyk i mysz ---------- */

let ptr = null;

function onDown(e) {
  if (e.button > 0 || !book) return;
  ptr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), drag: false, hist: [] };
}

function onMove(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  if (!ptr.drag) {
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
    hideBars();
    if (!startFlip(dx < 0 ? 1 : -1)) { ptr = null; return; }
    ptr.drag = true;
    ptr.edge0 = flip.edge;
    ptr.x0 = e.clientX;
    try { ui.stage.setPointerCapture(e.pointerId); } catch { /* ok */ }
  }
  const now = performance.now();
  ptr.hist.push([now, e.clientX]);
  while (ptr.hist.length > 2 && now - ptr.hist[0][0] > 100) ptr.hist.shift();
  setEdge(ptr.edge0 + (e.clientX - ptr.x0) * 1.15);
}

function onUp(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = ptr;
  ptr = null;
  if (p.drag && flip) {
    const h = p.hist;
    const v = h.length > 1 ? (h[h.length - 1][1] - h[0][1]) / Math.max(1, h[h.length - 1][0] - h[0][0]) : 0;
    const w = geo.pageW;
    const complete = flip.dir > 0
      ? (v < -0.35 || (flip.edge < w * 0.55 && v < 0.35))
      : (v > 0.35 || (flip.edge > -w * 0.55 && v > -0.35));
    animateTo(complete);
    return;
  }
  if (e.type === 'pointercancel') return;
  // Stuknięcie
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const fn = hit?.closest?.('.fn');
  if (fn && content.notes[fn.dataset.fn]) { showNote(content.notes[fn.dataset.fn]); return; }
  const x = e.clientX / innerWidth;
  if (x > 0.68) turn(1);
  else if (x < 0.32) turn(-1);
  else toggleBars();
}

/* ---------- Paski, panele, przypisy ---------- */

const barsVisible = () => ui.reader.classList.contains('bars');
function toggleBars() { ui.reader.classList.toggle('bars'); }
function hideBars() { ui.reader.classList.remove('bars'); }

function showNote(text) {
  ui.fnText.textContent = text;
  ui.fnPop.hidden = false;
}

function openSheet(el) { el.hidden = false; }
function closeSheets() {
  let closed = false;
  for (const el of [ui.tocPanel, ui.setPanel, ui.fnPop]) { if (!el.hidden) { el.hidden = true; closed = true; } }
  return closed;
}

function fillToc() {
  ui.tocList.replaceChildren(...content.chapters.map((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.title;
    if (i === pos.ch) b.classList.add('current');
    b.onclick = () => { closeSheets(); hideBars(); show({ ch: i, pg: 0 }); };
    li.appendChild(b);
    return li;
  }));
  const bms = (book.bookmarks || []).slice().sort((a, b) => a.ch - b.ch || a.frac - b.frac);
  if (!bms.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Brak zakładek. Dodasz je przyciskiem z kokardką na górze ekranu.';
    ui.bmList.replaceChildren(li);
  } else {
    ui.bmList.replaceChildren(...bms.map(bm => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${content.chapters[bm.ch]?.title || ''} · ${bm.percent}%`;
      b.onclick = () => { closeSheets(); hideBars(); show({ ch: bm.ch, pg: pageAt(bm.ch, bm.frac) }); };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn del';
      del.setAttribute('aria-label', 'Usuń zakładkę');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.onclick = () => {
        book.bookmarks = book.bookmarks.filter(x => x !== bm);
        db.putBook(book).catch(() => {});
        fillToc();
        show(pos);
      };
      li.append(b, del);
      return li;
    }));
  }
}

function toggleBookmark() {
  if (pos.ch < 0) return;
  book.bookmarks = book.bookmarks || [];
  if (isBookmarked(pos)) {
    book.bookmarks = book.bookmarks.filter(b => !(b.ch === pos.ch && pageAt(b.ch, b.frac) === pos.pg));
    opts.toast?.('Zakładka usunięta');
  } else {
    // środek strony – zakładka zostaje na właściwej stronie także po zmianie wielkości liter
    book.bookmarks.push({ ch: pos.ch, frac: (pos.pg + 0.5) / count(pos.ch), percent: percentOf(pos), at: Date.now() });
    opts.toast?.('Zakładka dodana');
  }
  show(pos);
  clearTimeout(saveTimer);
  db.putBook(book).catch(() => {});
}

function relayout() {
  if (!book) return;
  finishNow();
  const frac = anchor ?? fracOf(pos);
  computeGeometry();
  const ch = pos.ch;
  anchor = frac;
  show(ch < 0 ? pos : { ch, pg: pageAt(ch, frac) }, true);
}

/* ---------- Otwieranie i zamykanie ---------- */

export async function openBook(id, options) {
  opts = options || {};
  book = await db.getBook(id);
  content = await db.getContent(id);
  if (!book || !content) throw new Error('Nie mogę wczytać tej książki.');
  templates = [];
  prefix = [];
  let acc = 0;
  for (const c of content.chapters) { prefix.push(acc); acc += c.chars; }
  total = Math.max(1, acc);
  coverUrl = book.cover ? URL.createObjectURL(book.cover) : null;

  ui.title.textContent = book.title;
  ui.reader.hidden = false;
  ui.reader.classList.remove('bars');
  closeSheets();
  applyLook();
  computeGeometry();

  const pr = book.progress;
  if (pr && pr.ch >= 0 && pr.ch < content.chapters.length) {
    show({ ch: pr.ch, pg: pageAt(pr.ch, pr.frac) });
  } else {
    show({ ch: -1, pg: 0 });
  }
}

export function closeBook() {
  if (!book) return;
  finishNow();
  clearTimeout(saveTimer);
  const saving = db.putBook(book).catch(() => {});
  ui.reader.hidden = true;
  ui.stage.replaceChildren();
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = null;
  book = null; content = null; templates = [];
  return saving;
}

export const readerOpen = () => !!book;
export const closeReaderPanels = () => closeSheets() || (barsVisible() && (hideBars(), true));

/* ---------- Podpięcie zdarzeń (raz) ---------- */

ui.stage.addEventListener('pointerdown', onDown);
ui.stage.addEventListener('pointermove', onMove);
ui.stage.addEventListener('pointerup', onUp);
ui.stage.addEventListener('pointercancel', onUp);
ui.stage.addEventListener('contextmenu', e => e.preventDefault());

$('bmBtn').onclick = toggleBookmark;
$('tocBtn').onclick = () => {
  fillToc();
  openSheet(ui.tocPanel);
  ui.tocList.querySelector('.current')?.scrollIntoView({ block: 'center' });
};
$('setBtn').onclick = () => openSheet(ui.setPanel);
for (const b of document.querySelectorAll('.close-sheet')) b.onclick = closeSheets;
for (const sheet of [ui.tocPanel, ui.setPanel]) sheet.addEventListener('click', e => { if (e.target === sheet) closeSheets(); });
ui.fnPop.onclick = () => { ui.fnPop.hidden = true; };

for (const tab of ui.tocPanel.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of ui.tocPanel.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    ui.tocList.hidden = tab.dataset.tab !== 'toc';
    ui.bmList.hidden = tab.dataset.tab !== 'bm';
  };
}

function changeSetting(key, val) {
  S[key] = val;
  saveSettings();
  applyLook();
  relayout();
}
$('fontMinus').onclick = () => changeSetting('fontSize', Math.max(14, S.fontSize - 2));
$('fontPlus').onclick = () => changeSetting('fontSize', Math.min(34, S.fontSize + 2));
for (const [segId, key] of [['themeSeg', 'theme'], ['fontSeg', 'font'], ['lhSeg', 'lh']]) {
  $(segId).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) changeSetting(key, b.dataset.v);
  });
}

ui.seek.addEventListener('input', () => {
  if (!content) return;
  const target = (ui.seek.value / 1000) * total;
  let ch = 0;
  while (ch + 1 < prefix.length && prefix[ch + 1] <= target) ch++;
  ui.seekInfo.textContent = `${content.chapters[ch].title} · ${Math.round(ui.seek.value / 10)}%`;
});
ui.seek.addEventListener('change', () => {
  if (!content) return;
  const target = (ui.seek.value / 1000) * total;
  let ch = 0;
  while (ch + 1 < prefix.length && prefix[ch + 1] <= target) ch++;
  const frac = Math.min(1, (target - prefix[ch]) / content.chapters[ch].chars);
  show({ ch, pg: Math.min(count(ch) - 1, Math.floor(frac * count(ch))) });
});

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 180);
});

addEventListener('keydown', e => {
  if (!book) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); turn(1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); turn(-1); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && book) db.putBook(book).catch(() => {});
});
