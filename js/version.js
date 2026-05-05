// Tool version stamped onto every export envelope.
//
// Bump this whenever the running tool's user-visible behavior, prompts,
// state shape, or default configuration changes — i.e. when an export
// produced by this version of the tool would behave differently from
// the previous version's. Every bump MUST add an entry to CHANGELOG.md
// at the repo root explaining what changed.
//
// This is the *tool* version, not a per-translation revision: every
// export carries it so a recipient can answer "which version of the
// tool produced this artifact?". Importers don't gate on it (we
// migrate older shapes silently via the helpers in state-helpers.js),
// but the field is preserved for forensic and reproducibility use.
//
// History (full detail in CHANGELOG.md):
//   v1 — initial shape, before glossary/stats/projectName landed.
//   v2 — glossary rename, projectName field, stats (typed call
//        counts + per-chapter work minutes), ✓ Saved indicator,
//        chars/h header rate, Avg time column with untimed-call
//        exclusion, Reset stats, Russian speech-tag vs action rule,
//        editor status bar with chars-left / time-left estimates.
//   v3 — partial-paragraph retranslate: selecting text inside a
//        translation cell scopes the retranslate buttons to that
//        fragment only; rest of the paragraph stays intact.
//   v4 — Apply rules tab: per-chapter rule-based edit pass with a
//        persisted pending-suggestions diff and per-paragraph
//        accept/reject buttons.
//   v5 — Russian dialog block extended: gesture/emotion/thought
//        descriptors that frame the same speaker beat take the same
//        comma + lowercase as speech-reporting verbs (e.g.
//        «— Не переживай, — она улыбнулась.»). Period + capital is
//        now reserved for genuinely independent actions after the
//        speech ends.
//   v6 — Apply-rules tab gets the editor-grid layout: chapter
//        sidebar on the left for navigation, full chapter (title +
//        every paragraph) always visible on the right, diff
//        highlighting + accept/reject buttons inline only on rows
//        with a pending suggestion. Sidebar shows a marker on
//        chapters that have pending suggestions.
//   v7 — Apply-rules row label trimmed: title row shows `T`,
//        paragraph rows show the bare 1-based index. Column
//        narrowed and right-aligned so the row label is a hint,
//        not a column eating real estate.
export const APP_VERSION = 7;
