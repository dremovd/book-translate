#!/usr/bin/env node
// One-shot renderer: read an A/B alignment artifact (produced by
// scripts/build-abtest.mjs) and emit a 3-column .docx file
// (A | B | source). Native Word output — no pandoc dependency. Built
// with Node's zlib and a hand-rolled minimal ZIP+OOXML writer.
//
// Layout — mirrors the bilingual editor's per-paragraph rows but with
// 3 columns instead of 2:
//   - Source and A are paragraph-aligned 1:1 by construction (the
//     artifact's `aText` is the user's translation of `source` for
//     the same paragraph range).
//   - Within each block, A↔B paragraphs are aligned range-to-range
//     via POE (default model gpt-5.5). Each aligned (A range, B range)
//     pair becomes one row; the matching source range (taken from A's
//     range, since source↔A is 1:1) sits in the third cell.
//   - Paragraphs the aligner doesn't pair (a B-only insertion, a
//     dropped A paragraph) get their own row with the other side
//     blank — the missing side is its own visual cue.
//   - No cell borders, no merged cells: every row has three side-by-
//     side cells, so range-to-range matches line up across columns.
//
// Highlighting:
//   - After alignment, send every paired (A, B) range to the same
//     POE endpoint (default model gpt-5.5) and ask for the top
//     fraction (default 10 %) where the translations diverge most.
//     Cheap word-level metrics (Jaccard etc.) miss meaning-level
//     divergences and overweight word-order shuffles, so we let the
//     model judge.
//   - Top fraction get bright-yellow cell shading on all three cells.
//   - Rows where one side is empty are not eligible for highlighting.
//
// Usage:
//   node scripts/abtest-to-3col-docx.mjs <input.json> <output.docx> \
//     [--source-label "English"] [--a-label "Russian A"] [--b-label "Russian B"] \
//     [--highlight-top 0.10] [--align-model gpt-5.5] [--scorer-model gpt-5.5] \
//     [--align-concurrency 10]
//
// Reads POE_API_KEY from .env at the repo root. Both the alignment
// and the scoring calls use the gpt-5.5 bot by default; override
// independently with --align-model / --scorer-model.

import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

// ---------- argv ----------
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
const [inPath, outPath] = positional;
if (!inPath || !outPath) {
  console.error('Usage: abtest-to-3col-docx.mjs <input.json> <output.docx> [options]');
  process.exit(1);
}
const SOURCE_LABEL  = args['source-label'] || 'Source';
const A_LABEL       = args['a-label']      || 'A';
const B_LABEL       = args['b-label']      || 'B';
const HIGHLIGHT_TOP = Number(args['highlight-top'] ?? 0.10);
const ALIGN_MODEL   = args['align-model']  || 'gpt-5.5';
const SCORER_MODEL  = args['scorer-model'] || 'gpt-5.5';
const ALIGN_CONCURRENCY = Number(args['align-concurrency'] ?? 10);
const POE_BASE_URL  = args['base-url']     || 'https://api.poe.com/v1';
// Bright but readable highlighter yellow (Material yellow A200, the
// classic Word highlighter shade — saturated enough to spot, light
// enough to read black text over).
const HIGHLIGHT_FILL = 'FFEB3B';

function splitParas(text) {
  return String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
}

// Promise.all with a concurrency cap. Preserves input index. The async
// callback receives (item, index).
async function mapBatched(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    await Promise.all(batch.map((item, j) => fn(item, i + j)));
  }
}

