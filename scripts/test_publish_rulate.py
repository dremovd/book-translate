"""Unit tests for the publish-rulate algorithm logic.

Run from the repo root:
    python3 -m unittest scripts.test_publish_rulate
or:
    python3 scripts/test_publish_rulate.py

The CLI script lives at `scripts/publish-rulate.py` (hyphen). Hyphens
make Python imports awkward, so we use importlib.util to load it as a
module under the canonical underscore name.
"""

import importlib.util
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent / 'publish-rulate.py'
_spec = importlib.util.spec_from_file_location('publish_rulate', _SCRIPT)
publish_rulate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish_rulate)


class TestParseChaptersMd(unittest.TestCase):
    def test_basic(self):
        md = (
            '# Глава 1\n\n'
            'paragraph one\n\n'
            'paragraph two\n\n'
            '# Глава 2\n\n'
            'only paragraph\n'
        )
        out = publish_rulate.parse_chapters_md(md)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]['title'], 'Глава 1')
        self.assertEqual(out[0]['paragraphs'], ['paragraph one', 'paragraph two'])
        self.assertEqual(out[1]['title'], 'Глава 2')
        self.assertEqual(out[1]['paragraphs'], ['only paragraph'])

    def test_drops_preface(self):
        md = (
            'Some preface text without a heading.\n\n'
            '# Глава 1\n\n'
            'first.\n'
        )
        out = publish_rulate.parse_chapters_md(md)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['title'], 'Глава 1')

    def test_preserves_dialog_newlines_inside_paragraphs(self):
        # Dialog turns inside a single paragraph slot — kept as one
        # paragraph string with internal '\n', NOT split into two.
        md = (
            '# Глава 1\n\n'
            'narration line\n— Diaglog turn 1.\n— Dialog turn 2.\n\n'
            'next paragraph\n'
        )
        out = publish_rulate.parse_chapters_md(md)
        self.assertEqual(len(out[0]['paragraphs']), 2)
        self.assertEqual(out[0]['paragraphs'][0].count('\n'), 2)


class TestComputeParts(unittest.TestCase):
    def test_threshold_boundaries_target_5000(self):
        f = publish_rulate.compute_parts
        self.assertEqual(f(0,     5000), 1)
        self.assertEqual(f(5000,  5000), 1)
        self.assertEqual(f(9999,  5000), 1)
        self.assertEqual(f(10000, 5000), 1, '10000 is NOT > 10000 → 1 part')
        self.assertEqual(f(10001, 5000), 2)
        self.assertEqual(f(14999, 5000), 2)
        self.assertEqual(f(15000, 5000), 2, '15000 is NOT > 15000 → 2 parts')
        self.assertEqual(f(15001, 5000), 3)
        self.assertEqual(f(20001, 5000), 4)

    def test_zero_target_is_safe(self):
        # Defensive: a misconfigured target shouldn't make us divide by 0.
        self.assertEqual(publish_rulate.compute_parts(50000, 0), 1)


class TestSplitParagraphsBalanced(unittest.TestCase):
    def test_one_part_returns_input_unchanged(self):
        paras = ['a', 'b', 'c']
        self.assertEqual(publish_rulate.split_paragraphs_balanced(paras, 1), [paras])

    def test_equal_sized_two_parts(self):
        paras = ['x' * 100] * 4
        groups = publish_rulate.split_paragraphs_balanced(paras, 2)
        self.assertEqual([len(g) for g in groups], [2, 2])

    def test_unequal_sizes_picks_balanced_boundary(self):
        # Three small + one big → boundary should land BEFORE the big one
        # so the second group carries the bulk.
        paras = ['x' * 50, 'x' * 50, 'x' * 50, 'x' * 350]
        # Total = 500, target/part = 250, cumsum = [50, 100, 150, 500].
        # Boundary candidates 1..3 (must leave ≥1 paragraph for second group).
        # Closest to 250: |150-250|=100 (j=3) vs |100-250|=150 (j=2). Pick j=3.
        groups = publish_rulate.split_paragraphs_balanced(paras, 2)
        self.assertEqual([len(g) for g in groups], [3, 1])

    def test_three_parts_no_empty_groups_when_paragraphs_match(self):
        paras = ['a', 'b', 'c']
        groups = publish_rulate.split_paragraphs_balanced(paras, 3)
        self.assertEqual([len(g) for g in groups], [1, 1, 1])

    def test_more_parts_than_paragraphs_truncates(self):
        # Defensive: if the rule asks for 5 parts but we only have 2
        # paragraphs, give one paragraph per group and drop extras.
        groups = publish_rulate.split_paragraphs_balanced(['a', 'b'], 5)
        self.assertEqual(groups, [['a'], ['b']])


