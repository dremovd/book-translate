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

test('dummy flow: setup → glossary → editor → accept-next → final accept', async () => {
  const c = await initFresh();
  setDummyBook(c);

  await c.startFromRaw();
  assert.equal(c.view, 'glossary');
  assert.equal(c.book.chapters.length, 3);
  assert.equal(c.book.chapters[0].status, 'pending');

  await c.acceptGlossary();
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

test('currentChapterStats: counts words and non-space chars across title + translated paragraphs', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
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

test('previewChapterCount: live count of headings in rawBook (0 when empty, respects headingLevel)', async () => {
  const c = await initFresh();
  assert.equal(c.previewChapterCount, 0, 'empty input → 0 chapters');
  c.rawBook = '# A\n\nx\n\n# B\n\ny\n\n# C\n\nz';
  assert.equal(c.previewChapterCount, 3, 'three H1 chapters detected at default level');
  c.rawBook = '## A\n\nx\n\n## B\n\ny';
  c.headingLevel = 2;
  assert.equal(c.previewChapterCount, 2, 'two H2 chapters detected at level 2');
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

test('exportGlossary: filename uses projectName slug when set', async () => {
  const c = await initFresh();
  c.config.targetLanguage = 'Russian';
  c.config.projectName = 'My Cool Book';
  c.glossary = [{ term: 'Hogwarts', translation: 'Хогвартс', notes: '', chapters: [0] }];
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportGlossary();
  // Slug: lowercased, spaces → hyphens, no leading/trailing punctuation.
  assert.equal(captured.filename, 'my-cool-book-glossary.md');
});

test('exportGlossary: filename has no project prefix when projectName is empty/whitespace', async () => {
  const c = await initFresh();
  c.config.projectName = '   ';   // whitespace alone is treated as unset
  c.glossary = [{ term: 'X', translation: 'Х', notes: '', chapters: [0] }];
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportGlossary();
  assert.equal(captured.filename, 'glossary.md');
});

test('exportSoFar: filename includes projectName slug when set', async () => {
  const c = await initFresh();
  setDummyBook(c);
  c.config.projectName = 'meiyou-renxiang-ni';
  await c.startFromRaw();
  await c.acceptGlossary();
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportSoFar();
  assert.equal(captured.filename, 'meiyou-renxiang-ni-translation-through-chapter-001.md');
});

test('exportSoFar: filename has no project prefix when projectName is empty', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportSoFar();
  assert.equal(captured.filename, 'translation-through-chapter-001.md');
});

test('exportGlossary: produces a 3-column markdown table for the singular editor', async () => {
  const c = await initFresh();
  c.config.targetLanguage = 'Russian';
  c.glossary = [
    { term: 'Hogwarts', translation: 'Хогвартс', notes: 'school', chapters: [0] },
    { term: 'Quidditch', translation: 'квиддич', notes: '', chapters: [1] },
  ];
  // Capture what the component would download instead of actually clicking.
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportGlossary();
  assert.equal(captured.filename, 'glossary.md');
  assert.match(captured.md, /\| Term \| Russian \| Notes \|/);
  assert.doesNotMatch(captured.md, /Reference/i);
  assert.match(captured.md, /\| Hogwarts \| Хогвартс \| school \|/);
});

test('exportGlossary: no-ops on empty glossary', async () => {
  const c = await initFresh();
  let called = false;
  c._downloadMarkdown = () => { called = true; };
  c.exportGlossary();
  assert.equal(called, false, 'must not download an empty glossary');
});

test('currentChapterStats: ignores leading/trailing whitespace and treats newlines as separators', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
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
  await c.acceptGlossary();
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
  await c.acceptGlossary();              // ch1 translated

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
  await c.acceptGlossary();              // ch1 translated, ch2/ch3 pending
  c.selectChapter(1);
  assert.equal(c.currentChapterIndex, 0);
  c.selectChapter(2);
  assert.equal(c.currentChapterIndex, 0);
});

test('selectChapter: allows navigation to a translated chapter', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
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
  await c.acceptGlossary();              // on ch1 of 3

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
  await c.acceptGlossary();
  assert.equal(c.anyTranslated, true);
  assert.equal(c.acceptedCount, 0);

  await c.acceptAndNext();
  assert.equal(c.acceptedCount, 1);
});

// ---------- glossary ----------

test('startFromRaw: glossaryProgress starts null, ends null after build', async () => {
  const c = await initFresh();
  setDummyBook(c);
  assert.equal(c.glossaryProgress, null);
  await c.startFromRaw();
  assert.equal(c.glossaryProgress, null, 'progress must be cleared once the build finishes');
});

test('font-size and splitPercent survive acceptAndNext (translate next chapter)', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
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
  await c.acceptGlossary();
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
  await c.acceptGlossary();
  c.splitPercent = 45;
  c.originalFontSize = 'big';
  c.translationFontSize = 'smallest';
  await c.retranslateCurrent();
  assert.equal(c.splitPercent, 45);
  assert.equal(c.originalFontSize, 'big');
  assert.equal(c.translationFontSize, 'smallest');
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

test('addTerm/removeTerm mutate the glossary', async () => {
  const c = await initFresh();
  c.addTerm();
  c.addTerm();
  c.glossary[0].term = 'X';
  c.glossary[1].term = 'Y';
  c.removeTerm(0);
  assert.equal(c.glossary.length, 1);
  assert.equal(c.glossary[0].term, 'Y');
});

// ---------- persistence ----------

test('persistNow: lights up the saveIndicator after a successful save', async () => {
  const c = await initFresh();
  c.rawBook = '# X\n\nx';
  assert.equal(c.saveIndicator, false, 'idle by default');
  await c.persistNow();
  assert.equal(c.saveIndicator, true, 'must light up immediately after a successful save');
});

test('persistNow: leaves saveIndicator off when the underlying store throws', async () => {
  const c = await initFresh();
  // Force the store layer to throw — exercises the catch path in persistNow.
  const orig = globalThis.localforage.setItem;
  globalThis.localforage.setItem = async () => { throw new Error('disk full'); };
  try {
    await c.persistNow();
    assert.equal(c.saveIndicator, false, 'a thrown save must NOT light up the indicator');
  } finally {
    globalThis.localforage.setItem = orig;
  }
});

test('persist/load round-trip restores view, book, glossary, and config', async () => {
  const c1 = await initFresh();
  setDummyBook(c1);
  await c1.startFromRaw();
  c1.glossary.push({ term: 'Winston', translation: 'Уинстон', notes: '' });
  await c1.acceptGlossary();
  c1.book.chapters[0].paragraphs[0].translation = 'перевод';
  await c1.persistNow();

  const c2 = makeComponent();
  await c2.init();
  assert.equal(c2.view, 'editor');
  assert.equal(c2.book.chapters.length, 3);
  assert.equal(c2.book.chapters[0].status, 'translated');
  assert.equal(c2.book.chapters[0].paragraphs[0].translation, 'перевод');
  assert.ok(c2.glossary.some(e => e.term === 'Winston'));
});

test('loadSaved: pre-rename state with `dictionary`, `view: "dictionary"`, and `dictionary*` config keys migrates to glossary', async () => {
  // Simulate a state file written before the dictionary→glossary rename.
  // Hand-crafted via the same store the component reads from, so the test
  // exercises the actual loadSaved path rather than poking internals.
  await globalThis.localforage.setItem('book-translate-state:v1', {
    view: 'dictionary',
    rawBook: '# C\n\nx',
    book: { chapters: [{ title: 'C', translatedTitle: '', status: 'pending', paragraphs: [{ original: 'x', translation: '', status: 'pending' }] }] },
    dictionary: [{ term: 'Winston', translation: 'Уинстон', notes: '', chapters: [0] }],
    currentChapterIndex: 0,
    config: {
      translator: 'poe',
      apiKey: 'sk-x',
      model: 'gemini-3.1-pro',
      dictionaryModel: 'cheap-model',
      dictionaryGuidance: 'Use Spivak.',
      dictionaryChunkChars: 12345,
      targetLanguage: 'Russian',
    },
  });
  const c = makeComponent();
  await c.init();
  assert.equal(c.view, 'glossary', 'view: "dictionary" must migrate to "glossary"');
  assert.equal(c.glossary.length, 1, 'saved.dictionary must surface as c.glossary');
  assert.equal(c.glossary[0].term, 'Winston');
  assert.equal(c.config.glossaryModel,      'cheap-model');
  assert.equal(c.config.glossaryGuidance,   'Use Spivak.');
  assert.equal(c.config.glossaryChunkChars, 12345);
  assert.equal(c.config.dictionaryModel,    undefined, 'old key must NOT linger after migration');
  assert.equal(c.config.dictionaryGuidance, undefined);
  assert.equal(c.config.dictionaryChunkChars, undefined);
});

test('importFromText: pre-rename export envelope (dictionary, view: "dictionary") migrates to glossary on import', async () => {
  const c = await initFresh();
  c.config.apiKey = 'local-key';
  const envelope = {
    type: 'book-translate-state', version: 1, exportedAt: '2026-04-21T12:00:00Z',
    state: {
      view: 'dictionary',
      rawBook: '# C\n\nx',
      headingLevel: 1,
      book: { chapters: [{ title: 'C', translatedTitle: '', status: 'translated',
        paragraphs: [{ original: 'x', translation: 'икс', status: 'translated' }] }] },
      dictionary: [{ term: 'X', translation: 'Икс', notes: '', chapters: [0] }],
      currentChapterIndex: 0,
      config: { translator: 'poe', apiKey: '', model: 'm',
                dictionaryModel: 'cheap', dictionaryGuidance: 'g', dictionaryChunkChars: 9000 },
    },
  };
  await c.importFromText(JSON.stringify(envelope));
  assert.equal(c.view, 'glossary');
  assert.equal(c.glossary.length, 1);
  assert.equal(c.glossary[0].term, 'X');
  assert.equal(c.config.glossaryModel,      'cheap');
  assert.equal(c.config.glossaryGuidance,   'g');
  assert.equal(c.config.glossaryChunkChars, 9000);
  assert.equal(c.config.apiKey, 'local-key', 'local API key must still survive a legacy import');
});

test('parseQueryOverrides: legacy ?dictionaryModel/?dictionaryGuidance/?dictionaryChunkChars all map to glossary*', async () => {
  // Inline import to avoid disturbing the file's existing imports.
  const { parseQueryOverrides } = await import('../js/component.js');
  const out = parseQueryOverrides('?dictionaryModel=cheap&dictionaryGuidance=hello&dictionaryChunkChars=4242');
  assert.equal(out.configPatch.glossaryModel,      'cheap');
  assert.equal(out.configPatch.glossaryGuidance,   'hello');
  assert.equal(out.configPatch.glossaryChunkChars, 4242);
  // Legacy key should NOT also be set on the patch — we want one canonical key.
  assert.equal(out.configPatch.dictionaryModel, undefined);
});

test('parseQueryOverrides: when both legacy and new keys are present, the new one wins', async () => {
  const { parseQueryOverrides } = await import('../js/component.js');
  const out = parseQueryOverrides('?glossaryModel=NEW&dictionaryModel=OLD');
  assert.equal(out.configPatch.glossaryModel, 'NEW');
});

test('persist is suppressed until loadSaved completes (no clobber of saved state)', async () => {
  // Pre-seed store with state.
  const c1 = await initFresh();
  setDummyBook(c1);
  await c1.startFromRaw();
  await c1.acceptGlossary();
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
    '?translator=poe&model=claude-opus-4.7&glossaryModel=gemini-2.5-flash&apiKey=sk-test&targetLanguage=French'
  );
  assert.equal(applied, true);
  assert.equal(c.config.translator, 'poe');
  assert.equal(c.config.model, 'claude-opus-4.7');
  assert.equal(c.config.glossaryModel, 'gemini-2.5-flash');
  assert.equal(c.config.apiKey, 'sk-test');
  assert.equal(c.config.targetLanguage, 'French');
});

test('_applyQueryParamOverrides: coerces numeric fields', async () => {
  const c = await initFresh();
  c._applyQueryParamOverrides('?glossaryChunkChars=12345');
  assert.equal(c.config.glossaryChunkChars, 12345);
  assert.equal(typeof c.config.glossaryChunkChars, 'number');
});

test('_applyQueryParamOverrides: invalid number is skipped (existing value preserved)', async () => {
  const c = await initFresh();
  const before = c.config.glossaryChunkChars;
  c._applyQueryParamOverrides('?glossaryChunkChars=not-a-number');
  assert.equal(c.config.glossaryChunkChars, before);
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
      glossary: [{ term: 'hello', translation: 'привет', notes: '', chapters: [0] }],
      currentChapterIndex: 0,
      config: { translator: 'poe', apiKey: '', model: 'gemini-3.1-pro', targetLanguage: 'Russian' },
    },
  };
  await c.importFromText(JSON.stringify(envelope));

  assert.equal(c.view, 'editor');
  assert.equal(c.rawBook, '# Chapter 1\n\nhello');
  assert.equal(c.splitPercent, 70);
  assert.equal(c.book.chapters.length, 1);
  assert.equal(c.glossary.length, 1);
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
  await c.acceptGlossary();
  await c.reset();

  assert.equal(c.view, 'setup');
  assert.equal(c.rawBook, '');
  assert.equal(c.book, null);
  assert.equal(c.glossary.length, 0);
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
  await c.acceptGlossary();
  // User-edits paragraph 0 and 1.
  c.book.chapters[0].paragraphs[0].translation = 'my edit 0';
  c.book.chapters[0].paragraphs[1].translation = 'my edit 1';
  await c.retranslateParagraph(0, 'strict');
  // Paragraph 0 is overwritten by dummy (identity), paragraph 1 is untouched.
  assert.equal(c.book.chapters[0].paragraphs[0].translation, c.book.chapters[0].paragraphs[0].original);
  assert.equal(c.book.chapters[0].paragraphs[1].translation, 'my edit 1');
});

