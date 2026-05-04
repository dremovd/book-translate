import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberedParagraphs,
  parseNumberedParagraphs,
  alignByIndex,
  parseJsonArray,
  normalizeGlossary,
  chapterOriginalText,
  chapterTranslationText,
  formatGlossary,
  chunkBookText,
  mergeTermsWithSources,
  renderTranslationMarkdown,
  dialogConventionsFor,
} from '../js/translators/format.js';
import { parseBook } from '../js/parse.js';

// ---------- numberedParagraphs ----------

test('numberedParagraphs: prefixes each paragraph with [N]', () => {
  const s = numberedParagraphs([{ original: 'a' }, { original: 'b' }]);
  assert.equal(s, '[1] a\n\n[2] b');
});

test('numberedParagraphs: encode/decode round-trips through parseNumberedParagraphs', () => {
  const paragraphs = [{ original: 'foo' }, { original: 'bar\nbar2' }, { original: 'baz' }];
  const encoded = numberedParagraphs(paragraphs);
  const decoded = parseNumberedParagraphs(encoded);
  assert.equal(decoded.get(1), 'foo');
  assert.equal(decoded.get(2), 'bar\nbar2');
  assert.equal(decoded.get(3), 'baz');
});

// ---------- parseNumberedParagraphs ----------

test('parseNumberedParagraphs: maps sequential [N] markers', () => {
  const m = parseNumberedParagraphs('[1] foo\n\n[2] bar\n\n[3] baz');
  assert.equal(m.get(1), 'foo');
  assert.equal(m.get(2), 'bar');
  assert.equal(m.get(3), 'baz');
});

test('parseNumberedParagraphs: preserves multi-line paragraph bodies', () => {
  const m = parseNumberedParagraphs('[1] line one\nstill one\n\n[2] two');
  assert.equal(m.get(1), 'line one\nstill one');
  assert.equal(m.get(2), 'two');
});

test('parseNumberedParagraphs: [10] is distinguished from [1]', () => {
  const m = parseNumberedParagraphs('[1] a\n\n[10] b');
  assert.equal(m.get(1), 'a');
  assert.equal(m.get(10), 'b');
  assert.equal(m.size, 2);
});

test('parseNumberedParagraphs: non-contiguous indices are preserved (gaps not filled)', () => {
  const m = parseNumberedParagraphs('[1] a\n\n[3] c');
  assert.equal(m.get(1), 'a');
  assert.equal(m.has(2), false);
  assert.equal(m.get(3), 'c');
});

test('parseNumberedParagraphs: empty string returns empty map', () => {
  assert.equal(parseNumberedParagraphs('').size, 0);
});

// ---------- alignByIndex ----------

test('alignByIndex: returns translations aligned with originals by index', () => {
  const original = [{ original: 'foo' }, { original: 'bar' }, { original: 'baz' }];
  const map = new Map([[1, 'foo-ru'], [2, 'bar-ru'], [3, 'baz-ru']]);
  const out = alignByIndex(original, map);
  assert.deepEqual(out.map(p => p.translation), ['foo-ru', 'bar-ru', 'baz-ru']);
  for (const p of out) assert.equal(p.status, 'translated');
});

test('alignByIndex: missing indices fall back to original with status=untranslated', () => {
  const original = [{ original: 'foo' }, { original: 'bar' }, { original: 'baz' }];
  const map = new Map([[1, 'foo-ru'], [3, 'baz-ru']]);
  const out = alignByIndex(original, map);
  assert.equal(out[0].translation, 'foo-ru');
  assert.equal(out[0].status, 'translated');
  assert.equal(out[1].translation, 'bar');
  assert.equal(out[1].status, 'untranslated');
  assert.equal(out[2].translation, 'baz-ru');
  assert.equal(out[2].status, 'translated');
});

test('alignByIndex: output length always equals input length', () => {
  const original = [{ original: 'a' }, { original: 'b' }];
  assert.equal(alignByIndex(original, new Map()).length, 2);
  assert.equal(alignByIndex(original, new Map([[1, 'x'], [2, 'y'], [3, 'extra']])).length, 2);
});

// ---------- parseJsonArray ----------

