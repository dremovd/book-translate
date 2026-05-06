#!/usr/bin/env python3
"""Copy chapters from rulate to mirnovel.

For chapters that already live on rulate (and where rulate has edits
the local .md doesn't carry), this fetches the current body from
rulate and publishes it to mirnovel — straight from one publisher to
the other, no local source consulted. Typical use: backfilling
mirnovel with chapters 1..N that were public on rulate before
mirnovel existed.

Reuses each publisher's HTTP / auth helpers; the engine sentinel
codec handles the round-trip so bold/italic survive the copy as
real <strong>/<em> on the mirnovel side.
"""

import argparse
import importlib.util
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))


def _load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pr = _load_module('publish_rulate', 'publish-rulate.py')
mn = _load_module('publish_mirnovel', 'publish-mirnovel.py')

from _publish_engine import (  # noqa: E402
    _humanize_sentinels, _our_chapter_text,
    record_manifest as _record_manifest,
)


_TITLE_RE = re.compile(r'^Глава\s+(\d+)(?:\.(\d+))?\b')


def parse_chapter_title(title: str):
    """Lift `(source_chapter_index, part_index)` from a rulate-style
    "Глава N" or "Глава N.K" title. Returns (None, None) when the
    title doesn't fit (caller drops it from the copy queue)."""
    m = _TITLE_RE.match(title or '')
    if not m:
        return None, None
    src = int(m.group(1))
    part = int(m.group(2)) if m.group(2) else 1
    return src, part