test('_glossarySubsetForChapter: filters by chapters[]; legacy entries (no chapters) are kept', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();  // dummy glossary entries now carry chapters[]
  c.book = { chapters: [
    { title: 'A', translatedTitle: '', paragraphs: [{ original: 'x', translation: '', status: 'pending' }], status: 'pending' },
    { title: 'B', translatedTitle: '', paragraphs: [{ original: 'y', translation: '', status: 'pending' }], status: 'pending' },
  ]};
  c.glossary = [
    { term: 'Alpha',  translation: 'Альфа',  notes: '', chapters: [0] },
    { term: 'Beta',   translation: 'Бета',   notes: '', chapters: [1] },
    { term: 'Global', translation: 'Global', notes: '' },  // legacy: no chapters field
    { term: 'Both',   translation: 'Оба',    notes: '', chapters: [0, 1] },
  ];
  const sub0 = c._glossarySubsetForChapter(0).map(e => e.term).sort();
  assert.deepEqual(sub0, ['Alpha', 'Both', 'Global']);
  const sub1 = c._glossarySubsetForChapter(1).map(e => e.term).sort();
  assert.deepEqual(sub1, ['Beta', 'Both', 'Global']);
});

test('retranslateCurrent: regenerates current chapter using prior accepted as context', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
  await c.acceptAndNext();                 // on ch2
  c.book.chapters[1].paragraphs[0].translation = 'my edit';
  await c.retranslateCurrent();
  assert.equal(c.book.chapters[1].paragraphs[0].translation, 'para B1',
    'dummy retranslate should overwrite edits with the original text');
});

