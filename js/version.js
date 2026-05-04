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
//   v2 — current shape: glossary terminology, projectName field,
//        per-book stats with typed call counts and per-chapter
//        work-minute tracking, ✓ Saved indicator (replaces Save
//        button), chars/h header rate, Avg time column with
//        untimed-call exclusion, Reset stats action, Russian
//        speech-tag vs action dialog rule.
export const APP_VERSION = 2;
