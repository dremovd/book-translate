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
