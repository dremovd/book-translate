import { parseBook } from './parse.js';
import { store } from './store.js';
import { createTranslator } from './translators/index.js';
import { renderTranslationMarkdown, renderGlossaryMarkdown } from './translators/format.js';
import { renderInlineMd } from './markdown.js';
import {
  clampSplit, SAVE_BADGE_MS, chapterTranslationStats,
  defaultStats, migrateLegacyStats, migrateLegacyConfig, LEGACY_QUERY_KEY_MAP,
} from './state-helpers.js';

// Re-export — `chapterTranslationStats` was a public API of this module
// before the extract; tests and (potentially) external imports may
// still reach for it here. Re-exporting keeps the extract from being a
// breaking rename. (`FONT_SIZES` is intentionally still defined locally
// — see state-helpers.js for why it's not shared.)
export { chapterTranslationStats };

// Five-step font-size scale exposed to the editor toolbar. Singular and
// bilingual editors ship with slightly different smallest/small steps
// (the bilingual side starts a bit larger for CJK glyph legibility),
// so each component keeps its own copy rather than sharing one constant.
export const FONT_SIZES = {
  smallest: '0.8rem',
  small:    '0.9rem',
  medium:   '1rem',
  big:      '1.15rem',
  biggest:  '1.35rem',
};
const FONT_SIZE_KEYS = Object.keys(FONT_SIZES);
function clampFontSize(v, fallback) {
  return typeof v === 'string' && FONT_SIZE_KEYS.includes(v) ? v : fallback;
}

export const SAMPLE = `# Chapter One

It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.

The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured poster, too large for indoor display, had been tacked to the wall.

# Chapter Two

Winston sat back in his chair. He had managed to drink three glasses of gin, and the music was loud enough that he could almost follow the voice coming from the telescreen.

Outside, even through the shut window-pane, the world looked cold.

# Chapter Three

The dream had been a strange one, and already it was fading as Winston woke. He lay flat on his back, staring up at the ceiling.`;

// Registry of demo books selectable from the setup view. Two kinds:
//   inline `text` (hardcoded, no network) for quick plumbing tests,
//   `path`      (fetched at runtime) for real-book demos.
// Add more by appending to this array.
export const SAMPLE_BOOKS = [
  {
    id: 'tiny',
    label: 'Tiny 3-chapter demo (no network)',
    text: SAMPLE,
  },
  {
    id: 'munchausen',
    label: 'Baron Munchausen — R. E. Raspe (public domain, 35 chapters, Project Gutenberg #3154)',
    path: 'samples/munchausen.md',
  },
];

// Which config fields accept a string from the URL query. These are the
// knobs an onboarding link can pre-fill — the list is intentionally small
// and explicit; unknown params are silently ignored.
const QUERY_STRING_CONFIG_KEYS = [
  'translator', 'apiKey', 'model', 'glossaryModel', 'model2', 'baseUrl',
  'targetLanguage', 'glossaryGuidance', 'translationGuidance',
  'translationPromptPreset', 'translationPromptCustom',
  'projectName',
];
const QUERY_NUMBER_CONFIG_KEYS = ['glossaryChunkChars'];

// Pure: parse a window.location.search-style string into a patch applied
// to state on init. Returns { configPatch, stateOverrides, sampleId, anyApplied }.
// Legacy aliases (`dictionaryModel=…` etc., from before the rename) are
// imported from state-helpers so the singular and bilingual editors stay
// in lockstep on what counts as a legacy key.
export function parseQueryOverrides(queryString) {
  const out = { configPatch: {}, stateOverrides: {}, sampleId: null, anyApplied: false };
  if (!queryString) return out;
  const params = new URLSearchParams(queryString);

  for (const key of QUERY_STRING_CONFIG_KEYS) {
    if (params.has(key)) {
      out.configPatch[key] = params.get(key);
      out.anyApplied = true;
    }
  }
  for (const key of QUERY_NUMBER_CONFIG_KEYS) {
    if (params.has(key)) {
      const n = Number(params.get(key));
      if (Number.isFinite(n)) {
        out.configPatch[key] = n;
        out.anyApplied = true;
      }
    }
  }
  // Legacy aliases — only adopted if the new key wasn't supplied directly.
  for (const [oldKey, newKey] of Object.entries(LEGACY_QUERY_KEY_MAP)) {
    if (!params.has(oldKey) || out.configPatch[newKey] !== undefined) continue;
    const raw = params.get(oldKey);
    if (oldKey === 'dictionaryChunkChars') {
      const n = Number(raw);
      if (Number.isFinite(n)) { out.configPatch[newKey] = n; out.anyApplied = true; }
    } else {
      out.configPatch[newKey] = raw;
      out.anyApplied = true;
    }
  }
  if (params.has('headingLevel')) {
    const n = Number(params.get('headingLevel'));
    if (Number.isFinite(n)) {
      out.stateOverrides.headingLevel = n;
      out.anyApplied = true;
    }
  }
  if (params.has('sample')) {
    out.sampleId = params.get('sample');
    out.anyApplied = true;
  }
  return out;
}

