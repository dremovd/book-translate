import { parseBook } from './parse.js';
import { store } from './store.js';
import { createTranslator } from './translators/index.js';
import { renderTranslationMarkdown } from './translators/format.js';

export const SAMPLE = `# Chapter One

It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.

The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured poster, too large for indoor display, had been tacked to the wall.

# Chapter Two

Winston sat back in his chair. He had managed to drink three glasses of gin, and the music was loud enough that he could almost follow the voice coming from the telescreen.

Outside, even through the shut window-pane, the world looked cold.

# Chapter Three

The dream had been a strange one, and already it was fading as Winston woke. He lay flat on his back, staring up at the ceiling.`;

export function defaultConfig() {
  return {
    translator: 'dummy',
    apiKey: '',
    model: 'gemini-3.1-pro',
    baseUrl: 'https://api.poe.com/v1',
    targetLanguage: 'Russian',
    // Max chars per chunk when extracting terms for the dictionary.
    // ~400 000 chars ≈ ~100 k tokens. Smaller chunks → more API calls;
    // larger chunks → fewer but may hit context limits on small-window models.
    dictionaryChunkChars: 400000,
    // Free-text instructions that steer both the extract and translate
    // phases of the dictionary build — canonical translations to enforce,
    // categories to include/skip, case-normalization rules.
    dictionaryGuidance: '',
    // Translation prompt selection:
    //   'v1'     — "natural & idiomatic" (original)
    //   'v2'     — two-stage, native-writer rewrite (current default)
    //   'custom' — free-text, editable in translationPromptCustom below;
    //              `${lang}` is interpolated to the target language.
    // The structural contract ([0]..[N] numbering, dictionary) is appended
    // automatically regardless of preset.
    translationPromptPreset: 'v2',
    translationPromptCustom: '',
  };
}

