#!/usr/bin/env python3
"""Record the FULL set of visible book_ids on each discover surface.

This is a measurement / observability tool — *not* a replacement for the
regular discover scripts. Where ``<site>-discover.py`` only writes new
book_ids to candidates.jsonl, this script writes one row per fetch
listing every book_id visible on that surface, regardless of whether
we've seen the book before. Compared across hours / days, the rows let
us compute per-surface retention and window lifetime empirically — the
question we couldn't answer at deploy time for the newly-added surfaces
(fanqie home.* and qidian /rank/newbook).

Output schema (one row per fetch):
    {"ts": "2026-05-08T05:30:00Z",
     "site": "fanqie",
     "surface": "home.updateList",
     "book_ids": ["6823667291557727235", ...],
     "count": 20}

Usage:
    # Hourly: log only the unknown-window surfaces (cheap)
    python3 scripts/record_surface_contents.py --site fanqie --surfaces home
    python3 scripts/record_surface_contents.py --site qidian --surfaces newbook

    # All surfaces of a site (heavier, run sparingly)
    python3 scripts/record_surface_contents.py --site fanqie
    python3 scripts/record_surface_contents.py --site qidian
    python3 scripts/record_surface_contents.py --site jjwxc
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts import _jjwxc_engine as jj_eng
from scripts import _fanqie_engine as fq_eng
from scripts import _qidian_engine as qd_eng


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Log full discover-surface contents per fetch.')
    p.add_argument('--site', required=True, choices=['jjwxc', 'fanqie', 'qidian'])
    p.add_argument('--surfaces', nargs='+', default=None,
                   help='Subset of surfaces to walk. fanqie: rank|home (default both). '
                        'qidian: yuepiao|newbook (default both). jjwxc: bookbase (only).')
    p.add_argument('--output', default=None,
                   help='Output path (default: data/<site>/surface-contents.jsonl)')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='Seconds between fetches (default 0.5)')
    p.add_argument('--quiet', action='store_true', help='Cron-friendly: only print summary line')
    p.add_argument('--lock', default=None,
                   help='Lock file path; defaults to data/<site>/.record-contents.lock')
    return p.parse_args(argv)


def _record(out_path, site, surface, book_ids):
    row = {
        'ts': jj_eng.now_iso(),
        'site': site,
        'surface': surface,
        'book_ids': list(book_ids),
        'count': len(book_ids),
    }
    jj_eng.append_jsonl(out_path, row)
    return row


# --------- per-site walkers ---------

def walk_jjwxc(args):
    """Walk bookbase newest-published × pages 1..10 (the only jjwxc discovery surface)."""
    out = []
    rc = 0
    for page in range(1, 11):
        url = jj_eng.build_bookbase_url(sort_type=3, page=page, isfinish=1)
        try:
            html = jj_eng.fetch_html(url)
        except RuntimeError as e:
            print(f'jjwxc page={page}: FETCH FAILED ({e})', flush=True)
            rc = 1
            continue
        ids = [str(n) for n in jj_eng.parse_bookbase_listing(html)]
        if not ids:
            break
        row = _record(args.output, 'jjwxc', f'bookbase.page{page}', ids)
        out.append(row)
        if not args.quiet:
            print(f'  bookbase.page{page}: {len(ids)} ids', flush=True)
        jj_eng.jittered_sleep(args.sleep)
    return out, rc


def walk_fanqie(args):
    out = []
    rc = 0
    surfaces = args.surfaces or ['rank', 'home']
    if 'rank' in surfaces:
        for i, (gender, cat_id, name) in enumerate(fq_eng.RANK_CATEGORIES, 1):
            url = fq_eng.build_rank_url(gender=gender, category_id=cat_id)
            try:
                html = fq_eng.fetch_html(url)
            except RuntimeError as e:
                print(f'fanqie rank g={gender} cat={cat_id}: FETCH FAILED ({e})', flush=True)
                rc = 1
                continue
            try:
                books = fq_eng.parse_rank_book_list(html)
            except Exception as e:
                print(f'fanqie rank g={gender} cat={cat_id}: PARSE FAILED ({e})', flush=True)
                rc = 1
                continue
            ids = [b['bookId'] for b in books if b.get('bookId')]
            row = _record(args.output, 'fanqie', f'rank.g{gender}.cat{cat_id}', ids)
            out.append(row)
            if not args.quiet:
                print(f'  rank.g{gender}.cat{cat_id} {name}: {len(ids)} ids', flush=True)
            if i < len(fq_eng.RANK_CATEGORIES):
                jj_eng.jittered_sleep(args.sleep)
    if 'home' in surfaces:
        try:
            html = fq_eng.fetch_html(fq_eng.build_home_url())
            lists = fq_eng.parse_home_lists(html)
        except Exception as e:
            print(f'fanqie home: FAILED ({e})', flush=True)
            rc = 1
        else:
            for list_name, entries in lists.items():
                ids = [e['bookId'] for e in entries if e.get('bookId')]
                row = _record(args.output, 'fanqie', f'home.{list_name}', ids)
                out.append(row)
                if not args.quiet:
                    print(f'  home.{list_name}: {len(ids)} ids', flush=True)
    return out, rc


def walk_qidian(args):
    out = []
    rc = 0
    surfaces = args.surfaces or ['yuepiao', 'newbook']
    builders = {
        'yuepiao': qd_eng.build_yuepiao_url,
        'newbook': qd_eng.build_newbook_url,
    }
    for rank_type in surfaces:
        if rank_type not in builders:
            print(f'qidian: unknown rank_type {rank_type!r}', flush=True)
            rc = 1
            continue
        build = builders[rank_type]
        for i, catid in enumerate(qd_eng.RANK_CATIDS, 1):
            url = build(catid=catid)
            try:
                html = qd_eng.fetch_html(url)
            except RuntimeError as e:
                print(f'qidian {rank_type} catid={catid}: FETCH FAILED ({e})', flush=True)
                rc = 1
                continue
            try:
                records, _meta = qd_eng.parse_rank_records(html)
            except Exception as e:
                print(f'qidian {rank_type} catid={catid}: PARSE FAILED ({e})', flush=True)
                rc = 1
                continue
            ids = [str(r['bid']) for r in records if r.get('bid') is not None]
            row = _record(args.output, 'qidian', f'{rank_type}.catid{catid}', ids)
            out.append(row)
            if not args.quiet:
                print(f'  {rank_type}.catid{catid}: {len(ids)} ids', flush=True)
            if i < len(qd_eng.RANK_CATIDS):
                jj_eng.jittered_sleep(args.sleep)
    return out, rc


WALKERS = {
    'jjwxc': walk_jjwxc,
    'fanqie': walk_fanqie,
    'qidian': walk_qidian,
}


def main(argv=None):
    args = parse_args(argv)
    if args.output is None:
        args.output = f'data/{args.site}/surface-contents.jsonl'
    if args.lock is None:
        args.lock = f'data/{args.site}/.record-contents.lock'

    walker = WALKERS[args.site]

    def _do():
        rows, rc = walker(args)
        return rows, rc

    if args.lock:
        try:
            with jj_eng._Lock(args.lock):
                rows, rc = _do()
        except RuntimeError as e:
            print(f'record_surface_contents: {e}', flush=True)
            sys.exit(75)
    else:
        rows, rc = _do()

    total_ids = sum(r['count'] for r in rows)
    print(f'record_surface_contents: {args.site} surfaces={len(rows)} '
          f'total_ids_logged={total_ids} -> {args.output}',
          flush=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