export function defaultConfig() {
  return {
    translator: 'dummy',
    apiKey: '',
    // Optional project name. When set, every export filename gets a
    // sanitized version of it as a prefix — `glossary.md` becomes
    // `my-book-glossary.md`, `translation-through-chapter-001.md`
    // becomes `my-book-translation-through-chapter-001.md`, and the
    // state-export JSON uses it as the slug. Empty/whitespace = no
    // prefix (preserves the pre-existing filenames).
    projectName: '',
    model: 'gemini-3.1-pro',
    // Optional override for the glossary extract + translate-terms calls.
    // Empty → use `model` for everything. A cheaper/faster model here keeps
    // per-book glossary cost down without compromising chapter translation.
    glossaryModel: '',
    // Optional second model for chapter-level retranslation. When set,
    // surfaces an extra "Re-translate via <model2>" button next to the
    // standard one in the editor; the button reuses the default mode
    // and current glossary, only swapping `config.model` for this
    // value. Empty → no extra button shown.
    model2: '',
    baseUrl: 'https://api.poe.com/v1',
    // Inject the algorithmic Palladius (Палладий) Russian
    // transliteration as a per-CJK-term hint into the translate-terms
    // prompt. Off by default — Palladius is the canonical scheme for
    // Russian renderings of Mandarin, but for some books a
    // less-strict / character-fitted transliteration is preferred.
    // Enable in the setup view to opt in for the current book.
    usePalladius: false,
    targetLanguage: 'Russian',
    // Max chars per chunk when extracting terms for the glossary.
    // ~400 000 chars ≈ ~100 k tokens. Smaller chunks → more API calls;
    // larger chunks → fewer but may hit context limits on small-window models.
    glossaryChunkChars: 400000,
    // Free-text instructions that steer both the extract and translate
    // phases of the glossary build — canonical translations to enforce,
    // categories to include/skip, case-normalization rules.
    glossaryGuidance: '',
    // Translation prompt selection:
    //   'v1'     — "natural & idiomatic" (original)
    //   'v2'     — two-stage, native-writer rewrite (current default)
    //   'custom' — free-text, editable in translationPromptCustom below;
    //              `${lang}` is interpolated to the target language.
    // The structural contract ([0]..[N] numbering, glossary) is appended
    // automatically regardless of preset.
    translationPromptPreset: 'v2',
    translationPromptCustom: '',
    // Free-text rules appended after whichever preset is active. Use for
    // book-specific voice, register, or genre conventions. Threads into
    // both chapter translation and per-paragraph retranslation.
    translationGuidance: '',
  };
}

