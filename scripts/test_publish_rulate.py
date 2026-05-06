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

    def test_strips_leading_zero_from_chapter_numbers(self):
        # Local .md exports chapters as `Глава 01`, `Глава 02`, …
        # Rulate stores them as `Глава 1`, `Глава 2`, …
        # Without normalisation, the publisher's title-based classify
        # treats `Глава 01` as a brand-new chapter and re-uploads it.
        md = (
            '# Глава 01\n\nbody1\n\n'
            '# Глава 02\n\nbody2\n\n'
            '# Глава 10\n\nbody10\n'
        )
        out = publish_rulate.parse_chapters_md(md)
        titles = [c['title'] for c in out]
        # Leading zeros stripped on 01, 02; 10 has none and stays.
        self.assertEqual(titles, ['Глава 1', 'Глава 2', 'Глава 10'])

    def test_does_not_touch_non_chapter_titles(self):
        # The normalization is anchored on the literal "Глава " prefix —
        # other heading shapes pass through verbatim.
        md = (
            '# Prologue\n\nbody\n\n'
            '# Section 01\n\nbody\n'
        )
        out = publish_rulate.parse_chapters_md(md)
        titles = [c['title'] for c in out]
        self.assertEqual(titles, ['Prologue', 'Section 01'])


class TestNormalizeChapterTitle(unittest.TestCase):
    def test_strips_one_leading_zero(self):
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 01'),  'Глава 1')
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 09'),  'Глава 9')

    def test_double_digit_chapters_pass_through(self):
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 10'),  'Глава 10')
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 100'), 'Глава 100')

    def test_strips_multiple_leading_zeros(self):
        # Edge case: defensive against zero-padded triple-digit forms
        # like "Глава 001" if anyone configures three-digit padding.
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 001'), 'Глава 1')
        self.assertEqual(publish_rulate.normalize_chapter_title('Глава 012'), 'Глава 12')

    def test_non_chapter_strings_unchanged(self):
        self.assertEqual(publish_rulate.normalize_chapter_title('Prologue'), 'Prologue')
        self.assertEqual(publish_rulate.normalize_chapter_title('Часть 01'), 'Часть 01')

    def test_titles_with_subtitles_after_the_number(self):
        # If the title has more after the number (e.g. "Глава 01: …"),
        # only the leading zero is stripped, not anything else.
        self.assertEqual(
            publish_rulate.normalize_chapter_title('Глава 01: Знакомство'),
            'Глава 1: Знакомство',
        )


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

    def test_pretagged_source_index_overrides_enumerate(self):
        # When the caller has sliced the chapter list (e.g. --from 7
        # cutting off chapters 1..6), positional enumerate would
        # restart at 1 — but the original 1-based source index has to
        # survive so the subscription rule (which fires on
        # source_chapter_index >= N) and the user-visible ordering
        # both stay correct. We tag chapters with `_source_index`
        # BEFORE slicing; the queue builder reads the tag if present.
        chapters = [
            {'title': 'G', 'paragraphs': ['x'], '_source_index': 7},
            {'title': 'H', 'paragraphs': ['y'], '_source_index': 8},
        ]
        q = publish_rulate.build_upload_queue(chapters, target=5000)
        self.assertEqual([item['source_chapter_index'] for item in q],
                         [7, 8],
                         'sliced chapters must keep their original 1-based '
                         'source index for the subscription / ordering rules')


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
            '<p style="margin-left:0px; margin-right:0px; text-align:justify">'
            '<span style="color:#000000; font-size:11pt">x</span></p>',
        )

    def test_render_chapter_concatenates_with_no_separator(self):
        out = publish_rulate.render_chapter_body_html(['a', 'b'])
        self.assertEqual(out.count('<p '), 2)
        self.assertNotIn('</p> <p ', out, 'no whitespace between blocks')
        self.assertNotIn('</p>\n<p ', out)


