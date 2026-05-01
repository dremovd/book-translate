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

test('makeBilingualComponent: defaults to English editor / Chinese reference', () => {
  const c = makeBilingualComponent();
  assert.equal(c.config.editorLanguage,    'English');
  assert.equal(c.config.referenceLanguage, 'Chinese');
});

test('currentChapterStats: zero before a book is loaded', () => {
  const c = makeBilingualComponent();
  assert.deepEqual(c.currentChapterStats, { words: 0, chars: 0 });
});

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
  sender.dictionary = [{ term: 'X', originalForm: 'X', translation: 'Х', notes: '', chapters: [0] }];
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
  assert.equal(receiver.dictionary.length, 1);
  assert.equal(receiver.dictionary[0].translation, 'Х');
  assert.equal(receiver.config.apiKey, 'receiver-key',
    'receiver must keep its own apiKey, not adopt the (blanked) one from the envelope');
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

test('startFromRaw: parses both sides, builds dictionary, transitions to dictionary view', async () => {
  clearStore();
  // Mock the bilingual dict flow: extract → translate-pairs.
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
    assert.equal(c.view, 'dictionary');
    assert.equal(c.book.chapters.length, 2);
    assert.equal(c.book.chapters[0].title, 'Chapter One');
    assert.match(c.book.chapters[0].referenceText, /阮眠/);
    assert.equal(c.dictionary.length, 1);
    assert.equal(c.dictionary[0].originalForm, '阮眠');
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
    await c.acceptDictionary(); // triggers translate of chapter 0
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
    await c.acceptDictionary();
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
  const out = parseQueryOverrides('?model=gpt-5.5&dictionaryModel=claude-opus-4.7&apiKey=sk-x&editorHeadingLevel=2&referenceHeadingLevel=2');
  assert.equal(out.anyApplied, true);
  assert.equal(out.configPatch.model, 'gpt-5.5');
  assert.equal(out.configPatch.dictionaryModel, 'claude-opus-4.7');
  assert.equal(out.configPatch.apiKey, 'sk-x');
  assert.equal(out.stateOverrides.editorHeadingLevel, 2);
  assert.equal(out.stateOverrides.referenceHeadingLevel, 2);
});

test('parseQueryOverrides: ignores unknown keys', () => {
  const out = parseQueryOverrides('?unknownKey=garbage');
  assert.equal(out.anyApplied, false);
});

test('parseQueryOverrides: dictionaryGuidance comes through URL-decoded', () => {
  const text = 'Use Палладий for Chinese names.';
  const qs = '?dictionaryGuidance=' + encodeURIComponent(text);
  const out = parseQueryOverrides(qs);
  assert.equal(out.configPatch.dictionaryGuidance, text);
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

test('insertPalladiusPrompt: appends to existing guidance, idempotent', () => {
  const c = makeBilingualComponent();
  c.config.dictionaryGuidance = 'Existing rule.';
  c.insertPalladiusPrompt();
  assert.match(c.config.dictionaryGuidance, /Existing rule\./);
  assert.match(c.config.dictionaryGuidance, /Палладий/);
  // Calling again is a no-op (already present).
  const before = c.config.dictionaryGuidance;
  c.insertPalladiusPrompt();
  assert.equal(c.config.dictionaryGuidance, before);
});

test('insertPalladiusPrompt: empty guidance — sets to the preset alone', () => {
  const c = makeBilingualComponent();
  c.config.dictionaryGuidance = '';
  c.insertPalladiusPrompt();
  assert.equal(c.config.dictionaryGuidance, PALLADIUS_PROMPT);
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

test('startFromRaw: clears dictionaryProgress and surfaces error when translate-pairs phase fails (regression)', async () => {
  // Extract returns a pair so the translate phase actually runs.
  // Translate-pairs returns malformed JSON, which makes parseJsonArray throw.
  // The component must clear dictionaryProgress (so the UI doesn't stay
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
    assert.equal(c.dictionaryProgress, null, 'progress must be cleared even on failure');
    assert.ok(c.error, 'error must be set so the user knows the run failed');
    assert.notEqual(c.view, 'dictionary', 'view must NOT advance to dictionary on failure');
  } finally { restore(); }
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
