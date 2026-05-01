#!/usr/bin/env python3
"""Publish translated chapters to tl.rulate.ru.

Status: scaffold. The upload algorithm is being specified by the user
step-by-step; this file accumulates the spec until enough is known to
implement.

----------------------------------------------------------------------
Algorithm — overview
----------------------------------------------------------------------
Inputs:
  - Markdown file in this project's standard export format:
      # Chapter Title
      <blank line>
      paragraph 1
      <blank line>
      paragraph 2
      ...
      # Next Chapter Title
      ...
  - .env values: RULATE_LOGIN, RULATE_PASSWORD, RULATE_BOOK_ID,
                 RULATE_TARGET_CHARS_NO_SPACES,
                 [optional] RULATE_SUBSCRIPTION_FROM_CHAPTER.

Pipeline:
  1. Parse the .md into source chapters.
  2. Build the upload queue — for each source chapter, decide whether
     to split it into multiple rulate chapters (see "Long-chapter
     splitting" below). Output: a flat list of rulate-chapter specs
     `{title, paragraphs, source_chapter_index}` in upload order.
  3. For each rulate-chapter spec in the queue, run the per-chapter
     fill algorithm below (Phase A, then Phase B).

Long-chapter splitting (queue-build rule):
  target = int(env.RULATE_TARGET_CHARS_NO_SPACES or 5000)
  n      = source chapter's no-space character count
  parts  = 1                              if n <= 2*target
           floor((n - 1) / target)        otherwise
  # n=10000 → 1 part; n=10001 → 2 parts;
  # n=15000 → 2 parts; n=15001 → 3 parts; ...

  When parts > 1:
    - Split paragraphs (NOT mid-paragraph) into `parts` groups so each
      group's no-space character count is as close to n/parts as
      possible. Greedy balanced split: at each boundary i ∈ [1..N-1],
      pick the paragraph index whose cumulative size is closest to
      i*n/parts; never produce empty groups; preserve order.
    - Each group becomes its own rulate chapter. Phase A metadata
      (volume, status, access, subscription) is copied from the
      source chapter; only the title and body differ.
    - Title transformation: append ".K" (1-indexed) to the END of
      the source title, regardless of its shape. Examples:
          "Глава 1"             → "Глава 1.1", "Глава 1.2"
          "Глава 12"            → "Глава 12.1", "Глава 12.2"
          "Пролог"              → "Пролог.1", "Пролог.2"
          "Глава 1. Прибытие"   → "Глава 1. Прибытие.1", "Глава 1. Прибытие.2"
    - Subscription gating (per-chapter step 6) is keyed on the SOURCE
      chapter index, so all parts of one .md chapter share the same
      subscription state.

----------------------------------------------------------------------
Per-chapter fill algorithm (work in progress)
----------------------------------------------------------------------
For each rulate-chapter spec in the queue, perform the steps below.

Steps:
  1. Title — taken from the chapter's H1 line in the .md
     (corresponds to `book.chapters[i].translatedTitle` in the
     translation app's state). For some books the title is just a
     number ("Глава 01", "Глава 02"), but the algorithm should
     preserve whatever H1 text the .md contains, including any
     subtitle.

  2. Volume / Arc ("Том / Арка") — empty by default. The script
     accepts an optional `--volume <name>` flag for books that DO
     use this field.

  3. Status ("Статус") — "идёт перевод" by default. This is the
     rulate-side translation-progress flag. The script should send
     this value unless overridden via `--status <value>`.

  4. "Особые права доступа" checkbox — checked (true). This gates
     the chapter behind the paid / patron tier on rulate. Always
     enabled by this script; no CLI override planned for now.

  5. Access-rights matrix — every per-role / per-tier control inside
     the "Особые права доступа" panel is set to "Модераторы". This is
     the most restrictive level: only moderators can read the chapter
     while it's in this state. (Used as a publish-as-draft mode — the
     uploader posts the body, leaves the chapter visible only to
     moderators, and the user later relaxes access manually once a
     chapter is reviewed.)

  6. "Подписка" toggle — driven by the .env variable
     RULATE_SUBSCRIPTION_FROM_CHAPTER:
       - if unset or empty → DO NOT touch the subscription field
         (leave whatever rulate's default is on chapter creation).
       - if set to an integer N → for the N-th chapter and every
         chapter after it, send subscription=true. Chapters with
         (1-based) index < N keep the default (no override).
     Chapter index is the 1-based position in the parsed .md, not a
     parsed number from the title — keeps the rule consistent for
     books whose H1 isn't a clean number.

  ----  Phase A complete: chapter shell exists on rulate.  ----

  HTTP details for Phase A (verified by inspecting the live rulate
  modal at /book/<id>/0/mass_edit?ajax=1&placement=0):

    POST /book/<book_id>/0/mass_edit?ajax=1&placement=0
    Headers:
      X-Requested-With: XMLHttpRequest
      Cookie: <auth + DDoS-Guard, see cookies/rulate.txt>
      Referer: https://tl.rulate.ru/book/<book_id>
    Form fields (urlencoded):
      Chapter[title][]            — array; one entry per chapter.
                                    `mass_edit` accepts batches.
      Chapter[volume]             — text, empty by default.
      Chapter[status]             — "1" (идёт перевод) | "2"
                                    (редактируется) | "3" (готов).
      Chapter[has_override]       — "1" to enable "Особые права".
      Chapter[ac_read]            — "m" (Модераторы) for our flow.
      Chapter[ac_trread]          — "m"
      Chapter[ac_gen]             — "m"
      Chapter[ac_rate]            — "m"
      Chapter[ac_comment]         — "m"
      Chapter[ac_tr]              — "m"
                                    Other allowed: "a"=Все,
                                    "g"=Группа, "o"=Никто,
                                    ""=Как в переводе (default).
      Chapter[post_open]          — "0" (hidden) plus optional
                                    "1" (checkbox). Leave at "0".
      Chapter[subscription]       — "0" (hidden) plus optional
                                    "1" (checkbox). Driven by
                                    RULATE_SUBSCRIPTION_FROM_CHAPTER
                                    rule (step 6).
      Chapter[subscription_price] — empty unless a price is
                                    explicitly required.
      Chapter[audio_subscription] — "0"
      Chapter[audio_subscription_price] — empty
      yt0                         — "Сохранить" (submit button).

  7. Submit Phase A (steps 1-6) and follow into the chapter itself
     (UI: click the chapter title in the book's chapter list).
     HTTP-side: take the chapter-id assigned to the just-created
     chapter (returned in the redirect Location header / parsed from
     the post-submit page) and GET that chapter's edit page to load
     the body editor for Phase B.

  ----  Phase B: filling chapter body. ----

  8-10. (skipped) — empirically, the Phase A POST that creates the
     chapter shell ALSO seeds an empty first fragment AND a default
     source-side stub, so the original "create first fragment" /
     "fill source with 1" / "save source" / "click arrow" steps are
     no longer separate actions. The chapter ends up immediately
     ready for the translation-side editor (CKEditor).

  11. Translation editor — the panel that opens is a WYSIWYG editor
      (CKEditor) with a "Источник" / "Source" toggle that accepts
      raw HTML. CKEditor whitelists a SUBSET of CSS on save; it
      strips `font-family`, `margin-bottom`, `line-height` and
      similar from inline `style` blocks. The shape we send is the
      already-normalised form rulate ends up storing — so a
      sent → saved → re-fetched roundtrip is byte-stable:

          <p style="margin-left:0px; margin-right:0px; text-align:justify">
            <span style="color:#000000; font-size:11pt">{escaped text}</span>
          </p>

      Style choices that survive the sanitiser:
        - font-size:   11pt
        - text-align:  justify
        - color:       black
        - margin-l/r:  0px (no side gutter)

      Style choices the user might want but rulate WILL DROP:
        - font-family (e.g. Calibri) — site enforces its own font.
        - margin-bottom / paragraph "after" spacing — controlled by
          the site's reader CSS, not per-paragraph inline.
        - line-height — same.

      (single line in the actual payload — line breaks here are for
      readability). Escaping rules for `{escaped text}`:
        - `&` → `&amp;` (must come first)
        - `<` → `&lt;`
        - `>` → `&gt;`
        - quotes are left as-is (they sit inside text, not attribute
          values).
      Paragraphs are joined together with no separator between the
      `</p>` of one and the `<p>` of the next.

      Open question (need confirmation): a paragraph in this
      project's .md may contain in-paragraph newlines for dialog
      turns (Russian convention — multiple speech lines inside one
      paragraph slot, separated by `\n`). Two reasonable mappings:
        (a) emit each line as its OWN `<p>` block; or
        (b) keep one `<p>` and split lines with `<br>` inside the
            inner `<span>`.
      Defaulting to (a) — each `\n` inside a paragraph becomes a new
      `<p>` block — until told otherwise, since rulate's reader
      renders paragraphs with vertical spacing while `<br>` collapses
      to a hard line break with no spacing.

  12. [TBD]
  ...

----------------------------------------------------------------------
Notes for implementation
----------------------------------------------------------------------
- rulate is fronted by DDoS-Guard. A `requests.Session` going through
  the public login form (POST credentials, follow redirects, keep
  cookies) handles this; raw API hits without the cookie warm-up will
  be blocked.
- Auth: RULATE_LOGIN / RULATE_PASSWORD from .env. Read as raw lines
  (don't `source` — values may contain shell-special chars).
- Book ID: RULATE_BOOK_ID from .env.
"""

