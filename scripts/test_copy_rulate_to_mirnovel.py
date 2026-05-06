"""Tests for the rulate→mirnovel copy script. Only the pure helpers
get unit tests here; the orchestration is verified live via --dry-run."""

import importlib.util
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    'copy_rulate_to_mirnovel', _HERE / 'copy-rulate-to-mirnovel.py')
copy_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(copy_mod)


class TestParseChapterTitle(unittest.TestCase):
    """`Глава N` and `Глава N.K` → (source_index, part_index). Anything
    else → (None, None) so the caller drops it from the copy queue."""

    def test_single_part(self):
        self.assertEqual(copy_mod.parse_chapter_title('Глава 5'), (5, 1))

    def test_multi_part(self):
        self.assertEqual(copy_mod.parse_chapter_title('Глава 6.2'), (6, 2))

    def test_double_digit_chapter(self):
        self.assertEqual(copy_mod.parse_chapter_title('Глава 12.3'), (12, 3))

    def test_unrecognized_title(self):
        self.assertEqual(copy_mod.parse_chapter_title('Пролог'), (None, None))
        self.assertEqual(copy_mod.parse_chapter_title('Chapter 1'), (None, None))
        self.assertEqual(copy_mod.parse_chapter_title(''), (None, None))
        self.assertEqual(copy_mod.parse_chapter_title(None), (None, None))

    def test_title_with_subtitle_after_number(self):
        # "Глава 1. Прибытие" — keep the source index, the subtitle is dropped.
        self.assertEqual(copy_mod.parse_chapter_title('Глава 1. Прибытие'),
                         (1, 1))


class TestParseChapterParams(unittest.TestCase):
    """The copy must mirror rulate's actual subscription / post_open
    state — without this, mirnovel ends up with the wrong paid/delayed
    flags whenever rulate's truth differs from the env-threshold rule
    (e.g. chapter 6 was made free on rulate, but the threshold says paid)."""

    def _form(self, sub_checked: bool, post_open_checked: bool) -> str:
        sub_attr = ' checked="checked"' if sub_checked else ''
        po_attr = ' checked="checked"' if post_open_checked else ''
        return f'''
        <input type="checkbox" name="Chapter[subscription]" value="0">
        <input type="checkbox" name="Chapter[subscription]" value="1"{sub_attr}>
        <input type="checkbox" name="Chapter[post_open]" value="0">
        <input type="checkbox" name="Chapter[post_open]" value="1"{po_attr}>
        '''

    def test_both_off(self):
        out = copy_mod.parse_chapter_params_from_edit_html(self._form(False, False))
        self.assertEqual(out['subscription'], False)
        self.assertEqual(out['post_open'], False)

    def test_subscription_on(self):
        out = copy_mod.parse_chapter_params_from_edit_html(self._form(True, False))
        self.assertTrue(out['subscription'])
        self.assertFalse(out['post_open'])

    def test_post_open_on(self):
        out = copy_mod.parse_chapter_params_from_edit_html(self._form(False, True))
        self.assertFalse(out['subscription'])
        self.assertTrue(out['post_open'])

    def test_unrelated_checkboxes_ignored(self):
        # Other Chapter[*] checkboxes (audio_subscription, has_override, …)
        # must not influence the two flags we care about.
        html = '''
        <input type="checkbox" name="Chapter[audio_subscription]" value="1" checked>
        <input type="checkbox" name="Chapter[has_override]" value="1" checked>
        <input type="checkbox" name="Chapter[subscription]" value="1">
        <input type="checkbox" name="Chapter[post_open]" value="1">
        '''
        out = copy_mod.parse_chapter_params_from_edit_html(html)
        self.assertEqual(out['subscription'], False)
        self.assertEqual(out['post_open'], False)

    def _form_with_status(self, status_value: str) -> str:
        opts = []
        for v, label in [('1', 'идёт перевод'),
                         ('2', 'перевод редактируется'),
                         ('3', 'перевод готов')]:
            sel = ' selected="selected"' if v == status_value else ''
            opts.append(f'<option value="{v}"{sel}>{label}</option>')
        return ('<select name="Chapter[status]">' + ''.join(opts) +
                '</select>')

    def test_status_extracted_from_selected_option(self):
        for v in ('1', '2', '3'):
            out = copy_mod.parse_chapter_params_from_edit_html(self._form_with_status(v))
            self.assertEqual(out['status'], v,
                             f'expected status={v} from <option value={v} selected>')

    def test_status_none_when_no_selected_option(self):
        html = ('<select name="Chapter[status]">'
                '<option value="1">a</option>'
                '<option value="2">b</option>'
                '</select>')
        out = copy_mod.parse_chapter_params_from_edit_html(html)
        self.assertIsNone(out['status'])


