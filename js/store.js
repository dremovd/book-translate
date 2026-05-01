// Reads from globalThis so the browser (window.localforage from CDN)
// and Node tests (fake localforage installed on globalThis) both work.
function lf() {
  if (!globalThis.localforage) throw new Error('localforage not loaded');
  return globalThis.localforage;
}

// Each tool gets its own namespaced key so the editor and the bilingual
// translator don't clobber each other's state.
export function makeStore(key) {
  return {
    async save(data) { await lf().setItem(key, JSON.parse(JSON.stringify(data))); },
    async load()     { return await lf().getItem(key); },
    async clear()    { await lf().removeItem(key); },
  };
}

// Default store for the single-source editor (component.js).
export const store = makeStore('book-translate-state:v1');
