// Uninstall Koios: what to take away with it, then how that goes.
const api = window.readerApp.uninstall;
const log = document.getElementById('log');
const go = document.getElementById('go');
const cancel = document.getElementById('cancel');
let finished = null;

void api.details().then((details) => {
  document.getElementById('files').textContent = details.files;
  document.getElementById('settings').textContent = details.settings;
  if (details.platform === 'darwin') {
    document.getElementById('what').textContent = 'This removes the Companion that starts when you log in and moves Koios to the Bin. Your files stay unless you tick the second box.';
  }
});

api.onProgress((line) => {
  log.hidden = false;
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
});

cancel.addEventListener('click', () => (finished ? api.quit() : api.cancel()));

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (finished) return api.quit();
  for (const input of document.querySelectorAll('input')) input.disabled = true;
  go.disabled = true;
  cancel.disabled = true;
  go.textContent = 'Uninstalling…';
  log.hidden = false;
  finished = await api.run({ vscode: document.getElementById('vscode').checked, deleteFiles: document.getElementById('delete').checked });
  go.disabled = false;
  go.className = 'primary';
  go.textContent = finished.quit ? 'Close' : 'Done';
  cancel.hidden = true;
  if (finished.soon) setTimeout(() => api.quit(), 1500);
});
