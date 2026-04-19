import { makeComponent } from './component.js';

document.addEventListener('alpine:init', () => {
  window.Alpine.data('bookTranslator', makeComponent);
});