class TestInlineMarkdownRendering(unittest.TestCase):
    """Bold and italic markdown must reach rulate as <strong>/<em>,
    not as literal asterisks. The js side already does this in the
    editor (see js/markdown.js#renderInlineMd); the publisher had been
    sending the raw `**...**` / `*...*` text, which rulate rendered as
    plain asterisks. Tests pin the converter so a regression doesn't
    silently re-break the upload."""

    def test_double_asterisks_become_strong(self):
        out = publish_rulate.render_paragraph_html('**Примечание автора:** текст')
        self.assertIn('<strong>Примечание автора:</strong>', out)
        self.assertNotIn('**', out)

    def test_double_underscores_also_become_strong(self):
        out = publish_rulate.render_paragraph_html('Это __важно__ всем.')
        self.assertIn('<strong>важно</strong>', out)
        self.assertNotIn('__', out)

    def test_single_asterisks_become_em(self):
        out = publish_rulate.render_paragraph_html('Капли дождя — *кап-кап*, а не гром.')
        self.assertIn('<em>кап-кап</em>', out)
        # Make sure stray asterisks didn't survive outside the tags.
        self.assertEqual(out.count('*'), 0)

    def test_single_underscores_become_em(self):
        out = publish_rulate.render_paragraph_html('a _curious_ choice')
        self.assertIn('<em>curious</em>', out)

    def test_double_asterisks_match_before_single(self):
        # `**bold**` must not be parsed as `*` `bold` `*` `*` `*` —
        # the alternation tries `**` before `*` so a real bold span
        # is intact.
        out = publish_rulate.render_paragraph_html('**bold** and *italic*')
        self.assertIn('<strong>bold</strong>', out)
        self.assertIn('<em>italic</em>', out)

    def test_html_special_chars_inside_a_span_still_get_escaped(self):
        # A span's contents must still go through html_escape so the
        # rulate-side HTML stays well-formed.
        out = publish_rulate.render_paragraph_html('**a<b & c>d**')
        self.assertIn('<strong>a&lt;b &amp; c&gt;d</strong>', out)
        self.assertNotIn('<b ', out, 'angle brackets inside span MUST be escaped')

    def test_html_special_chars_outside_spans_still_get_escaped(self):
        out = publish_rulate.render_paragraph_html('plain <tag> & **bold**')
        self.assertIn('plain &lt;tag&gt; &amp; <strong>bold</strong>', out)

    def test_no_markdown_means_no_change_for_existing_chapters(self):
        # Pinning behavior for the chapters that don't use markdown:
        # output must match what the previous version produced byte-for-
        # byte. This is what keeps the "unchanged" set on rulate stable
        # under the renderer fix — no spurious diffs for plain text.
        out = publish_rulate.render_paragraph_html('Hello, world.')
        self.assertEqual(
            out,
            '<p style="margin-left:0px; margin-right:0px; text-align:justify">'
            '<span style="color:#000000; font-size:11pt">Hello, world.</span></p>',
        )

    def test_unmatched_asterisk_passes_through_as_text(self):
        # Lone `*` (no closing partner) must NOT trigger an empty <em>
        # — leave it as a literal asterisk.
        out = publish_rulate.render_paragraph_html('5 * 4 = 20')
        self.assertNotIn('<em>', out)
        self.assertIn('5 * 4 = 20', out)

    def test_dialog_split_lines_each_get_their_own_inline_render(self):
        # Multi-line dialog blocks must apply the markdown rendering to
        # each line independently so a `**...**` on the second line still
        # becomes <strong>.
        text = 'Мама сказала:\n— **Срочно** иди домой.'
        out = publish_rulate.render_paragraph_html(text)
        self.assertEqual(out.count('<p '), 2)
        self.assertIn('<strong>Срочно</strong>', out)


class TestComparisonRoundTrip(unittest.TestCase):
    """The publisher classifies "skip vs update_body" by comparing
    `_our_chapter_text(paragraphs)` against `_existing_chapter_text(...)`.
    Once render_paragraph_html emits `<strong>` / `<em>`, BS4's plain
    text extraction loses the formatting boundaries — so both sides
    must agree on a canonical form that PRESERVES the boundaries.

    Our canonical form uses private-use Unicode sentinels (``
    around bold, `` around italic). The local side translates
    `**X**` / `__X__` / `*X*` / `_X_` into sentinels; the rulate side
    walks BS4 elements and wraps `<strong>` / `<b>` and `<em>` / `<i>`
    contents in the same sentinels. Plain text on either side passes
    through unchanged.

    Round-trip invariant: `flatten(render_paragraph_html(p)) ==
    _our_chapter_text([p])`. Tests pin it for plain / bold / italic /
    mixed / dialog / HTML-specials / underscore-form.
    """

    @staticmethod
    def _flatten(html: str) -> str:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        paras = []
        for p in soup.find_all('p'):
            t = publish_rulate._inline_text_with_markdown(p).strip()
            if t:
                paras.append(publish_rulate._collapse_ws(t))
        return '\n\n'.join(paras)

    def test_plain_text(self):
        para = 'Hello, world.'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_bold(self):
        para = '**Примечание автора:** История начинается летом.'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_italic(self):
        para = 'Дождь — *кап-кап*, дробно и настойчиво.'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_mixed_bold_italic(self):
        para = '**bold** then *italic* mid-paragraph'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_underscore_forms_canonicalize_to_same_sentinels(self):
        # render_paragraph_html maps both `**` and `__` to <strong>, both
        # `*` and `_` to <em>. _our_chapter_text must canonicalize the
        # underscore forms onto the same sentinels so the round-trip holds.
        para = '__bold__ and _italic_'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_dialog_lines_with_bold(self):
        para = 'Мама сказала:\n— **Срочно** иди домой.'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_html_specials_inside_bold(self):
        para = 'see **a < b & c > d** here'
        self.assertEqual(self._flatten(publish_rulate.render_paragraph_html(para)),
                         publish_rulate._our_chapter_text([para]))

    def test_no_markdown_chapters_byte_identical_to_pre_change(self):
        # Plain-text chapters MUST keep producing the exact same bytes
        # as before, so chapters currently "unchanged" on rulate stay
        # that way without a gratuitous re-push.
        out = publish_rulate._our_chapter_text(['Hello, world.', 'Second.'])
        self.assertEqual(out, 'Hello, world.\n\nSecond.')


