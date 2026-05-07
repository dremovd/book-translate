#!/usr/bin/env python3
"""Cron driver for fanqienovel.com — runs discover + snapshot in sequence.

Cron entry (run every 12 hours):
    0 */12 * * *  cd /path/to/repo && /usr/bin/env python3 scripts/fanqie-cron.py >> data/fanqie/cron.log 2>&1

Same exit-code semantics as scripts/jjwxc-cron.py: 0 = clean, 1 = some
per-novel failures unrecovered, 2 = phase crashed, 75 = lock contention.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DISCOVER = REPO / 'scripts' / 'fanqie-discover.py'
SNAPSHOT = REPO / 'scripts' / 'fanqie-snapshot.py'


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Run fanqie discover + snapshot in sequence.')
    p.add_argument('--sleep', type=float, default=0.5,
                   help='--sleep passed to both phases (default: 0.5).')
    p.add_argument('--limit', type=int, default=0,
                   help='Snapshot --limit (default: 0 = no cap).')
    p.add_argument('--verbose', action='store_true',
                   help='Forward verbose output from underlying scripts (default: --quiet).')
    return p.parse_args(argv)


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _run_phase(name, cmd):
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    except FileNotFoundError as e:
        return 2, f'{name}: BUSTED ({e})'
    elapsed = time.time() - t0
    out = (proc.stdout or '').rstrip()
    err = (proc.stderr or '').rstrip()
    if out:
        print(out, flush=True)
    if err:
        print(err, file=sys.stderr, flush=True)
    return proc.returncode, f'{name}: rc={proc.returncode} elapsed={elapsed:.1f}s'


def main(argv=None):
    args = parse_args(argv)
    print(f'[{_now()}] fanqie-cron start', flush=True)

    discover_cmd = [sys.executable, str(DISCOVER), '--sleep', str(args.sleep)]
    snapshot_cmd = [sys.executable, str(SNAPSHOT), '--sleep', str(args.sleep)]
    if args.limit:
        snapshot_cmd += ['--limit', str(args.limit)]
    if not args.verbose:
        discover_cmd.append('--quiet')
        snapshot_cmd.append('--quiet')

    rc_discover, summary_d = _run_phase('discover', discover_cmd)
    print(f'[{_now()}] {summary_d}', flush=True)
    if rc_discover == 75:
        print(f'[{_now()}] fanqie-cron skipped (lock contention)', flush=True)
        sys.exit(75)

    rc_snapshot, summary_s = _run_phase('snapshot', snapshot_cmd)
    print(f'[{_now()}] {summary_s}', flush=True)
    print(f'[{_now()}] fanqie-cron end', flush=True)

    if rc_discover != 0 or rc_snapshot == 2:
        sys.exit(2)
    sys.exit(rc_snapshot)


if __name__ == '__main__':
    main()
