// Alpine component for the standalone A/B comparison page (abtest.html).
// Self-contained: loads a single pre-built alignment artifact on init,
// runs a blind 9-pair preference test, reports results.
//
// Kept separate from the editor's bookTranslator component so the editor
// page doesn't carry A/B state. The two share only the pure helpers
// (sampling, swap-correction tally) imported from ./abtest.js.

import {
  ABTESTS, pickRandomSample, assignSwaps, tallyAbResults,
} from './abtest.js';
import { renderBlockMd } from './markdown.js';

const PAIRS_PER_RUN = 9;

export function makeAbtestComponent() {
  return {
    artifact: null,        // parsed JSON from samples/abtest-<id>.json
    pairs: [],             // current sampled+swapped pairs
    choices: [],           // 'a' | 'b' | 'tie' | null per pair
    index: 0,              // index into pairs during running phase
    phase: 'loading',      // 'loading' | 'setup' | 'running' | 'done' | 'error'
    error: null,

    async init() {
      const entry = ABTESTS[0];
      if (!entry) { this.phase = 'error'; this.error = 'No A/B artifact registered.'; return; }
      try {
        const r = await fetch(entry.path);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.artifact = await r.json();
        this.phase = 'setup';
      } catch (e) {
        this.phase = 'error';
        this.error = `Failed to load ${entry.path}: ${e.message}`;
      }
    },

    start() {
      if (!this.artifact?.blocks?.length) return;
      const sample = pickRandomSample(this.artifact.blocks, PAIRS_PER_RUN);
      this.pairs = assignSwaps(sample);
      this.choices = new Array(this.pairs.length).fill(null);
      this.index = 0;
      this.phase = 'running';
      this._scrollToTop();
    },

    record(c) {
      if (this.phase !== 'running') return;
      if (c !== 'a' && c !== 'b' && c !== 'tie') return;
      this.choices[this.index] = c;
      if (this.index + 1 >= this.pairs.length) this.phase = 'done';
      else                                     this.index++;
      this._scrollToTop();
    },

    get results() {
      if (this.phase !== 'done') return { aWins: 0, bWins: 0, ties: 0 };
      return tallyAbResults(this.pairs, this.choices);
    },

    reset() {
      this.pairs = [];
      this.choices = [];
      this.index = 0;
      this.phase = 'setup';
    },

    // Markdown renderer exposed to the template. Block-level so source/
    // A/B segments that span multiple paragraphs render as separate
    // <p>s; inline `*…*` and `**…**` become <em>/<strong>. Output is
    // HTML-escaped before any markdown is applied (see markdown.js).
    renderMd(text) { return renderBlockMd(text); },

    _scrollToTop() {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
  };
}
