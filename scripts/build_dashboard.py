#!/usr/bin/env python3
"""Build a static dashboard from the scraped novel data.

Reads data/{jjwxc,fanqie,qidian}/{candidates,snapshots}.jsonl, computes a
simple "promising" score per novel based on growth between earliest and
latest snapshots, and writes a self-contained index.html (no external CSS/
JS deps) to --output (default: dashboard/index.html relative to repo root).

The heuristic per platform — kept deliberately simple, intended as a
starting point for ML / refinement:

  jjwxc  : Δcollects / days observed,   filter ongoing + collects in (10,30k)
  fanqie : Δread_count / days observed, filter ongoing + 100<read_count<100k
  qidian : Δcollect / days observed,    filter ongoing + recom_all>100

Novels with only one snapshot have no growth signal — they appear in a
"just discovered" table sorted by current popularity instead.

Run after each data update:
  python3 scripts/build_dashboard.py
  python3 scripts/build_dashboard.py --output /var/www/scrapers-dashboard/
"""

import argparse
import html as html_mod
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ────────── per-platform configuration ──────────

PLATFORMS = {
    'jjwxc': {
        'data_dir': 'data/jjwxc',
        'id_field': 'novel_id',
        'metric_field': 'collects',
        'metric_label': 'Collects',
        'word_field': 'word_count',
        'chapter_field': 'chapter_count',
        'detail_url': 'https://www.jjwxc.net/onebook.php?novelid={id}',
        # Sweet-spot bands for the size factor in score():
        # - tiny < 10 collects: probably noise
        # - 10–1k: rising, hardest to spot, biggest reward
        # - 1k–30k: established, growth still meaningful
        # - >30k: already mainstream, low value as discovery
        'size_band_breakpoints': (10, 1_000, 30_000),
        'size_band_factors':     (0.30, 1.00, 0.70, 0.20),
    },
    'fanqie': {
        'data_dir': 'data/fanqie',
        'id_field': 'book_id',
        'metric_field': 'read_count',
        'metric_label': 'Reads',
        'word_field': 'word_number',
        'chapter_field': 'chapter_total',
        'detail_url': 'https://fanqienovel.com/page/{id}',
        # Fanqie reads: noisy, freemium platform; bands span a wider range.
        'size_band_breakpoints': (1_000, 50_000, 1_000_000),
        'size_band_factors':     (0.40, 1.00, 0.60, 0.15),
    },
    'qidian': {
        'data_dir': 'data/qidian',
        'id_field': 'book_id',
        'metric_field': 'collect',
        'metric_label': 'Collects',
        'word_field': 'words_cnt',
        'chapter_field': None,   # not in qidian schema
        'detail_url': 'https://m.qidian.com/book/{id}',
        'size_band_breakpoints': (100, 5_000, 100_000),
        'size_band_factors':     (0.30, 1.00, 0.65, 0.20),
    },
}


import math


def _size_band_factor(value, breakpoints, factors):
    """Piecewise-constant multiplier on score given a size-bucket value.
    Implements an inverse-bell over current popularity — penalises both
    "too tiny to matter" and "already huge, no longer a discovery"."""
    v = value or 0
    for cutoff, factor in zip(breakpoints, factors):
        if v < cutoff:
            return factor
    return factors[-1]


def _promise_score(latest, growth, cfg):
    """Continuous promise score combining velocity, headroom, and
    publishing-cadence signals.

    Returns a non-negative float; higher = more promising.

    Score is **0** if any of:
      - status not ongoing (already finished, can't grow further)
      - no growth signal (single snapshot)
      - growth rate <= 0 (flat or shrinking)

    Otherwise:
      score = log10(1 + per_day) * size_band_factor * publishing_factor

    where size_band_factor follows the inverse-bell curve in PLATFORMS,
    and publishing_factor rewards books with multiple chapters posted (a
    cheap proxy for an author who's actively engaged, not a one-off).
    """
    if (latest.get('status') or '') != 'ongoing':
        return 0.0
    if growth is None:
        return 0.0
    per_day = growth['per_day']
    if per_day <= 0:
        return 0.0

    metric_now = growth['last_metric'] or 0
    velocity = math.log10(1 + per_day) * 100  # growth strength, ~0..3 scaled to ~0..300

    size_factor = _size_band_factor(metric_now,
                                     cfg['size_band_breakpoints'],
                                     cfg['size_band_factors'])

    chap_field = cfg['chapter_field']
    if chap_field:
        chap_n = latest.get(chap_field) or 0
        if chap_n < 1:
            publishing_factor = 0.2
        elif chap_n < 5:
            publishing_factor = 0.7
        else:
            publishing_factor = 1.0
    else:
        publishing_factor = 1.0

    return velocity * size_factor * publishing_factor


