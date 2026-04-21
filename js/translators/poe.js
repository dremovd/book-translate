// POE translator via OpenAI-compatible chat/completions endpoint.
// Contract (same as DummyTranslator):
//   buildDictionary(chapters) -> [{term, translation, notes}]
//   translateChapter(chapter, dictionary, priorAcceptedChapters) -> paragraphs[] (same length, aligned by index)
//
// Text-shape concerns (paragraph numbering, JSON extraction, rendering) live
// in ./format.js so any future OpenAI-compatible backend can reuse them.

import {
  numberedParagraphs,
  parseNumberedParagraphs,
  alignByIndex,
  parseJsonArray,
  normalizeDictionary,
  chapterOriginalText,
  chapterTranslationText,
  formatDictionary,
  chunkBookText,
  mergeTermsWithSources,
  dialogConventionsFor,
} from './format.js';

// Default chunk size for dictionary term extraction, in characters.
// ~400 000 chars ≈ ~100 k tokens at 4 chars/token — sized for modern
// long-context models (Gemini 1-2M, Claude 200k, GPT-4o 128k). Hpmor
// (≈3.76 MB) packs into ~10 chunks at this size.
const DEFAULT_DICT_CHUNK_CHARS = 400000;
// Cap on parallel extract calls. POE tolerates more; 10 is a good balance
// between throughput and being a decent API citizen on shared accounts.
const DICT_EXTRACT_CONCURRENCY = 10;

// Style-prompt presets for the translation step. Each `render(lang)` returns
// only the STYLE/INSTRUCTION block — the structural contract (numbered
// paragraphs, dictionary) is appended by `_translationSystemPrompt`
// regardless of preset, because it's protocol-level, not taste.
export const TRANSLATION_PRESETS = {
  v1: {
    label: 'v1 — natural & idiomatic',
    render: (lang) =>
      `Translate the text into high-quality, publication-ready ${lang} that reads fully natural and idiomatic, strictly avoiding any "translationese," while meticulously preserving and adapting the author's unique voice, personality, and rhythm so the result feels exactly like a ${lang} text the author would have written themselves. Never skip English text paragraphs — translate every sentence.`,
  },
  v2: {
    label: 'v2 — two-stage, native-writer rewrite',
    render: (lang) =>
      `Translate into ${lang} at publication-ready literary quality.\n\n` +
      `Work in two stages, always. First, read each paragraph and fully grasp what is being said — the thought, the voice, the rhythm, the subtext. Then set the English aside and rewrite the thought the way a native ${lang} writer would phrase it, as if ${lang} were the original language of the book. Do not reach back to the English sentence; reach for what a ${lang} reader would naturally want to read.\n\n` +
      `Reject "translationese" at the sentence level, not just the word level. If the English syntax would feel foreign in ${lang}, restructure: reorder clauses, split or merge sentences, switch passive to active or vice versa, replace abstract English constructions with the native ${lang} way of saying the same thing. Calques of English idioms are a failure even when grammatical. The result must read as an original ${lang} novel, not as a careful translation from a foreign language.\n\n` +
      `Preserve the author's voice, personality, rhythm, tone, and subtext. Never skip a paragraph or a sentence — translate every one.`,
  },
};
const DEFAULT_TRANSLATION_PRESET = 'v2';

export class PoeTranslator {
  constructor(config) {
    this.config = config;
    if (!config.apiKey) throw new Error('POE API key is required');
    if (!config.model)  throw new Error('Model (POE bot name) is required');
  }

  async chat(messages, { temperature = 0.2, model } = {}) {
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
    return content;
  }

  // Dictionary phases (extract + translate-terms) can use a separate,
  // optionally cheaper/faster model. Falls back to the main model if
  // `dictionaryModel` is unset or blank.
  _dictionaryModel() {
    const dict = (this.config.dictionaryModel || '').trim();
    return dict || this.config.model;
  }