test('retranslateParagraphWithModel2: no-op when config.model2 is empty', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
  c.book.chapters[0].paragraphs[0].translation = 'edited';
  // model2 is unset by default; should not run, leaving the edit alone.
  await c.retranslateParagraphWithModel2(0);
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'edited');
});

test('retranslateParagraphWithModel2: swaps config.model for config.model2 in the per-paragraph call', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();

  // Switch to POE so we can see the model name in the outgoing request.
  c.config.translator = 'poe';
  c.config.apiKey = 'k';
  c.config.baseUrl = 'http://x';
  c.config.model = 'Primary-Model';
  c.config.model2 = 'Secondary-Model';

  let usedModel;
  const restore = withFetch(async (_u, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return mockResponse({ body: { choices: [{ message: { content: 'translated text' } }] } });
  });
  try {
    await c.retranslateParagraphWithModel2(0);
    assert.equal(usedModel, 'Secondary-Model');
    assert.equal(c.config.model, 'Primary-Model', 'persisted config.model must not mutate');
    // And a plain per-paragraph retranslate goes back to the primary.
    await c.retranslateParagraph(0, 'default');
    assert.equal(usedModel, 'Primary-Model');
  } finally { restore(); }
});

test('retranslateCurrent: respects a cancelling _confirm', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();
  c.book.chapters[0].paragraphs[0].translation = 'keep me';
  c._confirm = () => false;
  await c.retranslateCurrent();
  assert.equal(c.book.chapters[0].paragraphs[0].translation, 'keep me');
});