# ────────── data loaders ──────────

def _read_jsonl(path):
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _group_snapshots(rows, id_field):
    by_id = defaultdict(list)
    for r in rows:
        nid = r.get(id_field)
        if nid is not None and r.get('ts'):
            by_id[nid].append(r)
    for rows in by_id.values():
        rows.sort(key=lambda r: r['ts'])
    return by_id


def _name_field(row):
    """Each platform names the title differently — pick what's there."""
    return row.get('title') or row.get('book_name') or '?'


def _author_field(row):
    return row.get('author') or row.get('author_name') or '?'


# ────────── scoring ──────────

def _compute_growth(rows, metric_field):
    """Δmetric / days_between for a single novel's sorted snapshot list.
    Returns None if growth can't be computed (single snapshot, zero gap)."""
    if len(rows) < 2:
        return None
    first, last = rows[0], rows[-1]
    t0, t1 = _parse_ts(first['ts']), _parse_ts(last['ts'])
    if not t0 or not t1:
        return None
    days = (t1 - t0).total_seconds() / 86400
    if days <= 0:
        return None
    delta = (last.get(metric_field) or 0) - (first.get(metric_field) or 0)
    return {
        'first': last,    # show most recent metadata, but
        'first_metric': first.get(metric_field) or 0,
        'last_metric': last.get(metric_field) or 0,
        'delta': delta,
        'days': days,
        'per_day': delta / days,
        'snapshots': len(rows),
        'latest': last,
    }


def _classify_error_line(line):
    """Bucket an error log line into a known category for the dashboard.

    Categories surfaced (most-specific first; first match wins):
      '403'     — explicit Forbidden (qidian-style hard WAF)
      '429'     — rate-limit; includes our "treating as HTTP 429" surfacing
                  of empty 200 bodies, plus legacy "INITIAL_STATE not found"
                  rows from before that fix.
      '404'     — Not Found (book removed by the platform)
      '5xx'     — server-side errors (worth distinguishing from rate-limit)
      'timeout' — TimeoutError / read timeout / connect timeout
      'network' — URLError / connection reset / DNS failure (transport)
      'abort'   — our consecutive-fail ABORTING marker — meta-level signal
                  that one of the above tripped the threshold
      'parse'   — schema regression / unparseable page that's not a soft-block
      'other'   — anything not matched above; if this grows, add a category.
    """
    # 4xx: explicit codes first. Match both our fetch_html's tidy "HTTP 4XX"
    # and urllib's default "HTTP Error 4XX: <reason>" from legacy logs.
    if ('HTTP 403' in line or 'HTTP Error 403' in line or 'Forbidden' in line):
        return '403'
    if ('HTTP 429' in line or 'HTTP Error 429' in line or 'treating as HTTP 429' in line
            or '200 OK but body' in line
            or ('INITIAL_STATE' in line and 'not found' in line)):
        return '429'
    if 'HTTP 404' in line or 'HTTP Error 404' in line or 'Not Found' in line:
        return '404'
    # 5xx
    import re as _re
    if _re.search(r'HTTP (?:Error )?5\d{2}', line):
        return '5xx'
    # Transport-level
    if 'timed out' in line or 'TimeoutError' in line or 'timeout' in line.lower():
        return 'timeout'
    if ('Connection reset' in line or 'ConnectionResetError' in line
            or 'URLError' in line or 'getaddrinfo' in line
            or 'Name or service not known' in line):
        return 'network'
    # Meta markers
    if 'ABORTING' in line:
        return 'abort'
    if 'PARSE FAILED' in line or 'parse:' in line:
        return 'parse'
    return 'other'


