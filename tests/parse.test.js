import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBook } from '../js/parse.js';

// Input format is Markdown. Chapters are delimited by ATX headings at a
// configured level (default `#`, i.e. H1). Paragraphs are blank-line
// separated (as in Markdown). Content before the first heading is ignored.

test('parseBook: splits on H1 headings', () => {
  const r = parseBook('# One\n\npara A\n\n# Two\n\npara B');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, 'One');
  assert.equal(r.chapters[1].title, 'Two');
});

test('parseBook: first chapter title captured (leading/trailing spaces stripped)', () => {
  const r = parseBook('#   Leading Spaces   \n\nbody');
  assert.equal(r.chapters[0].title, 'Leading Spaces');
});

test('parseBook: optional closing hashes are stripped from the title', () => {
  const r = parseBook('# Title ##\n\nbody\n\n# Another #\n\nbody2');
  assert.equal(r.chapters[0].title, 'Title');
  assert.equal(r.chapters[1].title, 'Another');
});

test('parseBook: paragraphs split on blank lines', () => {
  const r = parseBook('# Ch\n\np1\n\np2\n\np3');
  assert.deepEqual(r.chapters[0].paragraphs.map(p => p.original), ['p1', 'p2', 'p3']);
});

test('parseBook: H2 and deeper headings do NOT start new chapters at default level', () => {
  const r = parseBook('# Ch\n\npara A\n\n## Section\n\npara B\n\n### sub\n\npara C');
  assert.equal(r.chapters.length, 1);
  // The sub-headings remain inside the chapter body as text.
  const joined = r.chapters[0].paragraphs.map(p => p.original).join('\n');
  assert.match(joined, /## Section/);
  assert.match(joined, /### sub/);
});

test('parseBook: configurable heading level splits on that level only', () => {
  const src = '# Book\n\nintro\n\n## Chapter One\n\na\n\n## Chapter Two\n\nb';
  const r = parseBook(src, { headingLevel: 2 });
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, 'Chapter One');
  assert.equal(r.chapters[1].title, 'Chapter Two');
});

test('parseBook: empty chapters (heading but no body) are dropped', () => {
  const r = parseBook('# One\n\nbody\n\n# Empty\n\n# Two\n\nbody2');
  assert.equal(r.chapters.length, 2);
  assert.deepEqual(r.chapters.map(c => c.title), ['One', 'Two']);
});

test('parseBook: no headings — falls back to one untitled chapter', () => {
  const r = parseBook('some paragraph\n\nanother one');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, 'Chapter 1');
  assert.equal(r.chapters[0].paragraphs.length, 2);
});

test('parseBook: empty input yields zero chapters', () => {
  assert.equal(parseBook('').chapters.length, 0);
  assert.equal(parseBook('   \n\n   ').chapters.length, 0);
});

test('parseBook: content before the first heading is ignored', () => {
  const r = parseBook('preface text that should be ignored\n\n# Ch 1\n\nbody');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, 'Ch 1');
  assert.equal(r.chapters[0].paragraphs.length, 1);
  assert.equal(r.chapters[0].paragraphs[0].original, 'body');
});

test('parseBook: paragraphs and chapter start with pending status and empty translation', () => {
  const r = parseBook('# Ch\n\np1\n\np2');
  assert.equal(r.chapters[0].status, 'pending');
  for (const p of r.chapters[0].paragraphs) {
    assert.equal(p.status, 'pending');
    assert.equal(p.translation, '');
  }
});

test('parseBook: preserves inline markdown in paragraphs verbatim', () => {
  const r = parseBook('# Ch\n\nShe said *hello* and **goodbye**.\n\n> a quote');
  const originals = r.chapters[0].paragraphs.map(p => p.original);
  assert.ok(originals[0].includes('*hello*'));
  assert.ok(originals[0].includes('**goodbye**'));
  assert.ok(originals[1].startsWith('> '));
});

test('parseBook: multi-line paragraphs (single \\n inside a paragraph) stay as one paragraph', () => {
  const r = parseBook('# Ch\n\nline one\nline two\n\nnext paragraph');
  assert.equal(r.chapters[0].paragraphs.length, 2);
  assert.equal(r.chapters[0].paragraphs[0].original, 'line one\nline two');
});

test('parseBook: a line that starts with `#` without a space is NOT a heading', () => {
  // E.g. "#fragment" or "#hashtag" — CommonMark requires a space after the #.
  const r = parseBook('# Ch\n\n#hashtag is fine inline\n\n# Real Heading\n\nbody');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, 'Ch');
  assert.equal(r.chapters[0].paragraphs[0].original, '#hashtag is fine inline');
  assert.equal(r.chapters[1].title, 'Real Heading');
});