import argparse
import re
import sys
from pathlib import Path


# ----------------------------------------------------------------------
# .env loading
# ----------------------------------------------------------------------
def load_env(path: Path) -> dict:
    """Read a flat KEY=VALUE .env file, preserving raw values.

    Splits on the FIRST `=` so values may legitimately contain `=`.
    Comments (#) and blank lines are skipped. The cookie itself is no
    longer kept inline (see RULATE_COOKIE_FILE).
    """
    out = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        out[key.strip()] = value
    return out


# ----------------------------------------------------------------------
# Pure logic — parse / size / split / queue / render
# ----------------------------------------------------------------------
def parse_chapters_md(md: str) -> list[dict]:
    """Split the project's standard .md export into chapters.

    Each chapter is everything between consecutive H1 headings; any
    content before the first H1 is treated as a book-level preface and
    dropped (matches js/parse.js).
    """
    parts = re.split(r'(?m)^# (.+)$', md)
    out = []
    for i in range(1, len(parts), 2):
        title = parts[i].strip()
        body = parts[i + 1] if i + 1 < len(parts) else ''
        paragraphs = [p.strip() for p in body.split('\n\n') if p.strip()]
        out.append({'title': title, 'paragraphs': paragraphs})
    return out


def no_space_chars(text: str) -> int:
    """Length excluding all whitespace (matches the editor's
    "characters (no spaces)" stat in component.js)."""
    return len(re.sub(r'\s', '', text))


def chapter_no_space_chars(paragraphs: list[str]) -> int:
    return sum(no_space_chars(p) for p in paragraphs)


def _queue_size_summary(queue: list[dict]) -> str:
    """One-line size summary for the queue: total no-space character
    count across all parts, plus the mean per part. Used by --dry-run
    and --live-full-all output so the user sees how the split landed."""
    if not queue:
        return 'queue size: 0 parts'
    sizes = [chapter_no_space_chars(item['paragraphs']) for item in queue]
    total = sum(sizes)
    avg = total / len(sizes)
    return f'chars (no spaces): total {total}, avg per part {avg:.0f}'


def compute_parts(n_no_ws: int, target: int) -> int:
    """Number of rulate chapters to split a source chapter into.

    Rule (user-specified):
        n <= 2*target → 1 part (don't split)
        otherwise     → floor((n - 1) / target) parts
    Examples for target=5000:
        n = 10000 → 1 part   (≤ 2*target)
        n = 10001 → 2 parts
        n = 15000 → 2 parts  (still ≤ 3*target by the boundary)
        n = 15001 → 3 parts
    """
    if target <= 0:
        return 1
    if n_no_ws <= 2 * target:
        return 1
    return (n_no_ws - 1) // target