def _scan_cron_logs(data_dir, hours=48):
    """Scan recent cron.log.YYYY-MM-DD files for error markers. Returns
    (counts_by_category, [sample lines]).

    `counts_by_category` is a dict like {'403': 12, '429': 480, 'parse': 5,
    'other': 3} — surfaced verbatim on the dashboard so you can tell at a
    glance whether the platform is being WAF'd, rate-soft-limited, schema-
    drifting, or just network-flaky. Sample lines are still returned so the
    expandable details panel keeps showing the actual offending text.
    """
    errors = []
    counts = {'403': 0, '429': 0, '404': 0, '5xx': 0,
              'timeout': 0, 'network': 0,
              'abort': 0, 'parse': 0, 'other': 0}
    cutoff = datetime.now(tz=timezone.utc).timestamp() - hours * 3600
    if not os.path.isdir(data_dir):
        return counts, errors
    log_files = sorted([f for f in os.listdir(data_dir)
                        if f.startswith('cron.log.')], reverse=True)[:3]
    for fname in log_files:
        path = os.path.join(data_dir, fname)
        if os.path.getmtime(path) < cutoff:
            continue
        try:
            with open(path, encoding='utf-8') as f:
                in_traceback = False
                for raw in f:
                    line = raw.rstrip('\n')
                    # Python traceback blocks: count ONCE per exception, not
                    # once per stack-frame line. Swallow indented frames; the
                    # non-indented line that closes the block is the exception
                    # summary ("AttributeError: ...", "ValueError: ..." etc.).
                    if line.startswith('Traceback (most recent call last):'):
                        in_traceback = True
                        continue
                    if in_traceback:
                        if line and not line[0].isspace():
                            counts[_classify_error_line(line)] += 1
                            if len(errors) < 6:
                                errors.append(line[:200])
                            in_traceback = False
                        continue
                    # Non-traceback errors: only count explicit failure markers
                    # the scrapers emit themselves (single line per incident).
                    if any(kw in line for kw in
                           ('FAIL', 'STILL FAILING', 'ABORTING')):
                        counts[_classify_error_line(line)] += 1
                        if len(errors) < 6:
                            errors.append(line[:200])
        except OSError:
            continue
    return counts, errors


def _coverage_gap(by_id, candidates, id_field, last_snapshot_ts, grace_hours=2):
    """How many candidates that *should* have been snapshotted by now actually
    weren't?

    Discover and snapshot run on different cadences (hourly discover + daily
    snapshot is the current setup), so candidates added after the most
    recent snapshot run don't count as "missing" — they've had no chance
    yet. We compute coverage *relative* to the last snapshot run:

      eligible = candidates with first_seen <= last_snapshot_ts + grace
      missing  = eligible \ {ids snapshotted in the last snapshot cycle}

    grace_hours absorbs the snapshot run's own duration (a 15-min snapshot
    pass means books discovered during the run still get snapshotted).

    Returns (missing_count, eligible_count). If we have no snapshots yet
    or no candidates with first_seen, returns (0, 0) so the dashboard
    doesn't false-alarm on first deploy.
    """
    last_t = _parse_ts(last_snapshot_ts)
    if not last_t:
        return 0, 0
    eligibility_cutoff = last_t.timestamp() + grace_hours * 3600

    eligible = set()
    for r in candidates:
        nid = r.get(id_field)
        fs = _parse_ts(r.get('first_seen'))
        if nid is None or not fs:
            continue
        if fs.timestamp() <= eligibility_cutoff:
            eligible.add(nid)

    # "Snapshotted in the last cycle" = has any snapshot row dated within the
    # 6-hour window around last_snapshot_ts (covers a snapshot run that
    # spans an hour or two).
    cycle_lo = last_t.timestamp() - 6 * 3600
    cycle_hi = last_t.timestamp() + 6 * 3600
    snapshotted_this_cycle = set()
    for nid, rows in by_id.items():
        for r in rows:
            t = _parse_ts(r.get('ts'))
            if t and cycle_lo <= t.timestamp() <= cycle_hi:
                snapshotted_this_cycle.add(nid)
                break

    missing = eligible - snapshotted_this_cycle
    return len(missing), len(eligible)


def _classify_health(last_snapshot_ts, *, coverage_missing, coverage_total,
                     failures_24h, recent_errors):
    """Combine multiple signals into a single status indicator.

    Just-fresh-data isn't enough — a partial snapshot run that succeeded for
    100 books and got blocked on the next 200 will look "fresh" by age but
    is in fact catastrophic. Order: BLOCKED (most severe) > stale > healthy.
    """
    t = _parse_ts(last_snapshot_ts)
    if not t:
        return '🔴', 'no snapshot data yet'
    age_h = (datetime.now(tz=timezone.utc) - t).total_seconds() / 3600

    # BLOCKED: large fraction of eligible candidates missed in last cycle.
    # That pattern is what an upstream WAF / rate-limit looks like — the
    # snapshot DID run (fresh ts), but only got a small fraction through.
    if coverage_total > 0:
        miss_pct = coverage_missing / coverage_total
        if miss_pct >= 0.5:
            return '🔴', (f'BLOCKED — {coverage_missing}/{coverage_total} '
                          f'({miss_pct * 100:.0f}%) candidates unscraped in last cycle, '
                          f'last snapshot {age_h:.1f}h ago')
        if miss_pct >= 0.2:
            return '🟡', (f'partial — {coverage_missing}/{coverage_total} '
                          f'({miss_pct * 100:.0f}%) candidates unscraped, '
                          f'last snapshot {age_h:.1f}h ago')

    # Same-cycle failures are also a strong signal.
    if failures_24h >= 50:
        return '🔴', f'{failures_24h} per-novel failures in last 24h — likely WAF/rate-limit'

    # Plain freshness fallback.
    if age_h <= 30:
        return '🟢', f'{age_h:.1f}h since last snapshot'
    if age_h <= 48:
        return '🟡', f'{age_h:.1f}h since last snapshot (cron may have skipped)'
    return '🔴', f'{age_h:.1f}h since last snapshot — STALE, check cron'


