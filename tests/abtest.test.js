import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickRandomSample,
  assignSwaps,
  tallyAbResults,
  plainTextToMarkdown,
  buildAlignmentBlocks,
} from '../js/abtest.js';

// ---------- pickRandomSample ----------

test('pickRandomSample: returns at most n items; original array unchanged', () => {
  const arr = [1, 2, 3, 4, 5];
  const sample = pickRandomSample(arr, 3, () => 0.5);
  assert.equal(sample.length, 3);
  assert.deepEqual(arr, [1, 2, 3, 4, 5]);
});

test('pickRandomSample: n greater than length returns all items', () => {
  assert.equal(pickRandomSample([1, 2], 5).length, 2);
});

test('pickRandomSample: every item came from the source array', () => {
  const arr = ['a', 'b', 'c', 'd'];
  for (const x of pickRandomSample(arr, 4)) assert.ok(arr.includes(x));
});

// ---------- assignSwaps ----------

test('assignSwaps: each pair gets a boolean .swapped, original fields kept', () => {
  let i = 0;
  const rng = () => [0.1, 0.9, 0.3, 0.7][i++ % 4];
  const out = assignSwaps([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], rng);
  assert.equal(out[0].swapped, true);   // 0.1 < 0.5
  assert.equal(out[1].swapped, false);
  assert.equal(out[2].swapped, true);
  assert.equal(out[3].swapped, false);
  assert.equal(out[0].id, 1);
});

// ---------- tallyAbResults ----------

test('tallyAbResults: corrects rater choice for per-pair swap', () => {
  const pairs = [
    { swapped: false }, // slot A = aText
    { swapped: true },  // slot A = bText
    { swapped: false },
    { swapped: true },
    { swapped: false },
    { swapped: false },
  ];
  const choices = ['a', 'a', 'b', 'b', 'tie', null];
  // 0: pick slot A, not swapped → aWins
  // 1: pick slot A, swapped     → bWins
  // 2: pick slot B, not swapped → bWins
  // 3: pick slot B, swapped     → aWins
  // 4: tie
  // 5: not rated
  const r = tallyAbResults(pairs, choices);
  assert.equal(r.aWins, 2);
  assert.equal(r.bWins, 2);
  assert.equal(r.ties, 1);
});

test('tallyAbResults: handles empty input', () => {
  assert.deepEqual(tallyAbResults([], []), { aWins: 0, bWins: 0, ties: 0 });
});

// ---------- plainTextToMarkdown ----------

test('plainTextToMarkdown: Cyrillic ALL CAPS line surrounded by blanks → "# Title" in sentence-case', () => {
  const md = plainTextToMarkdown('\n\nКОНЬ НА КРЫШЕ\n\nЯ выехал в Россию верхом на коне.\n\n');
  assert.match(md, /^# Конь на крыше$/m);
  assert.match(md, /Я выехал в Россию/);
});

test('plainTextToMarkdown: Latin ALL CAPS line also recognized', () => {
  const md = plainTextToMarkdown('\n\nCHAPTER ONE\n\nIt was a bright cold day…\n');
  assert.match(md, /^# Chapter one$/m);
});

test('plainTextToMarkdown: mixed-case line is NOT a heading', () => {
  const md = plainTextToMarkdown('\n\nMixed Case Line\n\nbody.\n');
  assert.doesNotMatch(md, /^# Mixed/m);
});

test('plainTextToMarkdown: collapses runs of 3+ blank lines to one blank', () => {
  const md = plainTextToMarkdown('para 1\n\n\n\n\npara 2\n');
  assert.doesNotMatch(md, /\n{3,}/);
  assert.match(md, /para 1\n\npara 2/);
});

test('plainTextToMarkdown: empty input yields empty string', () => {
  assert.equal(plainTextToMarkdown(''), '');
});

// ---------- buildAlignmentBlocks ----------

test('buildAlignmentBlocks: emits one block per interval, joining ranges with \\n\\n', () => {
  const sourceBook = { chapters: [
    { title: 'Ch 1', paragraphs: [{original:'s1'},{original:'s2'},{original:'s3'}] },
    { title: 'Ch 2', paragraphs: [{original:'s4'},{original:'s5'}] },
  ]};
  const aBook = { chapters: [
    { title: 'A 1', paragraphs: [{original:'a1'},{original:'a2'},{original:'a3'}] },
    { title: 'A 2', paragraphs: [{original:'a4'},{original:'a5'}] },
  ]};
  const bBook = { chapters: [
    { title: 'B 1', paragraphs: [{original:'b1'},{original:'b2'}] },
  ]};
  const intervals = {
    0: [
      { bStart: 0, bEnd: 0, sourceChapterIdx: 0, sStart: 0, sEnd: 1 }, // b1 ↔ s1+s2
      { bStart: 1, bEnd: 1, sourceChapterIdx: 1, sStart: 0, sEnd: 0 }, // b2 ↔ s4
    ],
  };
  const blocks = buildAlignmentBlocks(sourceBook, aBook, bBook, intervals);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].source, 's1\n\ns2');
  assert.equal(blocks[0].aText, 'a1\n\na2');
  assert.equal(blocks[0].bText, 'b1');
  assert.equal(blocks[1].source, 's4');
  assert.equal(blocks[1].aText, 'a4');
  assert.equal(blocks[1].bText, 'b2');
});

test('buildAlignmentBlocks: drops entries when A does not cover that source chapter', () => {
  const sourceBook = { chapters: [
    { title: 'Ch 0', paragraphs: [{original:'s0'}] },
    { title: 'Ch 1', paragraphs: [{original:'s1'}] }, // beyond A
  ]};
  const aBook = { chapters: [
    { title: 'A 0', paragraphs: [{original:'a0'}] },
  ]};
  const bBook = { chapters: [
    { title: 'B 0', paragraphs: [{original:'b0'}] },
  ]};
  const intervals = {
    0: [{ bStart: 0, bEnd: 0, sourceChapterIdx: 1, sStart: 0, sEnd: 0 }],
  };
  assert.deepEqual(buildAlignmentBlocks(sourceBook, aBook, bBook, intervals), []);
});

test('buildAlignmentBlocks: out-of-range indices are dropped', () => {
  const sourceBook = { chapters: [{ title:'C', paragraphs: [{original:'s1'}] }] };
  const aBook = { chapters: [{ title:'A', paragraphs: [{original:'a1'}] }] };
  const bBook = { chapters: [{ title:'B', paragraphs: [{original:'b1'}] }] };
  const intervals = {
    0: [{ bStart: 0, bEnd: 5, sourceChapterIdx: 0, sStart: 0, sEnd: 0 }],
  };
  assert.deepEqual(buildAlignmentBlocks(sourceBook, aBook, bBook, intervals), []);
});

test('buildAlignmentBlocks: tolerates malformed input (missing chapters / non-array intervals)', () => {
  assert.deepEqual(buildAlignmentBlocks({}, {}, {}, {}), []);
  assert.deepEqual(buildAlignmentBlocks(null, null, null, null), []);
  const sourceBook = { chapters: [{ paragraphs: [] }] };
  const aBook = { chapters: [{ paragraphs: [] }] };
  const bBook = { chapters: [{ paragraphs: [] }] };
  assert.deepEqual(buildAlignmentBlocks(sourceBook, aBook, bBook, { 0: 'not an array' }), []);
});