def parse_chapter_params_from_edit_html(html: str) -> dict:
    """Read the publish-state flags from a rulate `/book/<id>/<ch>/edit`
    page. Returns `{'subscription': bool, 'post_open': bool, 'status': str|None}`.
    `status` is the value of the selected `<option>` in
    `<select name="Chapter[status]">` — '1' / '2' / '3' for
    идёт перевод / редактируется / готов. Used by the copy flow to
    mirror rulate's actual state to mirnovel rather than rederiving
    paid/free + deferred from env thresholds, and to filter the queue
    via --published-or-ready."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    out = {'subscription': False, 'post_open': False, 'status': None}
    for el in soup.select('input[type="checkbox"]'):
        name = el.get('name', '')
        if name == 'Chapter[subscription]' and el.has_attr('checked'):
            out['subscription'] = True
        elif name == 'Chapter[post_open]' and el.has_attr('checked'):
            out['post_open'] = True
    sel = soup.find('select', attrs={'name': 'Chapter[status]'})
    if sel is not None:
        chosen = sel.find('option', selected=True)
        if chosen is not None:
            out['status'] = chosen.get('value')
    return out


def _published_or_ready(item: dict) -> bool:
    """Filter predicate for `--published-or-ready`. Keep when:
        - the chapter is already public on rulate (post_open=False), OR
        - it's deferred but the editing-stage marker says ready
          (rulate_status='3' / «перевод готов»).
    Anything else (deferred + still in progress / editing / unknown
    status) is dropped — pushing it to mirnovel would mean publishing
    unfinished work."""
    if not item.get('delayed_override'):
        return True
    return item.get('rulate_status') == '3'


def _fetch_rulate_chapter_params(s, book_id: str, chapter_id) -> dict:
    """GET the rulate edit page for one chapter; parse out the
    publish-state flags. Returns the parsed dict, or
    `{'subscription': False, 'post_open': False}` on fetch failure
    (no override; falls back to the threshold-based default)."""
    r = s.get(f'https://tl.rulate.ru/book/{book_id}/{chapter_id}/edit',
              headers={'Referer': f'https://tl.rulate.ru/book/{book_id}'},
              timeout=20)
    if r.status_code != 200:
        return {'subscription': False, 'post_open': False}
    return parse_chapter_params_from_edit_html(r.text)


def _rulate_session(env: dict):
    """Spin up the rulate session using the cookie file (no scriptable
    login on rulate; user keeps DDoS-Guard-fresh cookies in cookies/rulate.txt)."""
    cookie_file = env.get('RULATE_COOKIE_FILE', 'cookies/rulate.txt')
    cookies = (_HERE.parent / cookie_file).read_text(encoding='utf-8').strip()
    s = pr._make_session(env, cookies)
    book_id = env.get('RULATE_BOOK_ID', '')
    if not pr._warm_up(s, book_id):
        return None
    return s


def _build_copy_queue(rulate_session, env, args) -> list:
    """For each rulate chapter in scope (source-chapter-index range),
    fetch the current body and shape a mirnovel queue item with the
    paragraphs in `**bold**`/`*italic*` markdown form (the queue item
    shape `_process_queue_item` expects — it goes through
    `_our_chapter_text` and `render_chapter_body_html` from there)."""
    book_id = env.get('RULATE_BOOK_ID', '')
    index = pr._existing_chapter_index(rulate_session, book_id)
    print(f'rulate chapter index: {len(index)} entries')
    queue = []
    for title, chapter_id in index.items():
        src, part = parse_chapter_title(title)
        if src is None:
            print(f'  skip (untitled-pattern): {title!r}')
            continue
        if args.from_source is not None and src < args.from_source:
            continue
        if args.up_to is not None and src > args.up_to:
            continue
        body = pr._existing_chapter_text(rulate_session, book_id, chapter_id)
        if not body:
            print(f'  skip (empty body on rulate): {title!r}')
            continue
        paragraphs = [_humanize_sentinels(p) for p in body.split('\n\n') if p]
        params = _fetch_rulate_chapter_params(rulate_session, book_id, chapter_id)
        queue.append({
            'title': title,
            'paragraphs': paragraphs,
            'source_chapter_index': src,
            'part_index': part,
            'total_parts': 1,
            # Mirror rulate's actual flags onto the mirnovel push:
            #   subscription=True  → paid on rulate    → open=0 on mirnovel
            #   subscription=False → free on rulate    → open=1 on mirnovel
            #   post_open=True     → deferred on rulate → delayed=1 on mirnovel
            #   post_open=False    → immediate on rulate → delayed=0 on mirnovel
            # build_phase_b_body picks these up via the *_override keys.
            'open_override': params['subscription'],
            'delayed_override': params['post_open'],
            'rulate_status': params['status'],
        })
    queue.sort(key=lambda it: (it['source_chapter_index'], it['part_index']))
    return queue


def dry_run(queue, env, args):
    print(f'queue: {len(queue)} chapter(s) ready to copy')
    active = '1' if args.publish_active else '0'
    for i, item in enumerate(queue, 1):
        sub = item['open_override']
        delayed = item['delayed_override']
        st = item.get('rulate_status') or '?'
        chars = sum(len(p) for p in item['paragraphs'])
        print(f"[{i:>2}] {item['title']:<14}  "
              f"src ch {item['source_chapter_index']}.{item['part_index']}  "
              f"paragraphs: {len(item['paragraphs']):>3}  chars: {chars:>5}  "
              f"active={active}  "
              f"open={'0' if sub else '1'}  "
              f"delayed={'1' if delayed else '0'}  "
              f"rulate_status={st}")


def live_copy(queue, env, args) -> int:
    s = mn._ensure_session(env)
    if s is None:
        print('mirnovel session unavailable', file=sys.stderr)
        return 2
    existing = mn._existing_chapter_index(s, env)
    print(f'mirnovel chapter index: {len(existing)} entries')
    manifest = mn._load_manifest()
    # Copy semantics: always replace the mirnovel-side body with what
    # rulate has, even when the body would otherwise classify as `skip`
    # (force_update) and even on first-time pushes (state.all_yes).
    args.force_update = True
    state = {'all_yes': True, 'all_no': False}
    counts = {'created': 0, 'updated': 0, 'skipped': 0,
              'declined': 0, 'failed': 0}
    for i, item in enumerate(queue, 1):
        print()
        print(f"=== [{i}/{len(queue)}] {item['title']} "
              f"(src ch {item['source_chapter_index']}.{item['part_index']}) ===")
        result = mn._process_queue_item(s, env, item, existing,
                                         manifest, state, args)
        counts[result] = counts.get(result, 0) + 1
        if result in ('created', 'updated'):
            mn._save_manifest(manifest)
    print()
    print('=== summary ===')
    for k in ('created', 'updated', 'skipped', 'declined', 'failed'):
        print(f'  {k:<8} {counts[k]}')
    return 0 if counts['failed'] == 0 else 1


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(
        prog='copy-rulate-to-mirnovel',
        description='Copy chapters from rulate to mirnovel (rulate is source of truth).',
    )
    parser.add_argument('--dry-run', action='store_true',
                        help='Build the copy queue and print it; no mirnovel writes.')
    parser.add_argument('--from', dest='from_source', type=int, default=None,
                        metavar='N',
                        help='Start at source chapter index N (1-based, inclusive).')
    parser.add_argument('--up-to', type=int, default=None, metavar='N',
                        help='Stop at source chapter index <= N.')
    parser.add_argument('--published-or-ready', action='store_true',
                        help='Keep only chapters that are already public on '
                             'rulate (post_open off) OR that are scheduled '
                             'with status «перевод готов» (status=3). Drops '
                             'in-progress / still-editing chapters that '
                             'aren\'t public yet.')
    parser.add_argument('--as-draft', action='store_true',
                        help='Push as draft (active=0). Default: active=1, '
                             'mirroring rulate where these chapters are public.')
    args = parser.parse_args(argv[1:])
    # Copy semantics — params mirror rulate state. `open` / `delayed` come
    # from the MIRNOVEL_*_FROM_CHAPTER env thresholds (matched to rulate's);
    # `active` defaults to 1 because the copy queue is built from chapters
    # ALREADY PUBLIC on rulate. `--as-draft` overrides for staged copies.
    args.publish_active = not args.as_draft

    env = pr.load_env(_HERE.parent / '.env')

    rulate_session = _rulate_session(env)
    if rulate_session is None:
        print('rulate session unavailable (cookie file?)', file=sys.stderr)
        return 2
    queue = _build_copy_queue(rulate_session, env, args)

    if args.published_or_ready:
        before = len(queue)
        queue = [it for it in queue if _published_or_ready(it)]
        dropped = before - len(queue)
        if dropped:
            print(f'--published-or-ready: dropped {dropped} chapter(s) '
                  f'(deferred + status<3); kept {len(queue)}.')

    if not queue:
        print('nothing to copy.', file=sys.stderr)
        return 0
    if args.dry_run:
        dry_run(queue, env, args); return 0
    return live_copy(queue, env, args)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
