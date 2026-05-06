#!/usr/bin/env python3
"""Publish translated chapters from a .md file to tl.rulate.ru.

Two-phase upload per chapter:
  Phase A (POST /book/<id>/0/mass_edit) creates a chapter shell with
  metadata (title, status, subscription, deferred-publish, …).
  Phase B (POST /book/<id>/<ch>/<frag>/translate) uploads the rendered
  HTML body. Chapters that already exist on rulate are classified as
  skip / update_body / create against the live book before any write.

Auth uses a browser-extracted Cookie header (rulate sits behind
DDoS-Guard; scripted login is fragile). See cookies/rulate.txt and
the RULATE_* keys in .env.

Pure engine helpers (parser, splitter, renderer, sentinel codec, hash,
manifest persistence) are imported from `_publish_engine`.
"""


import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _publish_engine import (
    PARA_TEMPLATE,
    _BOLD_MARK, _EM_MARK, _INLINE_MD_RE,
    parse_chapters_md, normalize_chapter_title,
    no_space_chars, chapter_no_space_chars, _queue_size_summary,
    compute_parts, split_paragraphs_balanced, build_upload_queue,
    html_escape, render_inline_md, render_paragraph_html, render_chapter_body_html,
    _canonicalize_inline_md, _inline_text_with_markdown,
    _humanize_sentinels, _collapse_ws,
    _our_chapter_text,
    _body_hash, _format_first_n_hunks,
    encode_form,
    record_manifest as _record_manifest,
    load_manifest as _engine_load_manifest,
    save_manifest as _engine_save_manifest,
)


def load_env(path: Path) -> dict:
    """Read a flat KEY=VALUE .env file. Splits on the first `=` so
    values may contain `=`. Cookies live in their own file (see
    RULATE_COOKIE_FILE) to dodge .env shell-escaping headaches."""
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


# --- below: rulate-specific HTTP, auth, scraping, form fields, orchestration ---


def subscription_for(source_chapter_index: int, env: dict):
    """`Подписка` toggle: True forces on, False forces off, None means
    don't override (env key unset/blank/non-int)."""
    raw = env.get('RULATE_SUBSCRIPTION_FROM_CHAPTER', '').strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return source_chapter_index >= n


STATUS_CODES = {
    'идёт перевод': '1',
    'перевод редактируется': '2',
    'перевод готов': '3',
}

ACCESS_LEVEL_MODERATORS = 'm'
ACCESS_FIELDS = ('ac_read', 'ac_trread', 'ac_gen', 'ac_rate', 'ac_comment', 'ac_tr')


