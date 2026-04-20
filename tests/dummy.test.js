import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DummyTranslator } from '../js/translators/dummy.js';

test('DummyTranslator.translateChapter returns { titleTranslation, paragraphs } with identity mapping', async () => {
  const t = new DummyTranslator();
  const chapter = {
    title: 'Chapter Title',
    paragraphs: [
      { original: 'hello', translation: '', status: 'pending' },
      { original: 'world', translation: '', status: 'pending' },
    ],
  };
  const r = await t.translateChapter(chapter, [], []);
  assert.equal(r.titleTranslation, 'Chapter Title');
  assert.equal(r.paragraphs.length, 2);
  assert.equal(r.paragraphs[0].translation, 'hello');
  assert.equal(r.paragraphs[0].status, 'translated');
  assert.equal(r.paragraphs[1].translation, 'world');
  assert.equal(r.paragraphs[1].status, 'translated');
});

test('DummyTranslator.translateChapter preserves original paragraph count', async () => {
  const t = new DummyTranslator();
  const chapter = { title: 't', paragraphs: Array.from({ length: 7 }, (_, i) => ({ original: 'p' + i })) };
  const r = await t.translateChapter(chapter, [], []);
  assert.equal(r.paragraphs.length, 7);
});

test('DummyTranslator.buildDictionary collects recurring capitalized tokens (freq >= 2) with chapter provenance', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Winston met Julia. Winston was tired.' }] },
    { paragraphs: [{ original: 'Julia smiled at Winston.' }] },
  ];
  const dict = await t.buildDictionary(chapters);
  const byTerm = Object.fromEntries(dict.map(d => [d.term, d]));
  assert.ok(byTerm.Winston, 'recurring capitalized token should be included');
  assert.ok(byTerm.Julia,   'recurring capitalized token should be included');
  assert.deepEqual(byTerm.Winston.chapters, [0, 1]);
  assert.deepEqual(byTerm.Julia.chapters,   [0, 1]);
});

test('DummyTranslator.translateParagraph returns the original text unchanged', async () => {
  const t = new DummyTranslator();
  const out = await t.translateParagraph({ original: 'hello' }, 'strict', []);
  assert.equal(out, 'hello');
  const out2 = await t.translateParagraph({ original: 'world' }, 'natural', []);
  assert.equal(out2, 'world');
});

test('DummyTranslator.buildDictionary filters out singletons', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Alpha walked down the street.' }] },
  ];
  const dict = await t.buildDictionary(chapters);
  assert.equal(dict.length, 0);
});

test('DummyTranslator.buildDictionary sorts by frequency descending, then alphabetical', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Alpha Alpha Alpha Beta Beta Gamma Gamma' }] },
  ];
  const dict = await t.buildDictionary(chapters);
  assert.deepEqual(dict.map(d => d.term), ['Alpha', 'Beta', 'Gamma']);
});

test('DummyTranslator.buildDictionary uses the term as translation (identity)', async () => {
  const t = new DummyTranslator();
  const chapters = [{ paragraphs: [{ original: 'Alpha Alpha Beta Beta' }] }];
  const dict = await t.buildDictionary(chapters);
  for (const e of dict) {
    assert.equal(e.translation, e.term);
    assert.equal(e.notes, '');
  }
});

test('DummyTranslator.buildDictionary caps at 40 entries', async () => {
  const t = new DummyTranslator();
  const words = Array.from({ length: 60 }, (_, i) => `Word${String.fromCharCode(65 + (i % 26))}${i}`);
  // Each twice so they pass the freq >= 2 filter.
  const chapters = [{ paragraphs: [{ original: [...words, ...words].join(' ') }] }];
  const dict = await t.buildDictionary(chapters);
  assert.ok(dict.length <= 40);
});