// Ask the aligner model to match A-paragraph ranges with B-paragraph
// ranges within ONE block. Returns 0-based, inclusive [{aStart, aEnd,
// bStart, bEnd}, …]. Throws on transport / parse failure — caller
// decides whether to fall back.
async function alignABViaPoe(aParas, bParas, { model, baseUrl, apiKey }) {
  const aText = aParas.map((t, i) => `[A${i + 1}] ${t}`).join('\n\n');
  const bText = bParas.map((t, i) => `[B${i + 1}] ${t}`).join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        `You align paragraph intervals between two translations of the same source — A and B. ` +
        `The match may not be 1-to-1: a single B paragraph can correspond to several A paragraphs (B condensed) and vice versa. Match interval-to-interval, covering every A and B paragraph that has a clear counterpart, in order.\n\n` +
        `If a stretch of B has no A counterpart (translator-invented, dropped, or unrelated), omit it; same for A. Do not overlap intervals.\n\n` +
        `Output ONLY a JSON array of {"aStart": N, "aEnd": N, "bStart": M, "bEnd": M} entries, in order. All indices are 1-based and inclusive. No prose, no code fences.`,
    },
    {
      role: 'user',
      content:
        `A paragraphs (A1..A${aParas.length}):\n\n${aText}\n\n---\n\n` +
        `B paragraphs (B1..B${bParas.length}):\n\n${bText}`,
    },
  ];
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.1 }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`POE API ${r.status}: ${body.slice(0, 400)}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Unexpected POE response shape');
  const stripped = content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const first = stripped.indexOf('[');
  const last  = stripped.lastIndexOf(']');
  if (first < 0 || last <= first) throw new Error(`Aligner did not return a JSON array; got: ${content.slice(0, 200)}`);
  const arr = JSON.parse(stripped.slice(first, last + 1));
  if (!Array.isArray(arr)) throw new Error('Aligner response is not an array');
  const out = [];
  for (const e of arr) {
    const aStart = Number(e?.aStart) - 1;
    const aEnd   = Number(e?.aEnd)   - 1;
    const bStart = Number(e?.bStart) - 1;
    const bEnd   = Number(e?.bEnd)   - 1;
    if (![aStart, aEnd, bStart, bEnd].every(Number.isInteger)) continue;
    if (aStart < 0 || bStart < 0) continue;
    if (aEnd >= aParas.length || bEnd >= bParas.length) continue;
    if (aEnd < aStart || bEnd < bStart) continue;
    out.push({ aStart, aEnd, bStart, bEnd });
  }
  return out;
}

// Turn a single artifact block + its A↔B intervals into the rows that
// will appear in the docx. Rules:
//   - Each interval becomes one row: source range (taken from A's
//     range — A is index-aligned to source), A range, B range.
//   - Any A paragraph not covered by an interval gets its own row
//     (with its source counterpart, B blank).
//   - Any B paragraph not covered gets its own row (source and A blank).
//   - Trailing source paragraphs past A's coverage (rare — A truncated)
//     get source-only rows.
//   - When `intervals` is null/empty (alignment skipped or failed),
//     fall back to the old per-index pairing so the row stream still
//     covers the block.
function buildAlignedRows(srcParas, aParas, bParas, intervals) {
  if (!intervals || intervals.length === 0) {
    const n = Math.max(srcParas.length, aParas.length, bParas.length);
    if (n === 0) return [];
    if (n === 1) {
      return [{
        source: srcParas.join('\n\n'),
        a:      aParas.join('\n\n'),
        b:      bParas.join('\n\n'),
      }];
    }
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        source: srcParas[i] || '',
        a:      aParas[i]   || '',
        b:      bParas[i]   || '',
      });
    }
    return rows;
  }
  // Sort intervals; drop any that overlap a previous interval (defensive
  // — the model is prompted not to overlap, but we'd rather skip a
  // duplicate row than emit garbled output).
  const sorted = intervals.slice().sort((x, y) =>
    (x.aStart - y.aStart) || (x.bStart - y.bStart));
  const safe = [];
  let lastA = -1, lastB = -1;
  for (const iv of sorted) {
    if (iv.aStart <= lastA || iv.bStart <= lastB) continue;
    safe.push(iv);
    lastA = iv.aEnd;
    lastB = iv.bEnd;
  }
  const join = (arr, s, e) => arr.slice(s, e + 1).filter(Boolean).join('\n\n');
  const rows = [];
  let aPtr = 0, bPtr = 0;
  for (const iv of safe) {
    while (aPtr < iv.aStart) {
      rows.push({
        source: srcParas[aPtr] || '',
        a:      aParas[aPtr],
        b:      '',
      });
      aPtr++;
    }
    while (bPtr < iv.bStart) {
      rows.push({ source: '', a: '', b: bParas[bPtr] });
      bPtr++;
    }
    const sLast = Math.min(iv.aEnd, srcParas.length - 1);
    rows.push({
      source: join(srcParas, iv.aStart, sLast),
      a:      join(aParas,   iv.aStart, iv.aEnd),
      b:      join(bParas,   iv.bStart, iv.bEnd),
    });
    aPtr = iv.aEnd + 1;
    bPtr = iv.bEnd + 1;
  }
  while (aPtr < aParas.length) {
    rows.push({
      source: srcParas[aPtr] || '',
      a:      aParas[aPtr],
      b:      '',
    });
    aPtr++;
  }
  while (bPtr < bParas.length) {
    rows.push({ source: '', a: '', b: bParas[bPtr] });
    bPtr++;
  }
  for (let s = aParas.length; s < srcParas.length; s++) {
    rows.push({ source: srcParas[s], a: '', b: '' });
  }
  return rows;
}

// Ask the scorer model to identify the top-K most-divergent (A, B)
// pairs out of a numbered batch. Returns a Set of 0-based indices into
// the input array. Fails loudly — caller decides whether to fall back.
async function scoreDivergencesViaPoe(pairs, topK, { model, baseUrl, apiKey }) {
  const numbered = pairs.map((p, i) =>
    `[${i + 1}]\nA: ${p.a}\nB: ${p.b}`
  ).join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        `You compare two translations of the same source text. ` +
        `For ${pairs.length} numbered (A, B) paragraph pairs below, identify the ${topK} pairs ` +
        `where A and B diverge MOST in meaning, register, or style — different word choice, ` +
        `restructured sentences, missed or added nuance, mistranslation. Word-order shuffles ` +
        `or simple synonym swaps DO NOT count as divergence; surface only meaningful differences. ` +
        `Output ONLY a JSON array of exactly ${topK} 1-based indices, no prose, no code fences.`
    },
    { role: 'user', content: numbered },
  ];
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.1 }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`POE API ${r.status}: ${body.slice(0, 400)}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Unexpected POE response shape');
  const stripped = content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const first = stripped.indexOf('[');
  const last  = stripped.lastIndexOf(']');
  if (first < 0 || last <= first) throw new Error(`Scorer did not return a JSON array; got: ${content.slice(0, 200)}`);
  const arr = JSON.parse(stripped.slice(first, last + 1));
  if (!Array.isArray(arr)) throw new Error('Scorer response is not an array');
  const out = new Set();
  for (const v of arr) {
    const idx = Number(v) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < pairs.length) out.add(idx);
  }
  return out;
}

