# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Book editor interface powered by an LLM translator. Static site (HTML + CSS + JS modules, no build step), deployable to GitHub Pages as-is.

## Run & deploy

Local dev — any static server:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

Tests (Node's built-in runner, no deps):

```
npm test                             # full suite + coverage report (Node 20.19+ via --experimental-test-coverage)
npm run test:fast                    # full suite, no coverage — tighter TDD loop
node --test tests/component.test.js  # single file
node --test --test-name-pattern='chapter gate' tests/component.test.js  # single test
```

Coverage is part of the default `test` script; the report prints after the run. No threshold gate — Node's built-in coverage doesn't support fail-on-threshold yet, so it's informational. Test files appear in the report at ~100% (anything else means there's an uncalled helper to delete).

Deploy — push to `main` and enable GitHub Pages (Settings → Pages → Deploy from a branch, `main` / root). The `.nojekyll` file at the repo root disables Jekyll processing so paths starting with `_` are served verbatim.

## Stack

Everything loaded from CDN at runtime; there is intentionally no package.json, bundler, or build step:

- **Alpine.js** for reactive UI — one component (`bookTranslator`) holds all state.
- **Pico CSS** for baseline styling; custom rules in `css/styles.css` handle the two-column paragraph editor.
- **localforage** for IndexedDB-backed persistence (handles books larger than the 5 MB `localStorage` cap).

## Translation flow

Deliberately sequential, not batch:

1. **Input**: Markdown pasted into the setup view. Chapters are split on ATX headings at a configurable level (default H1, i.e. `# Title`). Paragraphs are blank-line separated. Content before the first heading is ignored (book-level preface metadata). Non-Markdown manuscripts should be converted with pandoc first (`pandoc input.tex -t 'gfm-raw_html' -o book.md`).
2. **Glossary pass**: three phases, designed to scale past any single model's context window. (a) Split the book into chunks of `glossaryChunkChars` characters (default 400 000 ≈ ~100 k tokens at 4 chars/token). Each chunk covers exactly one chapter (split along paragraph boundaries if the chapter is bigger than `maxChars`) — no packing, so every extracted term's chapter origin is unambiguous. (b) For each chunk, ask the model for a JSON array of **terms only** (no translations). The extract prompt explicitly asks for real-world references (titles of books / films / songs / papers, institutions, theories, historical figures) alongside proper nouns and invented words. (c) Merge and deduplicate client-side via `mergeTermsWithSources`, keeping each term's set of source chapter indices. Then ask the model once to translate the merged list into `{term, translation, notes}` — the translate prompt tells it to use the canonical published translation for real-world references. The final glossary entries get `chapters: number[]` attached from the merge step. Per-chunk extract calls are fanned out with a concurrency cap (10). Both phases consume `config.glossaryGuidance` via `PoeTranslator._guidanceSection()`. (Pre-rename: this used to be called the "dictionary"; loadSaved/importFromText still accept the legacy field names — see `_migrateLegacyConfig` in `component.js`.)
3. **Chapter-by-chapter gate**: chapter 1 is translated → editor edits in the two-column view → click "Accept & translate next" → chapter 2 is translated with the glossary **plus all previously accepted chapters** as context. Chapter N+1 is not produced until N is marked accepted. Editor edits on accepted chapters are the training signal for downstream chapters.
4. **Editor UI**: CSS grid, two columns. Paragraph N (original, read-only, left) shares a grid row with paragraph N (translation, editable textarea, right). Translation textareas auto-size to content. Two per-paragraph retranslate buttons (`↻ stricter` / `↻ more natural`) sit under each textarea, calling `translator.translateParagraph` with the **chapter-filtered** glossary subset (from `_glossarySubsetForChapter`) — so an editor can patch a single bad paragraph without regenerating the chapter. Glossary is visible and editable in the sidebar.

## Translator interface

All translators in `js/translators/` implement the same two methods. Swapping backends is a one-line change in `createTranslator`:

```js
buildGlossary(chapters) -> [{ term, translation, notes, chapters: number[] }]
  // `chapters` = sorted chapter indices the term's source chunk(s) covered.
  // Since chunks are one-chapter-per-chunk (see chunkBookText), this is
  // exact provenance: the term was extracted from a chunk whose source was
  // chapter N. The component uses it to filter the glossary per-chapter
  // for single-paragraph retranslation calls.

translateChapter(chapter, glossary, priorAcceptedChapters) -> {
  titleTranslation,   // translation of chapter.title (falls back to the original title)
  paragraphs,         // same length as chapter.paragraphs, aligned by index
}
  // paragraphs[i] MUST correspond to chapter.paragraphs[i]
  // protocol: title is transmitted as [0], paragraphs as [1]..[N]

translateParagraph(paragraph, mode, glossarySubset, context) -> string
  // mode: 'strict' (stay close to English) | 'natural' (rewrite as native-target)
  // Caller passes only the glossary entries relevant to the paragraph's chapter.
  // Return value is the translated paragraph text — no numbering, no wrapping.
  // Called from the per-paragraph retranslate buttons in the editor, so an
  // editor can patch one bad paragraph without redoing the whole chapter.
```

