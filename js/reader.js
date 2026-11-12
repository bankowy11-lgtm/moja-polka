// Czytnik: dzieli rozdział na strony (kolumny CSS) i przewraca kartki w 3D.
// Na ekranie istnieją naraz najwyżej dwie strony, więc nawet gruba książka działa płynnie.
import { db } from './db.js';
import { createTts } from './tts.js';
import { createAudioPlayer } from './audio.js';

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
  // Domyślnie spokojne tempo czytania (dla dziecka); ttsV=2 przestawia stare zapisane tempo.
  const def = { fontSize: innerWidth < 600 ? 20 : 21, theme: 'light', font: 'serif', lh: '1.65', ttsRate: 0.85, ttsV: 2 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.ttsV !== 2) { delete saved.ttsRate; saved.ttsV = 2; }
    return { ...def, ...saved };
  } catch { return def; }
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
  tts.onPageShown();
}

/* ---------- Czytanie na głos ---------- */

const RATES = [[0.7, 'bardzo wolne'], [0.85, 'wolne'], [1, 'normalne'], [1.15, 'szybkie']];

const PROBLEMS = {
  'no-start': 'Tablet nie wydał dźwięku – najpewniej brakuje polskiego głosu. Wykonaj kroki poniżej.',
  'too-fast': 'Tablet nie wydał dźwięku – najpewniej brakuje polskiego głosu. Wykonaj kroki poniżej.',
  'language-unavailable': 'W tablecie brakuje polskiego głosu. Pobierz go według kroków poniżej.',
  'voice-unavailable': 'W tablecie brakuje polskiego głosu. Pobierz go według kroków poniżej.',
  'synthesis-unavailable': 'Mechanizm mowy w tablecie jest wyłączony lub nie zainstalowany.',
  'audio-busy': 'Inna aplikacja używa teraz dźwięku. Zamknij ją i spróbuj ponownie.',
  'unsupported': 'Ta przeglądarka nie umie czytać na głos. Zaktualizuj Chrome.',
};

function openTtsHelp(reason) {
  const why = $('ttsWhy');
  why.hidden = !reason;
  why.textContent = reason ? (PROBLEMS[reason] || 'Nie udało się uruchomić głosu. Wykonaj kroki poniżej.') : '';
  $('ttsTestResult').textContent = '';
  $('ttsDiag').textContent = tts.diagnostics(reason || '');
  closeSheets();
  openSheet($('ttsHelp'));
}
const tts = createTts({
  pageCols: () => curEl?.querySelector('.cols'),
  pageBox: () => curEl?.querySelector('.page-box'),
  chapter: () => pos.ch,
  isCover: () => pos.ch < 0,
  turnNext: () => {
    if (!startFlip(1, 'bottom')) return false;
    animateTo(true, 760);
    return true;
  },
  nextChapter: () => {
    const ch = pos.ch + 1;
    if (!content || ch >= content.chapters.length) return false;
    if (pos.ch >= 0 && pos.pg === count(pos.ch) - 1 && startFlip(1, 'bottom')) animateTo(true, 760);
    else show({ ch, pg: 0 });
    return true;
  },
  toast: (m, ms) => opts.toast?.(m, ms),
  title: () => [book?.title, book?.author].filter(Boolean).join('. ') + '.',
  onProblem: reason => openTtsHelp(reason),
  rate: () => Number(S.ttsRate) || 0.85,
  onState: ({ active, playing, rate }) => {
    $('ttsBar').hidden = !active;
    ui.reader.classList.toggle('tts-on', active);
    $('ttsBtn').classList.toggle('on', active);
    $('ttsPlay').classList.toggle('paused', !playing);
    $('ttsPlay').setAttribute('aria-label', playing ? 'Pauza' : 'Czytaj dalej');
    $('ttsRate').textContent = 'Tempo: ' + (RATES.find(r => r[0] === rate) || RATES[1])[1];
  },
});
if (!tts.supported) $('ttsBtn').hidden = true;

/* ---------- Lektor (audiobook z Wolnych Lektur) ---------- */

