import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberedParagraphs,
  parseNumberedParagraphs,
  alignByIndex,
  parseJsonArray,
  normalizeDictionary,
  chapterOriginalText,
  chapterTranslationText,
  formatDictionary,
  chunkBookText,
  mergeTermsWithSources,
  renderTranslationMarkdown,
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

// ---------- normalizeDictionary ----------

test('normalizeDictionary: fills missing fields with empty strings', () => {
  const arr = normalizeDictionary([{ term: 'a' }]);
  assert.deepEqual(arr, [{ term: 'a', translation: '', notes: '' }]);
});

test('normalizeDictionary: drops entries with empty or missing term', () => {
  const arr = normalizeDictionary([
    { term: 'keep', translation: 'x' },
    { term: '' },
    { translation: 'y' },
    null,
  ]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].term, 'keep');
});

test('normalizeDictionary: trims whitespace from fields', () => {
  const [entry] = normalizeDictionary([{ term: '  a  ', translation: '  b\n', notes: ' c ' }]);
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

// ---------- formatDictionary ----------

test('formatDictionary: renders "term → translation" per line', () => {
  const s = formatDictionary([
    { term: 'Winston', translation: 'Уинстон', notes: '' },
    { term: 'Julia', translation: 'Джулия', notes: 'love interest' },
  ]);
  assert.match(s, /Winston → Уинстон/);
  assert.match(s, /Julia → Джулия/);
  assert.match(s, /love interest/);
});

test('formatDictionary: empty dictionary returns "(empty)"', () => {
  assert.equal(formatDictionary([]), '(empty)');
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

test('renderTranslationMarkdown: chapters past uptoIndex are never included', () => {
  const book = { chapters: [
    ch('One', 'Один', [para('a', 'а')], 'accepted'),
    ch('Two', 'Два', [para('b', 'б')], 'translated'),
  ]};
  const md = renderTranslationMarkdown(book, 0);
  assert.match(md, /# Один/);
  assert.doesNotMatch(md, /Два/);
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