// ---------- stats: work-minute tracking ----------

// Helpers — most stats tests need a fully-set-up book in the editor view
// with a fixed wall clock and visibility=visible.
async function initInEditor() {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  await c.acceptGlossary();          // chapter 0 translated, view='editor'
  return c;
}
function withFakeNow(ms, fn) {
  const orig = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = orig; }
}

test('stats: default-empty stats present after init', async () => {
  const c = await initFresh();
  assert.ok(c.stats, 'stats object must exist');
  assert.deepEqual(c.stats.calls, {}, 'no calls counted yet');
  assert.deepEqual(c.stats.byChapter, {}, 'no chapter work yet');
});

test('_recordWork: bumps minute counter for current chapter, sets first/lastWorkAt', async () => {
  const c = await initInEditor();
  withFakeNow(1_700_000_000_000, () => c._recordWork());
  const ch = c.stats.byChapter[0];
  assert.equal(ch.minutes, 1);
  assert.equal(ch.firstWorkAt, ch.lastWorkAt, 'first/last identical on first event');
});

test('_recordWork: same minute, same chapter → no double-count', async () => {
  const c = await initInEditor();
  const t = 1_700_000_000_000;
  withFakeNow(t,        () => c._recordWork());
  withFakeNow(t + 1000, () => c._recordWork()); // 1 second later
  withFakeNow(t + 30000,() => c._recordWork()); // 30 seconds later
  assert.equal(c.stats.byChapter[0].minutes, 1, 'all three events in the same minute count once');
});

