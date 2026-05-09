#!/usr/bin/env python3
"""Snapshot fanqienovel candidates into a time-series JSONL.

For each candidate book_id, fetches /page/<book_id>, parses the embedded
INITIAL_STATE.page object, and appends one row to
data/fanqie/snapshots.jsonl with a UTC timestamp.

Schema (schema_version=1) — see _fanqie_engine.parse_book_detail.

Usage:
    python3 scripts/fanqie-snapshot.py
    python3 scripts/fanqie-snapshot.py --limit 50 --sleep 0.5
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _fanqie_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Snapshot fanqienovel candidates.')
    p.add_argument('--candidates', default='data/fanqie/candidates.jsonl',
                   help='Input candidates JSONL')
    p.add_argument('--output', default='data/fanqie/snapshots.jsonl',
                   help='Output snapshots JSONL')
    p.add_argument('--limit', type=int, default=0,
                   help='Cap how many candidates to fetch this run (0 = all)')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='Seconds between detail fetches (default: 0.5)')
    p.add_argument('--ids', nargs='+', default=None,
                   help='Override: snapshot exactly these book_ids')
    p.add_argument('--quiet', action='store_true',
                   help='Suppress per-25-novel progress; only print final summary')
    p.add_argument('--lock', default='data/fanqie/.snapshot.lock',
                   help='Lock file path; set empty to disable')
    p.add_argument('--failures', default='data/fanqie/failures.jsonl',
                   help='Where to record monitored books that failed both initial and retry fetch')
    p.add_argument('--max-consecutive-fails', type=int, default=20,
                   help='Abort after this many consecutive failures (default 20). 0 disables.')
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


def _permanently_dead_ids(failures_path, threshold=3):
    """book_ids that have failed with terminal HTTP 404 / Gone N times in a
    row — the book is gone from the platform; re-fetching every cron tick
    is wasted and pollutes failures.jsonl with duplicate rows."""
    consec = {}
    for row in eng.read_jsonl(failures_path):
        bid = row.get('book_id')
        if bid is None:
            continue
        err = (row.get('retry_error') or row.get('first_error') or '')
        if ('HTTP 404' in err or 'Not Found' in err
                or 'HTTP 410' in err or 'Gone' in err):
            consec[bid] = consec.get(bid, 0) + 1
        else:
            consec[bid] = 0
    return {bid for bid, n in consec.items() if n >= threshold}


def _snapshot_one(book_id, output_path):
    """Fetch one book and append a row. Returns (ok, error_message_or_None)."""
    url = eng.build_page_url(book_id)
    try:
        html = eng.fetch_html(url)
    except RuntimeError as e:
        return False, f'fetch: {e}'
    try:
        data = eng.parse_book_detail(html)
    except Exception as e:
        return False, f'parse: {e}'
    if not data.get('book_id'):
        # Page returned successfully but had no usable state (deleted /
        # restricted book). Surface as failure so verify catches the gap.
        return False, 'parse: empty page state (book may be removed)'
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
    dead = _permanently_dead_ids(args.failures)
    if dead:
        before = len(ids)
        ids = [b for b in ids if b not in dead]
        if not args.quiet:
            print(f'skipping {before - len(ids)} permanently-dead ids '
                  f'(404/Gone × ≥3 consecutive failures)')
    if args.limit > 0:
        ids = ids[:args.limit]
        if not args.quiet:
            print(f'limited to first {len(ids)}')
    if not ids:
        print('nothing to snapshot.', flush=True)
        return 0, 0, 0
    ok = 0
    failures = []
    consec_fail = 0
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
                      f'(probable WAF / rate-limit). {len(ids) - i} books skipped.',
                      flush=True)
                break
        if i < len(ids):
            eng.jittered_sleep(args.sleep)

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
    # Count how many of the unrecovered failures are "book removed" (404 /
    # Gone) vs system-level — surfaced to the summary line so the dashboard
    # can treat them differently.
    failed_404 = sum(
        1 for row in unrecovered
        if any(p in (row.get('retry_error') or row.get('first_error') or '')
               for p in ('HTTP 404', 'Not Found', 'HTTP 410', 'Gone'))
    )
    return ok, len(unrecovered), failed_404


def main(argv=None):
    args = parse_args(argv)
    if args.lock:
        try:
            with eng._Lock(args.lock):
                ok, failed, failed_404 = _run(args)
        except RuntimeError as e:
            print(f'snapshot: {e}', flush=True)
            sys.exit(75)
    else:
        ok, failed, failed_404 = _run(args)
    stats = eng.fetch_stats('fanqie')
    failed_other = failed - failed_404
    print(f'snapshot: {ok} ok (direct={stats["direct_ok"]} proxy_rescued={stats["proxy_rescued"]}), '
          f'{failed} failed (404={failed_404} other={failed_other}) -> {args.output}', flush=True)
    # Exit non-zero only when there are SYSTEM-level failures left
    # (a book legitimately removed from the platform isn't a cron alert).
    sys.exit(1 if failed_other else 0)


if __name__ == '__main__':
    main()
