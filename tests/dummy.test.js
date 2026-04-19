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

test('DummyTranslator.buildDictionary collects recurring capitalized tokens (freq >= 2)', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Winston met Julia. Winston was tired.' }] },
    { paragraphs: [{ original: 'Julia smiled at Winston.' }] },
  ];
  const dict = await t.buildDictionary(chapters);
  const terms = dict.map(d => d.term);
  assert.ok(terms.includes('Winston'), 'recurring capitalized token should be included');
  assert.ok(terms.includes('Julia'), 'recurring capitalized token should be included');
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
