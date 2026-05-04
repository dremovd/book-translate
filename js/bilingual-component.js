// Alpine component for the bilingual translation page (bilingual.html).
// Two source-language inputs, the user picks which is "original"
// (paragraphs split, editor's read-only column, output paragraph
// numbering anchor) and which is "reference" (full chapter blob, model-
// only context for meaning, names, idioms).
//
// Engine reuse: parseBook, makeStore, createTranslator, format helpers,
// renderBlockMd, plus the pure state/persistence helpers in
// ./state-helpers.js (font sizes, clamps, stats default + migration,
// chapter text counts). The stateful methods that mention `this.stats`
// / `this.config` stay duplicated with component.js by design — see
// memory/feedback_dry_vs_overengineering.

import { parseBook } from './parse.js';
import { makeStore } from './store.js';
import { createTranslator } from './translators/index.js';
import { renderTranslationMarkdown, renderGlossaryMarkdown } from './translators/format.js';
import { renderInlineMd } from './markdown.js';
import {
  clampSplit, SAVE_BADGE_MS, chapterTranslationStats,
  defaultStats, migrateLegacyStats, migrateLegacyConfig, LEGACY_QUERY_KEY_MAP,
} from './state-helpers.js';

// Re-export — `chapterTranslationStats` was a public export of this
// module before the extract; tests + scripts may still import from here.
// (FONT_SIZES is intentionally still defined locally — see state-helpers.js.)
export { chapterTranslationStats };

const STORE_KEY = 'book-translate-bilingual:v1';
const store = makeStore(STORE_KEY);

// Default glossary-guidance preset for Chinese → Russian: spells out
// the Palladius (Палладий) transliteration system for Chinese names so
// the model produces canonical Russian renderings (Жуань Мянь, not
// Ruan Mian). Inserted into config.glossaryGuidance via the
// "Palladius (Chinese → Russian)" button on the setup view.
export const PALLADIUS_PROMPT =
  `For Chinese personal names, places, and organizations, transliterate from the ` +
  `Chinese form (originalForm) into Russian using the Palladius (Палладий) system — ` +
  `the canonical Russian convention for Chinese-to-Cyrillic. Do NOT transliterate ` +
  `the English Pinyin spelling: go from the Chinese characters directly. ` +
  `Examples: 阮眠 → Жуань Мянь, 平江 → Пинцзян, 张伟 → Чжан Вэй, 北京 → Пекин ` +
  `(use the canonical Russian rendering when one exists, e.g. Пекин not Бэйцзин).`;

// Onboarding query-string overrides: same shape as the single-source
// editor (parseQueryOverrides in component.js), with bilingual extras
// `editorLanguage` / `referenceLanguage`.
const QUERY_STRING_CONFIG_KEYS = [
  'translator', 'apiKey', 'model', 'glossaryModel', 'model2', 'baseUrl',
  'targetLanguage', 'editorLanguage', 'referenceLanguage',
  'glossaryGuidance', 'translationGuidance',
  'translationPromptPreset', 'translationPromptCustom',
  'projectName',
];
const QUERY_NUMBER_CONFIG_KEYS = ['glossaryChunkChars'];

// LEGACY_QUERY_KEY_MAP comes from state-helpers — pre-rename URLs with
// `dictionaryModel=…` etc. still apply, mapped onto the new keys.
export function parseQueryOverrides(queryString) {
  const out = { configPatch: {}, stateOverrides: {}, anyApplied: false };
  if (!queryString) return out;
  const params = new URLSearchParams(queryString);
  for (const key of QUERY_STRING_CONFIG_KEYS) {
    if (params.has(key)) { out.configPatch[key] = params.get(key); out.anyApplied = true; }
  }
  for (const key of QUERY_NUMBER_CONFIG_KEYS) {
    if (params.has(key)) {
      const n = Number(params.get(key));
      if (Number.isFinite(n)) { out.configPatch[key] = n; out.anyApplied = true; }
    }
  }
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
  for (const k of ['editorHeadingLevel', 'referenceHeadingLevel']) {
    if (params.has(k)) {
      const n = Number(params.get(k));
      if (Number.isFinite(n)) { out.stateOverrides[k] = n; out.anyApplied = true; }
    }
  }
  return out;
}

