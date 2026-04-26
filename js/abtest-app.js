import { makeAbtestComponent } from './abtest-component.js';

document.addEventListener('alpine:init', () => {
  window.Alpine.data('abtest', makeAbtestComponent);
});
