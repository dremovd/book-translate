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


def _snapshot_one(nid, output_path):
    """Fetch one novel and append a row. Returns (ok, error_message_or_None)."""
    url = eng.build_onebook_url(nid)
    try:
        html = eng.fetch_html(url)
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
    if args.limit > 0:
        ids = ids[:args.limit]
        if not args.quiet:
            print(f'limited to first {len(ids)}')
    if not ids:
        print('nothing to snapshot.', flush=True)
        return 0, 0
    ok = 0
    failures = []  # [(nid, error)]
    for i, nid in enumerate(ids, 1):
        success, err = _snapshot_one(nid, args.output)
        if success:
            ok += 1
            if not args.quiet and (i % 25 == 0 or i == len(ids)):
                print(f'  [{i}/{len(ids)}] last: {nid}', flush=True)
        else:
            print(f'  [{i}/{len(ids)}] novel {nid}: {err}', flush=True)
            failures.append((nid, err))
        if i < len(ids):
            time.sleep(args.sleep)

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
    print(f'snapshot: {ok} ok, {failed} failed -> {args.output}', flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