// ---------- env (needed by both alignment and scorer calls) ----------
const env = await readFile('.env', 'utf8').catch(() => '');
const apiKey = (env.match(/^POE_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!apiKey) {
  console.error('error: no POE_API_KEY in .env (needed by the alignment + scorer calls).');
  process.exit(1);
}

// ---------- align A↔B paragraphs into ranges, then expand each block into rows ----------
const artifact = JSON.parse(await readFile(inPath, 'utf8'));
const blocks = artifact.blocks || [];
console.error(`Aligning A↔B paragraphs in ${blocks.length} blocks via POE/${ALIGN_MODEL} (concurrency ${ALIGN_CONCURRENCY})…`);
const tAlign = Date.now();
const blockRows = new Array(blocks.length);
let alignedViaApi = 0, alignSkipped = 0, alignFailed = 0, alignProgress = 0;
await mapBatched(blocks, ALIGN_CONCURRENCY, async (block, i) => {
  const srcParas = splitParas(block.source);
  const aParas   = splitParas(block.aText);
  const bParas   = splitParas(block.bText);
  // Trivial: at most one paragraph on each side, alignment is unambiguous.
  // Also bail out when one side is empty — there's nothing to align.
  const skipApi = (aParas.length <= 1 && bParas.length <= 1) ||
                  aParas.length === 0 || bParas.length === 0;
  if (skipApi) {
    blockRows[i] = buildAlignedRows(srcParas, aParas, bParas, null);
    alignSkipped++;
  } else {
    let intervals = null;
    try {
      intervals = await alignABViaPoe(aParas, bParas, {
        model: ALIGN_MODEL, baseUrl: POE_BASE_URL, apiKey,
      });
      alignedViaApi++;
    } catch (e) {
      alignFailed++;
      console.error(`\n  ! block ${i + 1} alignment failed: ${e.message} — falling back to per-index pairing`);
    }
    blockRows[i] = buildAlignedRows(srcParas, aParas, bParas, intervals);
  }
  alignProgress++;
  process.stderr.write(`\r  ${alignProgress}/${blocks.length} done (api=${alignedViaApi}, trivial=${alignSkipped}${alignFailed ? `, failed=${alignFailed}` : ''})…   `);
});
process.stderr.write('\n');
console.error(`  alignment: ${alignedViaApi} via API, ${alignSkipped} trivial${alignFailed ? `, ${alignFailed} failed` : ''} in ${((Date.now() - tAlign) / 1000).toFixed(1)}s`);
const rows = blockRows.flat();
console.error(`  produced ${rows.length} rows total`);

// ---------- ask the scorer model to mark the most-divergent rows ----------
const eligible = [];
for (let i = 0; i < rows.length; i++) {
  if (rows[i].a && rows[i].b) eligible.push({ rowIdx: i, a: rows[i].a, b: rows[i].b });
}
const targetCount = Math.max(1, Math.round(eligible.length * HIGHLIGHT_TOP));
console.error(`Scoring ${eligible.length} paired rows via POE/${SCORER_MODEL} for top ${targetCount} (≈${(HIGHLIGHT_TOP * 100).toFixed(0)}%)…`);
const tScore = Date.now();
const winners = await scoreDivergencesViaPoe(eligible, targetCount, {
  model: SCORER_MODEL, baseUrl: POE_BASE_URL, apiKey,
});
console.error(`  scorer returned ${winners.size} indices in ${((Date.now() - tScore) / 1000).toFixed(1)}s`);
let highlighted = 0;
for (let i = 0; i < eligible.length; i++) {
  if (winners.has(i)) {
    rows[eligible[i].rowIdx].highlight = true;
    highlighted++;
  }
}

// ---------- OOXML builders ----------
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// Word run: a <w:r> with optional run-properties (bold, size in
// half-points, color in RRGGBB) and one or more <w:t> with literal
// newlines turned into <w:br/> within the same paragraph.
function wRun(text, { bold = false, size = null, color = null } = {}) {
  const rpr = [];
  if (bold) rpr.push('<w:b/>');
  if (size != null) rpr.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  if (color) rpr.push(`<w:color w:val="${color}"/>`);
  const rPrXml = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  const parts = String(text ?? '').split('\n');
  const runs = parts.map((p, i) => {
    const seg = `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r>`;
    return i < parts.length - 1 ? seg + '<w:r>' + rPrXml + '<w:br/></w:r>' : seg;
  });
  return runs.join('');
}
function wPara(text, runOpts = {}) {
  return `<w:p>${wRun(text, runOpts)}</w:p>`;
}
function wParaMulti(paragraphs, runOpts = {}) {
  return paragraphs.map(p => wPara(p, runOpts)).join('');
}
// Word cell: tcPr block then content (paragraphs).
function wCell(contentXml, { widthDxa = null, fillRRGGBB = null, vMerge = null } = {}) {
  const tcPr = [];
  if (widthDxa != null) tcPr.push(`<w:tcW w:w="${widthDxa}" w:type="dxa"/>`);
  if (fillRRGGBB) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fillRRGGBB}"/>`);
  if (vMerge === 'restart') tcPr.push('<w:vMerge w:val="restart"/>');
  if (vMerge === 'continue') tcPr.push('<w:vMerge/>');
  const tcPrXml = tcPr.length ? `<w:tcPr>${tcPr.join('')}</w:tcPr>` : '';
  // Word requires every cell to contain at least one paragraph.
  const body = contentXml || '<w:p/>';
  return `<w:tc>${tcPrXml}${body}</w:tc>`;
}

