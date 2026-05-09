#!/usr/bin/env python3
"""Snapshot qidian candidates into a time-series JSONL.

For each candidate book_id, fetches /book/<book_id>, parses the embedded
Vite SSR pageContext.pageProps.pageData.bookInfo, appends one row to
data/qidian/snapshots.jsonl with a UTC timestamp.

Schema (schema_version=1) — see _qidian_engine.parse_book_detail.

Usage:
    python3 scripts/qidian-snapshot.py
    python3 scripts/qidian-snapshot.py --limit 50 --sleep 0.5
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _qidian_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Snapshot qidian candidates.')
    p.add_argument('--candidates', default='data/qidian/candidates.jsonl')
    p.add_argument('--output', default='data/qidian/snapshots.jsonl')
    p.add_argument('--limit', type=int, default=0,
                   help='Cap how many candidates to fetch this run (0 = all).')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='Seconds between detail fetches (default: 0.5).')
    p.add_argument('--ids', nargs='+', default=None,
                   help='Override: snapshot exactly these book_ids.')
    p.add_argument('--quiet', action='store_true',
                   help='Suppress per-25-novel progress; only print final summary.')
    p.add_argument('--lock', default='data/qidian/.snapshot.lock',
                   help='Lock file path; set empty to disable.')
    p.add_argument('--failures', default='data/qidian/failures.jsonl',
                   help='Where to record monitored books that failed both initial and retry fetch.')
    p.add_argument('--max-consecutive-fails', type=int, default=20,
                   help='Abort the snapshot pass after this many consecutive failures (default 20). '
                        'Guards against WAF/rate-limit episodes that would otherwise hang for hours '
                        'or tank the per-novel budget. 0 disables.')
    p.add_argument('--cycle-hours', type=float, default=0,
                   help='Skip books whose latest snapshot is younger than N hours. '
                        '0 (default) = no filter. Use with --limit for "frequent '
                        'small batches" cron pattern.')
    return p.parse_args(argv)


def _candidate_ids(path):
    seen = set()
    out = []
    for row in eng.read_jsonl(path):
        bid = row.get('book_id')
        if isinstance(bid, str) and bid and bid not in seen:
            seen.add(bid)
            out.append(bid)
    return out


def _snapshot_one(book_id, output_path):
    """Fetch one book and append a row. Returns (ok, error_message_or_None)."""
    url = eng.build_book_url(book_id)
    try:
        html = eng.fetch_html(url)
    except RuntimeError as e:
        return False, f'fetch: {e}'
    try:
        data = eng.parse_book_detail(html)
    except Exception as e:
        return False, f'parse: {e}'
    if not data.get('book_id'):
        return False, 'parse: empty pageData.bookInfo (book may be removed or restricted)'
    row = {'ts': eng.now_iso(), **data}
    eng.append_jsonl(output_path, row)
    return True, None


def _run(args):
    if args.ids:
        ids = list(args.ids)
        if not args.quiet:
            print(f'snapshotting {len(ids)} ids passed via --ids')
    else:
        ids = _candidate_ids(args.candidates)
        if not args.quiet:
            print(f'loaded {len(ids)} candidates from {args.candidates}')
    if args.cycle_hours and args.cycle_hours > 0:
        before = len(ids)
        ids = eng.filter_by_cycle(ids, args.output, 'book_id', args.cycle_hours)
        if not args.quiet:
            print(f'cycle-hours={args.cycle_hours}: {len(ids)} due '
                  f'(skipped {before - len(ids)} fresh-enough)')
    if args.limit > 0:
        ids = ids[:args.limit]
        if not args.quiet:
            print(f'limited to first {len(ids)}')
    if not ids:
        print('nothing to snapshot.', flush=True)
        return 0, 0
    ok = 0
    failures = []
    consec_fail = 0
    aborted_at = None
    for i, bid in enumerate(ids, 1):
        success, err = _snapshot_one(bid, args.output)
        if success:
            ok += 1
            consec_fail = 0
            if not args.quiet and (i % 25 == 0 or i == len(ids)):
                print(f'  [{i}/{len(ids)}] last: {bid}', flush=True)
        else:
            consec_fail += 1
            print(f'  [{i}/{len(ids)}] book {bid}: {err}', flush=True)
            failures.append((bid, err))
            if args.max_consecutive_fails and consec_fail >= args.max_consecutive_fails:
                print(f'  ABORTING — {consec_fail} consecutive failures '
                      f'(probable WAF / rate-limit). {len(ids) - i} books skipped this run.',
                      flush=True)
                aborted_at = i
                break
        if i < len(ids):
            time.sleep(args.sleep)

    unrecovered = []
    if failures:
        print(f'\nretry pass: {len(failures)} failed initially', flush=True)
        for j, (bid, err) in enumerate(failures, 1):
            backoff = min(args.sleep * 4 * j, 30.0)
            time.sleep(backoff)
            success, err2 = _snapshot_one(bid, args.output)
            if success:
                ok += 1
                print(f'  retry [{j}/{len(failures)}] book {bid}: ok', flush=True)
            else:
                print(f'  retry [{j}/{len(failures)}] book {bid}: STILL FAILING ({err2})', flush=True)
                unrecovered.append({'ts': eng.now_iso(), 'book_id': bid,
                                    'first_error': err, 'retry_error': err2})
        if unrecovered:
            for row in unrecovered:
                eng.append_jsonl(args.failures, row)
    return ok, len(unrecovered)


def main(argv=None):
    args = parse_args(argv)
    if args.lock:
        try:
            with eng._Lock(args.lock):
                ok, failed = _run(args)
        except RuntimeError as e:
            print(f'snapshot: {e}', flush=True)
            sys.exit(75)
    else:
        ok, failed = _run(args)
    print(f'snapshot: {ok} ok, {failed} failed -> {args.output}', flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