  // Three-phase dictionary build, designed to scale past any one model's
  // context window:
  //   1. Chunk the book into text blobs that fit in one prompt.
  //   2. For each chunk, ask the model for a JSON array of terms that need
  //      consistent translation (proper nouns, invented words, etc.).
  //   3. Merge the per-chunk lists, then ask the model once to translate the
  //      deduplicated set into the target language.
  // This also makes the dictionary step resumable at the chunk level later
  // if we ever want to add progress/cache.
  async buildDictionary(chapters, { onProgress } = {}) {
    const lang = this.config.targetLanguage || 'the target language';
    const configured = Number(this.config.dictionaryChunkChars);
    const maxChars = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_DICT_CHUNK_CHARS;

    const chunks = chunkBookText(chapters, maxChars);
    const total = chunks.length;
    onProgress?.({ stage: 'extract', current: 0, total });

    // mapBatched awaits each batch of size CONCURRENCY in turn, parallel
    // within a batch. Incrementing `done` after each chunk's extract
    // resolves gives one progress tick per chunk (not per batch), so the
    // bar moves up to CONCURRENCY times per batch-round.
    let done = 0;
    const results = await mapBatched(
      chunks, DICT_EXTRACT_CONCURRENCY,
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

    onProgress?.({ stage: 'translate', current: 0, total: 1 });
    const translated = await this._translateTerms(merged.map(m => m.term), lang);
    onProgress?.({ stage: 'translate', current: 1, total: 1 });

    // Attach chapter provenance to each translated entry. Entries whose
    // `term` didn't survive normalization fall back to empty chapters[].
    const chaptersByTerm = new Map(merged.map(m => [m.term, m.chapters]));
    return translated.map(e => ({
      ...e,
      chapters: chaptersByTerm.get(e.term) ?? [],
    }));
  }

  async _extractTerms(chunkText, lang) {
    const content = await this.chat([
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
    ], { model: this._dictionaryModel() });
    const arr = parseJsonArray(content);
    return arr.map(x => (x == null ? '' : String(x))).filter(Boolean);
  }

  async _translateTerms(terms, lang) {
    const content = await this.chat([
      {
        role: 'system',
        content:
          `You produce a translation dictionary for book translation into ${lang}. ` +
          `For each input term, provide a single best translation and optional short notes (gender, transliteration scheme, role). ` +
          `For real-world references (titles of books / films / songs / papers, institutions, theories, historical or public figures), use the canonical published translation into ${lang} when one exists — prefer the standard rendering over a fresh translation, and note it (e.g. "canonical", "standard published title", "Росмэн"). ` +
          this._guidanceSection() +
          `Respond with ONLY a JSON array of objects {"term": string, "translation": string, "notes": string}. No prose, no code fences.`,
      },
      {
        role: 'user',
        content: `Terms:\n\n${terms.map(t => `- ${t}`).join('\n')}`,
      },
    ], { model: this._dictionaryModel() });
    return normalizeDictionary(parseJsonArray(content));
  }

  // Editor-supplied guidance that steers both the extract and translate
  // phases of the dictionary build — e.g. canonical translations to enforce,
  // categories to include or skip, case-normalization rules. Returned with
  // surrounding whitespace so it can be inline-concatenated into prompts.
  _guidanceSection() {
    const guidance = (this.config.dictionaryGuidance || '').trim();
    if (!guidance) return '';
    return `\n\nEditor guidance (follow strictly):\n${guidance}\n\n`;
  }

  async translateChapter(chapter, dictionary, priorAcceptedChapters) {
    const lang = this.config.targetLanguage || 'the target language';
    const priorStr = priorAcceptedChapters
      .map(c => {
        const translatedTitle = c.translatedTitle || c.title;
        return `### ${c.title} — ${translatedTitle}\n\nOriginal:\n${chapterOriginalText(c)}\n\n` +
               `Editor-accepted translation:\n${chapterTranslationText(c)}`;
      })
      .join('\n\n---\n\n');

    const messages = [
      { role: 'system', content: this._translationSystemPrompt(lang, dictionary) },
    ];
    if (priorStr) {
      messages.push({
        role: 'user',
        content: `Previously accepted chapters (for style and terminology reference):\n\n${priorStr}`,
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

    const content = await this.chat(messages);
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
  //   dictionary: subset of entries the caller deems relevant
  //   context: { chapterTitle?, priorParagraphs?: [{original, translation}] }
  // Returns the translated text as a plain string.
  async translateParagraph(paragraph, mode, dictionary, context = {}) {
    const lang = this.config.targetLanguage || 'the target language';
    const strict = mode === 'strict';
    const modeInstruction = strict
      ? `BIAS: stay close to the original. Preserve the literal meaning, sentence structure, and where possible the word order. A slightly stiffer but more faithful rendering is preferred over a freer one. Do not invent or omit.`
      : `BIAS: sound like native ${lang} prose, even at the cost of fidelity to English shape. Restructure freely — reorder clauses, split or merge sentences, switch passive↔active, replace abstract English constructions with the ${lang}-native way of saying the same thing. Calques of English are a failure. The paragraph must feel as if a ${lang} writer wrote it.`;

    const currentTranslation = (paragraph.translation || '').trim();
    const revising = currentTranslation.length > 0;
    const revisionNote = revising
      ? `\n\nThe editor will provide a CURRENT TRANSLATION below. That's what you must improve — move the rendering in the direction of the BIAS above. Do not merely repeat it. If it already satisfies the BIAS, still produce a fresh rewording so the editor has something to compare.`
      : '';

    const priorStr = (context.priorParagraphs || [])
      .slice(-5)
      .filter(p => p.translation)
      .map(p => `Original: ${p.original}\nTranslation: ${p.translation}`)
      .join('\n\n');

    const dialog = dialogConventionsFor(lang);
    const dialogBlock = dialog
      ? `\n\nDialog formatting (${lang}): ${dialog} If the source paragraph contains multiple ` +
        `speaker turns, separate them with literal newlines within this single output paragraph.`
      : '';

    const messages = [
      {
        role: 'system',
        content:
          `Translate ONE paragraph into ${lang} at publication-ready literary quality. ${modeInstruction}${revisionNote}${dialogBlock}\n\n` +
          `Output: ONLY the translated paragraph text. No numbering, no quotes, no commentary, no label, no leading or trailing blank lines.\n\n` +
          `Use this dictionary for consistency:\n${formatDictionary(dictionary)}`,
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

    const content = await this.chat(messages, { temperature: strict ? 0.15 : 0.5 });
    // Strip potential labels the model slips in ("Translation:", wrapping quotes).
    return content
      .replace(/^\s*(?:Translation|Перевод)\s*:\s*/i, '')
      .replace(/^["'«"]|["'»"]$/g, '')
      .trim();
  }

  // Compose the translation system prompt from three blocks:
  //   1. Style — a named preset (v1, v2, …) or the user's custom text with
  //      `${lang}` interpolated. Unknown preset or empty custom falls back
  //      to the default preset.
  //   2. Structural contract — [0]..[N] numbering. Always present; taking
  //      this out would break `alignByIndex`.
  //   3. Dictionary — always present (may render as "(empty)").
  _translationSystemPrompt(lang, dictionary) {
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
      this._dialogSection(lang) +
      `\n\nThe input is numbered: [0] is the chapter title, [1]..[N] are body paragraphs in order. Your output MUST have the same [0]..[N] numbering, one translation per input item. Do not merge, split, reorder, or add commentary.\n\n` +
      `Use this dictionary for consistency:\n${formatDictionary(dictionary)}`;
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
      `When the convention requires multiple lines for a single source paragraph (e.g. several ` +
      `speaker turns), keep all those lines within the same numbered paragraph slot — separate ` +
      `them with literal newline characters. Do NOT split into multiple [N] paragraphs.`;
  }
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
