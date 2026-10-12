// The start page: how setting up or starting the Companion goes, and what to do when it doesn't.
const status = document.getElementById('status');
const note = document.getElementById('note');
const bar = document.getElementById('bar');
const log = document.getElementById('log');
const actions = document.getElementById('actions');

window.readerApp.start.onProgress((message) => {
  if (message.setup) {
    note.textContent = 'One-time setup: a minute or two. Reader installs its own Python, the Jupyter server it runs your code with, and the VS Code extension if you have VS Code.';
    log.hidden = false;
  }
  if (message.status) status.textContent = message.status;
  if (message.line !== undefined) {
    log.textContent += `${message.line}\n`;
    log.scrollTop = log.scrollHeight;
  }
  if (message.failed) {
    status.textContent = 'Reader’s Companion didn’t start';
    note.textContent = `${message.failed} What it said is below. Reader still opens without it: only running code on this computer needs it.`;
    bar.classList.add('failed');
    log.hidden = false;
    actions.hidden = false;
  }
});

document.getElementById('retry').addEventListener('click', () => window.readerApp.start.retry());
document.getElementById('without').addEventListener('click', () => window.readerApp.start.without());
document.getElementById('log-file').addEventListener('click', () => window.readerApp.start.log());
