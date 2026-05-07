#!/usr/bin/env python3
"""Discover candidate novels on m.qidian.com via the yuepiao rank.

Walks /rank/yuepiao/catid<N>/ for every catid in RANK_CATIDS (the
channel slugs harvested from the homepage). Each fetch yields 20 SSR
records; the URL `?page=N` parameter is silently ignored by Qidian's
SSR (pagination only works client-side via XHR), so we use catid
slugs as the discovery surface — ~250–350 unique book_ids per pass
after dedup across channels.

Re-running is idempotent.

Usage:
    python3 scripts/qidian-discover.py
    python3 scripts/qidian-discover.py --sleep 0.5 --output data/qidian/candidates.jsonl
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _qidian_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Discover qidian candidate books.')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='Seconds between catid fetches (default: 0.5).')
    p.add_argument('--output', default='data/qidian/candidates.jsonl',
                   help='Path to candidates JSONL.')
    p.add_argument('--quiet', action='store_true',
                   help='Suppress per-catid lines; only print final summary (cron-friendly).')
    p.add_argument('--lock', default='data/qidian/.discover.lock',
                   help='Lock file path; set empty to disable.')
    p.add_argument('--dry-run', action='store_true', help='Fetch and report but do not write.')
    return p.parse_args(argv)


def _run(args):
    seen = eng.load_candidate_book_ids(args.output)
    if not args.quiet:
        print(f'existing candidates: {len(seen)}')
    added = 0
    fetched = 0
    rc = 0
    for i, catid in enumerate(eng.RANK_CATIDS, 1):
        url = eng.build_yuepiao_url(catid=catid)
        try:
            html = eng.fetch_html(url)
        except RuntimeError as e:
            print(f'yuepiao catid={catid}: FETCH FAILED ({e})', flush=True)
            rc = 1
            continue
        try:
            records, _meta = eng.parse_yuepiao_records(html)
        except Exception as e:
            print(f'yuepiao catid={catid}: PARSE FAILED ({e})', flush=True)
            rc = 1
            continue
        fetched += 1
        new_on_page = 0
        ts = eng.now_iso()
        for entry in records:
            bid = entry.get('bid')
            bid = str(bid) if bid is not None else None
            if not bid or bid in seen:
                continue
            row = {
                'book_id': bid,
                'first_seen': ts,
                'discover_rank': 'yuepiao',
                'discover_catid': catid,
                'discover_rank_num': entry.get('rankNum'),
            }
            if not args.dry_run:
                eng.append_jsonl(args.output, row)
            seen.add(bid)
            new_on_page += 1
            added += 1
        if not args.quiet:
            print(f'  catid={catid}: {len(records)} records, {new_on_page} new '
                  f'(total candidates: {len(seen)})', flush=True)
        if i < len(eng.RANK_CATIDS):
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
    print(f'discover: fetched {fetched}/{len(eng.RANK_CATIDS)} catids, '
          f'added {added} new candidates'
          + (' (dry-run)' if args.dry_run else ''),
          flush=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