def _platform_view(plat_name, cfg):
    """Build the data view for one platform — scored novels + just-discovered + health."""
    snaps = list(_read_jsonl(os.path.join(cfg['data_dir'], 'snapshots.jsonl')))
    cands = list(_read_jsonl(os.path.join(cfg['data_dir'], 'candidates.jsonl')))
    failures = list(_read_jsonl(os.path.join(cfg['data_dir'], 'failures.jsonl')))
    by_id = _group_snapshots(snaps, cfg['id_field'])

    # Score every novel; sort by score desc. No binary filter — score
    # returns 0 for "not promising at all" (completed, flat, no signal).
    scored = []                  # [(nid, growth, score)]
    just_discovered = []         # 1-snapshot novels only

    for nid, rows in by_id.items():
        latest = rows[-1]
        g = _compute_growth(rows, cfg['metric_field'])
        if g is None:
            # Single snapshot; no growth signal yet.
            just_discovered.append(latest)
            continue
        score = _promise_score(latest, g, cfg)
        scored.append((nid, g, score))

    # Show only entries with score > 0 in the promising table.
    promising = [(nid, g, s) for (nid, g, s) in scored if s > 0]
    promising.sort(key=lambda x: x[2], reverse=True)
    just_discovered.sort(key=lambda r: -(r.get(cfg['metric_field']) or 0))

    # ── Health signals ──
    last_ts = max((r['ts'] for r in snaps if r.get('ts')), default=None)
    err_counts, err_samples = _scan_cron_logs(cfg['data_dir'])
    err_total = sum(err_counts.values())
    failures_24h = sum(
        1 for r in failures
        if (_parse_ts(r.get('ts')) and
            (datetime.now(tz=timezone.utc) - _parse_ts(r['ts'])).total_seconds() < 86400)
    )
    coverage_missing, coverage_total = _coverage_gap(
        by_id, cands, cfg['id_field'], last_ts)
    fresh_emoji, fresh_label = _classify_health(
        last_ts,
        coverage_missing=coverage_missing,
        coverage_total=coverage_total,
        failures_24h=failures_24h,
        recent_errors=err_total,
    )

    return {
        'plat_name': plat_name,
        'metric_label': cfg['metric_label'],
        'detail_url_template': cfg['detail_url'],
        'word_field': cfg['word_field'],
        'chapter_field': cfg['chapter_field'],
        'metric_field': cfg['metric_field'],
        'id_field': cfg['id_field'],
        'n_candidates': len({r.get(cfg['id_field']) for r in cands if r.get(cfg['id_field']) is not None}),
        'n_snapshots': len(snaps),
        'n_unique_snapshotted': len(by_id),
        'last_snapshot_ts': last_ts,
        'fresh_emoji': fresh_emoji,
        'fresh_label': fresh_label,
        'recent_errors_count': err_total,
        'recent_errors_counts_by_cat': err_counts,
        'recent_errors_samples': err_samples,
        'failures_24h': failures_24h,
        'failures_total': len(failures),
        'coverage_missing': coverage_missing,
        'coverage_total': coverage_total,
        'promising': promising,
        'just_discovered': just_discovered,
    }


# ────────── HTML rendering ──────────

