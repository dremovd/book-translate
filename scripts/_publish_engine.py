"""Site-agnostic engine shared by publish-rulate.py and publish-mirnovel.py.

Markdown parser, chapter splitter, HTML body renderer, sentinel-form
text codec for the skip-vs-update_body comparison, manifest persistence,
form encoder. No HTTP / auth / scraping selectors here — those live
per-site in `publish-{site}.py`.

Sharing the engine keeps round-trip semantics identical across sites
(same renderer → same hashes → same skip/update classification);
duplicating the plumbing keeps each publisher's HTTP layer readable
end-to-end.
"""

import hashlib
import json
import re


def normalize_chapter_title(title: str) -> str:
    """Strip leading zeros from "Глава 0N" so the local "Глава 01" matches
    the server's "Глава 1" — without this, the title-based classifier sees
    them as different chapters and creates duplicates."""
    if not title:
        return title
    return re.sub(r'^(Глава )0+(\d)', r'\1\2', title)


def parse_chapters_md(md: str) -> list[dict]:
    parts = re.split(r'(?m)^# (.+)$', md)
    out = []
    for i in range(1, len(parts), 2):
        title = normalize_chapter_title(parts[i].strip())
        body = parts[i + 1] if i + 1 < len(parts) else ''
        paragraphs = [p.strip() for p in body.split('\n\n') if p.strip()]
        out.append({'title': title, 'paragraphs': paragraphs})
    return out


def no_space_chars(text: str) -> int:
    return len(re.sub(r'\s', '', text))


def chapter_no_space_chars(paragraphs: list[str]) -> int:
    return sum(no_space_chars(p) for p in paragraphs)


def _queue_size_summary(queue: list[dict]) -> str:
    if not queue:
        return 'queue size: 0 parts'
    sizes = [chapter_no_space_chars(item['paragraphs']) for item in queue]
    total = sum(sizes)
    avg = total / len(sizes)
    return f'chars (no spaces): total {total}, avg per part {avg:.0f}'


def compute_parts(n_no_ws: int, target: int) -> int:
    """Number of parts to split a source chapter into.
        n <= 2*target → 1 part
        otherwise     → floor((n - 1) / target)
    The 2*target floor avoids splitting borderline chapters into
    two awkwardly-short parts."""
    if target <= 0:
        return 1
    if n_no_ws <= 2 * target:
        return 1
    return (n_no_ws - 1) // target


def split_paragraphs_balanced(paragraphs: list[str], parts: int) -> list[list[str]]:
    """Split into `parts` contiguous groups so each group's no-space
    char count is as close to total/parts as possible. Greedy: at each
    boundary, pick the paragraph index whose cumulative size is closest
    to the target ratio. Never produces empty groups; preserves order."""
    if parts <= 1 or len(paragraphs) <= 1:
        return [list(paragraphs)] if paragraphs else []
    if parts >= len(paragraphs):
        return [[p] for p in paragraphs]

    sizes = [no_space_chars(p) for p in paragraphs]
    total = sum(sizes)
    target_per_part = total / parts
    cumsum = []
    s = 0
    for sz in sizes:
        s += sz
        cumsum.append(s)

    boundaries: list[int] = []
    for i in range(1, parts):
        target_at = i * target_per_part
        prev_b = boundaries[-1] if boundaries else 0
        # j = boundary cuts AFTER paragraph index j-1; clamp so each
        # remaining boundary still has at least one paragraph to consume.
        lo = prev_b + 1
        hi = len(paragraphs) - (parts - i) + 1
        best_j, best_diff = lo, abs(cumsum[lo - 1] - target_at)
        for j in range(lo + 1, hi + 1):
            d = abs(cumsum[j - 1] - target_at)
            if d < best_diff:
                best_diff = d
                best_j = j
        boundaries.append(best_j)
    boundaries.append(len(paragraphs))

    groups: list[list[str]] = []
    start = 0
    for b in boundaries:
        groups.append(list(paragraphs[start:b]))
        start = b
    return groups


