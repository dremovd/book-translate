import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, mockResponse, clearStore } from './_setup.js';
import { PoeTranslator } from '../js/translators/poe.js';

// PoeTranslator.buildDictionary caches responses in localforage keyed by
// hash(model, messages). Without this hook, a chunk + prompt + model
// reused across tests would hit cache from the previous test's mock and
// the inline mock here would never run.
beforeEach(() => clearStore());

// Parsing/formatting helpers used by PoeTranslator are tested in format.test.js.
// This file covers what PoeTranslator itself is responsible for: HTTP shape,
// error handling, and the end-to-end integration of buildDictionary /
// translateChapter with mocked fetch.

test('PoeTranslator: throws without an API key', () => {
  assert.throws(() => new PoeTranslator({ apiKey: '', model: 'X', baseUrl: 'http://x' }));
});

test('PoeTranslator: throws without a model', () => {
  assert.throws(() => new PoeTranslator({ apiKey: 'k', model: '', baseUrl: 'http://x' }));
});

test('PoeTranslator.chat: builds the correct request and parses the response', async () => {
  let captured;
  const restore = withFetch(async (url, opts) => {
    captured = { url, opts };
    return mockResponse({ body: { choices: [{ message: { content: 'hi back' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'secret', model: 'Bot', baseUrl: 'http://x/v1' });
    const out = await t.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(out, 'hi back');
    assert.equal(captured.url, 'http://x/v1/chat/completions');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['Authorization'], 'Bearer secret');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, 'Bot');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  } finally { restore(); }
});

test('PoeTranslator.chat: strips trailing slashes on baseUrl', async () => {
  let captured;
  const restore = withFetch(async (url) => {
    captured = { url };
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x/v1///' });
    await t.chat([{ role: 'user', content: 'x' }]);
    assert.equal(captured.url, 'http://x/v1/chat/completions');
  } finally { restore(); }
});

test('PoeTranslator.chat: surfaces non-2xx responses', async () => {
  const restore = withFetch(async () => mockResponse({ ok: false, status: 401, body: 'unauthorized' }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await assert.rejects(t.chat([{ role: 'user', content: 'x' }]), /401/);
  } finally { restore(); }
});

test('PoeTranslator.chat: rejects on malformed response shape', async () => {
  const restore = withFetch(async () => mockResponse({ body: { nope: true } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await assert.rejects(t.chat([{ role: 'user', content: 'x' }]));
  } finally { restore(); }
});

// Helper for the 3-phase dictionary flow. Extract calls echo a JSON array
// of strings; translate calls (recognized by "Terms:" at the user message
// start) echo a JSON array of {term, translation, notes}.
//
// Responses can be supplied as an array (assigned in the order extract
// calls *arrive*) or as a `byContent` map (matched against a substring of
// the user message). With dictionary caching plus extract concurrency,
// the arrival order isn't strictly the chapter order, so tests that care
// about per-chapter responses should use `byContent`.
function dictFetchMock({ extractResponses = [], extractByContent = null, translateResponse = '[]' } = {}) {
  const calls = { extract: [], translate: [] };
  let extractIdx = 0;
  const impl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Terms:')) {
      calls.translate.push(userMsg);
      return mockResponse({ body: { choices: [{ message: { content: translateResponse } }] } });
    }
    calls.extract.push(userMsg);
    let content;
    if (extractByContent) {
      const hit = Object.entries(extractByContent).find(([needle]) => userMsg.includes(needle));
      content = hit ? hit[1] : '[]';
    } else {
      content = extractResponses[extractIdx++] ?? extractResponses[extractResponses.length - 1] ?? '[]';
    }
    return mockResponse({ body: { choices: [{ message: { content } }] } });
  };
  return { impl, calls };
}

test('PoeTranslator.buildDictionary: small book → 1 extract + 1 translate, entries carry chapters[]', async () => {
  const { impl, calls } = dictFetchMock({
    extractResponses: ['["Winston", "Julia"]'],
    translateResponse: '[{"term":"Winston","translation":"Уинстон"},{"term":"Julia","translation":"Джулия"}]',
  });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'Winston met Julia.' }] }]);
    assert.equal(calls.extract.length, 1);
    assert.equal(calls.translate.length, 1);
    assert.equal(dict.length, 2);
    for (const e of dict) assert.deepEqual(e.chapters, [0], `entry "${e.term}" should be tagged to chapter 0`);
    const byTerm = Object.fromEntries(dict.map(e => [e.term, e]));
    assert.equal(byTerm.Winston.translation, 'Уинстон');
    assert.equal(byTerm.Julia.translation, 'Джулия');
    assert.match(calls.translate[0], /Winston/);
    assert.match(calls.translate[0], /Julia/);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: multiple chapters → one extract call per chapter, entries carry their chapter origin', async () => {
  // Match by chunk content rather than arrival order — extract calls are
  // dispatched concurrently and may resolve out of input order once the
  // dictionary cache adds an extra await before the network call.
  const { impl, calls } = dictFetchMock({
    extractByContent: {
      [`# One\n\n${'x'.repeat(150)}`]:   '["A"]',
      [`# Two\n\n${'y'.repeat(150)}`]:   '["B"]',
      [`# Three\n\n${'z'.repeat(150)}`]: '["A", "C"]',
    },
    translateResponse: '[{"term":"A","translation":"а"},{"term":"B","translation":"б"},{"term":"C","translation":"в"}]',
  });
  const restore = withFetch(impl);
  try {
    const chapters = [
      { title: 'One',   paragraphs: [{ original: 'x'.repeat(150) }] },
      { title: 'Two',   paragraphs: [{ original: 'y'.repeat(150) }] },
      { title: 'Three', paragraphs: [{ original: 'z'.repeat(150) }] },
    ];
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x',
      dictionaryChunkChars: 200,
    });
    const dict = await t.buildDictionary(chapters);
    assert.equal(calls.extract.length, 3, 'one extract call per chapter');
    assert.equal(calls.translate.length, 1);
    // Merged list in the translate call should be deduplicated — A appears in two chunks.
    const body = calls.translate[0];
    assert.equal((body.match(/- A\b/g) ?? []).length, 1, 'merged list must dedupe A');
    assert.equal(dict.length, 3);
    const byTerm = Object.fromEntries(dict.map(e => [e.term, e]));
    assert.deepEqual(byTerm.A.chapters, [0, 2], 'A appeared in chapters 0 and 2');
    assert.deepEqual(byTerm.B.chapters, [1]);
    assert.deepEqual(byTerm.C.chapters, [2]);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: dictionaryGuidance is forwarded to both extract and translate system prompts', async () => {
  const calls = { extract: null, translate: null };
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const sys = body.messages.find(m => m.role === 'system')?.content ?? '';
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      calls.translate = sys;
      return mockResponse({ body: { choices: [{ message: { content: '[{"term":"X","translation":"Х"}]' } }] } });
    }
    calls.extract = sys;
    return mockResponse({ body: { choices: [{ message: { content: '["X"]' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x',
      dictionaryGuidance: 'Use the Spivak scheme. Include magical spells. Normalize caps.',
    });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'hi' }] }]);
    assert.match(calls.extract, /Spivak/);
    assert.match(calls.extract, /Include magical spells/);
    assert.match(calls.translate, /Spivak/);
    assert.match(calls.translate, /Normalize caps/);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: empty dictionaryGuidance adds no guidance section', async () => {
  let extractSys, translateSys;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const sys = body.messages.find(m => m.role === 'system')?.content ?? '';
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateSys = sys;
      return mockResponse({ body: { choices: [{ message: { content: '[{"term":"X","translation":"Х"}]' } }] } });
    }
    extractSys = sys;
    return mockResponse({ body: { choices: [{ message: { content: '["X"]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'hi' }] }]);
    assert.doesNotMatch(extractSys, /editor guidance/i);
    assert.doesNotMatch(translateSys, /editor guidance/i);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: when dictionaryModel is set, extract AND translate-terms calls use it', async () => {
  const models = { extract: [], translate: [] };
  const restore = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      models.translate.push(body.model);
      return mockResponse({ body: { choices: [{ message: { content: '[{"term":"W","translation":"В"}]' } }] } });
    }
    models.extract.push(body.model);
    return mockResponse({ body: { choices: [{ message: { content: '["W"]' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'Strong-Model', baseUrl: 'http://x',
      dictionaryModel: 'Cheap-Fast-Model',
    });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'Winston met Julia.' }] }]);
    assert.deepEqual(models.extract, ['Cheap-Fast-Model']);
    assert.deepEqual(models.translate, ['Cheap-Fast-Model']);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: when dictionaryModel is blank, falls back to the main model', async () => {
  const seen = [];
  const restore = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    const content = user.startsWith('Terms:') ? '[]' : '["X"]';
    return mockResponse({ body: { choices: [{ message: { content } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'Main-Model', baseUrl: 'http://x',
      dictionaryModel: '   ',  // whitespace → treat as unset
    });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'x' }] }]);
    for (const m of seen) assert.equal(m, 'Main-Model');
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: always uses the main model, ignores dictionaryModel', async () => {
  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'Strong-Model', baseUrl: 'http://x',
      dictionaryModel: 'Cheap-Fast-Model',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    assert.equal(usedModel, 'Strong-Model');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: always uses the main model, ignores dictionaryModel', async () => {
  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'Strong-Model', baseUrl: 'http://x',
      dictionaryModel: 'Cheap-Fast-Model',
    });
    await t.translateParagraph({ original: 'foo' }, 'natural', []);
    assert.equal(usedModel, 'Strong-Model');
  } finally { restore(); }
});