CSS = """\
:root {
  --bg: #0b0d10;
  --bg-elev: #14171c;
  --bg-elev-2: #1a1e25;
  --hairline: #20242c;
  --text: #e3e7ee;
  --muted: #7d8593;
  --muted-2: #5a6171;
  --accent: #5fbf83;
  --link: #7fb5ff;
  --warn: #f0c25c;
  --err: #ff7878;
  --ok: #5fbf83;
  --row-hover: rgba(127,181,255,0.04);
}
* { box-sizing: border-box; margin: 0; }
html { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "SF Pro Text",
       "Segoe UI", "Helvetica Neue", sans-serif;
       -webkit-font-smoothing: antialiased; }
body { background: var(--bg); color: var(--text); }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ─── header ─── */
header.top { position: sticky; top: 0; z-index: 10;
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 24px; padding: 16px 28px;
  background: linear-gradient(180deg, rgba(11,13,16,0.96) 70%, rgba(11,13,16,0.5));
  backdrop-filter: saturate(140%) blur(8px);
  border-bottom: 1px solid var(--hairline); }
header.top h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
header.top h1 small { color: var(--muted); font-weight: 400; margin-left: 8px; }
header.top .built { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* ─── health banner + cards ─── */
.banner { padding: 10px 28px; font-size: 13px; font-weight: 500;
  border-bottom: 1px solid var(--hairline); }
.banner.ok  { background: rgba(95,191,131,0.08); color: var(--ok); }
.banner.bad { background: rgba(255,120,120,0.08); color: var(--err); }
.health { padding: 16px 28px; border-bottom: 1px solid var(--hairline); }
.health-grid { display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.health-card { background: var(--bg-elev); border: 1px solid var(--hairline);
  border-radius: 8px; padding: 12px 14px; font-size: 12.5px; }
.health-card .head { display: flex; align-items: baseline; gap: 8px;
  font-weight: 600; font-size: 13px; }
.health-card .head .badge { font-size: 10.5px; padding: 1px 7px; border-radius: 99px;
  background: var(--bg-elev-2); color: var(--muted); font-weight: 500;
  letter-spacing: 0.02em; }
.health-card .row { display: flex; justify-content: space-between;
  margin-top: 6px; color: var(--muted); }
.health-card .row b { color: var(--text); font-weight: 600;
  font-variant-numeric: tabular-nums; }
.health-card .ok b   { color: var(--ok); }
.health-card .warn b { color: var(--warn); }
.health-card .err b  { color: var(--err); }
.health-card details { margin-top: 8px; padding-top: 8px;
  border-top: 1px solid var(--hairline); }
.health-card details summary { cursor: pointer; color: var(--muted-2); font-size: 12px; }
.health-card details pre { font: 11px/1.45 ui-monospace, "JetBrains Mono", "SF Mono", monospace;
  color: var(--muted); background: var(--bg); padding: 8px 10px; border-radius: 6px;
  margin-top: 6px; overflow: auto; max-height: 220px; white-space: pre-wrap; }

/* ─── tabs ─── */
nav.tabs { display: flex; gap: 0; padding: 0 28px;
  border-bottom: 1px solid var(--hairline);
  position: sticky; top: 56px; background: var(--bg); z-index: 9; }
nav.tabs button { background: transparent; color: var(--muted);
  border: 0; border-bottom: 2px solid transparent; padding: 14px 18px;
  font: inherit; font-weight: 500; cursor: pointer;
  letter-spacing: -0.005em; }
nav.tabs button:hover { color: var(--text); }
nav.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }

/* ─── tab content ─── */
section.tab { display: none; padding: 20px 28px 56px; }
section.tab.active { display: block; }
section.tab h2 { font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 28px 0 10px; }
section.tab h2:first-of-type { margin-top: 8px; }

/* ─── summary metric strip ─── */
.summary { display: flex; gap: 28px; flex-wrap: wrap; padding: 12px 0 4px;
  border-bottom: 1px solid var(--hairline); margin-bottom: 16px; }
.summary > div { font-size: 12.5px; }
.summary span.label { color: var(--muted); margin-right: 8px;
  text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.06em; }
.summary span.val { color: var(--text); font-weight: 600;
  font-variant-numeric: tabular-nums; }

/* ─── filter bar ─── */
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
input.filter { width: 280px; padding: 7px 11px; font: inherit; font-size: 12.5px;
  background: var(--bg-elev); color: var(--text);
  border: 1px solid var(--hairline); border-radius: 6px;
  outline: 0; transition: border-color 80ms; }
input.filter:focus { border-color: var(--accent); }
input.filter::placeholder { color: var(--muted-2); }
.toolbar .count { color: var(--muted); font-size: 12px;
  font-variant-numeric: tabular-nums; }

/* ─── tables ─── */
table { width: 100%; border-collapse: collapse; font-size: 12.5px;
  background: var(--bg-elev); border: 1px solid var(--hairline);
  border-radius: 8px; overflow: hidden;
  font-variant-numeric: tabular-nums; }
thead th { position: sticky; top: 0; z-index: 1;
  background: var(--bg-elev-2); color: var(--muted);
  text-align: left; padding: 9px 12px; font-weight: 600;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid var(--hairline);
  cursor: pointer; user-select: none; white-space: nowrap; }
thead th:hover { color: var(--text); }
thead th .arrow { color: var(--accent); margin-left: 4px; font-size: 10px;
  display: inline-block; min-width: 8px; }
tbody td { padding: 9px 12px; border-bottom: 1px solid var(--hairline); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--row-hover); }
.num { text-align: right; }
.title-cell { max-width: 380px; }
.title-cell a { color: var(--text); }
.title-cell a:hover { color: var(--link); text-decoration: none; }
.title-cell .stub { color: var(--muted); font-size: 11px; margin-left: 6px; }
.muted { color: var(--muted); }
.delta-up { color: var(--ok); }
.delta-zero { color: var(--muted-2); }

/* ─── empty state ─── */
.empty { padding: 20px; color: var(--muted); font-size: 13px;
  background: var(--bg-elev); border: 1px solid var(--hairline);
  border-radius: 8px; }
"""