def build_upload_queue(chapters: list[dict], target: int) -> list[dict]:
    """Apply the splitting rule to each source chapter; emit a flat
    upload list. Each item carries `source_chapter_index` (used by the
    subscription / delayed thresholds), `part_index`, and `total_parts`.

    `_source_index` on a chapter dict overrides positional enumeration —
    set by main() before --from / --up-to slicing so the original
    1-based index survives a sliced queue."""
    queue: list[dict] = []
    for enum_idx, ch in enumerate(chapters, start=1):
        src_idx = ch.get('_source_index', enum_idx)
        n = chapter_no_space_chars(ch['paragraphs'])
        parts = compute_parts(n, target)
        if parts <= 1:
            queue.append({
                'title': ch['title'],
                'paragraphs': list(ch['paragraphs']),
                'source_chapter_index': src_idx,
                'part_index': 1,
                'total_parts': 1,
            })
            continue
        groups = split_paragraphs_balanced(ch['paragraphs'], parts)
        actual_parts = len(groups)
        for k, group in enumerate(groups, start=1):
            queue.append({
                'title': f"{ch['title']}.{k}",
                'paragraphs': group,
                'source_chapter_index': src_idx,
                'part_index': k,
                'total_parts': actual_parts,
            })
    return queue


PARA_TEMPLATE = (
    '<p style="margin-left:0px; margin-right:0px; text-align:justify">'
    '<span style="color:#000000; font-size:11pt">{}</span>'
    '</p>'
)