// Column widths in twentieths-of-a-point (dxa). Equal-sized columns
// (3 × 3000 ≈ 9000 ≈ printable page width on Letter/A4 with default
// margins).
const COL_A_DXA = 3000;
const COL_B_DXA = 3000;
const COL_S_DXA = 3000;

const tblPr =
  '<w:tblPr>' +
    '<w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblBorders>' +
      '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/>' +
      '<w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>' +
    '</w:tblBorders>' +
    '<w:tblCellMar>' +
      '<w:top w:w="60" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>' +
      '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="120" w:type="dxa"/>' +
    '</w:tblCellMar>' +
  '</w:tblPr>';
const tblGrid =
  `<w:tblGrid>` +
    `<w:gridCol w:w="${COL_A_DXA}"/>` +
    `<w:gridCol w:w="${COL_B_DXA}"/>` +
    `<w:gridCol w:w="${COL_S_DXA}"/>` +
  `</w:tblGrid>`;

const headerRow =
  '<w:tr>' +
    wCell(wPara(A_LABEL,      { bold: true }), { widthDxa: COL_A_DXA }) +
    wCell(wPara(B_LABEL,      { bold: true }), { widthDxa: COL_B_DXA }) +
    wCell(wPara(SOURCE_LABEL, { bold: true }), { widthDxa: COL_S_DXA }) +
  '</w:tr>';

