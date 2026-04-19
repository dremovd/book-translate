// Install stubs on globalThis that browser code depends on.
// Importing this module for its side effects is enough.

// In-memory localforage — store.js reads globalThis.localforage at call time.
const _mem = new Map();
globalThis.localforage = {
  async setItem(k, v) { _mem.set(k, JSON.parse(JSON.stringify(v))); },
  async getItem(k)    { return _mem.has(k) ? JSON.parse(JSON.stringify(_mem.get(k))) : null; },
  async removeItem(k) { _mem.delete(k); },
  _clear()            { _mem.clear(); },
};

// component.js calls globalThis.confirm() via _confirm; default to "yes" in tests.
globalThis.confirm = () => true;

export function clearStore() { globalThis.localforage._clear(); }

export function withFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = prev; };
}

// Minimal fetch Response shape factory.
export function mockResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok, status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}
