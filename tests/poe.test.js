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

test('PoeTranslator.buildDictionary: extract prompt explicitly asks for real-world references', async () => {
  const { impl, calls } = dictFetchMock({ extractResponses: ['[]'] });
  const restore = withFetch(impl);
  try {
    const t = new PoeTranslator({ apiKey: 'k', model: 'M', baseUrl: 'http://x' });
    await t.buildDictionary([{ title: 'c', paragraphs: [{ original: 'text' }] }]);
    // Which *system* prompt triggered this extract call — we need to look
    // at the messages, but dictFetchMock collects the user msg. Build our
    // own inspector here.
  } finally { restore(); }

  // Use an inline mock to peek at the system prompt.
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