JS = """\
function showTab(name) {
  document.querySelectorAll('section.tab').forEach(s => {
    s.classList.toggle('active', s.dataset.tab === name);
  });
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (history.replaceState) history.replaceState(null, '', '#' + name);
}
function sortTable(table, colIdx, type) {
  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);
  const dir = table.dataset.sortCol === String(colIdx) && table.dataset.sortDir !== 'desc' ? 'desc' : 'asc';
  rows.sort((a, b) => {
    let av = a.cells[colIdx].dataset.v ?? a.cells[colIdx].innerText;
    let bv = b.cells[colIdx].dataset.v ?? b.cells[colIdx].innerText;
    if (type === 'num') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  rows.forEach(r => tbody.appendChild(r));
  table.dataset.sortCol = colIdx; table.dataset.sortDir = dir;
  table.querySelectorAll('th .arrow').forEach((s, i) => {
    s.innerText = i === colIdx ? (dir === 'asc' ? '▲' : '▼') : '';
  });
}
function bindSort() {
  document.querySelectorAll('table.sortable').forEach(table => {
    table.querySelectorAll('th').forEach((th, idx) => {
      th.addEventListener('click', () => sortTable(table, idx, th.dataset.type));
    });
  });
}
function bindFilter() {
  document.querySelectorAll('input.filter').forEach(input => {
    input.addEventListener('input', () => {
      const tableId = input.dataset.target;
      const q = input.value.toLowerCase();
      const table = document.getElementById(tableId);
      if (!table) return;
      Array.from(table.tBodies[0].rows).forEach(r => {
        r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  });
}
window.addEventListener('DOMContentLoaded', () => {
  bindSort();
  bindFilter();
  const initial = location.hash.replace('#', '') || 'jjwxc';
  showTab(initial);
});
"""


def _esc(s):
    return html_mod.escape(str(s) if s is not None else '')


def _fmt_int(v):
    if v is None:
        return ''
    try:
        return f'{int(v):,}'
    except (ValueError, TypeError):
        return ''


def _fmt_float(v):
    if v is None:
        return ''
    try:
        return f'{float(v):.2f}'
    except (ValueError, TypeError):
        return ''


def _fmt_age_hours(ts_str):
    t = _parse_ts(ts_str)
    if not t:
        return ''
    age_h = (datetime.now(tz=timezone.utc) - t).total_seconds() / 3600
    if age_h < 1:
        return f'{int(age_h * 60)} min ago'
    if age_h < 48:
        return f'{age_h:.1f} h ago'
    return f'{age_h / 24:.1f} d ago'


def _row_promising(view, nid, g, score):
    latest = g['latest']
    title = _name_field(latest)
    author = _author_field(latest)
    detail_url = view['detail_url_template'].format(id=nid)
    word = latest.get(view['word_field']) or 0
    chap_n = latest.get(view['chapter_field']) if view['chapter_field'] else None
    return f'''
<tr>
  <td class="num delta-up" data-v="{int(score * 100)}">{_fmt_float(score)}</td>
  <td class="num delta-up" data-v="{int(g['per_day'] * 1000)}">{_fmt_float(g['per_day'])}</td>
  <td class="num" data-v="{g['last_metric']}">{_fmt_int(g['last_metric'])}</td>
  <td class="num" data-v="{g['first_metric']}">{_fmt_int(g['first_metric'])}</td>
  <td class="num" data-v="{int(g['days'] * 100)}">{_fmt_float(g['days'])}</td>
  <td class="num muted">{g['snapshots']}</td>
  <td class="num" data-v="{word}">{_fmt_int(word)}</td>
  <td class="num" data-v="{chap_n or 0}">{_fmt_int(chap_n) if chap_n is not None else ''}</td>
  <td class="title-cell"><a href="{_esc(detail_url)}" target="_blank" rel="noopener">{_esc(title)}</a></td>
  <td class="muted">{_esc(author)}</td>
</tr>'''


