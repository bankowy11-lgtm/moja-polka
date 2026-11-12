// Książki są zapisane w pamięci telefonu (IndexedDB) i działają bez internetu.
// "books"   – lekkie dane do biblioteki (tytuł, okładka, postęp, zakładki)
// "content" – pełny tekst książki (rozdziały, przypisy)
// "meta"    – drobne ustawienia aplikacji

const DB_NAME = 'moja-polka';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('content', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Zapis przerwany (może brakuje miejsca w pamięci).'));
  });
}

export const db = {
  allBooks: () => run(['books'], 'readonly', t => t.objectStore('books').getAll()),
  getBook: id => run(['books'], 'readonly', t => t.objectStore('books').get(id)),
  putBook: book => run(['books'], 'readwrite', t => t.objectStore('books').put(book)),
  getContent: id => run(['content'], 'readonly', t => t.objectStore('content').get(id)),
  addBook: (book, content) => run(['books', 'content'], 'readwrite', t => {
    t.objectStore('content').put({ id: book.id, ...content });
    return t.objectStore('books').put(book);
  }),
  deleteBook: id => run(['books', 'content'], 'readwrite', t => {
    t.objectStore('content').delete(id);
    return t.objectStore('books').delete(id);
  }),
  getMeta: async key => (await run(['meta'], 'readonly', t => t.objectStore('meta').get(key)))?.value,
  setMeta: (key, value) => run(['meta'], 'readwrite', t => t.objectStore('meta').put({ id: key, value })),
};
