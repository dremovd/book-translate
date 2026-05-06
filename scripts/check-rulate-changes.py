#!/usr/bin/env python3
"""Compare each chapter in the local .md against what is currently on
rulate. Read-only: never POSTs, never modifies rulate, never writes to
the manifest.

Usage: scripts/check-rulate-changes.py path/to/book.md

Per-chapter status (printed in local-md order):

  unchanged     rulate body matches local — would be skipped on push.
  local-ahead   rulate body differs from local AND manifest matches
                rulate → we have an unpushed local edit.
  rulate-edited rulate body differs from BOTH local and manifest →
                someone touched rulate after our last push (or before
                we started tracking it via the manifest).
  no-manifest   rulate body differs from local AND no manifest entry —
                first time we'd touch this chapter via the script, so
                we cannot tell who edited what; treat as a careful
                push candidate.
  rulate-only   chapter exists on rulate but not in the local .md.
  local-only    chapter exists in the local .md but not on rulate.
"""

import argparse
import importlib.util
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent

# publish-rulate.py uses a hyphen, so it isn't a normal import path.
# Load it by file location instead.
_spec = importlib.util.spec_from_file_location(
    'publish_rulate', _HERE / 'publish-rulate.py')
pr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr)


def main(argv):
    p = argparse.ArgumentParser(prog='check-rulate-changes')
    p.add_argument('md', help='Path to the .md export of the translation')
    p.add_argument('--diff', action='store_true',
                   help='For every chapter where rulate ≠ local, print up to '
                        '--diff-hunks unified-diff hunks (rulate vs local).')
    p.add_argument('--diff-hunks', type=int, default=0, metavar='N',
                   help='Max hunks to print per changed chapter (default: 0 = '
                        'all hunks). Pass a positive integer to truncate.')
    p.add_argument('--diff-only', action='store_true',
                   help='Suppress the per-chapter status line; print ONLY the '
                        'diff blocks. Useful for piping the output. Implies --diff.')
    args = p.parse_args(argv[1:])
    if args.diff_only:
        args.diff = True

    repo = _HERE.parent
    env = pr.load_env(repo / '.env')
    book_id = env.get('RULATE_BOOK_ID')
    if not book_id:
        print('RULATE_BOOK_ID is unset.', file=sys.stderr)
        return 2

    md_path = Path(args.md).expanduser().resolve()
    chapters = pr.parse_chapters_md(md_path.read_text(encoding='utf-8'))
    target = int(env.get('RULATE_TARGET_CHARS_NO_SPACES', '5000') or '5000')
    # Build the same upload queue the publisher uses so titles line up
    # with rulate (long source chapters get split into ".1"/".2" parts).
    queue = pr.build_upload_queue(chapters, target=target)
    print(f'parsed {len(chapters)} source chapter(s) → {len(queue)} upload item(s) '
          f'(target={target} no-space chars/part)')

    cookies = pr._auth_cookies(env)
    s = pr._make_session(env, cookies)
    if not pr._warm_up(s, book_id):
        print('warm-up failed', file=sys.stderr)
        return 2

    rulate_index = pr._existing_chapter_index(s, book_id)
    print(f'{len(rulate_index)} chapter(s) found on rulate')

    manifest = pr._load_manifest()
    if not manifest:
        print('(manifest .rulate-state.json is empty or missing — '
              'no-manifest will be the dominant status for any local≠rulate diff)')

    statuses = {
        'unchanged': 0, 'local-ahead': 0, 'rulate-edited': 0,
        'no-manifest': 0, 'rulate-only': 0, 'local-only': 0,
    }
    print()
    print(f'{"#":>3}  {"status":<14} title')

    local_title_set = {item['title'] for item in queue}
    for i, item in enumerate(queue, 1):
        title = item['title']
        if title not in rulate_index:
            statuses['local-only'] += 1
            print(f'{i:>3}  local-only     {title}')
            continue
        chapter_id = rulate_index[title]
        rulate_text = pr._existing_chapter_text(s, book_id, chapter_id) or ''
        local_text = pr._our_chapter_text(item['paragraphs'])
        rulate_hash = pr._body_hash(rulate_text)
        local_hash = pr._body_hash(local_text)
        if rulate_hash == local_hash:
            statuses['unchanged'] += 1
            if not args.diff_only:
                print(f'{i:>3}  unchanged      {title}')
            continue
        manifest_entry = manifest.get(str(chapter_id)) or {}
        last_pushed_hash = manifest_entry.get('hash')
        if last_pushed_hash is None:
            status_label = 'no-manifest'
            statuses[status_label] += 1
            note = '(rulate ≠ local, never tracked)'
        elif last_pushed_hash == rulate_hash:
            status_label = 'local-ahead'
            statuses[status_label] += 1
            note = '(unpushed local edit)'
        else:
            status_label = 'rulate-edited'
            statuses[status_label] += 1
            note = '(rulate changed since our last push)'
        if not args.diff_only:
            print(f'{i:>3}  {status_label:<14} {title}  {note}')

        if args.diff:
            n = args.diff_hunks if args.diff_hunks > 0 else 10**6
            hunks, total = pr._format_first_n_hunks(rulate_text, local_text, n=n)
            header = (f'\n--- DIFF: chapter {title} ({status_label})  '
                      f'[{len(hunks)} of {total} hunk{"" if total == 1 else "s"}]')
            print(header)
            print('--- rulate (current)')
            print('+++ local (.md)')
            for h in hunks:
                for line in h:
                    print(line)
            if total > len(hunks):
                print(f'... ({total - len(hunks)} more hunk(s) suppressed; '
                      f'pass --diff-hunks=0 for full diff)')
            if total == 0:
                # Hashes differ but the humanized display is identical →
                # the change is at the markup level (literal `**` text
                # node on rulate vs. a real <strong> in our rendered HTML
                # post-renderer-fix). The publish flow will re-push this
                # chapter so rulate stores the proper bold tag.
                print('  (no visible text diff — formatting/markup change only;')
                print('   pushing will replace literal `**` with <strong>/<em>)')
            print()

    for title in sorted(set(rulate_index) - local_title_set):
        statuses['rulate-only'] += 1
        print(f'   .  rulate-only    {title}')

    print()
    summary = ', '.join(f'{k}={v}' for k, v in statuses.items() if v > 0)
    print('summary:', summary or 'no chapters compared')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