// FONT_SIZES is the only knob that diverges from the singular editor:
// the bilingual side starts a bit larger at the smallest/small steps
// for CJK glyph legibility. Kept local rather than shared.
const FONT_SIZES = {
  smallest: '0.85rem',
  small:    '0.95rem',
  medium:   '1rem',
  big:      '1.15rem',
  biggest:  '1.35rem',
};
const FONT_SIZE_KEYS = Object.keys(FONT_SIZES);
const clampFontSize = (v, fallback) =>
  typeof v === 'string' && FONT_SIZE_KEYS.includes(v) ? v : fallback;

function defaultConfig() {
  return {
    translator: 'poe',
    apiKey: '',
    // See component.js: optional project-name prefix for export filenames.
    projectName: '',
    model: 'gemini-3.1-pro',
    glossaryModel: '',
    // Optional second model for chapter-level retranslation. See
    // component.js's `model2` for behavior.
    model2: '',
    baseUrl: 'https://api.poe.com/v1',
    // See component.js: opt-in algorithmic Palladius transliteration
    // hint during glossary build (off by default).
    usePalladius: false,
    targetLanguage: 'Russian',
    editorLanguage:  'English',
    referenceLanguage: 'Chinese',
    glossaryChunkChars: 400000,
    glossaryGuidance: '',
    translationPromptPreset: 'v2',
    translationPromptCustom: '',
    translationGuidance: '',
  };
}