def build_phase_a_form(item: dict, env: dict, args) -> list[tuple[str, str]]:
    """Form fields for the Phase A POST (creates a chapter shell).

    Returns (key, value) pairs rather than a dict because rulate's
    Yii-style fields appear twice for booleans: a hidden `=0` default
    plus an optional `=1` override that Yii merges as the final value.
    `Chapter[title][]` is also repeatable for batched uploads.
    """
    fields: list[tuple[str, str]] = []
    fields.append(('Chapter[title][]', item['title']))
    fields.append(('Chapter[volume]', args.volume or ''))
    status_value = STATUS_CODES.get(args.status, args.status)
    fields.append(('Chapter[status]', status_value))
    if getattr(args, 'moderators_only', False):
        fields.append(('Chapter[has_override]', '1'))
        for ac in ACCESS_FIELDS:
            fields.append((f'Chapter[{ac}]', ACCESS_LEVEL_MODERATORS))
    # post_open = «Отложенная публикация» (deferred until book schedule).
    fields.append(('Chapter[post_open]', '0'))
    if getattr(args, 'deferred_publish', False):
        fields.append(('Chapter[post_open]', '1'))
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
        access_str = ('special_access=true  access_levels=Модераторы'
                      if getattr(args, 'moderators_only', False)
                      else 'special_access=(default, inherits book settings)')
        deferred_str = 'on' if getattr(args, 'deferred_publish', True) else 'off'
        print(f'      Phase A: volume={args.volume!r}  status={args.status!r}  '
              f'{access_str}  deferred_publish={deferred_str}  subscription={sub_str}')

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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog='publish-rulate',
        description='Publish translated chapters from a .md file to tl.rulate.ru.',
    )
    parser.add_argument('md', help='Path to the .md export of the translation')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print what would be uploaded without HTTP calls.')
    parser.add_argument('--show-payload', action='store_true',
                        help='With --dry-run, also print the exact urlencoded POST body for the first chapter.')
    parser.add_argument('--live-create-first', action='store_true',
                        help='Phase A only, first chapter only — sanity-check the create flow.')
    parser.add_argument('--live-full-first', action='store_true',
                        help='Phase A + B, first chapter only — sanity-check the full flow.')
    parser.add_argument('--live-full-all', action='store_true',
                        help='Phase A + B for every queued chapter (skip/update_body/create classified per chapter).')
    parser.add_argument('--volume', default='',
                        help='«Том / Арка» on every chapter. Empty by default.')
    parser.add_argument('--status', default='перевод редактируется',
                        help='«Статус»: «идёт перевод» / «перевод редактируется» / «перевод готов».')
    parser.add_argument('--up-to', type=int, default=None, metavar='N',
                        help='Limit processing to source chapters with index <= N.')
    parser.add_argument('--from', dest='from_source', type=int, default=None, metavar='N',
                        help='Start from source chapter N (1-based, inclusive). Original index preserved for the subscription rule.')
    parser.add_argument('--force-update', action='store_true',
                        help='Re-upload bodies whose text already matches — useful after a renderer/template change.')
    parser.add_argument('--moderators-only', action='store_true',
                        help='Enable «Особые права доступа» = «Модераторы» (moderator-only draft mode).')
    parser.add_argument('--deferred-publish', action=argparse.BooleanOptionalAction, default=True,
                        help='Tick «Отложенная публикация» (release on book schedule). On by default.')
    parser.add_argument('--yes-to-all', action='store_true',
                        help='Skip the per-chapter overwrite prompt; non-interactive overwrite of every diverged chapter.')
    parser.add_argument('--skip-rulate-edited', action='store_true',
                        help='Inverse of --yes-to-all: skip every chapter whose rulate body '
                             'has diverged from our last push, OR isn\'t in the manifest. '
                             'Use to safely re-run a publish without clobbering rulate-side edits.')
    args = parser.parse_args(argv[1:])

    repo = Path(__file__).resolve().parent.parent
    env = load_env(repo / '.env')
    target = int(env.get('RULATE_TARGET_CHARS_NO_SPACES', '5000') or '5000')

    md_path = Path(args.md).expanduser().resolve()
    chapters = parse_chapters_md(md_path.read_text(encoding='utf-8'))
    # Tag with the original 1-based index so it survives --from/--up-to slicing
    # (subscription rule keys on the absolute number, not the position).
    for src_idx, ch in enumerate(chapters, start=1):
        ch['_source_index'] = src_idx
    if args.from_source is not None:
        if args.from_source < 1:
            print(f'--from must be >= 1 (got {args.from_source})', file=sys.stderr)
            return 2
        chapters = [c for c in chapters if c['_source_index'] >= args.from_source]
        print(f'--from {args.from_source}: starting at chapter {args.from_source}, '
              f'{len(chapters)} chapter(s) remain.')
    if args.up_to is not None:
        if args.up_to < 1:
            print(f'--up-to must be >= 1 (got {args.up_to})', file=sys.stderr)
            return 2
        chapters = [c for c in chapters if c['_source_index'] <= args.up_to]
        print(f'--up-to {args.up_to}: keeping chapters with index <= {args.up_to}; '
              f'{len(chapters)} chapter(s) remain.')
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
    # We flatten with `_inline_text_with_markdown` rather than plain
    # `.get_text()` so `<strong>` / `<em>` boundaries survive into
    # the comparison form (sentinel-wrapped) and stay distinct from
    # a literal `**...**` text node left over from a pre-renderer-fix
    # push.
    candidates = []
    for div in soup.select('div.text'):
        paras = []
        for p in div.find_all('p'):
            t = _inline_text_with_markdown(p).strip()
            if t:
                paras.append(_collapse_ws(t))
        if paras:
            candidates.append('\n\n'.join(paras))
    if not candidates:
        return ''
    # Use the longest version — that's our most-recent body, in the
    # presence of multiple translation variants.
    return max(candidates, key=len)