export function makeComponent() {
  return {
    // ---- state ----
    view: 'setup',               // 'setup' | 'dictionary' | 'editor'
    rawBook: '',
    headingLevel: 1,             // 1 = split on `#`, 2 = split on `##`, …
    book: null,                  // { chapters: [{ title, paragraphs, status }] }
    dictionary: [],              // [{ term, translation, notes }]
    currentChapterIndex: 0,
    config: defaultConfig(),
    busy: false,
    error: null,

    _persistTimer: null,
    _loaded: false,

    // ---- lifecycle ----
    async init() {
      await this.loadSaved();
      this._loaded = true;

      // Alpine-only: reactive auto-persist. Skipped when run outside Alpine (tests).
      if (typeof this.$watch === 'function') {
        const schedule = () => this.schedulePersist();
        this.$watch('book',                schedule, { deep: true });
        this.$watch('dictionary',          schedule, { deep: true });
        this.$watch('config',              schedule, { deep: true });
        this.$watch('view',                schedule);
        this.$watch('currentChapterIndex', schedule);
        this.$watch('rawBook',             schedule);
        this.$watch('headingLevel',        schedule);

        // Resize all translation textareas whenever the editor becomes
        // visible or the shown chapter changes — these are the two moments
        // when freshly-rendered textareas might still report scrollHeight 0
        // if we resized at x-init time.
        this.$watch('view', v => { if (v === 'editor') this._autosizeAll(); });
        this.$watch('currentChapterIndex', () => this._autosizeAll());
      }

      // Browser-only: save on tab hide.
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') this.persistNow();
        });
      }
    },

    async loadSaved() {
      try {
        const saved = await store.load();
        if (saved && typeof saved === 'object') {
          this.view = saved.view ?? 'setup';
          this.rawBook = saved.rawBook ?? '';
          this.headingLevel = saved.headingLevel ?? 1;
          this.book = saved.book ?? null;
          this.dictionary = saved.dictionary ?? [];
          this.currentChapterIndex = saved.currentChapterIndex ?? 0;
          this.config = { ...defaultConfig(), ...(saved.config ?? {}) };
        }
      } catch (e) {
        console.warn('Failed to load state', e);
      }
    },

    // ---- derived ----
    get acceptedCount() {
      return this.book?.chapters?.filter(c => c.status === 'accepted').length ?? 0;
    },
    get anyTranslated() {
      return !!this.book?.chapters?.some(c => c.status !== 'pending');
    },
    get nextButtonLabel() {
      if (this.busy) return 'Translating next…';
      const chapters = this.book?.chapters ?? [];
      const idx = this.currentChapterIndex;
      if (idx >= chapters.length - 1) return 'Accept (final chapter)';
      const next = chapters[idx + 1];
      if (next?.status && next.status !== 'pending') return 'Accept & go to next chapter';
      return 'Accept & translate next chapter';
    },

    // ---- persistence ----
    schedulePersist() {
      if (!this._loaded) return;
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this.persistNow(), 400);
    },
    async persistNow() {
      clearTimeout(this._persistTimer);
      try {
        await store.save({
          view: this.view,
          rawBook: this.rawBook,
          headingLevel: this.headingLevel,
          book: this.book,
          dictionary: this.dictionary,
          currentChapterIndex: this.currentChapterIndex,
          config: this.config,
        });
      } catch (e) {
        console.warn('persist failed', e);
      }
    },

    // ---- actions ----
    loadSample() {
      this.rawBook = SAMPLE;
      this.headingLevel = 1;
    },

    async startFromRaw() {
      await this._runBusy(async () => {
        const parsed = parseBook(this.rawBook, { headingLevel: this.headingLevel });
        if (!parsed.chapters.length) {
          throw new Error(`No chapters detected. Make sure chapters start with ${'#'.repeat(this.headingLevel)} Title.`);
        }
        this.book = parsed;
        this.currentChapterIndex = 0;
        this.dictionary = await createTranslator(this.config).buildDictionary(parsed.chapters);
        this.view = 'dictionary';
      });
    },

    async acceptDictionary() {
      await this._runBusy(async () => {
        await this._translateChapterAt(0);
        this.currentChapterIndex = 0;
        this.view = 'editor';
      });
    },

    async acceptAndNext() {
      this.error = null;
      const chapters = this.book.chapters;
      const curIdx = this.currentChapterIndex;
      const prevStatus = chapters[curIdx].status;
      chapters[curIdx].status = 'accepted';
      const nextIdx = curIdx + 1;
      if (nextIdx >= chapters.length) {
        await this.persistNow();
        return;
      }
      // If the next chapter already has a translation (translated or accepted),
      // don't regenerate — that would clobber the editor's work. Just advance.
      // Use "Re-translate this chapter" on the next screen to pull in updated context.
      if (chapters[nextIdx].status !== 'pending') {
        this.currentChapterIndex = nextIdx;
        return;
      }
      this.busy = true;
      try {
        await this._translateChapterAt(nextIdx);
        this.currentChapterIndex = nextIdx;
      } catch (e) {
        chapters[curIdx].status = prevStatus;
        this.error = e.message || String(e);
      } finally {
        this.busy = false;
      }
    },

    async retranslateCurrent() {
      const idx = this.currentChapterIndex;
      const ch = this.book?.chapters?.[idx];
      if (!ch) return;
      if (!this._confirm(`Re-translate "${ch.title}"? Current edits in this chapter will be lost.`)) return;
      await this._runBusy(() => this._translateChapterAt(idx));
    },

    // Wraps an async operation that manipulates `book`/`dictionary`/`view`:
    //   clears .error, sets .busy = true, captures any thrown error into
    //   .error, restores .busy. Use this for methods whose failure mode is
    //   "show the message and let the user retry" — i.e. no rollback needed.
    async _runBusy(fn) {
      this.error = null;
      this.busy = true;
      try {
        return await fn();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.busy = false;
      }
    },

    // Translates chapters[idx] in place, using all previously accepted
    // chapters as context. Throws on translator failure so callers can roll
    // back state if they need to.
    async _translateChapterAt(idx) {
      const ch = this.book.chapters[idx];
      const prior = this.book.chapters.slice(0, idx).filter(c => c.status === 'accepted');
      const { titleTranslation, paragraphs } = await createTranslator(this.config)
        .translateChapter(ch, this.dictionary, prior);
      ch.paragraphs = paragraphs;
      ch.translatedTitle = titleTranslation;
      ch.status = 'translated';
      // Paragraphs got a fresh translation array — x-for will recreate the
      // textareas, and we want them sized to the new content.
      this._autosizeAll();
    },

    addTerm() { this.dictionary.push({ term: '', translation: '', notes: '' }); },
    removeTerm(i) { this.dictionary.splice(i, 1); },

    selectChapter(i) {
      const ch = this.book?.chapters?.[i];
      if (!ch || ch.status === 'pending') return;
      this.currentChapterIndex = i;
    },

    gotoSetup()      { this.view = 'setup'; },
    gotoDictionary() { if (this.dictionary.length) this.view = 'dictionary'; },

    get canExportSoFar() {
      if (!this.book?.chapters?.length) return false;
      const upto = this.currentChapterIndex;
      return this.book.chapters.slice(0, upto + 1).some(c => c.status !== 'pending');
    },

    // Export the translation of every non-pending chapter from index 0
    // through the currently-viewed chapter as a Markdown file the parser
    // can re-ingest. The filename encodes the last included chapter number
    // so successive exports don't stomp each other.
    exportSoFar() {
      if (!this.canExportSoFar) return;
      const md = renderTranslationMarkdown(this.book, this.currentChapterIndex);
      const n = String(this.currentChapterIndex + 1).padStart(3, '0');
      const filename = `translation-through-chapter-${n}.md`;
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    async reset() {
      if (!this._confirm('Clear all data (book, dictionary, translations, settings)?')) return;
      await store.clear();
      Object.assign(this, {
        view: 'setup',
        rawBook: '',
        headingLevel: 1,
        book: null,
        dictionary: [],
        currentChapterIndex: 0,
        config: defaultConfig(),
        error: null,
      });
    },

    // Indirection around the global `confirm()` so tests can override without
    // needing a jsdom. Tests set `component._confirm = () => false/true`.
    _confirm(msg) {
      return typeof globalThis.confirm === 'function' ? globalThis.confirm(msg) : true;
    },

    // Sizes a textarea to its current content. In modern browsers CSS
    // `field-sizing: content` handles this natively; we skip then so the
    // inline style doesn't shadow the CSS property. Everywhere else, set
    // height explicitly. Called from @input on each textarea and from
    // _autosizeAll() below on view/chapter transitions.
    autosize(el) {
      if (!el) return;
      if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content')) return;
      el.style.height = 'auto';
      el.style.height = (el.scrollHeight + 2) + 'px';
    },

    // Resize every translation textarea in the editor. Must be called after
    // the editor view is visible (scrollHeight is 0 while display: none).
    // Double rAF: one to let the browser paint after the view flips, one to
    // let the textarea settle its metrics.
    _autosizeAll() {
      if (typeof document === 'undefined') return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const el of document.querySelectorAll('textarea.translation')) {
          this.autosize(el);
        }
      }));
    },
  };
}