// Set up an in-process pinyin-pro stub on globalThis so the offline
// Palladius pipeline (palladius.js → pinyin-pro → syllable table) has
// the data it needs in Node tests. Browser code uses real pinyin-pro
// from the CDN script tag.
function withPinyinPro(fixture) {
  const prev = globalThis.pinyinPro;
  globalThis.pinyinPro = {
    pinyin: (text) => fixture[text] ?? text,
  };
  return () => { globalThis.pinyinPro = prev; };
}

test('PoeTranslator.buildDictionary: Palladius is OFF by default — no hints injected, no pinyin-pro consulted', async () => {
  // Stub pinyin-pro to fail loudly if it's invoked; the gate must
  // short-circuit before we ever look it up.
  const restorePinyin = withPinyinPro(new Proxy({}, {
    get() { throw new Error('pinyin-pro should not be invoked when usePalladius is off'); },
  }));
  let translateUserMsg = null;
  let translateSystemMsg = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateUserMsg = user;
      translateSystemMsg = body.messages.find(m => m.role === 'system')?.content ?? '';
      return mockResponse({ body: { choices: [{ message: { content:
        '[{"term":"阮眠","translation":"Жуань","notes":""}]'
      } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '["阮眠"]' } }] } });
  });
  try {
    // No usePalladius set → falsy → Palladius gate is closed.
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: '阮眠.' }] }]);
    assert.doesNotMatch(translateUserMsg, /Palladius:/);
    assert.doesNotMatch(translateSystemMsg, /Palladius/);
  } finally { restore(); restorePinyin(); }
});

test('PoeTranslator.buildDictionary: with usePalladius=true, transliterations land in the translate-prompt as hints', async () => {
  const restorePinyin = withPinyinPro({ '阮眠': 'ruan mian', '方茹清': 'fang ru qing' });
  let translateUserMsg = null;
  let translateSystemMsg = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateUserMsg = user;
      translateSystemMsg = body.messages.find(m => m.role === 'system')?.content ?? '';
      return mockResponse({ body: { choices: [{ message: { content:
        '[{"term":"阮眠","translation":"Жуань Мянь","notes":""},{"term":"方茹清","translation":"Фан Жу Цин","notes":""}]'
      } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '["阮眠", "方茹清"]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x', usePalladius: true });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: '阮眠 met 方茹清.' }] }]);
    // Each CJK term is annotated with its Palladius output in the user msg.
    assert.match(translateUserMsg, /阮眠 \(Palladius: Жуань Мянь\)/);
    assert.match(translateUserMsg, /方茹清 \(Palladius: Фан Жу Цин\)/);
    // System prompt acquires the Palladius-usage instructions when hints exist.
    assert.match(translateSystemMsg, /Palladius/);
  } finally { restore(); restorePinyin(); }
});