test('_recordWork: minute boundary crossed → new minute counted', async () => {
  const c = await initInEditor();
  const t = 1_700_000_000_000;          // arbitrary minute boundary
  withFakeNow(t,         () => c._recordWork());
  withFakeNow(t + 60000, () => c._recordWork());
  withFakeNow(t + 90000, () => c._recordWork()); // same as second minute
  assert.equal(c.stats.byChapter[0].minutes, 2);
});

test('_recordWork: switching chapters tracks each independently', async () => {
  const c = await initInEditor();
  const t = 1_700_000_000_000;
  // Translate chapter 1 so it's selectable.
  await c.acceptAndNext();
  withFakeNow(t,         () => { c.currentChapterIndex = 0; c._recordWork(); });
  withFakeNow(t + 60000, () => { c.currentChapterIndex = 1; c._recordWork(); });
  withFakeNow(t + 60000, () => { c.currentChapterIndex = 0; c._recordWork(); });
  assert.equal(c.stats.byChapter[0].minutes, 2);
  assert.equal(c.stats.byChapter[1].minutes, 1);
});

test('_recordWork: gated to view==="editor" (setup view does NOT count)', async () => {
  const c = await initFresh();
  setDummyBook(c);
  // Stay on setup; recordWork should be a no-op.
  c._recordWork();
  assert.equal(Object.keys(c.stats.byChapter).length, 0);
});

