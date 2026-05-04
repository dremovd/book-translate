// POE translator via OpenAI-compatible chat/completions endpoint.
// Contract (same as DummyTranslator):
//   buildGlossary(chapters) -> [{term, translation, notes}]
//   translateChapter(chapter, glossary, priorAcceptedChapters) -> paragraphs[] (same length, aligned by index)
//
// Text-shape concerns (paragraph numbering, JSON extraction, rendering) live
// in ./format.js so any future OpenAI-compatible backend can reuse them.

import {
  numberedParagraphs,
  parseNumberedParagraphs,
  alignByIndex,
  parseJsonArray,
  normalizeGlossary,
  chapterOriginalText,
  chapterTranslationText,
  formatGlossary,
  chunkBookText,
  mergeTermsWithSources,
  mergeBilingualPairsWithSources,
  dialogConventionsFor,
} from './format.js';
import { palladiusTransliterate, isMostlyCJK } from '../palladius.js';

// Default chunk size for glossary term extraction, in characters.
// ~400 000 chars ≈ ~100 k tokens at 4 chars/token — sized for modern
// long-context models (Gemini 1-2M, Claude 200k, GPT-4o 128k). Hpmor
// (≈3.76 MB) packs into ~10 chunks at this size.
const DEFAULT_GLOSSARY_CHUNK_CHARS = 400000;
// Cap on parallel extract calls. POE tolerates more; 10 is a good balance
// between throughput and being a decent API citizen on shared accounts.
const GLOSSARY_EXTRACT_CONCURRENCY = 10;

// Style-prompt presets for the translation step. Each `render(lang)` returns
// only the STYLE/INSTRUCTION block — the structural contract (numbered
// paragraphs, glossary) is appended by `_translationSystemPrompt`
// regardless of preset, because it's protocol-level, not taste.
export const TRANSLATION_PRESETS = {
  v1: {
    label: 'v1 — natural & idiomatic',
    render: (lang) =>
      `Translate into publication-ready ${lang} that reads fully natural and idiomatic — avoid "translationese". Preserve the author's voice, personality, and rhythm so the result reads as ${lang} the author might have written. Never skip a paragraph or sentence.`,
  },
  v2: {
    label: 'v2 — two-stage, native-writer rewrite',
    render: (lang) =>
      `Translate into ${lang} at publication-ready literary quality.\n\n` +
      `Work in two stages. First grasp each paragraph — thought, voice, rhythm, subtext. Then close the English and rewrite the thought the way a native ${lang} writer would phrase it, as if ${lang} were the original language.\n\n` +
      `Reject "translationese" at the sentence level. If the English syntax would feel foreign in ${lang}, restructure: reorder, split or merge sentences, switch voice, swap abstract English constructions for the native ${lang} way. Calques are a failure even when grammatical. The result must read as an original ${lang} novel, not a careful translation from a foreign language.\n\n` +
      `Preserve the author's voice, personality, rhythm, tone, subtext. Never skip a paragraph or sentence.`,
  },
};
const DEFAULT_TRANSLATION_PRESET = 'v2';

export class PoeTranslator {
  constructor(config) {
    this.config = config;
    if (!config.apiKey) throw new Error('POE API key is required');
    if (!config.model)  throw new Error('Model (POE bot name) is required');
  }

