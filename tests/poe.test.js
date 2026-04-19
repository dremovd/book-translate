import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, mockResponse } from './_setup.js';
import { PoeTranslator } from '../js/translators/poe.js';

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

// Helper for the 3-phase dictionary flow: extract calls echo a JSON array of
// strings; translate calls (recognized by "Terms:" at the user message start)
// echo a JSON array of {term, translation, notes}.
function dictFetchMock({ extractResponses = [], translateResponse = '[]' } = {}) {
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
    const content = extractResponses[extractIdx++] ?? extractResponses[extractResponses.length - 1] ?? '[]';
    return mockResponse({ body: { choices: [{ message: { content } }] } });
  };
  return { impl, calls };
}

test('PoeTranslator.buildDictionary: small book → 1 extract call + 1 translate call', async () => {
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
    assert.deepEqual(dict, [
      { term: 'Winston', translation: 'Уинстон', notes: '' },
      { term: 'Julia',   translation: 'Джулия',  notes: '' },
    ]);
    // Translate call message should list every extracted term.
    assert.match(calls.translate[0], /Winston/);
    assert.match(calls.translate[0], /Julia/);
  } finally { restore(); }
});

test('PoeTranslator.buildDictionary: chunk size forces multiple extract calls, one translate call', async () => {
  const { impl, calls } = dictFetchMock({
    extractResponses: ['["A"]', '["B"]', '["A", "C"]'],
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
    assert.ok(calls.extract.length >= 2, `expected multiple extract calls, got ${calls.extract.length}`);
    assert.equal(calls.translate.length, 1);
    // Merged list in the translate call should be deduplicated — A appears in two chunks.
    const body = calls.translate[0];
    assert.equal((body.match(/- A\b/g) ?? []).length, 1, 'merged list must dedupe A');
    assert.equal(dict.length, 3);
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