export function makeComponent() {
  return {
    // ---- state ----
    view: 'setup',               // 'setup' | 'glossary' | 'editor'
    rawBook: '',
    headingLevel: 1,             // 1 = split on `#`, 2 = split on `##`, …
    splitPercent: 60,            // editor column split — % of width given to translation, clamped 20..80
    originalFontSize: 'medium',    // key into FONT_SIZES — font of the read-only original column
    translationFontSize: 'big',    // key into FONT_SIZES — font of the editable translation column
    showAdvanced: false,         // setup view: collapse advanced fields by default
                                 // (assumes user arrived with a pre-filled URL)
    book: null,                  // { chapters: [{ title, paragraphs, status }] }
    glossary: [],                // [{ term, translation, notes }]
    currentChapterIndex: 0,
    config: defaultConfig(),
    busy: false,
    error: null,
    // Live progress object during glossary build ({ stage, current, total })
    // or null when idle. Updated from the translator's onProgress callback;
    // cleared in the finally of startFromRaw, reset, and on error.
    glossaryProgress: null,
    // Brief "✓ Saved" badge in the header. Flips to true after each
    // successful persistNow and self-clears after SAVE_BADGE_MS. Replaces
    // the manual Save button — auto-persist already covers every mutation
    // (400ms debounced + on tab hide), so the indicator is purely a
    // confirmation that the latest edit landed in localforage.
    saveIndicator: false,
    // Per-book stats: API call counts (typed) + per-chapter work-minute
    // tracking. Populated by _recordApiCall / _recordWork; surfaced in the
    // dedicated Stats view + a chars/min hint in the nav bar. See
    // defaultStats() above for the shape.
    stats: defaultStats(),

    _persistTimer: null,
    _saveBadgeTimer: null,
    _loaded: false,

    // ---- lifecycle ----
    async init() {
      await this.loadSaved();
      this._loaded = true;
      // After restoring from localforage, apply any onboarding URL params
      // (?model=…&apiKey=…&…). They override saved values for the specific
      // fields provided, leaving the rest intact.
      this._applyQueryParamOverrides();

      // Alpine-only: reactive auto-persist. Skipped when run outside Alpine (tests).
      if (typeof this.$watch === 'function') {
        const schedule = () => this.schedulePersist();
        this.$watch('book',                schedule, { deep: true });
        this.$watch('glossary',            schedule, { deep: true });
        this.$watch('config',              schedule, { deep: true });
        this.$watch('stats',               schedule, { deep: true });
        this.$watch('view',                schedule);
        this.$watch('currentChapterIndex', schedule);
        this.$watch('rawBook',             schedule);
        this.$watch('headingLevel',        schedule);
        this.$watch('splitPercent',        schedule);
        this.$watch('originalFontSize',    schedule);
        this.$watch('translationFontSize', schedule);
        this.$watch('showAdvanced',        schedule);

        // Resize all translation textareas whenever the editor becomes
        // visible or the shown chapter changes — these are the two moments
        // when freshly-rendered textareas might still report scrollHeight 0
        // if we resized at x-init time. Also reset scroll to the top of the
        // page so a new chapter doesn't open mid-paragraph.
        this.$watch('view', v => {
          if (v === 'editor') { this._autosizeAll(); this._scrollToTop(); }
        });
        this.$watch('currentChapterIndex', () => {
          this._autosizeAll();
          this._scrollToTop();
        });
      }

      // Browser-only: save on tab hide.
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') this.persistNow();
        });
      }

      // Stats — passive scroll listener feeds the work-minute tracker.
      // _recordWork itself is the one that gates on view + visibility +
      // current-chapter-exists, so this listener is intentionally dumb:
      // it just hands every scroll over and lets the tracker decide.
      // {passive: true} keeps it off the main-thread scroll critical path.
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', () => this._recordWork(), { passive: true });
      }
    },

    async loadSaved() {
      try {
        const saved = await store.load();
        if (saved && typeof saved === 'object') {
          // Migrate two legacy view values:
          //   'abtest'     — used to live here, now lives in abtest.html.
          //   'dictionary' — pre-rename name for the glossary view.
          const rawView = saved.view ?? 'setup';
          this.view =
              rawView === 'abtest'     ? 'setup'
            : rawView === 'dictionary' ? 'glossary'
            : rawView;
          this.rawBook = saved.rawBook ?? '';
          this.headingLevel = saved.headingLevel ?? 1;
          this.splitPercent = clampSplit(saved.splitPercent ?? 60);
          this.originalFontSize    = clampFontSize(saved.originalFontSize,    'medium');
          this.translationFontSize = clampFontSize(saved.translationFontSize, 'big');
          this.showAdvanced = !!saved.showAdvanced;
          this.book = saved.book ?? null;
          // Backward-compat: pre-rename saves had `dictionary`; new saves
          // use `glossary`. New wins if both present.
          this.glossary = saved.glossary ?? saved.dictionary ?? [];
          this.currentChapterIndex = saved.currentChapterIndex ?? 0;
          this.config = { ...defaultConfig(), ...migrateLegacyConfig(saved.config) };
          // Stats may be missing on saves predating this feature — fall
          // back to a clean object so getters / view code never crash.
          // Also migrates pre-duration legacy `calls[kind] = N` entries
          // into the `{count, totalMs}` shape so totals/averages work.
          this.stats = migrateLegacyStats(saved.stats);
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
    get currentChapterStats() {
      return chapterTranslationStats(this.book?.chapters?.[this.currentChapterIndex]);
    },

    // Live chapter count for the setup view: parse the textarea contents
    // with the current heading level and return how many chapters would be
    // detected. Returns 0 for empty / unparseable input. Used as a small
    // hint under the textarea so users see the parse succeed before they
    // commit to "Parse book & build glossary".
    get previewChapterCount() {
      if (!this.rawBook || !this.rawBook.trim()) return 0;
      try { return parseBook(this.rawBook, { headingLevel: this.headingLevel }).chapters.length; }
      catch { return 0; }
    },

    // chars/hour estimate over ACCEPTED chapters only — the in-progress
    // chapter is half-edited and would skew the rate. Returns null when
    // we don't yet have any accepted chapter with > 0 minutes (so the UI
    // can hide the badge entirely instead of showing "0 chars/h").
    // Hour rather than minute because typical literary throughput puts
    // the per-minute number in the high-hundreds, which is harder to
    // read at a glance than the per-hour figure.
    get charsPerHourTotal() {
      const chapters = this.book?.chapters;
      if (!chapters?.length) return null;
      let totalChars = 0, totalMin = 0;
      chapters.forEach((ch, i) => {
        if (ch?.status !== 'accepted') return;
        const mins = this.stats?.byChapter?.[i]?.minutes || 0;
        if (mins <= 0) return;
        totalMin += mins;
        totalChars += chapterTranslationStats(ch).chars;
      });
      return totalMin > 0 ? Math.round((totalChars / totalMin) * 60) : null;
    },

    // Stats — surface a "do we have anything to show?" flag so the
    // top-nav Stats link only appears once the user has actually run
    // some translation or done some editing. Otherwise it'd just be a
    // dead link on the freshly-loaded setup view.
    get hasAnyStats() {
      const calls = this.stats?.calls || {};
      // Each call entry is `{count, totalMs}` (or a legacy number for
      // saves predating the duration tracker — _migrateLegacyStats lifts
      // those, but this getter stays defensive for safety).
      const anyCalls = Object.values(calls).some(v =>
        typeof v === 'number' ? v > 0 : (v?.count || 0) > 0
      );
      if (anyCalls) return true;
      const byCh = this.stats?.byChapter || {};
      return Object.values(byCh).some(c => (c?.minutes || 0) > 0);
    },

    // Stats view helpers — surface the API-call counters as a stable,
    // ordered list of {kind, label, count, avgMs} (only non-zero rows
    // shown). avgMs is null when totalMs is 0 (e.g. legacy entries
    // migrated from the pre-duration shape) so the view can render "—".
    get apiCallRows() {
      const order = [
        ['chapter-translate',   'Chapter translation'],
        ['paragraph-translate', 'Paragraph retranslation'],
        ['glossary-extract',    'Glossary — extract terms'],
        ['glossary-translate',  'Glossary — translate terms'],
        ['bilingual-extract',   'Bilingual glossary — extract pairs'],
        ['bilingual-translate', 'Bilingual glossary — translate pairs'],
      ];
      const calls = this.stats?.calls || {};
      const out = [];
      for (const [k, label] of order) {
        const raw = calls[k];
        // Tolerate either {count,totalMs} or legacy numeric shape.
        const count   = typeof raw === 'number' ? raw : (raw?.count   || 0);
        const totalMs = typeof raw === 'number' ? 0   : (raw?.totalMs || 0);
        if (count <= 0) continue;
        const avgMs = totalMs > 0 ? Math.round(totalMs / count) : null;
        out.push({ kind: k, label, count, avgMs });
      }
      return out;
    },

    // Stats view — per-chapter table rows. Only chapters with at least
    // one recorded minute of work appear, so historical runs from before
    // the stats feature shipped (or chapters the user never opened) don't
    // pad the table with zero rows. The chars/min rate computation uses
    // the same filter via charsPerMinuteTotal.
    get chapterStatsRows() {
      const chapters = this.book?.chapters || [];
      const out = [];
      chapters.forEach((ch, i) => {
        const entry = this.stats?.byChapter?.[i];
        if (!entry || !entry.minutes) return;
        const stats = chapterTranslationStats(ch);
        out.push({
          index: i,
          title: ch.title,
          status: ch.status,
          chars: stats.chars,
          minutes: entry.minutes,
          charsPerHour: Math.round((stats.chars / entry.minutes) * 60),
          firstWorkAt: entry.firstWorkAt || null,
          lastWorkAt:  entry.lastWorkAt  || null,
        });
      });
      return out;
    },

    // Format an ISO timestamp for the Stats table — short locale form
    // ("5/4/2026, 14:32"). Returns "—" for null so x-text never shows
    // raw "null". Centralized so the template stays declarative.
    formatWorkTime(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
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
          splitPercent: this.splitPercent,
          originalFontSize: this.originalFontSize,
          translationFontSize: this.translationFontSize,
          showAdvanced: this.showAdvanced,
          book: this.book,
          glossary: this.glossary,
          currentChapterIndex: this.currentChapterIndex,
          config: this.config,
          stats: this.stats,
        });
        this._flashSaved();
      } catch (e) {
        console.warn('persist failed', e);
      }
    },

    // Flash the "✓ Saved" header badge. Called only on successful saves so
    // the indicator never lies. Re-firing during heavy editing simply
    // resets the timer — the badge stays visible while writes keep landing,
    // disappears SAVE_BADGE_MS after the last one.
    _flashSaved() {
      this.saveIndicator = true;
      clearTimeout(this._saveBadgeTimer);
      this._saveBadgeTimer = setTimeout(() => { this.saveIndicator = false; }, SAVE_BADGE_MS);
    },

    // Stats — typed POE call counter + per-kind avg latency. Cache hits
    // don't get here (the translator only invokes the callback when it
    // actually issued a network request); see PoeTranslator.chat. Each
    // kind's bucket is `{ count, totalMs }` so the view can render the
    // running average without storing every individual call's duration.
    _recordApiCall(kind, durationMs = 0) {
      if (!kind) return;
      if (!this.stats) this.stats = defaultStats();
      let bucket = this.stats.calls[kind];
      if (!bucket || typeof bucket !== 'object') {
        // Either a brand-new bucket OR a legacy numeric-counter shape from
        // before duration tracking landed. Carry the prior count over so
        // the historical numbers don't disappear; totalMs starts fresh.
        bucket = { count: typeof bucket === 'number' ? bucket : 0, totalMs: 0 };
        this.stats.calls[kind] = bucket;
      }
      bucket.count += 1;
      bucket.totalMs += Number(durationMs) || 0;
    },

    // Single factory for any translator instance the component needs —
    // ensures every code path that goes to the model also feeds the
    // typed-call counter. Accepts an optional config patch (e.g. swapping
    // `model` for the model2 retranslate button).
    _makeTranslator(configPatch = {}) {
      return createTranslator({
        ...this.config,
        ...configPatch,
        onApiCall: (kind, durationMs) => this._recordApiCall(kind, durationMs),
      });
    },

    // Stats — minute-bucketed work tracker. Fired by every event we
    // consider "engagement with the book" (see _installWorkListeners +
    // the @input wiring in the editor view): scroll, textarea edits,
    // retranslate buttons, title edits.
    //
    // Two gates so we don't count phantom work:
    //   - view must be 'editor' (no setup-view scroll, no glossary edits
    //     get attributed to a chapter — the glossary is book-wide).
    //   - document.visibilityState must be 'visible' (a backgrounded tab
    //     can fire scroll events on iOS / momentum-scroll edge cases).
    //
    // Same-minute events are no-ops after the first — they don't even
    // mutate `lastWorkAt`. That keeps the persistence debounce idle
    // during continuous reading-scroll, and keeps lastWorkAt at the
    // start-of-the-counted-minute (good enough at minute resolution).
    _recordWork() {
      if (this.view !== 'editor') return;
      if (typeof document !== 'undefined'
          && document.visibilityState
          && document.visibilityState !== 'visible') return;
      const idx = this.currentChapterIndex;
      if (typeof idx !== 'number' || idx < 0) return;
      if (!this.book?.chapters?.[idx]) return;
      if (!this.stats) this.stats = defaultStats();
      const minute = Math.floor(Date.now() / 60000);
      let entry = this.stats.byChapter[idx];
      if (!entry) {
        entry = { minutes: 0, _lastMinute: null, firstWorkAt: null, lastWorkAt: null };
        this.stats.byChapter[idx] = entry;
      }
      if (entry._lastMinute === minute) return;
      entry._lastMinute = minute;
      entry.minutes += 1;
      const nowIso = new Date(minute * 60000).toISOString();
      entry.lastWorkAt = nowIso;
      if (entry.firstWorkAt == null) entry.firstWorkAt = nowIso;
    },

    // Registry exposed to the setup view so x-for can populate the dropdown.
    SAMPLE_BOOKS,
    // Font-size keys + value map exposed to the editor toolbar (x-for
    // populates the select; :style reads FONT_SIZES by current key).
    FONT_SIZE_KEYS,
    FONT_SIZES,

    // ---- actions ----
    // Load a file into the rawBook textarea. Driven both by
    // <input type="file"> change events AND by drag-and-drop onto the
    // textarea — same handler covers both, since drop events expose
    // the file via dataTransfer.files while change events expose it
    // via target.files.
    async loadFile(ev) {
      const file =
        ev?.target?.files?.[0] ??              // <input type="file">
        ev?.dataTransfer?.files?.[0];          // drag-and-drop drop event
      if (!file) return;
      if (typeof ev?.preventDefault === 'function') ev.preventDefault();
      try {
        this.rawBook = await file.text();
      } catch (e) {
        this.error = `Failed to read file: ${e?.message ?? e}`;
      } finally {
        // Reset only true file <input>s so re-selecting the same file
        // fires `change` again. Never clear a textarea — drop events
        // fire with target = the textarea, and clearing its .value
        // would erase what x-model just bound to.
        const tgt = ev?.target;
        if (tgt && tgt.tagName === 'INPUT' && tgt.type === 'file') {
          tgt.value = '';
        }
      }
    },

    // Load a demo book into the setup textarea. For inline samples, sets
    // rawBook synchronously; for remote ones, fetches the file relative to
    // the site root (samples/<id>.md) and assigns on completion.
    async loadSample(id) {
      if (!id) return;
      const entry = SAMPLE_BOOKS.find(s => s.id === id);
      if (!entry) return;
      this.headingLevel = 1;
      this.error = null;
      if (typeof entry.text === 'string') {
        this.rawBook = entry.text;
        return;
      }
      if (!entry.path) return;
      await this._runBusy(async () => {
        const r = await fetch(entry.path);
        if (!r.ok) throw new Error(`Failed to fetch ${entry.path}: HTTP ${r.status}`);
        this.rawBook = await r.text();
      });
    },

    async startFromRaw() {
      await this._runBusy(async () => {
        const parsed = parseBook(this.rawBook, { headingLevel: this.headingLevel });
        if (!parsed.chapters.length) {
          throw new Error(`No chapters detected. Make sure chapters start with ${'#'.repeat(this.headingLevel)} Title.`);
        }
        this.book = parsed;
        this.currentChapterIndex = 0;
        this.glossaryProgress = { stage: 'extract', current: 0, total: parsed.chapters.length };
        try {
          this.glossary = await this._makeTranslator().buildGlossary(parsed.chapters, {
            onProgress: (p) => { this.glossaryProgress = p; },
          });
        } finally {
          this.glossaryProgress = null;
        }
        this.view = 'glossary';
      });
    },

    async acceptGlossary() {
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

    // Retranslate a single paragraph in the current chapter, biased either
    // toward literal fidelity ('strict') or toward native-target fluency
    // ('natural'). Passes only the glossary entries whose provenance
    // includes the current chapter — keeps the prompt focused.
    async retranslateParagraph(pIdx, mode, modelOverride = null) {
      const chIdx = this.currentChapterIndex;
      const ch = this.book?.chapters?.[chIdx];
      const p = ch?.paragraphs?.[pIdx];
      if (!p) return;
      await this._runBusy(async () => {
        const translator = this._makeTranslator(
          modelOverride ? { model: modelOverride } : {}
        );
        if (typeof translator.translateParagraph !== 'function') {
          throw new Error('This backend does not support per-paragraph retranslation.');
        }
        // Hand-bumped extra signal: a retranslate click is itself work,
        // even before the user touches the result. Avoids the case where
        // someone hits "↻ retranslate" then walks away — without this,
        // that minute would only count if scroll/edit also fired.
        this._recordWork();
        const subset = this._glossarySubsetForChapter(chIdx);
        const priorParagraphs = ch.paragraphs
          .slice(Math.max(0, pIdx - 5), pIdx)
          .map(pp => ({ original: pp.original, translation: pp.translation }));
        const newText = await translator.translateParagraph(p, mode, subset, {
          chapterTitle: ch.title,
          priorParagraphs,
        });
        p.translation = newText;
        p.status = 'translated';
        this._autosizeAll();
      });
    },
    async retranslateParagraphWithModel2(pIdx) {
      const m2 = (this.config.model2 || '').trim();
      if (!m2) return;
      // Default mode + the alt model — see `config.model2` for use case.
      await this.retranslateParagraph(pIdx, 'default', m2);
    },

    // Glossary entries whose provenance includes the given chapter index.
    // Entries without `chapters` (e.g. from a glossary built before the
    // provenance tracking landed, or manually added) are treated as
    // relevant to every chapter.
    _glossarySubsetForChapter(chIdx) {
      if (!Array.isArray(this.glossary)) return [];
      return this.glossary.filter(e =>
        !Array.isArray(e.chapters) || e.chapters.length === 0 || e.chapters.includes(chIdx)
      );
    },

    async retranslateCurrent() {
      const idx = this.currentChapterIndex;
      const ch = this.book?.chapters?.[idx];
      if (!ch) return;
      if (!this._confirm(`Re-translate "${ch.title}"? Current edits in this chapter will be lost.`)) return;
      this._recordWork();
      await this._runBusy(() => this._translateChapterAt(idx));
    },

    // Wraps an async operation that manipulates `book`/`glossary`/`view`:
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
      const { titleTranslation, paragraphs } = await this._makeTranslator()
        .translateChapter(ch, this.glossary, prior);
      ch.paragraphs = paragraphs;
      ch.translatedTitle = titleTranslation;
      ch.status = 'translated';
      // Paragraphs got a fresh translation array — x-for will recreate the
      // textareas, and we want them sized to the new content.
      this._autosizeAll();
    },

    addTerm() { this.glossary.push({ term: '', translation: '', notes: '' }); },
    // Sidebar variant: tag the new entry to the current chapter so it shows
    // up in the chapter-scoped subset (where it was added).
    addTermForCurrentChapter() {
      this.glossary.push({
        term: '', translation: '', notes: '',
        chapters: [this.currentChapterIndex],
      });
    },
    removeTerm(i) { this.glossary.splice(i, 1); },

    selectChapter(i) {
      const ch = this.book?.chapters?.[i];
      if (!ch || ch.status === 'pending') return;
      this.currentChapterIndex = i;
    },

    gotoSetup()    { this.view = 'setup'; },
    gotoGlossary() { if (this.glossary.length) this.view = 'glossary'; },
    gotoStats()    { this.view = 'stats'; },

    get canExport() {
      return !!(this.book || (this.rawBook && this.rawBook.trim()) || this.glossary.length);
    },

    // Build a versioned envelope of the current state for download / sharing.
    // API key is blanked out — the receiver must fill in their own on import.
    // Pure function (doesn't mutate this.config).
    serializeState() {
      const cfg = { ...this.config, apiKey: '' };
      return {
        type: 'book-translate-state',
        version: 1,
        exportedAt: new Date().toISOString(),
        state: {
          view: this.view,
          rawBook: this.rawBook,
          headingLevel: this.headingLevel,
          splitPercent: this.splitPercent,
          book: this.book,
          glossary: this.glossary,
          currentChapterIndex: this.currentChapterIndex,
          config: cfg,
          stats: this.stats,
        },
      };
    },

    // Download the current state as a JSON file the receiver can Import.
    exportState() {
      if (!this.canExport) return;
      const envelope = this.serializeState();
      const json = JSON.stringify(envelope, null, 2);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      // Slug source: projectName when set, otherwise fall back to the
      // first chapter's title (the pre-projectName behavior), then to a
      // generic 'translation' if neither yields anything useful.
      const projectSlug = this._projectFilenamePrefix().replace(/-$/, '');
      const fallbackTitle = this.book?.chapters?.[0]?.title || 'translation';
      const fallbackSlug = String(fallbackTitle)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const slug = projectSlug || fallbackSlug || 'translation';
      const filename = `book-translate-${slug}-${stamp}.json`;
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    // File-input → text → importFromText. Resets the <input> value so the
    // same file can be re-picked.
    async importState(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        await this.importFromText(text);
      } finally {
        if (event?.target) event.target.value = '';
      }
    },

    // Apply a previously exported state envelope. Preserves the receiver's
    // local apiKey so imports don't clobber a key the receiver has already
    // typed in. If the receiver has no key set, config.apiKey stays blank
    // (the export carries it blank) and they must fill it in before using
    // the POE backend.
    async importFromText(json) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed || parsed.type !== 'book-translate-state') {
          throw new Error('Not a book-translate state export (wrong or missing "type" field).');
        }
        const data = parsed.state;
        if (!data || typeof data !== 'object') {
          throw new Error('Export envelope has no "state" payload.');
        }
        if (!this._confirm(
          'Import will replace your current book, glossary, and settings.\n' +
          'Your local API key will be kept. Continue?'
        )) return;
        const localKey = this.config?.apiKey || '';
        // Backward-compat: pre-rename exports carry `dictionary` and the
        // pre-rename `view: 'dictionary'` value. New exports use `glossary`
        // / `view: 'glossary'`. Accept both shapes silently.
        const importedView = data.view === 'dictionary' ? 'glossary' : (data.view ?? 'setup');
        const importedGlossary =
            Array.isArray(data.glossary)   ? data.glossary
          : Array.isArray(data.dictionary) ? data.dictionary
          : [];
        Object.assign(this, {
          view: importedView,
          rawBook: data.rawBook ?? '',
          headingLevel: data.headingLevel ?? 1,
          splitPercent: clampSplit(data.splitPercent ?? 50),
          book: data.book ?? null,
          glossary: importedGlossary,
          currentChapterIndex: data.currentChapterIndex ?? 0,
          config: { ...defaultConfig(), ...migrateLegacyConfig(data.config), apiKey: localKey },
          stats: migrateLegacyStats(data.stats),
          error: null,
        });
        await this.persistNow();
      } catch (e) {
        this.error = `Import failed: ${e.message}`;
      }
    },

    get canExportSoFar() {
      if (!this.book?.chapters?.length) return false;
      const upto = this.currentChapterIndex;
      return this.book.chapters.slice(0, upto + 1).some(c => c.status !== 'pending');
    },

    // Sanitized projectName usable as a filename prefix. Empty when
    // config.projectName is unset, so callers can `${prefix}base.md`
    // and get the pre-projectName filename for free. The slug rules are
    // the same the state-export already uses for the chapter-title
    // fallback: lowercase, non-[a-z0-9] runs collapse to '-', leading
    // and trailing dashes trimmed, capped at 40 chars.
    _projectFilenamePrefix() {
      const raw = (this.config.projectName || '').trim();
      if (!raw) return '';
      const slug = raw.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      return slug ? `${slug}-` : '';
    },

    // Export the translation of every non-pending chapter from index 0
    // through the currently-viewed chapter as a Markdown file the parser
    // can re-ingest. The filename encodes the last included chapter number
    // so successive exports don't stomp each other.
    exportSoFar() {
      if (!this.canExportSoFar) return;
      const md = renderTranslationMarkdown(this.book, this.currentChapterIndex);
      const n = String(this.currentChapterIndex + 1).padStart(3, '0');
      const filename = `${this._projectFilenamePrefix()}translation-through-chapter-${n}.md`;
      this._downloadMarkdown(md, filename);
    },
    exportGlossary() {
      if (!this.glossary?.length) return;
      const md = renderGlossaryMarkdown(this.glossary, {
        targetLanguage: this.config.targetLanguage,
      });
      this._downloadMarkdown(md, `${this._projectFilenamePrefix()}glossary.md`);
    },
    _downloadMarkdown(md, filename) {
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
      if (!this._confirm('Clear all data (book, glossary, translations, settings)?')) return;
      await store.clear();
      Object.assign(this, {
        view: 'setup',
        rawBook: '',
        headingLevel: 1,
        splitPercent: 60,
        originalFontSize: 'medium',
        translationFontSize: 'big',
        book: null,
        glossary: [],
        currentChapterIndex: 0,
        config: defaultConfig(),
        error: null,
        glossaryProgress: null,
        stats: defaultStats(),
      });
    },

    // Indirection around the global `confirm()` so tests can override without
    // needing a jsdom. Tests set `component._confirm = () => false/true`.
    _confirm(msg) {
      return typeof globalThis.confirm === 'function' ? globalThis.confirm(msg) : true;
    },

    // Read overrides from the URL query string, patch config + state,
    // then strip the query from the address bar so the API key doesn't
    // linger in browser history / referrers. Accepts an explicit query
    // string for testability; falls back to window.location.search.
    // Returns `true` iff something was applied.
    _applyQueryParamOverrides(queryString) {
      const qs = queryString ?? (typeof window !== 'undefined' ? window.location?.search : '');
      const { configPatch, stateOverrides, sampleId, anyApplied } = parseQueryOverrides(qs || '');
      if (!anyApplied) return false;

      Object.assign(this.config, configPatch);
      Object.assign(this, stateOverrides);
      if (sampleId) {
        // Fire-and-forget: loadSample is async, init() doesn't wait.
        // `headingLevel` from query wins because Object.assign ran first.
        this.loadSample(sampleId);
      }

      if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
        try {
          const url = new URL(window.location.href);
          url.search = '';
          window.history.replaceState({}, (typeof document !== 'undefined' && document.title) || '', url.toString());
        } catch (_e) { /* best effort */ }
      }
      this.persistNow();
      return true;
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

    // Inline markdown renderer for x-html in paragraph cells. Escapes HTML
    // first, so passing user/model content can't smuggle script tags.
    renderMd(text) { return renderInlineMd(text); },

    // Drag-resize the column split between translation (left) and original
    // (right). Updates `splitPercent` live; CSS reads it as `--split-pct`.
    // Clamped to 20..80 so neither column collapses or eats the other.
    startResize(e) {
      e.preventDefault();
      if (typeof document === 'undefined') return;
      const grid = e.currentTarget?.closest?.('.paragraphs');
      if (!grid) return;
      const onMove = (ev) => {
        const r = grid.getBoundingClientRect();
        if (r.width <= 0) return;
        this.splitPercent = clampSplit(((ev.clientX - r.left) / r.width) * 100);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
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

    // Scroll the page to the top — invoked when the chapter changes or
    // when the editor view is first shown, so a new chapter doesn't open
    // mid-paragraph at the previous chapter's scroll offset.
    _scrollToTop() {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo(0, 0);
      }
    },
  };
}