test('_recordWork: gated on document.visibilityState (hidden tab does NOT count)', async () => {
  const c = await initInEditor();
  // Pretend the tab is hidden.
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { visibilityState: 'hidden' },
  });
  try {
    c._recordWork();
    assert.equal(Object.keys(c.stats.byChapter).length, 0, 'hidden tab must NOT count work');
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  }
});

// ---------- stats: API call tracking ----------

test('_recordApiCall: tracks count and accumulated duration per kind', async () => {
  const c = await initFresh();
  c._recordApiCall('chapter-translate', 1500);
  c._recordApiCall('chapter-translate', 2500);
  c._recordApiCall('paragraph-translate', 300);
  assert.equal(c.stats.calls['chapter-translate'].count, 2);
  assert.equal(c.stats.calls['chapter-translate'].totalMs, 4000);
  assert.equal(c.stats.calls['chapter-translate'].timedCount, 2,
    'timedCount must match the timed-arg call count');
  assert.equal(c.stats.calls['paragraph-translate'].count, 1);
  assert.equal(c.stats.calls['paragraph-translate'].totalMs, 300);
});

test('_recordApiCall: missing/undefined duration bumps count but NOT totalMs/timedCount', async () => {
  const c = await initFresh();
  c._recordApiCall('chapter-translate'); // no duration passed
  assert.equal(c.stats.calls['chapter-translate'].count, 1);
  assert.equal(c.stats.calls['chapter-translate'].totalMs, 0);
  assert.equal(c.stats.calls['chapter-translate'].timedCount, 0,
    'untimed calls must stay out of the average divisor');
});

test('_makeTranslator: forwards durationMs through to _recordApiCall (regression: avg latency stuck at "—")', async () => {
  // The translator times each call and invokes onApiCall(kind, durationMs).
  // The component MUST forward both args to _recordApiCall — passing
  // only `kind` lets durationMs default to 0, totalMs never accumulates,
  // and the Stats view's Avg-latency column shows "—" forever.
  const c = await initFresh();
  c.config.translator = 'poe';
  c.config.apiKey = 'k'; c.config.model = 'M'; c.config.baseUrl = 'http://x';
  let now = 1_000_000;
  const origDateNow = Date.now;
  Date.now = () => now;
  const restore = withFetch(async () => {
    now += 1234; // simulate 1234 ms of network time
    return mockResponse({ body: { choices: [{ message: { content: 'ok' } }] } });
  });
  try {
    const t = c._makeTranslator();
    await t.chat([{ role: 'user', content: 'a' }], { kind: 'chapter-translate' });
    const bucket = c.stats.calls['chapter-translate'];
    assert.equal(bucket.count, 1);
    assert.equal(bucket.totalMs, 1234, 'durationMs must reach the stats bucket');
  } finally { restore(); Date.now = origDateNow; }
});

test('apiCallRows: avgMs = totalMs / timedCount; untimed calls in the same bucket are excluded from the divisor', async () => {
  // Mixed bucket: some calls came in with timing (post-fix), some
  // without (pre-fix bug or legacy numeric migration). The displayed
  // count includes everything (it's still an accurate call count); the
  // average should NOT be diluted by the untimed calls.
  const c = await initFresh();
  c._recordApiCall('chapter-translate');           // untimed (count++, no totalMs)
  c._recordApiCall('chapter-translate');           // untimed
  c._recordApiCall('chapter-translate', 1000);     // timed, 1000ms
  c._recordApiCall('chapter-translate', 3000);     // timed, 3000ms
  const row = c.apiCallRows.find(r => r.kind === 'chapter-translate');
  assert.equal(row.count, 4, 'count includes untimed calls');
  // avg = (1000 + 3000) / 2 timed-calls = 2000ms — NOT 1000ms (which would
  // be the diluted version dividing by 4).
  assert.equal(row.avgMs, 2000);
});