def _row_discovered(view, latest):
    title = _name_field(latest)
    author = _author_field(latest)
    nid = latest.get(view['id_field'])
    detail_url = view['detail_url_template'].format(id=nid)
    metric = latest.get(view['metric_field']) or 0
    word = latest.get(view['word_field']) or 0
    chap_n = latest.get(view['chapter_field']) if view['chapter_field'] else None
    return f'''
<tr>
  <td class="num" data-v="{metric}">{_fmt_int(metric)}</td>
  <td class="num" data-v="{word}">{_fmt_int(word)}</td>
  <td class="num" data-v="{chap_n or 0}">{_fmt_int(chap_n) if chap_n is not None else ''}</td>
  <td class="title-cell"><a href="{_esc(detail_url)}" target="_blank" rel="noopener">{_esc(title)}</a></td>
  <td class="muted">{_esc(author)}</td>
</tr>'''


def _promising_table(view, top):
    metric = view['metric_label']
    metric_low = _esc(metric.lower())
    rows = ''.join(_row_promising(view, nid, g, s) for nid, g, s in top)
    return f'''<table id="tbl-promising-{view["plat_name"]}" class="sortable" data-sort-col="0" data-sort-dir="desc">
  <thead><tr>
    <th data-type="num">Score<span class="arrow">▼</span></th>
    <th data-type="num">Δ {metric_low}/day<span class="arrow"></span></th>
    <th data-type="num">{_esc(metric)} now<span class="arrow"></span></th>
    <th data-type="num">{_esc(metric)} first<span class="arrow"></span></th>
    <th data-type="num">Days<span class="arrow"></span></th>
    <th data-type="num">Snaps<span class="arrow"></span></th>
    <th data-type="num">Words<span class="arrow"></span></th>
    <th data-type="num">Chap<span class="arrow"></span></th>
    <th data-type="text">Title<span class="arrow"></span></th>
    <th data-type="text">Author<span class="arrow"></span></th>
  </tr></thead>
  <tbody>{rows}</tbody>
</table>'''


def _discovered_table(view, new):
    metric = view['metric_label']
    rows = ''.join(_row_discovered(view, r) for r in new)
    return f'''<table id="tbl-discovered-{view["plat_name"]}" class="sortable" data-sort-col="0" data-sort-dir="desc">
  <thead><tr>
    <th data-type="num">{_esc(metric)}<span class="arrow">▼</span></th>
    <th data-type="num">Words<span class="arrow"></span></th>
    <th data-type="num">Chap<span class="arrow"></span></th>
    <th data-type="text">Title<span class="arrow"></span></th>
    <th data-type="text">Author<span class="arrow"></span></th>
  </tr></thead>
  <tbody>{rows}</tbody>
</table>'''


def _platform_section(view, top_n):
    top = view['promising'][:top_n]
    new = view['just_discovered'][:top_n]
    metric = view['metric_label']

    if top:
        promising_block = _promising_table(view, top)
    else:
        promising_block = (f'<div class="empty">No novels with growth signal yet — '
                           f'need ≥2 snapshots per novel to compute Δ{_esc(metric.lower())}/day. '
                           f'First useful build is one day after deploy.</div>')

    if new:
        discovered_block = _discovered_table(view, new)
    else:
        discovered_block = '<div class="empty">No newly-discovered eligible novels.</div>'

    last_age = _fmt_age_hours(view['last_snapshot_ts']) or 'never'
    plat = view['plat_name']

    return f'''
<section class="tab" data-tab="{plat}">
  <div class="summary">
    <div><span class="label">candidates:</span> {_fmt_int(view['n_candidates'])}</div>
    <div><span class="label">snapshots:</span> {_fmt_int(view['n_snapshots'])}</div>
    <div><span class="label">unique novels snapshotted:</span> {_fmt_int(view['n_unique_snapshotted'])}</div>
    <div><span class="label">last snapshot:</span> {last_age}</div>
  </div>

  <h2>Top promising — by Δ{_esc(metric.lower())} / day</h2>
  <input class="filter" placeholder="Filter by title/author…" data-target="tbl-promising-{plat}"/>
  {promising_block}

  <h2>Just discovered (single snapshot, no growth signal yet)</h2>
  <input class="filter" placeholder="Filter…" data-target="tbl-discovered-{plat}"/>
  {discovered_block}
</section>'''