Implementations:

- `dummy.js` — returns original text as translation; glossary is a frequency-ranked list of capitalized tokens. Used as the default so glossary/chapter-gate/editor plumbing can be exercised with no network or API key.
- `poe.js` — calls POE's OpenAI-compatible `/chat/completions` endpoint. Glossary prompt asks for a JSON array. Translation prompt numbers paragraphs `[1] … [2] …` and requires the same numbering back; `parseNumberedParagraphs` rebuilds the index-aligned array. Missing numbers fall back to the original with `status: 'untranslated'`.
- `index.js` — factory switching on `config.translator`.

## State model

Single Alpine component in `js/app.js`. Shape:

```
{ view: 'setup'|'glossary'|'editor',
  rawBook, headingLevel,
  book: { chapters: [{ title, translatedTitle, status, paragraphs: [{ original, translation, status }] }] },
  glossary: [{ term, translation, notes, chapters: number[] }],
  currentChapterIndex,
  config: {
    translator, apiKey, baseUrl, targetLanguage,
    model,                  // chapter + per-paragraph translation
    glossaryModel,          // optional override for glossary phases; empty = reuse `model`
    glossaryChunkChars, glossaryGuidance,
    translationPromptPreset, translationPromptCustom,
  } }
```

Backward compat — pre-rename saves and JSON exports used `dictionary`, `view: 'dictionary'`, `dictionaryModel`, `dictionaryGuidance`, `dictionaryChunkChars`. `loadSaved`/`importFromText` accept those silently and migrate to the new names; `parseQueryOverrides` accepts the legacy URL params too. New writes always use the new names.

Chapter `status` transitions: `pending → translated → accepted`. Paragraph `status`: `pending | translated | untranslated`.

State auto-persists to localforage (key `book-translate-state:v1`) on any mutation, 400 ms debounced, plus on `visibilitychange: hidden`. It is restored on `init()` before the first reactive update fires (gated by `_loaded`).

## Invariants — don't break these

- **Paragraph-index alignment**: paragraph N on the left must always line up with paragraph N on the right. Both the editor CSS (`display: contents` on pairs inside a two-column grid) and the POE translator prompt depend on it. Any change to the translator contract must preserve `output.length === input.length` and index correspondence.
- **Chapter gate**: never auto-translate chapter N+1 before N is accepted. Passing un-edited machine output as "prior accepted" context defeats the point of the gate.
- **Glossary is an input, not output**: editing the glossary after chapter K is already accepted does not retroactively re-translate. Glossary changes only affect not-yet-translated chapters (plus manual "Re-translate this chapter").

## How to work in this repo

- **TDD**. Write the failing test first, then the code to make it pass. New behaviour without a test in `tests/` is not done. When fixing a bug, add a test that reproduces it before changing any production code — the test must fail against `main`, pass against the fix.
- **DRY**. Shared logic lives in one place. Translator implementations both go through the same `{ buildGlossary, translateChapter }` contract — don't duplicate prompt-building or paragraph-alignment code across backends; factor it into a shared helper in `js/translators/` instead. Similarly, test helpers (`withFetch`, `mockResponse`, `clearStore`) live in `tests/_setup.js` — reuse them, don't reinvent them per file.

## Testing

- `tests/` uses `node:test` + `node:assert/strict`. No test framework, no build step, no dependencies beyond Node itself.
- `tests/_setup.js` installs a `globalThis.localforage` in-memory stub (store.js reads `globalThis`, not `window`, so browser and Node both work), plus helpers `withFetch(impl)` and `mockResponse({ ok, status, body })` for stubbing the POE client.
- `js/component.js` holds the full state machine and is imported by tests directly. `js/app.js` is just the three-line Alpine registration — it exists so tests never have to run a browser. The component tolerates Alpine features being absent: `init()` only registers `$watch`ers if `typeof this.$watch === 'function'`, and destructive confirmations go through `this._confirm(msg)` so tests can override.
- Coverage focus, in order of importance:
  - **Chapter gate invariant** (`component.test.js` "does NOT re-translate an already-translated next chapter") — if this breaks, editors lose work.
  - **Paragraph index alignment** (`poe.test.js` "preserves index alignment", "missing paragraphs fall back…") — if this breaks, the two-column editor is misaligned and edits land on the wrong paragraph.
  - **Persistence round-trip** (`component.test.js` "persist/load round-trip…", "persist is suppressed until loadSaved completes") — if either breaks, state is lost or clobbered on reload.
- When adding a new translator backend: add a file under `js/translators/`, wire it into `createTranslator`, and copy the PoeTranslator test pattern (mock `fetch`, assert prompt shape, assert paragraph-count preservation).

## Known constraints

- POE API is called directly from the browser. If CORS blocks the request, run a thin proxy (Cloudflare Worker / similar) and point `config.baseUrl` at it.
- The API key is stored in the browser (localforage). Fine for a personal tool on a user's own machine; not suitable for a shared deployment.
