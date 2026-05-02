import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearStore, withFetch, mockResponse } from './_setup.js';
import { makeComponent } from '../js/component.js';

const SAMPLE = '# Chapter 1\n\npara A1\n\npara A2\n\n# Chapter 2\n\npara B1\n\n# Chapter 3\n\npara C1';

async function initFresh() {
  clearStore();
  const c = makeComponent();
  await c.init();
  return c;
}

function setDummyBook(c, raw = SAMPLE) {
  c.rawBook = raw;
  c.config.translator = 'dummy';
}

// ---------- full happy path ----------

test('dummy flow: setup → dictionary → editor → accept-next → final accept', async () => {
  const c = await initFresh();
  setDummyBook(c);

  await c.startFromRaw();
  assert.equal(c.view, 'dictionary');
  assert.equal(c.book.chapters.length, 3);
  assert.equal(c.book.chapters[0].status, 'pending');

  await c.acceptDictionary();
  assert.equal(c.view, 'editor');
  assert.equal(c.currentChapterIndex, 0);
  assert.equal(c.book.chapters[0].status, 'translated');
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'para A1');
  assert.equal(c.book.chapters[1].status, 'pending', 'chapter 2 must NOT be translated yet');

  c.book.chapters[0].paragraphs[0].translation = 'перевод A1';

  await c.acceptAndNext();
  assert.equal(c.currentChapterIndex, 1);
  assert.equal(c.book.chapters[0].status, 'accepted');
  assert.equal(c.book.chapters[1].status, 'translated');
  assert.equal(c.book.chapters[2].status, 'pending');

  await c.acceptAndNext();
  assert.equal(c.currentChapterIndex, 2);
  assert.equal(c.book.chapters[1].status, 'accepted');
  assert.equal(c.book.chapters[2].status, 'translated');

  // Final chapter.
  await c.acceptAndNext();
  assert.equal(c.book.chapters[2].status, 'accepted');
  assert.equal(c.acceptedCount, 3);
});

// ---------- translation stats footer ----------

test('currentChapterStats: zero when no book is loaded', async () => {
  const c = await initFresh();
  assert.deepEqual(c.currentChapterStats, { words: 0, chars: 0 });
});

test('currentChapterStats: counts words and non-space chars across title + translated paragraphs', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  // Dummy copies original to translation, so ch1 has translatedTitle='Chapter 1'
  // and paragraphs[0].translation='para A1', paragraphs[1].translation='para A2'.
  const stats = c.currentChapterStats;
  // 'Chapter 1' (2 words, 8 non-space chars) + 'para A1' (2/6) + 'para A2' (2/6).
  assert.equal(stats.words, 6);
  assert.equal(stats.chars, 20);
});

test('loadFile: <input type="file"> change event populates rawBook', async () => {
  const c = await initFresh();
  await c.loadFile({
    target: {
      tagName: 'INPUT',
      type: 'file',
      files: [{ async text() { return '# Chapter One\n\nHello.'; } }],
      value: '_will_be_cleared_',
    },
  });
  assert.equal(c.rawBook, '# Chapter One\n\nHello.');
});

test('loadFile: drag-and-drop drop event populates rawBook and calls preventDefault', async () => {
  const c = await initFresh();
  let prevented = false;
  await c.loadFile({
    preventDefault: () => { prevented = true; },
    dataTransfer: { files: [{ async text() { return 'dropped content'; } }] },
    target: { tagName: 'TEXTAREA' },  // drop fires with the textarea as target
  });
  assert.equal(prevented, true, 'must call preventDefault on the drop event');
  assert.equal(c.rawBook, 'dropped content');
});

test('loadFile: surfaces a file-read error without clobbering rawBook', async () => {
  const c = await initFresh();
  c.rawBook = 'kept';
  await c.loadFile({
    target: {
      tagName: 'INPUT', type: 'file',
      files: [{ async text() { throw new Error('disk gone'); } }],
    },
  });
  assert.equal(c.rawBook, 'kept');
  assert.match(c.error || '', /disk gone/);
});

