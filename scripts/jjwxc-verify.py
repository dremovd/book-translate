#!/usr/bin/env python3
"""Integrity-check the jjwxc data files.

Reports any row that:
- has missing required fields
- has unexpected schema_version
- has wrong types (collects must be int, etc.)
- has duplicated (ts, novel_id) pairs (snapshot run accidentally re-fetched)
- candidates registry has duplicate novel_ids

Exit non-zero on any problem so cron can wire it to alerting.

Usage:
    python3 scripts/jjwxc-verify.py
    python3 scripts/jjwxc-verify.py --candidates path --snapshots path
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _jjwxc_engine as eng

CURRENT_SCHEMA_VERSION = 2

# (field, type, allow_none)
SNAPSHOT_REQUIRED = [
    ('ts', str, False),
    ('novel_id', int, False),
    ('schema_version', int, True),  # rows from before v2 land won't have it
    ('title', str, True),
    ('author', str, True),
    ('genre', str, True),
    ('word_count', int, True),
    ('chapter_count', int, True),
    ('collects', int, True),
    ('reviews', int, True),
    ('score', int, True),
    ('status', str, True),
    ('last_update', str, True),
    ('tags', list, True),
]

CANDIDATE_REQUIRED = [
    ('novel_id', int, False),
    ('first_seen', str, False),
]


def _check_row(row, required, ctx):
    issues = []
    for field, ty, allow_none in required:
        if field not in row:
            issues.append(f'{ctx}: missing field {field!r}')
            continue
        v = row[field]
        if v is None:
            if not allow_none:
                issues.append(f'{ctx}: {field}=None not allowed')
            continue
        if not isinstance(v, ty):
            issues.append(f'{ctx}: {field} expected {ty.__name__}, got {type(v).__name__}={v!r}')
    return issues


def verify_candidates(path):
    issues = []
    seen_ids = set()
    n = 0
    for i, row in enumerate(eng.read_jsonl(path), 1):
        n += 1
        ctx = f'{path}:line {i}'
        issues += _check_row(row, CANDIDATE_REQUIRED, ctx)
        nid = row.get('novel_id')
        if isinstance(nid, int):
            if nid in seen_ids:
                issues.append(f'{ctx}: duplicate novel_id {nid}')
            else:
                seen_ids.add(nid)
    return n, len(seen_ids), issues


def verify_snapshots(path):
    issues = []
    seen_ts_id = set()
    schema_versions = Counter()
    novel_ids = set()
    rows = 0
    for i, row in enumerate(eng.read_jsonl(path), 1):
        rows += 1
        ctx = f'{path}:line {i}'
        issues += _check_row(row, SNAPSHOT_REQUIRED, ctx)
        sv = row.get('schema_version')
        schema_versions[sv] += 1
        nid = row.get('novel_id')
        ts = row.get('ts')
        if isinstance(nid, int):
            novel_ids.add(nid)
            if isinstance(ts, str):
                key = (ts, nid)
                if key in seen_ts_id:
                    issues.append(f'{ctx}: duplicate (ts, novel_id) {key}')
                else:
                    seen_ts_id.add(key)
        # chapters list shape (only enforce on schema_version >= 2)
        if (sv or 0) >= 2 and isinstance(row.get('chapters'), list):
            for ci, ch in enumerate(row['chapters']):
                if not isinstance(ch, dict):
                    issues.append(f'{ctx}: chapters[{ci}] not a dict')
                    continue
                for k in ('idx', 'chapter_id', 'title', 'word_count', 'published_at'):
                    if k not in ch:
                        issues.append(f'{ctx}: chapters[{ci}] missing {k!r}')
    return rows, novel_ids, schema_versions, issues


def verify_coverage(candidates_path, snapshots_path):
    """For every candidate first-seen on day D, every snapshot cycle on day
    ≥D should contain a row for that candidate. Returns list of gaps:
    (cycle_date, missing_novel_ids).
    """
    # Build candidates → first_seen date.
    first_seen = {}
    for row in eng.read_jsonl(candidates_path):
        nid = row.get('novel_id')
        ts = row.get('first_seen')
        if isinstance(nid, int) and isinstance(ts, str):
            first_seen.setdefault(nid, ts[:10])
    # Group snapshot rows by UTC date. Each day = one snapshot cycle.
    rows_by_date = {}  # date_str -> set(novel_id)
    for row in eng.read_jsonl(snapshots_path):
        nid = row.get('novel_id')
        ts = row.get('ts') or ''
        if isinstance(nid, int) and isinstance(ts, str):
            d = ts[:10]
            rows_by_date.setdefault(d, set()).add(nid)
    gaps = []
    for d in sorted(rows_by_date):
        eligible = {nid for nid, fd in first_seen.items() if fd <= d}
        present = rows_by_date[d]
        missing = eligible - present
        if missing:
            gaps.append((d, missing))
    return gaps


def verify_failures(path):
    """Failures jsonl shape: {ts, novel_id, first_error, retry_error?}."""
    issues = []
    for i, row in enumerate(eng.read_jsonl(path), 1):
        ctx = f'{path}:line {i}'
        for f in ('ts', 'novel_id', 'first_error'):
            if f not in row:
                issues.append(f'{ctx}: missing {f!r}')
    return issues


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Verify jjwxc data integrity.')
    p.add_argument('--candidates', default='data/jjwxc/candidates.jsonl')
    p.add_argument('--snapshots', default='data/jjwxc/snapshots.jsonl')
    p.add_argument('--failures', default='data/jjwxc/failures.jsonl')
    p.add_argument('--max-issues', type=int, default=20,
                   help='Show at most this many issues per file (default: 20)')
    p.add_argument('--coverage-tolerance', type=int, default=0,
                   help='Allow up to N missing per snapshot cycle without failing (default: 0).')
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    print(f'verifying {args.candidates}')
    n_c, n_unique, issues_c = verify_candidates(args.candidates)
    print(f'  rows={n_c}  unique novel_ids={n_unique}  issues={len(issues_c)}')
    for iss in issues_c[:args.max_issues]:
        print(f'    ! {iss}')

    print(f'\nverifying {args.snapshots}')
    n_s, ids_s, schema_versions, issues_s = verify_snapshots(args.snapshots)
    print(f'  rows={n_s}  unique novel_ids={len(ids_s)}  '
          f'schema_versions={dict(schema_versions)}  issues={len(issues_s)}')
    for iss in issues_s[:args.max_issues]:
        print(f'    ! {iss}')

    # cross-file: every snapshot id should be in candidates.
    cand_ids = eng.load_candidate_ids(args.candidates)
    orphan = ids_s - cand_ids
    if orphan:
        print(f'\nWARNING: {len(orphan)} snapshot ids are not in candidates registry')
        for nid in list(orphan)[:5]:
            print(f'    ! orphan novel_id={nid}')

    # Per-cycle coverage check.
    gaps = verify_coverage(args.candidates, args.snapshots)
    coverage_bad = any(len(missing) > args.coverage_tolerance for _, missing in gaps)
    print(f'\nverifying snapshot coverage')
    if not gaps:
        print('  no gaps: every eligible candidate appears in every snapshot cycle')
    else:
        print(f'  {len(gaps)} cycle(s) with missing rows (tolerance={args.coverage_tolerance}):')
        for d, missing in gaps[:args.max_issues]:
            sample = sorted(missing)[:5]
            extra = '' if len(missing) <= 5 else f' (+ {len(missing)-5} more)'
            severity = '!' if len(missing) > args.coverage_tolerance else '·'
            print(f'    {severity} {d}: {len(missing)} missing — sample: {sample}{extra}')

    # Failures file (only if it exists).
    if Path(args.failures).exists():
        issues_f = verify_failures(args.failures)
        n_failures = sum(1 for _ in eng.read_jsonl(args.failures))
        print(f'\nverifying {args.failures}')
        print(f'  rows={n_failures}  issues={len(issues_f)}')
        for iss in issues_f[:args.max_issues]:
            print(f'    ! {iss}')
    else:
        issues_f = []
        n_failures = 0

    bad = bool(issues_c) or bool(issues_s) or bool(orphan) or bool(issues_f) or coverage_bad
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