class TestStrongVsLiteralAsterisks(unittest.TestCase):
    """The crux of the design: a rulate-side `<strong>` MUST flatten to
    a different value than a literal `**...**` text node. Otherwise the
    publisher cannot tell apart "rulate has properly-rendered bold"
    (skip) from "rulate still has unrendered markdown" (push to apply
    the renderer fix). Without this discrimination, every chapter with
    bold pushed before the renderer fix would look "unchanged" forever
    and the fix would never actually reach rulate without --force-update."""

    @staticmethod
    def _flatten_p(html: str) -> str:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        return publish_rulate._inline_text_with_markdown(soup.find('p'))

    def test_strong_tag_emits_sentinel_not_asterisks(self):
        out = self._flatten_p('<p>foo <strong>bold</strong> bar</p>')
        self.assertNotIn('**', out, 'sentinel form must NOT use literal **')
        self.assertIn('bold', out)

    def test_literal_asterisks_pass_through_unchanged(self):
        # Pre-fix HTML: `<p><span>foo **bold** bar</span></p>` — there's
        # no <strong> to convert; the asterisks are part of a text node.
        # Flatten must leave them alone so the comparison can tell apart
        # this case from a real <strong>.
        out = self._flatten_p('<p>foo **bold** bar</p>')
        self.assertEqual(out, 'foo **bold** bar')

    def test_strong_and_literal_yield_DIFFERENT_strings(self):
        # The whole point of the design.
        sentinel = self._flatten_p('<p>x <strong>y</strong> z</p>')
        literal  = self._flatten_p('<p>x **y** z</p>')
        self.assertNotEqual(
            sentinel, literal,
            "<strong>y</strong> and literal '**y**' MUST produce different "
            "comparable strings — that's what lets the publisher detect "
            "pre-fix chapters as needing the renderer-fix re-push.")

    def test_local_bold_matches_rulate_strong_tag(self):
        local  = publish_rulate._our_chapter_text(['x **y** z'])
        rulate = publish_rulate._collapse_ws(
            self._flatten_p('<p>x <strong>y</strong> z</p>')).strip()
        self.assertEqual(local, rulate)

    def test_local_bold_does_NOT_match_pre_fix_rulate(self):
        # Pre-fix chapter on rulate today (literal **) vs local with
        # bold intent. Must mismatch → classifier flags update_body →
        # renderer fix gets applied on next push.
        local  = publish_rulate._our_chapter_text(['x **y** z'])
        rulate = publish_rulate._collapse_ws(
            self._flatten_p('<p>x **y** z</p>')).strip()
        self.assertNotEqual(local, rulate)

    def test_b_tag_treated_as_strong(self):
        # Rulate's editor sometimes emits <b>/<i> instead of
        # <strong>/<em>. They must produce the same canonical form so
        # rulate-side bold is recognized regardless of which tag is used.
        b_form      = self._flatten_p('<p>x <b>y</b> z</p>')
        strong_form = self._flatten_p('<p>x <strong>y</strong> z</p>')
        self.assertEqual(b_form, strong_form)

    def test_i_tag_treated_as_em(self):
        i_form  = self._flatten_p('<p>x <i>y</i> z</p>')
        em_form = self._flatten_p('<p>x <em>y</em> z</p>')
        self.assertEqual(i_form, em_form)