test('loadSaved: migrates legacy numeric calls[kind]=N to {count, totalMs, timedCount}', async () => {
  // Simulate saves written before per-kind duration tracking landed.
  await globalThis.localforage.setItem('book-translate-state:v1', {
    view: 'setup',
    stats: { calls: { 'chapter-translate': 5, 'glossary-extract': 2 }, byChapter: {} },
  });
  const c = makeComponent();
  await c.init();
  assert.equal(c.stats.calls['chapter-translate'].count, 5);
  assert.equal(c.stats.calls['chapter-translate'].totalMs, 0);
  // The legacy entries were never timed; timedCount = 0 keeps them out
  // of the average divisor for any subsequent timed calls.
  assert.equal(c.stats.calls['chapter-translate'].timedCount, 0);
  assert.equal(c.stats.calls['glossary-extract'].count, 2);
  assert.equal(c.stats.calls['glossary-extract'].timedCount, 0);
});

test('loadSaved: pre-timedCount {count, totalMs} entries get timedCount inferred (totalMs>0 → count, else 0)', async () => {
  // Simulate saves between the duration feature shipping and the
  // timedCount field landing — `{count, totalMs}` without timedCount.
  // Heuristic: if totalMs > 0, every recorded call must have been timed;
  // if totalMs == 0, none could have been.
  await globalThis.localforage.setItem('book-translate-state:v1', {
    view: 'setup',
    stats: {
      calls: {
        'chapter-translate': { count: 3, totalMs: 6000 },     // post-fix data
        'paragraph-translate': { count: 4, totalMs: 0 },      // pre-fix bug data
      },
      byChapter: {},
    },
  });
  const c = makeComponent();
  await c.init();
  assert.equal(c.stats.calls['chapter-translate'].timedCount, 3,
    'totalMs > 0 → infer that all count calls were timed');
  assert.equal(c.stats.calls['paragraph-translate'].timedCount, 0,
    'totalMs == 0 → infer that no call was timed');
});

test('stats survive persistNow / loadSaved round-trip', async () => {
  const c1 = await initInEditor();
  const t = 1_700_000_000_000;
  withFakeNow(t, () => c1._recordWork());
  c1._recordApiCall('chapter-translate', 1234);
  await c1.persistNow();

  const c2 = makeComponent();
  await c2.init();
  assert.equal(c2.stats.byChapter[0]?.minutes, 1);
  assert.equal(c2.stats.calls['chapter-translate'].count, 1);
  assert.equal(c2.stats.calls['chapter-translate'].totalMs, 1234);
  assert.equal(c2.stats.calls['chapter-translate'].timedCount, 1);
});

test('reset(): wipes stats along with the rest of state', async () => {
  const c = await initInEditor();
  withFakeNow(1_700_000_000_000, () => c._recordWork());
  c._recordApiCall('chapter-translate', 100);
  c._confirm = () => true;
  await c.reset();
  assert.deepEqual(c.stats.calls, {});
  assert.deepEqual(c.stats.byChapter, {});
});

// ---------- stats: nav-bar chars/min ----------

test('charsPerHourTotal: null when no minutes worked', async () => {
  const c = await initFresh();
  assert.equal(c.charsPerHourTotal, null);
});