const audio = createAudioPlayer({
  book: () => book,
  chapters: () => content.chapters,
  pos: () => pos,
  chapterStartFrac: ch => (prefix[ch] || 0) / total,
  showChapter: ch => { finishNow(); show({ ch, pg: 0 }); },
  save: () => { if (book) db.putBook(book).catch(() => {}); },
  toast: (m, ms) => opts.toast?.(m, ms),
  rate: () => Number(S.audioRate) || 1,
  setRate: r => { S.audioRate = r; saveSettings(); },
  stopTts: () => tts.stop(),
  onActive: on => {
    $('audioBar').hidden = !on;
    ui.reader.classList.toggle('audio-on', on);
    $('audioBtn').classList.toggle('on', on);
  },
  openSheet: el => openSheet(el),
  closeSheets: () => closeSheets(),
});

/* ---------- Przewracanie kartek: zaginanie rogu ---------- */
// Kartkę ciągnie się za róg (domyślnie prawy dolny). Linia zgięcia to symetralna
// odcinka „róg → palec”. Część kartki za tą linią jest odbijana jak w lustrze
// i pokazuje tył kartki z prześwitującym tekstem – tak jak prawdziwy papier.

const LIFT = 0.14; // jak mocno róg unosi się ku górze podczas przewracania

function clampFold(F, C) {
  const W = geo.pageW, H = geo.pageH;
  // Kartka jest przyklejona do grzbietu: róg nie może odjechać dalej niż długość krawędzi.
  const near = { x: 0, y: C.y }, far = { x: 0, y: H - C.y };
  let { x, y } = F;
  let dx = x - near.x, dy = y - near.y, d = Math.hypot(dx, dy);
  if (d > W) { x = near.x + dx * W / d; y = near.y + dy * W / d; }
  const diag = Math.hypot(W, H);
  dx = x - far.x; dy = y - far.y; d = Math.hypot(dx, dy);
  if (d > diag) { x = far.x + dx * diag / d; y = far.y + dy * diag / d; }
  return { x, y };
}

