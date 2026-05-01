// Shared helpers for translator backends that talk to a model over text:
// paragraph numbering, JSON-array parsing, dictionary normalization, chapter
// and dictionary rendering. Keep this module pure — no network, no `this`.

export function numberedParagraphs(paragraphs) {
  return paragraphs.map((p, i) => `[${i + 1}] ${p.original}`).join('\n\n');
}

export function parseNumberedParagraphs(content) {
  const map = new Map();
  const chunks = content.split(/\n(?=\s*\[\d+\])/);
  for (const chunk of chunks) {
    const m = chunk.match(/^\s*\[(\d+)\]\s*([\s\S]*)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const text = m[2].replace(/\s+$/, '').replace(/^\s+/, '');
    if (text) map.set(n, text);
  }
  return map;
}

// Given the original paragraphs and a map of parsed-by-number translations,
// produce paragraphs[] of the same length, aligned by index. Missing entries
// fall back to the original with `status: 'untranslated'` so the UI can flag
// them for the editor.
export function alignByIndex(originalParagraphs, parsedMap) {
  return originalParagraphs.map((p, i) => {
    const n = i + 1;
    const has = parsedMap.has(n);
    return {
      original: p.original,
      translation: has ? parsedMap.get(n) : p.original,
      status: has ? 'translated' : 'untranslated',
    };
  });
}

export function parseJsonArray(content) {
  const stripped = content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const first = stripped.indexOf('[');
  const last = stripped.lastIndexOf(']');
  const slice = first >= 0 && last > first ? stripped.slice(first, last + 1) : stripped;
  const arr = JSON.parse(slice);
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
  return arr;
}

export function normalizeDictionary(arr) {
  return arr.map(e => ({
    term: String(e?.term ?? '').trim(),
    translation: String(e?.translation ?? '').trim(),
    notes: String(e?.notes ?? '').trim(),
  })).filter(e => e.term);
}

export function chapterOriginalText(chapter) {
  return chapter.paragraphs.map(p => p.original).join('\n\n');
}

export function chapterTranslationText(chapter) {
  return chapter.paragraphs.map(p => p.translation).join('\n\n');
}

export function formatDictionary(dictionary) {
  if (!dictionary.length) return '(empty)';
  return dictionary
    .map(d => {
      // Bilingual entries carry `originalForm` — the canonical form in
      // the reference language (e.g. the Chinese characters when the
      // user's "original" side is English). Surface it before notes so
      // the model can pin canonical names without being confused by the
      // English transliteration's spelling.
      const parts = [];
      if (d.originalForm) parts.push(`originally ${d.originalForm}`);
      if (d.notes)        parts.push(d.notes);
      const tail = parts.length ? `  (${parts.join('; ')})` : '';
      return `- ${d.term} → ${d.translation}${tail}`;
    })
    .join('\n');
}

// Language-specific dialog-formatting guidance auto-injected into the
// translation system prompt. Keyed on the lowercased target language. An
// unknown language returns '' (no harm done).
//
// Why a hardcoded table: typographic conventions for direct speech are
// language-level facts that don't change project-to-project, and stuffing
// them into the prompt avoids the model defaulting to English-style
// "quotation marks" everywhere. Editors who want different conventions can
// still override via translationPromptCustom.
const DIALOG_CONVENTIONS = {
  russian:
    'Each speaker line starts with an em-dash (—) on a new line. ' +
    'Speaker tags inside a line are flanked by em-dashes, e.g. «— Привет, — сказал он, — как дела?». ' +
    'Do NOT use English-style "quotation marks" for spoken lines.',
  ukrainian:
    'Each speaker line starts with an em-dash (—) on a new line. ' +
    'Speaker tags inside a line are flanked by em-dashes. ' +
    'Do NOT use English-style "quotation marks" for spoken lines.',
  french:
    'Use guillemets («…») around spoken lines, with a non-breaking space inside the marks ' +
    '(« comme ceci »). When dialog continues across multiple turns within a paragraph, start each ' +
    'new speaker turn with an em-dash (—) on a new line.',
  german:
    'Use German-style „lower-and-upper" quotation marks for spoken lines (opening „, closing "). ' +
    'Reported speech inside dialog can use ›single guillemets‹.',
  spanish:
    'Each speaker line starts with an em-dash (—) on a new line. ' +
    'Speaker tags inside a line are flanked by em-dashes, e.g. «—Hola —dijo él—, ¿cómo estás?».',
  italian:
    'Use guillemets («…») around spoken lines — the standard convention in modern Italian publishing. ' +
    'When dialog continues across multiple speaker turns within a paragraph, start each new turn with an em-dash (—) on a new line.',
  polish:
    'Each speaker line starts with an em-dash (—) on a new line. ' +
    'Speaker tags use em-dashes around them, e.g. «— Cześć — powiedział — jak się masz?».',
  portuguese:
    'Each speaker line starts with an em-dash (—) on a new line. ' +
    'Reported speech inside dialog can use «guillemets».',
  dutch:
    'Use double curly quotation marks ("…") around spoken lines — the standard convention in modern Dutch publishing. ' +
    'For nested speech, use single curly quotation marks (\'…\').',
};

export function dialogConventionsFor(lang) {
  if (!lang) return '';
  const key = String(lang).toLowerCase().trim();
  return DIALOG_CONVENTIONS[key] || '';
}

// Split a book into chunks suitable for term extraction. Each chunk covers
// exactly one chapter; chapters bigger than maxChars are split along
// paragraph boundaries (never mid-paragraph) with the title repeated on
// every continuation chunk for context. One-chapter-per-chunk makes each
// chunk's source chapter unambiguous, which the dictionary uses to track
// which chapters each term appeared in.
// Returns: [{ text, chapterIndices: [number] }]  (a 1-element array for now,
// but kept as an array so the shape stays stable if we ever re-enable
// chapter packing for small books.)
export function chunkBookText(chapters, maxChars) {
  const chunks = [];
  chapters.forEach((ch, chapterIndex) => {
    const heading = `# ${ch.title}`;
    const paragraphs = ch.paragraphs.map(p => p.original);
    if (paragraphs.length === 0) return;
    const full = `${heading}\n\n${paragraphs.join('\n\n')}`;

    if (full.length <= maxChars) {
      chunks.push({ text: full, chapterIndices: [chapterIndex] });
      return;
    }

    let buf = heading;
    for (const p of paragraphs) {
      const addition = '\n\n' + p;
      if (buf.length + addition.length > maxChars && buf !== heading) {
        chunks.push({ text: buf, chapterIndices: [chapterIndex] });
        buf = heading + addition;
      } else {
        buf += addition;
      }
    }
    if (buf !== heading) chunks.push({ text: buf, chapterIndices: [chapterIndex] });
  });
  return chunks;
}

// Render the bilingual dictionary as a Markdown table for export. Columns
// are named by the user's actual languages (e.g. Chinese / English /
// Russian) so the file is self-describing. Chapter provenance is
// internal bookkeeping for the model's per-chapter prompt filtering —
// not useful in the exported file, so it's not emitted.
export function renderDictionaryMarkdown(dictionary, opts = {}) {
  const target    = opts.targetLanguage    || 'Translation';
  // Bilingual dictionaries pass `referenceLanguage` and carry per-entry
  // `originalForm` (the canonical reference-language form). Single-source
  // dictionaries pass neither — render a 3-column table (Term · target ·
  // Notes) so the export reflects the data the user actually has.
  const isBilingual = !!opts.referenceLanguage;
  if (isBilingual) {
    const editor    = opts.editorLanguage    || 'Editor';
    const reference = opts.referenceLanguage;
    const lines = [`# Dictionary — ${reference} / ${editor} → ${target}`, ''];
    if (!dictionary?.length) return lines.join('\n') + '\n';
    const headerCols = [reference, editor, target, 'Notes'];
    lines.push('| ' + headerCols.join(' | ') + ' |');
    lines.push('| ' + headerCols.map(() => '---').join(' | ') + ' |');
    for (const d of dictionary) {
      lines.push('| ' + [
        cell(d.originalForm),
        cell(d.term),
        cell(d.translation),
        cell(d.notes),
      ].join(' | ') + ' |');
    }
    return lines.join('\n') + '\n';
  }
  const lines = [`# Dictionary — ${target}`, ''];
  if (!dictionary?.length) return lines.join('\n') + '\n';
  const headerCols = ['Term', target, 'Notes'];
  lines.push('| ' + headerCols.join(' | ') + ' |');
  lines.push('| ' + headerCols.map(() => '---').join(' | ') + ' |');
  for (const d of dictionary) {
    lines.push('| ' + [
      cell(d.term),
      cell(d.translation),
      cell(d.notes),
    ].join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

// Pipe is the table-cell separator; escape any inside cell content so a
// stray `|` in a name or note doesn't blow up the row.
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

// Render translated chapters from indices 0..uptoIndex as a single Markdown
// document of the same shape the parser accepts (so the output can be
// re-imported round-trip). Chapters still in `status: 'pending'` are
// skipped. At paragraph granularity, an empty translation falls back to the
// original text — so a partially-edited chapter still exports cleanly,
// mixed-language, instead of producing blank paragraphs.
export function renderTranslationMarkdown(book, uptoIndex) {
  if (!book?.chapters?.length) return '';
  const upto = Math.min(uptoIndex, book.chapters.length - 1);
  const out = [];
  for (let i = 0; i <= upto; i++) {
    const c = book.chapters[i];
    if (c.status === 'pending') continue;
    const title = (c.translatedTitle && c.translatedTitle.trim()) || c.title;
    const body = c.paragraphs
      .map(p => (p.translation && p.translation.trim()) || p.original)
      .join('\n\n');
    out.push(`# ${title}\n\n${body}`);
  }
  return out.join('\n\n');
}

// Merge per-chunk term extractions, dedupe across chunks, and preserve the
// set of chapter indices each term appeared in (so the dictionary can
// later filter entries relevant to a given chapter).
// Input:  [{ terms: string[], chapterIndices: number[] }]
// Output: [{ term, chapters: number[], frequency: number }]
//         sorted by frequency desc, ties broken alphabetically.
export function mergeTermsWithSources(chunkResults) {
  const byTerm = new Map();
  for (const r of chunkResults) {
    if (!r || !Array.isArray(r.terms)) continue;
    for (const raw of r.terms) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      let entry = byTerm.get(t);
      if (!entry) { entry = { count: 0, chapters: new Set() }; byTerm.set(t, entry); }
      entry.count++;
      if (Array.isArray(r.chapterIndices)) {
        for (const ci of r.chapterIndices) entry.chapters.add(ci);
      }
    }
  }
  return [...byTerm.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([term, { count, chapters }]) => ({
      term,
      chapters: [...chapters].sort((a, b) => a - b),
      frequency: count,
    }));
}

// Bilingual sibling of mergeTermsWithSources: each chunk yielded a list
// of {original, reference} pairs (the same term in two languages); this
// dedupes the merged pair set and accumulates each pair's chapter set.
// Identity is the (original, reference) tuple — two different reference
// forms for the same original (or vice versa) stay as separate entries.
// Input:  [{ pairs: [{original, reference}], chapterIndices: number[] }]
// Output: [{ original, reference, chapters: number[], frequency }]
//         sorted by frequency desc, ties broken alphabetically by original.
export function mergeBilingualPairsWithSources(chunkResults) {
  const byKey = new Map();
  for (const r of chunkResults) {
    if (!r || !Array.isArray(r.pairs)) continue;
    for (const raw of r.pairs) {
      const original  = String(raw?.original  ?? '').trim();
      const reference = String(raw?.reference ?? '').trim();
      if (!original) continue;
      const key = `${original}|${reference}`;
      let entry = byKey.get(key);
      if (!entry) { entry = { original, reference, count: 0, chapters: new Set() }; byKey.set(key, entry); }
      entry.count++;
      if (Array.isArray(r.chapterIndices)) {
        for (const ci of r.chapterIndices) entry.chapters.add(ci);
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.original.localeCompare(b.original))
    .map(({ original, reference, count, chapters }) => ({
      original, reference,
      chapters: [...chapters].sort((a, b) => a - b),
      frequency: count,
    }));
}
