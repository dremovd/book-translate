// Parse a Markdown book into chapters and paragraphs.
//
// Input shape (default): chapters are ATX-style H1 headings (`# Title`).
// Content before the first heading is dropped (typical for a manuscript with
// preface metadata that isn't part of the translatable body). If no heading
// matches the configured level, the whole document becomes a single
// "Chapter 1" — this is the graceful-degradation path for users pasting
// plain prose with no headings at all.
//
// Paragraphs are blank-line-separated, as in Markdown. Inline markup
// (*emph*, **bold**, links, blockquotes, list bullets) is preserved verbatim
// — the translator receives the original text and is free to preserve
// formatting; the editor displays it as-is.

export function parseBook(raw, { headingLevel = 1 } = {}) {
  const hashes = '#'.repeat(headingLevel);
  // ATX heading: `{hashes} Title`, optional closing ` ##`, trailing whitespace.
  // Note: \s+ before the title ensures we don't match deeper-level headings
  // (e.g. `##` when looking for `#`), because `\s+` can't match `#`.
  const headingRe = new RegExp(
    `^${hashes}\\s+(.+?)(?:\\s+#+)?\\s*$`,
    'gm',
  );

  const matches = [];
  let m;
  while ((m = headingRe.exec(raw)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      title: m[1].trim(),
    });
  }

  if (matches.length === 0) {
    const paragraphs = splitParagraphs(raw);
    return {
      chapters: paragraphs.length
        ? [{ title: 'Chapter 1', translatedTitle: '', paragraphs, status: 'pending' }]
        : [],
    };
  }

  const chapters = [];
  for (let i = 0; i < matches.length; i++) {
    const bodyStart = matches[i].end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].start : raw.length;
    const paragraphs = splitParagraphs(raw.slice(bodyStart, bodyEnd));
    if (paragraphs.length) {
      chapters.push({
        title: matches[i].title,
        translatedTitle: '',
        paragraphs,
        status: 'pending',
      });
    }
  }
  return { chapters };
}

function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
    .map(original => ({ original, translation: '', status: 'pending' }));
}
