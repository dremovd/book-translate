import './_setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, mockResponse, clearStore } from './_setup.js';
import { makeBilingualComponent, parseQueryOverrides, PALLADIUS_PROMPT } from '../js/bilingual-component.js';

const RAW_EN = `# Chapter One

Ruan Mian arrived.

She paused.

# Chapter Two

The night fell.`;

const RAW_ZH = `# 第01章

阮眠到了。

她停了一下。

# 第02章

夜晚降临了。`;

test('currentChapterStats: counts words and non-space chars across title + paragraph translations', () => {
  const c = makeBilingualComponent();
  c.book = {
    chapters: [{
      translatedTitle: 'Заголовок',
      paragraphs: [
        { translation: 'два слова' },
        { translation: 'строка\nещё строка' },
      ],
    }],
  };
  c.currentChapterIndex = 0;
  // 'Заголовок' (1 / 9) + 'два слова' (2 / 8) + 'строка ещё строка' (3 / 15).
  assert.deepEqual(c.currentChapterStats, { words: 6, chars: 32 });
});

// ---------- import / export state ----------

test('canExport: false on a fresh component, true once anything is filled in', () => {
  const c = makeBilingualComponent();
  assert.equal(c.canExport, false);
  c.rawEditor = 'abc';
  assert.equal(c.canExport, true);
});

test('serializeState: stamps type/version, blanks apiKey, includes both raw inputs', () => {
  const c = makeBilingualComponent();
  c.rawEditor = 'editor side';
  c.rawReference = 'ref side';
  c.config.apiKey = 'SECRET';
  const env = c.serializeState();
  assert.equal(env.type, 'bilingual-translate-state');
  assert.equal(env.version, 1);
  assert.equal(env.state.rawEditor, 'editor side');
  assert.equal(env.state.rawReference, 'ref side');
  assert.equal(env.state.config.apiKey, '', 'apiKey must be blanked in the export envelope');
});

test('importFromText: round-trips state and preserves the receiver\'s local apiKey', async () => {
  const sender = makeBilingualComponent();
  sender._loaded = true;
  sender.rawEditor = 'src text';
  sender.rawReference = 'ref text';
  sender.editorHeadingLevel = 2;
  sender.referenceHeadingLevel = 3;
  sender.glossary = [{ term: 'X', originalForm: 'X', translation: 'Х', notes: '', chapters: [0] }];
  sender.config.apiKey = 'sender-key';
  const json = JSON.stringify(sender.serializeState());

  const receiver = makeBilingualComponent();
  receiver._loaded = true;
  receiver.config.apiKey = 'receiver-key';
  await receiver.importFromText(json);

  assert.equal(receiver.rawEditor, 'src text');
  assert.equal(receiver.rawReference, 'ref text');
  assert.equal(receiver.editorHeadingLevel, 2);
  assert.equal(receiver.referenceHeadingLevel, 3);
  assert.equal(receiver.glossary.length, 1);
  assert.equal(receiver.glossary[0].translation, 'Х');
  assert.equal(receiver.config.apiKey, 'receiver-key',
    'receiver must keep its own apiKey, not adopt the (blanked) one from the envelope');
});

test('retranslateParagraphWithModel2: no-op when config.model2 is empty', async () => {
  const c = makeBilingualComponent();
  c._loaded = true;
  c.book = { chapters: [{
    title: 'Chapter One', translatedTitle: 'Глава 1',
    paragraphs: [{ original: 'A', translation: 'edited', status: 'translated' }],
    referenceText: '阮眠',
    status: 'translated',
  }]};
  c.currentChapterIndex = 0;
  await c.retranslateParagraphWithModel2(0);
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'edited');
});

test('retranslateParagraphWithModel2: swaps in config.model2 for the per-paragraph translate request', async () => {
  clearStore();
  const c = makeBilingualComponent();
  c._loaded = true;
  c.config.apiKey = 'k';
  c.config.baseUrl = 'http://x';
  c.config.model = 'Primary-Model';
  c.config.model2 = 'Secondary-Model';
  c.book = { chapters: [{
    title: 'Chapter One', translatedTitle: 'Глава 1',
    paragraphs: [{ original: 'A', translation: 'old', status: 'translated' }],
    referenceText: '阮眠',
    status: 'translated',
  }]};
  c.currentChapterIndex = 0;

  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: 'переведено' } }] } });
  });
  try {
    await c.retranslateParagraphWithModel2(0);
    assert.equal(usedModel, 'Secondary-Model');
    assert.equal(c.config.model, 'Primary-Model', 'persisted config.model must not mutate');
  } finally { restore(); }
});

test('importFromText: rejects an export from the single-source editor', async () => {
  const c = makeBilingualComponent();
  c._loaded = true;
  // Mismatched type — the single-source editor uses 'book-translate-state'.
  await c.importFromText(JSON.stringify({
    type: 'book-translate-state', version: 1, state: { rawBook: 'x' },
  }));
  assert.match(c.error || '', /bilingual-translate-state|wrong.*type|not a bilingual/i);
});

