// Pure helpers for the A/B translation comparison view.
// Anything that touches the network or DOM lives in component.js or
// translators/poe.js — these are testable in plain Node.

// Registry of pre-built alignment artifacts the abtest page can load.
// Each entry's `path` points to a JSON produced by scripts/build-abtest.mjs.
// Add a new entry here when a new alignment artifact is committed.
// Currently HPMOR-only; the standalone page (abtest.html) loads ABTESTS[0].
export const ABTESTS = [
  {
    id: 'hpmor',
    label: 'HPMOR ch1-3 — yours vs. hpmor.ru fan translation',
    path: 'samples/abtest-hpmor.json',
  },
];

// Random sample of n items from arr, without replacement (Fisher-Yates).
// Returns up to n items (fewer if arr.length < n). Pure given an injected rng.
export function pickRandomSample(arr, n, rng = Math.random) {
  const a = arr.slice();
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// For each pair, randomly decide whether the on-screen "A" slot shows the
// underlying aText (swapped=false) or bText (swapped=true). The rater
// picks a slot label; tallyAbResults below corrects for the swap.
export function assignSwaps(pairs, rng = Math.random) {
  return pairs.map(p => ({ ...p, swapped: rng() < 0.5 }));
}

// Convert "rater picked slot A/B/tie" choices to actual A/B win counts,
// correcting for per-pair swap. `pairs[i].swapped` must be the same value
// that was used to render the pair to the rater.
//   choice 'a' → rater picked the slot labeled A
//   choice 'b' → rater picked the slot labeled B
//   choice 'tie' → rater couldn't pick
//   choice null/undefined → unrated (skipped)
export function tallyAbResults(pairs, choices) {
  let aWins = 0, bWins = 0, ties = 0;
  for (let i = 0; i < pairs.length; i++) {
    const c = choices[i];
    if (!c) continue;
    if (c === 'tie') { ties++; continue; }
    // aWins iff (rater picked A) XOR (slot A was actually B-text)
    if ((c === 'a') !== !!pairs[i].swapped) aWins++;
    else bWins++;
  }
  return { aWins, bWins, ties };
}

// Heuristic plain-text → Markdown converter. A line that is all uppercase
// (Cyrillic or Latin), short (<80 chars), and surrounded by blank lines
// is treated as a chapter heading and rewritten as `# Title` in
// sentence-case. Indented body lines have their leading whitespace
// stripped. Paragraph blanks are preserved.
//
// This is "good enough for plain-text imports of Russian classics" — it
// handles the typical e-book layout where chapter titles are ALL CAPS on
// their own line.
export function plainTextToMarkdown(text) {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    if (!s) { out.push(''); continue; }
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
    if (isAllCapsHeadingLine(s) && prevBlank && nextBlank && s.length <= 80) {
      out.push('# ' + sentenceCase(s));
      continue;
    }
    out.push(s);
  }
  // Collapse runs of blank lines to one blank.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isAllCapsHeadingLine(s) {
  // Must contain at least one Cyrillic OR Latin uppercase letter, and
  // contain NO lowercase letters of either alphabet.
  const hasUpper = /[A-ZА-ЯЁ]/.test(s);
  const hasLower = /[a-zа-яё]/.test(s);
  return hasUpper && !hasLower;
}

function sentenceCase(s) {
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Turn the LLM's per-B-chapter interval matchings into the actual A/B
// test items: each item concatenates a source-paragraph range, the
// matching A-paragraph range (A is index-aligned to source), and the
// matching B-paragraph range. Drops items where any side is empty or
// out of bounds.
//
// intervalsPerBChapter:
//   { [bChapterIdx]: [{ bStart, bEnd, sourceChapterIdx, sStart, sEnd }, …] }
//   indices are inclusive 0-based.
//
// Returns: [{ source, aText, bText, label }].
export function buildAlignmentBlocks(sourceBook, aBook, bBook, intervalsPerBChapter) {
  const out = [];
  for (const [bChIdxStr, intervals] of Object.entries(intervalsPerBChapter || {})) {
    const bChIdx = Number(bChIdxStr);
    const bCh = bBook?.chapters?.[bChIdx];
    if (!bCh || !Array.isArray(intervals)) continue;
    for (const iv of intervals) {
      const sCh = iv?.sourceChapterIdx;
      const sourceCh = sourceBook?.chapters?.[sCh];
      const aCh = aBook?.chapters?.[sCh];
      if (!sourceCh || !aCh) continue;
      const sStart = clampRange(iv.sStart, sourceCh.paragraphs.length);
      const sEnd   = clampRange(iv.sEnd,   sourceCh.paragraphs.length);
      const bStart = clampRange(iv.bStart, bCh.paragraphs.length);
      const bEnd   = clampRange(iv.bEnd,   bCh.paragraphs.length);
      if (sStart === null || sEnd === null || bStart === null || bEnd === null) continue;
      if (sEnd < sStart || bEnd < bStart) continue;
      const aLen = aCh.paragraphs.length;
      if (sStart >= aLen) continue; // A doesn't cover this source paragraph yet.
      const aSliceEnd = Math.min(sEnd, aLen - 1);
      const sourceText = joinRange(sourceCh.paragraphs, sStart, sEnd);
      const aText      = joinRange(aCh.paragraphs,      sStart, aSliceEnd);
      const bText      = joinRange(bCh.paragraphs,      bStart, bEnd);
      if (!sourceText || !aText || !bText) continue;
      out.push({
        source: sourceText,
        aText, bText,
        label: `${sourceCh.title}  · B ch ${bChIdx + 1}, ¶${bStart + 1}-${bEnd + 1}`,
      });
    }
  }
  return out;
}

function clampRange(n, len) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < 0 || v >= len) return null;
  return v;
}
function joinRange(paragraphs, start, end) {
  return paragraphs
    .slice(start, end + 1)
    .map(p => (p?.original || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// Take a 1-based inclusive range string ("3-5") and return a copy of the
// book with only those chapters. Used by the offline build script to scope
// alignment to a sub-range of source/A/B (e.g. "chapters 1-3 of HPMOR
// without prefaces"). Returns a defensive shallow copy when range is
// undefined so callers can safely keep mutating their input.
export function sliceChaptersInBook(book, range) {
  const chapters = (book?.chapters || []).slice();
  if (range == null) return { ...(book || {}), chapters };
  const m = String(range).match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) throw new Error(`Bad chapter range: "${range}" (expected "N-M", 1-based inclusive)`);
  const start = Number(m[1]) - 1;
  const end   = Number(m[2]) - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error(`Bad chapter range: "${range}"`);
  }
  return { ...(book || {}), chapters: chapters.slice(start, end + 1) };
}
