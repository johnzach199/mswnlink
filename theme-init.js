// Runs before first paint (loaded synchronously in <head>) so the window never flashes the wrong theme.
(function () {
  var root = document.documentElement;
  var theme = 'light';
  try {
    var saved = localStorage.getItem('mswnlink.ui-theme');
    if (saved === 'dark' || saved === 'light') theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch (error) { /* storage unavailable: keep the light default */ }
  root.dataset.theme = theme;
  var platform = String(navigator.platform || navigator.userAgent || '');
  root.dataset.platform = /Mac/i.test(platform) ? 'darwin' : (/Win/i.test(platform) ? 'win32' : 'linux');
})();
