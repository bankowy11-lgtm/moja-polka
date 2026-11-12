// Zamienia plik EPUB lub TXT na książkę gotową do zapisania na półce.
// Treść jest czyszczona: zostają tylko bezpieczne znaczniki (akapity, nagłówki,
// kursywa, obrazki). Skrypty, style i linki z pliku są usuwane.

/* ---------- Odczyt ZIP (EPUB to archiwum ZIP) ---------- */

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('To nie jest poprawny plik EPUB.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Uszkodzony plik EPUB.');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  return {
    has: name => entries.has(name),
    async bytes(name) {
      const e = entries.get(name);
      if (!e) return null;
      const n = dv.getUint16(e.off + 26, true);
      const x = dv.getUint16(e.off + 28, true);
      const start = e.off + 30 + n + x;
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data.slice();
      if (e.method === 8) return inflateRaw(data);
      throw new Error('Nieobsługiwany rodzaj kompresji w pliku.');
    },
    async text(name) {
      const b = await this.bytes(name);
      return b ? dec.decode(b) : null;
    },
  };
}

/* ---------- Pomocnicze ---------- */

function resolvePath(fromFile, href) {
  let h = href;
  try { h = decodeURIComponent(href); } catch { /* zostaw jak jest */ }
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of h.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function parseXml(text, type = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) {
    doc = new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

const byTag = (root, tag) => Array.from(root.getElementsByTagNameNS('*', tag));
const clean = s => (s || '').replace(/\s+/g, ' ').trim();

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeOf = path => MIME[(path.split('.').pop() || '').toLowerCase()];

function bytesToDataUrl(bytes, mime) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

/* ---------- Czyszczenie treści ---------- */

const BLOCK = {
  p: 'p', div: 'div', section: 'div', article: 'div', main: 'div', header: 'div', footer: 'div', aside: 'div',
  blockquote: 'blockquote', figure: 'div', figcaption: 'p', center: 'div', pre: 'p',
  h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'div', dt: 'p', dd: 'p',
  table: 'div', tbody: 'div', thead: 'div', tr: 'p', td: 'span', th: 'span', hr: 'hr',
};
const INLINE = {
  em: 'em', i: 'em', cite: 'em', strong: 'strong', b: 'strong', u: 'u', ins: 'u', s: 's', del: 's',
  sup: 'sup', sub: 'sub', small: 'small', span: 'span', font: 'span', big: 'span', abbr: 'span',
  q: 'q', code: 'code', br: 'br', a: 'a', img: 'img', image: 'img', svg: 'svg',
};
const SKIP = new Set(['script', 'style', 'head', 'title', 'link', 'meta', 'object', 'embed', 'iframe', 'form',
  'input', 'button', 'select', 'textarea', 'video', 'audio', 'noscript', 'template', 'math', 'canvas']);

/* ---------- EPUB ---------- */

export async function importEpub(buf, fileName) {
  const zip = readZip(buf);
  const container = await zip.text('META-INF/container.xml');
  if (!container) throw new Error('Brak pliku META-INF/container.xml – to nie wygląda na EPUB.');
  const opfPath = byTag(parseXml(container, 'application/xml'), 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('Nie znaleziono spisu zawartości książki.');
  if (zip.has('META-INF/encryption.xml')) {
    const enc = await zip.text('META-INF/encryption.xml');
    // Same czcionki bywają „zaszyfrowane” bez DRM – blokujemy tylko szyfrowaną treść.
    if (/\.x?html?["']/i.test(enc)) throw new Error('Ta książka ma zabezpieczenie DRM i nie da się jej otworzyć.');
  }
  const opf = parseXml(await zip.text(opfPath), 'application/xml');

  const DC = 'http://purl.org/dc/elements/1.1/';
  const title = clean(opf.getElementsByTagNameNS(DC, 'title')[0]?.textContent) || fileName.replace(/\.[^.]+$/, '');
  const creators = Array.from(opf.getElementsByTagNameNS(DC, 'creator'));
  const roleOf = c => {
    const refine = c.id && byTag(opf, 'meta').find(m => m.getAttribute('refines') === '#' + c.id && m.getAttribute('property') === 'role');
    return (refine?.textContent || '') + ' ' + (c.getAttribute('opf:role') || '') + ' ' + (c.id || '');
  };
  const authorEl = creators.find(c => !/trl|translator/.test(roleOf(c))) || creators[0];
  const author = clean(authorEl?.textContent);

  const manifest = new Map();
  for (const it of byTag(opf, 'item')) {
    manifest.set(it.getAttribute('id'), {
      href: resolvePath(opfPath, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }

  // Okładka
  let coverItem = [...manifest.values()].find(m => m.props.split(/\s+/).includes('cover-image'));
  if (!coverItem) {
    const metaCover = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
    if (metaCover) coverItem = manifest.get(metaCover.getAttribute('content'));
  }
  let cover = null;
  if (coverItem && mimeOf(coverItem.href)) {
    const b = await zip.bytes(coverItem.href);
    if (b) cover = new Blob([b], { type: mimeOf(coverItem.href) });
  }

  // Tytuły ze spisu treści (nav.xhtml lub toc.ncx), gdy rozdział nie ma nagłówka
  const tocTitles = new Map();
  try {
    const nav = [...manifest.values()].find(m => m.props.split(/\s+/).includes('nav'));
    if (nav) {
      const d = parseXml(await zip.text(nav.href));
      for (const a of byTag(d, 'a')) {
        const target = resolvePath(nav.href, (a.getAttribute('href') || '').split('#')[0]);
        if (!tocTitles.has(target)) tocTitles.set(target, clean(a.textContent));
      }
    }
  } catch { /* spis treści jest opcjonalny */ }

  const spine = byTag(opf, 'itemref')
    .map(r => ({ item: manifest.get(r.getAttribute('idref')), linear: r.getAttribute('linear') !== 'no' }))
    .filter(s => s.item && s.linear && /html/.test(s.item.type) && !s.item.props.includes('nav'));

  const docCache = new Map();
  async function getDoc(path) {
    if (!docCache.has(path)) {
      const t = await zip.text(path);
      docCache.set(path, t ? parseXml(t) : null);
    }
    return docCache.get(path);
  }

  const imgCache = new Map();
  async function imageUrl(path) {
    if (!imgCache.has(path)) {
      let url = null;
      const mime = mimeOf(path);
      const b = mime && await zip.bytes(path);
      if (b && b.length < 3_000_000) url = await bytesToDataUrl(b, mime);
      imgCache.set(path, url);
    }
    return imgCache.get(path);
  }

  const footRefs = [];        // { key, target: 'plik#id' }
  const targetFileCount = new Map();

  async function convert(node, out, file) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { out.appendChild(document.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== 1) continue;
      const tag = (child.localName || '').toLowerCase();
      if (SKIP.has(tag)) continue;

      if (tag === 'img' || tag === 'image') {
        const src = child.getAttribute('src') || child.getAttribute('href') ||
          child.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (!src || /^[a-z]+:/i.test(src)) continue;
        const url = await imageUrl(resolvePath(file, src));
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = child.getAttribute('alt') || '';
          out.appendChild(img);
        }
        continue;
      }
      if (tag === 'svg') { await convert(child, out, file); continue; }

      if (tag === 'a') {
        const href = child.getAttribute('href') || '';
        const label = clean(child.textContent);
        const isNote = href.includes('#') && !/^[a-z]+:/i.test(href) && label.length > 0 && label.length <= 5;
        if (isNote) {
          const [f, id] = href.split('#');
          const target = (f ? resolvePath(file, f) : file) + '#' + id;
          const key = String(footRefs.length + 1);
          footRefs.push({ key, target });
          const span = document.createElement('span');
          span.className = 'fn';
          span.dataset.fn = key;
          const sup = document.createElement('sup');
          sup.textContent = label.replace(/[[\]()]/g, '');
          span.appendChild(sup);
          out.appendChild(span);
          continue;
        }
        const span = document.createElement('span');
        await convert(child, span, file);
        out.appendChild(span);
        continue;
      }

      const mapped = BLOCK[tag] || INLINE[tag];
      if (!mapped) { await convert(child, out, file); continue; }
      const el = document.createElement(mapped);
      if (mapped !== 'br' && mapped !== 'hr') await convert(child, el, file);
      // puste bloki (np. odstępy) pomijamy, chyba że zawierają obrazek
      if (BLOCK[tag] && mapped !== 'hr' && !clean(el.textContent) && !el.querySelector('img')) continue;
      out.appendChild(el);
    }
  }

  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const file = spine[i].item.href;
    const doc = await getDoc(file);
    const body = doc && (byTag(doc, 'body')[0] || doc.documentElement);
    if (!body) continue;
    const wrap = document.createElement('div');
    await convert(body, wrap, file);
    const text = clean(wrap.textContent);
    // strony techniczne, puste, strony tytułowe z logo; zostawiamy same ilustracje
    if (text.length < 400 && !(wrap.querySelector('img') && text.length < 100)) continue;
    // prośby o wsparcie dodawane przez Wolne Lektury
    if (text.length < 1500 && /wesprzyj|wolnelektury\.pl\/pomagam|1,5% podatku|1% podatku/i.test(text)) continue;
    const h = wrap.querySelector('h2,h3,h4');
    const docTitle = clean(byTag(doc, 'title')[0]?.textContent);
    const usableDocTitle = docTitle && !/\.(pl|com|org)\b/i.test(docTitle) && docTitle !== title ? docTitle : '';
    const chTitle = clean(h?.textContent).slice(0, 90) || tocTitles.get(file) || usableDocTitle || `Część ${chapters.length + 1}`;
    chapters.push({ file, title: chTitle, html: wrap.innerHTML, chars: text.length });
  }

  const notes = {};
  for (const ref of footRefs) {
    const [f, id] = ref.target.split('#');
    const doc = await getDoc(f);
    if (!doc) continue;
    const el = doc.getElementById?.(id) || byTag(doc, '*').find(e => e.getAttribute('id') === id);
    if (!el) continue;
    // Link powrotny z przypisu do tekstu (cel sam jest linkiem) – to nie jest przypis.
    if ((el.localName || '').toLowerCase() === 'a' && el.getAttribute('href')) continue;
    let block = el;
    while (block && !/^(p|div|li|aside|dd|section)$/i.test(block.localName || '')) block = block.parentNode;
    const txt = clean((block || el).textContent).replace(/^\[?\d+\]?\.?\s*/, '');
    if (!txt) continue;
    notes[ref.key] = txt.slice(0, 1200);
    targetFileCount.set(f, (targetFileCount.get(f) || 0) + 1);
  }

  // Pliki z przypisami nie są rozdziałami – przypisy pokazujemy w dymkach.
  const noteFiles = new Set([...targetFileCount].filter(([, n]) => n >= 3).map(([f]) => f));
  const finalChapters = chapters.filter(c => !noteFiles.has(c.file)).map(({ file, ...c }) => c);
  if (!finalChapters.length) throw new Error('Nie znalazłem w tym pliku tekstu do czytania.');

  return { title, author, cover, chapters: finalChapters, notes };
}

/* ---------- TXT ---------- */

export async function importTxt(buf, fileName) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('windows-1250').decode(buf); }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Plik jest pusty.');

  const blankSeparated = (text.match(/\n\s*\n/g) || []).length > 20;
  const paras = (blankSeparated ? text.split(/\n\s*\n/) : text.split('\n')).map(clean).filter(Boolean);
  const isHeading = s => s.length < 90 && /^(rozdział|rozdzial|chapter|część|czesc|księga|ksiega)(?=[\s.:]|$)/i.test(s);

  const chapters = [];
  let cur = null;
  const hasHeadings = paras.some(isHeading);
  const start = t => { cur = { title: t, el: document.createElement('div'), chars: 0 }; chapters.push(cur); };
  for (const p of paras) {
    if (isHeading(p)) {
      start(p);
      const h = document.createElement('h2');
      h.textContent = p;
      cur.el.appendChild(h);
      continue;
    }
    if (!cur || (!hasHeadings && cur.chars > 25000)) start(`Część ${chapters.length + 1}`);
    const el = document.createElement('p');
    el.textContent = p;
    cur.el.appendChild(el);
    cur.chars += p.length;
  }
  const title = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return {
    title, author: '', cover: null, notes: {},
    chapters: chapters.filter(c => c.chars > 0 || c.el.childNodes.length > 1)
      .map(c => ({ title: c.title, html: c.el.innerHTML, chars: c.chars || 1 })),
  };
}

export async function importFile(file) {
  const buf = await file.arrayBuffer();
  const name = file.name || 'Książka';
  if (/\.epub$/i.test(name) || file.type === 'application/epub+zip') return importEpub(buf, name);
  if (/\.txt$/i.test(name) || file.type === 'text/plain') return importTxt(buf, name);
  throw new Error('Obsługuję pliki EPUB i TXT.');
}