test('exportDictionary: produces a 3-column markdown table for the singular editor', async () => {
  const c = await initFresh();
  c.config.targetLanguage = 'Russian';
  c.dictionary = [
    { term: 'Hogwarts', translation: 'Хогвартс', notes: 'school', chapters: [0] },
    { term: 'Quidditch', translation: 'квиддич', notes: '', chapters: [1] },
  ];
  // Capture what the component would download instead of actually clicking.
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportDictionary();
  assert.equal(captured.filename, 'dictionary.md');
  assert.match(captured.md, /\| Term \| Russian \| Notes \|/);
  assert.doesNotMatch(captured.md, /Reference/i);
  assert.match(captured.md, /\| Hogwarts \| Хогвартс \| school \|/);
});

test('exportDictionary: no-ops on empty dictionary', async () => {
  const c = await initFresh();
  let called = false;
  c._downloadMarkdown = () => { called = true; };
  c.exportDictionary();
  assert.equal(called, false, 'must not download an empty dictionary');
});

test('currentChapterStats: ignores leading/trailing whitespace and treats newlines as separators', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  c.book.chapters[0].translatedTitle = '  Заголовок  ';
  c.book.chapters[0].paragraphs[0].translation = 'два слова';
  c.book.chapters[0].paragraphs[1].translation = 'строка\nещё строка';
  const stats = c.currentChapterStats;
  // 'Заголовок' (1 word, 9 chars) + 'два слова' (2/8) + 'строка ещё строка' (3/15).
  assert.equal(stats.words, 6);
  assert.equal(stats.chars, 32);
});

// ---------- chapter gate ----------

test('acceptAndNext: does NOT re-translate an already-translated next chapter', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  await c.acceptAndNext();                 // now on ch2, ch2 translated
  assert.equal(c.currentChapterIndex, 1);

  // User navigates back to ch1 and edits it.
  c.selectChapter(0);
  c.book.chapters[0].paragraphs[0].translation = 'edited A1';

  // User had already edited ch2. That edit must survive.
  c.selectChapter(1);
  c.book.chapters[1].paragraphs[0].translation = 'my ch2 edit';

  c.selectChapter(0);
  await c.acceptAndNext();

  assert.equal(c.currentChapterIndex, 1);
  assert.equal(c.book.chapters[1].paragraphs[0].translation, 'my ch2 edit',
    'already-translated next chapter must not be clobbered');
});

test('acceptAndNext: rolls back status when translator fails', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();              // ch1 translated

  // Swap to POE with a failing fetch; ch2 is still pending, so it will be attempted.
  c.config.translator = 'poe';
  c.config.apiKey = 'k';
  c.config.model = 'M';
  c.config.baseUrl = 'http://x';
  const restore = withFetch(async () => mockResponse({ ok: false, status: 500, body: 'boom' }));
  try {
    await c.acceptAndNext();
  } finally { restore(); }

  assert.ok(c.error, 'error should be recorded');
  assert.equal(c.book.chapters[0].status, 'translated',
    'previous chapter status must be restored on failure');
  assert.equal(c.currentChapterIndex, 0, 'should not advance on failure');
});

// ---------- navigation ----------

test('selectChapter: refuses to navigate to a pending chapter', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();              // ch1 translated, ch2/ch3 pending
  c.selectChapter(1);
  assert.equal(c.currentChapterIndex, 0);
  c.selectChapter(2);
  assert.equal(c.currentChapterIndex, 0);
});

test('selectChapter: allows navigation to a translated chapter', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  await c.acceptAndNext();                 // on ch2
  c.selectChapter(0);
  assert.equal(c.currentChapterIndex, 0);
});

// ---------- error surfaces ----------

test('startFromRaw: empty input surfaces an error and stays on setup', async () => {
  const c = await initFresh();
  c.rawBook = '';
  c.config.translator = 'dummy';
  await c.startFromRaw();
  assert.match(c.error || '', /chapters/i);
  assert.equal(c.view, 'setup');
});

test('headingLevel: level-2 input is rejected at default level, accepted at level 2', async () => {
  const src = '# Book\n\nintro\n\n## Ch A\n\na\n\n## Ch B\n\nb';

  const c1 = await initFresh();
  c1.rawBook = src;
  c1.config.translator = 'dummy';
  await c1.startFromRaw();
  // Default level 1 → one chapter (the # Book heading), with sub-headings as body text.
  assert.equal(c1.book.chapters.length, 1);
  assert.equal(c1.book.chapters[0].title, 'Book');

  const c2 = await initFresh();
  c2.rawBook = src;
  c2.config.translator = 'dummy';
  c2.headingLevel = 2;
  await c2.startFromRaw();
  assert.equal(c2.book.chapters.length, 2);
  assert.deepEqual(c2.book.chapters.map(c => c.title), ['Ch A', 'Ch B']);
});

