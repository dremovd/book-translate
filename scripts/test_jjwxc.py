"""Unit tests for jjwxc discovery/snapshot helpers.

Run from the repo root:
    python3 -m unittest scripts.test_jjwxc
or:
    python3 scripts/test_jjwxc.py
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts import _jjwxc_engine as eng

FIXTURES = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'jjwxc'


def _read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


class TestParseBookbaseListing(unittest.TestCase):
    def test_extracts_unique_ids_in_order(self):
        html = _read('bookbase_p1.html')
        ids = eng.parse_bookbase_listing(html)
        self.assertGreater(len(ids), 20, 'expected >20 novels per listing page')
        self.assertEqual(len(ids), len(set(ids)), 'ids must be unique')

    def test_returns_ints(self):
        html = _read('bookbase_newest.html')
        ids = eng.parse_bookbase_listing(html)
        self.assertTrue(all(isinstance(i, int) for i in ids))
        # Newest-first listing should have very recent (= large) ids.
        self.assertGreater(max(ids), 10_000_000)

    def test_empty_html_yields_empty(self):
        self.assertEqual(eng.parse_bookbase_listing(''), [])
        self.assertEqual(eng.parse_bookbase_listing('<html>nope</html>'), [])


class TestParseOnebookCompleted(unittest.TestCase):
    def setUp(self):
        self.data = eng.parse_onebook_html(_read('onebook_10000.html'))

    def test_title_author_genre(self):
        self.assertEqual(self.data['title'], '霁雪问晴')
        self.assertEqual(self.data['author'], '沾衣')
        self.assertIn('原创-言情', self.data['genre'])

    def test_numeric_fields(self):
        self.assertEqual(self.data['word_count'], 65845)
        self.assertEqual(self.data['collects'], 21)
        self.assertEqual(self.data['reviews'], 135)
        self.assertEqual(self.data['score'], 1_531_163)

    def test_status_completed(self):
        self.assertEqual(self.data['status'], 'completed')

    def test_chapter_count_positive(self):
        self.assertGreater(self.data['chapter_count'], 5)

    def test_last_update_iso_like(self):
        self.assertEqual(self.data['last_update'], '2006-07-11 21:47:11')

    def test_tags_nonempty(self):
        self.assertGreater(len(self.data['tags']), 0)

    def test_tags_have_no_nbsp_entities(self):
        for t in self.data['tags']:
            self.assertNotIn('&nbsp;', t)
            self.assertNotIn('\xa0', t)


class TestParseOnebookOngoing(unittest.TestCase):
    def setUp(self):
        self.data = eng.parse_onebook_html(_read('onebook_ongoing.html'))

    def test_status_ongoing(self):
        self.assertEqual(self.data['status'], 'ongoing')

    def test_zero_collects_handled(self):
        self.assertEqual(self.data['collects'], 0)
        self.assertEqual(self.data['score'], 0)
        self.assertEqual(self.data['reviews'], 0)

    def test_word_count_present(self):
        self.assertEqual(self.data['word_count'], 3678)

    def test_title_author(self):
        self.assertEqual(self.data['title'], '晴雨天')
        self.assertEqual(self.data['author'], '且之')


class TestParseOnebookRestricted(unittest.TestCase):
    """Some novel pages omit articleSection/author itemprops (e.g.
    restricted-view variants for certain content categories). The parser
    must fall back to <h1>/<title> instead of returning None."""

    def setUp(self):
        self.data = eng.parse_onebook_html(_read('onebook_restricted.html'))

    def test_title_via_fallback(self):
        self.assertEqual(self.data['title'], '恋爱军师有天也会情不自禁（情非得已）')

    def test_author_via_fallback(self):
        self.assertEqual(self.data['author'], '山郁寻')

    def test_numeric_fields_still_parsed(self):
        # collects/genre/etc. itemprops are present even in this layout.
        self.assertIsNotNone(self.data['collects'])
        self.assertIsNotNone(self.data['genre'])


class TestParseLastUpdatePlaceholder(unittest.TestCase):
    """jjwxc returns 0000-00-00 00:00:00 for novels with no chapters yet —
    the parser must normalize that to None so downstream date arithmetic
    doesn't choke."""

    def test_placeholder_becomes_none(self):
        html = '<html><meta name="Keywords" content="x|最新更新:0000-00-00 00:00:00|y"/></html>'
        d = eng.parse_onebook_html(html)
        self.assertIsNone(d['last_update'])

    def test_real_date_preserved(self):
        html = '<html><meta name="Keywords" content="x|最新更新:2026-05-07 12:34:56|y"/></html>'
        d = eng.parse_onebook_html(html)
        self.assertEqual(d['last_update'], '2026-05-07 12:34:56')


class TestStripsAndCollapse(unittest.TestCase):
    def test_strip_tags_basic(self):
        self.assertEqual(eng._strip_tags('<b>x</b><i>y</i>z'), 'xyz')

    def test_collapse_ws(self):
        self.assertEqual(eng._collapse_ws('  a\n\tb  '), 'a b')

    def test_parse_int_with_commas(self):
        self.assertEqual(eng._parse_int('1,531,163'), 1_531_163)
        self.assertEqual(eng._parse_int('65845字'), 65845)
        self.assertIsNone(eng._parse_int(None))
        self.assertIsNone(eng._parse_int('abc'))