test('_pairBooks: pairs chapters by index, packs referenceText as a single blob', () => {
  const c = makeBilingualComponent();
  const en = { chapters: [
    { title: 'Chapter One', paragraphs: [{ original: 'A1' }, { original: 'A2' }] },
    { title: 'Chapter Two', paragraphs: [{ original: 'B1' }] },
  ]};
  const zh = { chapters: [
    { title: '第01章', paragraphs: [{ original: '一' }, { original: '二' }] },
    { title: '第02章', paragraphs: [{ original: '三' }] },
  ]};
  const paired = c._pairBooks(en, zh);
  assert.equal(paired.chapters.length, 2);
  // English drives the editable paragraphs.
  assert.equal(paired.chapters[0].title, 'Chapter One');
  assert.equal(paired.chapters[0].paragraphs.length, 2);
  // Chinese chapter blob is single-string under referenceText, with title prefix.
  assert.match(paired.chapters[0].referenceText, /^# 第01章/);
  assert.match(paired.chapters[0].referenceText, /一/);
  assert.match(paired.chapters[0].referenceText, /二/);
  assert.equal(paired.chapters[0].status, 'pending');
});

test('_pairBooks: trims to the shorter side when chapter counts differ', () => {
  const c = makeBilingualComponent();
  const long  = { chapters: [
    { title: 'A', paragraphs: [{ original: 'a' }] },
    { title: 'B', paragraphs: [{ original: 'b' }] },
    { title: 'C', paragraphs: [{ original: 'c' }] },
  ]};
  const short = { chapters: [
    { title: 'X', paragraphs: [{ original: 'x' }] },
    { title: 'Y', paragraphs: [{ original: 'y' }] },
  ]};
  assert.equal(c._pairBooks(long, short).chapters.length, 2);
  assert.equal(c._pairBooks(short, long).chapters.length, 2);
});

test('startFromRaw: parses both sides, builds glossary, transitions to glossary view', async () => {
  clearStore();
  // Mock the bilingual glossary flow: extract → translate-pairs.
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:')) {
      return mockResponse({ body: { choices: [{ message: { content: '[{"term":"Ruan Mian","originalForm":"阮眠","translation":"Жуань Мянь","notes":""}]' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[{"original":"Ruan Mian","reference":"阮眠"}]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k';
    c.config.model = 'M';
    c.config.baseUrl = 'http://x';
    c.rawEditor    = RAW_EN;
    c.rawReference = RAW_ZH;
    await c.startFromRaw();
    assert.equal(c.error, null);
    assert.equal(c.view, 'glossary');
    assert.equal(c.book.chapters.length, 2);
    assert.equal(c.book.chapters[0].title, 'Chapter One');
    assert.match(c.book.chapters[0].referenceText, /阮眠/);
    assert.equal(c.glossary.length, 1);
    assert.equal(c.glossary[0].originalForm, '阮眠');
  } finally { restore(); }
});

test('startFromRaw: editor side drives paragraphs; reference side becomes referenceText', async () => {
  clearStore();
  const restore = withFetch(async (_url, opts) => {
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    // Swap roles by pasting Chinese as editor and English as reference.
    c.rawEditor    = RAW_ZH;
    c.rawReference = RAW_EN;
    await c.startFromRaw();
    assert.equal(c.book.chapters[0].title, '第01章');
    assert.match(c.book.chapters[0].referenceText, /Chapter One/);
  } finally { restore(); }
});

test('chapter translate passes referenceText through to the model', async () => {
  clearStore();
  let capturedMessages = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:')) {
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    if (userMsg.includes('REFERENCE') || userMsg.includes('[1]')) {
      capturedMessages = body.messages;
      return mockResponse({ body: { choices: [{ message: { content: '[0] Глава 1\n\n[1] Жуань Мянь пришла.\n\n[2] Она остановилась.' } }] } });
    }
    // extract phase
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor = RAW_EN; c.rawReference = RAW_ZH;
    await c.startFromRaw();
    await c.acceptGlossary(); // triggers translate of chapter 0
    assert.equal(c.book.chapters[0].status, 'translated');
    assert.equal(c.book.chapters[0].translatedTitle, 'Глава 1');
    assert.equal(c.book.chapters[0].paragraphs[0].translation, 'Жуань Мянь пришла.');
    // The reference blob was sent.
    const refMsg = capturedMessages.find(m =>
      m.role === 'user' && /REFERENCE|source of truth/i.test(m.content)
    );
    assert.ok(refMsg, 'translateChapter must include the reference user message');
    assert.match(refMsg.content, /阮眠到了/);
  } finally { restore(); }
});

test('retranslateParagraph passes referenceText via context', async () => {
  clearStore();
  let translateParagraphMessages = null;
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsgs = body.messages.filter(m => m.role === 'user').map(m => m.content);
    const sys = body.messages.find(m => m.role === 'system')?.content ?? '';
    if (userMsgs.some(c => c.startsWith('Pairs:'))) {
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    if (userMsgs.some(c => c.startsWith('Paragraph to translate:'))) {
      translateParagraphMessages = body.messages;
      return mockResponse({ body: { choices: [{ message: { content: 'новый перевод' } }] } });
    }
    if (/Translate the chapter title/.test(userMsgs.join('\n')) || /\[0\] is the chapter title/.test(sys)) {
      return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x\n\n[2] y' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor = RAW_EN; c.rawReference = RAW_ZH;
    await c.startFromRaw();
    await c.acceptGlossary();
    await c.retranslateParagraph(0, 'natural');
    assert.equal(c.book.chapters[0].paragraphs[0].translation, 'новый перевод');
    const refMsg = translateParagraphMessages.find(m =>
      m.role === 'user' && /REFERENCE|source of truth/i.test(m.content)
    );
    assert.ok(refMsg, 'translateParagraph must include the reference user message');
    assert.match(refMsg.content, /阮眠到了/);
  } finally { restore(); }
});

// ---------- query-param onboarding ----------

test('parseQueryOverrides: pulls config keys and per-side heading levels off the query', () => {
  const out = parseQueryOverrides('?model=gpt-5.5&glossaryModel=claude-opus-4.7&apiKey=sk-x&editorHeadingLevel=2&referenceHeadingLevel=2');
  assert.equal(out.anyApplied, true);
  assert.equal(out.configPatch.model, 'gpt-5.5');
  assert.equal(out.configPatch.glossaryModel, 'claude-opus-4.7');
  assert.equal(out.configPatch.apiKey, 'sk-x');
  assert.equal(out.stateOverrides.editorHeadingLevel, 2);
  assert.equal(out.stateOverrides.referenceHeadingLevel, 2);
});

test('parseQueryOverrides: ignores unknown keys', () => {
  const out = parseQueryOverrides('?unknownKey=garbage');
  assert.equal(out.anyApplied, false);
});

test('parseQueryOverrides: glossaryGuidance comes through URL-decoded', () => {
  const text = 'Use Палладий for Chinese names.';
  const qs = '?glossaryGuidance=' + encodeURIComponent(text);
  const out = parseQueryOverrides(qs);
  assert.equal(out.configPatch.glossaryGuidance, text);
});

test('parseQueryOverrides: legacy ?dictionary* params still apply to the new glossary* keys', () => {
  const out = parseQueryOverrides(
    '?dictionaryModel=cheap&dictionaryGuidance=hello&dictionaryChunkChars=4242'
  );
  assert.equal(out.configPatch.glossaryModel,      'cheap');
  assert.equal(out.configPatch.glossaryGuidance,   'hello');
  assert.equal(out.configPatch.glossaryChunkChars, 4242);
});

test('_applyQueryParamOverrides: applies query patch and persists', async () => {
  clearStore();
  const c = makeBilingualComponent();
  c._loaded = true;
  const applied = c._applyQueryParamOverrides('?model=gpt-5.5&apiKey=sk-x&editorHeadingLevel=2');
  assert.equal(applied, true);
  assert.equal(c.config.model, 'gpt-5.5');
  assert.equal(c.config.apiKey, 'sk-x');
  assert.equal(c.editorHeadingLevel, 2);
});

// ---------- Palladius preset ----------

test('insertPalladiusPrompt: empty → preset alone; non-empty → appended; idempotent', () => {
  // Empty guidance: insertion sets exactly the preset.
  const c1 = makeBilingualComponent();
  c1.config.glossaryGuidance = '';
  c1.insertPalladiusPrompt();
  assert.equal(c1.config.glossaryGuidance, PALLADIUS_PROMPT);

  // Existing guidance: preset is appended; existing rule preserved.
  const c2 = makeBilingualComponent();
  c2.config.glossaryGuidance = 'Existing rule.';
  c2.insertPalladiusPrompt();
  assert.match(c2.config.glossaryGuidance, /Existing rule\./);
  assert.match(c2.config.glossaryGuidance, /Палладий/);
  // Calling again is a no-op (already present).
  const before = c2.config.glossaryGuidance;
  c2.insertPalladiusPrompt();
  assert.equal(c2.config.glossaryGuidance, before);
});

// ---------- chapter count getters ----------

test('editorChapterCount / referenceChapterCount: live count of `#` headings per side', () => {
  const c = makeBilingualComponent();
  c.rawEditor    = RAW_EN;
  c.rawReference = RAW_ZH;
  assert.equal(c.editorChapterCount, 2);
  assert.equal(c.referenceChapterCount, 2);
  assert.equal(c.chapterCountMismatch, false);
});

test('chapterCountMismatch: true when sides have different parsed chapter counts', () => {
  const c = makeBilingualComponent();
  c.rawEditor    = '# A\n\nx\n\n# B\n\ny';
  c.rawReference = '# A\n\nx\n\n# B\n\ny\n\n# C\n\nz';
  assert.equal(c.editorChapterCount, 2);
  assert.equal(c.referenceChapterCount, 3);
  assert.equal(c.chapterCountMismatch, true);
});

test('chapterCountMismatch: false when one side is still empty', () => {
  const c = makeBilingualComponent();
  c.rawEditor = RAW_EN;
  // rawReference left empty — not yet a "mismatch", just incomplete setup
  assert.equal(c.chapterCountMismatch, false);
});

// ---------- loadFileIntoSide ----------

function fakeFile(name, text) {
  return {
    name,
    async text() { return text; },
  };
}

test('loadFileIntoSide: <input type=file> change fills the editor textarea', async () => {
  const c = makeBilingualComponent();
  await c.loadFileIntoSide('editor', { target: { files: [fakeFile('en.md', '# Chapter\n\nbody')] } });
  assert.match(c.rawEditor, /^# Chapter/);
});

test('loadFileIntoSide: drag-and-drop fills the reference textarea and prevents default', async () => {
  const c = makeBilingualComponent();
  let prevented = false;
  await c.loadFileIntoSide('reference', {
    dataTransfer: { files: [fakeFile('zh.md', '# 第一章\n\n中文')] },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.match(c.rawReference, /^# 第一章/);
});

test('loadFileIntoSide: ignores empty file lists silently', async () => {
  const c = makeBilingualComponent();
  c.rawEditor = 'preserve me';
  await c.loadFileIntoSide('editor', { target: { files: [] } });
  assert.equal(c.rawEditor, 'preserve me');
});

test('loadFileIntoSide: drop event MUST NOT mutate the textarea value (regression)', async () => {
  // Drop event's target is the textarea, which has a .value property.
  // The "reset on completion" branch must skip non-file-input targets,
  // otherwise loading the file also clears the textarea afterward.
  const c = makeBilingualComponent();
  // A "textarea-shaped" target: tagName=TEXTAREA, has writable value.
  const textareaTarget = { tagName: 'TEXTAREA', value: 'should-stay' };
  await c.loadFileIntoSide('reference', {
    type: 'drop',
    target: textareaTarget,
    dataTransfer: { files: [fakeFile('zh.md', '# 第一章\n\n中文')] },
    preventDefault() {},
  });
  assert.match(c.rawReference, /^# 第一章/);
  assert.equal(textareaTarget.value, 'should-stay', 'drop must not clear textarea');
});

test('loadFileIntoSide: <input type=file> change event still gets its value cleared', async () => {
  // The reset is intentional for file inputs — without it, re-selecting
  // the same file does NOT fire `change` again. Keep that behavior.
  const c = makeBilingualComponent();
  const fileInputTarget = { tagName: 'INPUT', type: 'file', files: [fakeFile('en.md', '# Ch')], value: 'some/path' };
  await c.loadFileIntoSide('editor', { type: 'change', target: fileInputTarget });
  assert.equal(fileInputTarget.value, '', 'file input value must be reset after read');
});

test('startFromRaw: clears glossaryProgress and surfaces error when translate-pairs phase fails (regression)', async () => {
  // Extract returns a pair so the translate phase actually runs.
  // Translate-pairs returns malformed JSON, which makes parseJsonArray throw.
  // The component must clear glossaryProgress (so the UI doesn't stay
  // stuck at "Translating … 0/1") and set this.error.
  clearStore();
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:')) {
      // Truncated / non-array response → parseJsonArray throws.
      return mockResponse({ body: { choices: [{ message: { content: 'Sorry, model overloaded' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[{"original":"X","reference":"Y"}]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor = RAW_EN; c.rawReference = RAW_ZH;
    await c.startFromRaw();
    assert.equal(c.glossaryProgress, null, 'progress must be cleared even on failure');
    assert.ok(c.error, 'error must be set so the user knows the run failed');
    assert.notEqual(c.view, 'glossary', 'view must NOT advance to glossary on failure');
  } finally { restore(); }
});

test('persistNow: lights up the saveIndicator after a successful save', async () => {
  clearStore();
  const c = makeBilingualComponent();
  c._loaded = true;
  c.rawEditor = 'hello';
  assert.equal(c.saveIndicator, false);
  await c.persistNow();
  assert.equal(c.saveIndicator, true);
});

test('persistNow: leaves saveIndicator off when the underlying store throws', async () => {
  clearStore();
  const c = makeBilingualComponent();
  c._loaded = true;
  const orig = globalThis.localforage.setItem;
  globalThis.localforage.setItem = async () => { throw new Error('disk full'); };
  try {
    await c.persistNow();
    assert.equal(c.saveIndicator, false);
  } finally {
    globalThis.localforage.setItem = orig;
  }
});

test('uses its own store key (does not collide with the single-source editor)', async () => {
  // Save state with the bilingual component.
  clearStore();
  const c1 = makeBilingualComponent();
  c1._loaded = true;
  c1.rawEditor = 'hello';
  c1.config.apiKey = 'bilingual-key';
  await c1.persistNow();
  // The single-source store key must not have been written.
  const editorKey = await globalThis.localforage.getItem('book-translate-state:v1');
  const bilingualKey = await globalThis.localforage.getItem('book-translate-bilingual:v1');
  assert.equal(editorKey, null, 'single-source editor store must remain untouched');
  assert.ok(bilingualKey, 'bilingual store key must be populated');
  assert.equal(bilingualKey.config.apiKey, 'bilingual-key');
});

// ---------- chapter gate, navigation, view transitions, stats ----------
//
// The bilingual editor mirrors a lot of the singular editor's logic.
// Where the behavior is the same, the tests below are direct mirrors of
// the singular tests in component.test.js — same shape, just driven
// against makeBilingualComponent. The gates (chapter, view, visibility)
// are the kind of invariant where divergence between the two editors
// would be a real bug.

const RAW_EN_3 = `# Ch1\n\nbody1\n\n# Ch2\n\nbody2\n\n# Ch3\n\nbody3`;
const RAW_ZH_3 = `# 第1\n\n中1\n\n# 第2\n\n中2\n\n# 第3\n\n中3`;

// Set up a bilingual component up to the editor view with chapter 0
// translated. Caller is responsible for calling restore() on the
// returned object to release the fetch mock. Glossary phases return
// empty arrays (no terms extracted), and chapter translate echoes a
// trivial [0]/[1] response so paragraphs survive index alignment.
async function bilingualInEditor() {
  clearStore();
  const restore = withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (userMsg.startsWith('Pairs:')) {
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    if (/Translate the chapter title/.test(userMsg) || /REFERENCE/.test(userMsg)) {
      return mockResponse({ body: { choices: [{ message: { content: '[0] T\n\n[1] x' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  const c = makeBilingualComponent();
  c._loaded = true;
  c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
  c.rawEditor = RAW_EN_3;
  c.rawReference = RAW_ZH_3;
  await c.startFromRaw();
  await c.acceptGlossary();
  return { c, restore };
}

function withFakeNow(ms, fn) {
  const orig = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = orig; }
}

// ---------- chapter gate ----------

test('acceptAndNext: does NOT re-translate an already-translated next chapter', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // First accept-and-next: ch1 was pending, now translated.
    await c.acceptAndNext();
    assert.equal(c.currentChapterIndex, 1);
    assert.equal(c.book.chapters[0].status, 'accepted');
    assert.equal(c.book.chapters[1].status, 'translated');

    // User edits ch1, navigates back to ch0.
    c.book.chapters[1].paragraphs[0].translation = 'my edit';
    c.selectChapter(0);
    assert.equal(c.currentChapterIndex, 0);

    // Accept ch0 again: ch1 must NOT be regenerated (its edit must survive).
    await c.acceptAndNext();
    assert.equal(c.book.chapters[1].paragraphs[0].translation, 'my edit',
      'already-translated next chapter must not be clobbered');
  } finally { restore(); }
});

test('selectChapter: refuses pending, allows translated', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // ch1 is still pending after acceptGlossary alone.
    c.selectChapter(1);
    assert.equal(c.currentChapterIndex, 0, 'pending chapter must be refused');
    c.selectChapter(2);
    assert.equal(c.currentChapterIndex, 0);

    // Translate ch1 via accept-and-next, then revisit ch0.
    await c.acceptAndNext();
    assert.equal(c.currentChapterIndex, 1);
    c.selectChapter(0);
    assert.equal(c.currentChapterIndex, 0, 'translated chapter must be reachable');
  } finally { restore(); }
});

// ---------- view transitions ----------

test('gotoSetup / gotoGlossary / gotoStats: simple view transitions', async () => {
  const c = makeBilingualComponent();
  c._loaded = true;
  c.view = 'editor';
  c.gotoSetup();
  assert.equal(c.view, 'setup');

  // gotoGlossary is a no-op when there are no glossary entries (defensive).
  c.gotoGlossary();
  assert.equal(c.view, 'setup');
  c.glossary.push({ term: 'X', originalForm: 'X', translation: 'Х', notes: '', chapters: [] });
  c.gotoGlossary();
  assert.equal(c.view, 'glossary');

  c.gotoStats();
  assert.equal(c.view, 'stats');
});

// ---------- reset ----------

test('reset: wipes book, glossary, raws, stats; returns to setup', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // Plant some stats so we can verify they get cleared too.
    withFakeNow(1_700_000_000_000, () => c._recordWork());
    c._recordApiCall('chapter-translate', 999);
    assert.ok(Object.keys(c.stats.byChapter).length > 0);

    c._confirm = () => true;
    c.reset();
    assert.equal(c.view, 'setup');
    assert.equal(c.book, null);
    assert.deepEqual(c.glossary, []);
    assert.equal(c.rawEditor, '');
    assert.equal(c.rawReference, '');
    assert.deepEqual(c.stats.calls, {});
    assert.deepEqual(c.stats.byChapter, {});
  } finally { restore(); }
});

test('reset: respects a cancelling _confirm', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    c._confirm = () => false;
    c.reset();
    assert.equal(c.view, 'editor', 'cancellation must keep current view');
    assert.ok(c.book, 'book must survive a cancelled reset');
  } finally { restore(); }
});

// ---------- stats: work tracking ----------

test('stats: default-empty stats present after init', () => {
  const c = makeBilingualComponent();
  assert.ok(c.stats);
  assert.deepEqual(c.stats.calls, {});
  assert.deepEqual(c.stats.byChapter, {});
});

test('_recordWork: bumps minute counter for current chapter, sets first/lastWorkAt', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    withFakeNow(1_700_000_000_000, () => c._recordWork());
    const ch = c.stats.byChapter[0];
    assert.equal(ch.minutes, 1);
    assert.equal(ch.firstWorkAt, ch.lastWorkAt);
  } finally { restore(); }
});

test('_recordWork: same minute → no double-count; new minute → +1', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    const t = 1_700_000_000_000;
    withFakeNow(t,         () => c._recordWork());
    withFakeNow(t + 30000, () => c._recordWork()); // same minute
    withFakeNow(t + 60000, () => c._recordWork()); // next minute
    assert.equal(c.stats.byChapter[0].minutes, 2);
  } finally { restore(); }
});

test('_recordWork: gated to view==="editor" (setup view does NOT count)', () => {
  const c = makeBilingualComponent();
  c._loaded = true;
  // view is 'setup' by default; recordWork must be a no-op.
  c._recordWork();
  assert.equal(Object.keys(c.stats.byChapter).length, 0);
});

test('_recordWork: hidden tab does NOT count work', async () => {
  const { c, restore } = await bilingualInEditor();
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { visibilityState: 'hidden' },
  });
  try {
    c._recordWork();
    assert.equal(Object.keys(c.stats.byChapter).length, 0);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
    restore();
  }
});

// ---------- stats: API call counter ----------

test('_recordApiCall: tracks count + accumulated duration; missing duration → 0ms', () => {
  const c = makeBilingualComponent();
  c._recordApiCall('chapter-translate', 500);
  c._recordApiCall('chapter-translate', 1500);
  c._recordApiCall('paragraph-translate'); // no duration
  assert.equal(c.stats.calls['chapter-translate'].count, 2);
  assert.equal(c.stats.calls['chapter-translate'].totalMs, 2000);
  assert.equal(c.stats.calls['paragraph-translate'].count, 1);
  assert.equal(c.stats.calls['paragraph-translate'].totalMs, 0);
});

test('apiCallRows: avgMs = totalMs / count; null for legacy (totalMs=0)', () => {
  const c = makeBilingualComponent();
  c._recordApiCall('chapter-translate', 1000);
  c._recordApiCall('chapter-translate', 3000);
  c._recordApiCall('glossary-extract'); // no duration → totalMs=0 → avgMs=null
  const rows = Object.fromEntries(c.apiCallRows.map(r => [r.kind, r]));
  assert.equal(rows['chapter-translate'].avgMs, 2000);
  assert.equal(rows['glossary-extract'].avgMs, null);
});

test('_recordApiCall: cache hits do NOT bump the counter (translator-side gate)', async () => {
  // Real wiring test: build glossary twice with identical input. First
  // call lands on the network; second is served from the SHA-256-keyed
  // localforage cache. The hook must only fire once per kind.
  clearStore();
  let networkHits = 0;
  const restore = withFetch(async (_url, opts) => {
    networkHits++;
    const body = JSON.parse(opts.body);
    const user = body.messages.find(m => m.role === 'user')?.content ?? '';
    if (user.startsWith('Pairs:')) {
      return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
    }
    return mockResponse({ body: { choices: [{ message: { content: '[]' } }] } });
  });
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor = RAW_EN_3; c.rawReference = RAW_ZH_3;
    await c.startFromRaw();
    const networkAfterFirst = networkHits;
    const callsAfterFirst = c.stats.calls['bilingual-extract']?.count || 0;
    assert.ok(callsAfterFirst > 0, 'first run must record extract calls');

    // Second run with identical input: served from cache.
    c.view = 'setup'; c.book = null;
    await c.startFromRaw();
    assert.equal(networkHits, networkAfterFirst,
      'second run must hit the cache, not the network');
    assert.equal(c.stats.calls['bilingual-extract']?.count, callsAfterFirst,
      'cache hits must not increment the API call counter');
  } finally { restore(); }
});

// ---------- stats: derived getters ----------

test('charsPerHourTotal: null when no minutes worked', () => {
  const c = makeBilingualComponent();
  assert.equal(c.charsPerHourTotal, null);
});

test('charsPerHourTotal: based on ACCEPTED chapters only — in-progress chapter excluded', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // ch0 is currently 'translated' (acceptGlossary done). Edit + record work.
    c.book.chapters[0].paragraphs[0].translation = 'abcdefghij'; // 10 chars
    withFakeNow(1_700_000_000_000, () => c._recordWork());
    withFakeNow(1_700_000_120_000, () => c._recordWork()); // +2 min total
    assert.equal(c.charsPerHourTotal, null,
      'in-progress chapter must not contribute to the rate');
    // Now accept it. The mock chapter-translate returned title='T' (1
    // char) and body='x'; we then overwrote body to 10 chars. So
    // chapterTranslationStats yields 1 + 10 = 11 chars.
    // 11 chars / 2 minutes × 60 = 330 chars/h.
    await c.acceptAndNext();
    assert.equal(c.charsPerHourTotal, 330);
  } finally { restore(); }
});

test('chapterStatsRows: only includes chapters with at least one recorded minute', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    await c.acceptAndNext(); // translate ch1 too
    withFakeNow(1_700_000_000_000, () => { c.currentChapterIndex = 0; c._recordWork(); });
    const rows = c.chapterStatsRows;
    assert.equal(rows.length, 1, 'untouched chapters must NOT appear');
    assert.equal(rows[0].index, 0);
  } finally { restore(); }
});

test('hasAnyStats: false on a fresh component, true once anything is recorded', async () => {
  const c = makeBilingualComponent();
  assert.equal(c.hasAnyStats, false);
  c._recordApiCall('chapter-translate', 100);
  assert.equal(c.hasAnyStats, true);
});

// ---------- exports (so far + glossary download) ----------

test('canExportSoFar / exportSoFar: requires at least one accepted chapter', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // Just translated, nothing accepted yet.
    assert.equal(c.canExportSoFar, false);
    await c.acceptAndNext();
    assert.equal(c.canExportSoFar, true);

    let captured = null;
    c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
    c.exportSoFar();
    assert.ok(captured, 'exportSoFar must invoke the downloader');
    assert.match(captured.md, /Ch1|T/);
  } finally { restore(); }
});

test('exportGlossary: filename uses projectName slug when set; bare otherwise', () => {
  const c = makeBilingualComponent();
  c.glossary = [{ term: 'X', originalForm: 'X', translation: 'Х', notes: '', chapters: [0] }];
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };

  // Without projectName.
  c.exportGlossary();
  assert.equal(captured.filename, 'glossary.md');

  // With projectName.
  c.config.projectName = 'My Cool Book!';
  captured = null;
  c.exportGlossary();
  assert.equal(captured.filename, 'my-cool-book-glossary.md');
});

test('exportSoFar (bilingual): filename uses projectName slug when set', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    await c.acceptAndNext(); // give us at least one accepted chapter
    c.config.projectName = 'meiyou';
    let captured = null;
    c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
    c.exportSoFar();
    assert.equal(captured.filename, 'meiyou-translation.md');
  } finally { restore(); }
});