  // chat() is the single network entry point — every real POE call goes
  // through here. The optional `kind` opt lets callers tag the call so
  // config.onApiCall(kind, durationMs) can categorize it (and time it)
  // for the stats view. The hook fires AFTER a successful response only —
  // failed calls don't count, by design (a 500 isn't editorial work).
  // _chatCached suppresses the hook on cache hits by routing them around
  // chat() entirely.
  async chat(messages, { temperature = 0.2, model, kind = null } = {}) {
    const startedAt = Date.now();
    const r = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: model || this.config.model,
        messages,
        temperature,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`POE API ${r.status}: ${body.slice(0, 400)}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Unexpected API response shape');
    if (kind && typeof this.config.onApiCall === 'function') {
      const durationMs = Date.now() - startedAt;
      try { this.config.onApiCall(kind, durationMs); } catch (_e) { /* best effort */ }
    }
    return content;
  }

  // Same as chat(), but caches the model response in localforage keyed
  // by SHA-256 of (model, messages). Used by the four glossary phases
  // (extract / translate-terms, plus their bilingual variants), where
  // the same chunk + prompt + model deterministically produces the same
  // JSON output. Re-running a glossary build (e.g. after refining
  // guidance for a different chapter, or pasting the same book again)
  // should not re-hit the API for chunks that haven't changed.
  //
  // The cache key includes the full messages payload, so any change to
  // the system prompt (target language, guidance, prompt template) or
  // the user content (chunk text) invalidates the entry automatically.
  // Falls through to plain chat() when localforage / crypto.subtle is
  // unavailable.
  async _chatCached(messages, opts = {}) {
    const model = opts.model || this.config.model;
    const lf = globalThis.localforage;
    const subtle = globalThis.crypto?.subtle;
    if (!lf || !subtle) return this.chat(messages, opts);
    const key = `poe-glossary-cache:v1:${await sha256Hex(JSON.stringify({ model, messages }))}`;
    const cached = await lf.getItem(key);
    if (cached != null) return cached;
    const content = await this.chat(messages, opts);
    await lf.setItem(key, content);
    return content;
  }

  // Glossary phases (extract + translate-terms) can use a separate,
  // optionally cheaper/faster model. Falls back to the main model if
  // `glossaryModel` is unset or blank.
  _glossaryModel() {
    const gloss = (this.config.glossaryModel || '').trim();
    return gloss || this.config.model;
  }

  // Three-phase glossary build, designed to scale past any one model's
  // context window:
  //   1. Chunk the book into text blobs that fit in one prompt.
  //   2. For each chunk, ask the model for a JSON array of terms that need
  //      consistent translation (proper nouns, invented words, etc.).
  //   3. Merge the per-chunk lists, then ask the model once to translate the
  //      deduplicated set into the target language.
  // This also makes the glossary step resumable at the chunk level later
  // if we ever want to add progress/cache.
  async buildGlossary(chapters, { onProgress } = {}) {
    const lang = this.config.targetLanguage || 'the target language';
    const configured = Number(this.config.glossaryChunkChars);
    const maxChars = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_GLOSSARY_CHUNK_CHARS;

    const chunks = chunkBookText(chapters, maxChars);
    const total = chunks.length;
    onProgress?.({ stage: 'extract', current: 0, total });

    // mapBatched awaits each batch of size CONCURRENCY in turn, parallel
    // within a batch. Incrementing `done` after each chunk's extract
    // resolves gives one progress tick per chunk (not per batch), so the
    // bar moves up to CONCURRENCY times per batch-round.
    let done = 0;
    const results = await mapBatched(
      chunks, GLOSSARY_EXTRACT_CONCURRENCY,
      async (chunk) => {
        const r = {
          terms: await this._extractTerms(chunk.text, lang),
          chapterIndices: chunk.chapterIndices,
        };
        done++;
        onProgress?.({ stage: 'extract', current: done, total });
        return r;
      },
    );
    const merged = mergeTermsWithSources(results);
    if (merged.length === 0) return [];

    // Run algorithmic Palladius BEFORE the translate call so its output
    // can be fed to the model as a hint per-term. The LLM is then asked
    // to start from the Palladius transliteration for proper nouns and
    // override only when a canonical published rendering exists. This
    // beats the LLM's habit of inventing fresh transliterations that
    // drift from the standard scheme.
    const palladius = await this._safePalladius(merged.map(m => m.term));

    onProgress?.({ stage: 'translate', current: 0, total: 1 });
    const translated = await this._translateTerms(
      merged.map(m => ({ term: m.term, palladius: palladius.get(m.term) || '' })),
      lang,
    );
    onProgress?.({ stage: 'translate', current: 1, total: 1 });

    // Attach chapter provenance to each translated entry. Entries whose
    // `term` didn't survive normalization fall back to empty chapters[].
    const chaptersByTerm = new Map(merged.map(m => [m.term, m.chapters]));
    return translated.map(e => ({
      ...e,
      chapters: chaptersByTerm.get(e.term) ?? [],
    }));
  }

  // Bilingual glossary build: like buildGlossary but each chapter
  // carries a `referenceText` blob (the same chapter in a second
  // language). Extract phase asks the model for {original, reference}
  // pairs by reading both blobs side-by-side; translate phase produces
  // {term, originalForm, translation, notes}. The result feeds the
  // bilingual translator's prompts (formatGlossary surfaces
  // `originalForm` in the glossary line).
  async buildBilingualGlossary(chapters, { onProgress } = {}) {
    const lang     = this.config.targetLanguage      || 'the target language';
    // editorLang = the language whose paragraphs the user reads/edits.
    // refLang    = the canonical source-of-truth language (chapter blob).
    const editorLang = this.config.editorLanguage   || this.config.originalLanguage || 'the editor language';
    const refLang  = this.config.referenceLanguage   || 'the reference language';

    const work = (chapters || []).filter(ch => ch && ch.paragraphs?.length);
    const total = work.length;
    onProgress?.({ stage: 'extract', current: 0, total });

    let done = 0;
    const chunkResults = await mapBatched(
      work, GLOSSARY_EXTRACT_CONCURRENCY,
      async (ch) => {
        const idx = chapters.indexOf(ch);
        const heading = `# ${ch.title}`;
        const body = ch.paragraphs.map(p => p.original).join('\n\n');
        const originalChunk  = `${heading}\n\n${body}`;
        const referenceChunk = (ch.referenceText || '').trim();
        const pairs = await this._extractBilingualPairs(originalChunk, referenceChunk, editorLang, refLang);
        done++;
        onProgress?.({ stage: 'extract', current: done, total });
        return { pairs, chapterIndices: [idx] };
      },
    );

    const merged = mergeBilingualPairsWithSources(chunkResults);
    if (merged.length === 0) return [];

    // Same Palladius-first pattern as buildGlossary, but applied to
    // the Chinese `reference` side (the bilingual term identity is the
    // pair, but the transliteration always belongs to the CJK form).
    const palladius = await this._safePalladius(merged.map(m => m.reference));

    onProgress?.({ stage: 'translate', current: 0, total: 1 });
    const translated = await this._translateBilingualPairs(
      merged.map(({ original, reference }) => ({
        original, reference,
        palladius: palladius.get(reference) || '',
      })),
      lang, editorLang, refLang,
    );
    onProgress?.({ stage: 'translate', current: 1, total: 1 });

    // Re-attach chapter provenance, keyed on the (term, originalForm)
    // identity since either side alone could collide (e.g. one English
    // form that two distinct Chinese names share, or vice versa).
    const chaptersByPair = new Map(
      merged.map(m => [`${m.original}|${m.reference}`, m.chapters])
    );
    return translated.map(e => ({
      ...e,
      chapters: chaptersByPair.get(`${e.term}|${e.originalForm}`) ?? [],
    }));
  }

  // Best-effort Palladius lookup over a list of source strings. Returns
  // a Map (possibly empty) of input → Cyrillic transliteration. Gated
  // on the `usePalladius` config flag (off by default) — Palladius is
  // a strong opinion about how Chinese names should look in Russian,
  // and not every translation project wants it imposed before the
  // model has even seen the term.
  //
  // Palladius runs offline (pinyin-pro on the page + the syllable table
  // in palladius.js); the try/catch covers the case where pinyin-pro
  // hasn't loaded yet, so the glossary build degrades to no-hint
  // rather than crashing.
  async _safePalladius(sources) {
    if (!this.config.usePalladius) return new Map();
    const cjkOnly = (sources || []).filter(s => s && isMostlyCJK(s));
    if (cjkOnly.length === 0) return new Map();
    try {
      return await palladiusTransliterate(cjkOnly);
    } catch (e) {
      if (typeof console !== 'undefined') {
        console.warn('Palladius lookup failed; LLM will translate without algorithmic hints.', e);
      }
      return new Map();
    }
  }

  async _extractBilingualPairs(originalChunk, referenceChunk, editorLang, refLang) {
    const content = await this._chatCached([
      {
        role: 'system',
        content:
          `You extract terms that need consistent translation across chapters of a novel. ` +
          `The same chapter is provided in TWO languages — ${editorLang} (the user's working text) and ${refLang} (the canonical reference). ` +
          `For each term, provide BOTH forms: the ${editorLang} form (as it appears in the ${editorLang} text) and the ${refLang} form (as it appears in the ${refLang} text). ` +
          `Include:\n` +
          `- Proper nouns (characters, places, organizations).\n` +
          `- Invented words, neologisms, fictional species.\n` +
          `- Recurring technical, academic, or stylistic terms.\n` +
          `- Titles, honorifics, and forms of address.\n` +
          `- Real-world references embedded in the text: titles of books, films, songs, plays, papers, institutions, theories, and names of historical or public figures.\n\n` +
          this._guidanceSection() +
          `Respond with ONLY a JSON array of objects {"original": "...", "reference": "..."} where "original" is the ${editorLang} form and "reference" is the ${refLang} form. No prose, no code fences.`,
      },
      {
        role: 'user',
        content:
          `${editorLang.toUpperCase()} CHUNK:\n\n${originalChunk}\n\n` +
          `---\n\n${refLang.toUpperCase()} REFERENCE (same chapter):\n\n${referenceChunk || '(none provided)'}`,
      },
    ], { model: this._glossaryModel(), kind: 'bilingual-extract' });
    const arr = parseJsonArray(content);
    return arr
      .map(x => ({
        original:  String(x?.original  ?? '').trim(),
        reference: String(x?.reference ?? '').trim(),
      }))
      .filter(p => p.original);
  }

  // Pairs shape: [{ original, reference, palladius? }]. The palladius
  // field is the Cyrillic Palladius transliteration of `reference` (the
  // CJK side) and is shown to the model as a per-pair default for
  // character / place names.
  async _translateBilingualPairs(pairs, lang, editorLang, refLang) {
    const list = pairs || [];
    const hasPalladius = list.some(p => p.palladius);
    const palladiusBlock = hasPalladius
      ? `Some pairs include a "Palladius:" annotation — that is the algorithmic ${lang} Palladius transliteration of the ${refLang} form. Use it as the default translation for character / place names. Override only when a canonical published ${lang} rendering exists (real-world books, films, historical figures, well-known foreign-language proper names). Do not invent a fresh transliteration when a Palladius hint is present.\n\n`
      : '';
    const content = await this._chatCached([
      {
        role: 'system',
        content:
          `You produce a translation glossary into ${lang} for a novel. ` +
          `Each input is a {original, reference} pair — "original" is the ${editorLang} form, "reference" is the canonical ${refLang} form. ` +
          `For each pair, provide a single best translation into ${lang} and optional short notes (gender, transliteration scheme, role). ` +
          `Use the ${refLang} form as the identity anchor for transliteration: prefer the canonical ${lang} rendering of the ${refLang} term over a fresh transliteration of the ${editorLang} form. ` +
          `For real-world references (titles of books / films / songs / papers, institutions, theories, historical or public figures), use the canonical published ${lang} translation when one exists. ` +
          palladiusBlock +
          this._guidanceSection() +
          `Respond with ONLY a JSON array of objects {"term": string, "originalForm": string, "translation": string, "notes": string}, ` +
          `where "term" is the ${editorLang} form (copied from input.original) and "originalForm" is the ${refLang} form (copied from input.reference). No prose, no code fences.`,
      },
      {
        role: 'user',
        content:
          `Pairs:\n\n` +
          list.map(p => p.palladius
            ? `- ${p.original}  ↔  ${p.reference} (Palladius: ${p.palladius})`
            : `- ${p.original}  ↔  ${p.reference}`
          ).join('\n'),
      },
    ], { model: this._glossaryModel(), kind: 'bilingual-translate' });
    const arr = parseJsonArray(content);
    return arr
      .map(e => ({
        term:         String(e?.term         ?? '').trim(),
        originalForm: String(e?.originalForm ?? '').trim(),
        translation:  String(e?.translation  ?? '').trim(),
        notes:        String(e?.notes        ?? '').trim(),
      }))
      .filter(e => e.term && e.translation);
  }

  async _extractTerms(chunkText, lang) {
    const content = await this._chatCached([
      {
        role: 'system',
        content:
          `You extract terms from a book chunk that need consistent translation into ${lang} across chapters. Include:\n` +
          `- Proper nouns (characters, places, organizations).\n` +
          `- Invented words, neologisms, spells, fictional species.\n` +
          `- Recurring technical, academic, or stylistic terms.\n` +
          `- Titles, honorifics, and forms of address.\n` +
          `- Real-world references embedded in the text: titles of books, films, songs, plays, papers, institutions, theories, and names of historical or public figures. These deserve their canonical published translation in ${lang}, not a fresh one.\n\n` +
          this._guidanceSection() +
          `Respond with ONLY a JSON array of strings — the original terms exactly as they appear, no translations, no commentary, no code fences.`,
      },
      { role: 'user', content: chunkText },
    ], { model: this._glossaryModel(), kind: 'glossary-extract' });
    const arr = parseJsonArray(content);
    return arr.map(x => (x == null ? '' : String(x))).filter(Boolean);
  }

  // Items shape: [{ term: string, palladius?: string }]. The palladius
  // field carries the raw Cyrillic transliteration produced by the
  // Palladius post-processor for CJK terms; it shows up in the prompt
  // as a per-term hint the model should adopt for proper nouns unless
  // a canonical published translation exists.
  async _translateTerms(items, lang) {
    const list = (items || []).map(x =>
      typeof x === 'string' ? { term: x, palladius: '' } : x
    );
    const hasPalladius = list.some(x => x.palladius);
    const palladiusBlock = hasPalladius
      ? `Some terms include a "Palladius:" annotation — that is the algorithmic Russian Palladius transliteration of the Chinese form. Use it as the default translation for character / place names. Override only when a canonical published translation exists in ${lang} (e.g. real-world books, films, historical figures, well-known foreign-language proper names). Do not invent a fresh transliteration when a Palladius hint is present.\n\n`
      : '';
    const content = await this._chatCached([
      {
        role: 'system',
        content:
          `You produce a translation glossary for book translation into ${lang}. ` +
          `For each input term, provide a single best translation and optional short notes (gender, transliteration scheme, role). ` +
          `For real-world references (titles of books / films / songs / papers, institutions, theories, historical or public figures), use the canonical published translation into ${lang} when one exists — prefer the standard rendering over a fresh translation, and note it (e.g. "canonical", "standard published title", "Росмэн"). ` +
          palladiusBlock +
          this._guidanceSection() +
          `Respond with ONLY a JSON array of objects {"term": string, "translation": string, "notes": string}. No prose, no code fences.`,
      },
      {
        role: 'user',
        content: `Terms:\n\n${list.map(x =>
          x.palladius ? `- ${x.term} (Palladius: ${x.palladius})` : `- ${x.term}`
        ).join('\n')}`,
      },
    ], { model: this._glossaryModel(), kind: 'glossary-translate' });
    return normalizeGlossary(parseJsonArray(content));
  }

  // Editor-supplied guidance that steers both the extract and translate
  // phases of the glossary build — e.g. canonical translations to enforce,
  // categories to include or skip, case-normalization rules. Returned with
  // surrounding whitespace so it can be inline-concatenated into prompts.
  _guidanceSection() {
    const guidance = (this.config.glossaryGuidance || '').trim();
    if (!guidance) return '';
    return `\n\nEditor guidance:\n${guidance}\n\n`;
  }

  // Per-book translation guidance, appended after whichever style preset
  // is active (v1 / v2 / custom). Used by both translateChapter and
  // translateParagraph so per-paragraph retranslations share the same
  // book-specific voice/register/genre rules.
  _translationGuidanceSection() {
    const guidance = (this.config.translationGuidance || '').trim();
    if (!guidance) return '';
    return `\n\nAdditional guidance for this book:\n${guidance}`;
  }

  // Tell the model how to treat inline Markdown markers (* / ** / _ / __)
  // in the source. Without this, models read the asterisks as incidental
  // punctuation and drop them during cleanup — which also severs the link
  // between "italic in source" and any guidance like "use quotes for
  // character thoughts". Default behavior: preserve the wrapping; if the
  // guidance prescribes a different convention, follow that.
  _inlineMarkersSection() {
    return `\n\nInline markers in the source (*…*, **…**, _…_, __…__) are italic or bold and semantically meaningful — do not drop them. In fiction, italic often marks a character's thought, an imagined or remembered line, or strong emphasis. If the guidance above prescribes a target-language convention (e.g. "use quotation marks for character thoughts"), apply it to these spans; otherwise preserve the wrapping verbatim around the equivalent phrase.`;
  }

  async translateChapter(chapter, glossary, priorAcceptedChapters) {
    const lang = this.config.targetLanguage || 'the target language';
    const priorStr = priorAcceptedChapters
      .map(c => {
        const translatedTitle = c.translatedTitle || c.title;
        return `### ${c.title} — ${translatedTitle}\n\nOriginal:\n${chapterOriginalText(c)}\n\n` +
               `Editor-accepted translation:\n${chapterTranslationText(c)}`;
      })
      .join('\n\n---\n\n');

    const messages = [
      { role: 'system', content: this._translationSystemPrompt(lang, glossary) },
    ];
    if (priorStr) {
      messages.push({
        role: 'user',
        content: `Previously accepted chapters (for style and terminology reference):\n\n${priorStr}`,
      });
    }
    // Bilingual mode: when a reference-language version of the same chapter
    // is supplied, it's the model's source of truth for meaning, names,
    // and idioms — but the output still mirrors the .paragraphs side's
    // numbering, so the editable column lines up with what the user sees.
    const refText = (chapter.referenceText || '').trim();
    if (refText) {
      messages.push({
        role: 'user',
        content:
          `REFERENCE (source of truth for meaning, names, idioms — full chapter, ` +
          `consult while translating but do NOT mirror its phrasing in your output):\n\n${refText}`,
      });
    }
    messages.push({
      role: 'user',
      content:
        `Translate the chapter title ([0]) and ${chapter.paragraphs.length} paragraphs ([1]..[${chapter.paragraphs.length}]). ` +
        `Output format: each item on its own line (or block), prefixed with [N] where N matches the input number.\n\n` +
        `[0] ${chapter.title}\n\n` +
        numberedParagraphs(chapter.paragraphs),
    });

    const content = await this.chat(messages, { kind: 'chapter-translate' });
    const parsed = parseNumberedParagraphs(content);
    return {
      titleTranslation: parsed.get(0) ?? chapter.title,
      paragraphs: alignByIndex(chapter.paragraphs, parsed),
    };
  }

  // Retranslate one paragraph, optionally biased toward "strict" (close to
  // the English original) or "natural" (rewrite freely as idiomatic ${lang}).
  // Called from the per-paragraph retranslate buttons in the editor — lets
  // the editor patch a single bad paragraph without redoing the chapter.
  //   paragraph: { original, translation?, status? }
  //   mode: 'strict' | 'natural'
  //   glossary: subset of entries the caller deems relevant
  //   context: { chapterTitle?, priorParagraphs?: [{original, translation}] }
  // Returns the translated text as a plain string.
  async translateParagraph(paragraph, mode, glossary, context = {}) {
    const lang = this.config.targetLanguage || 'the target language';
    // Three modes: 'strict' (literal-bias), 'natural' (native-target-bias),
    // anything else (default / no bias) — the per-book style preset alone.
    const strict  = mode === 'strict';
    const natural = mode === 'natural';
    const modeInstruction =
        strict  ? `BIAS (strict): faithful to the original — preserve literal meaning, sentence structure, and where possible word order. Stiffer-but-faithful beats freer. Do not invent or omit.`
      : natural ? `BIAS (natural): sound like native ${lang} prose, even at the cost of fidelity to English shape. Restructure freely — reorder, split/merge sentences, switch passive↔active, swap abstract English constructions for the ${lang}-native way. Calques of English are a failure. The paragraph must read as if a ${lang} writer wrote it.`
                : '';
    const hasBias = strict || natural;

    // Default mode always translates fresh from the source — any existing
    // translation is deliberately ignored, so the editor can use `↻
    // retranslate` as a "forget what I have, start over" action. The
    // strict/natural modes DO feed the current translation so the model
    // can refine it toward the bias.
    const currentTranslation = (paragraph.translation || '').trim();
    const revising = hasBias && currentTranslation.length > 0;
    const revisionNote = revising
      ? `\n\nA CURRENT TRANSLATION is provided below — produce a fresh rendering that moves it toward the BIAS. Do not repeat it verbatim.`
      : '';

    const priorStr = (context.priorParagraphs || [])
      .slice(-5)
      .filter(p => p.translation)
      .map(p => `Original: ${p.original}\nTranslation: ${p.translation}`)
      .join('\n\n');

    const dialog = dialogConventionsFor(lang);
    const dialogBlock = dialog
      ? `\n\nDialog formatting (${lang}): ${dialog} For multiple speaker turns in a single source paragraph, separate them with literal newlines in the output.`
      : '';
    const guidanceBlock = this._translationGuidanceSection();
    const markersBlock  = this._inlineMarkersSection();

    const messages = [
      {
        role: 'system',
        content:
          `Translate ONE paragraph into ${lang} at publication-ready literary quality. ${modeInstruction}${revisionNote}${guidanceBlock}${dialogBlock}${markersBlock}\n\n` +
          `Output: just the translated paragraph — do NOT wrap it in an extra pair of quotation marks, but KEEP quotation marks that belong inside the prose (direct speech, inner monologue, quoted words). No numbering, label (e.g. "Translation:"), commentary, or leading/trailing blank lines.\n\n` +
          `Use this glossary for consistency:\n${formatGlossary(glossary)}`,
      },
    ];
    if (context.chapterTitle) {
      messages.push({ role: 'user', content: `Chapter: ${context.chapterTitle}` });
    }
    if (priorStr) {
      messages.push({
        role: 'user',
        content: `Preceding paragraphs in this chapter (for tone and continuity):\n\n${priorStr}`,
      });
    }
    // Bilingual mode: full reference-language chapter as source-of-truth
    // context. Lets the model find the corresponding passage on the
    // reference side and translate from its meaning, while the output
    // still corresponds to the original-side paragraph being retranslated.
    const refText = (context.referenceText || '').trim();
    if (refText) {
      messages.push({
        role: 'user',
        content:
          `REFERENCE (source of truth for meaning, names, idioms — full chapter, ` +
          `find the passage that corresponds to the paragraph below and translate from it):\n\n${refText}`,
      });
    }
    messages.push({
      role: 'user',
      content: `Paragraph to translate:\n\n${paragraph.original}`,
    });
    if (revising) {
      messages.push({
        role: 'user',
        content: `Current translation (revise it per the BIAS — do not output it verbatim):\n\n${currentTranslation}`,
      });
    }

    const content = await this.chat(messages, {
      temperature: strict ? 0.15 : 0.5,
      kind: 'paragraph-translate',
    });
    const unlabeled = content.replace(/^\s*(?:Translation|Перевод)\s*:\s*/i, '').trim();
    // Quote unwrapping: only strip an outer pair when the SOURCE wasn't
    // itself wrapped in matching quotes. If the source was a direct-
    // speech line surrounded by quotes, the matching quotes around the
    // output are carrying the same meaning and must stay.
    return isWrappedInMatchingQuotes(paragraph.original)
      ? unlabeled
      : unwrapOuterQuotes(unlabeled);
  }

  // ---------- chapter / paragraph alignment ----------
  //
  // Two-phase alignment for the A/B comparison view:
  //   1. alignChapters(source, b) — for each B chapter, which SOURCE
  //      chapters does it adapt? Returns 0-based indices.
  //   2. alignParagraphsInChapter(sourceParas, bParas) — within a single
  //      chapter pair, return interval-to-interval matches (a single B
  //      paragraph can adapt several source paragraphs and vice versa).
  //
  // Both run on `glossaryModel` (cheaper than the main translation
  // model) since this is structural matching, not literary judgment.

  async alignChapters(sourceBook, bBook, { onProgress } = {}) {
    onProgress?.({ stage: 'align-chapters', current: 0, total: 1 });

    const summarize = (chapters) =>
      (chapters || []).map((ch, i) => {
        const snippet = (ch?.paragraphs?.[0]?.original || '').replace(/\s+/g, ' ').slice(0, 240);
        return `[${i + 1}] ${ch?.title || ''}\n${snippet}`;
      }).join('\n\n');

    const content = await this.chat([
      {
        role: 'system',
        content:
          `You align chapter sets across two versions of the same book — SOURCE (the original) and B (a translation or adaptation that may reorganize, condense, or skip chapters). For each B chapter, identify which SOURCE chapters it adapts (one or several). If a B chapter has no clear SOURCE counterpart (e.g. a wholly invented introduction), return an empty array.\n\n` +
          `Output ONLY a JSON array of {"b": N, "s": [M, ...]} entries, one per B chapter, in B order. All indices are 1-based as shown below. No prose, no code fences.`,
      },
      {
        role: 'user',
        content: `SOURCE chapters:\n\n${summarize(sourceBook?.chapters)}\n\n---\n\nB chapters:\n\n${summarize(bBook?.chapters)}`,
      },
    ], { model: this._glossaryModel() });

    onProgress?.({ stage: 'align-chapters', current: 1, total: 1 });

    const arr = parseJsonArray(content);
    return arr.map(e => {
      const bIdx = Number(e?.b) - 1;
      const sArr = Array.isArray(e?.s) ? e.s : [];
      return {
        bChapterIdx: bIdx,
        sourceChapterIndices: sArr
          .map(n => Number(n) - 1)
          .filter(n => Number.isInteger(n) && n >= 0),
      };
    }).filter(e => Number.isInteger(e.bChapterIdx) && e.bChapterIdx >= 0);
  }

  async alignParagraphsInChapter(sourceParagraphs, bParagraphs, { onProgress } = {}) {
    onProgress?.({ stage: 'align-paragraphs', current: 0, total: 1 });

    const sText = (sourceParagraphs || []).map((p, i) => `[S${i + 1}] ${p?.text ?? ''}`).join('\n\n');
    const bText = (bParagraphs || []).map((p, i) => `[B${i + 1}] ${p?.text ?? ''}`).join('\n\n');

    const content = await this.chat([
      {
        role: 'system',
        content:
          `You align paragraph intervals within ONE chapter pair across SOURCE and B. The match may not be 1-to-1 — a single B paragraph can adapt several SOURCE paragraphs (the adaptation may condense), and one SOURCE paragraph can be expanded across several B paragraphs. Match interval-to-interval.\n\n` +
          `For each contiguous block of B that adapts a contiguous range of SOURCE, output an entry. If part of B has no SOURCE counterpart (invented or unrelated), omit it.\n\n` +
          `Output ONLY a JSON array of {"bStart": N, "bEnd": N, "sStart": M, "sEnd": M} entries, in order. All indices are 1-based and inclusive. No prose, no code fences.`,
      },
      {
        role: 'user',
        content:
          `SOURCE paragraphs (S1..S${(sourceParagraphs || []).length}):\n\n${sText}\n\n` +
          `---\n\nB paragraphs (B1..B${(bParagraphs || []).length}):\n\n${bText}`,
      },
    ], { model: this._glossaryModel() });

    onProgress?.({ stage: 'align-paragraphs', current: 1, total: 1 });

    const arr = parseJsonArray(content);
    return arr.map(e => ({
      bStart: Number(e?.bStart) - 1,
      bEnd:   Number(e?.bEnd) - 1,
      sStart: Number(e?.sStart) - 1,
      sEnd:   Number(e?.sEnd) - 1,
    })).filter(iv =>
      Number.isInteger(iv.bStart) && Number.isInteger(iv.bEnd) &&
      Number.isInteger(iv.sStart) && Number.isInteger(iv.sEnd) &&
      iv.bStart >= 0 && iv.sStart >= 0 &&
      iv.bEnd >= iv.bStart && iv.sEnd >= iv.sStart
    );
  }

  // Compose the translation system prompt from three blocks:
  //   1. Style — a named preset (v1, v2, …) or the user's custom text with
  //      `${lang}` interpolated. Unknown preset or empty custom falls back
  //      to the default preset.
  //   2. Structural contract — [0]..[N] numbering. Always present; taking
  //      this out would break `alignByIndex`.
  //   3. Glossary — always present (may render as "(empty)").
  _translationSystemPrompt(lang, glossary) {
    const preset = this.config.translationPromptPreset || DEFAULT_TRANSLATION_PRESET;
    let style;
    if (preset === 'custom') {
      const custom = (this.config.translationPromptCustom || '').trim();
      style = custom
        ? custom.replace(/\$\{lang\}/g, lang)
        : TRANSLATION_PRESETS[DEFAULT_TRANSLATION_PRESET].render(lang);
    } else {
      const entry = TRANSLATION_PRESETS[preset] || TRANSLATION_PRESETS[DEFAULT_TRANSLATION_PRESET];
      style = entry.render(lang);
    }
    return style +
      this._translationGuidanceSection() +
      this._dialogSection(lang) +
      this._inlineMarkersSection() +
      `\n\nInput is numbered: [0] is the chapter title, [1]..[N] are body paragraphs in order. Output MUST mirror this numbering with one translation per input item. No merging, splitting, reordering, or commentary.\n\n` +
      `Use this glossary for consistency:\n${formatGlossary(glossary)}`;
  }

  // Inline dialog-formatting block, auto-injected when we have conventions
  // for the target language. The "stay inside the same numbered slot"
  // rider is the load-bearing bit: Russian/Spanish/Polish dialog wants
  // multiple lines per speech, but we still need [N] alignment, so the
  // model must emit `\n` literals rather than splitting paragraphs.
  _dialogSection(lang) {
    const conv = dialogConventionsFor(lang);
    if (!conv) return '';
    return `\n\nDialog formatting (${lang}): ${conv}\n\n` +
      `For multi-line dialog in a single source paragraph, keep all lines inside the same numbered paragraph slot — separate them with literal newlines.`;
  }
}