def classify_queue_item(s, book_id: str, item: dict, existing: dict) -> dict:
    """Decide skip / update_body / create for a queue item against rulate.
    Read-only: doesn't mutate anything. `update_body` returns both texts
    so the caller can show a diff before overwriting."""
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
        'rulate_text': current or '',
        'local_text': expected,
    }


# Manifest = `{chapter_id → {hash, last_pushed_at}}` per chapter, used to
# distinguish "rulate body == our last push" (safe to overwrite) from
# "rulate body has external edits since" (prompt before overwrite).
MANIFEST_NAME = '.rulate-state.json'


def _manifest_path() -> Path:
    return Path(__file__).resolve().parent.parent / MANIFEST_NAME


def _load_manifest() -> dict:
    return _engine_load_manifest(_manifest_path())


def _save_manifest(manifest: dict) -> None:
    _engine_save_manifest(_manifest_path(), manifest)


def _initial_state(args) -> dict:
    """Per-run prompt state seeded from CLI flags.
        --yes-to-all          → all_yes  (overwrite every diverged chapter)
        --skip-rulate-edited  → all_no   (skip every diverged chapter — manifest
                                          match path still overwrites freely)
    The two are mutually exclusive in spirit; when both are set, --yes-to-all
    wins because the manifest-match check happens first in _confirm_overwrite."""
    return {
        'all_yes': bool(getattr(args, 'yes_to_all', False)),
        'all_no':  bool(getattr(args, 'skip_rulate_edited', False)),
    }