test('exportGlossary: renders a 4-column markdown table (Reference / Editor / Target / Notes)', () => {
  const c = makeBilingualComponent();
  c.config.editorLanguage    = 'English';
  c.config.referenceLanguage = 'Chinese';
  c.config.targetLanguage    = 'Russian';
  c.glossary = [
    { term: 'Ruan Mian', originalForm: '阮眠', translation: 'Жуань Мянь', notes: 'protagonist', chapters: [0] },
  ];
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportGlossary();
  assert.equal(captured.filename, 'glossary.md');
  assert.match(captured.md, /\| Chinese \| English \| Russian \| Notes \|/);
  assert.match(captured.md, /\| 阮眠 \| Ruan Mian \| Жуань Мянь \| protagonist \|/);
});

// ---------- error & warning paths in startFromRaw ----------

test('startFromRaw: empty side surfaces an error and stays on setup', async () => {
  const c = makeBilingualComponent();
  c._loaded = true;
  c.rawEditor = '';
  c.rawReference = '# Ch\n\nbody';
  await c.startFromRaw();
  assert.match(c.error || '', /at least one chapter/i);
  assert.equal(c.view, 'setup');
});

test('startFromRaw: chapter-count mismatch warns but proceeds with the shorter side', async () => {
  // Don't actually call the model — return empty pairs / no chapter
  // translate hits. We only care that the warning surfaces and the book
  // is paired to the shorter side.
  clearStore();
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '[]' } }] } }));
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor    = '# A\n\nx\n\n# B\n\ny';                          // 2 chapters
    c.rawReference = '# 1\n\na\n\n# 2\n\nb\n\n# 3\n\nc';              // 3 chapters
    await c.startFromRaw();
    assert.match(c.error || '', /mismatch.*2.*3|3.*2/i);
    assert.equal(c.book.chapters.length, 2, 'pairs to the shorter side');
  } finally { restore(); }
});