def split_paragraphs_balanced(paragraphs: list[str], parts: int) -> list[list[str]]:
    """Split a paragraph list into `parts` contiguous groups so the
    no-space char count of each group is as close to total/parts as
    possible. Greedy: at boundary i ∈ [1..parts-1], pick the paragraph
    index whose cumulative size is closest to i*total/parts. Never
    produces empty groups; preserves order.
    """
    if parts <= 1 or len(paragraphs) <= 1:
        return [list(paragraphs)] if paragraphs else []
    if parts >= len(paragraphs):
        # One paragraph per group, drop excess parts.
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
        # The j-th boundary cuts AFTER paragraph index j-1 (i.e. group
        # = paragraphs[start:j]). Need: prev_b < j ≤ N - (parts - i),
        # so each remaining boundary still has at least one paragraph.
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
    list of rulate-chapter specs in upload order.

    Each item:
        title:                 str (original or "...K" suffixed)
        paragraphs:            list[str]
        source_chapter_index:  int (1-based, used for subscription rule)
        part_index:            int (1-based)
        total_parts:           int
    """
    queue: list[dict] = []
    for src_idx, ch in enumerate(chapters, start=1):
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


# ----------------------------------------------------------------------
# Phase B HTML rendering (per algorithm step 11)
# ----------------------------------------------------------------------
PARA_TEMPLATE = (
    '<p style="margin-left:0px; margin-right:0px; text-align:justify">'
    '<span style="color:#000000; font-size:11pt">{}</span>'
    '</p>'
)


def html_escape(text: str) -> str:
    """Escape & < > for HTML body text. Quotes are left as-is — they
    sit inside content, not attribute values."""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def render_paragraph_html(paragraph: str) -> str:
    """Wrap one .md paragraph as one or more `<p>` blocks.

    A paragraph in this project's .md may contain newlines for dialog
    turns (Russian convention — multiple speech lines in one paragraph
    slot). Each non-empty line becomes its own `<p>` block so rulate's
    reader gives them vertical spacing.
    """
    lines = [ln for ln in paragraph.split('\n') if ln.strip()]
    return ''.join(PARA_TEMPLATE.format(html_escape(ln)) for ln in lines)


def render_chapter_body_html(paragraphs: list[str]) -> str:
    """Concatenate every paragraph's `<p>` blocks with no separator —
    matches the upstream editor's serialised output."""
    return ''.join(render_paragraph_html(p) for p in paragraphs)


# ----------------------------------------------------------------------
# Subscription rule (per-chapter step 6)
# ----------------------------------------------------------------------
def subscription_for(source_chapter_index: int, env: dict):
    """Resolve the "Подписка" toggle for a chapter:
        None  → don't touch the field (env unset / blank / non-int)
        True  → force subscription on (source_chapter_index >= N)
        False → force subscription off (source_chapter_index < N)
    """
    raw = env.get('RULATE_SUBSCRIPTION_FROM_CHAPTER', '').strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return source_chapter_index >= n


# ----------------------------------------------------------------------
# Phase A POST body builder
# ----------------------------------------------------------------------
STATUS_CODES = {
    'идёт перевод': '1',
    'перевод редактируется': '2',
    'перевод готов': '3',
}

ACCESS_LEVEL_MODERATORS = 'm'
ACCESS_FIELDS = ('ac_read', 'ac_trread', 'ac_gen', 'ac_rate', 'ac_comment', 'ac_tr')


def build_phase_a_form(item: dict, env: dict, args) -> list[tuple[str, str]]:
    """Compose the form fields for the Phase A POST that creates a
    chapter shell. Returns a list of (key, value) pairs (not a dict —
    `Chapter[title][]` is repeatable, and even single-chapter requests
    use the same key shape mass_edit expects).

    Per-step mapping:
      1. title           → Chapter[title][] (single value here; batch
                           uploads can repeat the key.)
      2. volume          → Chapter[volume]
      3. status          → Chapter[status] (1/2/3)
      4. special access  → Chapter[has_override]=1
      5. access matrix   → Chapter[ac_*]=m for all six fields
      6. subscription    → Chapter[subscription]=1 if rule says so;
                           the hidden=0 default is always sent so the
                           field is unambiguous.
    """
    fields: list[tuple[str, str]] = []
    fields.append(('Chapter[title][]', item['title']))
    fields.append(('Chapter[volume]', args.volume or ''))
    status_value = STATUS_CODES.get(args.status, args.status)
    fields.append(('Chapter[status]', status_value))
    fields.append(('Chapter[has_override]', '1'))
    for ac in ACCESS_FIELDS:
        fields.append((f'Chapter[{ac}]', ACCESS_LEVEL_MODERATORS))
    # post_open: keep off (chapter not auto-published).
    fields.append(('Chapter[post_open]', '0'))
    # Subscription: send hidden=0 always; if rule says enable, ALSO
    # send the checkbox=1 value, which Yii merges as the final.
    sub = subscription_for(item['source_chapter_index'], env)
    fields.append(('Chapter[subscription]', '0'))
    if sub is True:
        fields.append(('Chapter[subscription]', '1'))
    fields.append(('Chapter[subscription_price]', ''))
    fields.append(('Chapter[audio_subscription]', '0'))
    fields.append(('Chapter[audio_subscription_price]', ''))
    fields.append(('yt0', 'Сохранить'))
    return fields


def encode_form(fields: list[tuple[str, str]]) -> str:
    """URL-encode a list of (key, value) pairs into form-data. Used
    for showing the exact body that would be POSTed in dry-run mode."""
    from urllib.parse import quote
    return '&'.join(f'{quote(k, safe="[]")}={quote(v, safe="")}' for k, v in fields)


