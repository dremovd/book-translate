#!/usr/bin/env python3
"""Single-entry cron driver: discover then snapshot, append a status line to
data/jjwxc/cron.log.

Cron entry (run every 12 hours):

    0 */12 * * *  cd /path/to/repo && /usr/bin/env python3 scripts/jjwxc-cron.py >> data/jjwxc/cron.log 2>&1

Exit codes:
    0   both phases succeeded with no failures
    1   snapshot completed but had per-novel failures (parse/fetch)
    2   discover or snapshot crashed
   75   another instance is already running (EX_TEMPFAIL) — cron will retry

The two underlying scripts each hold their own lock file, so even if you
schedule discover and snapshot independently they can't overlap with each
other or with this driver.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DISCOVER = REPO / 'scripts' / 'jjwxc-discover.py'
SNAPSHOT = REPO / 'scripts' / 'jjwxc-snapshot.py'


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Run jjwxc discover + snapshot in sequence.')
    p.add_argument('--pages', type=int, default=15,
                   help='Discover --pages (default: 15; bookbase caps at ~10 anyway).')
    p.add_argument('--sleep', type=float, default=0.3,
                   help='--sleep passed to both phases (default: 0.3).')
    p.add_argument('--limit', type=int, default=0,
                   help='Snapshot --limit (default: 0 = no cap, snapshot all candidates).')
    p.add_argument('--verbose', action='store_true',
                   help='Forward verbose output from underlying scripts (default: --quiet).')
    return p.parse_args(argv)


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _run_phase(name, cmd):
    """Run a phase, capture stdout/stderr, return (rc, summary_line)."""
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    except FileNotFoundError as e:
        return 2, f'{name}: BUSTED ({e})'
    elapsed = time.time() - t0
    # The underlying scripts always print one summary line ('discover: ...' or
    # 'snapshot: ...') on stdout. Echo their full output verbatim for the log.
    out = (proc.stdout or '').rstrip()
    err = (proc.stderr or '').rstrip()
    if out:
        print(out, flush=True)
    if err:
        print(err, file=sys.stderr, flush=True)
    return proc.returncode, f'{name}: rc={proc.returncode} elapsed={elapsed:.1f}s'


def main(argv=None):
    args = parse_args(argv)
    print(f'[{_now()}] jjwxc-cron start', flush=True)

    discover_cmd = [
        sys.executable, str(DISCOVER),
        '--pages', str(args.pages),
        '--sleep', str(args.sleep),
    ]
    snapshot_cmd = [
        sys.executable, str(SNAPSHOT),
        '--sleep', str(args.sleep),
    ]
    if args.limit:
        snapshot_cmd += ['--limit', str(args.limit)]
    if not args.verbose:
        discover_cmd.append('--quiet')
        snapshot_cmd.append('--quiet')

    rc_discover, summary_d = _run_phase('discover', discover_cmd)
    print(f'[{_now()}] {summary_d}', flush=True)

    # If discover bailed because another instance was running (rc=75), don't
    # cascade into snapshot — let cron retry both phases on the next tick.
    if rc_discover == 75:
        print(f'[{_now()}] jjwxc-cron skipped (lock contention)', flush=True)
        sys.exit(75)

    rc_snapshot, summary_s = _run_phase('snapshot', snapshot_cmd)
    print(f'[{_now()}] {summary_s}', flush=True)
    print(f'[{_now()}] jjwxc-cron end', flush=True)

    if rc_discover != 0 or rc_snapshot == 2:
        sys.exit(2)
    sys.exit(rc_snapshot)


if __name__ == '__main__':
    main()
