#!/usr/bin/env python3
"""Publish translated chapters from a .md file to mirnovel.ru.

Two-phase upload mirroring publish-rulate.py: action=create_chapter
(Phase A, empty shell) then action=save_chapter (Phase B, title +
body + flags), both via `POST /editor_api`. Auth is scriptable —
POST /account with login + pass + btnlogin=1 sets a PHPSESSID
cookie that's persisted in cookies/mirnovel.txt for reuse.

Manifest: .mirnovel-state.json. Engine helpers (parser, splitter,
renderer, sentinel codec, hash, manifest persistence) imported from
`_publish_engine` so round-trip semantics stay identical to rulate.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _publish_engine import (  # noqa: E402
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


# load_env / subscription_for / delayed_for are duplicated rather than
# shared with publish-rulate.py — small plumbing helpers, see the saved
# memory on natural-duplication-over-overengineering.
def load_env(path: Path) -> dict:
    """Read a flat KEY=VALUE .env file. Splits on the first `=` so
    values may contain `=`."""
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


def _threshold_flag(source_chapter_index: int, env: dict, env_key: str):
    """env[env_key] = positive int N → True/False from `idx >= N`.
    Unset/blank/non-int → None (don't override; site default stands)."""
    raw = env.get(env_key, '').strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return source_chapter_index >= n


def subscription_for(source_chapter_index: int, env: dict):
    """Resolve the mirnovel "open" toggle (paid vs free) for a chapter.
    Returns True (force paid → `open=0`), False (force free → `open=1`)
    or None (don't override). Threshold key: MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER."""
    return _threshold_flag(source_chapter_index, env,
                           'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER')


def delayed_for(source_chapter_index: int, env: dict):
    """Resolve the mirnovel "Отложенная публикация" toggle for a chapter.
    Returns True (force `delayed=1`), False (force `delayed=0`) or None
    (don't override). Threshold key: MIRNOVEL_DELAYED_FROM_CHAPTER. Set
    to 7 by default so chapters 1..6 (already public on rulate) push
    immediately on mirnovel, and 7+ go on the deferred schedule."""
    return _threshold_flag(source_chapter_index, env,
                           'MIRNOVEL_DELAYED_FROM_CHAPTER')


# ----------------------------------------------------------------------
# Phase A / Phase B form bodies
# ----------------------------------------------------------------------
def build_phase_a_body(item: dict, env: dict) -> list:
    """`action=create_chapter` form fields. Mirnovel ignores
    `data.title` here (always defaults to "Новая глава") — we send it
    anyway so a future server-side change to honor it needs no script
    edit. The body lands in Phase B's save_chapter."""
    book_id = env.get('MIRNOVEL_BOOK_ID', '')
    data = {
        'title': item['title'],
        'body': '',
        'active': 0,
    }
    return [
        ('action', 'create_chapter'),
        ('book_id', str(book_id)),
        ('data', json.dumps(data, ensure_ascii=False)),
    ]


def build_phase_b_body(item: dict, env: dict, *,
                       chapter_id, html_body: str,
                       active: bool) -> list:
    """`action=save_chapter` form fields. Sets title + HTML body + four
    flags: `active` (0 draft / 1 published — from caller), `open`
    (0 paid / 1 free), `amount` (price; '0' = mirnovel auto-computes at
    1₽/1000 chars), `delayed` (0/1). chapter_id is sent both as an outer
    field and inside `data` to match the browser request shape.

    `open` / `delayed` resolve via, in order: an explicit per-item
    override (`item['open_override']` / `item['delayed_override']`,
    used by the rulate-copy flow to mirror rulate's actual state),
    then the env-threshold rule, then the site default."""
    sub = item.get('open_override',
                    subscription_for(item['source_chapter_index'], env))
    delayed = item.get('delayed_override',
                        delayed_for(item['source_chapter_index'], env))
    data = {
        'chapter_id': int(chapter_id),
        'title': item['title'],
        'body': html_body,
        'active': '1' if active else '0',
        'open': '1' if sub is False else ('0' if sub is True else '0'),
        'amount': '0',
        'delayed': 1 if delayed is True else 0,
    }
    return [
        ('action', 'save_chapter'),
        ('chapter_id', str(chapter_id)),
        ('data', json.dumps(data, ensure_ascii=False)),
    ]


def parse_chapter_index_from_manage_html(html: str) -> dict:
    """`{title → chapter_id}` from the manage-page HTML. Reads the
    `data-id` / `data-title` attrs on each `.chapter-item.manage-item`
    row — source-of-truth attrs, no HTML-escape surprises."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    out = {}
    for div in soup.select('.chapter-item.manage-item'):
        chid = div.get('data-id')
        title = div.get('data-title')
        if chid and title:
            out[title] = chid
    return out


_EDITOR_DATA_RE = re.compile(r'window\.EDITOR_DATA\s*=\s*(\{.*?\});', re.DOTALL)


def parse_chapter_body_from_editor_html(html: str) -> str:
    """Pull the chapter body out of the per-chapter editor's
    `window.EDITOR_DATA = {…, body: "<p>…</p>"}` seed and flatten it
    through `_inline_text_with_markdown` into the same sentinel form
    `_our_chapter_text` produces — that's what makes the comparison
    classify identically across publishers."""
    m = _EDITOR_DATA_RE.search(html)
    if not m:
        return ''
    # The seeded object is JS dict-literal, not JSON (unquoted keys);
    # rather than parse it all, just lift `body:"…"` directly.
    body_match = re.search(r'body:\s*"((?:\\.|[^"\\])*)"', m.group(1))
    if not body_match:
        return ''
    body_html = (body_match.group(1)
                 .replace('\\"', '"')
                 .replace('\\\\', '\\')
                 .replace('\\n', '\n')
                 .replace('\\/', '/'))
    if not body_html.strip():
        return ''
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(body_html, 'html.parser')
    paras = []
    for p in soup.find_all('p'):
        t = _inline_text_with_markdown(p).strip()
        if t:
            paras.append(_collapse_ws(t))
    return '\n\n'.join(paras)


MANIFEST_NAME = '.mirnovel-state.json'


def _manifest_path() -> Path:
    return Path(__file__).resolve().parent.parent / MANIFEST_NAME


def _load_manifest() -> dict:
    return _engine_load_manifest(_manifest_path())


def _save_manifest(manifest: dict) -> None:
    _engine_save_manifest(_manifest_path(), manifest)


def _make_session(env: dict, cookies: str = ''):
    """curl_cffi session with chrome131 TLS impersonation (mirnovel
    fronts a small Cloudflare / DDoS-Guard layer that rejects vanilla
    requests). Optional cookie string seeded as `key=value; …`."""
    from curl_cffi import requests as cffi_requests
    s = cffi_requests.Session(impersonate='chrome131')
    if cookies:
        for pair in cookies.split(';'):
            pair = pair.strip()
            if '=' in pair:
                k, _, v = pair.partition('=')
                s.cookies.set(k.strip(), v.strip(), domain='mirnovel.ru')
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/146.0.0.0 Safari/537.36',
    })
    return s


def _login_and_save_cookie(env: dict, cookie_path: Path) -> bool:
    """GET / to seed PHPSESSID, POST /account to authenticate, persist
    the resulting PHPSESSID into `cookie_path` for reuse."""
    login = env.get('MIRNOVEL_LOGIN', '')
    password = env.get('MIRNOVEL_PASSWORD', '')
    if not login or not password:
        print('MIRNOVEL_LOGIN / MIRNOVEL_PASSWORD missing in .env',
              file=sys.stderr)
        return False
    s = _make_session(env)
    s.get('https://mirnovel.ru/', timeout=20)
    r = s.post('https://mirnovel.ru/account',
               data={
                   'login': login, 'pass': password,
                   'btnlogin': '1', 'remember': '1',
               },
               headers={
                   'X-Requested-With': 'XMLHttpRequest',
                   'Origin': 'https://mirnovel.ru',
                   'Referer': 'https://mirnovel.ru/',
               },
               timeout=30)
    try:
        body = r.json()
    except Exception:
        print(f'login: non-JSON response (HTTP {r.status_code})', file=sys.stderr)
        return False
    if not body.get('ok'):
        print(f'login failed: {body}', file=sys.stderr)
        return False
    # Mirnovel's `editor_api` write actions (create_chapter, save_chapter,
    # …) check BOTH cookies, even though the read-only get_* probes
    # accept PHPSESSID alone — without `user_token_v3` they return
    # `{"success":false,"error":"Не авторизован"}`. Persist both.
    pairs = []
    for name in ('PHPSESSID', 'user_token_v3'):
        v = s.cookies.get(name, domain='mirnovel.ru')
        if v:
            pairs.append(f'{name}={v}')
    if pairs:
        cookie_path.parent.mkdir(parents=True, exist_ok=True)
        cookie_path.write_text('; '.join(pairs), encoding='utf-8')
    return True


def _read_cookie_file(path: Path) -> str:
    if not path.exists():
        return ''
    return path.read_text(encoding='utf-8').strip()


def _editor_api_post(s, env: dict, fields: list) -> dict:
    """POST form-encoded `fields` to /editor_api; return parsed JSON."""
    book_id = env.get('MIRNOVEL_BOOK_ID', '')
    referer = f'https://mirnovel.ru/editor/{book_id}/0?mode=manage'
    r = s.post('https://mirnovel.ru/editor_api',
               data=fields,
               headers={
                   'Origin': 'https://mirnovel.ru',
                   'Referer': referer,
                   'Content-Type': 'application/x-www-form-urlencoded',
               },
               timeout=30)
    try:
        return r.json()
    except Exception:
        return {'success': False, 'error': f'non-JSON response (HTTP {r.status_code})'}


def _phase_a_post(s, item: dict, env: dict):
    """Create chapter shell; return chapter_id or None on failure."""
    fields = build_phase_a_body(item, env)
    print('=== Phase A POST ===')
    print(f"  action=create_chapter  title={item['title']!r}")
    body = _editor_api_post(s, env, fields)
    if not body.get('success'):
        print(f"  FAILED: {body.get('error', body)}")
        return None
    chapter_id = body.get('chapter_id') or body.get('chapter', {}).get('Id')
    print(f'  created chapter_id={chapter_id}')
    return chapter_id


def _phase_b_post(s, item: dict, env: dict, *,
                  chapter_id, html_body: str, active: bool):
    """Save title + body + flags; return True on success."""
    fields = build_phase_b_body(item, env, chapter_id=chapter_id,
                                 html_body=html_body, active=active)
    # Read the resolved flags out of the actual JSON body that's about
    # to be POSTed — that respects per-item overrides (the rulate-copy
    # path uses these to mirror rulate's real state instead of the env
    # threshold defaults).
    data = json.loads(next(v for k, v in fields if k == 'data'))
    print('=== Phase B POST ===')
    print(f"  action=save_chapter  chapter_id={chapter_id}  "
          f"title={item['title']!r}  bytes={len(html_body)}  "
          f"active={data['active']}  "
          f"open={data['open']}  "
          f"delayed={data['delayed']}")
    body = _editor_api_post(s, env, fields)
    if not body.get('success'):
        print(f"  FAILED: {body.get('error', body)}")
        return False
    print(f'  saved')
    return True


def _existing_chapter_index(s, env: dict) -> dict:
    book_id = env.get('MIRNOVEL_BOOK_ID', '')
    r = s.get(f'https://mirnovel.ru/editor/{book_id}/0?mode=manage',
              headers={'Referer': f'https://mirnovel.ru/my_book/{book_id}?tabs=stat'},
              timeout=30)
    if r.status_code != 200:
        return {}
    return parse_chapter_index_from_manage_html(r.text)


def _existing_chapter_text(s, env: dict, chapter_id: str) -> "str | None":
    """Sentinel-form chapter body for the comparison path. Reads
    `window.EDITOR_DATA` from the per-chapter editor page."""
    book_id = env.get('MIRNOVEL_BOOK_ID', '')
    r = s.get(f'https://mirnovel.ru/editor/{book_id}/{chapter_id}',
              headers={'Referer': f'https://mirnovel.ru/editor/{book_id}/0?mode=manage'},
              timeout=30)
    if r.status_code != 200:
        return None
    return parse_chapter_body_from_editor_html(r.text)


def classify_queue_item(s, env: dict, item: dict, existing: dict) -> dict:
    """skip / update_body / create — same trichotomy as rulate's
    classify; site-specific chapter-index + body fetch underneath."""
    title = item['title']
    if title not in existing:
        return {'action': 'create'}
    chapter_id = existing[title]
    current = _existing_chapter_text(s, env, chapter_id)
    expected = _our_chapter_text(item['paragraphs'])
    if current == expected:
        return {'action': 'skip', 'chapter_id': chapter_id}
    return {
        'action': 'update_body',
        'chapter_id': chapter_id,
        'rulate_text': current or '',  # name kept for compat with engine helper
        'local_text': expected,
    }


def _confirm_overwrite(item, decision, manifest, state) -> bool:
    """Auto-True on manifest match; otherwise prompt with the diff."""
    chapter_id = str(decision['chapter_id'])
    server_hash = _body_hash(decision['rulate_text'])
    entry = manifest.get(chapter_id) or {}
    last_pushed_hash = entry.get('hash')
    if last_pushed_hash == server_hash:
        print('  manifest match: safe to overwrite '
              '(no external edits since last push)')
        return True
    if state.get('all_yes'):
        return True
    if state.get('all_no'):
        return False
    reason = ('no manifest entry — first push of this chapter via the script'
              if last_pushed_hash is None else
              'manifest mismatch — mirnovel body has changed since our last push')
    print(f'\n  ⚠ Confirm overwrite of {item["title"]!r}: {reason}')
    if last_pushed_hash:
        when = entry.get('last_pushed_at', '?')
        print(f'    our last push: {last_pushed_hash[:12]}… at {when}')
        print(f'    mirnovel now:  {server_hash[:12]}…')
    hunks, total = _format_first_n_hunks(
        decision['rulate_text'], decision['local_text'], n=5,
    )
    if not hunks:
        print('  (no visible text diff — formatting/markup change only;')
        print('   pushing will replace literal `**` with <strong>/<em>)')
    else:
        for h in hunks:
            for line in h:
                print(line)
        if total > len(hunks):
            print(f'  ... ({total - len(hunks)} more hunk(s) not shown)')
    while True:
        ans = input('  Overwrite? [y/n/Y(=yes-to-all)/N(=no-to-all)] ').strip()
        if ans == 'y': return True
        if ans == 'n': return False
        if ans == 'Y':
            state['all_yes'] = True
            return True
        if ans == 'N':
            state['all_no'] = True
            return False


def _process_queue_item(s, env: dict, item: dict, existing: dict,
                         manifest: dict, state: dict, args) -> str:
    """Returns 'created' | 'updated' | 'skipped' | 'declined' | 'failed'."""
    decision = classify_queue_item(s, env, item, existing)
    if getattr(args, 'force_update', False) and decision['action'] == 'skip':
        decision = {
            'action': 'update_body',
            'chapter_id': decision['chapter_id'],
            'rulate_text': '',
            'local_text': _our_chapter_text(item['paragraphs']),
        }
        print(f'  decision: skip → forced to update_body  (chapter_id={decision["chapter_id"]})')
    else:
        print(f"  decision: {decision['action']}", end='')
        if 'chapter_id' in decision:
            print(f"  (chapter_id={decision['chapter_id']})")
        else:
            print()
    if decision['action'] == 'skip':
        return 'skipped'
    html_body = render_chapter_body_html(item['paragraphs'])
    if decision['action'] == 'update_body':
        if not _confirm_overwrite(item, decision, manifest, state):
            print('  declined.')
            return 'declined'
        chapter_id = decision['chapter_id']
        ok = _phase_b_post(s, item, env,
                           chapter_id=chapter_id, html_body=html_body,
                           active=getattr(args, 'publish_active', False))
        if not ok:
            return 'failed'
        _record_manifest(manifest, chapter_id,
                         _our_chapter_text(item['paragraphs']))
        return 'updated'
    # create
    chapter_id = _phase_a_post(s, item, env)
    if not chapter_id:
        return 'failed'
    ok = _phase_b_post(s, item, env,
                       chapter_id=chapter_id, html_body=html_body,
                       active=getattr(args, 'publish_active', False))
    if not ok:
        return 'failed'
    _record_manifest(manifest, chapter_id,
                     _our_chapter_text(item['paragraphs']))
    return 'created'


def dry_run(queue: list, env: dict, args) -> None:
    book_id = env.get('MIRNOVEL_BOOK_ID', '<unset>')
    print(f'mirnovel book {book_id} (login {env.get("MIRNOVEL_LOGIN", "?")}) — DRY RUN')
    target = int(env.get('MIRNOVEL_TARGET_CHARS_NO_SPACES', '5000') or '5000')
    print(f'split target: {target} chars (no spaces) per part')
    print(f'queue size: {len(queue)} chapter(s) to upload')
    print(_queue_size_summary(queue))
    print()
    for i, item in enumerate(queue, 1):
        sub = subscription_for(item['source_chapter_index'], env)
        delayed = delayed_for(item['source_chapter_index'], env)
        print(f"[{i:>3}] {item['title']!r}  "
              f"(part {item['part_index']}/{item['total_parts']} of source ch "
              f"{item['source_chapter_index']})")
        print(f'      paragraphs: {len(item["paragraphs"])}  '
              f'chars(no-ws): {chapter_no_space_chars(item["paragraphs"])}')
        print(f'      Phase A: action=create_chapter  body=""  active=0')
        print(f'      Phase B: action=save_chapter  '
              f'open={"1" if sub is False else "0"}  '
              f'delayed={"1" if delayed is True else "0"}  '
              f'amount=0 (auto = 1₽/1000 chars when paid)')
        if args.show_payload and i == 1:
            print('      Phase A urlencoded body:')
            print('       ', encode_form(build_phase_a_body(item, env)))
            print('      Phase B urlencoded body (chapter_id=PLACEHOLDER):')
            html_body = render_chapter_body_html(item['paragraphs'])
            print('       ', encode_form(build_phase_b_body(
                item, env, chapter_id='PLACEHOLDER',
                html_body=html_body, active=False)))
        print()


def _ensure_session(env: dict):
    """Logged-in session. Reuses cookies/mirnovel.txt; logs in fresh
    when the file is missing or the cookie has expired."""
    cookie_file = env.get('MIRNOVEL_COOKIE_FILE', 'cookies/mirnovel.txt')
    repo = Path(__file__).resolve().parent.parent
    cookie_path = (repo / cookie_file).resolve()
    cookies = _read_cookie_file(cookie_path)
    if not cookies:
        print('no cookie file — performing scripted login')
        if not _login_and_save_cookie(env, cookie_path):
            return None
        cookies = _read_cookie_file(cookie_path)
    s = _make_session(env, cookies)
    # An expired session redirects /editor/* to the login modal. Detect
    # it by the page <title> rather than the status code (mirnovel
    # serves it as 200 with the login form rendered).
    book_id = env.get('MIRNOVEL_BOOK_ID', '')
    r = s.get(f'https://mirnovel.ru/editor/{book_id}/0?mode=manage', timeout=30)
    if '<title>Авторизация</title>' in r.text:
        print('cookie expired — performing scripted login')
        if not _login_and_save_cookie(env, cookie_path):
            return None
        cookies = _read_cookie_file(cookie_path)
        s = _make_session(env, cookies)
    return s


def live_full_all(queue: list, env: dict, args) -> int:
    s = _ensure_session(env)
    if s is None:
        return 2
    existing = _existing_chapter_index(s, env)
    print(f'Existing chapters on mirnovel: {len(existing)}')
    print(f'Queue: {_queue_size_summary(queue)}')
    manifest = _load_manifest()
    state = {'all_yes': False, 'all_no': False}
    counts = {'created': 0, 'updated': 0, 'skipped': 0, 'declined': 0, 'failed': 0}
    for i, item in enumerate(queue, 1):
        print()
        print(f"=== [{i}/{len(queue)}] '{item['title']}' "
              f"(part {item['part_index']}/{item['total_parts']} of source ch "
              f"{item['source_chapter_index']}) ===")
        result = _process_queue_item(s, env, item, existing, manifest, state, args)
        counts[result] = counts.get(result, 0) + 1
        if result in ('created', 'updated'):
            _save_manifest(manifest)
    print()
    print('=== summary ===')
    for k in ('created', 'updated', 'skipped', 'declined', 'failed'):
        print(f'  {k:<8} {counts[k]}')
    print(f'  queue   {_queue_size_summary(queue)}')
    return 0 if counts['failed'] == 0 else 1


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(
        prog='publish-mirnovel',
        description='Publish translated chapters from a .md file to mirnovel.ru.',
    )
    parser.add_argument('md', help='Path to the .md export of the translation')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print what would be uploaded without HTTP calls.')
    parser.add_argument('--show-payload', action='store_true',
                        help='With --dry-run, also print the urlencoded POST body for the first chapter.')
    parser.add_argument('--live-full-all', action='store_true',
                        help='Phase A + B for every queued chapter (skip/update_body/create classified per chapter).')
    parser.add_argument('--up-to', type=int, default=None, metavar='N',
                        help='Limit to source chapters with index <= N.')
    parser.add_argument('--from', dest='from_source', type=int, default=None, metavar='N',
                        help='Start from source chapter index N (1-based, inclusive).')
    parser.add_argument('--publish-active', action='store_true',
                        help='Send active=1 («Опубликовать»). Default: active=0 (draft).')
    parser.add_argument('--yes-to-all', action='store_true',
                        help='Skip the per-chapter overwrite prompt; use with care.')
    args = parser.parse_args(argv[1:])

    repo = Path(__file__).resolve().parent.parent
    env = load_env(repo / '.env')
    target = int(env.get('MIRNOVEL_TARGET_CHARS_NO_SPACES', '5000') or '5000')

    md_path = Path(args.md).expanduser().resolve()
    chapters = parse_chapters_md(md_path.read_text(encoding='utf-8'))
    for src_idx, ch in enumerate(chapters, start=1):
        ch['_source_index'] = src_idx
    if args.from_source is not None:
        if args.from_source < 1:
            print(f'--from must be >= 1', file=sys.stderr); return 2
        chapters = [c for c in chapters if c['_source_index'] >= args.from_source]
        print(f'--from {args.from_source}: {len(chapters)} chapter(s) remain.')
    if args.up_to is not None:
        if args.up_to < 1:
            print(f'--up-to must be >= 1', file=sys.stderr); return 2
        chapters = [c for c in chapters if c['_source_index'] <= args.up_to]
        print(f'--up-to {args.up_to}: {len(chapters)} chapter(s) remain.')
    queue = build_upload_queue(chapters, target=target)

    if args.dry_run:
        dry_run(queue, env, args); return 0
    if args.live_full_all:
        return live_full_all(queue, env, args)
    print('No mode selected. Use --dry-run or --live-full-all.', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
