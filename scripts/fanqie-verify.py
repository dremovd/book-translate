#!/usr/bin/env python3
"""Integrity-check fanqie data files (mirror of jjwxc-verify.py).

Reports any row with missing required fields, wrong types, duplicate
(ts, book_id) pairs, schema_version drift, orphans (snapshot id not in
candidates), or per-cycle coverage gaps (a candidate eligible on day D
must have a snapshot row that day).

Exit non-zero on any problem.
"""

import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _fanqie_engine as eng

CURRENT_SCHEMA_VERSION = 1

# (field, type, allow_none)
SNAPSHOT_REQUIRED = [
    ('ts', str, False),
    ('book_id', str, False),
    ('schema_version', int, False),
    ('book_name', str, True),
    ('author', str, True),
    ('author_id', str, True),
    ('category', str, True),
    ('word_number', int, True),
    ('read_count', int, True),
    ('creation_status', int, True),
    ('status', str, True),
    ('chapter_total', int, True),
    ('last_publish_time', int, True),
    ('last_chapter_id', str, True),
    ('last_chapter_title', str, True),
    ('thumb_url', str, True),
]

CANDIDATE_REQUIRED = [
    ('book_id', str, False),
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
        bid = row.get('book_id')
        if isinstance(bid, str) and bid:
            if bid in seen_ids:
                issues.append(f'{ctx}: duplicate book_id {bid}')
            else:
                seen_ids.add(bid)
    return n, len(seen_ids), issues


def verify_snapshots(path):
    issues = []
    seen_ts_id = set()
    schema_versions = Counter()
    book_ids = set()
    rows = 0
    for i, row in enumerate(eng.read_jsonl(path), 1):
        rows += 1
        ctx = f'{path}:line {i}'
        issues += _check_row(row, SNAPSHOT_REQUIRED, ctx)
        sv = row.get('schema_version')
        schema_versions[sv] += 1
        bid = row.get('book_id')
        ts = row.get('ts')
        if isinstance(bid, str) and bid:
            book_ids.add(bid)
            if isinstance(ts, str):
                key = (ts, bid)
                if key in seen_ts_id:
                    issues.append(f'{ctx}: duplicate (ts, book_id) {key}')
                else:
                    seen_ts_id.add(key)
    return rows, book_ids, schema_versions, issues


def verify_coverage(candidates_path, snapshots_path):
    """Every candidate eligible on day D must have a snapshot row that day."""
    first_seen = {}
    for row in eng.read_jsonl(candidates_path):
        bid = row.get('book_id')
        ts = row.get('first_seen')
        if isinstance(bid, str) and bid and isinstance(ts, str):
            first_seen.setdefault(bid, ts[:10])
    rows_by_date = {}
    for row in eng.read_jsonl(snapshots_path):
        bid = row.get('book_id')
        ts = row.get('ts') or ''
        if isinstance(bid, str) and bid and isinstance(ts, str):
            d = ts[:10]
            rows_by_date.setdefault(d, set()).add(bid)
    gaps = []
    for d in sorted(rows_by_date):
        eligible = {bid for bid, fd in first_seen.items() if fd <= d}
        present = rows_by_date[d]
        missing = eligible - present
        if missing:
            gaps.append((d, missing))
    return gaps


def verify_failures(path):
    issues = []
    for i, row in enumerate(eng.read_jsonl(path), 1):
        ctx = f'{path}:line {i}'
        for f in ('ts', 'book_id', 'first_error'):
            if f not in row:
                issues.append(f'{ctx}: missing {f!r}')
    return issues


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Verify fanqie data integrity.')
    p.add_argument('--candidates', default='data/fanqie/candidates.jsonl')
    p.add_argument('--snapshots', default='data/fanqie/snapshots.jsonl')
    p.add_argument('--failures', default='data/fanqie/failures.jsonl')
    p.add_argument('--max-issues', type=int, default=20)
    p.add_argument('--coverage-tolerance', type=int, default=0)
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    print(f'verifying {args.candidates}')
    n_c, n_unique, issues_c = verify_candidates(args.candidates)
    print(f'  rows={n_c}  unique book_ids={n_unique}  issues={len(issues_c)}')
    for iss in issues_c[:args.max_issues]:
        print(f'    ! {iss}')

    print(f'\nverifying {args.snapshots}')
    n_s, ids_s, schema_versions, issues_s = verify_snapshots(args.snapshots)
    print(f'  rows={n_s}  unique book_ids={len(ids_s)}  '
          f'schema_versions={dict(schema_versions)}  issues={len(issues_s)}')
    for iss in issues_s[:args.max_issues]:
        print(f'    ! {iss}')

    cand_ids = eng.load_candidate_book_ids(args.candidates)
    orphan = ids_s - cand_ids
    if orphan:
        print(f'\nWARNING: {len(orphan)} snapshot ids are not in candidates registry')
        for bid in list(orphan)[:5]:
            print(f'    ! orphan book_id={bid}')

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

    if Path(args.failures).exists():
        issues_f = verify_failures(args.failures)
        n_failures = sum(1 for _ in eng.read_jsonl(args.failures))
        print(f'\nverifying {args.failures}')
        print(f'  rows={n_failures}  issues={len(issues_f)}')
        for iss in issues_f[:args.max_issues]:
            print(f'    ! {iss}')
    else:
        issues_f = []

    bad = bool(issues_c) or bool(issues_s) or bool(orphan) or bool(issues_f) or coverage_bad
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