class TestPublishedOrReadyFilter(unittest.TestCase):
    """`--published-or-ready` keeps a queue item when it's either
    already public (post_open=False) OR scheduled-but-ready
    (post_open=True AND status='3'). Drops still-editing chapters
    (status='1' or '2') that aren't yet public, since pushing them to
    mirnovel would mean publishing unfinished work."""

    def _item(self, post_open: bool, status):
        return {'title': 'Глава X', 'paragraphs': ['x'],
                'source_chapter_index': 1, 'part_index': 1, 'total_parts': 1,
                'open_override': False, 'delayed_override': post_open,
                'rulate_status': status}

    def test_keeps_already_public_regardless_of_status(self):
        for st in ('1', '2', '3', None):
            self.assertTrue(copy_mod._published_or_ready(self._item(False, st)),
                            f'public chapter (status={st!r}) MUST be kept')

    def test_keeps_scheduled_when_status_is_ready(self):
        self.assertTrue(copy_mod._published_or_ready(self._item(True, '3')))

    def test_drops_scheduled_when_status_is_in_progress_or_editing(self):
        self.assertFalse(copy_mod._published_or_ready(self._item(True, '1')))
        self.assertFalse(copy_mod._published_or_ready(self._item(True, '2')))

    def test_drops_scheduled_when_status_unknown(self):
        # Conservative default: missing status → don't push.
        self.assertFalse(copy_mod._published_or_ready(self._item(True, None)))


class TestPhaseBOverride(unittest.TestCase):
    """The copy queue stamps `open_override` / `delayed_override` onto
    each item (mirroring rulate's actual flags). build_phase_b_body
    must honor those instead of the env threshold defaults — that's
    what makes 'copy including parameters' actually copy them."""

    def test_open_override_wins_over_env_threshold(self):
        # env says chapter 6 should be paid (open=0), but rulate has it
        # free → override forces open=1.
        item = {
            'title': 'Глава 6.1', 'paragraphs': ['x'],
            'source_chapter_index': 6, 'part_index': 1, 'total_parts': 2,
            'open_override': False,    # = "subscription off on rulate" = free
            'delayed_override': False,
        }
        env = {'MIRNOVEL_BOOK_ID': '290184',
               'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': '6',
               'MIRNOVEL_DELAYED_FROM_CHAPTER': '7'}
        body = copy_mod.mn.build_phase_b_body(
            item, env, chapter_id=1, html_body='<p>x</p>', active=True)
        import json as _j
        data = _j.loads(next(v for k, v in body if k == 'data'))
        self.assertEqual(str(data['open']), '1',
            'override=False (free) MUST set open=1 even though the threshold says paid')

    def test_delayed_override_wins_over_env_threshold(self):
        item = {
            'title': 'Глава 1', 'paragraphs': ['x'],
            'source_chapter_index': 1, 'part_index': 1, 'total_parts': 1,
            'open_override': False,
            'delayed_override': True,  # post_open=on on rulate even for early chapter
        }
        env = {'MIRNOVEL_DELAYED_FROM_CHAPTER': '7'}
        body = copy_mod.mn.build_phase_b_body(
            item, env, chapter_id=1, html_body='<p>x</p>', active=True)
        import json as _j
        data = _j.loads(next(v for k, v in body if k == 'data'))
        self.assertEqual(str(data['delayed']), '1')


if __name__ == '__main__':
    unittest.main()
