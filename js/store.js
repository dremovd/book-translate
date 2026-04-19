const KEY = 'book-translate-state:v1';

// Reads from globalThis so the browser (window.localforage from CDN)
// and Node tests (fake localforage installed on globalThis) both work.
function lf() {
  if (!globalThis.localforage) throw new Error('localforage not loaded');
  return globalThis.localforage;
}

export const store = {
  async save(data) { await lf().setItem(KEY, JSON.parse(JSON.stringify(data))); },
  async load()     { return await lf().getItem(KEY); },
  async clear()    { await lf().removeItem(KEY); },
};