def _confirm_overwrite(item: dict, decision: dict, manifest: dict,
                       state: dict) -> bool:
    """Auto-True when manifest hash matches rulate's current hash (we're
    the only ones who could have produced the diff). Otherwise prompt
    with the diff and accept y / n / Y / N."""
    chapter_id = str(decision['chapter_id'])
    rulate_hash = _body_hash(decision['rulate_text'])
    entry = manifest.get(chapter_id) or {}
    last_pushed_hash = entry.get('hash')

    if last_pushed_hash == rulate_hash:
        print('  manifest match: safe to overwrite (no external edits since last push)')
        return True

    if state.get('all_yes'):
        return True
    if state.get('all_no'):
        return False

    reason = 'no manifest entry — first push of this chapter via the script' \
             if last_pushed_hash is None else \
             'manifest mismatch — rulate body has changed since our last push'
    print(f'\n  ⚠ Confirm overwrite of {item["title"]!r}: {reason}')
    if last_pushed_hash:
        when = entry.get('last_pushed_at', '?')
        print(f'    our last push: {last_pushed_hash[:12]}… at {when}')
        print(f'    rulate now:    {rulate_hash[:12]}…')

    hunks, total = _format_first_n_hunks(
        decision['rulate_text'], decision['local_text'], n=5,
    )
    if not hunks:
        print('  (no textual diff at line level — whitespace-only change?)')
    else:
        print(f'  --- diff (- rulate, + local), first {len(hunks)} of {total} change(s) ---')
        for hunk in hunks:
            for line in hunk:
                print('  ' + line.rstrip())
        if total > len(hunks):
            print(f'  … (and {total - len(hunks)} more change(s) not shown)')

    if not sys.stdin.isatty():
        print('  stdin is not a TTY — cannot prompt. Skipping this chapter to be safe. '
              'Re-run with --yes-to-all if you want unattended overwrites.', file=sys.stderr)
        return False
    while True:
        ans = input('  Overwrite? [y]es / [n]o / [a]bort / [Y]es-to-all / [N]o-to-all: ').strip()
        if ans == 'y': return True
        if ans == 'n': return False
        if ans == 'a': raise SystemExit('aborted by user')
        if ans == 'Y':
            state['all_yes'] = True
            return True
        if ans == 'N':
            state['all_no'] = True
            return False
        print('  unknown answer; expected y / n / a / Y / N')


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
                        csrf: str, user_id: "str | None", existing: dict,
                        manifest: dict, state: dict) -> str:
    """Classify + execute one queue item. Returns 'created' | 'updated' |
    'skipped'. Mutates `existing` after a create, `manifest` after any
    successful body push. `--force-update` rewrites a `skip` decision to
    `update_body` (used after a renderer/template change that's invisible
    in a text-level diff but changes what rulate actually stores)."""
    decision = classify_queue_item(s, book_id, item, existing)
    if getattr(args, 'force_update', False) and decision['action'] == 'skip':
        chapter_id = decision['chapter_id']
        fragment_id = _find_first_fragment_id(s, book_id, chapter_id)
        rulate_text = _existing_chapter_text(s, book_id, chapter_id) or ''
        local_text = _our_chapter_text(item['paragraphs'])
        decision = {
            'action': 'update_body',
            'chapter_id': chapter_id,
            'fragment_id': fragment_id,
            'rulate_text': rulate_text,
            'local_text': local_text,
        }
        print(f'  decision: skip → forced to update_body  (chapter_id={chapter_id})')
    else:
        print(f'  decision: {decision["action"]}'
              + (f"  (chapter_id={decision.get('chapter_id')})" if decision.get('chapter_id') else ''))

    if decision['action'] == 'skip':
        chapter_id = decision['chapter_id']
        # Manifest gets the hash even on skip — gives future runs a
        # match-point so the overwrite prompt stays out of the way.
        _record_manifest(manifest, chapter_id, _our_chapter_text(item['paragraphs']))
        if user_id:
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

        # Conflict gate — manifest match → no prompt; otherwise prompt
        # (unless `--yes-to-all`).
        if not getattr(args, 'yes_to_all', False):
            if not _confirm_overwrite(item, decision, manifest, state):
                print('  declined; chapter left as-is')
                return 'skipped'

        if user_id:
            _prune_versions(s, book_id, chapter_id, fragment_id, user_id,
                            keep_newest_ours=False)
        body_html = render_chapter_body_html(item['paragraphs'])
        b_resp = _phase_b_post(s, body_html, book_id, chapter_id, fragment_id, csrf)
        if b_resp.status_code not in (200, 302):
            raise RuntimeError(f'Phase B (update) failed: status {b_resp.status_code}')
        _record_manifest(manifest, chapter_id, decision['local_text'])
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
    _record_manifest(manifest, chapter_id, _our_chapter_text(item['paragraphs']))
    print(f'  created chapter {chapter_id} (fragment {fragment_id})')
    return 'created'


# `_record_manifest` is imported from `_publish_engine` as an alias at
# the top of this file — same hash + timestamp logic, no site-specific
# bits, so both publishers produce identical manifest entries.


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

    manifest = _load_manifest()
    state = _initial_state(args)

    item = queue[0]
    print(f'\n=== [1/1] {item["title"]!r} ===')
    try:
        outcome = _process_queue_item(s, book_id, item, env, args, csrf, user_id,
                                      existing, manifest, state)
    except Exception as e:
        print(f'  error: {e}', file=sys.stderr)
        return 1
    finally:
        _save_manifest(manifest)
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

    manifest = _load_manifest()
    state = _initial_state(args)

    import time
    stats = {'created': 0, 'updated': 0, 'skipped': 0, 'failed': 0}
    touched: list[dict] = []  # items actually pushed (created or updated)
    for i, item in enumerate(queue, start=1):
        print(f'\n=== [{i}/{len(queue)}] {item["title"]!r} '
              f'(part {item["part_index"]}/{item["total_parts"]} of source ch {item["source_chapter_index"]}) ===')
        try:
            outcome = _process_queue_item(s, book_id, item, env, args, csrf, user_id,
                                          existing, manifest, state)
            stats[outcome] += 1
            if outcome in ('created', 'updated'):
                touched.append(item)
        except Exception as e:
            print(f'  error: {e}', file=sys.stderr)
            stats['failed'] += 1
        finally:
            # Persist manifest after every iteration — a later failure
            # mustn't lose the entries we already populated, and
            # `skip`-path entries also need to land on disk.
            _save_manifest(manifest)
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
