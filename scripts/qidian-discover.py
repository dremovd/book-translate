#!/usr/bin/env python3
"""Discover candidate novels on m.qidian.com via two rank surfaces.

Walks BOTH /rank/yuepiao/catid<N>/ (popularity ranking) AND
/rank/newbook/catid<N>/ (newest-published ranking) for every catid in
RANK_CATIDS, harvests the SSR pageData.records (≤20 books per slug),
and appends new book_ids to data/qidian/candidates.jsonl with the
rank type + catid + rank_num the row came from.

Discovery surface after dedup across channels & rank types:
- yuepiao : ~280 popular novels (millions of chars, established)
- newbook : ~300 newly-published novels (10k–200k chars, chapter 1–~50)
- combined: ~500-580 unique books per pass — the only path to truly
  brand-new novels on Qidian's mobile site.

The `?page=` URL param is dead (SSR ignores it). Catid slugs are the
only working axis for URL-based discovery. Re-running is idempotent.

Usage:
    python3 scripts/qidian-discover.py                            # both surfaces
    python3 scripts/qidian-discover.py --rank-types newbook       # newest only
    python3 scripts/qidian-discover.py --rank-types yuepiao       # popularity only
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _qidian_engine as eng


RANK_URL_BUILDERS = {
    'yuepiao': eng.build_yuepiao_url,
    'newbook': eng.build_newbook_url,
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Discover qidian candidate books.')
    p.add_argument('--rank-types', nargs='+', default=['yuepiao', 'newbook'],
                   choices=list(RANK_URL_BUILDERS),
                   help='Which rank surfaces to walk (default: both).')
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


def _walk_rank(rank_type, args, seen):
    """Walk one rank surface (yuepiao OR newbook) across all catids.

    Returns (added, fetched, rc). Populates `seen` in place so a second
    surface walk doesn't re-add ids harvested by the first.
    """
    build = RANK_URL_BUILDERS[rank_type]
    added = 0
    fetched = 0
    rc = 0
    for i, catid in enumerate(eng.RANK_CATIDS, 1):
        url = build(catid=catid)
        try:
            html = eng.fetch_html(url)
        except RuntimeError as e:
            print(f'{rank_type} catid={catid}: FETCH FAILED ({e})', flush=True)
            rc = 1
            continue
        try:
            records, _meta = eng.parse_rank_records(html)
        except Exception as e:
            print(f'{rank_type} catid={catid}: PARSE FAILED ({e})', flush=True)
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
                'discover_rank': rank_type,
                'discover_catid': catid,
                'discover_rank_num': entry.get('rankNum'),
            }
            if not args.dry_run:
                eng.append_jsonl(args.output, row)
            seen.add(bid)
            new_on_page += 1
            added += 1
        if not args.quiet:
            print(f'  {rank_type} catid={catid}: {len(records)} records, {new_on_page} new '
                  f'(total candidates: {len(seen)})', flush=True)
        if i < len(eng.RANK_CATIDS):
            time.sleep(args.sleep)
    return added, fetched, rc


def _run(args):
    seen = eng.load_candidate_book_ids(args.output)
    if not args.quiet:
        print(f'existing candidates: {len(seen)}')
    total_added = 0
    total_fetched = 0
    overall_rc = 0
    for rank_type in args.rank_types:
        if not args.quiet:
            print(f'--- rank surface: {rank_type} ---', flush=True)
        added, fetched, rc = _walk_rank(rank_type, args, seen)
        total_added += added
        total_fetched += fetched
        overall_rc = overall_rc or rc
    return total_added, total_fetched, overall_rc


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
    expected = len(eng.RANK_CATIDS) * len(args.rank_types)
    print(f'discover: fetched {fetched}/{expected} catid×rank-type slots, '
          f'added {added} new candidates'
          + (' (dry-run)' if args.dry_run else ''),
          flush=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
