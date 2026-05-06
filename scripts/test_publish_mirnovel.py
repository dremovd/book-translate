"""Unit tests for the mirnovel publisher.

Mirrors the structure of test_publish_rulate.py but only covers the
mirnovel-specific code paths — the pure engine (parser, splitter,
renderer, sentinel codec, comparison) is shared via _publish_engine.py
and exercised by test_publish_rulate.py + test_publish_engine_round_trip
(if present). No need to retest those here.

Coverage focus:
  - load_env / subscription_for / delayed_for (env-driven plumbing)
  - Phase A form body (action=create_chapter shape)
  - Phase B form body (action=save_chapter shape, including delayed/open/active)
  - Chapter-list scrape from the /editor/<book>/0?mode=manage HTML
"""

import importlib.util
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    'publish_mirnovel', _HERE / 'publish-mirnovel.py')
publish_mirnovel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish_mirnovel)


class TestLoadEnv(unittest.TestCase):
    """Same .env shape as rulate; we duplicate the loader rather than
    factor it out — natural duplication for a 12-line plumbing helper."""

    def test_basic(self):
        import tempfile, os
        with tempfile.NamedTemporaryFile('w', suffix='.env', delete=False) as f:
            f.write('A=1\nB=hello world\n# comment\n\nC=v=al=ue\n')
            path = Path(f.name)
        try:
            env = publish_mirnovel.load_env(path)
            self.assertEqual(env, {'A': '1', 'B': 'hello world', 'C': 'v=al=ue'})
        finally:
            os.unlink(path)

    def test_missing_file_returns_empty(self):
        self.assertEqual(publish_mirnovel.load_env(Path('/nonexistent/.env')), {})


class TestSubscriptionRule(unittest.TestCase):
    """`subscription_for` flips the mirnovel "open" toggle (paid vs.
    free). Returns True/False/None per the same semantics as rulate's
    rule but reading the MIRNOVEL_* env key."""

    def test_unset_returns_none(self):
        self.assertIsNone(publish_mirnovel.subscription_for(1, {}))
        self.assertIsNone(publish_mirnovel.subscription_for(
            1, {'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': ''}))

    def test_non_integer_returns_none(self):
        self.assertIsNone(publish_mirnovel.subscription_for(
            1, {'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': 'six'}))

    def test_threshold_inclusive(self):
        env = {'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': '6'}
        self.assertFalse(publish_mirnovel.subscription_for(5, env))
        self.assertTrue(publish_mirnovel.subscription_for(6, env))
        self.assertTrue(publish_mirnovel.subscription_for(7, env))

    def test_reads_only_mirnovel_env_key(self):
        # Must NOT pick up the rulate key by accident.
        env = {'RULATE_SUBSCRIPTION_FROM_CHAPTER': '6'}
        self.assertIsNone(publish_mirnovel.subscription_for(7, env))


class TestDelayedRule(unittest.TestCase):
    """First 6 chapters are already public on rulate, so they publish
    IMMEDIATELY on mirnovel (no timer). Chapters 7+ go on the deferred
    schedule (delayed=1). MIRNOVEL_DELAYED_FROM_CHAPTER=7 is the rule."""

    def test_unset_returns_none(self):
        self.assertIsNone(publish_mirnovel.delayed_for(1, {}))

    def test_threshold_inclusive(self):
        env = {'MIRNOVEL_DELAYED_FROM_CHAPTER': '7'}
        self.assertFalse(publish_mirnovel.delayed_for(6, env),
            'chapter 6 already public on rulate → no timer')
        self.assertTrue(publish_mirnovel.delayed_for(7, env),
            'chapter 7+ → on the deferred-publish schedule')

    def test_reads_only_mirnovel_env_key(self):
        env = {'RULATE_DELAYED_FROM_CHAPTER': '7'}
        self.assertIsNone(publish_mirnovel.delayed_for(7, env))


class TestPhaseAFormBody(unittest.TestCase):
    """Phase A on mirnovel = action=create_chapter. The endpoint is
    `POST /editor_api`, body is form-encoded with three top-level
    keys: action, book_id, data (the data field is JSON-encoded with
    the chapter's initial state)."""

    def test_basic_shape(self):
        item = {'title': 'Глава 7.1', 'paragraphs': ['x'],
                'source_chapter_index': 7, 'part_index': 1, 'total_parts': 2}
        env = {'MIRNOVEL_BOOK_ID': '290184'}
        body = publish_mirnovel.build_phase_a_body(item, env)
        # Three top-level form keys.
        self.assertIn(('action', 'create_chapter'), body)
        self.assertIn(('book_id', '290184'), body)
        # `data` is one big JSON string.
        data_json = next(v for k, v in body if k == 'data')
        import json as _j
        data = _j.loads(data_json)
        self.assertEqual(data['title'], 'Глава 7.1')
        self.assertEqual(data['body'], '',
            'Phase A creates an empty shell; the body lands in Phase B')
        self.assertEqual(data['active'], 0)


