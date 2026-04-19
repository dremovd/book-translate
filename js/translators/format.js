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
    .map(d => `- ${d.term} → ${d.translation}${d.notes ? `  (${d.notes})` : ''}`)
    .join('\n');
}

// Split a book into approximately-maxChars text blobs suitable for term
// extraction. Chapter boundaries are preserved as `# Title` headings in each
// chunk. If a single chapter exceeds maxChars, it is split along paragraph
// boundaries (never mid-paragraph) with the title repeated for context.
// Output is an array of strings; concatenation is not meaningful.
export function chunkBookText(chapters, maxChars) {
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };

  for (const ch of chapters) {
    const heading = `# ${ch.title}`;
    const paragraphs = ch.paragraphs.map(p => p.original);
    const chapterText = `${heading}\n\n${paragraphs.join('\n\n')}`;

    if (chapterText.length > maxChars) {
      flush();
      let inner = heading;
      for (const p of paragraphs) {
        const addition = '\n\n' + p;
        if (inner.length + addition.length > maxChars && inner !== heading) {
          chunks.push(inner);
          inner = heading + addition;
        } else {
          inner += addition;
        }
      }
      if (inner !== heading) chunks.push(inner);
      continue;
    }

    const addition = buf ? '\n\n' + chapterText : chapterText;
    if (buf && buf.length + addition.length > maxChars) {
      flush();
      buf = chapterText;
    } else {
      buf += addition;
    }
  }
  flush();
  return chunks;
}

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

// Dedupe term strings across per-chunk results and sort by cross-chunk
// frequency (descending), breaking ties alphabetically. Input is tolerant
// of nulls/non-arrays so a partial failure upstream doesn't crash here.
export function mergeTermLists(termArrays) {
  const counts = new Map();
  for (const arr of termArrays) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);
}
