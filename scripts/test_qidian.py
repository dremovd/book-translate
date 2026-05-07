"""Unit tests for qidian scraper engine.

Run from the repo root:
    python3 -m unittest scripts.test_qidian
"""

import unittest
from pathlib import Path

from scripts import _qidian_engine as eng

FIXTURES = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'qidian'


def _read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


class TestExtractPageContext(unittest.TestCase):
    def test_real_rank_fixture(self):
        ctx = eng.extract_pagecontext(_read('rank_yuepiao.html'))
        self.assertIn('pageContext', ctx)
        pd = ctx['pageContext']['pageProps']['pageData']
        self.assertEqual(pd.get('pageNum'), 1)
        self.assertGreater(pd.get('total'), 0)

    def test_missing_marker_raises(self):
        with self.assertRaises(ValueError):
            eng.extract_pagecontext('<html>no script here</html>')


class TestParseYuepiaoRecords(unittest.TestCase):
    def setUp(self):
        self.records, self.meta = eng.parse_yuepiao_records(_read('rank_yuepiao.html'))

    def test_records_present(self):
        self.assertEqual(len(self.records), 20)
        for r in self.records:
            self.assertIn('bid', r)
            self.assertIn('bName', r)
            self.assertIn('bAuth', r)
            self.assertIn('rankNum', r)

    def test_meta_present(self):
        self.assertEqual(self.meta['pageNum'], 1)
        self.assertEqual(self.meta['total'], 1000)
        self.assertEqual(self.meta['isLast'], 0)


class TestParseBookDetail(unittest.TestCase):
    def setUp(self):
        self.data = eng.parse_book_detail(_read('book_1010868264.html'))

    def test_schema_version(self):
        self.assertEqual(self.data['schema_version'], 1)

    def test_book_id_kept_as_string(self):
        self.assertEqual(self.data['book_id'], '1010868264')

    def test_book_metadata(self):
        self.assertEqual(self.data['book_name'], '诡秘之主')
        self.assertEqual(self.data['author_name'], '爱潜水的乌贼')
        self.assertEqual(self.data['author_id'], 4362088)
        self.assertEqual(self.data['cbid'], '9069458404256003')

    def test_status_completed(self):
        # actionStatus is "已经完本" → completed
        self.assertEqual(self.data['action_status'], '已经完本')
        self.assertEqual(self.data['status'], 'completed')

    def test_words_cnt_int(self):
        self.assertGreater(self.data['words_cnt'], 1_000_000)
        self.assertIsInstance(self.data['words_cnt'], int)

    def test_recom_all_int(self):
        self.assertGreater(self.data['recom_all'], 0)
        self.assertIsInstance(self.data['recom_all'], int)


class TestParseBookDetailOngoing(unittest.TestCase):
    def setUp(self):
        self.data = eng.parse_book_detail(_read('book_ongoing.html'))

    def test_status_ongoing(self):
        self.assertEqual(self.data['action_status'], '连载中')
        self.assertEqual(self.data['status'], 'ongoing')

    def test_collect_present(self):
        # Active series should have collects > 0
        self.assertGreater(self.data['collect'], 0)


class TestNormalizeStatus(unittest.TestCase):
    def test_completed(self):
        self.assertEqual(eng._normalize_status('已经完本'), 'completed')
        self.assertEqual(eng._normalize_status('完结'), 'completed')

    def test_ongoing(self):
        self.assertEqual(eng._normalize_status('连载中'), 'ongoing')
        self.assertEqual(eng._normalize_status('连载'), 'ongoing')

    def test_unknown(self):
        self.assertIsNone(eng._normalize_status(None))
        self.assertIsNone(eng._normalize_status(''))
        self.assertIsNone(eng._normalize_status('上架'))


class TestNormalizeYuepiaoRecord(unittest.TestCase):
    def test_basic(self):
        entry = {'bid': '12345', 'bName': '某书', 'bAuth': '某作者',
                 'cat': '玄幻', 'catId': 21, 'subCat': '异世大陆', 'subCatId': 73,
                 'cnt': '300万字', 'rankNum': 5, 'rankCnt': '5000月票',
                 'desc': 'short text'}
        out = eng.normalize_yuepiao_record(entry)
        self.assertEqual(out['book_id'], '12345')
        self.assertEqual(out['book_name'], '某书')
        self.assertEqual(out['rank_num'], 5)
        self.assertEqual(out['cat'], '玄幻')

    def test_int_bid_coerced_to_string(self):
        entry = {'bid': 1234567}
        out = eng.normalize_yuepiao_record(entry)
        self.assertEqual(out['book_id'], '1234567')


class TestUrlBuilders(unittest.TestCase):
    def test_yuepiao_default(self):
        self.assertEqual(eng.build_yuepiao_url(), 'https://m.qidian.com/rank/yuepiao')

    def test_yuepiao_catid(self):
        self.assertEqual(eng.build_yuepiao_url(catid='21'),
                         'https://m.qidian.com/rank/yuepiao/catid21/')

    def test_yuepiao_negative_catid(self):
        # The "all channels" slug is catid-1, with the literal hyphen.
        self.assertEqual(eng.build_yuepiao_url(catid='-1'),
                         'https://m.qidian.com/rank/yuepiao/catid-1/')

    def test_book_url(self):
        self.assertEqual(eng.build_book_url('1010868264'),
                         'https://m.qidian.com/book/1010868264')


class TestRankCatids(unittest.TestCase):
    def test_catids_present(self):
        # 15 channels harvested at scaffold time. If Qidian adds a new
        # channel this test won't fail (the engine just won't reach the
        # new books); if they remove a bunch, we want to know.
        self.assertGreaterEqual(len(eng.RANK_CATIDS), 10)
        # Every entry must be a stringified int-like (or "-1").
        for c in eng.RANK_CATIDS:
            self.assertTrue(c.lstrip('-').isdigit(), f'unexpected catid: {c!r}')


if __name__ == '__main__':
    unittest.main()