test('parseJsonArray: bare array', () => {
  const arr = parseJsonArray('[{"term":"a","translation":"b"}]');
  assert.deepEqual(arr, [{ term: 'a', translation: 'b' }]);
});

test('parseJsonArray: strips ```json code fences', () => {
  const arr = parseJsonArray('```json\n[{"x":1}]\n```');
  assert.deepEqual(arr, [{ x: 1 }]);
});

test('parseJsonArray: extracts array when surrounded by prose', () => {
  const arr = parseJsonArray('Here: [{"x":1}] done.');
  assert.deepEqual(arr, [{ x: 1 }]);
});

test('parseJsonArray: throws on unparseable input', () => {
  assert.throws(() => parseJsonArray('definitely not json'));
});

// ---------- normalizeGlossary ----------

test('normalizeGlossary: fills missing fields with empty strings', () => {
  const arr = normalizeGlossary([{ term: 'a' }]);
  assert.deepEqual(arr, [{ term: 'a', translation: '', notes: '' }]);
});

test('normalizeGlossary: drops entries with empty or missing term', () => {
  const arr = normalizeGlossary([
    { term: 'keep', translation: 'x' },
    { term: '' },
    { translation: 'y' },
    null,
  ]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].term, 'keep');
});

test('normalizeGlossary: trims whitespace from fields', () => {
  const [entry] = normalizeGlossary([{ term: '  a  ', translation: '  b\n', notes: ' c ' }]);
  assert.deepEqual(entry, { term: 'a', translation: 'b', notes: 'c' });
});

// ---------- chapter text helpers ----------

test('chapterOriginalText/chapterTranslationText: paragraphs joined by blank lines', () => {
  const ch = { paragraphs: [
    { original: 'p1', translation: 't1' },
    { original: 'p2', translation: 't2' },
  ]};
  assert.equal(chapterOriginalText(ch), 'p1\n\np2');
  assert.equal(chapterTranslationText(ch), 't1\n\nt2');
});

// ---------- formatGlossary ----------

test('formatGlossary: renders "term → translation" per line', () => {
  const s = formatGlossary([
    { term: 'Winston', translation: 'Уинстон', notes: '' },
    { term: 'Julia', translation: 'Джулия', notes: 'love interest' },
  ]);
  assert.match(s, /Winston → Уинстон/);
  assert.match(s, /Julia → Джулия/);
  assert.match(s, /love interest/);
});

test('formatGlossary: empty glossary returns "(empty)"', () => {
  assert.equal(formatGlossary([]), '(empty)');
});

test('formatGlossary: bilingual entry renders "(originally X)" before notes', () => {
  // The model translating English-side paragraphs benefits from seeing
  // the canonical Chinese form of each name in the glossary line — both
  // for disambiguation and so canonical-rendering instructions in the
  // notes have something to attach to.
  const s = formatGlossary([
    { term: 'Ruan Mian', translation: 'Жуань Мянь', originalForm: '阮眠', notes: 'protagonist' },
    { term: 'Pingjiang', translation: 'Пинцзян', originalForm: '平江', notes: '' },
  ]);
  assert.match(s, /Ruan Mian → Жуань Мянь.*originally 阮眠.*protagonist/);
  assert.match(s, /Pingjiang → Пинцзян.*originally 平江/);
  // Without notes, "originally X" still appears on its own.
  assert.doesNotMatch(s, /Pingjiang.*protagonist/);
});

test('formatGlossary: entry without originalForm keeps the single-source format', () => {
  const s = formatGlossary([{ term: 'X', translation: 'Х', notes: 'a note' }]);
  assert.match(s, /X → Х\s+\(a note\)/);
  assert.doesNotMatch(s, /originally/);
});

// ---------- renderGlossaryMarkdown ----------

import { renderGlossaryMarkdown } from '../js/translators/format.js';