// ---------- derived getters ----------

test('nextButtonLabel reflects final-chapter and already-translated-next cases', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();              // on ch1 of 3

  assert.equal(c.nextButtonLabel, 'Accept & translate next chapter');

  await c.acceptAndNext();                 // on ch2 of 3 (ch3 pending)
  assert.equal(c.nextButtonLabel, 'Accept & translate next chapter');

  await c.acceptAndNext();                 // on ch3 of 3 (final)
  assert.equal(c.nextButtonLabel, 'Accept (final chapter)');

  // Go back to ch1, next chapter is already translated → "go to next".
  c.selectChapter(0);
  assert.equal(c.nextButtonLabel, 'Accept & go to next chapter');
});

test('acceptedCount and anyTranslated getters', async () => {
  const c = await initFresh();
  assert.equal(c.acceptedCount, 0);
  assert.equal(c.anyTranslated, false);

  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  assert.equal(c.anyTranslated, true);
  assert.equal(c.acceptedCount, 0);

  await c.acceptAndNext();
  assert.equal(c.acceptedCount, 1);
});

// ---------- dictionary ----------

test('startFromRaw: dictionaryProgress starts null, ends null after build', async () => {
  const c = await initFresh();
  setDummyBook(c);
  assert.equal(c.dictionaryProgress, null);
  await c.startFromRaw();
  assert.equal(c.dictionaryProgress, null, 'progress must be cleared once the build finishes');
});

test('font-size and splitPercent survive acceptAndNext (translate next chapter)', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  c.splitPercent = 72;
  c.originalFontSize = 'small';
  c.translationFontSize = 'biggest';
  await c.acceptAndNext();
  assert.equal(c.currentChapterIndex, 1);
  assert.equal(c.splitPercent, 72,           'split preserved across chapter change');
  assert.equal(c.originalFontSize, 'small');
  assert.equal(c.translationFontSize, 'biggest');
});

test('font-size and splitPercent survive selectChapter (sidebar navigation)', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  await c.acceptAndNext();
  c.splitPercent = 30;
  c.originalFontSize = 'smallest';
  c.translationFontSize = 'medium';
  c.selectChapter(0);
  assert.equal(c.currentChapterIndex, 0);
  assert.equal(c.splitPercent, 30);
  assert.equal(c.originalFontSize, 'smallest');
  assert.equal(c.translationFontSize, 'medium');
});

test('font-size and splitPercent survive retranslateCurrent', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  c.splitPercent = 45;
  c.originalFontSize = 'big';
  c.translationFontSize = 'smallest';
  await c.retranslateCurrent();
  assert.equal(c.splitPercent, 45);
  assert.equal(c.originalFontSize, 'big');
  assert.equal(c.translationFontSize, 'smallest');
});

test('defaults: split 60 %, original medium, translation big', async () => {
  const c = await initFresh();
  assert.equal(c.splitPercent, 60);
  assert.equal(c.originalFontSize, 'medium');
  assert.equal(c.translationFontSize, 'big');
});

test('font-size selections persist across reloads', async () => {
  const c1 = await initFresh();
  c1.originalFontSize = 'small';
  c1.translationFontSize = 'biggest';
  await c1.persistNow();

  const c2 = makeComponent();
  await c2.init();
  assert.equal(c2.originalFontSize, 'small');
  assert.equal(c2.translationFontSize, 'biggest');
});

test('font-size: malformed saved value falls back to default', async () => {
  clearStore();
  await globalThis.localforage.setItem('book-translate-state:v1', {
    originalFontSize: 'enormous', translationFontSize: 42,
  });
  const c = makeComponent();
  await c.init();
  assert.equal(c.originalFontSize, 'medium');
  assert.equal(c.translationFontSize, 'big');
});