// ---------- retranslateCurrent ----------

test('retranslateCurrent: drops prior edits and re-translates fresh', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // User edited the chapter; retranslateCurrent must wipe edits.
    c.book.chapters[0].translatedTitle = 'edited title';
    c.book.chapters[0].paragraphs[0].translation = 'edited body';
    await c.retranslateCurrent();
    // The mock returns '[0] T\n\n[1] x' — fresh translation from source.
    assert.equal(c.book.chapters[0].translatedTitle, 'T');
    assert.equal(c.book.chapters[0].paragraphs[0].translation, 'x');
    assert.equal(c.book.chapters[0].status, 'translated');
  } finally { restore(); }
});

// ---------- _migrateLegacyStats ----------

test('_migrateLegacyStats: numeric calls[kind]=N gets lifted into {count, totalMs}', async () => {
  // Drive via the public path: pre-seed the store, then init() reads it
  // back through loadSaved → _migrateLegacyStats.
  clearStore();
  await globalThis.localforage.setItem('book-translate-bilingual:v1', {
    view: 'setup',
    stats: { calls: { 'chapter-translate': 4 }, byChapter: {} },
  });
  const c = makeBilingualComponent();
  await c.init();
  assert.equal(c.stats.calls['chapter-translate'].count, 4);
  assert.equal(c.stats.calls['chapter-translate'].totalMs, 0);
});