class TestBuildUploadQueue(unittest.TestCase):
    def test_no_split_when_under_threshold(self):
        chapters = [{'title': 'Глава 1', 'paragraphs': ['x' * 100]}]
        q = publish_rulate.build_upload_queue(chapters, target=5000)
        self.assertEqual(len(q), 1)
        self.assertEqual(q[0]['title'], 'Глава 1')
        self.assertEqual(q[0]['part_index'], 1)
        self.assertEqual(q[0]['total_parts'], 1)
        self.assertEqual(q[0]['source_chapter_index'], 1)

    def test_splits_into_two_parts_with_suffixed_titles(self):
        # 3 paragraphs, 4000 chars each → 12000 → 2 parts (target 5000).
        big = 'я' * 4000
        chapters = [{'title': 'Глава 1', 'paragraphs': [big, big, big]}]
        q = publish_rulate.build_upload_queue(chapters, target=5000)
        self.assertEqual(len(q), 2)
        self.assertEqual([item['title'] for item in q], ['Глава 1.1', 'Глава 1.2'])
        self.assertEqual([item['part_index'] for item in q], [1, 2])
        self.assertEqual([item['total_parts'] for item in q], [2, 2])
        self.assertEqual([item['source_chapter_index'] for item in q], [1, 1])
        # Together the parts cover all source paragraphs.
        self.assertEqual(sum(len(item['paragraphs']) for item in q), 3)

    def test_title_suffix_works_for_non_numeric_titles(self):
        big = 'a' * 4000
        chapters = [
            {'title': 'Пролог', 'paragraphs': [big, big, big]},
            {'title': 'Глава 1. Прибытие', 'paragraphs': [big, big, big]},
        ]
        q = publish_rulate.build_upload_queue(chapters, target=5000)
        titles = [item['title'] for item in q]
        self.assertIn('Пролог.1', titles)
        self.assertIn('Пролог.2', titles)
        self.assertIn('Глава 1. Прибытие.1', titles)
        self.assertIn('Глава 1. Прибытие.2', titles)

    def test_source_chapter_index_propagates_through_parts(self):
        big = 'a' * 4000
        chapters = [
            {'title': 'A', 'paragraphs': ['short']},                     # 1 part
            {'title': 'B', 'paragraphs': [big, big, big]},               # 2 parts
            {'title': 'C', 'paragraphs': ['short']},                     # 1 part
        ]
        q = publish_rulate.build_upload_queue(chapters, target=5000)
        # A → src 1, B parts → src 2, C → src 3.
        self.assertEqual([item['source_chapter_index'] for item in q],
                         [1, 2, 2, 3])


class TestRenderHtml(unittest.TestCase):
    def test_html_escape_handles_ampersand_first(self):
        self.assertEqual(
            publish_rulate.html_escape('A&B<C>D'),
            'A&amp;B&lt;C&gt;D',
        )

    def test_render_paragraph_one_line_one_p(self):
        out = publish_rulate.render_paragraph_html('Hello, world.')
        self.assertEqual(out.count('<p '), 1)
        self.assertIn('Hello, world.', out)

    def test_render_paragraph_dialog_lines_become_separate_p_blocks(self):
        text = 'Мама сказала:\n— Иди домой.\n— Уже поздно.'
        out = publish_rulate.render_paragraph_html(text)
        self.assertEqual(out.count('<p '), 3)

    def test_render_paragraph_drops_blank_lines(self):
        out = publish_rulate.render_paragraph_html('A\n\n\nB')
        self.assertEqual(out.count('<p '), 2)

    def test_render_paragraph_uses_exact_template(self):
        out = publish_rulate.render_paragraph_html('x')
        self.assertEqual(
            out,
            '<p style="margin-left:0cm; margin-right:0cm; text-align:justify;">'
            '<span style="color:#000000">x</span></p>',
        )

    def test_render_chapter_concatenates_with_no_separator(self):
        out = publish_rulate.render_chapter_body_html(['a', 'b'])
        self.assertEqual(out.count('<p '), 2)
        self.assertNotIn('</p> <p ', out, 'no whitespace between blocks')
        self.assertNotIn('</p>\n<p ', out)


class TestSubscriptionRule(unittest.TestCase):
    def test_unset_returns_none(self):
        self.assertIsNone(publish_rulate.subscription_for(1, {}))
        self.assertIsNone(publish_rulate.subscription_for(1, {'RULATE_SUBSCRIPTION_FROM_CHAPTER': ''}))
        self.assertIsNone(publish_rulate.subscription_for(1, {'RULATE_SUBSCRIPTION_FROM_CHAPTER': 'abc'}))

    def test_threshold_inclusive(self):
        env = {'RULATE_SUBSCRIPTION_FROM_CHAPTER': '10'}
        self.assertFalse(publish_rulate.subscription_for(9,  env))
        self.assertTrue(publish_rulate.subscription_for(10, env))
        self.assertTrue(publish_rulate.subscription_for(11, env))


if __name__ == '__main__':
    unittest.main()