test('addTerm/removeTerm mutate the dictionary', async () => {
  const c = await initFresh();
  c.addTerm();
  c.addTerm();
  c.dictionary[0].term = 'X';
  c.dictionary[1].term = 'Y';
  c.removeTerm(0);
  assert.equal(c.dictionary.length, 1);
  assert.equal(c.dictionary[0].term, 'Y');
});

// ---------- persistence ----------

test('persist/load round-trip restores view, book, dictionary, and config', async () => {
  const c1 = await initFresh();
  setDummyBook(c1);
  await c1.startFromRaw();
  c1.dictionary.push({ term: 'Winston', translation: 'Уинстон', notes: '' });
  await c1.acceptDictionary();
  c1.book.chapters[0].paragraphs[0].translation = 'перевод';
  await c1.persistNow();

  const c2 = makeComponent();
  await c2.init();
  assert.equal(c2.view, 'editor');
  assert.equal(c2.book.chapters.length, 3);
  assert.equal(c2.book.chapters[0].status, 'translated');
  assert.equal(c2.book.chapters[0].paragraphs[0].translation, 'перевод');
  assert.ok(c2.dictionary.some(e => e.term === 'Winston'));
});

test('persist is suppressed until loadSaved completes (no clobber of saved state)', async () => {
  // Pre-seed store with state.
  const c1 = await initFresh();
  setDummyBook(c1);
  await c1.startFromRaw();
  await c1.acceptDictionary();
  await c1.persistNow();

  const before = await globalThis.localforage.getItem('book-translate-state:v1');
  assert.ok(before?.book);

  // Create a second component but DO NOT call init. Trigger schedulePersist()
  // — it must be a no-op because _loaded is false.
  const c2 = makeComponent();
  c2.schedulePersist();
  // Wait past the debounce.
  await new Promise(r => setTimeout(r, 50));
  const after = await globalThis.localforage.getItem('book-translate-state:v1');
  assert.deepEqual(after, before, 'pre-init schedulePersist must not write');
});

// ---------- query-param overrides ----------

test('_applyQueryParamOverrides: applies known string config fields', async () => {
  const c = await initFresh();
  const applied = c._applyQueryParamOverrides(
    '?translator=poe&model=claude-opus-4.7&dictionaryModel=gemini-2.5-flash&apiKey=sk-test&targetLanguage=French'
  );
  assert.equal(applied, true);
  assert.equal(c.config.translator, 'poe');
  assert.equal(c.config.model, 'claude-opus-4.7');
  assert.equal(c.config.dictionaryModel, 'gemini-2.5-flash');
  assert.equal(c.config.apiKey, 'sk-test');
  assert.equal(c.config.targetLanguage, 'French');
});

test('_applyQueryParamOverrides: coerces numeric fields', async () => {
  const c = await initFresh();
  c._applyQueryParamOverrides('?dictionaryChunkChars=12345');
  assert.equal(c.config.dictionaryChunkChars, 12345);
  assert.equal(typeof c.config.dictionaryChunkChars, 'number');
});

test('_applyQueryParamOverrides: invalid number is skipped (existing value preserved)', async () => {
  const c = await initFresh();
  const before = c.config.dictionaryChunkChars;
  c._applyQueryParamOverrides('?dictionaryChunkChars=not-a-number');
  assert.equal(c.config.dictionaryChunkChars, before);
});

test('_applyQueryParamOverrides: empty query returns false and leaves state alone', async () => {
  const c = await initFresh();
  const originalModel = c.config.model;
  assert.equal(c._applyQueryParamOverrides(''), false);
  assert.equal(c.config.model, originalModel);
});

test('_applyQueryParamOverrides: only the params present override — absent fields are kept', async () => {
  const c = await initFresh();
  c.config.apiKey = 'pre-existing-key';
  c.config.model = 'pre-existing-model';
  c._applyQueryParamOverrides('?model=new-model');
  assert.equal(c.config.model, 'new-model');
  assert.equal(c.config.apiKey, 'pre-existing-key', 'unspecified field must not be touched');
});

test('_applyQueryParamOverrides: unknown params are ignored, no throw', async () => {
  const c = await initFresh();
  c._applyQueryParamOverrides('?unknown=foo&ALSO_UNKNOWN=bar&model=valid');
  assert.equal(c.config.model, 'valid');
});

