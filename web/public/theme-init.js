/* global document, localStorage */
// Applies a saved theme before first paint (kept out of the bundle so it can run synchronously).
(function () {
  try {
    var t = localStorage.getItem('mm.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch {
    /* storage unavailable: follow the OS */
  }
})();
