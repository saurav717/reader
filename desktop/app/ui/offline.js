// Shown in the site's window when it couldn't load: Try again goes back to where it was going.
const query = new URLSearchParams(window.location.search);
const why = query.get('error');
if (why) document.getElementById('why').textContent = ` (${why})`;
document.getElementById('retry').addEventListener('click', () => {
  const url = query.get('url');
  if (url && /^https?:/.test(url)) window.location.href = url;
});