// Przycięcie wielokąta do półpłaszczyzny (P−M)·n ≥ 0 (albo ≤ 0)
function clipHalf(poly, M, n, positive) {
  const out = [];
  const side = p => ((p.x - M.x) * n.x + (p.y - M.y) * n.y) * (positive ? 1 : -1);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
const polyCss = pts => (pts.length >= 3
  ? `polygon(${pts.map(p => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`).join(',')})`
  : 'polygon(0 0, 0 0, 0 0)');

// Uniesienie rogu zależne od tego, jak daleko kartka jest przewrócona (łuk)
function liftAt(x, C) {
  const W = geo.pageW;
  const p = Math.max(0, Math.min(1, (W - x) / (2 * W)));
  const amount = Math.sin(p * Math.PI) * geo.pageH * LIFT;
  return C.y > 0 ? -amount : amount; // róg dolny idzie w górę, górny w dół
}

function startFlip(dir, corner = 'bottom') {
  if (flip) finishNow();
  const target = dir > 0 ? nextPos(pos) : prevPos(pos);
  if (!target) {
    if (dir > 0 && pos.ch >= 0) opts.toast?.('To już koniec książki!');
    return null;
  }
  const W = geo.pageW, H = geo.pageH;
  const C = { x: W, y: corner === 'top' ? 0 : H };
  const other = buildPage(target);
  let under, top;
  if (dir > 0) {              // bieżąca kartka się zagina, pod nią następna
    under = other; top = curEl;
    ui.stage.prepend(under);
  } else {                    // poprzednia kartka wraca i się rozprostowuje
    under = curEl; top = other;
    ui.stage.appendChild(top);
  }
  top.classList.add('curl-top');

  const el = cls => { const d = document.createElement('div'); d.className = cls; return d; };
  const flapWrap = el('flap-wrap');
  const flap = el('flap');
  const flapPage = buildPage(dir > 0 ? pos : target);
  flapPage.classList.add('flap-page');
  const flapShine = el('flap-shine');
  flap.append(flapPage, el('flap-paper'), flapShine);
  flapWrap.appendChild(flap);
  ui.stage.appendChild(flapWrap);
  const underShade = el('under-shade');
  under.appendChild(underShade);

  flip = { dir, target, under, top, flapWrap, flap, flapShine, underShade, C, raf: 0 };
  setFold(dir > 0 ? { x: W, y: C.y } : { x: -W, y: C.y });
  return flip;
}

function setFold(Fin) {
  const f = flip, W = geo.pageW, H = geo.pageH, C = f.C;
  const F = clampFold(Fin, C);
  f.F = F;
  const vx = C.x - F.x, vy = C.y - F.y, len = Math.hypot(vx, vy);
  if (len < 0.5) {                       // kartka leży płasko
    f.top.style.clipPath = '';
    f.flapWrap.style.visibility = 'hidden';
    f.underShade.style.opacity = '0';
    return;
  }
  f.flapWrap.style.visibility = '';
  const n = { x: vx / len, y: vy / len };                 // kierunek do rogu
  const M = { x: (C.x + F.x) / 2, y: (C.y + F.y) / 2 };   // punkt na linii zgięcia
  const rect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  f.top.style.clipPath = polyCss(clipHalf(rect, M, n, false));
  f.flap.style.clipPath = polyCss(clipHalf(rect, M, n, true));

  // Odbicie lustrzane względem linii zgięcia
  const k = 2 * (M.x * n.x + M.y * n.y);
  const a = 1 - 2 * n.x * n.x, b = -2 * n.x * n.y, d = 1 - 2 * n.y * n.y;
  f.flap.style.transform = `matrix(${a},${b},${b},${d},${k * n.x},${k * n.y})`;

  // Pasy cienia/połysku ułożone wzdłuż linii zgięcia, po stronie rogu
  const L = 3 * Math.hypot(W, H);
  const rot = Math.atan2(-n.x, n.y) * 180 / Math.PI;
  const band = (node, thick) => {
    node.style.width = L + 'px';
    node.style.height = Math.max(1, thick) + 'px';
    node.style.transform = `translate(${M.x}px,${M.y}px) rotate(${rot}deg) translate(${-L / 2}px,0)`;
  };
  const depth = len / 2;
  band(f.flapShine, depth);
  band(f.underShade, Math.min(depth, 30 + depth * 0.35));
  const p = Math.max(0, Math.min(1, (W - F.x) / (2 * W)));
  f.underShade.style.opacity = (Math.min(1, p * 6) * (1 - p * p)).toFixed(3);
}

// Przesuwa róg do końca (przewrócona) albo z powrotem (anulowanie), po łuku.
function animateTo(complete, duration) {
  const f = flip;
  const W = geo.pageW, C = f.C;
  const F0 = f.F;
  const toX = f.dir > 0 ? (complete ? -W : W) : (complete ? W : -W);
  const extraY = F0.y - C.y - liftAt(F0.x, C);   // ile palec dodatkowo przesunął w pionie
  const dist = Math.abs(toX - F0.x) / (2 * W);
  const dur = duration ?? 160 + 460 * dist;
  const ease = duration
    ? (q => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2))
    : (q => 1 - Math.pow(1 - q, 3));
  const t0 = performance.now();
  const step = now => {
    const q = Math.min(1, (now - t0) / dur);
    const e = ease(q);
    const x = F0.x + (toX - F0.x) * e;
    setFold({ x, y: C.y + extraY * (1 - e) + liftAt(x, C) });
    if (q < 1) f.raf = requestAnimationFrame(step);
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
  f.flapWrap.remove();
  f.underShade.remove();
  f.top.classList.remove('curl-top');
  f.top.style.clipPath = '';
  // dalej: zostaje następna (pod spodem); wstecz: zostaje poprzednia (rozprostowana)
  const keep = complete ? (f.dir > 0 ? f.under : f.top) : (f.dir > 0 ? f.top : f.under);
  curEl = keep;
  ui.stage.replaceChildren(keep);
  if (complete) { pos = f.target; anchor = null; afterMove(); }
}

function finishNow() { if (flip) endFlip(flip.complete ?? true); }

function turn(dir) {
  hideBars();
  if (startFlip(dir, 'bottom')) animateTo(true, 760);
}

/* ---------- Dotyk i mysz ---------- */

let ptr = null;

function pagePoint(e) {
  const r = ui.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e) {
  if (e.button > 0 || !book) return;
  if (flip && flip.complete === undefined) {   // kartka jest właśnie trzymana palcem
    if (ptr?.drag) return;                     // drugi palec – ignorujemy
    animateTo(false);                          // porzucone zagięcie – kartka wraca na miejsce
  }
  ptr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, p0: pagePoint(e), drag: false, hist: [] };
}

function onMove(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  if (!ptr.drag) {
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
    hideBars();
    // Złapanie w górnej części strony zagina górny róg, w pozostałych – dolny.
    const corner = ptr.p0.y < geo.pageH * 0.3 ? 'top' : 'bottom';
    if (!startFlip(dx < 0 ? 1 : -1, corner)) { ptr = null; return; }
    ptr.drag = true;
    ptr.x0 = e.clientX;
    ptr.y0 = e.clientY;
    try { ui.stage.setPointerCapture(e.pointerId); } catch { /* ok */ }
  }
  const now = performance.now();
  ptr.hist.push([now, e.clientX]);
  while (ptr.hist.length > 2 && now - ptr.hist[0][0] > 100) ptr.hist.shift();
  const W = geo.pageW, C = flip.C;
  const mx = e.clientX - ptr.x0, my = e.clientY - ptr.y0;
  // Róg podąża za palcem; w trakcie ruchu unosi się po łuku ku przeciwległemu rogowi.
  const x = flip.dir > 0 ? W + mx * 1.15 : -W + mx * 2;
  setFold({ x, y: C.y + my + liftAt(x, C) });
}

function onUp(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = ptr;
  ptr = null;
  if (p.drag && flip) {
    const h = p.hist;
    // prędkość ruchu palca tuż przed puszczeniem (gdy palec się zatrzymał – zero)
    const stopped = !h.length || performance.now() - h[h.length - 1][0] > 120;
    const v = !stopped && h.length > 1 ? (h[h.length - 1][1] - h[0][1]) / Math.max(1, h[h.length - 1][0] - h[0][0]) : 0;
    const w = geo.pageW, x = flip.F.x;
    const complete = flip.dir > 0
      ? (v < -0.35 || (x < w * 0.3 && v < 0.35))
      : (v > 0.35 || (x > -w * 0.3 && v > -0.35));
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
  for (const el of [ui.tocPanel, ui.setPanel, ui.fnPop, $('ttsHelp'), $('abPanel')]) { if (!el.hidden) { el.hidden = true; closed = true; } }
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
  // przycisk lektora tylko dla książek z nagraniem (sprawdzane w tle, gdy jest internet)
  const opened = book;
  $('audioBtn').hidden = !audio.available(book);
  if (!$('audioBtn').hidden && !book.audioTracks) {
    audio.prefetch(book).then(has => { if (book === opened && has === false) $('audioBtn').hidden = true; });
  }
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
  tts.stop();
  audio.close();
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
$('ttsBtn').onclick = () => { hideBars(); audio.close(); tts.toggle(); };
$('audioBtn').onclick = () => {
  hideBars();
  if (audio.active) audio.toggle();
  else audio.open();
};
$('ttsPlay').onclick = () => tts.toggle();
$('ttsStop').onclick = () => tts.stop();
function cycleRate() {
  const k = RATES.findIndex(r => r[0] === (Number(S.ttsRate) || 0.85));
  S.ttsRate = RATES[(k + 1) % RATES.length][0];
  saveSettings();
  tts.rateChanged();
}
$('ttsRate').onclick = cycleRate;
$('ttsHelpBtn').onclick = () => openTtsHelp('');
$('ttsTest').onclick = async () => {
  const out = $('ttsTestResult');
  out.textContent = 'Słuchaj…';
  const r = await tts.test();
  out.textContent = r.ok
    ? '✔ Głos działa. Słyszysz go? Jeśli nie – podgłośnij tablet.'
    : '✖ ' + (PROBLEMS[r.reason] || 'Głos nie działa.') ;
  $('ttsDiag').textContent = tts.diagnostics(r.ok ? 'test OK' : r.reason);
};
$('tocBtn').onclick = () => {
  fillToc();
  openSheet(ui.tocPanel);
  ui.tocList.querySelector('.current')?.scrollIntoView({ block: 'center' });
};
$('setBtn').onclick = () => openSheet(ui.setPanel);
for (const b of document.querySelectorAll('.close-sheet')) b.onclick = closeSheets;
for (const sheet of [ui.tocPanel, ui.setPanel, $('ttsHelp'), $('abPanel')]) sheet.addEventListener('click', e => { if (e.target === sheet) closeSheets(); });
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