def _health_card(view):
    cls = 'ok' if view['fresh_emoji'] == '🟢' else ('warn' if view['fresh_emoji'] == '🟡' else 'err')
    err_cls = 'ok' if view['recent_errors_count'] == 0 else 'err'
    fail_cls = 'ok' if view['failures_24h'] == 0 else 'warn'
    cov_cls = ('ok' if view['coverage_missing'] == 0
               else ('warn' if view['coverage_missing'] < 50 else 'err'))

    err_block = ''
    if view['recent_errors_samples']:
        sample = '\n'.join(view['recent_errors_samples'])
        err_block = f'<details><summary>recent log errors</summary><pre>{_esc(sample)}</pre></details>'

    # Compact category-breakdown line. Order = "most specific / most useful
    # to act on" first. Only categories with >0 hits are shown.
    cats = view.get('recent_errors_counts_by_cat') or {}
    bits = []
    for k in ('403', '429', '404', '5xx', 'timeout', 'network', 'abort', 'parse', 'other'):
        v = cats.get(k, 0)
        if v:
            bits.append(f'{k}=<b>{v}</b>')
    cat_breakdown = (' · '.join(bits) if bits
                     else '<span class="muted">—</span>')

    return f'''
<div class="health-card">
  <div class="name">{view['plat_name']}</div>
  <div class="row {cls}">{view['fresh_emoji']} {_esc(view['fresh_label'])}</div>
  <div class="row {fail_cls}">⚠ failures (24h / total): <b>{view['failures_24h']} / {view['failures_total']}</b></div>
  <div class="row {cov_cls}">∅ candidates eligible at last snapshot but unscraped: <b>{view['coverage_missing']:,} / {view['coverage_total']:,}</b></div>
  <div class="row {err_cls}">✗ recent log errors (48h): <b>{view['recent_errors_count']}</b> &nbsp; {cat_breakdown}</div>
  {err_block}
</div>'''


def render_html(views, top_n=50):
    sections = '\n'.join(_platform_section(v, top_n) for v in views)
    tabs = '\n'.join(f'<button data-tab="{v["plat_name"]}" '
                     f'onclick="showTab(\'{v["plat_name"]}\')">{v["plat_name"]}</button>'
                     for v in views)
    health_cards = '\n'.join(_health_card(v) for v in views)
    built = datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    # Top-level health summary line so issues are visible without scrolling.
    any_stale = any(v['fresh_emoji'] != '🟢' for v in views)
    any_errs = any(v['recent_errors_count'] > 0 for v in views)
    any_fails = any(v['failures_24h'] > 0 for v in views)
    if any_stale or any_errs or any_fails:
        tags = []
        if any_stale: tags.append('stale data')
        if any_errs: tags.append('log errors')
        if any_fails: tags.append('per-novel failures')
        banner = f'<div style="background:#411; color:#ff8b8b; padding:8px 22px; font-size:13px;">⚠ HEALTH: {", ".join(tags)} — see cards below.</div>'
    else:
        banner = '<div style="background:#15301f; color:#6dd498; padding:8px 22px; font-size:13px;">✓ HEALTH: all platforms fresh, no recent errors.</div>'

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>novel-scrapers · top promising</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>{CSS}</style>
</head>
<body>
<header>
  <h1>novel-scrapers — top promising</h1>
  <div class="meta">Built {built} · Top {top_n} per platform · Click a title to open the source page</div>
</header>
{banner}
<div class="health">
  <div class="health-grid">{health_cards}</div>
</div>
<nav class="tabs">{tabs}</nav>
{sections}
<script>{JS}</script>
</body>
</html>
'''


# ────────── main ──────────

def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Build the static dashboard.')
    p.add_argument('--output', default='dashboard/index.html',
                   help='Output HTML path (default: dashboard/index.html). '
                        'Parent directory is created if missing.')
    p.add_argument('--top', type=int, default=50, help='Top N per platform (default: 50)')
    p.add_argument('--quiet', action='store_true')
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    views = [_platform_view(name, cfg) for name, cfg in PLATFORMS.items()]
    out = render_html(views, top_n=args.top)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out, encoding='utf-8')
    if not args.quiet:
        for v in views:
            print(f'  {v["plat_name"]:7s}  candidates={v["n_candidates"]:>4}  '
                  f'snapshots={v["n_snapshots"]:>5}  unique={v["n_unique_snapshotted"]:>4}  '
                  f'promising={len(v["promising"]):>4}  just_discovered={len(v["just_discovered"]):>4}')
    print(f'wrote {out_path} ({len(out):,} bytes)')


if __name__ == '__main__':
    main()
