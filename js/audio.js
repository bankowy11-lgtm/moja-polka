// Lektor: audiobooki z Wolnych Lektur czytane przez aktorów (MP3, odtwarzane z internetu).
// Nagrania są podzielone na rozdziały – dopasowujemy je do rozdziałów w książce,
// więc „🎧 Lektor” zaczyna od rozdziału, który dziecko ma właśnie otwarty.

const API = 'https://wolnelektury.pl/api/books/';

// Książki startowe (dla półek ułożonych zanim zapisywaliśmy adres książki)
const TITLE_SLUGS = {
  'Tajemniczy ogród': 'tajemniczy-ogrod',
  'Doktor Dolittle i jego zwierzęta': 'hugh-lofting-doktor-dolittle-i-jego-zwierzeta',
  'Baśnie': 'andersen-basnie',
  'O czym szumią wierzby': 'o-czym-szumia-wierzby',
  'Heidi': 'heidi',
  'Król Maciuś Pierwszy': 'krol-macius-pierwszy',
  'Przygody Tomka Sawyera': 'przygody-tomka-sawyera',
  'W pustyni i w puszczy': 'w-pustyni-i-w-puszczy',
  'Szatan z siódmej klasy': 'makuszynski-szatan-z-siodmej-klasy',
};
export const slugOf = book => book?.wlSlug || TITLE_SLUGS[book?.title] || null;

/* ---------- Dopasowanie rozdziałów do nagrań ---------- */

const ORD = {
  pierwszy: 1, drugi: 2, trzeci: 3, czwarty: 4, 'piąty': 5, 'szósty': 6, 'siódmy': 7, 'ósmy': 8, 'dziewiąty': 9,
  'dziesiąty': 10, jedenasty: 11, dwunasty: 12, trzynasty: 13, czternasty: 14, 'piętnasty': 15, szesnasty: 16,
  siedemnasty: 17, osiemnasty: 18, 'dziewiętnasty': 19, dwudziesty: 20, trzydziesty: 30, czterdziesty: 40, 'pięćdziesiąty': 50,
};
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function roman(s) {
  if (!/^[ivxlc]+$/.test(s)) return null;
  let n = 0;
  for (let k = 0; k < s.length; k++) {
    const v = ROMAN[s[k]], nx = ROMAN[s[k + 1]] || 0;
    n += v < nx ? -v : v;
  }
  return n;
}
function number(a, b) {
  if (/^\d+$/.test(a)) return +a;
  const r = roman(a);
  if (r) return r;
  if (ORD[a] != null) return ORD[a] + (ORD[a] >= 20 && ORD[b] < 10 ? ORD[b] : 0);
  return null;
}
// „Rozdział I. Puddleby” → [1];  „Wstęp i Rozdział I” → ['wstep', 1];  „3. Coś tam” → [3]
export function keysOf(text) {
  const t = (text || '').toLowerCase();
  const keys = [];
  if (/(^|\s)wstęp/.test(t)) keys.push('wstep');
  for (const m of t.matchAll(/rozdzia[łl]\s+([^\s.,:;]+)(?:\s+([^\s.,:;]+))?/g)) {
    const n = number(m[1], m[2]);
    if (n) keys.push(n);
  }
  if (!keys.some(k => typeof k === 'number')) {
    const m = t.match(/^(\d+)(?:[.\s]|$)/);
    if (m) keys.push(+m[1]);
  }
  return keys;
}

const fmt = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/* ---------- Odtwarzacz ---------- */

