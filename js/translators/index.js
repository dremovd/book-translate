import { DummyTranslator } from './dummy.js';
import { PoeTranslator } from './poe.js';

export function createTranslator(config) {
  switch (config.translator) {
    case 'poe':   return new PoeTranslator(config);
    case 'dummy': return new DummyTranslator();
    default:      throw new Error(`Unknown translator: ${config.translator}`);
  }
}