test('_applyQueryParamOverrides: headingLevel top-level state is overridable', async () => {
  const c = await initFresh();
  c._applyQueryParamOverrides('?headingLevel=2');
  assert.equal(c.headingLevel, 2);
});

// ---------- state export / import ----------

test('serializeState: envelope carries type + version + state; apiKey is blanked', async () => {
  const c = await initFresh();
  setDummyBook(c);
  c.config.apiKey = 'sk-secret-key';
  c.config.model = 'gemini-3.1-pro';
  await c.startFromRaw();

  const env = c.serializeState();
  assert.equal(env.type, 'book-translate-state');
  assert.equal(env.version, 1);
  assert.ok(env.exportedAt, 'exportedAt timestamp must be set');
  // Secret must not leak.
  assert.equal(env.state.config.apiKey, '');
  // Non-secret config survives.
  assert.equal(env.state.config.model, 'gemini-3.1-pro');
  // Work state is included.
  assert.equal(env.state.rawBook, c.rawBook);
  assert.equal(env.state.book.chapters.length, 3);
});

test('serializeState: does not mutate this.config.apiKey', async () => {
  const c = await initFresh();
  c.config.apiKey = 'sk-keep-me';
  c.serializeState();
  assert.equal(c.config.apiKey, 'sk-keep-me');
});

test('importFromText: applies exported envelope; preserves local apiKey', async () => {
  const c = await initFresh();
  c.config.apiKey = 'my-local-key';

  const envelope = {
    type: 'book-translate-state', version: 1, exportedAt: '2026-04-21T12:00:00Z',
    state: {
      view: 'editor',
      rawBook: '# Chapter 1\n\nhello',
      headingLevel: 1,
      splitPercent: 70,
      book: { chapters: [{
        title: 'Chapter 1', translatedTitle: 'Глава 1', status: 'translated',
        paragraphs: [{ original: 'hello', translation: 'привет', status: 'translated' }],
      }]},
      dictionary: [{ term: 'hello', translation: 'привет', notes: '', chapters: [0] }],
      currentChapterIndex: 0,
      config: { translator: 'poe', apiKey: '', model: 'gemini-3.1-pro', targetLanguage: 'Russian' },
    },
  };
  await c.importFromText(JSON.stringify(envelope));

  assert.equal(c.view, 'editor');
  assert.equal(c.rawBook, '# Chapter 1\n\nhello');
  assert.equal(c.splitPercent, 70);
  assert.equal(c.book.chapters.length, 1);
  assert.equal(c.dictionary.length, 1);
  assert.equal(c.config.model, 'gemini-3.1-pro');
  assert.equal(c.config.apiKey, 'my-local-key', 'local API key must be preserved on import');
  assert.equal(c.error, null);
});

test('importFromText: receiver has no key → imported (blank) key + receiver fills in later', async () => {
  const c = await initFresh();           // fresh → apiKey defaults to ''
  const envelope = {
    type: 'book-translate-state', version: 1,
    state: { config: { apiKey: '' } },   // exported state always has blank key
  };
  await c.importFromText(JSON.stringify(envelope));
  assert.equal(c.config.apiKey, '', 'apiKey stays blank; receiver must type their own');
});

test('importFromText: rejects JSON without the right envelope type', async () => {
  const c = await initFresh();
  await c.importFromText('{"foo": 1}');
  assert.match(c.error || '', /type/i);
});

test('importFromText: rejects malformed JSON', async () => {
  const c = await initFresh();
  await c.importFromText('not json at all');
  assert.match(c.error || '', /import failed/i);
});

test('importFromText: cancelled _confirm leaves state untouched', async () => {
  const c = await initFresh();
  c.rawBook = 'keep me';
  c._confirm = () => false;
  const env = JSON.stringify({
    type: 'book-translate-state', version: 1,
    state: { rawBook: 'replaced' },
  });
  await c.importFromText(env);
  assert.equal(c.rawBook, 'keep me');
});

test('canExport: false on fresh component, true once there is work to export', async () => {
  const c = await initFresh();
  assert.equal(c.canExport, false);
  c.rawBook = 'some text';
  assert.equal(c.canExport, true);
});

