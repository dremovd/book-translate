# Changelog

The export envelope (and the localforage persistence shape it mirrors)
carries a `version` field that pins which version of the tool produced
the artifact. The constant lives in [`js/version.js`](js/version.js)
as `APP_VERSION`, and gets stamped into every JSON export's
`version` field by both editors' `serializeState`.

**Discipline:** every commit that changes user-visible behavior,
prompts, default configuration, persisted-state shape, or the
exported envelope **must** bump `APP_VERSION` and add an entry to
this file. PRs without the bump should be rejected.

Importers are backward-compatible — older shapes load via the
migrations in `js/state-helpers.js` (`migrateLegacyConfig`,
`migrateLegacyStats`) — so older exports keep importing into newer
tool versions without intervention. Going the other way (a newer
export into an older tool) silently drops fields the older code
doesn't know about; the version stamp lets you recognize that case.

## v9 — 2026-05-05

**Apply-rules tab adopts the editor's grid layout.** The 4-column
diff table (`# / Current / Suggested / Actions`) becomes the same
two-column `.paragraphs` grid the editor uses: translation on the
left at `--split-pct`, original on the right. Each row carries:

- A tiny row-number badge above the translation (`T` / `1` / `2` …,
  same compact label introduced in v7).
- The current translation, rendered through `renderMd` so `**bold**`
  shows as bold (the editor already did this in rendered mode; the
  rules tab used `x-text` and showed literal asterisks).
- On diff rows, the layout reads top-to-bottom as
  **current → accept/reject buttons → suggestion**, so the eye
  finds the decision point right at the boundary. The "before"
  side gets a thin red left bar, the "after" side a thin yellow
  one — no background fills (those were drowning out the text on
  short paragraphs and looking like alert boxes). Non-diff rows
  stay completely neutral so reading the chapter doesn't feel
  like reading a diff.
- The original paragraph in the right column, also markdown-
  rendered.

`chapterRulesRows` gained an `original` field for the new column;
existing `current` / `suggestion` / `key` / `label` shape unchanged.
The deprecated `.rules-diff` table CSS was replaced with grid-mode
styles (`.rules-paragraphs`, `.rules-suggestion-block`, etc.).

**Markdown bold in the Apply-rules tab.** The editor's rendered
mode already mapped `**...**` → `<strong>` via `renderInlineMd`;
the rules tab now does the same in both the current-translation
and suggestion cells (and the original column on the right). The
title row in the editor stays a plain `<input>` — single-line
inputs can't render rich text without contenteditable, which would
break paste behavior.

## v8 — 2026-05-05

**Apply-rules work tracked separately from translation work.**
`stats.byChapter[idx]` is now split into two sub-buckets:

- `editor` — minutes spent in the translation tab (typing, scrolling,
  per-paragraph retranslate). Same shape as the previous flat entry.
- `rules` — minutes spent in the Apply-rules tab (running passes,
  scrolling the diff, accepting/rejecting suggestions).

Each sub-bucket has its own `_lastMinute` dedup, so editor and rules
work in the same wall-clock minute each get one bump rather than one
combined. Multiple rules passes on the same chapter accumulate into
the same `rules` sub-bucket, so iterations sum.

