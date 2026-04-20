// Dummy translator: returns original text unchanged.
// Used as the default so the rest of the pipeline (dictionary → chapter gate → editor)
// can be exercised end-to-end without a network or API key.

export class DummyTranslator {
  async buildDictionary(chapters) {
    // For each capitalized token track which chapter indices it appeared in,
    // so the dictionary has the same `chapters: number[]` shape the POE
    // backend produces — keeps the downstream "subset for this chapter"
    // filter consistent across backends.
    const perTerm = new Map();
    chapters.forEach((ch, chIdx) => {
      for (const p of ch.paragraphs) {
        const matches = p.original.match(/\b[A-Z][a-zA-Z'\-]{2,}\b/g) || [];
        for (const m of matches) {
          let e = perTerm.get(m);
          if (!e) { e = { count: 0, chapters: new Set() }; perTerm.set(m, e); }
          e.count++;
          e.chapters.add(chIdx);
        }
      }
    });
    return [...perTerm.entries()]
      .filter(([, e]) => e.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([term, e]) => ({
        term,
        translation: term,
        notes: '',
        chapters: [...e.chapters].sort((a, b) => a - b),
      }));
  }

  async translateChapter(chapter /*, dictionary, priorAcceptedChapters */) {
    return {
      titleTranslation: chapter.title,
      paragraphs: chapter.paragraphs.map(p => ({
        original: p.original,
        translation: p.original,
        status: 'translated',
      })),
    };
  }

  async translateParagraph(paragraph /*, mode, dictionary, context */) {
    return paragraph.original;
  }
}