export function createAudioPlayer(h) {
  const $ = id => document.getElementById(id);
  const el = new Audio();
  el.preload = 'metadata';
  const st = { tracks: null, i: 0, active: false, saveT: 0, rates: [0.85, 1, 1.15], follow: true };

  async function loadTracks(book) {
    const slug = slugOf(book);
    if (!slug) return [];
    const fresh = book.audioTracks && Date.now() - (book.audioFetched || 0) < 30 * 864e5;
    if (fresh) return book.audioTracks;
    try {
      const res = await fetch(API + slug + '/');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const title = j.title || book.title;
      const tracks = (j.media || []).filter(m => m.type === 'mp3' && /^https:\/\//.test(m.url)).map(m => {
        let label = String(m.name || '').replace(/^\d+\.\s*/, '');
        const at = label.indexOf(title + ', ');
        if (at >= 0) label = label.slice(at + title.length + 2);
        return { url: m.url, artist: m.artist || '', label, keys: keysOf(label) };
      });
      book.audioTracks = tracks;
      book.audioFetched = Date.now();
      h.save();
      return tracks;
    } catch {
      return book.audioTracks || null; // null = brak internetu i brak zapisanej listy
    }
  }

  // Który plik odpowiada rozdziałowi? Najpierw po numerze rozdziału, potem proporcjonalnie.
  function trackForChapter(ch) {
    const t = st.tracks;
    if (ch < 0) return Math.max(0, t.findIndex(x => !/stopka/i.test(x.label)));
    const chapters = h.chapters();
    for (const k of keysOf(chapters[ch].title)) {
      const idx = t.findIndex(x => x.keys.includes(k));
      if (idx >= 0) return idx;
    }
    // po nazwie (np. „Zakończenie”, „Posłowie”)
    const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const name = norm(chapters[ch].title);
    const byName = t.findIndex(x => { const l = norm(x.label); return l && (l === name || name.startsWith(l) || l.startsWith(name)); });
    if (byName >= 0 && name.length > 3) return byName;
    const playable = t.map((x, i) => i).filter(i => !/stopka/i.test(t[i].label));
    const k = Math.min(playable.length - 1, Math.floor(h.chapterStartFrac(ch) * playable.length));
    return playable[Math.max(0, k)];
  }
  function chapterForTrack(i) {
    const keys = st.tracks[i]?.keys || [];
    if (!keys.length) return -1;
    return h.chapters().findIndex(c => keysOf(c.title).some(k => keys.includes(k)));
  }

  function ui() {
    const t = st.tracks?.[st.i];
    $('abTitle').textContent = t ? t.label : '';
    $('abArtist').textContent = t?.artist ? `czyta ${t.artist}` : '';
    $('abPlay').classList.toggle('paused', el.paused);
    $('abPlay').setAttribute('aria-label', el.paused ? 'Odtwarzaj' : 'Pauza');
    $('abRate').textContent = `${String(el.playbackRate).replace('.', ',')}×`;
    $('abCount').textContent = st.tracks ? `${st.i + 1} / ${st.tracks.length}` : '';
  }
  function times() {
    $('abCur').textContent = fmt(el.currentTime);
    $('abDur').textContent = fmt(el.duration);
    if (!seeking && isFinite(el.duration) && el.duration > 0) $('abSeek').value = Math.round((el.currentTime / el.duration) * 1000);
  }

  function remember() {
    const book = h.book();
    if (!book || !st.tracks) return;
    book.audioPos = { i: st.i, t: Math.floor(el.currentTime || 0) };
    h.save();
  }

  function mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = st.tracks[st.i], book = h.book();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.label, artist: t.artist, album: book.title,
        artwork: [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
      });
    } catch { /* starsze przeglądarki */ }
  }

  function load(i, t = 0, play = true) {
    st.i = Math.max(0, Math.min(st.tracks.length - 1, i));
    el.src = st.tracks[st.i].url;
    el.playbackRate = Number(h.rate()) || 1;
    if (t > 0) el.addEventListener('loadedmetadata', () => { el.currentTime = Math.min(t, (el.duration || t) - 1); }, { once: true });
    $('abTitle').textContent = 'Ładuję nagranie…';
    if (play) playNow();
    ui();
    mediaSession();
    // tekst w czytniku podąża za lektorem (jeśli rozdział da się dopasować)
    const ch = chapterForTrack(st.i);
    if (st.follow && ch >= 0 && h.pos().ch !== ch) h.showChapter(ch);
  }

  function playNow() {
    el.play().catch(err => {
      if (err?.name !== 'AbortError') { h.toast('Nie mogę odtworzyć nagrania – sprawdź internet.', 4000); ui(); }
    });
  }

  async function open() {
    const book = h.book();
    h.stopTts();
    $('abTitle').textContent = 'Ładuję…';
    st.tracks = await loadTracks(book);
    if (st.tracks === null) { h.toast('Lektor potrzebuje internetu. Połącz się z Wi-Fi i spróbuj ponownie.', 5000); return; }
    if (!st.tracks.length) { h.toast('Ta książka nie ma nagrania lektora.', 4000); return; }
    st.active = true;
    h.onActive(true);
    const pos = h.pos();
    const want = trackForChapter(pos.ch);
    const saved = book.audioPos;
    // ten sam rozdział co ostatnio – wznawiamy od zapamiętanej sekundy
    if (saved && saved.i === want) load(want, saved.t);
    else load(want, 0);
  }

  function close() {
    if (!st.active) return;
    remember();
    el.pause();
    el.removeAttribute('src');
    el.load();
    st.active = false;
    h.onActive(false);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  function toggle() { if (el.paused) playNow(); else el.pause(); }
  const skip = s => { el.currentTime = Math.max(0, Math.min((el.duration || 0) - 0.5, el.currentTime + s)); };

  el.addEventListener('play', ui);
  el.addEventListener('pause', () => { ui(); remember(); });
  el.addEventListener('timeupdate', () => {
    times();
    if (Date.now() - st.saveT > 5000) { st.saveT = Date.now(); remember(); }
  });
  el.addEventListener('loadedmetadata', times);
  el.addEventListener('waiting', () => { $('abArtist').textContent = 'Ładuję…'; });
  el.addEventListener('playing', ui);
  el.addEventListener('ended', () => {
    if (st.i + 1 < st.tracks.length) load(st.i + 1, 0);
    else { remember(); h.toast('Koniec nagrania – brawo! 🎉'); ui(); }
  });
  el.addEventListener('error', () => {
    if (!st.active || !el.getAttribute('src')) return;
    h.toast('Nie mogę wczytać nagrania – sprawdź internet.', 4000);
    ui();
  });

  let seeking = false;
  $('abSeek').addEventListener('input', () => {
    seeking = true;
    if (isFinite(el.duration)) $('abCur').textContent = fmt((($('abSeek').value) / 1000) * el.duration);
  });
  $('abSeek').addEventListener('change', () => {
    if (isFinite(el.duration)) el.currentTime = ($('abSeek').value / 1000) * el.duration;
    seeking = false;
  });
  $('abPlay').onclick = toggle;
  $('abBack').onclick = () => skip(-15);
  $('abFwd').onclick = () => skip(15);
  $('abPrev').onclick = () => (el.currentTime > 5 ? (el.currentTime = 0) : load(st.i - 1, 0));
  $('abNext').onclick = () => { if (st.i + 1 < st.tracks.length) load(st.i + 1, 0); };
  $('abClose').onclick = close;
  $('abRate').onclick = () => {
    const k = st.rates.indexOf(Number(h.rate()) || 1);
    const r = st.rates[(k + 1) % st.rates.length];
    h.setRate(r);
    el.playbackRate = r;
    ui();
  };
  $('abList').onclick = () => {
    const list = $('abTracks');
    list.replaceChildren(...st.tracks.map((t, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.label;
      if (i === st.i) b.classList.add('current');
      b.onclick = () => { h.closeSheets(); load(i, 0); };
      li.appendChild(b);
      return li;
    }));
    h.openSheet($('abPanel'));
    list.querySelector('.current')?.scrollIntoView({ block: 'center' });
  };

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* nieobsługiwane */ } };
    set('play', () => playNow());
    set('pause', () => el.pause());
    set('seekbackward', () => skip(-15));
    set('seekforward', () => skip(15));
    set('previoustrack', () => load(st.i - 1, 0));
    set('nexttrack', () => { if (st.i + 1 < st.tracks.length) load(st.i + 1, 0); });
  }

  return {
    open, close, toggle,
    pause: () => el.pause(),
    get active() { return st.active; },
    available: book => !!slugOf(book) && !(book.audioTracks && book.audioTracks.length === 0),
    // sprawdza w tle, czy książka ma nagranie (żeby ukryć przycisk, gdy go nie ma)
    prefetch: async book => { const t = await loadTracks(book); return t === null ? null : t.length > 0; },
    _el: el,
  };
}