def html_escape(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


# `**` and `__` precede `*` and `_` in the alternation so a bold span
# isn't torn into two italic spans meeting in the middle. Mirrors
# js/markdown.js#renderInlineMd so what the editor displays as bold/
# italic round-trips to the publisher target as <strong>/<em>.
_INLINE_MD_RE = re.compile(
    r'\*\*(.+?)\*\*'
    r'|__(.+?)__'
    r'|\*(.+?)\*'
    r'|_(.+?)_',
    re.DOTALL,
)


def render_inline_md(text: str) -> str:
    """Convert markdown bold/italic to <strong>/<em>; HTML-escape every
    other character including the text inside a span."""
    parts = []
    pos = 0
    for m in _INLINE_MD_RE.finditer(text):
        if m.start() > pos:
            parts.append(html_escape(text[pos:m.start()]))
        bold_a, bold_u, em_a, em_u = m.group(1), m.group(2), m.group(3), m.group(4)
        if bold_a is not None:
            parts.append(f'<strong>{html_escape(bold_a)}</strong>')
        elif bold_u is not None:
            parts.append(f'<strong>{html_escape(bold_u)}</strong>')
        elif em_a is not None:
            parts.append(f'<em>{html_escape(em_a)}</em>')
        elif em_u is not None:
            parts.append(f'<em>{html_escape(em_u)}</em>')
        pos = m.end()
    if pos < len(text):
        parts.append(html_escape(text[pos:]))
    return ''.join(parts)


def render_paragraph_html(paragraph: str) -> str:
    """One .md paragraph → one or more `<p>` blocks. Newlines inside a
    paragraph (Russian dialog-turn convention) become separate `<p>`s
    so the reader gives them vertical spacing."""
    lines = [ln for ln in paragraph.split('\n') if ln.strip()]
    return ''.join(PARA_TEMPLATE.format(render_inline_md(ln)) for ln in lines)


def render_chapter_body_html(paragraphs: list[str]) -> str:
    return ''.join(render_paragraph_html(p) for p in paragraphs)


def _collapse_ws(text: str) -> str:
    return re.sub(r'[ \t\xa0]+', ' ', text).strip()


# Private-use codepoints that wrap real `<strong>`/`<em>` content so the
# comparison can tell apart "server has rendered bold" (sentinel-wrapped)
# from "server still has unrendered literal **X**" (pass-through). Without
# this discrimination, pre-renderer-fix chapters look "unchanged" forever
# and never get re-pushed.
_BOLD_MARK = ''
_EM_MARK   = ''


def _canonicalize_inline_md(text: str) -> str:
    """Turn local `**X**` / `__X__` into `_BOLD_MARK X _BOLD_MARK`,
    `*X*` / `_X_` into `_EM_MARK X _EM_MARK`. Same regex as the
    renderer; emits sentinels instead of HTML; no escaping."""
    def repl(m):
        bold_a, bold_u, em_a, em_u = m.group(1), m.group(2), m.group(3), m.group(4)
        if bold_a is not None: return f'{_BOLD_MARK}{bold_a}{_BOLD_MARK}'
        if bold_u is not None: return f'{_BOLD_MARK}{bold_u}{_BOLD_MARK}'
        if em_a   is not None: return f'{_EM_MARK}{em_a}{_EM_MARK}'
        if em_u   is not None: return f'{_EM_MARK}{em_u}{_EM_MARK}'
        return m.group(0)
    return _INLINE_MD_RE.sub(repl, text)


def _inline_text_with_markdown(node) -> str:
    """Flatten a BS4 tag, wrapping `<strong>`/`<b>` in `_BOLD_MARK` and
    `<em>`/`<i>` in `_EM_MARK`. Plain text nodes pass through unchanged
    INCLUDING any literal `**`/`*` they contain — that's the
    discriminator from `_canonicalize_inline_md`'s sentinel output."""
    from bs4 import NavigableString
    if isinstance(node, NavigableString):
        return str(node)
    if node is None or not hasattr(node, 'children'):
        return str(node) if node is not None else ''
    parts = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
            continue
        name = (getattr(child, 'name', '') or '').lower()
        inner = _inline_text_with_markdown(child)
        if name in ('strong', 'b'):
            parts.append(f'{_BOLD_MARK}{inner}{_BOLD_MARK}')
        elif name in ('em', 'i'):
            parts.append(f'{_EM_MARK}{inner}{_EM_MARK}')
        else:
            parts.append(inner)
    return ''.join(parts)


def _humanize_sentinels(text: str) -> str:
    """Sentinels → readable `**`/`*` for diff display only. Never used
    as input to a hash."""
    return text.replace(_BOLD_MARK, '**').replace(_EM_MARK, '*')


def _our_chapter_text(paragraphs: list) -> str:
    """Local-side counterpart to `_inline_text_with_markdown`: split
    each paragraph at `\\n` (matching what `render_paragraph_html` does
    on the way out), canonicalize markdown markers to sentinels,
    collapse whitespace."""
    out = []
    for p in paragraphs:
        for line in p.split('\n'):
            t = _collapse_ws(_canonicalize_inline_md(line))
            if t:
                out.append(t)
    return '\n\n'.join(out)


def _body_hash(text: str) -> str:
    return hashlib.sha256((text or '').encode('utf-8')).hexdigest()


def _format_first_n_hunks(rulate_text: str, local_text: str, n: int = 5):
    """Up to `n` unified-diff hunks for human display. Sentinels are
    humanized BEFORE diffing so the output is readable; net effect:
    a chapter where the only diff is `<strong>` vs literal `**X**`
    shows zero hunks (handled separately by the manifest-match path)."""
    import difflib
    raw = list(difflib.unified_diff(
        _humanize_sentinels(rulate_text).splitlines(),
        _humanize_sentinels(local_text).splitlines(),
        fromfile='server (current)',
        tofile='local (.md)',
        lineterm='',
    ))
    hunks = []
    current = None
    for line in raw:
        if line.startswith('@@'):
            if current is not None:
                hunks.append(current)
            current = [line]
        elif current is not None:
            current.append(line)
    if current is not None:
        hunks.append(current)
    return hunks[:n], len(hunks)


def load_manifest(path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def save_manifest(path, manifest: dict) -> None:
    path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True),
        encoding='utf-8',
    )


def record_manifest(manifest: dict, chapter_id, local_text: str) -> None:
    from datetime import datetime, timezone
    manifest[str(chapter_id)] = {
        'hash': _body_hash(local_text),
        'last_pushed_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }


def encode_form(fields: list) -> str:
    from urllib.parse import quote
    return '&'.join(f'{quote(k, safe="[]")}={quote(v, safe="")}' for k, v in fields)