test('renderGlossaryMarkdown: produces a 4-column markdown table (no chapters column)', () => {
  const gloss = [
    { term: 'Ruan Mian', originalForm: '阮眠', translation: 'Жуань Мянь', notes: 'protagonist', chapters: [0, 1, 2] },
    { term: 'Pingjiang', originalForm: '平江', translation: 'Пинцзян',     notes: '',            chapters: [0] },
  ];
  const md = renderGlossaryMarkdown(gloss, {
    editorLanguage: 'English', referenceLanguage: 'Chinese', targetLanguage: 'Russian',
  });
  assert.match(md, /Chinese.*English.*Russian/);
  // Header row uses the language names — Notes only, no Chapters column.
  assert.match(md, /\| Chinese \| English \| Russian \| Notes \|/);
  assert.doesNotMatch(md, /Chapters/i);
  // Body rows include the term data.
  assert.match(md, /\| 阮眠 \| Ruan Mian \| Жуань Мянь \| protagonist \|/);
  assert.match(md, /\| 平江 \| Pingjiang \| Пинцзян \|  \|/);
});

test('renderGlossaryMarkdown: empty glossary still emits the header line', () => {
  const md = renderGlossaryMarkdown([], { editorLanguage: 'English', referenceLanguage: 'Chinese', targetLanguage: 'Russian' });
  assert.match(md, /^#/m);
  assert.match(md, /English.*Russian/);
  assert.doesNotMatch(md, /\|.*\|/);
});

test('renderGlossaryMarkdown: escapes pipe characters in cell content (table-safety)', () => {
  const md = renderGlossaryMarkdown([
    { term: 'Foo|Bar', originalForm: 'A|B', translation: 'X|Y', notes: 'split: a|b' },
  ], { editorLanguage: 'EN', referenceLanguage: 'ZH', targetLanguage: 'RU' });
  assert.match(md, /A\\\|B/);
  assert.match(md, /Foo\\\|Bar/);
  assert.match(md, /X\\\|Y/);
  assert.match(md, /split: a\\\|b/);
});

test('renderGlossaryMarkdown: omitting referenceLanguage produces a 3-column table for the single-source editor', () => {
  const gloss = [
    { term: 'Hogwarts', translation: 'Хогвартс', notes: 'school', chapters: [0] },
    { term: 'Quidditch', translation: 'квиддич', notes: '', chapters: [1] },
  ];
  const md = renderGlossaryMarkdown(gloss, { targetLanguage: 'Russian' });
  // Header line drops the Reference column entirely — three columns only.
  assert.match(md, /\| Term \| Russian \| Notes \|/);
  assert.doesNotMatch(md, /Reference/i);
  assert.doesNotMatch(md, /Chinese/);
  // Each body row also has three pipe-delimited cells, not four.
  assert.match(md, /\| Hogwarts \| Хогвартс \| school \|/);
  assert.match(md, /\| Quidditch \| квиддич \|  \|/);
});

test('renderGlossaryMarkdown: chapter provenance is never emitted, even when present', () => {
  const gloss = [{ term: 'X', originalForm: '一', translation: 'Икс', notes: '', chapters: [0, 1, 2, 3] }];
  const md = renderGlossaryMarkdown(gloss, { editorLanguage: 'EN', referenceLanguage: 'ZH', targetLanguage: 'RU' });
  assert.doesNotMatch(md, /Chapters/i);
  assert.doesNotMatch(md, /1, 2, 3, 4/);
});

// ---------- chunkBookText ----------

test('chunkBookText: single chapter becomes one chunk with its chapter index', () => {
  const chunks = chunkBookText([
    { title: 'A', paragraphs: [{ original: 'p1' }, { original: 'p2' }] },
  ], 1000);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /# A/);
  assert.deepEqual(chunks[0].chapterIndices, [0]);
});

test('chunkBookText: multiple chapters yield one chunk per chapter (no packing)', () => {
  const chunks = chunkBookText([
    { title: 'A', paragraphs: [{ original: 'x' }] },
    { title: 'B', paragraphs: [{ original: 'y' }] },
    { title: 'C', paragraphs: [{ original: 'z' }] },
  ], 1000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(c => c.chapterIndices), [[0], [1], [2]]);
  assert.match(chunks[0].text, /# A/);
  assert.match(chunks[2].text, /# C/);
});

test('chunkBookText: a chapter larger than max is split by paragraph boundaries, all with same chapterIndex', () => {
  const chapter = {
    title: 'Huge',
    paragraphs: Array.from({ length: 6 }, (_, i) => ({ original: `para${i}-` + 'x'.repeat(50) })),
  };
  const chunks = chunkBookText([chapter], 100);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.match(c.text, /Huge/);
    assert.deepEqual(c.chapterIndices, [0]);
  }
  for (const p of chapter.paragraphs) {
    const hits = chunks.filter(c => c.text.includes(p.original)).length;
    assert.equal(hits, 1, `paragraph "${p.original.slice(0, 20)}…" should appear in exactly one chunk`);
  }
});

test('chunkBookText: empty paragraphs chapter is skipped', () => {
  const chunks = chunkBookText([
    { title: 'Empty', paragraphs: [] },
    { title: 'Real',  paragraphs: [{ original: 'body' }] },
  ], 1000);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].chapterIndices, [1]);
});