test('canExportSoFar / exportSoFar: requires at least one non-pending chapter, downloads through current', async () => {
  const c = await initFresh();
  setDummyBook(c);
  // Before parsing, no book → can't export.
  assert.equal(c.canExportSoFar, false);

  await c.startFromRaw();
  // Glossary view, ch1 still pending.
  assert.equal(c.canExportSoFar, false);

  await c.acceptGlossary();
  // ch1 translated → exportSoFar must work.
  assert.equal(c.canExportSoFar, true);
  let captured = null;
  c._downloadMarkdown = (md, filename) => { captured = { md, filename }; };
  c.exportSoFar();
  assert.match(captured.filename, /^translation-through-chapter-001\.md$/);
  assert.match(captured.md, /^# Chapter 1/);
});

test('exportSoFar: no-ops when nothing has been translated yet', async () => {
  const c = await initFresh();
  setDummyBook(c);
  await c.startFromRaw();
  // Still in glossary view, no chapter translated.
  let called = false;
  c._downloadMarkdown = () => { called = true; };
  c.exportSoFar();
  assert.equal(called, false);
});

test('importFromText: rejects an envelope with the right type but no `state` payload', async () => {
  const c = await initFresh();
  await c.importFromText(JSON.stringify({
    type: 'book-translate-state', version: 1, /* state intentionally missing */
  }));
  assert.match(c.error || '', /no.*state.*payload|state/i);
});

test('hasAnyStats: false on a fresh component, true once any call or work-minute lands', async () => {
  const c = await initFresh();
  assert.equal(c.hasAnyStats, false);
  c._recordApiCall('chapter-translate', 100);
  assert.equal(c.hasAnyStats, true);
});

test('hasAnyStats: counts work-minutes too (not just API calls)', async () => {
  const c = await initInEditor();
  assert.equal(c.hasAnyStats, false);
  withFakeNow(1_700_000_000_000, () => c._recordWork());
  assert.equal(c.hasAnyStats, true);
});

test('gotoSetup / gotoGlossary / gotoStats: simple view transitions', async () => {
  const c = await initFresh();
  c.view = 'editor';
  c.gotoSetup();
  assert.equal(c.view, 'setup');
  // gotoGlossary is gated on the glossary being non-empty.
  c.gotoGlossary();
  assert.equal(c.view, 'setup');
  c.glossary.push({ term: 'X', translation: 'Х', notes: '' });
  c.gotoGlossary();
  assert.equal(c.view, 'glossary');
  c.gotoStats();
  assert.equal(c.view, 'stats');
});

test('loadSample: inline-text sample sets rawBook and resets headingLevel', async () => {
  const c = await initFresh();
  c.headingLevel = 3; // anything non-default
  await c.loadSample('tiny');
  assert.match(c.rawBook, /^# Chapter One/);
  assert.equal(c.headingLevel, 1, 'inline samples are H1; level must reset');
});

test('loadSample: unknown id is a silent no-op (no error, no rawBook change)', async () => {
  const c = await initFresh();
  c.rawBook = 'kept';
  await c.loadSample('does-not-exist');
  assert.equal(c.rawBook, 'kept');
  assert.equal(c.error, null);
});

test('loadSample: empty/falsy id is also a no-op', async () => {
  const c = await initFresh();
  c.rawBook = 'kept';
  await c.loadSample('');
  await c.loadSample(null);
  await c.loadSample(undefined);
  assert.equal(c.rawBook, 'kept');
});

test('chapterStatsRows: only includes chapters with at least one recorded minute', async () => {
  const c = await initInEditor();
  await c.acceptAndNext();
  withFakeNow(1_700_000_000_000, () => { c.currentChapterIndex = 0; c._recordWork(); });
  const rows = c.chapterStatsRows;
  assert.equal(rows.length, 1, 'untouched chapters must NOT appear in the stats table');
  assert.equal(rows[0].index, 0);
});

test('charsPerHourTotal: based on ACCEPTED chapters only — in-progress chapter excluded', async () => {
  const c = await initInEditor();
  c.book.chapters[0].paragraphs[0].translation = 'abcdefghij'; // 10 chars
  c.book.chapters[0].paragraphs[1].translation = '12345';      // 5 chars
  withFakeNow(1_700_000_000_000, () => c._recordWork());
  withFakeNow(1_700_000_120_000, () => c._recordWork()); // +2 minutes total
  assert.equal(c.stats.byChapter[0].minutes, 2);
  // In-progress chapter must NOT contribute.
  assert.equal(c.charsPerHourTotal, null);

  // Accept chapter 0. chapterTranslationStats includes the title
  // ("Chapter 1" → 8 no-space chars) plus the two edited paragraphs
  // (10 + 5 = 15) → 23 chars / 2 minutes × 60 = 690 chars/h.
  await c.acceptAndNext();
  assert.equal(c.charsPerHourTotal, 690);
});
