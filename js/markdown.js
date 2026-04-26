// Tiny inline-only markdown → safe HTML.
// Handles **bold** / __bold__ / *italic* / _italic_ and nothing else.
// Output is meant for x-html and is HTML-escaped before any markdown is
// applied, so user/model input can't smuggle <script> or attributes through.
//
// Why not pull in a real markdown library? The book is plain prose and the
// only inline markup the LLM ever emits in these chapters is *emph* and
// **bold** (per the source LaTeX → pandoc gfm pipeline). A 30-line function
// avoids a CDN dependency and keeps the editor cell render path obvious.

// Multi-paragraph variant: split on blank-line breaks, render each
// paragraph through `renderInlineMd`, wrap each in <p>. Used by the
// A/B comparison view where a single side can span several paragraphs
// joined with `\n\n`. Output is meant for `x-html`.
export function renderBlockMd(text) {
  if (text == null) return '';
  const s = String(text).trim();
  if (!s) return '';
  return s.split(/\n\s*\n/)
    .map(p => p.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
    .map(p => `<p>${renderInlineMd(p)}</p>`)
    .join('');
}

export function renderInlineMd(text) {
  if (text == null) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Order matters: ** and __ must be matched before * and _ so the latter
  // don't eat their delimiters. Lazy `.+?` keeps each marker pair as small
  // as possible. The `s` flag lets a span cross a newline (rare but cheap).
  return escaped
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/__(.+?)__/gs, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gs, '<em>$1</em>')
    // Underscore italic only when bordered by non-word characters on both
    // sides — so snake_case stays as plain text.
    .replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/gs, '<em>$1</em>');
}
