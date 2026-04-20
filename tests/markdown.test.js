import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInlineMd } from '../js/markdown.js';

test('renderInlineMd: plain text passes through unchanged', () => {
  assert.equal(renderInlineMd('hello world'), 'hello world');
});

test('renderInlineMd: escapes HTML before applying markdown (XSS guard)', () => {
  assert.equal(
    renderInlineMd('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
  assert.equal(renderInlineMd('a & b'), 'a &amp; b');
  assert.equal(renderInlineMd('"quoted"'), '&quot;quoted&quot;');
});

test('renderInlineMd: *italic* → <em>', () => {
  assert.equal(renderInlineMd('hello *world*'), 'hello <em>world</em>');
});

test('renderInlineMd: **bold** → <strong>', () => {
  assert.equal(renderInlineMd('**bold** word'), '<strong>bold</strong> word');
});

test('renderInlineMd: __bold__ also → <strong>', () => {
  assert.equal(renderInlineMd('__bold__'), '<strong>bold</strong>');
});

test('renderInlineMd: bold and italic in the same line', () => {
  assert.equal(
    renderInlineMd('She **whispered**, then *paused*.'),
    'She <strong>whispered</strong>, then <em>paused</em>.'
  );
});

test('renderInlineMd: _italic_ at word boundaries, not inside words', () => {
  assert.equal(renderInlineMd('a _word_ here'), 'a <em>word</em> here');
  // snake_case must NOT become snake<em>case…
  assert.equal(renderInlineMd('foo_bar_baz'), 'foo_bar_baz');
});

test('renderInlineMd: multiple bolds on one line', () => {
  assert.equal(
    renderInlineMd('**one** and **two**'),
    '<strong>one</strong> and <strong>two</strong>'
  );
});

test('renderInlineMd: handles null / undefined / non-string input', () => {
  assert.equal(renderInlineMd(null), '');
  assert.equal(renderInlineMd(undefined), '');
  assert.equal(renderInlineMd(42), '42');
});

test('renderInlineMd: leaves unbalanced markers alone', () => {
  assert.equal(renderInlineMd('half *italic'), 'half *italic');
  assert.equal(renderInlineMd('half **bold'), 'half **bold');
});

test('renderInlineMd: preserves newlines verbatim (CSS handles wrapping)', () => {
  assert.equal(renderInlineMd('line one\nline two'), 'line one\nline two');
});
