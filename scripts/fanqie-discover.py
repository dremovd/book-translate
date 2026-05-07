#!/usr/bin/env python3
"""Discover candidate novels on fanqienovel.com via rank pages.

Walks every (gender × category) entry in RANK_CATEGORIES, fetching
``/rank?gender=N&category_id=K`` and extracting the server-rendered
``state.rank.book_list`` (≤10 books per category). Each new book_id is
appended to data/fanqie/candidates.jsonl with a first-seen timestamp.

Re-running is idempotent.

Usage:
    python3 scripts/fanqie-discover.py
    python3 scripts/fanqie-discover.py --sleep 0.5 --output data/fanqie/candidates.jsonl
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _fanqie_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Discover fanqienovel candidate books.')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='Seconds between rank-page fetches (default: 0.5)')
    p.add_argument('--output', default='data/fanqie/candidates.jsonl',
                   help='Path to candidates JSONL (default: data/fanqie/candidates.jsonl)')
    p.add_argument('--quiet', action='store_true',
                   help='Suppress per-category lines; only print final summary (cron-friendly)')
    p.add_argument('--lock', default='data/fanqie/.discover.lock',
                   help='Lock file path; set empty to disable')
    p.add_argument('--dry-run', action='store_true', help='Fetch and report but do not write')
    return p.parse_args(argv)


def _run(args):
    seen = eng.load_candidate_book_ids(args.output)
    if not args.quiet:
        print(f'existing candidates: {len(seen)}')
    added = 0
    fetched = 0
    rc = 0
    for i, (gender, category_id, name) in enumerate(eng.RANK_CATEGORIES, 1):
        url = eng.build_rank_url(gender=gender, category_id=category_id)
        try:
            html = eng.fetch_html(url)
        except RuntimeError as e:
            print(f'rank g={gender} cat={category_id}: FETCH FAILED ({e})', flush=True)
            rc = 1
            continue
        try:
            books = eng.parse_rank_book_list(html)
        except Exception as e:
            print(f'rank g={gender} cat={category_id}: PARSE FAILED ({e})', flush=True)
            rc = 1
            continue
        fetched += 1
        ts = eng.now_iso()
        new_on_page = 0
        for entry in books:
            bid = entry.get('bookId')
            if not bid or bid in seen:
                continue
            row = {
                'book_id': bid,
                'first_seen': ts,
                'discover_gender': gender,
                'discover_category_id': category_id,
                'discover_category_name': name,
            }
            if not args.dry_run:
                eng.append_jsonl(args.output, row)
            seen.add(bid)
            new_on_page += 1
            added += 1
        if not args.quiet:
            print(f'  g={gender} cat={category_id} {name}: {len(books)} books, '
                  f'{new_on_page} new (total candidates: {len(seen)})', flush=True)
        if i < len(eng.RANK_CATEGORIES):
            time.sleep(args.sleep)
    return added, fetched, rc


def main(argv=None):
    args = parse_args(argv)
    if args.lock:
        try:
            with eng._Lock(args.lock):
                added, fetched, rc = _run(args)
        except RuntimeError as e:
            print(f'discover: {e}', flush=True)
            sys.exit(75)
    else:
        added, fetched, rc = _run(args)
    print(f'discover: fetched {fetched}/{len(eng.RANK_CATEGORIES)} categories, '
          f'added {added} new candidates' + (' (dry-run)' if args.dry_run else ''),
          flush=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
