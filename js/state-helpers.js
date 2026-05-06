// Shared, pure helpers used by both component.js (singular editor) and
// bilingual-component.js. Everything here is module-level — no `this`,
// no closures over per-component state — so importing from one file
// keeps the two editors in lockstep without introducing a mixin or a
// base class. Stateful methods (work tracker, API counter, …) stay
// duplicated by design; see the saved memory note on DRY trade-offs.

// ---------- split clamp ----------
//
// (FONT_SIZES / FONT_SIZE_KEYS / clampFontSize are deliberately NOT
// shared: the singular and bilingual editors ship with slightly
// different smallest/small step values — bumping one to match the
// other would be a silent UX regression, and that wart is older than
// this extract. Each component keeps its own copy.)

// Editor column-split percentage, clamped to [20, 80] so neither column
// can collapse or eat the other. Anything non-numeric goes to 60 (the
// default). Used by both the persisted state load path and the
// drag-resize handler.
export function clampSplit(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 60;
  return Math.max(20, Math.min(80, n));
}

// ---------- "✓ Saved" indicator ----------

// How long the header "✓ Saved" badge stays visible after each
// successful persistNow. ~1.5 s reads as "I saw it confirm" without
// flashing distractingly during heavy editing — the auto-persist
// debounce is 400 ms, so successive saves keep the badge on
// continuously and it disappears 1.5 s after the last write.
export const SAVE_BADGE_MS = 1500;

// ---------- chapter text stats ----------

// Word + non-space character count for one chapter's translated text
// (title + every paragraph translation, joined). Whitespace-separated
// tokens for words; `\s` for the chars filter, so newlines don't count.
// Used by the editor footer (current chapter only) and by the Stats
// view (across accepted chapters).
export function chapterTranslationStats(chapter) {
  if (!chapter) return { words: 0, chars: 0 };
  const parts = [chapter.translatedTitle || ''];
  for (const p of chapter.paragraphs || []) parts.push(p?.translation || '');
  const text = parts.join('\n').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.replace(/\s/g, '').length;
  return { words, chars };
}

// ---------- stats default + migration ----------

// Empty stats object — separate factory so loadSaved/reset/import can
// all share the same default and we don't accidentally leave the
// in-memory `stats` aliasing a fixed module-level constant.
export function defaultStats() {
  return {
    // calls[kind] = { count, totalMs } — typed POE call counter +
    // accumulated network duration per kind. Cache hits don't get
    // counted (the translator only invokes the callback when it
    // actually issued a network request).
    //
    // Known kinds (free strings supplied by the caller):
    //   'chapter-translate', 'paragraph-translate',
    //   'glossary-extract',  'glossary-translate',
    //   'bilingual-extract', 'bilingual-translate' (bilingual editor only)
    calls: {},
    // byChapter[idx] = { editor: <bucket>, rules: <bucket> }
    //
    // Two sub-buckets so translation-throughput math (charsPerHourTotal)
    // doesn't get diluted by Apply-rules polish minutes — those polish
    // existing chars rather than producing new ones, so mixing them
    // would understate the editor's typing rate.
    //
    // Each bucket (see defaultWorkBucket below) has its own minute
    // counter and dedup, so editor and rules work in the same wall-clock
    // minute each get one bump, not just one combined.
    byChapter: {},
  };
}

// One per-chapter, per-view work bucket. Two of these live under each
// `byChapter[idx]` (`.editor` and `.rules`) so the editor and Apply-rules
// tabs accumulate independently.
//
//   minutes:     count of distinct wall-clock minutes the user did
//                work in this chapter from this view.
//   _lastMinute: the minute index (Math.floor(now/60000)) of the
//                most-recently counted bump — used to dedup events
//                fired within the same minute. Independent per
//                sub-bucket so editor + rules can both bump in the
//                same minute.
//   firstWorkAt: ISO timestamp of the first counted minute. Set once,
//                never overwritten.
//   lastWorkAt:  ISO timestamp of the most-recently counted minute.
//                Updated only when `minutes` bumps, NOT on every
//                event — keeps the persistence debounce idle during
//                continuous scroll.
export function defaultWorkBucket() {
  return { minutes: 0, _lastMinute: null, firstWorkAt: null, lastWorkAt: null };
}

