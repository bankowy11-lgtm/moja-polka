// Biblioteka: półka z książkami, dodawanie plików, usuwanie, otwieranie czytnika.
import { db } from './db.js';
import { importFile, importEpub } from './importer.js';
import { openBook, closeBook, readerOpen, closeReaderPanels } from './reader.js';

const $ = id => document.getElementById(id);
const STARTER_BOOKS = ['books/tajemniczy-ogrod.epub'];

/* ---------- Drobne elementy interfejsu ---------- */

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(on, text = 'Ładuję…') {
  $('busyText').textContent = text;
  $('busy').hidden = !on;
}

function confirmDialog(text, yesLabel = 'Usuń') {
  return new Promise(resolve => {
    const d = $('dialog');
    $('dlgText').textContent = text;
    $('dlgYes').textContent = yesLabel;
    d.hidden = false;
    const done = v => { d.hidden = true; $('dlgYes').onclick = $('dlgNo').onclick = d.onclick = null; resolve(v); };
    $('dlgYes').onclick = () => done(true);
    $('dlgNo').onclick = () => done(false);
    d.onclick = e => { if (e.target === d) done(false); };
  });
}

const hueOf = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/* ---------- Dodawanie książek ---------- */

async function saveImported(data, extra = {}) {
  const books = await db.allBooks();
  const dup = books.find(b => b.title === data.title && (b.author || '') === (data.author || ''));
  if (dup) return { dup };
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const meta = {
    id, title: data.title, author: data.author || '', cover: data.cover || null,
    hue: hueOf(data.title), addedAt: Date.now(), lastOpened: 0,
    chapterCount: data.chapters.length, progress: null, bookmarks: [], ...extra,
  };
  await db.addBook(meta, { chapters: data.chapters, notes: data.notes || {} });
  return { book: meta };
}

async function addFiles(files) {
  if (!files.length) return;
  try { await navigator.storage?.persist?.(); } catch { /* opcjonalne */ }
  let added = 0;
  for (const f of files) {
    busy(true, `Dodaję: ${f.name}`);
    try {
      const data = await importFile(f);
      const r = await saveImported(data);
      if (r.dup) toast(`„${r.dup.title}” już jest na półce`);
      else added++;
    } catch (err) {
      console.error(err);
      toast(`Nie udało się dodać „${f.name}”: ${err.message}`, 4500);
    }
  }
  busy(false);
  if (added) toast(added === 1 ? 'Książka dodana na półkę' : `Dodano książek: ${added}`);
  await renderLibrary();
}

async function seedStarterBooks() {
  if (await db.getMeta('seeded')) return;
  for (const url of STARTER_BOOKS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await importEpub(await res.arrayBuffer(), url.split('/').pop());
      await saveImported(data, { builtin: true });
    } catch (err) {
      console.error('Nie udało się dodać książki startowej', err);
      return; // spróbujemy przy następnym uruchomieniu
    }
  }
  await db.setMeta('seeded', true);
}

/* ---------- Półka ---------- */

const urls = [];
function coverEl(book) {
  const wrap = document.createElement('div');
  wrap.className = 'cover';
  if (book.cover) {
    const img = document.createElement('img');
    const u = URL.createObjectURL(book.cover);
    urls.push(u);
    img.src = u;
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);
  } else {
    wrap.classList.add('gen');
    wrap.style.setProperty('--hue', book.hue ?? 140);
    const t = document.createElement('span');
    t.textContent = book.title;
    wrap.appendChild(t);
  }
  return wrap;
}

async function renderLibrary() {
  while (urls.length) URL.revokeObjectURL(urls.pop());
  const books = (await db.allBooks()).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || b.addedAt - a.addedAt);
  const shelf = $('shelf');
  $('empty').hidden = books.length > 0;
  $('bookCount').textContent = books.length ? `(${books.length})` : '';

  // „Czytaj dalej” – ostatnio czytana książka
  const last = books.find(b => b.lastOpened && b.progress);
  const cont = $('continue');
  cont.hidden = !last;
  cont.replaceChildren();
  if (last) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-card';
    const info = document.createElement('div');
    info.className = 'continue-info';
    info.innerHTML = '<small>Czytaj dalej</small><strong></strong><span></span><div class="bar"><i></i></div>';
    info.querySelector('strong').textContent = last.title;
    info.querySelector('span').textContent = `Przeczytano ${last.progress.percent || 0}%`;
    info.querySelector('i').style.width = (last.progress.percent || 0) + '%';
    const play = document.createElement('div');
    play.className = 'continue-play';
    play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>';
    btn.append(coverEl(last), info, play);
    btn.onclick = () => open(last.id);
    cont.appendChild(btn);
  }

  shelf.replaceChildren(...books.map(b => {
    const card = document.createElement('article');
    card.className = 'book';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'book-open';
    openBtn.setAttribute('aria-label', `Czytaj: ${b.title}`);
    openBtn.appendChild(coverEl(b));
    const pc = b.progress?.percent || 0;
    if (pc > 0) {
      const bar = document.createElement('div');
      bar.className = 'bar on-cover';
      bar.innerHTML = '<i></i>';
      bar.firstChild.style.width = pc + '%';
      openBtn.appendChild(bar);
    }
    openBtn.onclick = () => open(b.id);
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const h = document.createElement('h3');
    h.textContent = b.title;
    const a = document.createElement('p');
    a.textContent = b.author || ' ';
    const s = document.createElement('p');
    s.className = 'muted';
    s.textContent = pc >= 100 ? 'Przeczytana ✔' : pc > 0 ? `${pc}%` : 'Nowa';
    meta.append(h, a, s);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn book-del';
    del.setAttribute('aria-label', `Usuń: ${b.title}`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
    del.onclick = async () => {
      if (await confirmDialog(`Usunąć „${b.title}” z półki? Postęp i zakładki tej książki też znikną.`)) {
        await db.deleteBook(b.id);
        toast('Usunięto z półki');
        renderLibrary();
      }
    };
    card.append(openBtn, meta, del);
    return card;
  }));
}

/* ---------- Przejścia między ekranami ---------- */

async function open(id) {
  busy(true, 'Otwieram książkę…');
  try {
    $('library').hidden = true;
    await openBook(id, { toast });
    history.pushState({ reader: id }, '');
  } catch (err) {
    console.error(err);
    $('library').hidden = false;
    toast(err.message, 4000);
  } finally {
    busy(false);
  }
}

async function backToLibrary() {
  await closeBook();
  $('library').hidden = false;
  renderLibrary();
}

$('backBtn').onclick = () => history.back();
addEventListener('popstate', () => {
  if (!readerOpen()) return;
  // Systemowy przycisk „wstecz”: najpierw zamyka panele, potem czytnik.
  if (closeReaderPanels()) { history.pushState({ reader: 1 }, ''); return; }
  backToLibrary();
});

$('addBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  addFiles(files);
};

// Przeciągnij i upuść plik (na komputerze)
addEventListener('dragover', e => { if (!readerOpen()) e.preventDefault(); });
addEventListener('drop', e => {
  if (readerOpen()) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

/* ---------- Start ---------- */

(async () => {
  if (!('indexedDB' in window) || !('DecompressionStream' in window)) {
    toast('Ta przeglądarka jest za stara. Zaktualizuj Chrome.', 8000);
  }
  busy(true, 'Przygotowuję półkę…');
  try {
    await seedStarterBooks();
  } finally {
    busy(false);
  }
  await renderLibrary();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