test('chunkBookText: empty input returns empty array', () => {
  assert.deepEqual(chunkBookText([], 1000), []);
});

// ---------- mergeTermsWithSources ----------

test('mergeTermsWithSources: deduplicates terms and unions chapter indices', () => {
  const merged = mergeTermsWithSources([
    { terms: ['Winston', 'Julia'],      chapterIndices: [0] },
    { terms: ['Winston', 'Big Brother'], chapterIndices: [1] },
    { terms: ['Julia', 'Winston'],      chapterIndices: [2] },
  ]);
  const byTerm = Object.fromEntries(merged.map(e => [e.term, e]));
  assert.deepEqual(byTerm.Winston.chapters, [0, 1, 2]);
  assert.deepEqual(byTerm.Julia.chapters, [0, 2]);
  assert.deepEqual(byTerm['Big Brother'].chapters, [1]);
});

test('mergeTermsWithSources: sorts by frequency desc, alphabetical tiebreak', () => {
  const merged = mergeTermsWithSources([
    { terms: ['A', 'B'], chapterIndices: [0] },
    { terms: ['A'],      chapterIndices: [1] },
    { terms: ['A', 'C'], chapterIndices: [2] },
    { terms: ['B'],      chapterIndices: [3] },
  ]);
  assert.deepEqual(merged.map(e => e.term), ['A', 'B', 'C']);  // A=3, B=2, C=1
  assert.equal(merged[0].frequency, 3);
});