# ----------------------------------------------------------------------
# Dry run — print what we'd post, no network calls
# ----------------------------------------------------------------------
def dry_run(queue: list[dict], env: dict, args: argparse.Namespace) -> None:
    book_id = env.get('RULATE_BOOK_ID', '<unset>')
    login = env.get('RULATE_LOGIN', '<unset>')
    target = int(env.get('RULATE_TARGET_CHARS_NO_SPACES', '5000') or '5000')
    print(f'rulate book {book_id} (login {login}) — DRY RUN')
    print(f'split target: {target} chars (no spaces) per part')
    print(f'queue size: {len(queue)} chapter(s) to upload')
    print(_queue_size_summary(queue))
    print()
    for i, item in enumerate(queue, start=1):
        n_no_ws = chapter_no_space_chars(item['paragraphs'])
        sub = subscription_for(item['source_chapter_index'], env)
        sub_str = (
            'enable'        if sub is True
            else 'disable'  if sub is False
            else '(default, no override)'
        )
        body_html = render_chapter_body_html(item['paragraphs'])
        first_html = render_paragraph_html(item['paragraphs'][0])[:160] if item['paragraphs'] else ''
        print(f'[{i:3}] {item["title"]!r}  (part {item["part_index"]}/{item["total_parts"]} of source ch {item["source_chapter_index"]})')
        print(f'      paragraphs: {len(item["paragraphs"])}  chars(no-ws): {n_no_ws}')
        print(f'      Phase A: volume={args.volume!r}  status={args.status!r}  '
              f'special_access=true  access_levels=Модераторы  subscription={sub_str}')

        if args.show_payload and i == 1:
            phase_a = build_phase_a_form(item, env, args)
            url = f'https://tl.rulate.ru/book/{book_id}/0/mass_edit?ajax=1&placement=0'
            print(f'      Phase A POST → {url}')
            print(f'      Phase A form fields:')
            for k, v in phase_a:
                shown = v if len(v) <= 60 else v[:60] + '…'
                print(f'        {k!s:40} = {shown!r}')
            body = encode_form(phase_a)
            print(f'      Phase A urlencoded body ({len(body)} bytes):')
            print(f'        {body[:240]}{"…" if len(body) > 240 else ""}')

        print(f'      Phase B: source-stub="1"  body html len={len(body_html)}')
        print(f'               first <p>: {first_html}{"…" if len(first_html) >= 159 else ""}')
        print()


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------
def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog='publish-rulate',
        description='Publish translated chapters from a .md file to tl.rulate.ru.',
    )
    parser.add_argument('md', help='Path to the .md export of the translation')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print what would be uploaded without making any HTTP calls.')
    parser.add_argument('--show-payload', action='store_true',
                        help='In --dry-run mode, also print the exact urlencoded POST body for the first queued chapter.')
    parser.add_argument('--live-create-first', action='store_true',
                        help='Send ONE Phase A POST for the FIRST queued chapter, then stop. '
                             'Use to verify the create-chapter flow against a real account. '
                             'Logs the full request and the full response.')
    parser.add_argument('--live-full-first', action='store_true',
                        help='Phase A + Phase B for the FIRST queued chapter only: create '
                             'the chapter shell, locate the auto-created fragment, POST the '
                             'rendered HTML body. Stops after one chapter.')
    parser.add_argument('--live-full-all', action='store_true',
                        help='Like --live-full-first, but iterates the entire queue. Each '
                             'item is classified against the live book (skip / update body / '
                             'create) before any write. Prints a summary at the end.')
    parser.add_argument('--volume', default='',
                        help='"Том / Арка" value for every chapter. Empty by default.')
    parser.add_argument('--status', default='идёт перевод',
                        help='"Статус" value for every chapter. Default "идёт перевод".')
    parser.add_argument('--up-to', type=int, default=None, metavar='N',
                        help='Limit processing to the first N SOURCE chapters of the .md '
                             '(applied BEFORE the long-chapter splitting, so e.g. --up-to 3 '
                             'still uploads all parts of source chapters 1..3).')
    parser.add_argument('--force-update', action='store_true',
                        help='Treat every existing-and-text-matching chapter as "update_body" '
                             'instead of "skip". Re-uploads the body for chapters whose text '
                             'is identical — useful after a PARA_TEMPLATE / formatting change '
                             'when you want to push the new HTML to chapters that were already '
                             'on rulate.')
    args = parser.parse_args(argv[1:])

    repo = Path(__file__).resolve().parent.parent
    env = load_env(repo / '.env')
    target = int(env.get('RULATE_TARGET_CHARS_NO_SPACES', '5000') or '5000')

    md_path = Path(args.md).expanduser().resolve()
    chapters = parse_chapters_md(md_path.read_text(encoding='utf-8'))
    if args.up_to is not None:
        if args.up_to < 1:
            print(f'--up-to must be >= 1 (got {args.up_to})', file=sys.stderr)
            return 2
        chapters = chapters[:args.up_to]
        print(f'--up-to {args.up_to}: limited to first {len(chapters)} source chapter(s).')
    queue = build_upload_queue(chapters, target=target)

    if args.dry_run:
        dry_run(queue, env, args)
        return 0

    if args.live_create_first:
        return live_create_first(queue, env, args)

    if args.live_full_first:
        return live_full_first(queue, env, args)

    if args.live_full_all:
        return live_full_all(queue, env, args)

    print('No mode selected. Use --dry-run, --live-create-first, '
          '--live-full-first, or --live-full-all.', file=sys.stderr)
    return 2


# ----------------------------------------------------------------------
# Helpers shared by live-* modes
# ----------------------------------------------------------------------
def _auth_cookies(env: dict) -> str:
    """Read RULATE_COOKIE_FILE and keep ONLY the auth-side cookies.
    DDoS-Guard rotates `__ddg*` aggressively; sending stale ones will
    burn the request before our Chrome-impersonating curl_cffi gets a
    chance to mint fresh ones."""
    cookie_file = env.get('RULATE_COOKIE_FILE')
    if not cookie_file:
        raise RuntimeError('RULATE_COOKIE_FILE is unset')
    raw = (Path(__file__).resolve().parent.parent / cookie_file).read_text(encoding='utf-8').strip()
    # Drop DDoS-Guard's challenge cookies (`__ddg*`) — they get stale
    # quickly and DDoS-Guard reissues fresh ones for our session on the
    # warm-up GET. Keep everything else: `YII_CSRF_TOKEN`, `phpsession`,
    # and the long-name Yii auth cookie that varies per app.
    auth = '; '.join(
        p for p in raw.split('; ')
        if '=' in p and not p.split('=', 1)[0].startswith('__ddg')
    )
    if not auth:
        raise RuntimeError('No auth cookies found in RULATE_COOKIE_FILE')
    return auth


def _csrf_from_cookie(cookie_str: str) -> "str | None":
    """Extract the form CSRF token from the YII_CSRF_TOKEN cookie value.

    The cookie holds: `<sha-hash>s:<len>:"<token>";` (URL-encoded). The
    form-side `YII_CSRF_TOKEN` field is the inner `<token>`.
    """
    import urllib.parse as up
    for pair in cookie_str.split('; '):
        if pair.startswith('YII_CSRF_TOKEN='):
            decoded = up.unquote(pair.split('=', 1)[1])
            m = re.search(r'"([^"]+)"', decoded)
            return m.group(1) if m else None
    return None