// Strip an outer pair of quotation marks ONLY when it's unambiguously a
// wrapper — both ends are the same quote char, and no other instance of
// that char appears between them. Preserves all quotes used legitimately
// inside the paragraph (direct speech, inner monologue, quoted terms).
// Handles the common ASCII " and ', plus the French/Russian «…» pair and
// the curly "…" pair that models sometimes emit.
const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['\u201C', '\u201D'], // " "
  ['\u201E', '\u201C'], // „ "  (German-style)
];
function unwrapOuterQuotes(text) {
  if (!text || text.length < 2) return text;
  for (const [open, close] of QUOTE_PAIRS) {
    if (text[0] !== open || text[text.length - 1] !== close) continue;
    const inner = text.slice(1, -1);
    // If the same quote appears inside, the outer ones are probably
    // meaningful (balanced dialog), don't touch.
    if (inner.includes(open) || inner.includes(close)) continue;
    return inner;
  }
  return text;
}

// True if a paragraph is itself wrapped in one of the recognized quote
// pairs — i.e. the paragraph IS a piece of direct speech or a quoted
// sentence. Used to suppress quote-unwrapping on translator output so the
// equivalent outer quotes around the translation survive.
function isWrappedInMatchingQuotes(text) {
  if (!text || text.length < 2) return false;
  for (const [open, close] of QUOTE_PAIRS) {
    if (text[0] === open && text[text.length - 1] === close) return true;
  }
  return false;
}

// SHA-256 hex digest of a string. Used as the glossary-cache key —
// short, stable, collision-resistant. Available in browsers and Node
// 19+ via globalThis.crypto.subtle; the caller checks before invoking.
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Promise.all with a concurrency cap. Preserves input order.
async function mapBatched(items, limit, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const part = await Promise.all(batch.map(fn));
    for (let j = 0; j < part.length; j++) out[i + j] = part[j];
  }
  return out;
}
