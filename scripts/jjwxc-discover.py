#!/usr/bin/env python3
"""Discover candidate novels on jjwxc.net by paginating bookbase.

Walks the bookbase listing sorted by newest-published (sortType=3) for the
first --pages pages, harvests novel_ids, and appends each new id to
data/jjwxc/candidates.jsonl with a first-seen timestamp.

Re-running is idempotent: ids already in candidates.jsonl are skipped.
The candidate file is the input to jjwxc-snapshot.py.

Usage:
    python3 scripts/jjwxc-discover.py --pages 50
    python3 scripts/jjwxc-discover.py --pages 100 --sleep 1.5 --output data/jjwxc/candidates.jsonl
"""

import argparse
import sys
import time
from pathlib import Path

# allow `python3 scripts/jjwxc-discover.py` from repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _jjwxc_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Discover jjwxc candidate novels.')
    p.add_argument('--pages', type=int, default=50, help='Number of bookbase pages to walk (default: 50)')
    p.add_argument('--start-page', type=int, default=1, help='First page index (default: 1)')
    p.add_argument('--sort-type', type=int, default=3, help='bookbase sortType (default: 3 = newest published)')
    p.add_argument('--isfinish', type=int, default=1, help='isfinish filter (default: 1 = ongoing)')
    p.add_argument('--sleep', type=float, default=0.3,
                   help='Seconds between page fetches (default: 0.3, measured tolerance is well under this)')
    p.add_argument('--output', default='data/jjwxc/candidates.jsonl', help='Path to candidates JSONL')
    p.add_argument('--dry-run', action='store_true', help='Fetch and report but do not write')
    p.add_argument('--quiet', action='store_true', help='Suppress per-page lines; only print final summary (cron-friendly)')
    p.add_argument('--lock', default='data/jjwxc/.discover.lock',
                   help='Lock file path (prevents overlapping cron runs). Set empty to disable.')
    return p.parse_args(argv)


def _run(args):
    seen = eng.load_candidate_ids(args.output)
    if not args.quiet:
        print(f'existing candidates: {len(seen)}')
    added = 0
    fetched_pages = 0
    for page in range(args.start_page, args.start_page + args.pages):
        url = eng.build_bookbase_url(sort_type=args.sort_type, page=page, isfinish=args.isfinish)
        try:
            html = eng.fetch_html(url)
        except RuntimeError as e:
            # Always loud: cron should email this.
            print(f'page {page}: FETCH FAILED ({e}); stopping', flush=True)
            return added, fetched_pages, 1
        ids = eng.parse_bookbase_listing(html)
        fetched_pages += 1
        new_on_page = [n for n in ids if n not in seen]
        ts = eng.now_iso()
        for nid in new_on_page:
            row = {'novel_id': nid, 'first_seen': ts, 'discover_page': page,
                   'sort_type': args.sort_type, 'isfinish': args.isfinish}
            if not args.dry_run:
                eng.append_jsonl(args.output, row)
            seen.add(nid)
            added += 1
        if not args.quiet:
            print(f'page {page}: {len(ids)} ids, {len(new_on_page)} new (total candidates: {len(seen)})')
        if not ids:
            if not args.quiet:
                print(f'page {page}: empty listing — stopping')
            break
        if page < args.start_page + args.pages - 1:
            time.sleep(args.sleep)
    return added, fetched_pages, 0


def main(argv=None):
    args = parse_args(argv)
    if args.lock:
        try:
            with eng._Lock(args.lock):
                added, fetched_pages, rc = _run(args)
        except RuntimeError as e:
            print(f'discover: {e}', flush=True)
            sys.exit(75)  # EX_TEMPFAIL — cron will retry
    else:
        added, fetched_pages, rc = _run(args)
    print(f'discover: fetched {fetched_pages} pages, added {added} new candidates' +
          (' (dry-run, nothing written)' if args.dry_run else ''),
          flush=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