def _user_id_from_cookie(cookie_str: str) -> "str | None":
    """Extract the rulate user_id from Yii's auth cookie. The cookie
    has a 32-hex name (app-specific) and a URL-encoded PHP-serialize
    value embedding the login session, e.g.:
        ...s:4:{i:0;i:<user_id>;i:1;s:<n>:"<login>";...}
    Returns the integer user_id as a string, or None if the cookie
    isn't present in the auth string.
    """
    import urllib.parse as up
    for pair in cookie_str.split('; '):
        if '=' not in pair:
            continue
        name, _, value = pair.partition('=')
        # Yii's auth cookie uses a 32-hex name derived from the app
        # secret + state key. Match that shape so we don't accidentally
        # parse a different cookie.
        if not re.fullmatch(r'[0-9a-f]{32}', name):
            continue
        decoded = up.unquote(value)
        m = re.search(r'i:0;i:(\d+);', decoded)
        if m:
            return m.group(1)
    return None


def _make_session(env: dict, cookies: str):
    """Create a curl_cffi session impersonating Chrome (passes
    DDoS-Guard's TLS / HTTP fingerprint)."""
    impersonate = (env.get('RULATE_CURL_IMPERSONATE', '') or 'chrome131').strip()
    print(f'curl_cffi impersonate: {impersonate}')
    from curl_cffi import requests as cr
    s = cr.Session(impersonate=impersonate)
    s.headers.update({
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookies,
    })
    return s