class TestUrlBuilders(unittest.TestCase):
    def test_bookbase_url_has_required_params(self):
        u = eng.build_bookbase_url(sort_type=3, page=2, isfinish=1)
        self.assertIn('sortType=3', u)
        self.assertIn('page=2', u)
        self.assertIn('isfinish=1', u)

    def test_onebook_url(self):
        self.assertEqual(eng.build_onebook_url(123), 'https://www.jjwxc.net/onebook.php?novelid=123')


class TestJsonlRoundTrip(unittest.TestCase):
    def test_append_and_read(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'data', 'snap.jsonl')
            eng.append_jsonl(path, {'novel_id': 1, 'collects': 100})
            eng.append_jsonl(path, {'novel_id': 2, 'collects': 200})
            rows = list(eng.read_jsonl(path))
            self.assertEqual(rows, [
                {'novel_id': 1, 'collects': 100},
                {'novel_id': 2, 'collects': 200},
            ])

    def test_read_missing_yields_nothing(self):
        rows = list(eng.read_jsonl('/tmp/__definitely_missing_xyz.jsonl'))
        self.assertEqual(rows, [])

    def test_load_candidate_ids(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'cand.jsonl')
            eng.append_jsonl(path, {'novel_id': 11, 'first_seen': 'x'})
            eng.append_jsonl(path, {'novel_id': 22, 'first_seen': 'y'})
            eng.append_jsonl(path, {'novel_id': 11, 'first_seen': 'z'})  # dup
            self.assertEqual(eng.load_candidate_ids(path), {11, 22})


class TestGrowthCompute(unittest.TestCase):
    """jjwxc-growth.py loads snapshots and ranks by Δcollects/day. The
    telescope identity says averaging consecutive deltas equals last-minus-
    first / total-days, so compute_growth uses last-minus-first."""

    def setUp(self):
        # Lazy-import the script (hyphenated filename → importlib).
        import importlib.util
        path = Path(__file__).resolve().parent / 'jjwxc-growth.py'
        spec = importlib.util.spec_from_file_location('jjwxc_growth', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.growth = mod

    def test_returns_none_for_single_snapshot(self):
        rows = [{'ts': '2026-05-01T00:00:00Z', 'novel_id': 1, 'collects': 10}]
        self.assertIsNone(self.growth.compute_growth(rows))

    def test_returns_none_for_zero_window(self):
        rows = [
            {'ts': '2026-05-01T00:00:00Z', 'novel_id': 1, 'collects': 10},
            {'ts': '2026-05-01T00:00:00Z', 'novel_id': 1, 'collects': 50},
        ]
        self.assertIsNone(self.growth.compute_growth(rows))

    def test_basic_growth(self):
        rows = [
            {'ts': '2026-05-01T00:00:00Z', 'novel_id': 1, 'collects': 100,
             'title': 't', 'author': 'a'},
            {'ts': '2026-05-03T00:00:00Z', 'novel_id': 1, 'collects': 200,
             'title': 't', 'author': 'a', 'status': 'ongoing'},
        ]
        g = self.growth.compute_growth(rows)
        self.assertEqual(g['delta_collects'], 100)
        self.assertEqual(g['days'], 2.0)
        self.assertEqual(g['collects_per_day'], 50.0)

    def test_telescope_identity(self):
        # last-minus-first should equal sum of pairwise consecutive deltas / total time
        rows = [
            {'ts': '2026-05-01T00:00:00Z', 'novel_id': 1, 'collects': 0},
            {'ts': '2026-05-02T00:00:00Z', 'novel_id': 1, 'collects': 10},
            {'ts': '2026-05-03T00:00:00Z', 'novel_id': 1, 'collects': 30},
            {'ts': '2026-05-04T00:00:00Z', 'novel_id': 1, 'collects': 60},
        ]
        g = self.growth.compute_growth(rows)
        self.assertEqual(g['delta_collects'], 60)
        self.assertEqual(g['days'], 3.0)
        self.assertEqual(g['collects_per_day'], 20.0)


class TestLock(unittest.TestCase):
    """The cron driver depends on _Lock raising on contention so a second
    invocation can exit with EX_TEMPFAIL instead of corrupting state by
    running concurrently."""

    def test_acquire_and_release(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'x.lock')
            with eng._Lock(path):
                self.assertTrue(os.path.exists(path))
            # After release, another acquire must succeed.
            with eng._Lock(path):
                pass

    def test_contention_raises(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'x.lock')
            with eng._Lock(path):
                with self.assertRaises(RuntimeError) as cm:
                    with eng._Lock(path):
                        pass
                self.assertIn('lock held', str(cm.exception))

    def test_writes_pid(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'x.lock')
            with eng._Lock(path):
                self.assertEqual(open(path).read().strip(), str(os.getpid()))


if __name__ == '__main__':
    unittest.main()