test('PoeTranslator.buildDictionary: no Palladius call and no annotation when there are no CJK terms', async () => {
  let pinyinCalled = 0;
  const restorePinyin = withPinyinPro(new Proxy({}, {
    get() { pinyinCalled++; throw new Error('pinyin-pro should not be invoked when no CJK terms'); },
  }));
  let translateUserMsg = null;
  let translateSystemMsg = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateUserMsg = user;
      translateSystemMsg = body.messages.find(m => m.role === 'system')?.content ?? '';
      return mockResponse({ body: { choices: [{ message: { content:
        '[{"term":"Hogwarts","translation":"Хогвартс","notes":"school"}]'
      } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '["Hogwarts"]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'Hogwarts is a school.' }] }]);
    assert.equal(dict[0].translation, 'Хогвартс');
    assert.equal(pinyinCalled, 0);
    assert.doesNotMatch(translateUserMsg, /Palladius:/);
    assert.doesNotMatch(translateSystemMsg, /Palladius/);
  } finally { restore(); restorePinyin(); }
});

test('PoeTranslator.buildDictionary: with usePalladius=true but pinyin-pro missing, gracefully falls back to no hints', async () => {
  // Simulate the "pinyin-pro hasn't loaded yet" failure mode.
  const prev = globalThis.pinyinPro;
  delete globalThis.pinyinPro;
  let translateUserMsg = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateUserMsg = user;
      return mockResponse({ body: { choices: [{ message: { content:
        '[{"term":"阮眠","translation":"Жуань","notes":""}]'
      } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '["阮眠"]' } }] } });
  });
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x', usePalladius: true });
    const dict = await t.buildDictionary([{ title: 'c', paragraphs: [{ original: '阮眠.' }] }]);
    // No Palladius annotation in the prompt — fallback to the bare term form.
    assert.doesNotMatch(translateUserMsg, /Palladius:/);
    // LLM result survives intact.
    assert.equal(dict[0].translation, 'Жуань');
  } finally {
    console.warn = prevWarn;
    restore();
    globalThis.pinyinPro = prev;
  }
});

test('PoeTranslator.buildBilingualDictionary: Palladius hints reference (Chinese) form into the translate-pairs prompt', async () => {
  const restorePinyin = withPinyinPro({ '阮眠': 'ruan mian' });
  let translateUserMsg = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Pairs:')) {
      translateUserMsg = user;
      return mockResponse({ body: { choices: [{ message: { content:
        '[{"term":"Ruan Mian","originalForm":"阮眠","translation":"Жуань Мянь","notes":""}]'
      } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[{"original":"Ruan Mian","reference":"阮眠"}]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x',
      editorLanguage: 'English', referenceLanguage: 'Chinese', targetLanguage: 'Russian',
      usePalladius: true });
    const dict = await t.buildBilingualDictionary([{
      title: 'Chapter One', paragraphs: [{ original: 'Ruan Mian arrived.' }],
      referenceText: '# 第01章\n\n阮眠到了。',
    }]);
    // Pair line carries the Palladius annotation (offline-computed:
    // pinyin-pro stub returns "ruan mian" → Palladius rules → "Жуань Мянь").
    assert.match(translateUserMsg, /Ruan Mian {2}↔ {2}阮眠 \(Palladius: Жуань Мянь\)/);
    assert.equal(dict[0].translation, 'Жуань Мянь');
    assert.equal(dict[0].originalForm, '阮眠');
  } finally { restore(); restorePinyin(); }
});

test('PoeTranslator.buildDictionary: identical input → second build hits cache, no fetches', async () => {
  let fetchCalls = 0;
  const restore = withFetch(async (_u, opts) => {
    fetchCalls++;
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    const content = user.startsWith('Terms:')
      ? '[{"term":"X","translation":"Х"}]'
      : '["X"]';
    return mockResponse({ body: { choices: [{ message: { content } }] } });
  });
  try {
    const chapters = [{ title: 'c', paragraphs: [{ original: 'X is a thing.' }] }];
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict1 = await t.buildDictionary(chapters);
    assert.equal(fetchCalls, 2, 'first build: 1 extract + 1 translate');
    const dict2 = await t.buildDictionary(chapters);
    assert.equal(fetchCalls, 2, 'second build: served from cache, no new fetches');
    assert.deepEqual(dict1, dict2, 'cached result must match the original');
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: different model invalidates cache', async () => {
  let fetchCalls = 0;
  const restore = withFetch(async (_u, opts) => {
    fetchCalls++;
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    return mockResponse({ body: { choices: [{ message: { content: user.startsWith('Terms:') ? '[]' : '[]' } }] } });
  });
  try {
    const chapters = [{ title: 'c', paragraphs: [{ original: 'X is a thing.' }] }];
    await new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' }).buildDictionary(chapters);
    const after1 = fetchCalls;
    await new PoeTranslator({ apiKey: 'k', model: 'M2', baseUrl: 'http://x' }).buildDictionary(chapters);
    assert.ok(fetchCalls > after1, 'switching model must miss cache');
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: changing dictionaryGuidance invalidates cache', async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls++;
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const chapters = [{ title: 'c', paragraphs: [{ original: 'text' }] }];
    await new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' }).buildDictionary(chapters);
    const after1 = fetchCalls;
    await new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x', dictionaryGuidance: 'NEW RULES' }).buildDictionary(chapters);
    assert.ok(fetchCalls > after1, 'changing guidance changes the system prompt and must miss cache');
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: extract prompt explicitly asks for real-world references', async () => {
  // Inline mock that captures the system prompt for the extract call.
  let extractSystem;
  const restore2 = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (!user.startsWith('Terms:')) {
      extractSystem = body.messages.find(m => m.role === 'system')?.content;
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'text' }] }]);
    assert.match(extractSystem, /real-world references/i);
    assert.match(extractSystem, /canonical/i);
    assert.match(extractSystem, /books.*films.*songs|titles of books/i);
  } finally { restore2(); }
});

