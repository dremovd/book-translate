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

test('DummyTranslator.buildGlossary collects recurring capitalized tokens (freq >= 2) with chapter provenance', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Winston met Julia. Winston was tired.' }] },
    { paragraphs: [{ original: 'Julia smiled at Winston.' }] },
  ];
  const gloss = await t.buildGlossary(chapters);
  const byTerm = Object.fromEntries(gloss.map(d => [d.term, d]));
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

test('DummyTranslator.buildGlossary filters out singletons', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Alpha walked down the street.' }] },
  ];
  const gloss = await t.buildGlossary(chapters);
  assert.equal(gloss.length, 0);
});

test('DummyTranslator.buildGlossary sorts by frequency descending, then alphabetical', async () => {
  const t = new DummyTranslator();
  const chapters = [
    { paragraphs: [{ original: 'Alpha Alpha Alpha Beta Beta Gamma Gamma' }] },
  ];
  const gloss = await t.buildGlossary(chapters);
  assert.deepEqual(gloss.map(d => d.term), ['Alpha', 'Beta', 'Gamma']);
});

test('DummyTranslator.buildGlossary uses the term as translation (identity)', async () => {
  const t = new DummyTranslator();
  const chapters = [{ paragraphs: [{ original: 'Alpha Alpha Beta Beta' }] }];
  const gloss = await t.buildGlossary(chapters);
  for (const e of gloss) {
    assert.equal(e.translation, e.term);
    assert.equal(e.notes, '');
  }
});

test('DummyTranslator.buildGlossary caps at 40 entries', async () => {
  const t = new DummyTranslator();
  const words = Array.from({ length: 60 }, (_, i) => `Word${String.fromCharCode(65 + (i % 26))}${i}`);
  // Each twice so they pass the freq >= 2 filter.
  const chapters = [{ paragraphs: [{ original: [...words, ...words].join(' ') }] }];
  const gloss = await t.buildGlossary(chapters);
  assert.ok(gloss.length <= 40);
});