// ---------- derived getters ----------

test('nextButtonLabel: final-chapter, translated-next, and pending-next variants', async () => {
  const { c, restore } = await bilingualInEditor();
  try {
    // Currently on ch0 of 3 (translated; ch1, ch2 pending).
    assert.equal(c.nextButtonLabel, 'Accept & translate next chapter');
    await c.acceptAndNext();   // ch0 accepted, on ch1 (ch2 pending)
    assert.equal(c.nextButtonLabel, 'Accept & translate next chapter');
    await c.acceptAndNext();   // on ch2 (final)
    assert.equal(c.nextButtonLabel, 'Accept (final chapter)');
    // Go back to ch0 — next chapter (ch1) is already accepted.
    c.selectChapter(0);
    assert.equal(c.nextButtonLabel, 'Accept & go to next chapter');
  } finally { restore(); }
});

test('acceptedCount / anyTranslated: derived from chapter statuses', async () => {
  const c = makeBilingualComponent();
  assert.equal(c.acceptedCount, 0);
  assert.equal(c.anyTranslated, false);
  c.book = { chapters: [
    { status: 'pending' }, { status: 'translated' }, { status: 'accepted' },
  ]};
  assert.equal(c.acceptedCount, 1);
  assert.equal(c.anyTranslated, true);
});