test('PoeTranslator.buildDictionary: translate prompt asks for canonical published translations', async () => {
  let translateSystem;
  const restore = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Terms:')) {
      translateSystem = body.messages.find(m => m.role === 'system')?.content;
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '["X"]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'text' }] }]);
    assert.match(translateSystem, /canonical/i);
    assert.match(translateSystem, /published|standard/i);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: calls onProgress through extract then translate stages', async () => {
  const { impl } = dictFetchMock({
    extractResponses: ['["A"]', '["B"]'],
    translateResponse: '[{"term":"A","translation":"а"},{"term":"B","translation":"б"}]',
  });
  const restore = withFetch(impl);
  try {
    const events = [];
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', dictionaryChunkChars: 100,
    });
    await t.buildDictionary(
      [
        { title: 'A', paragraphs: [{ original: 'x'.repeat(40) }] },
        { title: 'B', paragraphs: [{ original: 'y'.repeat(40) }] },
      ],
      { onProgress: (p) => events.push({ ...p }) }
    );
    const extracts = events.filter(e => e.stage === 'extract');
    assert.ok(extracts.length >= 2, `expected multiple extract progress events, got ${extracts.length}`);
    const lastExtract = extracts[extracts.length - 1];
    assert.equal(lastExtract.current, 2);
    assert.equal(lastExtract.total, 2);

    const translates = events.filter(e => e.stage === 'translate');
    assert.ok(translates.length >= 1, 'translate stage must emit at least one event');
    const lastTranslate = translates[translates.length - 1];
    assert.equal(lastTranslate.current, 1);
    assert.equal(lastTranslate.total, 1);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: onProgress is optional (no callback → no crash)', async () => {
  const { impl } = dictFetchMock({
    extractResponses: ['["X"]'],
    translateResponse: '[{"term":"X","translation":"Х"}]',
  });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'x' }] }]);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: no extracted terms → no translate call, empty dict', async () => {
  const { impl, calls } = dictFetchMock({ extractResponses: ['[]'] });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'text' }] }]);
    assert.equal(dict.length, 0);
    assert.equal(calls.translate.length, 0, 'should not call translate when no terms');
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: preserves index alignment and returns titleTranslation from [0]', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[0] Глава 1\n\n[1] foo-ru\n\n[2] bar-ru\n\n[3] baz-ru' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const chapter = { title: 'Chapter 1', paragraphs: [
      { original: 'foo' }, { original: 'bar' }, { original: 'baz' },
    ]};
    const out = await t.translateChapter(chapter, [], []);
    assert.equal(out.titleTranslation, 'Глава 1');
    assert.equal(out.paragraphs.length, 3);
    assert.deepEqual(out.paragraphs.map(p => p.translation), ['foo-ru', 'bar-ru', 'baz-ru']);
    for (const p of out.paragraphs) assert.equal(p.status, 'translated');
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: missing paragraphs fall back to original with untranslated status', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[0] Глава\n\n[1] foo-ru\n\n[3] baz-ru' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateChapter(
      { title: 'Chapter', paragraphs: [{ original: 'foo' }, { original: 'bar' }, { original: 'baz' }] },
      [], []
    );
    assert.equal(out.titleTranslation, 'Глава');
    assert.equal(out.paragraphs[0].translation, 'foo-ru');
    assert.equal(out.paragraphs[0].status, 'translated');
    assert.equal(out.paragraphs[1].translation, 'bar');
    assert.equal(out.paragraphs[1].status, 'untranslated');
    assert.equal(out.paragraphs[2].translation, 'baz-ru');
    assert.equal(out.paragraphs[2].status, 'translated');
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: missing [0] in response falls back to original title', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[1] x' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateChapter(
      { title: 'Original Title', paragraphs: [{ original: 'foo' }] },
      [], []
    );
    assert.equal(out.titleTranslation, 'Original Title');
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: preset v1 — "natural & idiomatic" style, no two-stage mandate', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationPromptPreset: 'v1',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /publication-ready Russian/);
    assert.match(sys, /translationese/);
    assert.doesNotMatch(sys, /two stages/i);
    assert.doesNotMatch(sys, /native Russian writer/);
    // Structural contract is always appended regardless of preset.
    assert.match(sys, /\[0\] is the chapter title/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: preset custom uses translationPromptCustom with ${lang} interpolated', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationPromptPreset: 'custom',
      translationPromptCustom: 'Translate into ${lang} like a drunken poet. The ${lang} reader must laugh.',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /Translate into Russian like a drunken poet\. The Russian reader must laugh\./);
    // Neither preset's distinctive phrasing should be present.
    assert.doesNotMatch(sys, /two stages/i);
    assert.doesNotMatch(sys, /publication-ready Russian that reads fully natural/);
    // Structural contract + dictionary still appended.
    assert.match(sys, /\[0\] is the chapter title/);
    assert.match(sys, /Use this dictionary/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: preset custom with empty custom field falls back to v2', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationPromptPreset: 'custom',
      translationPromptCustom: '   ',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /two stages/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: unknown preset falls back to v2', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationPromptPreset: 'nonexistent',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    assert.match(sentBody.messages[0].content, /two stages/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: sends title as [0] in the user prompt', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateChapter({ title: 'My Chapter', paragraphs: [{ original: 'foo' }] }, [], []);
    const userMsgs = sentBody.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    assert.match(userMsgs, /\[0\] My Chapter/);
    assert.match(userMsgs, /\[1\] foo/);
  } finally { restore(); }
});