test('mergeTermsWithSources: trims whitespace and drops empty terms', () => {
  const merged = mergeTermsWithSources([
    { terms: ['  Winston  ', ''], chapterIndices: [0] },
    { terms: ['\n', null, undefined], chapterIndices: [0] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].term, 'Winston');
});

test('mergeTermsWithSources: tolerates malformed rows', () => {
  const merged = mergeTermsWithSources([
    null, undefined,
    { terms: ['Ok'], chapterIndices: [5] },
    { terms: null, chapterIndices: [7] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].chapters, [5]);
});

test('mergeTermsWithSources: empty input returns empty array', () => {
  assert.deepEqual(mergeTermsWithSources([]), []);
});

// ---------- renderTranslationMarkdown ----------

function ch(title, translatedTitle, paragraphs, status) {
  return { title, translatedTitle, paragraphs, status };
}
function para(original, translation) {
  return { original, translation, status: translation ? 'translated' : 'pending' };
}

test('renderTranslationMarkdown: includes chapters 0..upto, using translated title and translated body', () => {
  const book = { chapters: [
    ch('One', 'Один', [para('hello', 'привет'), para('world', 'мир')], 'accepted'),
    ch('Two', 'Два', [para('foo', 'фу')], 'translated'),
    ch('Three', '', [para('bar', '')], 'pending'),
  ]};
  const md = renderTranslationMarkdown(book, 1);
  assert.match(md, /^# Один/);
  assert.match(md, /привет/);
  assert.match(md, /# Два/);
  assert.match(md, /фу/);
  assert.doesNotMatch(md, /Three/);
  assert.doesNotMatch(md, /bar/);
});

test('renderTranslationMarkdown: pending chapters in range are skipped', () => {
  const book = { chapters: [
    ch('One',   '',    [para('a', '')],  'pending'),
    ch('Two',   'Два', [para('b', 'б')], 'accepted'),
  ]};
  const md = renderTranslationMarkdown(book, 1);
  assert.doesNotMatch(md, /# One/);
  assert.match(md, /# Два/);
});

test('renderTranslationMarkdown: falls back to original title if translatedTitle is empty', () => {
  const book = { chapters: [
    ch('Only', '', [para('hi', 'привет')], 'translated'),
  ]};
  assert.match(renderTranslationMarkdown(book, 0), /^# Only/);
});

test('renderTranslationMarkdown: falls back to original paragraph when translation is empty', () => {
  const book = { chapters: [
    ch('X', 'Х', [
      para('translated para', 'переведённый'),
      para('not translated', ''),
    ], 'translated'),
  ]};
  const md = renderTranslationMarkdown(book, 0);
  assert.match(md, /переведённый/);
  assert.match(md, /not translated/);  // original kept inline
});

test('renderTranslationMarkdown: empty or unreachable book returns empty string', () => {
  assert.equal(renderTranslationMarkdown({ chapters: [] }, 0), '');
  assert.equal(renderTranslationMarkdown({ chapters: [ch('X', '', [para('a', '')], 'pending')] }, 0), '');
});

// ---------- dialogConventionsFor ----------

test('dialogConventionsFor: Russian → em-dash + new-line guidance', () => {
  const s = dialogConventionsFor('Russian');
  assert.ok(s.length > 0);
  assert.match(s, /em-dash|—/);
  assert.match(s, /new line|new speaker|each speaker/i);
});

test('dialogConventionsFor: Russian explains the speech-tag-vs-action punctuation split', () => {
  // Russian punctuation after a spoken line depends on what follows.
  // Speech-reporting verb (verba dicendi) → comma + lowercase tag.
  // Standalone action                     → period + capitalised sentence.
  // The block must mention BOTH branches; without that the model
  // defaults to one or the other and the output reads like translated
  // prose, not native Russian.
  const s = dialogConventionsFor('Russian');
  // Speech-tag branch: must show the comma + lowercased verb pattern.
  assert.match(s, /сказала она/);
  // Action branch: must show the period + capitalised action pattern.
  assert.match(s, /Она улыбнулась/);
  // The two example sentences pin both rules in their canonical form.
  assert.match(s, /— Не переживай, — сказала она\./);
  assert.match(s, /— Не переживай\. — Она улыбнулась\./);
});

test('dialogConventionsFor: French → guillemets', () => {
  const s = dialogConventionsFor('French');
  assert.match(s, /guillemets|«/);
});

test('dialogConventionsFor: English → double quotes + tags-inside-paragraph guidance', () => {
  const s = dialogConventionsFor('English');
  assert.ok(s.length > 0);
  assert.match(s, /double quot/i);
  assert.match(s, /paragraph/i);
});

test('dialogConventionsFor: German → German-style quotation marks', () => {
  const s = dialogConventionsFor('German');
  assert.ok(s.length > 0);
  assert.match(s, /„|quotation/i);
});

test('dialogConventionsFor: case-insensitive lookup', () => {
  assert.equal(dialogConventionsFor('RUSSIAN'), dialogConventionsFor('russian'));
  assert.equal(dialogConventionsFor('  french  '), dialogConventionsFor('French'));
});

test('dialogConventionsFor: unknown language returns empty string', () => {
  assert.equal(dialogConventionsFor('Klingon'), '');
  assert.equal(dialogConventionsFor(''), '');
  assert.equal(dialogConventionsFor(null), '');
  assert.equal(dialogConventionsFor(undefined), '');
});

test('renderTranslationMarkdown: output round-trips through parseBook', () => {
  const book = { chapters: [
    ch('One', 'Один', [para('hello', 'привет'), para('world', 'мир')], 'accepted'),
    ch('Two', 'Два', [para('foo', 'фу')],                               'translated'),
  ]};
  const md = renderTranslationMarkdown(book, 1);
  const { chapters } = parseBook(md);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, 'Один');
  assert.deepEqual(chapters[0].paragraphs.map(p => p.original), ['привет', 'мир']);
  assert.equal(chapters[1].title, 'Два');
  assert.deepEqual(chapters[1].paragraphs.map(p => p.original), ['фу']);
});