export function makeBilingualComponent() {
  return {
    // ---- state ----
    view: 'setup',                // 'setup' | 'glossary' | 'editor'
    // Two raw markdown inputs, named by their role (not by abstract A/B):
    //   rawEditor    — the side the user reads & edits against; paragraphs
    //                  are split from this and shown in the editor's
    //                  read-only column. Output paragraph numbering
    //                  mirrors this side.
    //   rawReference — the canonical source-of-truth side; passed to the
    //                  model as a full chapter blob on every translate
    //                  call, never shown in the editor.
    rawEditor: '', rawReference: '',
    editorHeadingLevel: 1, referenceHeadingLevel: 1,
    splitPercent: 60,
    originalFontSize: 'medium',
    translationFontSize: 'big',
    showAdvanced: false,          // setup view: collapse advanced fields by default
    book: null,                   // { chapters: [{ title, translatedTitle, status, paragraphs:[{original,translation,status}], referenceText }] }
    glossary: [],                 // [{ term, originalForm, translation, notes, chapters[] }]
    currentChapterIndex: 0,
    config: defaultConfig(),
    busy: false,
    error: null,
    glossaryProgress: null,
    // See component.js: brief "✓ Saved" header badge driven by persistNow.
    saveIndicator: false,
    // See component.js: typed POE call counter + per-chapter work-minute tracker.
    stats: defaultStats(),

    _persistTimer: null,
    _saveBadgeTimer: null,
    _loaded: false,

    async init() {
      await this.loadSaved();
      this._loaded = true;
      this._applyQueryParamOverrides();

      if (typeof this.$watch === 'function') {
        const schedule = () => this.schedulePersist();
        this.$watch('book',                schedule, { deep: true });
        this.$watch('glossary',            schedule, { deep: true });
        this.$watch('config',              schedule, { deep: true });
        this.$watch('stats',               schedule, { deep: true });
        this.$watch('view',                schedule);
        this.$watch('currentChapterIndex', schedule);
        this.$watch('rawEditor',           schedule);
        this.$watch('rawReference',        schedule);
        this.$watch('editorHeadingLevel',     schedule);
        this.$watch('referenceHeadingLevel',  schedule);
        this.$watch('splitPercent',        schedule);
        this.$watch('originalFontSize',    schedule);
        this.$watch('showAdvanced',        schedule);
        this.$watch('translationFontSize', schedule);

        this.$watch('view', v => {
          if (v === 'editor') { this._autosizeAll(); this._scrollToTop(); }
        });
        this.$watch('currentChapterIndex', () => {
          this._autosizeAll();
          this._scrollToTop();
        });
      }

      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') this.persistNow();
        });
      }
      // See component.js: passive scroll listener feeds the work-minute tracker.
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', () => this._recordWork(), { passive: true });
      }
    },

    async loadSaved() {
      try {
        const saved = await store.load();
        if (saved && typeof saved === 'object') {
          // Migrate the pre-rename `view: 'dictionary'` value.
          const rawView = saved.view ?? 'setup';
          this.view                  = rawView === 'dictionary' ? 'glossary' : rawView;
          this.rawEditor             = saved.rawEditor    ?? saved.rawA ?? '';
          this.rawReference          = saved.rawReference ?? saved.rawB ?? '';
          this.editorHeadingLevel    = saved.editorHeadingLevel    ?? saved.headingLevelA ?? 1;
          this.referenceHeadingLevel = saved.referenceHeadingLevel ?? saved.headingLevelB ?? 1;
          this.splitPercent          = clampSplit(saved.splitPercent ?? 60);
          this.originalFontSize    = clampFontSize(saved.originalFontSize,    'medium');
          this.translationFontSize = clampFontSize(saved.translationFontSize, 'big');
          this.showAdvanced        = !!saved.showAdvanced;
          this.book                = saved.book ?? null;
          // Backward-compat: pre-rename saves used `dictionary`.
          this.glossary            = saved.glossary ?? saved.dictionary ?? [];
          this.currentChapterIndex = saved.currentChapterIndex ?? 0;
          this.config              = { ...defaultConfig(), ...migrateLegacyConfig(saved.config) };
          this.stats               = migrateLegacyStats(saved.stats);
        }
      } catch (e) { console.warn('Failed to load bilingual state', e); }
    },

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
          rawEditor: this.rawEditor, rawReference: this.rawReference,
          editorHeadingLevel: this.editorHeadingLevel,
          referenceHeadingLevel: this.referenceHeadingLevel,
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
      } catch (e) { console.warn('persist failed', e); }
    },
    _flashSaved() {
      this.saveIndicator = true;
      clearTimeout(this._saveBadgeTimer);
      this._saveBadgeTimer = setTimeout(() => { this.saveIndicator = false; }, SAVE_BADGE_MS);
    },

    // See component.js for the full rationale on these stats methods.
    _recordApiCall(kind, durationMs) {
      if (!kind) return;
      if (!this.stats) this.stats = defaultStats();
      let bucket = this.stats.calls[kind];
      if (!bucket || typeof bucket !== 'object') {
        bucket = {
          count: typeof bucket === 'number' ? bucket : 0,
          totalMs: 0,
          timedCount: 0,
        };
        this.stats.calls[kind] = bucket;
      }
      bucket.count += 1;
      if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
        bucket.totalMs    += durationMs;
        bucket.timedCount += 1;
      }
    },
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
    _makeTranslator(configPatch = {}) {
      return createTranslator({
        ...this.config,
        ...configPatch,
        onApiCall: (kind, durationMs) => this._recordApiCall(kind, durationMs),
      });
    },
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
    get hasAnyStats() {
      const calls = this.stats?.calls || {};
      const anyCalls = Object.values(calls).some(v =>
        typeof v === 'number' ? v > 0 : (v?.count || 0) > 0
      );
      if (anyCalls) return true;
      const byCh = this.stats?.byChapter || {};
      return Object.values(byCh).some(c => (c?.minutes || 0) > 0);
    },
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
        const count      = typeof raw === 'number' ? raw : (raw?.count      || 0);
        const totalMs    = typeof raw === 'number' ? 0   : (raw?.totalMs    || 0);
        const timedCount = typeof raw === 'number' ? 0   : (raw?.timedCount || 0);
        if (count <= 0) continue;
        const avgMs = timedCount > 0 ? Math.round(totalMs / timedCount) : null;
        out.push({ kind: k, label, count, avgMs });
      }
      return out;
    },
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
    formatWorkTime(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    },

    // ---- exposed constants ----
    FONT_SIZE_KEYS, FONT_SIZES,

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
    get canStartFromRaw() {
      return this.rawEditor.trim().length > 0 && this.rawReference.trim().length > 0;
    },

    // Live chapter counts for the setup view: parse each side with its
    // configured heading level and return the chapter count. Returns 0
    // when the textarea is empty or no headings match. Used for both
    // a status hint and the mismatch warning.
    get editorChapterCount() {
      if (!this.rawEditor.trim()) return 0;
      try { return parseBook(this.rawEditor, { headingLevel: this.editorHeadingLevel }).chapters.length; }
      catch { return 0; }
    },
    get referenceChapterCount() {
      if (!this.rawReference.trim()) return 0;
      try { return parseBook(this.rawReference, { headingLevel: this.referenceHeadingLevel }).chapters.length; }
      catch { return 0; }
    },
    get chapterCountMismatch() {
      const e = this.editorChapterCount;
      const r = this.referenceChapterCount;
      return e > 0 && r > 0 && e !== r;
    },

    // ---- actions ----
    gotoSetup()    { this.view = 'setup'; },
    gotoGlossary() { if (this.glossary.length) this.view = 'glossary'; },
    gotoStats()    { this.view = 'stats'; },
    selectChapter(i) {
      const ch = this.book?.chapters?.[i];
      if (!ch || ch.status === 'pending') return;
      this.currentChapterIndex = i;
    },

    addTerm() {
      this.glossary.push({ term: '', originalForm: '', translation: '', notes: '', chapters: [] });
    },
    removeTerm(i) { this.glossary.splice(i, 1); },

    // Pair the two parsed books by chapter index, building the bilingual
    // book shape: chapters[i].paragraphs come from the editor side,
    // chapters[i].referenceText is the full reference-side chapter blob.
    // Drops trailing chapters that don't pair on both sides.
    _pairBooks(editorBook, referenceBook) {
      const n = Math.min(editorBook.chapters.length, referenceBook.chapters.length);
      const chapters = [];
      for (let i = 0; i < n; i++) {
        const e = editorBook.chapters[i];
        const r = referenceBook.chapters[i];
        const refBody = r.paragraphs.map(p => p.original).join('\n\n');
        chapters.push({
          title: e.title,
          translatedTitle: '',
          status: 'pending',
          paragraphs: e.paragraphs.map(p => ({ ...p })),
          referenceTitle: r.title,
          referenceText: `# ${r.title}\n\n${refBody}`,
        });
      }
      return { chapters };
    },

    async startFromRaw() {
      if (this.busy) return;
      this.error = null;
      const editorBook    = parseBook(this.rawEditor,    { headingLevel: this.editorHeadingLevel });
      const referenceBook = parseBook(this.rawReference, { headingLevel: this.referenceHeadingLevel });
      if (!editorBook.chapters.length || !referenceBook.chapters.length) {
        this.error = 'Both texts must contain at least one chapter heading.';
        return;
      }
      if (editorBook.chapters.length !== referenceBook.chapters.length) {
        this.error = `Chapter count mismatch: editor=${editorBook.chapters.length}, reference=${referenceBook.chapters.length}. Pairing the first ${Math.min(editorBook.chapters.length, referenceBook.chapters.length)} chapters.`;
        // keep going — user warned, partial pairing is still useful
      }
      this.book = this._pairBooks(editorBook, referenceBook);
      this.currentChapterIndex = 0;

      await this._runBusy(async () => {
        const t = this._makeTranslator();
        this.glossaryProgress = null;
        try {
          const gloss = await t.buildBilingualGlossary(this.book.chapters, {
            onProgress: (p) => { this.glossaryProgress = { ...p }; },
          });
          this.glossary = gloss;
          this.view = 'glossary';
        } finally {
          // Always clear the progress hint, even when buildBilingualGlossary
          // throws. Otherwise the UI stays at e.g. "Translating … 0/1"
          // forever after an API/parse failure.
          this.glossaryProgress = null;
        }
      });
    },

    async acceptGlossary() {
      if (!this.book) return;
      await this._runBusy(async () => {
        await this._translateChapter(0);
        this.view = 'editor';
        this.currentChapterIndex = 0;
      });
    },

    async _translateChapter(i) {
      const ch = this.book.chapters[i];
      if (!ch) return;
      const prior = this.book.chapters
        .slice(0, i)
        .filter(c => c.status === 'accepted');
      const t = this._makeTranslator();
      const out = await t.translateChapter(ch, this.glossary, prior);
      ch.translatedTitle = out.titleTranslation;
      ch.paragraphs = out.paragraphs;
      ch.status = 'translated';
    },

    async acceptAndNext() {
      if (!this.book || this.busy) return;
      const ch = this.book.chapters[this.currentChapterIndex];
      if (!ch) return;
      // Rollback guard, mirror of the singular editor: marking the
      // current chapter as accepted is conditional on the next one
      // either already existing or translating successfully. If
      // _translateChapter throws (network blip, model overload, parse
      // failure), restore the prior status so the user isn't stuck
      // with an "accepted" chapter that has no successor.
      const prevStatus = ch.status;
      ch.status = 'accepted';
      const next = this.book.chapters[this.currentChapterIndex + 1];
      if (!next) return; // final chapter — accept stands.
      await this._runBusy(async () => {
        try {
          if (next.status === 'pending') {
            await this._translateChapter(this.currentChapterIndex + 1);
          }
          this.currentChapterIndex++;
        } catch (e) {
          ch.status = prevStatus;
          throw e; // _runBusy surfaces it as this.error
        }
      });
    },

    async retranslateCurrent() {
      if (!this.book || this.busy) return;
      this._recordWork();
      await this._runBusy(async () => {
        const ch = this.book.chapters[this.currentChapterIndex];
        if (!ch) return;
        // Reset to source-only state before retranslating: drop the prior
        // edits so the model translates fresh from source.
        ch.translatedTitle = '';
        ch.paragraphs = ch.paragraphs.map(p => ({
          ...p, translation: '', status: 'pending',
        }));
        ch.status = 'pending';
        await this._translateChapter(this.currentChapterIndex);
      });
    },

    // Per-paragraph retranslate. Sends the full reference chapter as
    // context so the model can find the corresponding passage on the
    // source-of-truth side and translate from its meaning.
    async retranslateParagraph(i, mode, modelOverride = null) {
      if (!this.book || this.busy) return;
      const ch = this.book.chapters[this.currentChapterIndex];
      if (!ch) return;
      const p = ch.paragraphs[i];
      if (!p) return;
      const subset = this._glossarySubsetForChapter(this.currentChapterIndex);
      const priorParagraphs = ch.paragraphs.slice(Math.max(0, i - 5), i);
      this._recordWork();
      await this._runBusy(async () => {
        const t = this._makeTranslator(modelOverride ? { model: modelOverride } : {});
        const out = await t.translateParagraph(p, mode, subset, {
          chapterTitle: ch.title,
          priorParagraphs,
          referenceText: ch.referenceText,
        });
        p.translation = out;
        p.status = 'translated';
      });
    },
    async retranslateParagraphWithModel2(i) {
      const m2 = (this.config.model2 || '').trim();
      if (!m2) return;
      await this.retranslateParagraph(i, 'default', m2);
    },

    _glossarySubsetForChapter(chapterIdx) {
      return this.glossary.filter(t =>
        Array.isArray(t.chapters) && t.chapters.includes(chapterIdx)
      );
    },

    addTermForCurrentChapter() {
      this.glossary.push({
        term: '', originalForm: '', translation: '', notes: '',
        chapters: [this.currentChapterIndex],
      });
    },

    // Mirror of the single-source editor: read overrides from window.location.search
    // on init, apply them, then strip the query so the API key doesn't linger
    // in browser history. Also accepts an explicit string for testability.
    _applyQueryParamOverrides(queryString) {
      const qs = queryString ?? (typeof window !== 'undefined' ? window.location?.search : '');
      const { configPatch, stateOverrides, anyApplied } = parseQueryOverrides(qs || '');
      if (!anyApplied) return false;
      Object.assign(this.config, configPatch);
      Object.assign(this, stateOverrides);
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

    // Load a file into the editor- or reference-side textarea. Driven
    // both by <input type="file"> change events AND by drag-and-drop
    // onto the textarea — the setup view supports either way to skip
    // the copy-paste step for big books.
    async loadFileIntoSide(side, ev) {
      const file =
        ev?.target?.files?.[0] ??              // <input type="file">
        ev?.dataTransfer?.files?.[0];          // drag-and-drop drop event
      if (!file) return;
      // For drop events, suppress the browser's default (which would
      // navigate to the file URL).
      if (typeof ev?.preventDefault === 'function') ev.preventDefault();
      try {
        const text = await file.text();
        if (side === 'editor')         this.rawEditor    = text;
        else if (side === 'reference') this.rawReference = text;
      } catch (e) {
        this.error = `Failed to read file: ${e?.message ?? e}`;
      } finally {
        // Reset only true file <input>s so re-selecting the same file
        // fires `change` again. NEVER touch a textarea: drop events fire
        // with target = the textarea, and clearing its .value would
        // erase what x-model just bound to (the dropped content).
        const tgt = ev?.target;
        if (tgt && tgt.tagName === 'INPUT' && tgt.type === 'file') {
          tgt.value = '';
        }
      }
    },

    // Append the Palladius (Палладий) transliteration prompt to the
    // glossary guidance — the canonical Russian-language convention
    // for rendering Chinese names. Triggered from a button next to the
    // guidance textarea on the setup view.
    insertPalladiusPrompt() {
      const block = PALLADIUS_PROMPT;
      const cur = (this.config.glossaryGuidance || '').trim();
      if (cur.includes('Палладий') || cur.includes('Palladius')) return;
      this.config.glossaryGuidance = cur ? `${cur}\n\n${block}` : block;
    },

    async _runBusy(fn) {
      this.busy = true;
      try { await fn(); }
      catch (e) {
        console.error(e);
        this.error = e?.message ?? String(e);
      }
      finally { this.busy = false; }
    },

    // Targeted reset for the Stats view: zero out per-kind call counts
    // and per-chapter work-minute history. Useful after a code change
    // that left the stats buckets in a weird shape (legacy data with
    // zero totalMs, etc.) so the user can start a clean measurement
    // window without losing the book, glossary, or edits.
    resetStats() {
      if (!this._confirm('Reset call counts and work-minute history? Book, glossary, and edits stay.')) return;
      this.stats = defaultStats();
    },

    reset() {
      if (!this._confirm('Discard everything and return to setup?')) return;
      this.book = null;
      this.glossary = [];
      this.rawEditor = '';
      this.rawReference = '';
      this.currentChapterIndex = 0;
      this.view = 'setup';
      this.error = null;
      this.stats = defaultStats();
    },

    // ---- import / export state ----
    //
    // Mirrors component.js's state envelope but with `type` set to
    // 'bilingual-translate-state' so the two editors can't accidentally
    // import each other's exports (the schemas overlap on book/glossary
    // but diverge on raw inputs and heading levels — silently restoring
    // the wrong shape would leave the receiver in a broken state).
    get canExport() {
      return !!(
        this.book ||
        (this.rawEditor && this.rawEditor.trim()) ||
        (this.rawReference && this.rawReference.trim()) ||
        this.glossary.length
      );
    },
    serializeState() {
      const cfg = { ...this.config, apiKey: '' };
      return {
        type: 'bilingual-translate-state',
        version: 1,
        exportedAt: new Date().toISOString(),
        state: {
          view: this.view,
          rawEditor: this.rawEditor,
          rawReference: this.rawReference,
          editorHeadingLevel: this.editorHeadingLevel,
          referenceHeadingLevel: this.referenceHeadingLevel,
          splitPercent: this.splitPercent,
          originalFontSize: this.originalFontSize,
          translationFontSize: this.translationFontSize,
          book: this.book,
          glossary: this.glossary,
          currentChapterIndex: this.currentChapterIndex,
          config: cfg,
          stats: this.stats,
        },
      };
    },
    exportState() {
      if (!this.canExport) return;
      const envelope = this.serializeState();
      const json = JSON.stringify(envelope, null, 2);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      // Slug source: projectName when set, else first chapter's title,
      // else generic 'translation'.
      const projectSlug = this._projectFilenamePrefix().replace(/-$/, '');
      const fallbackTitle = this.book?.chapters?.[0]?.title || 'translation';
      const fallbackSlug = String(fallbackTitle)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const slug = projectSlug || fallbackSlug || 'translation';
      const filename = `bilingual-translate-${slug}-${stamp}.json`;
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
    async importFromText(json) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed || parsed.type !== 'bilingual-translate-state') {
          throw new Error('Not a bilingual-translate state export (expected type "bilingual-translate-state").');
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
        // Backward-compat for pre-rename exports (dictionary→glossary).
        const importedView = data.view === 'dictionary' ? 'glossary' : (data.view ?? 'setup');
        const importedGlossary =
            Array.isArray(data.glossary)   ? data.glossary
          : Array.isArray(data.dictionary) ? data.dictionary
          : [];
        Object.assign(this, {
          view: importedView,
          rawEditor: data.rawEditor ?? '',
          rawReference: data.rawReference ?? '',
          editorHeadingLevel: data.editorHeadingLevel ?? 1,
          referenceHeadingLevel: data.referenceHeadingLevel ?? 1,
          splitPercent: clampSplit(data.splitPercent ?? 60),
          originalFontSize: clampFontSize(data.originalFontSize, 'medium'),
          translationFontSize: clampFontSize(data.translationFontSize, 'big'),
          book: data.book ?? null,
          glossary: importedGlossary,
          currentChapterIndex: data.currentChapterIndex ?? 0,
          config: { ...defaultConfig(), ...migrateLegacyConfig(data.config), apiKey: localKey },
          stats: data.stats && typeof data.stats === 'object'
            ? { ...defaultStats(), ...data.stats,
                calls: { ...(data.stats.calls || {}) },
                byChapter: { ...(data.stats.byChapter || {}) } }
            : defaultStats(),
          error: null,
        });
        await this.persistNow();
      } catch (e) {
        this.error = `Import failed: ${e.message}`;
      }
    },
    _confirm(msg) {
      if (typeof globalThis.confirm === 'function') return globalThis.confirm(msg);
      return true;
    },

    // ---- markdown rendering for x-html ----
    renderMd(text) { return renderInlineMd(text); },

    // ---- editor view helpers ----
    autosize(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = (el.scrollHeight + 2) + 'px';
    },
    _autosizeAll() {
      if (typeof document === 'undefined') return;
      requestAnimationFrame(() => {
        for (const el of document.querySelectorAll('.translation.editor')) this.autosize(el);
      });
    },
    _scrollToTop() {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    startResize(ev) {
      ev.preventDefault();
      const grid = ev.currentTarget.closest('.paragraphs');
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      const onMove = (e) => {
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        this.splitPercent = clampSplit(pct);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    // ---- export ----
    get canExportSoFar() {
      return !!this.book?.chapters?.length && this.acceptedCount > 0;
    },
    // See component.js#_projectFilenamePrefix.
    _projectFilenamePrefix() {
      const raw = (this.config.projectName || '').trim();
      if (!raw) return '';
      const slug = raw.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      return slug ? `${slug}-` : '';
    },
    exportSoFar() {
      this._downloadMarkdown(
        renderTranslationMarkdown(this.book, this.currentChapterIndex),
        `${this._projectFilenamePrefix()}translation.md`,
      );
    },
    exportGlossary() {
      const md = renderGlossaryMarkdown(this.glossary, {
        editorLanguage:    this.config.editorLanguage,
        referenceLanguage: this.config.referenceLanguage,
        targetLanguage:    this.config.targetLanguage,
      });
      this._downloadMarkdown(md, `${this._projectFilenamePrefix()}glossary.md`);
    },
    _downloadMarkdown(md, filename) {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
