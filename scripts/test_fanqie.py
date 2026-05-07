"""Unit tests for fanqie scraper engine.

Run from the repo root:
    python3 -m unittest scripts.test_fanqie
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts import _fanqie_engine as eng

FIXTURES = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'fanqie'


def _read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


class TestExtractInitialState(unittest.TestCase):
    """The state extractor must handle ``undefined`` literals (Fanqie emits
    them) and balanced-brace scanning (state is huge — naive regex won't
    do)."""

    def test_basic_object(self):
        html = '<html>x window.__INITIAL_STATE__ = {"a": 1, "b": "hi"}</html>'
        self.assertEqual(eng.extract_initial_state(html), {'a': 1, 'b': 'hi'})

    def test_undefined_becomes_null(self):
        html = '<html>window.__INITIAL_STATE__ = {"a": undefined, "b": [1, undefined, 2]}</html>'
        self.assertEqual(eng.extract_initial_state(html), {'a': None, 'b': [1, None, 2]})

    def test_strings_with_braces_dont_break_balance(self):
        html = 'window.__INITIAL_STATE__ = {"a": "hello { world }", "b": "{}"}'
        self.assertEqual(eng.extract_initial_state(html), {'a': 'hello { world }', 'b': '{}'})

    def test_missing_marker_raises(self):
        with self.assertRaises(ValueError):
            eng.extract_initial_state('<html>no state here</html>')

    def test_real_rank_fixture(self):
        state = eng.extract_initial_state(_read('rank.html'))
        self.assertIn('rank', state)
        self.assertIsInstance(state['rank']['book_list'], list)
        self.assertEqual(len(state['rank']['book_list']), 10)


class TestParseRankBookList(unittest.TestCase):
    def test_returns_ten_entries_with_required_fields(self):
        books = eng.parse_rank_book_list(_read('rank.html'))
        self.assertEqual(len(books), 10)
        for b in books:
            self.assertIn('bookId', b)
            self.assertIn('bookName', b)
            self.assertIn('author', b)


class TestParseBookDetail(unittest.TestCase):
    """Detail-page parsing must produce the canonical snapshot row."""

    def setUp(self):
        self.completed = eng.parse_book_detail(_read('page_completed_long.html'))
        self.ongoing = eng.parse_book_detail(_read('page_ongoing_short.html'))

    def test_schema_version(self):
        self.assertEqual(self.completed['schema_version'], 1)

    def test_book_id_kept_as_string(self):
        # Fanqie ids are >=18 digits; storing as int would overflow some tools.
        self.assertEqual(self.completed['book_id'], '6823667291557727235')
        self.assertIsInstance(self.completed['book_id'], str)

    def test_status_completed(self):
        self.assertEqual(self.completed['status'], 'completed')
        self.assertEqual(self.completed['creation_status'], 0)

    def test_status_ongoing(self):
        self.assertEqual(self.ongoing['status'], 'ongoing')
        self.assertEqual(self.ongoing['creation_status'], 1)

    def test_word_number_int(self):
        self.assertGreater(self.completed['word_number'], 1_000_000)
        self.assertIsInstance(self.completed['word_number'], int)

    def test_chapter_total(self):
        self.assertEqual(self.completed['chapter_total'], 966)
        self.assertEqual(self.ongoing['chapter_total'], 168)

    def test_category_v2_parsed(self):
        # categoryV2 ships as a JSON-stringified array; we parse it.
        cv2 = self.completed['category_v2']
        self.assertIsInstance(cv2, list)
        self.assertGreater(len(cv2), 0)
        self.assertIn('Name', cv2[0])

    def test_last_publish_time_int(self):
        self.assertIsInstance(self.completed['last_publish_time'], int)
        self.assertGreater(self.completed['last_publish_time'], 1_000_000_000)

    def test_thumb_url_present(self):
        self.assertTrue(self.completed['thumb_url'].startswith('http'))


class TestNormalizeRankEntry(unittest.TestCase):
    def test_translates_camel_to_snake(self):
        entry = {
            'bookId': '12345', 'bookName': 't', 'author': 'a', 'uid': 'aid',
            'category': 'cat', 'wordNumber': '500', 'readCount': '0',
            'read_count': '12345', 'creationStatus': '1',
            'lastChapterUpdateTime': '1700000000',
            'lastChapterItemId': 'cid', 'lastChapterTitle': 'ch',
            'thumbUri': 'http://x/y.jpg',
        }
        row = eng.normalize_rank_entry(entry)
        self.assertEqual(row['book_id'], '12345')
        self.assertEqual(row['author_id'], 'aid')
        self.assertEqual(row['word_number'], 500)
        self.assertEqual(row['read_count'], 12345)  # picks `read_count` over `readCount`
        self.assertEqual(row['status'], 'ongoing')
        self.assertEqual(row['last_publish_time'], 1700000000)


class TestUrls(unittest.TestCase):
    def test_rank_url_has_required_params(self):
        u = eng.build_rank_url(gender=2, category_id='1139')
        self.assertIn('gender=2', u)
        self.assertIn('category_id=1139', u)

    def test_page_url(self):
        self.assertEqual(eng.build_page_url('123'), 'https://fanqienovel.com/page/123')


class TestRankCategories(unittest.TestCase):
    def test_categories_present(self):
        # 19 male + 18 female were live-checked at scaffold time. If Fanqie
        # adds a new tag this test won't fail (length check is for ≥30, not exact),
        # but if they remove half the tags we want to know.
        self.assertGreaterEqual(len(eng.RANK_CATEGORIES), 30)
        for gender, cid, name in eng.RANK_CATEGORIES:
            self.assertIn(gender, (1, 2))
            self.assertTrue(cid.isdigit())
            self.assertTrue(name)


class TestLoadCandidateBookIds(unittest.TestCase):
    def test_basic(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'cand.jsonl')
            with open(path, 'w') as f:
                f.write(json.dumps({'book_id': 'a', 'first_seen': 'x'}) + '\n')
                f.write(json.dumps({'book_id': 'b', 'first_seen': 'y'}) + '\n')
                f.write(json.dumps({'book_id': 'a', 'first_seen': 'z'}) + '\n')  # dup
            self.assertEqual(eng.load_candidate_book_ids(path), {'a', 'b'})


if __name__ == '__main__':
    unittest.main()
