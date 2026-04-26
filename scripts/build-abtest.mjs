#!/usr/bin/env node
// Offline tool. Builds a self-contained A/B alignment JSON for the abtest
// view to consume — runs the two-phase POE alignment using credentials
// from .env at the repo root, then writes
// `samples/abtest-<id>.json` with the matched blocks pre-built.
//
// Usage:
//   node scripts/build-abtest.mjs \
//     --id munchausen \
//     --label "Munchausen — yours vs Chukovsky" \
//     --source samples/munchausen.md \
//     --a samples/translation-through-chapter-016.md \
//     --b /tmp/munchausen-ru-classical.txt \
//     --b-format plain
//
// Optional:
//   --b-url <url>      fetch B from URL (skips --b file)
//   --concurrency 10   POE concurrency for paragraph alignment
//   --max-chapters N   stop after this many B chapters (debug)
//   --source-chapters N-M    restrict source/A to a 1-based inclusive
//                            range (lockstep — they're index-aligned)
//   --b-chapters N-M         restrict B to a 1-based inclusive range
//
// Path resolution: --source/--a/--b accept either repo-relative or
// absolute paths. Source files outside the repo are read as-is and the
// artifact records the original path verbatim.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), '..');

import { parseBook } from '../js/parse.js';
import { PoeTranslator } from '../js/translators/poe.js';
import {
  plainTextToMarkdown, buildAlignmentBlocks, sliceChaptersInBook,
} from '../js/abtest.js';

// ---------- argv ----------
const args = parseArgs(process.argv.slice(2));
const id        = required(args.id, 'id');
const label     = required(args.label, 'label');
const sourcePath = required(args.source, 'source');
const aPath      = required(args.a, 'a');
const bPath      = args.b;
const bUrl       = args['b-url'];
const bFormat    = args['b-format'] || 'auto'; // 'plain' | 'markdown' | 'auto'
const concurrency = Number(args.concurrency || 10);
const maxChapters = args['max-chapters'] ? Number(args['max-chapters']) : Infinity;
const sourceRange = args['source-chapters'] || null;
const bRange      = args['b-chapters'] || null;

if (!bPath && !bUrl) die('Need either --b <path> or --b-url <url>');

// ---------- env ----------
const env = await readFile(`${REPO}/.env`, 'utf8');
const apiKey = (env.match(/^POE_API_KEY=(.+)$/m) || [])[1]?.trim();
const model  = (env.match(/^POE_MODEL=(.+)$/m)   || [])[1]?.trim() || 'gemini-3.1-pro';
if (!apiKey) die('No POE_API_KEY in .env');
log(`Model: ${model}`);

// ---------- inputs ----------
log(`Reading source: ${sourcePath}`);
const sourceMd = await readFile(resolveInput(sourcePath), 'utf8');
let sourceBook = parseBook(sourceMd);
log(`  ${sourceBook.chapters.length} chapters`);

log(`Reading A: ${aPath}`);
const aMd = await readFile(resolveInput(aPath), 'utf8');
let aBook = parseBook(aMd);
log(`  ${aBook.chapters.length} chapters`);

let bRaw, bFormatResolved = bFormat;
if (bUrl) {
  log(`Fetching B from URL: ${bUrl}`);
  const r = await fetch(bUrl);
  if (!r.ok) die(`Fetching B: HTTP ${r.status}`);
  bRaw = await r.text();
} else {
  log(`Reading B: ${bPath}`);
  bRaw = await readFile(resolveInput(bPath), 'utf8');
}
if (bFormatResolved === 'auto') {
  bFormatResolved = looksLikeMarkdown(bRaw) ? 'markdown' : 'plain';
  log(`  detected format: ${bFormatResolved}`);
}
const bMd = bFormatResolved === 'plain' ? plainTextToMarkdown(bRaw) : bRaw;
let bBook = parseBook(bMd);
log(`  ${bBook.chapters.length} chapters`);

if (bBook.chapters.length === 0) die('B parsed to zero chapters — check input format.');

// ---------- chapter-range trimming ----------
// `--source-chapters N-M` trims SOURCE and A in lockstep (they're
// already index-aligned: A[i] is the user's translation of SOURCE[i],
// so the trim preserves that correspondence). `--b-chapters` trims B
// independently.
if (sourceRange) {
  sourceBook = sliceChaptersInBook(sourceBook, sourceRange);
  aBook      = sliceChaptersInBook(aBook,      sourceRange);
  log(`  source/A trimmed to chapters ${sourceRange}: ${sourceBook.chapters.length} / ${aBook.chapters.length} chapters`);
}
if (bRange) {
  bBook = sliceChaptersInBook(bBook, bRange);
  log(`  B trimmed to chapters ${bRange}: ${bBook.chapters.length} chapters`);
}

