// Dummy translator: returns original text unchanged.
// Used as the default so the rest of the pipeline (dictionary → chapter gate → editor)
// can be exercised end-to-end without a network or API key.

export class DummyTranslator {
  async buildDictionary(chapters) {
    const counts = new Map();
    for (const ch of chapters) {
      for (const p of ch.paragraphs) {
        const matches = p.original.match(/\b[A-Z][a-zA-Z'\-]{2,}\b/g) || [];
        for (const m of matches) counts.set(m, (counts.get(m) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([term]) => ({ term, translation: term, notes: '' }));
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
}