// ---------- translateParagraph ----------

test('PoeTranslator.translateParagraph: default mode — no BIAS block, style preset still governs', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
    });
    await t.translateParagraph({ original: 'hello' }, 'default', []);
    const sys = sentBody.messages[0].content;
    // No strict/natural BIAS line.
    assert.doesNotMatch(sys, /BIAS\s*\(strict\)/);
    assert.doesNotMatch(sys, /BIAS\s*\(natural\)/);
    // Core instruction and shared sections still present.
    assert.match(sys, /Translate ONE paragraph into Russian/);
    assert.match(sys, /italic/i);  // inline-markers block
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: default mode IGNORES any existing translation — source-only, fresh take', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph(
      { original: 'Hello world.', translation: 'Старый перевод, совсем не похож.' },
      'default', []
    );
    const all = sentBody.messages.map(m => m.content).join('\n');
    // Existing translation must not be fed to the model.
    assert.doesNotMatch(all, /Старый перевод/);
    assert.doesNotMatch(all, /current translation/i);
    assert.doesNotMatch(all, /A CURRENT TRANSLATION/);
    // Source still present.
    assert.match(all, /Hello world\./);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: strict mode — system prompt biases toward literal fidelity', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'перевод' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian' });
    const out = await t.translateParagraph(
      { original: 'Hello world.' }, 'strict', [], { chapterTitle: 'Ch 1' }
    );
    assert.equal(out, 'перевод');
    const sys = sentBody.messages[0].content;
    assert.match(sys, /stay close to the original|literal/i);
    assert.doesNotMatch(sys, /\[0\]|\[1\]/);  // no numbered-paragraph protocol for single-paragraph calls
    assert.match(sys, /one paragraph|ONE paragraph/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: natural mode — system prompt biases toward native fluency', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'yeah' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian' });
    await t.translateParagraph({ original: 'Hello.' }, 'natural', []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /native Russian prose|as if a .+ writer wrote it|Calques of English are a failure/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: includes dictionary subset and prior paragraphs in prompt', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = [{ term: 'Winston', translation: 'Уинстон', notes: '' }];
    const prior = [
      { original: 'Earlier.', translation: 'Раньше.' },
      { original: 'Untranslated.', translation: '' },  // should be filtered out
    ];
    await t.translateParagraph(
      { original: 'Winston walked.' },
      'strict', dict,
      { chapterTitle: 'Chapter One', priorParagraphs: prior }
    );
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.match(all, /Winston → Уинстон/);
    assert.match(all, /Chapter One/);
    assert.match(all, /Earlier\./);
    assert.match(all, /Раньше\./);
    assert.doesNotMatch(all, /Untranslated\./);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: includes current translation as a "revise this" block when present', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'новый вариант' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph(
      { original: 'Hello world.', translation: 'Старый перевод.' },
      'natural', []
    );
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.match(all, /Старый перевод\./);
    assert.match(all, /current translation/i);
    // System prompt should tell the model not to echo it back unchanged.
    assert.match(sentBody.messages[0].content, /do not (?:merely )?repeat|do not output it verbatim/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: omits current-translation block when paragraph.translation is empty', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph({ original: 'Hello.', translation: '' }, 'strict', []);
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.doesNotMatch(all, /current translation/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: strips "Translation:" label and an unambiguous wrapper pair of quotes', async () => {
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: 'Translation: "переведённый текст"' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: 'foo' }, 'natural', []);
    assert.equal(out, 'переведённый текст');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: KEEPS quotes that belong inside the paragraph (direct speech / inner monologue)', async () => {
  // Paragraph both starts AND ends with " but contains further " in the
  // middle — the whole thing is direct speech, the outer quotes are
  // meaningful, and the stripper must not eat them.
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '"Я думаю," — подумал он, — "что это необычно."' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: 'He thought things.' }, 'natural', []);
    // All four " chars must survive — they're part of the prose.
    assert.equal((out.match(/"/g) ?? []).length, 4);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: KEEPS a single opening quote with non-quote terminator (half-dialog)', async () => {
  // Paragraph starts with " but does NOT end with " — the leading quote
  // is part of prose; the stripper must not eat it.
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '"Здравствуй," — сказал он и улыбнулся.' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: '"Hello," he said, smiling.' }, 'natural', []);
    assert.ok(out.startsWith('"'), 'opening quote must be preserved');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: source wrapped in "…" — output outer quotes are KEPT (direct-speech line)', async () => {
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '"Здравствуй, мир."' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: '"Hello, world."' }, 'natural', []);
    assert.equal(out, '"Здравствуй, мир."');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: source NOT wrapped — output outer quotes are STILL stripped (model error)', async () => {
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '"Это не должно быть в кавычках."' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: 'This should not be quoted.' }, 'natural', []);
    assert.equal(out, 'Это не должно быть в кавычках.');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: source wrapped in «…» — output « » pair is preserved', async () => {
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '«Bonjour, monde.»' } }] } }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.translateParagraph({ original: '«Hello, world.»' }, 'natural', []);
    assert.equal(out, '«Bonjour, monde.»');
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: prompt allows internal quotes and forbids only the wrapping pair', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph({ original: '"foo" she said' }, 'natural', []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /do not wrap.*quotation marks/i);
    assert.match(sys, /keep.*quotation marks|direct speech|inner monologue|inside/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: prompt explains inline *italic* / **bold** markers', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: '*a thought*' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /italic/i);
    assert.match(sys, /thought|inner|internal/i);
    assert.match(sys, /guidance/i);
    assert.match(sys, /preserve/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: prompt explains inline *italic* / **bold** markers', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph({ original: '*thought*' }, 'natural', []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /italic/i);
    assert.match(sys, /thought|inner|internal/i);
    assert.match(sys, /preserve/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: translationGuidance is appended to the v2 preset', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationGuidance: 'Use formal вы throughout. Preserve rhetorical irony.',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /Use formal вы throughout/);
    assert.match(sys, /Preserve rhetorical irony/);
    // v2 preset + structural contract still present.
    assert.match(sys, /two stages/i);
    assert.match(sys, /\[0\] is the chapter title/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: translationGuidance is appended to the v1 preset too', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationPromptPreset: 'v1',
      translationGuidance: 'Keep sentences short.',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /publication-ready Russian/);   // v1 mandate
    assert.match(sys, /Keep sentences short/);        // appended guidance
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: empty translationGuidance adds no extra section', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    assert.doesNotMatch(sentBody.messages[0].content, /Additional guidance/i);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: translationGuidance reaches the system prompt', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: 'x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
      translationGuidance: 'Use nautical register.',
    });
    await t.translateParagraph({ original: 'foo' }, 'natural', []);
    assert.match(sentBody.messages[0].content, /Use nautical register/);
  } finally { restore(); }
});