class TestPhaseBFormBody(unittest.TestCase):
    """Phase B = action=save_chapter. Sets title + body + the publish-
    state flags (active / open / amount / delayed) all in one POST."""

    def test_chapter_in_subscription_range_paid_and_delayed(self):
        # chapter 7 → delayed=1 (≥ MIRNOVEL_DELAYED_FROM_CHAPTER) AND
        # paid (open=0 because ≥ MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER).
        item = {'title': 'Глава 7.1', 'paragraphs': ['x'],
                'source_chapter_index': 7, 'part_index': 1, 'total_parts': 2}
        env = {
            'MIRNOVEL_BOOK_ID': '290184',
            'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': '6',
            'MIRNOVEL_DELAYED_FROM_CHAPTER': '7',
        }
        body = publish_mirnovel.build_phase_b_body(
            item, env, chapter_id=56326200, html_body='<p>X</p>',
            active=False)
        import json as _j
        data = _j.loads(next(v for k, v in body if k == 'data'))
        self.assertEqual(data['title'], 'Глава 7.1')
        self.assertEqual(data['body'], '<p>X</p>')
        # Send chapter_id both as outer form field and inside data
        # (matches the captured cURL — defensive duplication).
        self.assertIn(('action', 'save_chapter'), body)
        self.assertIn(('chapter_id', '56326200'), body)
        self.assertEqual(data['chapter_id'], 56326200)
        # Subscription threshold (6) and delayed threshold (7) both fire
        # at chapter index 7.
        self.assertEqual(str(data['open']), '0', 'paid → open=0')
        self.assertEqual(str(data['delayed']), '1', 'deferred → delayed=1')

    def test_chapter_below_thresholds_immediate_and_free(self):
        # chapter 5 → not delayed (5 < 7), and free (5 < 6 …) — wait,
        # subscription threshold is `>= N`, so chapter 5 with N=6 → False
        # → free (open=1). delayed threshold N=7 → False → delayed=0.
        item = {'title': 'Глава 5.1', 'paragraphs': ['x'],
                'source_chapter_index': 5, 'part_index': 1, 'total_parts': 2}
        env = {
            'MIRNOVEL_BOOK_ID': '290184',
            'MIRNOVEL_SUBSCRIPTION_FROM_CHAPTER': '6',
            'MIRNOVEL_DELAYED_FROM_CHAPTER': '7',
        }
        body = publish_mirnovel.build_phase_b_body(
            item, env, chapter_id=56326100, html_body='<p>Y</p>',
            active=True)
        import json as _j
        data = _j.loads(next(v for k, v in body if k == 'data'))
        self.assertEqual(str(data['open']), '1', 'free → open=1')
        self.assertEqual(str(data['delayed']), '0', 'no timer → delayed=0')
        self.assertEqual(str(data['active']), '1', 'published → active=1')


class TestExistingChapterIndexParse(unittest.TestCase):
    """The chapter list is embedded in the /editor/<book>/0?mode=manage
    HTML as `<div class="chapter-item manage-item" data-id="..." ...>`
    rows. Parser returns `{title → chapter_id}` so classify can map
    queue-item titles to chapter ids."""

    def test_parses_data_attrs(self):
        html = '''
        <div class="chapter-item manage-item"
             data-id="56326111" data-number="1" data-title="Глава 1.1"
             data-active="0" data-open="0" data-amount="1"
             data-letter="0" data-delayed="0">…</div>
        <div class="chapter-item manage-item"
             data-id="56326153" data-title="Новая глава"
             data-active="0">…</div>
        '''
        out = publish_mirnovel.parse_chapter_index_from_manage_html(html)
        self.assertEqual(out['Глава 1.1'], '56326111')
        self.assertEqual(out['Новая глава'], '56326153')

    def test_ignores_unrelated_divs(self):
        html = '<div class="something-else" data-id="1">x</div>'
        self.assertEqual(
            publish_mirnovel.parse_chapter_index_from_manage_html(html), {})


class TestExistingChapterTextParse(unittest.TestCase):
    """Read-back: when the chapter editor page (/editor/<book>/<id>)
    renders, the chapter's current HTML body sits in the page. We
    parse it back through `_inline_text_with_markdown` so the
    sentinel-form comparison stays consistent across publishers."""

    def test_parses_body_from_window_data(self):
        # The editor page seeds chapter data into a JS global. Locate
        # the body field, decode it, run the engine flatten so a real
        # <strong> reconstructs as a `` sentinel (matching the
        # local-side _our_chapter_text canonicalization).
        html = '''
        <html><body>
        <script>
        window.EDITOR_DATA = {chapter_id: 56326111, body: "<p>hello <strong>bold</strong> world</p>"};
        </script>
        </body></html>
        '''
        out = publish_mirnovel.parse_chapter_body_from_editor_html(html)
        # Bold reconstructs as the sentinel form so comparison with
        # `_our_chapter_text(['hello **bold** world'])` matches.
        self.assertIn('hello', out)
        self.assertIn('bold', out)
        # And `<strong>` is no longer literal markup.
        self.assertNotIn('<strong>', out)


if __name__ == '__main__':
    unittest.main()
