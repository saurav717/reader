// The privacy policy and terms (public/privacy/, public/terms/) in the theme
// the app is in, before the first paint: the same reading of the site's look
// and the saved settings as index.html makes, so Koios, Light or Dark here is
// what Settings → Appearance says. Nothing is written.
(function () {
  var root = document.documentElement;
  try {
    var look = localStorage.getItem('reader.look') === 'classic' ? 'classic' : 'koios';
    var saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
    var kept = saved.theme;
    // A theme nobody picked follows the look (lib/store.tsx does the same).
    if (!saved.themeChosen && (kept === 'dark' || !kept)) kept = null;
    var theme = kept || (look === 'classic' ? 'dark' : 'koios');
    if (theme === 'system') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (theme === 'koios' && look === 'classic') theme = 'dark';
    if (theme === 'koios') {
      root.dataset.koios = 'on';
      if (saved.koiosSky !== false) root.dataset.sky = 'on';
      theme = 'dark';
    }
    root.dataset.theme = theme;
  } catch (e) {
    root.dataset.koios = 'on';
    root.dataset.theme = 'dark';
  }
})();