// ---------- chapter / paragraph alignment ----------

test('PoeTranslator.alignChapters: parses {b, s[]} mapping into 0-based indices', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[{"b":1,"s":[2]},{"b":2,"s":[3,4]},{"b":3,"s":[]}]' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const sourceBook = { chapters: [
      { title: 'S1', paragraphs: [{ original: 'a' }] },
      { title: 'S2', paragraphs: [{ original: 'b' }] },
      { title: 'S3', paragraphs: [{ original: 'c' }] },
      { title: 'S4', paragraphs: [{ original: 'd' }] },
    ]};
    const bBook = { chapters: [
      { title: 'B1', paragraphs: [{ original: 'x' }] },
      { title: 'B2', paragraphs: [{ original: 'y' }] },
      { title: 'B3', paragraphs: [{ original: 'z' }] },
    ]};
    const out = await t.alignChapters(sourceBook, bBook);
    assert.deepEqual(out, [
      { bChapterIdx: 0, sourceChapterIndices: [1] },
      { bChapterIdx: 1, sourceChapterIndices: [2, 3] },
      { bChapterIdx: 2, sourceChapterIndices: [] },
    ]);
  } finally { restore(); }
});

test('PoeTranslator.alignChapters: uses dictionaryModel when set', async () => {
  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'BIG', baseUrl: 'http://x',
      dictionaryModel: 'CHEAP',
    });
    await t.alignChapters(
      { chapters: [{ title: 'a', paragraphs: [{ original: 'x' }] }] },
      { chapters: [{ title: 'b', paragraphs: [{ original: 'y' }] }] },
    );
    assert.equal(usedModel, 'CHEAP');
  } finally { restore(); }
});

test('PoeTranslator.alignChapters: drops entries with negative b or non-integer indices', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[{"b":1,"s":[1,-1,2]},{"b":-5,"s":[1]},{"b":2}]' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.alignChapters(
      { chapters: [{ title: 'a', paragraphs: [{ original: 'x' }] }] },
      { chapters: [{ title: 'b', paragraphs: [{ original: 'y' }] }, { title: 'c', paragraphs: [{ original: 'z' }] }] },
    );
    // Entry 1 keeps b=0, drops the -1 from s[]; entry 2 (b=-5) is dropped
    // entirely; entry 3 has missing s → empty.
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { bChapterIdx: 0, sourceChapterIndices: [0, 1] });
    assert.deepEqual(out[1], { bChapterIdx: 1, sourceChapterIndices: [] });
  } finally { restore(); }
});

test('PoeTranslator.alignParagraphsInChapter: parses interval-to-interval matches into 0-based ranges', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[{"bStart":1,"bEnd":1,"sStart":1,"sEnd":3},{"bStart":2,"bEnd":2,"sStart":4,"sEnd":4}]' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.alignParagraphsInChapter(
      [{ paragraphIdx: 0, text: 's1' }, { paragraphIdx: 1, text: 's2' },
       { paragraphIdx: 2, text: 's3' }, { paragraphIdx: 3, text: 's4' }],
      [{ paragraphIdx: 0, text: 'b1' }, { paragraphIdx: 1, text: 'b2' }],
    );
    assert.deepEqual(out, [
      { bStart: 0, bEnd: 0, sStart: 0, sEnd: 2 },
      { bStart: 1, bEnd: 1, sStart: 3, sEnd: 3 },
    ]);
  } finally { restore(); }
});

test('PoeTranslator.alignParagraphsInChapter: drops malformed intervals (out-of-order or negative)', async () => {
  const restore = withFetch(async () => mockResponse({
    body: { choices: [{ message: { content: '[{"bStart":1,"bEnd":1,"sStart":2,"sEnd":4},{"bStart":3,"bEnd":1,"sStart":1,"sEnd":2},{"bStart":1,"bEnd":2,"sStart":-1,"sEnd":1}]' } }] },
  }));
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const out = await t.alignParagraphsInChapter([{ text: 's' }], [{ text: 'b' }]);
    // Only the first survives: second has bEnd<bStart, third has negative sStart.
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { bStart: 0, bEnd: 0, sStart: 1, sEnd: 3 });
  } finally { restore(); }
});