// Lift saved stats into the current shape. Migrations stack:
//
//   1. Pre-stats saves had no `stats` field at all → start fresh.
//   2. Pre-duration saves stored `calls[kind]` as a plain integer.
//      Numeric entries become `{count, totalMs: 0, timedCount: 0}`
//      — historical count survives, but those calls don't dilute the
//      average since they were never timed.
//   3. Pre-`timedCount` saves had `{count, totalMs}` only. We
//      recover `timedCount` heuristically: if totalMs > 0, every
//      call must have been timed (= count); if totalMs == 0, none
//      could have been (= 0). That's exactly right for both
//      "all post-fix calls" and "all pre-fix calls", and the worst
//      case is that a mixed bucket gets one round of either-or
//      attribution before fresh calls fix it.
//   4. Pre-rules-bucket saves had `byChapter[idx]` as a flat
//      `{minutes, _lastMinute, firstWorkAt, lastWorkAt}`. Lift those
//      into `{editor: <flat>, rules: defaultWorkBucket()}` — all
//      historical work was editor-tab work (the rules tab didn't
//      exist), so attributing it to `.editor` is exact.
export function migrateLegacyStats(raw) {
  const fresh = defaultStats();
  if (!raw || typeof raw !== 'object') return fresh;
  const calls = {};
  for (const [k, v] of Object.entries(raw.calls || {})) {
    if (v && typeof v === 'object' && typeof v.count === 'number') {
      const count   = v.count;
      const totalMs = typeof v.totalMs === 'number' ? v.totalMs : 0;
      // Prefer an explicit timedCount when present; otherwise infer.
      const timedCount = typeof v.timedCount === 'number'
        ? v.timedCount
        : (totalMs > 0 ? count : 0);
      calls[k] = { count, totalMs, timedCount };
    } else if (typeof v === 'number') {
      calls[k] = { count: v, totalMs: 0, timedCount: 0 };
    }
  }
  const byChapter = {};
  for (const [k, v] of Object.entries(raw.byChapter || {})) {
    if (!v || typeof v !== 'object') continue;
    // Already in nested shape: pass through, filling any missing
    // sub-bucket with an empty default.
    if (v.editor || v.rules) {
      byChapter[k] = {
        editor: v.editor && typeof v.editor === 'object' ? v.editor : defaultWorkBucket(),
        rules:  v.rules  && typeof v.rules  === 'object' ? v.rules  : defaultWorkBucket(),
      };
      continue;
    }
    // Legacy flat shape — lift into the editor sub-bucket. Rules
    // starts empty: the rules tab didn't exist when this was written.
    byChapter[k] = {
      editor: {
        minutes:     typeof v.minutes === 'number' ? v.minutes : 0,
        _lastMinute: typeof v._lastMinute === 'number' ? v._lastMinute : null,
        firstWorkAt: v.firstWorkAt || null,
        lastWorkAt:  v.lastWorkAt  || null,
      },
      rules: defaultWorkBucket(),
    };
  }
  return {
    ...fresh,
    ...raw,
    calls,
    byChapter,
  };
}

// ---------- legacy config-key migration (dictionary → glossary) ----------

// Map of pre-rename config keys to their new names. Used by
// `migrateLegacyConfig` (read-time, on saved/imported config) and by
// each editor's parseQueryOverrides (URL-param-time). Kept here so the
// dictionary→glossary migration has a single source of truth.
export const LEGACY_QUERY_KEY_MAP = Object.freeze({
  dictionaryModel:      'glossaryModel',
  dictionaryGuidance:   'glossaryGuidance',
  dictionaryChunkChars: 'glossaryChunkChars',
});

// Rewrite pre-rename config keys to their new names before the
// saved/imported config is merged with defaultConfig(). Without this
// the merge would silently leave the old key sitting next to the new
// (default-blank) one and the app would read the blank.
export function migrateLegacyConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = { ...raw };
  for (const [oldKey, newKey] of Object.entries(LEGACY_QUERY_KEY_MAP)) {
    if (out[newKey] === undefined && out[oldKey] !== undefined) {
      out[newKey] = out[oldKey];
    }
    delete out[oldKey];
  }
  return out;
}