class TestFormattingChangeDetection(unittest.TestCase):
    """Adding bold (or removing it) is a real content change and MUST
    flip the classifier from skip → update_body. Otherwise the user
    could never push a "make this phrase bold" edit through this tool."""

    @staticmethod
    def _flatten_p(html: str) -> str:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        return publish_rulate._collapse_ws(
            publish_rulate._inline_text_with_markdown(soup.find('p'))).strip()

    def test_local_adds_bold_rulate_doesnt(self):
        local  = publish_rulate._our_chapter_text(['it was **important**'])
        rulate = self._flatten_p('<p>it was important</p>')
        self.assertNotEqual(local, rulate)

    def test_rulate_adds_bold_local_doesnt(self):
        # Inverse: someone bolded a phrase on rulate, our local doesn't
        # have it. Must flag a diff so _confirm_overwrite prompts before
        # we silently overwrite their formatting.
        local  = publish_rulate._our_chapter_text(['it was important'])
        rulate = self._flatten_p('<p>it was <strong>important</strong></p>')
        self.assertNotEqual(local, rulate)

    def test_same_bold_on_both_sides_is_skip(self):
        local  = publish_rulate._our_chapter_text(['it was **important**'])
        rulate = self._flatten_p('<p>it was <strong>important</strong></p>')
        self.assertEqual(local, rulate)

    def test_no_markdown_either_side_is_skip(self):
        local  = publish_rulate._our_chapter_text(['plain text'])
        rulate = self._flatten_p('<p>plain text</p>')
        self.assertEqual(local, rulate)


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


class _Args:
    """Minimal argparse-like stand-in for tests; only the fields
    `_initial_state` reads need to exist."""
    def __init__(self, **kw):
        self.__dict__.update(kw)


class TestInitialState(unittest.TestCase):
    """`_initial_state(args)` maps CLI flags to the prompt-state dict
    consumed by `_confirm_overwrite`. Pinning the mapping so a future
    rename of either flag doesn't silently drop the wiring."""

    def test_default_no_flags(self):
        st = publish_rulate._initial_state(_Args())
        self.assertEqual(st, {'all_yes': False, 'all_no': False})

    def test_yes_to_all_sets_all_yes(self):
        st = publish_rulate._initial_state(_Args(yes_to_all=True))
        self.assertTrue(st['all_yes'])
        self.assertFalse(st['all_no'])

    def test_skip_rulate_edited_sets_all_no(self):
        st = publish_rulate._initial_state(_Args(skip_rulate_edited=True))
        self.assertFalse(st['all_yes'])
        self.assertTrue(st['all_no'])


class TestConfirmOverwriteSkipsRulateEdited(unittest.TestCase):
    """`--skip-rulate-edited` (state.all_no = True) must cause
    `_confirm_overwrite` to return False on manifest-mismatch chapters
    WITHOUT prompting — that's the whole point of the flag.

    The manifest-match path still returns True even with all_no set —
    those edits are unambiguously ours, safe to push."""

    def _decision(self, rulate_text, local_text, chapter_id='42'):
        return {'action': 'update_body', 'chapter_id': chapter_id,
                'rulate_text': rulate_text, 'local_text': local_text}

    def test_manifest_mismatch_returns_false_without_prompt(self):
        decision = self._decision('on rulate', 'on disk')
        manifest = {'42': {'hash': publish_rulate._body_hash('an older body'),
                            'last_pushed_at': '2026-01-01T00:00:00Z'}}
        # Set all_no=True; if _confirm_overwrite tries to call input()
        # the test would hang — so any return without hanging proves the
        # short-circuit fires correctly.
        state = {'all_yes': False, 'all_no': True}
        ok = publish_rulate._confirm_overwrite(
            {'title': 'Глава X'}, decision, manifest, state)
        self.assertFalse(ok, 'all_no MUST short-circuit the prompt to False')

    def test_no_manifest_entry_also_skipped(self):
        # First-time push (no manifest entry) is treated like a mismatch
        # by the flag — conservative default, keeps strange rulate state
        # untouched until the user opts in.
        decision = self._decision('on rulate', 'on disk', chapter_id='999')
        manifest = {}  # no entry for chapter_id 999
        state = {'all_yes': False, 'all_no': True}
        ok = publish_rulate._confirm_overwrite(
            {'title': 'Глава X'}, decision, manifest, state)
        self.assertFalse(ok)

    def test_manifest_match_still_overwrites(self):
        # Even with all_no set, a clean manifest match is still safe to
        # overwrite — we know we authored the current rulate body.
        rulate_text = 'identical body'
        decision = self._decision(rulate_text, 'identical body')
        manifest = {'42': {'hash': publish_rulate._body_hash(rulate_text),
                            'last_pushed_at': '2026-01-01T00:00:00Z'}}
        state = {'all_yes': False, 'all_no': True}
        ok = publish_rulate._confirm_overwrite(
            {'title': 'Глава X'}, decision, manifest, state)
        self.assertTrue(ok, 'manifest match path is independent of all_no')


if __name__ == '__main__':
    unittest.main()
