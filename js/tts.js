// Czytanie na głos: syntezator mowy telefonu (polski głos), zdanie po zdaniu.
// Czytane zdanie jest podświetlane, a kartka przewraca się sama, gdy tekst przejdzie na następną stronę.

const SKIP = '.fn';                       // numerki przypisów nie są czytane
const BLOCKS = 'p,h2,h3,h4,li,blockquote,div';
const MAX_LEN = 220;                      // długie zdania dzielimy (syntezatory nie lubią bardzo długich)

/* ---------- Tekst rozdziału → zdania ---------- */

const nodeCache = new WeakMap();
function textNodes(cols) {
  let c = nodeCache.get(cols);
  if (!c) {
    const nodes = [], starts = [];
    const w = document.createTreeWalker(cols, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let off = 0;
    while (w.nextNode()) { nodes.push(w.currentNode); starts.push(off); off += w.currentNode.nodeValue.length; }
    c = { nodes, starts, total: off };
    nodeCache.set(cols, c);
  }
  return c;
}

function splitLong(text) {
  const out = [];
  let i = 0;
  while (text.length - i > MAX_LEN) {
    const chunk = text.slice(i, i + MAX_LEN);
    let cut = Math.max(chunk.lastIndexOf(', '), chunk.lastIndexOf('; '), chunk.lastIndexOf(' — '), chunk.lastIndexOf(': '));
    if (cut < MAX_LEN * 0.4) cut = chunk.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_LEN;
    out.push({ i, t: text.slice(i, i + cut + 1) });
    i += cut + 1;
  }
  out.push({ i, t: text.slice(i) });
  return out;
}

function sentencesOf(cols) {
  const { nodes, starts } = textNodes(cols);
  const blocks = [];
  let last = null;
  nodes.forEach((n, k) => {
    const b = n.parentElement.closest(BLOCKS);
    if (b !== last || !blocks.length) { blocks.push({ start: starts[k], text: '' }); last = b; }
    blocks[blocks.length - 1].text += n.nodeValue;
  });
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('pl', { granularity: 'sentence' }) : null;
  const out = [];
  for (const bl of blocks) {
    const parts = seg
      ? [...seg.segment(bl.text)].map(s => ({ i: s.index, t: s.segment }))
      : [...bl.text.matchAll(/[^.!?…]+[.!?…]*["”»)]*\s*/g)].map(m => ({ i: m.index, t: m[0] }));
    for (const p of parts) {
      for (const piece of splitLong(p.t)) {
        const text = piece.t.replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        const start = bl.start + p.i + piece.i;
        out.push({ start, end: start + piece.t.length, text });
      }
    }
  }
  return out;
}

function rangeFor(cols, start, end) {
  const { nodes, starts, total } = textNodes(cols);
  if (!nodes.length) return null;
  const find = off => {
    off = Math.max(0, Math.min(off, total));
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return [nodes[lo], Math.min(off - starts[lo], nodes[lo].nodeValue.length)];
  };
  const r = document.createRange();
  r.setStart(...find(start));
  r.setEnd(...find(end));
  return r;
}

// Czy fragment tekstu leży na bieżącej stronie, przed nią czy za nią?
function whereIs(range, box) {
  if (!range || !box) return 'on';
  const rect = [...range.getClientRects()].find(r => r.width > 0);
  if (!rect) return 'on';
  const b = box.getBoundingClientRect();
  if (rect.left >= b.right - 1) return 'after';
  if (rect.right <= b.left + 1) return 'before';
  return 'on';
}

/* ---------- Odtwarzacz ---------- */

export function createTts(h) {
  const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const synth = supported ? window.speechSynthesis : null;
  const st = { active: false, playing: false, ch: null, sents: [], i: 0, token: 0, expecting: null, wake: null, fast: 0 };
  let voice = null;

  function pickVoice() {
    const all = synth.getVoices().filter(v => /^pl([-_]|$)/i.test(v.lang));
    voice = all.find(v => /google/i.test(v.name)) || all.find(v => v.localService) || all[0] || null;
    return voice;
  }
  async function ensureVoice() {
    if (pickVoice()) return voice;
    await new Promise(res => {
      const t = setTimeout(res, 1500);
      synth.addEventListener('voiceschanged', () => { clearTimeout(t); res(); }, { once: true });
    });
    return pickVoice();
  }

  const setHighlight = range => {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    if (range) CSS.highlights.set('tts', new Highlight(range));
    else CSS.highlights.delete('tts');
  };

  async function wakeLock(on) {
    try {
      if (on && !st.wake && navigator.wakeLock) {
        st.wake = await navigator.wakeLock.request('screen');
        st.wake.addEventListener('release', () => { st.wake = null; });
      } else if (!on && st.wake) { await st.wake.release(); st.wake = null; }
    } catch { /* ekran może zgasnąć – nic się nie dzieje */ }
  }

  const emit = () => h.onState?.({ active: st.active, playing: st.playing, rate: h.rate() });

  function loadChapter() {
    const cols = h.pageCols();
    st.ch = h.chapter();
    st.sents = cols ? sentencesOf(cols) : [];
  }

  // Pierwsze zdanie widoczne na bieżącej stronie (albo zdanie, które z poprzedniej strony tu przechodzi)
  function firstOnPage() {
    const cols = h.pageCols(), box = h.pageBox();
    if (!cols) return 0;
    for (let k = 0; k < st.sents.length; k++) {
      const s = st.sents[k];
      const w = whereIs(rangeFor(cols, s.start, s.start + 1), box);
      if (w === 'on') {
        if (k > 0) {
          const p = st.sents[k - 1];
          if (whereIs(rangeFor(cols, p.end - 1, p.end), box) === 'on') return k - 1;
        }
        return k;
      }
      if (w === 'after') return k;
    }
    return st.sents.length;
  }

  function speakCurrent() {
    if (!st.playing) return;
    const s = st.sents[st.i];
    if (!s) { nextChapter(); return; }
    const cols = h.pageCols();
    const range = cols && rangeFor(cols, s.start, s.end);
    if (range && whereIs(rangeFor(cols, s.start, s.start + 1), h.pageBox()) === 'after') {
      st.expecting = 'page';
      if (!h.turnNext()) st.expecting = null;
    } else {
      setHighlight(range);
    }
    say(s.text, () => { st.i++; speakCurrent(); });
  }

  // Wypowiada tekst i pilnuje, czy syntezator naprawdę mówi.
  // Gdy w tablecie brakuje polskiego głosu, zdania „kończą się” natychmiast bez dźwięku –
  // wtedy zatrzymujemy czytanie i pokazujemy instrukcję, zamiast pędzić przez książkę.
  function say(text, next) {
    const tok = ++st.token;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pl-PL';
    if (voice) u.voice = voice;
    u.rate = h.rate();
    const t0 = performance.now();
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = () => {
      if (tok !== st.token || !st.playing) return;
      const took = performance.now() - t0;
      if (!started || took < Math.min(900, text.length * 20)) {
        st.fast++;
        if (st.fast >= 2) { fail(started ? 'too-fast' : 'no-start'); return; }
      } else {
        st.fast = 0;
      }
      next();
    };
    u.onerror = e => {
      if (tok !== st.token || e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') { pause(); h.toast('Stuknij ▶, aby zacząć czytać.'); return; }
      fail(e.error || 'error');
    };
    synth.speak(u);
  }

  function fail(reason) {
    stop();
    h.onProblem?.(reason, diagnostics(reason));
  }

  function diagnostics(reason = '') {
    const all = supported ? synth.getVoices() : [];
    const pl = all.filter(v => /^pl([-_]|$)/i.test(v.lang));
    return [
      `Powód: ${reason || '–'}`,
      `Głosy w urządzeniu: ${all.length}`,
      `Polskie głosy: ${pl.length ? pl.map(v => v.name + (v.localService ? '' : ' (online)')).join(', ') : 'BRAK'}`,
      `Wybrany głos: ${voice ? voice.name : 'domyślny systemu'}`,
      `Tempo: ${h.rate()}`,
      `Przeglądarka: ${navigator.userAgent}`,
    ].join('\n');
  }

  // Próba głosu z ekranu pomocy: zwraca { ok, reason }
  function test() {
    return new Promise(resolve => {
      if (!supported) { resolve({ ok: false, reason: 'unsupported' }); return; }
      stop();
      pickVoice();
      const text = 'Cześć! Tak brzmi czytanie na głos. Miłego czytania!';
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pl-PL';
      if (voice) u.voice = voice;
      u.rate = h.rate();
      const t0 = performance.now();
      let started = false, done = false;
      const finish = r => { if (!done) { done = true; resolve(r); } };
      u.onstart = () => { started = true; };
      u.onend = () => {
        const took = performance.now() - t0;
        finish(started && took > 900 ? { ok: true } : { ok: false, reason: started ? 'too-fast' : 'no-start' });
      };
      u.onerror = e => finish({ ok: false, reason: e.error || 'error' });
      setTimeout(() => finish(started ? { ok: true } : { ok: false, reason: 'timeout' }), 8000);
      if (synth.speaking || synth.pending) synth.cancel();
      synth.speak(u);
    });
  }

  function nextChapter() {
    st.expecting = 'chapter';
    if (!h.nextChapter()) {
      st.expecting = null;
      stop();
      h.toast('Koniec książki – brawo! 🎉');
    }
  }

  function restart(delay = 80) {
    st.token++;
    synth.cancel();
    setTimeout(speakCurrent, delay); // po cancel() Chrome potrzebuje chwili
  }

  // Uwaga: pierwsze zdanie musi zostać wypowiedziane od razu w reakcji na stuknięcie
  // (bez czekania) – inaczej część tabletów blokuje dźwięk.
  function start() {
    if (!supported) { h.onProblem?.('unsupported', diagnostics('unsupported')); return; }
    pickVoice();
    if (!voice) ensureVoice();       // głosy czasem wczytują się z opóźnieniem – dobierzemy później
    st.active = true;
    st.playing = true;
    st.fast = 0;
    emit();
    wakeLock(true);
    if (synth.speaking || synth.pending) synth.cancel();
    if (h.isCover()) {               // z okładki: najpierw tytuł, potem pierwsza strona
      say(h.title(), () => { st.expecting = 'chapter'; if (!h.turnNext()) stop(); });
      return;
    }
    loadChapter();
    st.i = firstOnPage();
    st.token++;
    speakCurrent();
  }

  function pause() {
    st.playing = false;
    st.token++;
    synth.cancel();
    wakeLock(false);
    emit();
  }

  function resume() {
    if (!st.active) return start();
    st.playing = true;
    wakeLock(true);
    emit();
    restart();
  }

  function stop() {
    if (!st.active) return;
    st.active = false;
    st.playing = false;
    st.expecting = null;
    st.token++;
    synth?.cancel();
    setHighlight(null);
    wakeLock(false);
    emit();
  }

  // Wywoływane przez czytnik po każdej zmianie strony
  function onPageShown() {
    if (!st.active) return;
    const why = st.expecting;
    st.expecting = null;
    if (why === 'page') {                         // kartkę przewróciło czytanie – tylko podświetlenie
      const s = st.sents[st.i];
      const cols = h.pageCols();
      if (s && cols && h.chapter() === st.ch) setHighlight(rangeFor(cols, s.start, s.end));
      return;
    }
    if (h.isCover()) { setHighlight(null); return; }
    loadChapter();
    st.i = why === 'chapter' ? 0 : firstOnPage(); // użytkownik sam przewrócił – czytamy od tej strony
    setHighlight(null);
    if (st.playing) restart();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && st.playing) wakeLock(true);
  });

  return {
    supported,
    start, pause, resume, stop, onPageShown, test, diagnostics,
    toggle: () => (!st.active ? start() : st.playing ? pause() : resume()),
    get active() { return st.active; },
    get playing() { return st.playing; },
    rateChanged: () => { if (st.playing) restart(); emit(); },
  };
}
