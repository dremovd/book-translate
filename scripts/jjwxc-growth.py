#!/usr/bin/env python3
"""Rank candidates by growth using snapshots.jsonl.

For each novel with ≥2 snapshots, computes Δcollects per day as
(collects_last − collects_first) / days_between. Telescope identity:
averaging consecutive per-snapshot deltas gives the same number, so
last-minus-first is enough.

Run after at least two snapshot rounds have accumulated:
    python3 scripts/jjwxc-growth.py
    python3 scripts/jjwxc-growth.py --top 50 --min-days 1.0
    python3 scripts/jjwxc-growth.py --min-collects 1000 --max-collects 30000
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _jjwxc_engine as eng  # noqa: F401  (kept for future helpers)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Rank jjwxc candidates by Δcollects/day.')
    p.add_argument('--snapshots', default='data/jjwxc/snapshots.jsonl',
                   help='Snapshots JSONL (default: data/jjwxc/snapshots.jsonl)')
    p.add_argument('--top', type=int, default=30, help='Print top N (default: 30)')
    p.add_argument('--min-days', type=float, default=0.0,
                   help='Skip novels whose snapshot window is shorter than this (default: 0).')
    p.add_argument('--min-collects', type=int, default=None,
                   help='Filter: skip novels whose latest collects < this.')
    p.add_argument('--max-collects', type=int, default=None,
                   help='Filter: skip novels whose latest collects > this (graduates).')
    p.add_argument('--status', choices=('ongoing', 'completed', 'any'), default='any',
                   help='Filter by latest status (default: any).')
    p.add_argument('--json', action='store_true', help='Emit JSON instead of a table.')
    return p.parse_args(argv)


def _parse_ts(s):
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


def _load_grouped(path):
    """Return {novel_id: [snapshots sorted by ts]}.

    Accepts the snapshot row shape produced by jjwxc-snapshot.py.
    """
    by_id = defaultdict(list)
    for row in eng.read_jsonl(path):
        nid = row.get('novel_id')
        ts = row.get('ts')
        if isinstance(nid, int) and ts:
            by_id[nid].append(row)
    for rows in by_id.values():
        rows.sort(key=lambda r: r['ts'])
    return by_id


def compute_growth(rows):
    """Given ≥2 snapshots for one novel sorted by ts, return a summary dict.

    Returns None if fewer than 2 snapshots or zero-length time window.
    """
    if len(rows) < 2:
        return None
    first, last = rows[0], rows[-1]
    days = (_parse_ts(last['ts']) - _parse_ts(first['ts'])).total_seconds() / 86400.0
    if days <= 0:
        return None
    delta = (last.get('collects') or 0) - (first.get('collects') or 0)
    return {
        'novel_id': last['novel_id'],
        'title': last.get('title'),
        'author': last.get('author'),
        'genre': last.get('genre'),
        'status': last.get('status'),
        'collects_first': first.get('collects') or 0,
        'collects_last': last.get('collects') or 0,
        'delta_collects': delta,
        'days': days,
        'collects_per_day': delta / days,
        'snapshots': len(rows),
        'word_count': last.get('word_count'),
        'chapter_count': last.get('chapter_count'),
    }


def main(argv=None):
    args = parse_args(argv)
    by_id = _load_grouped(args.snapshots)
    if not by_id:
        print(f'no snapshots found at {args.snapshots}', file=sys.stderr)
        sys.exit(1)
    rows = []
    skipped_oneshot = 0
    for nid, snaps in by_id.items():
        g = compute_growth(snaps)
        if g is None:
            skipped_oneshot += 1
            continue
        if g['days'] < args.min_days:
            continue
        if args.min_collects is not None and g['collects_last'] < args.min_collects:
            continue
        if args.max_collects is not None and g['collects_last'] > args.max_collects:
            continue
        if args.status != 'any' and g['status'] != args.status:
            continue
        rows.append(g)
    rows.sort(key=lambda r: r['collects_per_day'], reverse=True)
    rows = rows[:args.top]

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    if not rows:
        print(f'no rankable rows. {len(by_id)} novels in snapshots, {skipped_oneshot} have only one '
              f'snapshot so far. Run snapshot again later for growth signal.')
        return

    print(f'top {len(rows)} of {len(by_id)} novels by Δcollects/day '
          f'(skipped {skipped_oneshot} single-snapshot)')
    print(f'{"#":>3}  {"Δ/day":>7}  {"days":>5}  {"first→last":>12}  {"wc":>6}  '
          f'{"ch":>3}  {"status":>9}  novel')
    print('-' * 100)
    for i, r in enumerate(rows, 1):
        rng = f'{r["collects_first"]}→{r["collects_last"]}'
        title = (r.get('title') or '?')[:40]
        author = (r.get('author') or '?')[:20]
        print(f'{i:>3}  {r["collects_per_day"]:>7.2f}  {r["days"]:>5.2f}  {rng:>12}  '
              f'{(r.get("word_count") or 0):>6}  {(r.get("chapter_count") or 0):>3}  '
              f'{(r.get("status") or "?"):>9}  {title} / {author}')


if __name__ == '__main__':
    main()
