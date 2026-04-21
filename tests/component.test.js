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