test('PoeTranslator.alignParagraphsInChapter: prompt mentions interval-to-interval (not 1:1)', async () => {
  let sentBody;
  const restore = withFetch(async (_u, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.alignParagraphsInChapter([{ text: 's' }], [{ text: 'b' }]);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /interval[- ]to[- ]interval|range|may not be 1[- ]to[- ]1/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: prompt includes Russian dialog conventions when target is Russian', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /Dialog formatting/);
    assert.match(sys, /em-dash|—/);
    // Stays inside the same numbered paragraph slot when the convention
    // expands a paragraph into multiple lines.
    assert.match(sys, /same numbered paragraph slot|literal newline/i);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: no dialog conventions block for unknown target language', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Klingon',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'foo' }] }, [], []);
    const sys = sentBody.messages[0].content;
    assert.doesNotMatch(sys, /Dialog formatting/);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: includes language-specific dialog conventions', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'French',
    });
    await t.translateParagraph({ original: 'Hello.' }, 'natural', []);
    const sys = sentBody.messages[0].content;
    assert.match(sys, /Dialog formatting \(French\)/);
    assert.match(sys, /guillemets|«/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: prior-chapter context uses the accepted translatedTitle', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t2\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const prior = [{
      title: 'Chapter One',
      translatedTitle: 'Глава Один',
      paragraphs: [{ original: 'Hello.', translation: 'Привет.' }],
    }];
    await t.translateChapter({ title: 'Chapter Two', paragraphs: [{ original: 'Foo' }] }, [], prior);
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.match(all, /Chapter One/);
    assert.match(all, /Глава Один/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: default preset is v2 — two-stage, native-voice mandate', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x', targetLanguage: 'Russian',
    });
    await t.translateChapter({ title: 'c', paragraphs: [{ original: 'Foo' }] }, [], []);
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.match(all, /publication-ready/);
    assert.match(all, /two stages/i);                   // understand → rewrite
    assert.match(all, /native Russian writer/);          // not a translator — a native
    assert.match(all, /translationese/);
    assert.match(all, /original Russian novel/);         // the target standard
    assert.match(all, /author's voice/);
    assert.match(all, /Never skip/);
  } finally { restore(); }
});

// ---------- reference-text (bilingual mode) ----------
//
// When a chapter carries a `referenceText` field (the same chapter in a
// second language, full blob), the translator passes it to the model as
// an authoritative cross-check while still rendering output paragraph-
// numbered against the chapter's own .paragraphs (the "original" side).
// Used by the bilingual tool — the existing single-source editor never
// sets the field, so its prompts must stay byte-identical.

test('PoeTranslator.translateChapter: with referenceText — adds a user message labeling it source of truth', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateChapter(
      { title: 'Ch', paragraphs: [{ original: 'Ruan Mian walked.' }],
        referenceText: '阮眠走了过来。' },
      [], []
    );
    const userMsgs = sentBody.messages.filter(m => m.role === 'user').map(m => m.content);
    const refMsg = userMsgs.find(c => c.includes('阮眠走了过来。'));
    assert.ok(refMsg, 'reference content must appear in a user message');
    assert.match(refMsg, /reference|source of truth|authoritative/i);
    // Numbered original still goes through verbatim.
    const all = userMsgs.join('\n');
    assert.match(all, /\[1\] Ruan Mian walked\./);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: WITHOUT referenceText — prompts are byte-identical to single-source mode', async () => {
  // Capture both shapes and make sure the no-reference run looks exactly
  // the same as it did before this feature existed (regression guard).
  const captures = [];
  const restore = withFetch(async (_url, opts) => {
    captures.push(JSON.parse(opts.body));
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateChapter({ title: 'Ch', paragraphs: [{ original: 'Foo.' }] }, [], []);
    const userContents = captures[0].messages.filter(m => m.role === 'user').map(m => m.content);
    // No "REFERENCE"-labelled or "source of truth" message should leak.
    for (const c of userContents) assert.doesNotMatch(c, /source of truth|REFERENCE \(/);
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: empty/whitespace referenceText is treated as absent', async () => {
  const captures = [];
  const restore = withFetch(async (_url, opts) => {
    captures.push(JSON.parse(opts.body));
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateChapter(
      { title: 'Ch', paragraphs: [{ original: 'Foo.' }], referenceText: '   \n  ' },
      [], []
    );
    const userContents = captures[0].messages.filter(m => m.role === 'user').map(m => m.content);
    for (const c of userContents) assert.doesNotMatch(c, /source of truth/);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: with context.referenceText — adds a chapter-blob reference message', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph(
      { original: 'Ruan Mian walked.' },
      'default', [],
      { referenceText: '阮眠走了过来。这一刻。' }
    );
    const userMsgs = sentBody.messages.filter(m => m.role === 'user').map(m => m.content);
    const refMsg = userMsgs.find(c => c.includes('阮眠走了过来。这一刻。'));
    assert.ok(refMsg, 'reference content must appear in a user message');
    assert.match(refMsg, /reference|source of truth|authoritative/i);
  } finally { restore(); }
});

// ---------- buildBilingualDictionary ----------
//
// Two-source dictionary build: the user's "original" side (e.g. English)
// is what model paragraphs are numbered against; the reference side
// (e.g. Chinese) is the canonical/identity anchor for names. Each
// chapter passes BOTH blobs through the extract phase, asking the model
// for {english, chinese} term pairs. Merge dedupes pairs across chapters
// (one entry per pair, with chapter origins). Translate-pairs phase
// produces final {term, originalForm, translation, notes, chapters}.
//
// Helper for the bilingual flow: extract calls echo a JSON array of
// {original, reference} (or whatever shape implementation chooses);
// translate calls (recognized by the "Pairs:" or "Terms:" prefix in the
// user message) echo the translated objects.
function bilingualDictFetchMock({ extractResponses = [], translateResponse = '[]' } = {}) {
  const calls = { extract: [], translate: [] };
  let extractIdx = 0;
  const impl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:') || userMsg.startsWith('Terms:')) {
      calls.translate.push(userMsg);
      return mockResponse({ body: { choices: [{ message: { content: translateResponse } }] } });
    }
    calls.extract.push({ user: userMsg, system: body.messages.find(m => m.role === 'system')?.content ?? '' });
    const content = extractResponses[extractIdx++] ?? extractResponses[extractResponses.length - 1] ?? '[]';
    return mockResponse({ body: { choices: [{ message: { content } }] } });
  };
  return { impl, calls };
}

