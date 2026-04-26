import './_setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, mockResponse } from './_setup.js';
import { makeAbtestComponent } from '../js/abtest-component.js';

function fakeArtifact(blockCount) {
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({
      source: `S${i}`, aText: `A${i}`, bText: `B${i}`,
      label: `block ${i}`,
    });
  }
  return {
    id: 'hpmor', label: 'HPMOR test', builtAt: '2026-04-26T00:00:00Z',
    model: 'gemini-3.1-pro',
    stats: { blocks: blocks.length },
    blocks,
  };
}

test('makeAbtestComponent: init() fetches the registered artifact, transitions to setup', async () => {
  let fetched = null;
  const restore = withFetch(async (url) => { fetched = url; return mockResponse({ body: fakeArtifact(20) }); });
  try {
    const c = makeAbtestComponent();
    assert.equal(c.phase, 'loading');
    await c.init();
    assert.equal(c.phase, 'setup');
    assert.ok(c.artifact);
    assert.equal(c.artifact.id, 'hpmor');
    // The component fetched the path registered in ABTESTS[0].
    assert.match(fetched, /samples\/abtest-hpmor\.json$/);
  } finally { restore(); }
});

test('makeAbtestComponent: init() sets phase=error on fetch failure', async () => {
  const restore = withFetch(async () => mockResponse({ ok: false, status: 404 }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    assert.equal(c.phase, 'error');
    assert.match(c.error, /HTTP 404|404/);
  } finally { restore(); }
});

test('makeAbtestComponent: start() seeds 9 pairs and enters running phase', async () => {
  const restore = withFetch(async () => mockResponse({ body: fakeArtifact(20) }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    c.start();
    assert.equal(c.phase, 'running');
    assert.equal(c.pairs.length, 9);
    assert.equal(c.choices.length, 9);
    assert.equal(c.index, 0);
    for (const p of c.pairs) assert.equal(typeof p.swapped, 'boolean');
  } finally { restore(); }
});

test('makeAbtestComponent: start() caps pairs at the available block count', async () => {
  const restore = withFetch(async () => mockResponse({ body: fakeArtifact(3) }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    c.start();
    assert.equal(c.pairs.length, 3);
  } finally { restore(); }
});

test('makeAbtestComponent: record() advances index, then flips to done; results tally swap-corrected', async () => {
  const restore = withFetch(async () => mockResponse({ body: fakeArtifact(9) }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    c.start();
    // Force a deterministic swap pattern so the test is repeatable.
    c.pairs.forEach((p, i) => p.swapped = (i % 2 === 1));
    // Always pick slot A.
    for (let i = 0; i < 9; i++) c.record('a');
    assert.equal(c.phase, 'done');
    // Picked A on every pair: aWins = pairs where !swapped (5: 0,2,4,6,8); bWins = swapped (4: 1,3,5,7).
    assert.equal(c.results.aWins, 5);
    assert.equal(c.results.bWins, 4);
    assert.equal(c.results.ties, 0);
  } finally { restore(); }
});

test('makeAbtestComponent: reset() returns to setup phase, clears pairs', async () => {
  const restore = withFetch(async () => mockResponse({ body: fakeArtifact(9) }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    c.start();
    c.record('a');
    c.reset();
    assert.equal(c.phase, 'setup');
    assert.equal(c.pairs.length, 0);
    assert.equal(c.choices.length, 0);
    assert.equal(c.index, 0);
    // Artifact stays loaded — no need to refetch.
    assert.ok(c.artifact);
  } finally { restore(); }
});

test('makeAbtestComponent: record() ignores invalid input outside the running phase', async () => {
  const restore = withFetch(async () => mockResponse({ body: fakeArtifact(9) }));
  try {
    const c = makeAbtestComponent();
    await c.init();
    c.record('a'); // before start
    assert.equal(c.phase, 'setup');
    c.start();
    c.record('garbage');
    assert.equal(c.choices[0], null);
    assert.equal(c.index, 0);
  } finally { restore(); }
});