// Highlighted rows shade ALL three cells (A, B, source) — diverging
// rows should pop equally everywhere they're shown.
const bodyRowsXml = rows.map(r => {
  const fill = r.highlight ? HIGHLIGHT_FILL : null;
  const aCell = wCell(wPara(r.a),      { widthDxa: COL_A_DXA, fillRRGGBB: fill });
  const bCell = wCell(wPara(r.b),      { widthDxa: COL_B_DXA, fillRRGGBB: fill });
  const sCell = wCell(wPara(r.source), { widthDxa: COL_S_DXA, fillRRGGBB: fill });
  return `<w:tr>${aCell}${bCell}${sCell}</w:tr>`;
}).join('');

const summary =
  `Built ${artifact.builtAt || '(unknown)'} via ${artifact.model || 'unknown model'}; ` +
  `A↔B aligned by ${ALIGN_MODEL}, divergence scored by ${SCORER_MODEL}. ` +
  `${blocks.length} blocks → ${rows.length} aligned rows; ` +
  `${highlighted} highlighted (top ${(HIGHLIGHT_TOP * 100).toFixed(1)}% of paired rows).`;

const documentXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
      wPara(`Three-way comparison — ${artifact.label || artifact.id}`, { bold: true, size: 32 }) +
      wPara(summary, { size: 18, color: '666666' }) +
      `<w:tbl>${tblPr}${tblGrid}${headerRow}${bodyRowsXml}</w:tbl>` +
      // Required final sectPr — page size, margins.
      '<w:sectPr>' +
        '<w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"/>' +
      '</w:sectPr>' +
    '</w:body>' +
  '</w:document>';

// ---------- ZIP / docx package writer ----------
const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32._t = table;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const local = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);    // utf-8 names
    lh.writeUInt16LE(8, 8);          // deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);      // 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(off, 42);
    central.push(cd, name);
    off += lh.length + name.length + compressed.length;
  }
  const cdAll = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdAll.length, 12);
  eocd.writeUInt32LE(off, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cdAll, eocd]);
}

const zip = buildZip([
  { path: '[Content_Types].xml',   data: CONTENT_TYPES_XML },
  { path: '_rels/.rels',           data: ROOT_RELS_XML },
  { path: 'word/document.xml',     data: documentXml },
]);
await writeFile(outPath, zip);
console.error(`Wrote ${outPath} (${(zip.length / 1024).toFixed(1)} KiB) — ${rows.length} rows, ${highlighted} highlighted (~${(highlighted / Math.max(1, eligible.length) * 100).toFixed(1)}%).`);