test('PoeTranslator.buildBilingualDictionary: extract sees both original chunk and reference blob', async () => {
  const { impl, calls } = bilingualDictFetchMock({
    extractResponses: ['[{"original":"Ruan Mian","reference":"阮眠"}]'],
    translateResponse: '[{"term":"Ruan Mian","originalForm":"阮眠","translation":"Жуань Мянь","notes":"protagonist"}]',
  });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x',
      targetLanguage: 'Russian', originalLanguage: 'English', referenceLanguage: 'Chinese',
    });
    const dict = await t.buildBilingualDictionary([{
      title: 'Ch 1',
      paragraphs: [{ original: 'Ruan Mian arrived.' }],
      referenceText: '阮眠到了。',
    }]);
    assert.equal(calls.extract.length, 1);
    assert.equal(calls.translate.length, 1);
    // Extract call's user message must contain BOTH sides.
    assert.match(calls.extract[0].user, /Ruan Mian arrived/);
    assert.match(calls.extract[0].user, /阮眠到了/);
    // Result has the bilingual shape.
    assert.equal(dict.length, 1);
    assert.equal(dict[0].term, 'Ruan Mian');
    assert.equal(dict[0].originalForm, '阮眠');
    assert.equal(dict[0].translation, 'Жуань Мянь');
    assert.deepEqual(dict[0].chapters, [0]);
  } finally { restore(); }
});

test('PoeTranslator.buildBilingualDictionary: pairs are deduped across chapters; chapters[] aggregates', async () => {
  const { impl, calls } = bilingualDictFetchMock({
    extractResponses: [
      '[{"original":"Ruan Mian","reference":"阮眠"}]',
      '[{"original":"Ruan Mian","reference":"阮眠"},{"original":"Pingjiang","reference":"平江"}]',
    ],
    translateResponse: '[{"term":"Ruan Mian","originalForm":"阮眠","translation":"Жуань Мянь","notes":""},{"term":"Pingjiang","originalForm":"平江","translation":"Пинцзян","notes":""}]',
  });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = await t.buildBilingualDictionary([
      { title: 'Ch 1', paragraphs: [{ original: 'Ruan Mian arrived.' }], referenceText: '阮眠到了。' },
      { title: 'Ch 2', paragraphs: [{ original: 'Ruan Mian in Pingjiang.' }], referenceText: '阮眠在平江。' },
    ]);
    // Translate call must list each pair only once (deduped).
    assert.equal((calls.translate[0].match(/Ruan Mian/g) || []).length, 1, 'merged list must dedupe');
    assert.equal(dict.length, 2);
    const byTerm = Object.fromEntries(dict.map(e => [e.term, e]));
    assert.deepEqual(byTerm['Ruan Mian'].chapters, [0, 1]);
    assert.deepEqual(byTerm['Pingjiang'].chapters, [1]);
  } finally { restore(); }
});

test('PoeTranslator.buildBilingualDictionary: extract prompt mentions BOTH languages and asks for pair output', async () => {
  let extractSystem;
  const restore = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Pairs:') || user.startsWith('Terms:')) {
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    extractSystem = body.messages.find(m => m.role === 'system')?.content;
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x',
      originalLanguage: 'English', referenceLanguage: 'Chinese',
    });
    await t.buildBilingualDictionary([{ title: 'c', paragraphs: [{ original: 'x' }], referenceText: '中' }]);
    assert.match(extractSystem, /English/);
    assert.match(extractSystem, /Chinese/);
    // Output schema mentions both keys.
    assert.match(extractSystem, /original.*reference|both.*forms/i);
  } finally { restore(); }
});

test('PoeTranslator.buildBilingualDictionary: no pairs extracted → no translate call, empty dict', async () => {
  const { impl, calls } = bilingualDictFetchMock({ extractResponses: ['[]'] });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = await t.buildBilingualDictionary([{
      title: 'c', paragraphs: [{ original: 'x' }], referenceText: '中',
    }]);
    assert.equal(dict.length, 0);
    assert.equal(calls.translate.length, 0);
  } finally { restore(); }
});

test('PoeTranslator.buildBilingualDictionary: dictionaryGuidance is forwarded to both phases', async () => {
  const sys = { extract: null, translate: null };
  const restore = withFetch(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:')) {
      sys.translate = body.messages.find(m => m.role === 'system')?.content;
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    sys.extract = body.messages.find(m => m.role === 'system')?.content;
    return mockResponse({ body: { choices: [{ message: { content: '[{"original":"X","reference":"Y"}]' } }] } });
  });
  try {
    const t = new PoeTranslator({
      apiKey: 'k', model: 'M', baseUrl: 'http://x',
      dictionaryGuidance: 'Use Palladius for transliteration.',
    });
    await t.buildBilingualDictionary([{
      title: 'c', paragraphs: [{ original: 'x' }], referenceText: '中',
    }]);
    assert.match(sys.extract, /Palladius/);
    assert.match(sys.translate, /Palladius/);
  } finally { restore(); }
});

test('PoeTranslator.translateParagraph: WITHOUT context.referenceText — no reference message in prompt', async () => {
  let sentBody;
  const restore = withFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '.' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.translateParagraph({ original: 'Foo.' }, 'default', []);
    for (const m of sentBody.messages) {
      if (m.role === 'user') assert.doesNotMatch(m.content, /source of truth|REFERENCE \(/);
    }
  } finally { restore(); }
});

test('PoeTranslator.translateChapter: includes dictionary and prior accepted chapters in the prompt', async () => {
  let sentBody;
  const restore = withFetch(async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mockResponse({ body: { choices: [{ message: { content: '[1] x' } }] } });
  });
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    const dict = [{ term: 'W', translation: 'В', notes: 'protagonist' }];
    const prior = [{
      title: 'Chapter 1',
      paragraphs: [{ original: 'Hello.', translation: 'Привет.' }],
    }];
    await t.translateChapter(
      { title: 'Chapter 2', paragraphs: [{ original: 'Foo' }] },
      dict, prior
    );
    const all = sentBody.messages.map(m => m.content).join('\n');
    assert.match(all, /W → В/);
    assert.match(all, /protagonist/);
    assert.match(all, /Chapter 1/);
    assert.match(all, /Привет/);
    assert.match(all, /\[1\] Foo/);
  } finally { restore(); }
});