def _warm_up(s, book_id: str) -> bool:
    """GET the book page so DDoS-Guard issues fresh challenge cookies
    against our session. Returns True if the response indicates an
    authenticated session (presence of `/logout`)."""
    r = s.get(f'https://tl.rulate.ru/book/{book_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    print(f'warm-up GET: status={r.status_code}, len={len(r.text)}')
    return r.status_code == 200 and '/logout' in r.text


def _phase_a_post(s, item: dict, env: dict, args, book_id: str):
    """Send the Phase A POST. Returns the curl_cffi response."""
    fields = build_phase_a_form(item, env, args)
    body = encode_form(fields)
    url = f'https://tl.rulate.ru/book/{book_id}/0/mass_edit?ajax=1&placement=0'
    print()
    print('=== Phase A POST ===')
    print(f'URL:    {url}')
    print(f'Title:  {item["title"]!r}')
    for k, v in fields:
        print(f'  {k!s:40} = {v!r}')
    return s.post(
        url,
        headers={
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://tl.rulate.ru',
            'Referer': f'https://tl.rulate.ru/book/{book_id}',
            'X-Requested-With': 'XMLHttpRequest',
        },
        data=body, allow_redirects=False, timeout=30,
    )


def _find_chapter_id_by_title(s, book_id: str, title: str) -> "str | None":
    """Re-fetch the book page, find the chapter row whose title text
    matches `title` exactly, return its `data-id`."""
    r = s.get(f'https://tl.rulate.ru/book/{book_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    if r.status_code != 200:
        return None
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(r.text, 'html.parser')
    for tr in soup.select('tr.chapter_row'):
        link = tr.select_one('td.t > a')
        if link and link.get_text(strip=True) == title:
            return tr.get('data-id')
    return None


def _find_first_fragment_id(s, book_id: str, chapter_id: str) -> "str | None":
    """GET the chapter page and pull the first fragment_id out of any
    `/book/<book>/<ch>/<fragment>` reference."""
    r = s.get(f'https://tl.rulate.ru/book/{book_id}/{chapter_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    if r.status_code != 200:
        return None
    matches = re.findall(rf'/book/{book_id}/{chapter_id}/(\d+)', r.text)
    return matches[0] if matches else None


# ----------------------------------------------------------------------
# Duplicate detection (skip identical content / update when only body differs)
# ----------------------------------------------------------------------
def _existing_chapter_index(s, book_id: str) -> dict:
    """Map {title → chapter_id} for chapters already on rulate. Reads
    each `<tr class="chapter_row" data-id="...">` and the `<a>` text
    inside the title cell."""
    from bs4 import BeautifulSoup
    r = s.get(f'https://tl.rulate.ru/book/{book_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    if r.status_code != 200:
        return {}
    soup = BeautifulSoup(r.text, 'html.parser')
    out = {}
    for tr in soup.select('tr.chapter_row'):
        cid = tr.get('data-id')
        a = tr.select_one('td.t > a')
        if cid and a:
            out[a.get_text(strip=True)] = cid
    return out


def _existing_chapter_text(s, book_id: str, chapter_id: str) -> "str | None":
    """Return the CURRENT translation text for a chapter, normalised
    for comparison (paragraphs joined with blank lines, internal
    whitespace collapsed). Returns None on fetch failure.

    rulate's chapter page renders every translation version; we pick
    the version with the most owner-styled `<p>` blocks (the "real"
    text — empty stubs from auto-creation contain none)."""
    from bs4 import BeautifulSoup
    r = s.get(f'https://tl.rulate.ru/book/{book_id}/{chapter_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    if r.status_code != 200:
        return None
    soup = BeautifulSoup(r.text, 'html.parser')
    # Each translation version is wrapped in a `<div class='text'>`.
    candidates = []
    for div in soup.select('div.text'):
        paras = []
        for p in div.find_all('p'):
            t = p.get_text('\n').strip()
            if t:
                paras.append(_collapse_ws(t))
        if paras:
            candidates.append('\n\n'.join(paras))
    if not candidates:
        return ''
    # Use the longest version — that's our most-recent body, in the
    # presence of multiple translation variants.
    return max(candidates, key=len)


def _collapse_ws(text: str) -> str:
    """Collapse runs of horizontal whitespace to a single space and
    strip line endings — so two pieces of HTML that differ only in
    indentation / nbsp / trailing spaces compare equal."""
    return re.sub(r'[ \t ]+', ' ', text).strip()


def _our_chapter_text(paragraphs: list) -> str:
    """Apply the same normalisation to our own paragraph list so it
    can be compared with the rulate-rendered output. Mirrors
    `render_paragraph_html`: dialog-line splits become `\\n` between
    paragraphs, exactly the same way the renderer would expand them
    to separate `<p>` blocks."""
    out = []
    for p in paragraphs:
        for line in p.split('\n'):
            t = _collapse_ws(line)
            if t:
                out.append(t)
    return '\n\n'.join(out)


def classify_queue_item(s, book_id: str, item: dict, existing: dict) -> dict:
    """Decide what action a queue item needs against rulate:
        {'action': 'create'}                    — title not present
        {'action': 'skip',          'chapter_id': ...}  — title and body match
        {'action': 'update_body',   'chapter_id': ..., 'fragment_id': ...} —
            title present, body differs
    The classification is read-only — it does NOT mutate anything on
    rulate; it just decides what `live_full_first`/`live_full_all`
    should do.
    """
    title = item['title']
    if title not in existing:
        return {'action': 'create'}
    chapter_id = existing[title]
    current = _existing_chapter_text(s, book_id, chapter_id)
    expected = _our_chapter_text(item['paragraphs'])
    if current == expected:
        return {'action': 'skip', 'chapter_id': chapter_id}
    fragment_id = _find_first_fragment_id(s, book_id, chapter_id)
    return {
        'action': 'update_body',
        'chapter_id': chapter_id,
        'fragment_id': fragment_id,
    }


def _existing_translation_versions(s, book_id: str, chapter_id: str) -> list:
    """Inspect the chapter page and return one record per translation
    version present:
        {tr_id: str, user_id: str | None, is_empty: bool}

    Each version is wrapped as
        `<div id='t<tr_id>' class='u<user_id> ...'>
            <div class='text'>...</div>
         </div>`
    `is_empty` is True when the body div has no visible text content
    (the auto-created system stub renders as `<div class='text'><p></p></div>`).
    """
    from bs4 import BeautifulSoup
    r = s.get(f'https://tl.rulate.ru/book/{book_id}/{chapter_id}',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    if r.status_code != 200:
        return []
    soup = BeautifulSoup(r.text, 'html.parser')
    out = []
    for div in soup.select('div[id^="t"]'):
        m = re.match(r't(\d+)$', div.get('id') or '')
        if not m:
            continue
        tr_id = m.group(1)
        cls = ' '.join(div.get('class') or [])
        um = re.search(r'\bu(\d+)\b', cls)
        user_id = um.group(1) if um else None
        text_div = div.select_one('div.text')
        body = text_div.get_text(strip=True) if text_div else ''
        out.append({'tr_id': tr_id, 'user_id': user_id, 'is_empty': not body})
    return out


def _delete_tr_version(s, book_id: str, chapter_id: str,
                       fragment_id: str, tr_id: str):
    """POST `tr_rm` to delete one translation version from a fragment."""
    url = f'https://tl.rulate.ru/book/{book_id}/{chapter_id}/{fragment_id}/tr_rm'
    return s.post(
        url,
        headers={
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://tl.rulate.ru',
            'Referer': f'https://tl.rulate.ru/book/{book_id}/{chapter_id}',
            'X-Requested-With': 'XMLHttpRequest',
        },
        data=f'tr_id={tr_id}', allow_redirects=False, timeout=20,
    )


def _prune_versions(s, book_id: str, chapter_id: str, fragment_id: str,
                    user_id: str, keep_newest_ours: bool) -> int:
    """Remove housekeeping versions from a fragment so the chapter
    ends up with at most one of OUR translations and zero stubs.

    Always deletes:
      - empty versions (auto-stub `<p></p>` from chapter creation, or
        any later stub). They never carry useful content.

    Conditionally deletes our own versions (matched by `user_id`):
      - `keep_newest_ours=True` → keep the most recent (highest
        tr_id) version, drop all older ones. Used in the `skip`
        path so accumulated duplicates from prior buggy runs get
        cleaned up without losing the live content.
      - `keep_newest_ours=False` → drop ALL of our versions. Used
        in `create` / `update_body` paths because we're about to
        POST a fresh version that will become the only one.

    Other translators' (non-empty) versions are NEVER touched.
    Returns the number of versions deleted.
    """
    versions = _existing_translation_versions(s, book_id, chapter_id)
    if not versions:
        return 0
    ours = sorted(
        (v for v in versions if v['user_id'] == user_id),
        key=lambda v: int(v['tr_id']),
    )
    keep_id = ours[-1]['tr_id'] if (keep_newest_ours and ours) else None

    to_delete = []
    for v in versions:
        if v['is_empty']:
            to_delete.append(v)
            continue
        if v['user_id'] == user_id and v['tr_id'] != keep_id:
            to_delete.append(v)

    deleted = 0
    for v in to_delete:
        try:
            r = _delete_tr_version(s, book_id, chapter_id, fragment_id, v['tr_id'])
            if r.status_code in (200, 204, 302):
                deleted += 1
                print(f'  pruned tr_id={v["tr_id"]} (user={v["user_id"]}, empty={v["is_empty"]})')
            else:
                print(f'  prune failed for tr_id={v["tr_id"]}: status {r.status_code}')
        except Exception as e:
            print(f'  prune error for tr_id={v["tr_id"]}: {e}')
    return deleted


def _phase_b_post(s, html_body: str, book_id: str, chapter_id: str,
                  fragment_id: str, csrf: str):
    """Multipart POST that saves the translation HTML for the
    auto-created first fragment. Mirrors the curl observed in
    DevTools: Translation[body] + empty Translation[new_img] +
    ajax=1 + YII_CSRF_TOKEN."""
    from curl_cffi import CurlMime
    url = f'https://tl.rulate.ru/book/{book_id}/{chapter_id}/{fragment_id}/translate'
    print()
    print('=== Phase B POST (multipart) ===')
    print(f'URL:                {url}')
    print(f'Translation[body]:  {len(html_body)} bytes html')
    print(f'YII_CSRF_TOKEN:     {csrf[:25]}…')

    mp = CurlMime()
    mp.addpart(name='Translation[body]', data=html_body.encode('utf-8'))
    # Empty file part with explicit filename="" — matches what the
    # browser sends when no image is attached.
    mp.addpart(name='Translation[new_img]', filename='',
               content_type='application/octet-stream', data=b'')
    mp.addpart(name='ajax', data=b'1')
    mp.addpart(name='YII_CSRF_TOKEN', data=csrf.encode('utf-8'))
    return s.post(
        url,
        headers={
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Origin': 'https://tl.rulate.ru',
            'Referer': f'https://tl.rulate.ru/book/{book_id}/{chapter_id}',
        },
        multipart=mp, allow_redirects=False, timeout=60,
    )


# ----------------------------------------------------------------------
# Live full first: Phase A + Phase B for queue[0]
# ----------------------------------------------------------------------
def _process_queue_item(s, book_id: str, item: dict, env: dict, args,
                        csrf: str, user_id: "str | None", existing: dict) -> str:
    """Classify one queue item against rulate and execute the matching
    action. Mutates `existing` after a successful create so subsequent
    items see the new chapter. Returns one of:
        'created' | 'updated' | 'skipped'
    Raises on any HTTP / parse error (caller decides whether to keep
    going through the rest of the queue).

    All write paths (`create` / `update_body`) prune empty stubs and
    obsolete copies of our own translation BEFORE posting the fresh
    body — so each chapter ends up with exactly one of our versions
    and no system stub. The `skip` path also prunes (housekeeping —
    keeps the newest of our versions, drops empty stubs and any
    older accumulated duplicates from prior buggy runs).
    """
    decision = classify_queue_item(s, book_id, item, existing)
    if getattr(args, 'force_update', False) and decision['action'] == 'skip':
        # Force a body re-upload even though text matches — used after
        # PARA_TEMPLATE / format changes that don't show up in a text
        # diff but do change what rulate stores.
        chapter_id = decision['chapter_id']
        fragment_id = _find_first_fragment_id(s, book_id, chapter_id)
        decision = {
            'action': 'update_body',
            'chapter_id': chapter_id,
            'fragment_id': fragment_id,
        }
        print(f'  decision: skip → forced to update_body  (chapter_id={chapter_id})')
    else:
        print(f'  decision: {decision["action"]}'
              + (f"  (chapter_id={decision.get('chapter_id')})" if decision.get('chapter_id') else ''))

    if decision['action'] == 'skip':
        if user_id:
            chapter_id = decision['chapter_id']
            fragment_id = _find_first_fragment_id(s, book_id, chapter_id)
            if fragment_id:
                _prune_versions(s, book_id, chapter_id, fragment_id, user_id,
                                keep_newest_ours=True)
        return 'skipped'

    if decision['action'] == 'update_body':
        chapter_id = decision['chapter_id']
        fragment_id = decision['fragment_id']
        if not fragment_id:
            raise RuntimeError(f'no fragment_id for existing chapter {chapter_id}')
        if user_id:
            _prune_versions(s, book_id, chapter_id, fragment_id, user_id,
                            keep_newest_ours=False)
        body_html = render_chapter_body_html(item['paragraphs'])
        b_resp = _phase_b_post(s, body_html, book_id, chapter_id, fragment_id, csrf)
        if b_resp.status_code not in (200, 302):
            raise RuntimeError(f'Phase B (update) failed: status {b_resp.status_code}')
        print(f'  updated body of chapter {chapter_id} (fragment {fragment_id})')
        return 'updated'

    # action == 'create'
    a_resp = _phase_a_post(s, item, env, args, book_id)
    if a_resp.status_code not in (200, 302):
        raise RuntimeError(f'Phase A failed: status {a_resp.status_code}')
    chapter_id = _find_chapter_id_by_title(s, book_id, item['title'])
    if not chapter_id:
        raise RuntimeError(f'could not locate new chapter id by title')
    fragment_id = _find_first_fragment_id(s, book_id, chapter_id)
    if not fragment_id:
        raise RuntimeError(f'could not locate fragment id for new chapter {chapter_id}')
    if user_id:
        # New chapter ships with an auto-created empty stub. Drop it
        # before our POST so the chapter ends up with one version.
        _prune_versions(s, book_id, chapter_id, fragment_id, user_id,
                        keep_newest_ours=False)
    body_html = render_chapter_body_html(item['paragraphs'])
    b_resp = _phase_b_post(s, body_html, book_id, chapter_id, fragment_id, csrf)
    if b_resp.status_code not in (200, 302):
        raise RuntimeError(f'Phase B (create) failed: status {b_resp.status_code}')
    existing[item['title']] = chapter_id
    print(f'  created chapter {chapter_id} (fragment {fragment_id})')
    return 'created'


def live_full_first(queue: list[dict], env: dict, args) -> int:
    if not queue:
        print('queue is empty; nothing to do.', file=sys.stderr)
        return 1
    book_id = env.get('RULATE_BOOK_ID')
    if not book_id:
        print('RULATE_BOOK_ID is unset.', file=sys.stderr)
        return 1
    cookies = _auth_cookies(env)
    csrf = _csrf_from_cookie(cookies)
    if not csrf:
        print('Could not extract CSRF token from cookies.', file=sys.stderr)
        return 1
    user_id = _user_id_from_cookie(cookies)
    if user_id:
        print(f'rulate user_id: {user_id}')
    else:
        print('warning: could not extract user_id from cookies — version pruning disabled.')

    s = _make_session(env, cookies)
    if not _warm_up(s, book_id):
        print('warm-up failed; aborting.', file=sys.stderr)
        return 1

    existing = _existing_chapter_index(s, book_id)
    print(f'Existing chapters on rulate: {len(existing)}')

    item = queue[0]
    print(f'\n=== [1/1] {item["title"]!r} ===')
    try:
        outcome = _process_queue_item(s, book_id, item, env, args, csrf, user_id, existing)
    except Exception as e:
        print(f'  error: {e}', file=sys.stderr)
        return 1
    print(f'\nOutcome: {outcome}')
    return 0


def live_full_all(queue: list[dict], env: dict, args) -> int:
    if not queue:
        print('queue is empty; nothing to do.', file=sys.stderr)
        return 1
    book_id = env.get('RULATE_BOOK_ID')
    if not book_id:
        print('RULATE_BOOK_ID is unset.', file=sys.stderr)
        return 1
    cookies = _auth_cookies(env)
    csrf = _csrf_from_cookie(cookies)
    if not csrf:
        print('Could not extract CSRF token from cookies.', file=sys.stderr)
        return 1
    user_id = _user_id_from_cookie(cookies)
    if user_id:
        print(f'rulate user_id: {user_id}')
    else:
        print('warning: could not extract user_id from cookies — version pruning disabled.')

    s = _make_session(env, cookies)
    if not _warm_up(s, book_id):
        print('warm-up failed; aborting.', file=sys.stderr)
        return 1

    existing = _existing_chapter_index(s, book_id)
    print(f'Existing chapters on rulate: {len(existing)}')
    print('Queue: ' + _queue_size_summary(queue))

    import time
    stats = {'created': 0, 'updated': 0, 'skipped': 0, 'failed': 0}
    touched: list[dict] = []  # items actually pushed (created or updated)
    for i, item in enumerate(queue, start=1):
        print(f'\n=== [{i}/{len(queue)}] {item["title"]!r} '
              f'(part {item["part_index"]}/{item["total_parts"]} of source ch {item["source_chapter_index"]}) ===')
        try:
            outcome = _process_queue_item(s, book_id, item, env, args, csrf, user_id, existing)
            stats[outcome] += 1
            if outcome in ('created', 'updated'):
                touched.append(item)
        except Exception as e:
            print(f'  error: {e}', file=sys.stderr)
            stats['failed'] += 1
        # Be polite to rulate / DDoS-Guard between writes; this is
        # cheap and keeps long-running uploads from getting throttled.
        if i < len(queue):
            time.sleep(1.5)

    print('\n=== summary ===')
    for k in ('created', 'updated', 'skipped', 'failed'):
        print(f'  {k:8} {stats[k]}')
    # Size summary: full queue (always) + just-pushed subset (when any).
    print(f'  queue   {_queue_size_summary(queue)}')
    if touched:
        print(f'  pushed  {_queue_size_summary(touched)}')
    return 0 if stats['failed'] == 0 else 1


# ----------------------------------------------------------------------
# Live one-shot: send the Phase A POST for queue[0] and report.
# ----------------------------------------------------------------------
def live_create_first(queue: list[dict], env: dict, args) -> int:
    """Send a single Phase A POST for queue[0] via curl_cffi (Chrome
    TLS impersonation). Strategy: send only auth cookies (no
    DDoS-Guard ones); DDoS-Guard issues fresh `__ddg*` challenge cookies
    on first contact since our TLS / HTTP fingerprint matches a real
    Chrome. The session keeps them for the POST.

    Logs the full request and the full response — no retries, no
    follow-up calls.
    """
    if not queue:
        print('queue is empty; nothing to do.', file=sys.stderr)
        return 1
    item = queue[0]
    book_id = env.get('RULATE_BOOK_ID')
    if not book_id:
        print('RULATE_BOOK_ID is unset.', file=sys.stderr)
        return 1
    cookie_file = env.get('RULATE_COOKIE_FILE')
    if not cookie_file:
        print('RULATE_COOKIE_FILE is unset.', file=sys.stderr)
        return 1
    cookie = (Path(__file__).resolve().parent.parent / cookie_file).read_text(encoding='utf-8').strip()

    # Drop DDoS-Guard's challenge cookies — they get stale quickly and
    # DDoS-Guard reissues fresh ones for our Chrome-impersonating
    # session on the warm-up GET. Keep the rest (CSRF, phpsession, and
    # the long-name Yii auth cookie that varies per app deployment).
    auth_cookie = '; '.join(
        p for p in cookie.split('; ')
        if '=' in p and not p.split('=', 1)[0].startswith('__ddg')
    )
    if not auth_cookie:
        print('No auth cookies found in RULATE_COOKIE_FILE.', file=sys.stderr)
        return 1

    fields = build_phase_a_form(item, env, args)
    body = encode_form(fields)
    url = f'https://tl.rulate.ru/book/{book_id}/0/mass_edit?ajax=1&placement=0'

    print('=== LIVE Phase A POST (via curl_cffi, Chrome impersonation) ===')
    print(f'URL:    {url}')
    print(f'Title:  {item["title"]!r}')
    print('Form fields:')
    for k, v in fields:
        print(f'  {k!s:40} = {v!r}')
    print(f'Body:   {len(body)} bytes')
    print()

    # DDoS-Guard remembers fingerprints. If a chosen impersonation
    # gets flagged after a few requests, rotate the env override to
    # one of: chrome, chrome131, edge99, safari17_0, firefox.
    impersonate = (env.get('RULATE_CURL_IMPERSONATE', '') or 'chrome131').strip()
    print(f'curl_cffi impersonate: {impersonate}')
    from curl_cffi import requests as cr
    s = cr.Session(impersonate=impersonate)
    s.headers.update({
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': auth_cookie,
    })

    # Warm-up: GET the book page so DDoS-Guard issues fresh challenge
    # cookies for our session before we POST.
    warm = s.get(f'https://tl.rulate.ru/book/{book_id}',
                 headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'}, timeout=20)
    print(f'warm-up GET: status={warm.status_code}, len={len(warm.text)}')
    if warm.status_code >= 400 or '/logout' not in warm.text:
        print('warm-up failed (DDoS-Guard or auth). Aborting before any POST.', file=sys.stderr)
        return 1

    # POST through the same warmed-up session.
    resp = s.post(
        url,
        headers={
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://tl.rulate.ru',
            'Referer': f'https://tl.rulate.ru/book/{book_id}',
            'X-Requested-With': 'XMLHttpRequest',
        },
        data=body,
        allow_redirects=False,
        timeout=30,
    )
    text = resp.text
    print()
    print('=== Response ===')
    print(f'Status:   {resp.status_code}')
    for h in ('Location', 'Content-Type', 'Content-Length'):
        v = resp.headers.get(h)
        if v:
            print(f'  {h}: {v[:300]}')
    set_cookies = resp.headers.get_list('set-cookie') if hasattr(resp.headers, 'get_list') else []
    if set_cookies:
        print(f'  Set-Cookie x{len(set_cookies)}')
    print(f'Body ({len(text)} bytes):')
    print(text[:1500])
    if len(text) > 1500:
        print('  …(truncated)')

    new_ids = sorted(set(re.findall(rf'/book/{book_id}/(\d+)', text)))
    if new_ids:
        print()
        print(f'chapter ids referenced in response: {new_ids}')
    return 0 if resp.status_code in (200, 302) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
