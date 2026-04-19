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
npm test
# or: node --test tests/
# single file: node --test tests/component.test.js
# single test: node --test --test-name-pattern='chapter gate' tests/component.test.js
```

Deploy — push to `main` and enable GitHub Pages (Settings → Pages → Deploy from a branch, `main` / root). The `.nojekyll` file at the repo root disables Jekyll processing so paths starting with `_` are served verbatim.

## Stack

Everything loaded from CDN at runtime; there is intentionally no package.json, bundler, or build step:

- **Alpine.js** for reactive UI — one component (`bookTranslator`) holds all state.
- **Pico CSS** for baseline styling; custom rules in `css/styles.css` handle the two-column paragraph editor.
- **localforage** for IndexedDB-backed persistence (handles books larger than the 5 MB `localStorage` cap).

## Translation flow

Deliberately sequential, not batch:

1. **Input**: Markdown pasted into the setup view. Chapters are split on ATX headings at a configurable level (default H1, i.e. `# Title`). Paragraphs are blank-line separated. Content before the first heading is ignored (book-level preface metadata). Non-Markdown manuscripts should be converted with pandoc first (`pandoc input.tex -t 'gfm-raw_html' -o book.md`).
2. **Dictionary pass**: three phases, designed to scale past any single model's context window. (a) Split the book into chunks of `dictionaryChunkChars` characters (default 400 000 ≈ ~100 k tokens at 4 chars/token), cutting at chapter boundaries when possible and paragraph boundaries when a single chapter is too big. (b) For each chunk, ask the model for a JSON array of **terms only** (no translations). (c) Merge and deduplicate the term lists client-side, then ask the model once to translate the merged list into `{term, translation, notes}`. The editor reviews and edits the result. Per-chunk extract calls are fanned out with a concurrency cap (10). Both phases consume `config.dictionaryGuidance` — free-text instructions (canonical translations, case-normalization rules, what to include/skip) injected into the system prompts via `PoeTranslator._guidanceSection()`.
3. **Chapter-by-chapter gate**: chapter 1 is translated → editor edits in the two-column view → click "Accept & translate next" → chapter 2 is translated with the dictionary **plus all previously accepted chapters** as context. Chapter N+1 is not produced until N is marked accepted. Editor edits on accepted chapters are the training signal for downstream chapters.
4. **Editor UI**: CSS grid, two columns. Paragraph N (original, read-only, left) shares a grid row with paragraph N (translation, editable textarea, right). Translation textareas auto-size to content. Dictionary is visible and editable in the sidebar.

## Translator interface

All translators in `js/translators/` implement the same two methods. Swapping backends is a one-line change in `createTranslator`:

```js
buildDictionary(chapters) -> [{ term, translation, notes }]
translateChapter(chapter, dictionary, priorAcceptedChapters) -> {
  titleTranslation,   // translation of chapter.title (falls back to the original title)
  paragraphs,         // same length as chapter.paragraphs, aligned by index
}
  // paragraphs[i] MUST correspond to chapter.paragraphs[i]
  // protocol: title is transmitted as [0], paragraphs as [1]..[N]
```

Implementations:

- `dummy.js` — returns original text as translation; dictionary is a frequency-ranked list of capitalized tokens. Used as the default so dictionary/chapter-gate/editor plumbing can be exercised with no network or API key.
- `poe.js` — calls POE's OpenAI-compatible `/chat/completions` endpoint. Dictionary prompt asks for a JSON array. Translation prompt numbers paragraphs `[1] … [2] …` and requires the same numbering back; `parseNumberedParagraphs` rebuilds the index-aligned array. Missing numbers fall back to the original with `status: 'untranslated'`.
- `index.js` — factory switching on `config.translator`.

## State model

Single Alpine component in `js/app.js`. Shape:

```
{ view: 'setup'|'dictionary'|'editor',
  rawBook, chapterDelimiter,
  book: { chapters: [{ title, status, paragraphs: [{ original, translation, status }] }] },
  dictionary: [{ term, translation, notes }],
  currentChapterIndex,
  config: { translator, apiKey, model, baseUrl, targetLanguage } }
```

Chapter `status` transitions: `pending → translated → accepted`. Paragraph `status`: `pending | translated | untranslated`.

State auto-persists to localforage (key `book-translate-state:v1`) on any mutation, 400 ms debounced, plus on `visibilitychange: hidden`. It is restored on `init()` before the first reactive update fires (gated by `_loaded`).

## Invariants — don't break these

- **Paragraph-index alignment**: paragraph N on the left must always line up with paragraph N on the right. Both the editor CSS (`display: contents` on pairs inside a two-column grid) and the POE translator prompt depend on it. Any change to the translator contract must preserve `output.length === input.length` and index correspondence.
- **Chapter gate**: never auto-translate chapter N+1 before N is accepted. Passing un-edited machine output as "prior accepted" context defeats the point of the gate.
- **Dictionary is an input, not output**: editing the dictionary after chapter K is already accepted does not retroactively re-translate. Dictionary changes only affect not-yet-translated chapters (plus manual "Re-translate this chapter").

## How to work in this repo

- **TDD**. Write the failing test first, then the code to make it pass. New behaviour without a test in `tests/` is not done. When fixing a bug, add a test that reproduces it before changing any production code — the test must fail against `main`, pass against the fix.
- **DRY**. Shared logic lives in one place. Translator implementations both go through the same `{ buildDictionary, translateChapter }` contract — don't duplicate prompt-building or paragraph-alignment code across backends; factor it into a shared helper in `js/translators/` instead. Similarly, test helpers (`withFetch`, `mockResponse`, `clearStore`) live in `tests/_setup.js` — reuse them, don't reinvent them per file.

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
