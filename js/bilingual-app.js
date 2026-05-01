import { makeBilingualComponent } from './bilingual-component.js';

document.addEventListener('alpine:init', () => {
  window.Alpine.data('bilingual', makeBilingualComponent);
});