`charsPerHourTotal` (and the editor status bar's time-left estimate)
now denominate on **editor minutes only** — rules polishes existing
text, it doesn't produce new chars, so mixing those minutes in would
understate the editor's typing rate.

The Stats table gains an **Rules min** column, sitting next to the
existing Editor-min column. Chapters with only rules-tab work (no
editor minutes) show `—` for chars/h since the rate is undefined.

**Migration.** Pre-split `byChapter[idx] = {minutes, _lastMinute,
firstWorkAt, lastWorkAt}` saves are lifted into `{editor: <flat>,
rules: emptyBucket}` on read — historical work was all editor work
(the rules tab didn't exist), so the attribution is exact. The
bilingual editor uses the same shape; only the editor sub-bucket
is ever written there.

## v7 — 2026-05-05

**Apply-rules row labels trimmed.** The first column on the diff
table previously showed `Chapter title` / `Paragraph 1` / `Paragraph
2` etc., which was wide and chatty. Now it shows `T` for the title
row and the bare 1-based index for paragraph rows. Column narrowed
to ~2.5rem, right-aligned with tabular-nums, muted color — reads
as a row-number gutter rather than a label column.

State unchanged; pure cosmetic.

## v6 — 2026-05-05

**Apply-rules tab gets the editor-grid layout.** Previously the tab
showed only the diff table after a pass had run, with no way to
navigate between chapters or read the source while typing the rules.

Now:
- **Chapter sidebar** on the left (same affordance as the editor
  view): click any non-pending chapter to switch the rules tab to
  that chapter. A small dot marker next to chapter titles flags
  chapters with pending suggestions so multi-chapter passes are
  easy to spot.
- **Full chapter visible** on the right at all times: title row
  plus every paragraph in order, even when no pass has run yet.
  Useful for reading the chapter while typing the rules.
- **Diff inline**: rows with a pending suggestion light up the
  `Suggested` column + accept/reject buttons. Rows without a
  suggestion stay neutral.

Renamed the view-friendly getter from `pendingPassRows` (diffs
only) to `chapterRulesRows` (all paragraphs annotated with optional
suggestion) since the new layout shows every paragraph regardless
of pending state.

## v5 — 2026-05-05

**Russian dialog block: gesture/emotion/thought tags treated as speaker
tags.** The auto-injected dialog block previously distinguished only
between speech-reporting verbs (comma + lowercase) and standalone
actions (period + capital). The intermediate case — a gesture or
emotion descriptor that *frames the speaker's beat* — was ambiguous,
which left users having to spell it out in their Apply-rules prompt.

Now the dispatch is explicit:
- Continuation tags (verba dicendi OR thought/emotion/gesture
  descriptors that frame the same beat) → comma + lowercase, e.g.
  `— Не переживай, — она улыбнулась.`
- Independent actions after the speech ends → period + capital, e.g.
  `— Не переживай. — Она улыбнулась.`

The same word (`улыбнулась`) can land in either form depending on
whether it's part of the same beat or a new one — both forms are
pinned verbatim in the prompt block and in `format.test.js`.

This means user Apply-rules prompts no longer need to re-state the
gesture-as-tag rule; the base prompt covers it.

## v4 — 2026-05-05

**Apply rules tab.** New per-chapter rule-based edit pass alongside
Setup / Glossary / Editor / Stats:

- Type free-form rules (e.g. "normalize ellipses", "use `друг` instead
  of `товарищ` for strangers"). The model returns ONLY the paragraphs
  that need to change, in the same `[N]` numbered protocol the chapter
  translator uses. Identical-roundtrip suggestions are filtered out
  server-side so the diff view only shows real changes.
- Glossary subset for the chapter, translation guidance, and target-
  language dialog conventions are auto-injected into the prompt; the
  user's rules stack on top.
- Diff view: side-by-side rows of current vs suggested, with **→**
  (accept) and **×** (reject) per paragraph. Title slot included as
  the first row when the model proposes a title change.
- Persisted: `chapter.pendingPass = {prompt, ranAt, titleSuggestion,
  suggestions}` rides along with the book in localforage. Pending
  passes survive reload; auto-clear once every diff has been
  accepted or rejected.
- Stale-source warning: if the user has edited a paragraph after the
  pass ran and the suggestion is now identical to what's there, the
  warning strip lists the affected paragraph numbers (decision is
  still the user's — no auto-discard).
- New translator method `PoeTranslator.applyRules` and new typed
  call kind `apply-rules`, surfaced in the Stats view's API-calls
  table.
- Last-used prompt persisted at `config.applyRulesPrompt` so the
  same rule applies one click away on the next chapter / next
  session.

## v3 — 2026-05-05

**Partial-paragraph retranslate.** The four retranslate buttons under
each paragraph (`↻ retranslate`, `↻ stricter`, `↻ more natural`,
`↻ <model2>`) now respect the user's text selection inside the
translation cell:

- If a non-empty range is selected inside the textarea (cell in editor
  mode), the retranslate replaces ONLY that fragment — the rest of the
  paragraph (including any custom edits the user made elsewhere in the
  cell) stays untouched. The full paragraph is sent to the model as
  context so voice/register stays consistent.
- Cursor-only / no selection / select-all / rendered-view click all
  fall through to the existing whole-paragraph behavior. No accidental
  partial mode.
- Implementation: HTML passes `$refs.editor` (the per-row textarea) to
  the click handler; `_selectionFromTextarea` decides between partial
  and full mode; `PoeTranslator._translateParagraphSelection` is the
  new prompt branch that asks the model for just the replacement text;
  the component splices the result back at the original `[start, end)`
  range.

State shape unchanged from v2 — only translator/component behavior and
the new selection-aware prompt branch.

## v2 — 2026-05-05

Consolidated changes since `version: 1` was first set in the export
envelope. From this point on, each commit bumps individually.

**State shape**:
- `dictionary` field renamed to `glossary` everywhere (state, exports,
  view value, config keys). Migration: `migrateLegacyStats` and
  `migrateLegacyConfig` rewrite `dictionary*` keys and the
  `view: 'dictionary'` value on read. Old exports still import.
- `projectName` config field added — sanitized slug prefixes every
  export filename (`my-book-glossary.md`, etc.).
- `stats` object added: `{calls: {kind → {count, totalMs, timedCount}}, byChapter: {idx → {minutes, _lastMinute, firstWorkAt, lastWorkAt}}}`.
  Tracks typed POE call counts with average wall-clock time per kind,
  and per-chapter work-minute history (1-minute bucket dedup, gated
  on editor-view + visibility).
- `model2`, `usePalladius`, `translationGuidance`,
  `translationPromptPreset`, `translationPromptCustom` config fields
  added. (Most landed prior to this consolidation.)
- `book.chapters[].translatedTitle` field added.

**UI / UX**:
- Top-nav `Glossary` link (renamed from `Dictionary`).
- Top-nav `Stats` link with API-call breakdown, per-chapter editing
  table, rolling chars-per-hour rate.
- Header `chars/h` ambient indicator (rolling rate over accepted
  chapters only — in-progress chapter excluded).
- Header `✓ Saved` indicator replaces the manual `Save` button;
  auto-persist already covered every mutation.
- `Reset stats` button in Stats view — wipes counters without
  touching the book / glossary / edits.
- Tiny **editor status bar** fixed at the bottom of the viewport:
  shows current chapter's chars total, a rough "chars left" estimate
  (via window scroll fraction), and a rough "time left until end of
  chapter". Time uses your accepted-chapter rate when stats are
  available, falling back to a 20 000 chars/h default (marked with
  `*`) before any chapter is accepted.
- Per-paragraph retranslate row now has four buttons: default,
  stricter, more natural, and `↻ <model2-name>` (when `config.model2`
  is set).
- Live `N chapter(s) detected` hint under the book textarea on the
  setup view, before parsing.
- Setup view: simple fields visible by default, advanced collapsed
  under `Show advanced options`.
- Project-name field in setup view; passes through query-string
  prefilled URLs.

**Prompts**:
- Russian dialog convention: speech-tag (`сказала она`, comma +
  lowercase) vs standalone action (`Она улыбнулась`, period +
  capitalised) distinction now spelled out in the auto-injected
  dialog block.
- v2 translation prompt preset (two-stage native-writer rewrite)
  is the default; v1 still selectable.

**Stats / instrumentation**:
- API call latency tracked per kind. `_recordApiCall(kind, durationMs)`
  bumps `count` always, `totalMs` + `timedCount` only when a numeric
  duration is supplied. Avg time = `totalMs / timedCount`, so legacy
  untimed calls don't dilute the divisor.
- Display switched from `chars/min` and `Avg latency (ms)` to the
  more legible `chars/h` and `Avg time` (e.g. `5.3 s`).

**Backward compat**:
- Pre-rename URL params (`?dictionaryModel=…`, `?dictionaryGuidance=…`)
  still apply, mapped onto the new `glossary*` keys at parse time.
- Pre-stats and pre-`timedCount` save shapes migrate silently on load.
- The "✓ Saved" / Reset-stats UI tolerates an empty `stats` object so
  old saves don't crash the new view.

## v1 — initial

The original export envelope shape, before any of the changes listed
above. Notable fields:

- `dictionary` (later `glossary`)
- `dictionaryModel`, `dictionaryGuidance`, `dictionaryChunkChars`
  (later `glossary*`)
- `view: 'dictionary'` for what's now `view: 'glossary'`
- No `stats`, no `projectName`, no `translationGuidance`, no `model2`.

The shape is still importable via the v2 migration helpers; the value
of `version: 1` simply tags the artifact as pre-v2.