// ---------- alignment ----------
const t = new PoeTranslator({
  apiKey, model, baseUrl: 'https://api.poe.com/v1', dictionaryModel: model,
});

log('\nPhase 1: chapter alignment …');
const tCh = Date.now();
const chapterMap = await t.alignChapters(sourceBook, bBook);
log(`  ${chapterMap.length} B chapters mapped in ${secs(Date.now() - tCh)}s`);
for (const m of chapterMap.slice(0, 8)) {
  const bTitle = bBook.chapters[m.bChapterIdx]?.title || '?';
  const sTitles = m.sourceChapterIndices.map(i => sourceBook.chapters[i]?.title || '?');
  log(`    B"${bTitle}" → [${sTitles.join(', ')}]`);
}
if (chapterMap.length > 8) log(`    … and ${chapterMap.length - 8} more`);

// Build the work list — one (B chapter × source chapter) pair per call.
// Skip pairs where the source chapter is past A's coverage (no A text to compare).
const work = [];
for (const m of chapterMap) {
  if (m.bChapterIdx >= maxChapters) break;
  for (const sCh of m.sourceChapterIndices) {
    if (sCh >= aBook.chapters.length) continue;
    work.push({ bChapterIdx: m.bChapterIdx, sourceChapterIdx: sCh });
  }
}
log(`\nPhase 2: paragraph alignment — ${work.length} (B,source) pairs, concurrency ${concurrency}`);

const intervalsPerBChapter = {};
let done = 0;
const tPa = Date.now();
await mapBatched(work, concurrency, async ({ bChapterIdx, sourceChapterIdx }) => {
  const bCh = bBook.chapters[bChapterIdx];
  const sCh = sourceBook.chapters[sourceChapterIdx];
  if (!bCh || !sCh) return;
  const sourceParas = sCh.paragraphs.map((p, i) => ({ paragraphIdx: i, text: p.original }));
  const bParas      = bCh.paragraphs.map((p, i) => ({ paragraphIdx: i, text: p.original }));
  let intervals = [];
  try {
    intervals = await t.alignParagraphsInChapter(sourceParas, bParas);
  } catch (e) {
    log(`  ! pair B${bChapterIdx + 1} ↔ S${sourceChapterIdx + 1} failed: ${e.message}`);
  }
  done++;
  process.stderr.write(`\r  ${done}/${work.length} done…   `);
  if (!intervalsPerBChapter[bChapterIdx]) intervalsPerBChapter[bChapterIdx] = [];
  for (const iv of intervals) {
    intervalsPerBChapter[bChapterIdx].push({
      bStart: iv.bStart, bEnd: iv.bEnd,
      sourceChapterIdx,
      sStart: iv.sStart, sEnd: iv.sEnd,
    });
  }
});
process.stderr.write('\n');
log(`  done in ${secs(Date.now() - tPa)}s`);

// ---------- build blocks ----------
const blocks = buildAlignmentBlocks(sourceBook, aBook, bBook, intervalsPerBChapter);
log(`\nProduced ${blocks.length} aligned A/B blocks.`);

// ---------- write ----------
const outPath = `samples/abtest-${id}.json`;
const artifact = {
  id, label,
  builtAt: new Date().toISOString(),
  model,
  source: { path: sourcePath, chapters: sourceBook.chapters.length },
  a:      { path: aPath,      chapters: aBook.chapters.length },
  b:      bUrl ? { url: bUrl } : { path: bPath },
  bFormat: bFormatResolved,
  stats: {
    chapterMapEntries: chapterMap.length,
    paragraphAlignmentPairs: work.length,
    blocks: blocks.length,
  },
  blocks,
};
await writeFile(`${REPO}/${outPath}`, JSON.stringify(artifact, null, 2), 'utf8');
log(`Wrote ${outPath} (${humanBytes(JSON.stringify(artifact).length)})`);

// ---------- helpers ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}
function required(v, name) { if (!v || v === true) die(`Missing --${name}`); return v; }
function resolveInput(p) { return isAbsolute(p) ? p : `${REPO}/${p}`; }
function die(msg) { console.error('error:', msg); process.exit(1); }
function log(msg) { console.error(msg); }
function secs(ms) { return (ms / 1000).toFixed(1); }
function humanBytes(n) { return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`; }
function looksLikeMarkdown(t) { return /^#\s+/m.test(t); }

async function mapBatched(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    await Promise.all(batch.map(fn));
  }
}