test('reset clears all state and the store', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  await c.reset();

  assert.equal(c.view, 'setup');
  assert.equal(c.rawBook, '');
  assert.equal(c.book, null);
  assert.equal(c.dictionary.length, 0);
  assert.equal(c.currentChapterIndex, 0);
  const stored = await globalThis.localforage.getItem('book-translate-state:v1');
  assert.equal(stored, null);
});

test('reset respects a cancelling _confirm', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  c._confirm = () => false;
  const before = JSON.parse(JSON.stringify(c.book));
  await c.reset();
  assert.deepEqual(c.book, before, 'state must be untouched when the user cancels');
});

// ---------- retranslateCurrent ----------

test('retranslateParagraph (dummy): rewrites just the one paragraph, leaves others alone', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  // User-edits paragraph 0 and 1.
  c.book.chapters[0].paragraphs[0].translation = 'my edit 0';
  c.book.chapters[0].paragraphs[1].translation = 'my edit 1';
  await c.retranslateParagraph(0, 'strict');
  // Paragraph 0 is overwritten by dummy (identity), paragraph 1 is untouched.
  assert.equal(c.book.chapters[0].paragraphs[0].translation, c.book.chapters[0].paragraphs[0].original);
  assert.equal(c.book.chapters[0].paragraphs[1].translation, 'my edit 1');
});

test('_dictionarySubsetForChapter: filters by chapters[]; legacy entries (no chapters) are kept', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();  // dummy dict entries now carry chapters[]
  c.book = { chapters: [
    { title: 'A', translatedTitle: '', paragraphs: [{ original: 'x', translation: '', status: 'pending' }], status: 'pending' },
    { title: 'B', translatedTitle: '', paragraphs: [{ original: 'y', translation: '', status: 'pending' }], status: 'pending' },
  ]};
  c.dictionary = [
    { term: 'Alpha',  translation: 'Альфа',  notes: '', chapters: [0] },
    { term: 'Beta',   translation: 'Бета',   notes: '', chapters: [1] },
    { term: 'Global', translation: 'Global', notes: '' },  // legacy: no chapters field
    { term: 'Both',   translation: 'Оба',    notes: '', chapters: [0, 1] },
  ];
  const sub0 = c._dictionarySubsetForChapter(0).map(e => e.term).sort();
  assert.deepEqual(sub0, ['Alpha', 'Both', 'Global']);
  const sub1 = c._dictionarySubsetForChapter(1).map(e => e.term).sort();
  assert.deepEqual(sub1, ['Beta', 'Both', 'Global']);
});

test('retranslateCurrent: regenerates current chapter using prior accepted as context', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  await c.acceptAndNext();                 // on ch2
  c.book.chapters[1].paragraphs[0].translation = 'my edit';
  await c.retranslateCurrent();
  assert.equal(c.book.chapters[1].paragraphs[0].translation, 'para B1',
    'dummy retranslate should overwrite edits with the original text');
});

test('retranslateCurrentWithModel2: no-op when config.model2 is empty', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  c.book.chapters[0].paragraphs[0].translation = 'edited';
  // model2 is unset by default; should not run, leaving the edit alone.
  await c.retranslateCurrentWithModel2();
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'edited');
});

test('retranslateCurrentWithModel2: swaps config.model for config.model2 in the translate call', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();

  // Switch to POE so we can see the model name in the outgoing request.
  c.config.translator = 'poe';
  c.config.apiKey = 'k';
  c.config.baseUrl = 'http://x';
  c.config.model = 'Primary-Model';
  c.config.model2 = 'Secondary-Model';

  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: '[0] t\n\n[1] x' } }] } });
  });
  try {
    await c.retranslateCurrentWithModel2();
    assert.equal(usedModel, 'Secondary-Model');
    // Sanity: persisted config.model is unchanged after the override.
    assert.equal(c.config.model, 'Primary-Model');
    // And a plain retranslate goes back to the primary.
    await c.retranslateCurrent();
    assert.equal(usedModel, 'Primary-Model');
  } finally { restore(); }
});

test('retranslateCurrent: respects a cancelling _confirm', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptDictionary();
  c.book.chapters[0].paragraphs[0].translation = 'keep me';
  c._confirm = () => false;
  await c.retranslateCurrent();
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'keep me');
});
