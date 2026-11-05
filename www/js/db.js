// Tiny IndexedDB wrapper. Stores: books, files (blobs), days (reading stats), kv.
const DB_NAME = 'inkpage';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('files');
      d.createObjectStore('days', { keyPath: 'day' });
      d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        const rq = fn(s);
        if (rq) rq.onsuccess = () => (out = rq.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value, key) =>
    tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  // Atomic read-modify-write for keyPath stores (books, days).
  // fn receives the current value (or undefined) and returns the new value.
  update: (store, key, fn) =>
    open().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction(store, 'readwrite');
          const s = t.objectStore(store);
          const g = s.get(key);
          g.onsuccess = () => {
            const next = fn(g.result);
            if (next !== undefined) s.put(next);
          };
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    ),
};

// ---- settings (small, synchronous via localStorage) ----
const DEFAULTS = {
  theme: 'dark',
  accent: '#7c9cff',
  mode: 'paged-rtl', // paged-ltr | paged-rtl | webtoon
  fit: 'screen', // screen | width | height
  spread: false,
  invertTaps: false,
  keepAwake: true,
  dailyGoal: 20, // minutes
  dim: 0, // 0..0.7 reader dimming overlay
  readerBg: 'black', // black | gray | white
};

let cache;
export function getSettings() {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('inkpage.settings') || '{}') };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  return cache;
}
export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try {
    localStorage.setItem('inkpage.settings', JSON.stringify(s));
  } catch {}
  return s;
}
export function resetSettings() {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem('inkpage.settings');
  } catch {}
}