test('canStartFromRaw: true only when both sides have content', () => {
  const c = makeBilingualComponent();
  assert.equal(c.canStartFromRaw, false);
  c.rawEditor = 'x';
  assert.equal(c.canStartFromRaw, false, 'one side alone is not enough');
  c.rawReference = 'y';
  assert.equal(c.canStartFromRaw, true);
  // Whitespace-only doesn't count.
  c.rawReference = '   \n  ';
  assert.equal(c.canStartFromRaw, false);
});

test('addTerm/removeTerm: mutate the glossary with originalForm initialized', () => {
  const c = makeBilingualComponent();
  c.addTerm();
  c.addTerm();
  assert.equal(c.glossary.length, 2);
  // Bilingual entries carry an originalForm slot (vs singular which doesn't).
  assert.equal(c.glossary[0].originalForm, '');
  c.glossary[0].term = 'X'; c.glossary[1].term = 'Y';
  c.removeTerm(0);
  assert.equal(c.glossary.length, 1);
  assert.equal(c.glossary[0].term, 'Y');
});

test('formatWorkTime: returns "—" for null, locale-formatted string for ISO timestamps', () => {
  const c = makeBilingualComponent();
  assert.equal(c.formatWorkTime(null), '—');
  assert.equal(c.formatWorkTime(undefined), '—');
  const iso = '2026-05-04T12:00:00Z';
  const out = c.formatWorkTime(iso);
  assert.notEqual(out, '—');
  assert.equal(typeof out, 'string');
  // toLocaleString output varies by locale, but it must NOT be the raw ISO.
  assert.notEqual(out, iso);
});

// ---------- glossaryProgress + onProgress wiring ----------

test('startFromRaw: glossaryProgress starts null, ends null after build', async () => {
  clearStore();
  const restore = withFetch(async () =>
    mockResponse({ body: { choices: [{ message: { content: '[]' } }] } }));
  try {
    const c = makeBilingualComponent();
    c._loaded = true;
    c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
    c.rawEditor = RAW_EN_3; c.rawReference = RAW_ZH_3;
    assert.equal(c.glossaryProgress, null);
    await c.startFromRaw();
    assert.equal(c.glossaryProgress, null, 'progress must be cleared once the build finishes');
  } finally { restore(); }
});
