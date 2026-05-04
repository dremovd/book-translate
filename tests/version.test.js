import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_VERSION } from '../js/version.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('APP_VERSION is a positive integer (no dotted/semver shape)', () => {
  assert.equal(typeof APP_VERSION, 'number');
  assert.ok(Number.isInteger(APP_VERSION));
  assert.ok(APP_VERSION >= 1);
});

test('CHANGELOG.md has an entry for the current APP_VERSION', async () => {
  // Forces a bump-without-changelog regression to fail loudly. Anyone
  // bumping APP_VERSION must add a `## v<N>` heading in CHANGELOG.md
  // for the new value (the wording after the version number is free
  // — only the heading shape is checked).
  const changelog = await readFile(join(repoRoot, 'CHANGELOG.md'), 'utf-8');
  const heading = new RegExp(`^## v${APP_VERSION}\\b`, 'm');
  assert.match(changelog, heading,
    `CHANGELOG.md is missing a "## v${APP_VERSION}" heading. ` +
    `If you bumped APP_VERSION, add an entry describing the change.`);
});

test('CHANGELOG.md keeps the v1 heading too (history is append-only)', async () => {
  // The CHANGELOG accumulates — never delete past entries when bumping.
  // This test exists so a "tidy up" PR doesn't accidentally lose the
  // historical record.
  const changelog = await readFile(join(repoRoot, 'CHANGELOG.md'), 'utf-8');
  assert.match(changelog, /^## v1\b/m,
    'CHANGELOG.md must keep the v1 heading (append-only history)');
});
