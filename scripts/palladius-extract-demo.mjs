#!/usr/bin/env node
// One-shot demo: extract proper-noun terms from a pure-Chinese .md
// file via the POE dictionary-extraction phase, then run them through
// the offline Palladius pipeline (pinyin-pro + js/palladius.js) for
// canonical Russian transliteration. Prints a table.
//
// In Node we don't have pinyin-pro installed (the project is
// no-build-step, no package.json), so we fetch the UMD from jsdelivr
// once, cache to /tmp, and eval it to populate globalThis.pinyinPro —
// matching what the browser's <script> tag does.
//
// Usage:
//   node scripts/palladius-extract-demo.mjs <input.md> [--max-terms 30]
//
// Reads POE_API_KEY (and optional POE_MODEL) from .env at the repo root.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), '..');

const PINYIN_PRO_VERSION = '3.28.1';
const PINYIN_PRO_URL = `https://cdn.jsdelivr.net/npm/pinyin-pro@${PINYIN_PRO_VERSION}/dist/index.js`;
const PINYIN_PRO_CACHE = `/tmp/pinyin-pro-${PINYIN_PRO_VERSION}.umd.js`;

async function loadPinyinPro() {
  let exists = false;
  try { await stat(PINYIN_PRO_CACHE); exists = true; } catch {}
  if (!exists) {
    console.error(`Downloading pinyin-pro@${PINYIN_PRO_VERSION} from jsdelivr…`);
    const r = await fetch(PINYIN_PRO_URL);
    if (!r.ok) throw new Error(`Failed to fetch pinyin-pro: HTTP ${r.status}`);
    await writeFile(PINYIN_PRO_CACHE, await r.text(), 'utf8');
  }
  const code = await readFile(PINYIN_PRO_CACHE, 'utf8');
  // The UMD self-attaches to `globalThis.pinyinPro`. Run in the
  // current realm so `globalThis` is the same object the rest of the
  // script sees.
  vm.runInThisContext(code, { filename: PINYIN_PRO_CACHE });
  if (typeof globalThis.pinyinPro?.pinyin !== 'function') {
    throw new Error('pinyin-pro UMD loaded but globalThis.pinyinPro.pinyin not exposed');
  }
}

await loadPinyinPro();

const { parseBook }            = await import('../js/parse.js');
const { PoeTranslator }        = await import('../js/translators/poe.js');
const { palladiusTransliterate, isMostlyCJK } = await import('../js/palladius.js');

const argv = process.argv.slice(2);
const args = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  } else positional.push(a);
}
const [inPath] = positional;
if (!inPath) {
  console.error('Usage: palladius-extract-demo.mjs <input.md> [--max-terms 30]');
  process.exit(1);
}
const MAX_TERMS = Number(args['max-terms'] || 30);

const env = await readFile(`${REPO}/.env`, 'utf8');
const apiKey = (env.match(/^POE_API_KEY=(.+)$/m) || [])[1]?.trim();
const model  = (env.match(/^POE_MODEL=(.+)$/m)   || [])[1]?.trim() || 'gemini-3.1-pro';
if (!apiKey) { console.error('No POE_API_KEY in .env'); process.exit(1); }

const md = await readFile(isAbsolute(inPath) ? inPath : `${REPO}/${inPath}`, 'utf8');
const book = parseBook(md);
console.error(`Parsed ${book.chapters.length} chapter(s) from ${inPath}`);

const t = new PoeTranslator({
  apiKey, model, baseUrl: 'https://api.poe.com/v1',
  targetLanguage: 'Russian',
});

// Use just the first chapter's first ~5 k chars to keep this fast & cheap.
const ch0 = book.chapters[0];
const sampleText = `# ${ch0.title}\n\n` +
  ch0.paragraphs.map(p => p.original).join('\n\n').slice(0, 5000);
console.error(`Extract sample: chapter "${ch0.title}", ${sampleText.length} chars`);
const t0 = Date.now();
const allTerms = await t._extractTerms(sampleText, 'Russian');
console.error(`  POE extracted ${allTerms.length} terms in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Filter to CJK-only terms (proper nouns we'd want Palladius for) and dedupe.
const cjkTerms = Array.from(new Set(allTerms.filter(isMostlyCJK))).slice(0, MAX_TERMS);
console.error(`  ${cjkTerms.length} CJK term(s) → offline Palladius (capped at ${MAX_TERMS})`);

const t1 = Date.now();
const map = await palladiusTransliterate(cjkTerms);
console.error(`  Palladius (offline) returned in ${((Date.now() - t1) / 1000).toFixed(2)}s`);

console.log();
console.log('| Term  | Palladius |');
console.log('| ----- | --------- |');
for (const term of cjkTerms) {
  const tr = map.get(term) || '(no result)';
  console.log(`| ${term} | ${tr} |`);
}
