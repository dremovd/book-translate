#!/usr/bin/env python3
"""Snapshot jjwxc novel metadata into a time-series JSONL.

Reads candidate ids from candidates.jsonl (output of jjwxc-discover.py),
fetches each novel's onebook detail page, parses the Schema.org itemprops,
and appends one row per novel per run to snapshots.jsonl. Each row carries
a UTC timestamp so later analytics can compute per-novel growth curves.

Schema:
    {"ts": "...Z", "novel_id": int, "title": str, "author": str,
     "genre": str, "word_count": int, "chapter_count": int,
     "collects": int, "reviews": int, "score": int, "status": str,
     "last_update": "YYYY-MM-DD HH:MM:SS", "tags": [str, ...]}

Re-running on the same day is fine — every run appends a new snapshot row.

Usage:
    python3 scripts/jjwxc-snapshot.py
    python3 scripts/jjwxc-snapshot.py --limit 50 --sleep 1.5
    python3 scripts/jjwxc-snapshot.py --candidates data/jjwxc/candidates.jsonl \\
        --output data/jjwxc/snapshots.jsonl
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _jjwxc_engine as eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Snapshot jjwxc candidates.')
    p.add_argument('--candidates', default='data/jjwxc/candidates.jsonl',
                   help='Input candidates JSONL (default: data/jjwxc/candidates.jsonl)')
    p.add_argument('--output', default='data/jjwxc/snapshots.jsonl',
                   help='Output snapshots JSONL (default: data/jjwxc/snapshots.jsonl)')
    p.add_argument('--limit', type=int, default=0,
                   help='Cap how many candidates to fetch this run (0 = all)')
    p.add_argument('--sleep', type=float, default=0.3,
                   help='Seconds between detail fetches (default: 0.3, measured tolerance is well under this)')
    p.add_argument('--ids', nargs='+', type=int, default=None,
                   help='Override: snapshot exactly these novel_ids (skip candidates file)')
    p.add_argument('--quiet', action='store_true',
                   help='Suppress per-25-novel progress; only print final summary (cron-friendly)')
    p.add_argument('--lock', default='data/jjwxc/.snapshot.lock',
                   help='Lock file path (prevents overlapping cron runs). Set empty to disable.')
    p.add_argument('--failures', default='data/jjwxc/failures.jsonl',
                   help='Where to record monitored novels that failed both initial and retry fetch.')
    p.add_argument('--max-consecutive-fails', type=int, default=20,
                   help='Abort after this many consecutive failures (default 20). 0 disables.')
    p.add_argument('--cycle-hours', type=float, default=0,
                   help='Skip novels whose latest snapshot is younger than N hours. '
                        '0 (default) = no filter, snapshot all candidates. Use with '
                        '--limit for "frequent small batches" cron pattern, e.g. '
                        '--cycle-hours 24 --limit 30 every 15 min ⇒ each book hit once/day.')
    return p.parse_args(argv)


def _candidate_ids(path):
    """Return novel_ids from candidates JSONL in registry order."""
    seen = set()
    out = []
    for row in eng.read_jsonl(path):
        nid = row.get('novel_id')
        if isinstance(nid, int) and nid not in seen:
            seen.add(nid)
            out.append(nid)
    return out


def _permanently_dead_ids(failures_path, id_field, threshold=3):
    """ids that have failed `threshold` times in a row with a permanent
    error (HTTP 404 / Not Found / Gone). The platform removed the book;
    no amount of retrying brings it back, and re-fetching every cron tick
    just pollutes failures.jsonl with duplicate rows. Skip them.
    """
    consec = {}
    for row in eng.read_jsonl(failures_path):
        nid = row.get(id_field)
        if nid is None:
            continue
        err = (row.get('retry_error') or row.get('first_error') or '')
        is_terminal = ('HTTP 404' in err or 'Not Found' in err
                       or 'HTTP 410' in err or 'Gone' in err)
        if is_terminal:
            consec[nid] = consec.get(nid, 0) + 1
        else:
            # Any non-terminal failure resets the streak — book may yet recover.
            consec[nid] = 0
    return {nid for nid, n in consec.items() if n >= threshold}


def _snapshot_one(nid, output_path):
    """Fetch one novel and append a row. Returns (ok, error_message_or_None)."""
    url = eng.build_onebook_url(nid)
    try:
        # referer = bookbase listing because that's where browser-nav users
        # actually came from; cookie jar shared with discover.
        html = eng.fetch_html(url, jar_key='jjwxc',
                               referer='https://www.jjwxc.net/bookbase.php')
    except RuntimeError as e:
        return False, f'fetch: {e}'
    try:
        data = eng.parse_onebook_html(html)
    except Exception as e:
        return False, f'parse: {e}'
    row = {'ts': eng.now_iso(), 'novel_id': nid, **data}
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
        ids = eng.filter_by_cycle(ids, args.output, 'novel_id', args.cycle_hours)
        if not args.quiet:
            print(f'cycle-hours={args.cycle_hours}: {len(ids)} due for snapshot '
                  f'(skipped {before - len(ids)} fresh-enough)')
    # Drop ids that have already failed permanently (HTTP 404 / Gone) on
    # several consecutive ticks — re-fetching them is wasted bandwidth and
    # they would otherwise emit a fresh failures.jsonl row each cycle.
    dead = _permanently_dead_ids(args.failures, 'novel_id')
    if dead:
        before = len(ids)
        ids = [n for n in ids if n not in dead]
        if not args.quiet:
            print(f'skipping {before - len(ids)} permanently-dead ids '
                  f'(404/Gone × ≥3 consecutive failures)')
    if args.limit > 0:
        ids = ids[:args.limit]
        if not args.quiet:
            print(f'limited to first {len(ids)}')
    if not ids:
        print('nothing to snapshot.', flush=True)
        return 0, 0
    ok = 0
    failures = []  # [(nid, error)]
    consec_fail = 0
    for i, nid in enumerate(ids, 1):
        success, err = _snapshot_one(nid, args.output)
        if success:
            ok += 1
            consec_fail = 0
            if not args.quiet and (i % 25 == 0 or i == len(ids)):
                print(f'  [{i}/{len(ids)}] last: {nid}', flush=True)
        else:
            consec_fail += 1
            print(f'  [{i}/{len(ids)}] novel {nid}: {err}', flush=True)
            failures.append((nid, err))
            if args.max_consecutive_fails and consec_fail >= args.max_consecutive_fails:
                print(f'  ABORTING — {consec_fail} consecutive failures '
                      f'(probable WAF / rate-limit). {len(ids) - i} novels skipped.',
                      flush=True)
                break
        if i < len(ids):
            eng.jittered_sleep(args.sleep)

    # Retry pass — full coverage means no monitored novel quietly loses its
    # data point. Walk every initial failure with exponential backoff. Any
    # still-failing ids land in a separate JSONL so the next cron run sees
    # them (and the verify script can surface them).
    unrecovered = []
    if failures:
        print(f'\nretry pass: {len(failures)} failed initially', flush=True)
        for j, (nid, err) in enumerate(failures, 1):
            backoff = min(args.sleep * 4 * j, 30.0)
            time.sleep(backoff)
            success, err2 = _snapshot_one(nid, args.output)
            if success:
                ok += 1
                print(f'  retry [{j}/{len(failures)}] novel {nid}: ok', flush=True)
            else:
                print(f'  retry [{j}/{len(failures)}] novel {nid}: STILL FAILING ({err2})', flush=True)
                unrecovered.append({'ts': eng.now_iso(), 'novel_id': nid,
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
            sys.exit(75)  # EX_TEMPFAIL — cron will retry
    else:
        ok, failed = _run(args)
    stats = eng.fetch_stats('jjwxc')
    print(f'snapshot: {ok} ok (direct={stats["direct_ok"]} proxy_rescued={stats["proxy_rescued"]}), {failed} failed -> {args.output}', flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
