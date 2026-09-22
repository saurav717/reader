// Signing in with an institution: which URL a signed-in browser is asked for,
// how a landing page's PDF is found, and what the proxy says about whether it
// can open a window at all. No browser is launched here — these are the
// decisions around it, which are what can be wrong quietly.
//
//   node --test scripts/access.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
const { availability, everSignedIn, headedArgs, pdfCandidates, pdfLinksIn, status, viewerUrl } = await import('../server/access.js');

describe('which URL a signed-in browser asks for', () => {
  it('turns an IEEE document page into its stamp endpoints, file first', () => {
    const candidates = pdfCandidates('https://ieeexplore.ieee.org/document/9000000/');
    assert.equal(candidates[0], 'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9000000');
    assert.equal(candidates[1], 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000');
    assert.equal(candidates[2], 'https://ieeexplore.ieee.org/document/9000000/');
  });

  it('reads the article number from an abstract page and from a stamp URL', () => {
    assert.equal(
      pdfCandidates('https://ieeexplore.ieee.org/abstract/document/1234567')[0],
      'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1234567',
    );
    assert.equal(
      pdfCandidates('https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=1234567')[0],
      'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1234567',
    );
  });

  it('leaves every other publisher alone', () => {
    assert.deepEqual(pdfCandidates('https://link.springer.com/article/10.1007/x'), [
      'https://link.springer.com/article/10.1007/x',
    ]);
    assert.deepEqual(pdfCandidates('not a url'), ['not a url']);
  });
});

describe('where a landing page says its PDF is', () => {
  it('reads the citation_pdf_url meta tag most publishers put on the page', () => {
    const html = `<html><head>
      <meta name="citation_title" content="A paper">
      <meta name="citation_pdf_url" content="https://link.springer.com/content/pdf/10.1007/x.pdf">
    </head></html>`;
    assert.deepEqual(pdfLinksIn(html, 'https://link.springer.com/article/10.1007/x'), [
      'https://link.springer.com/content/pdf/10.1007/x.pdf',
    ]);
  });

  it('reads the path IEEE keeps in its metadata blob, and the frame on its stamp page', () => {
    const document = `<script>xplGlobal.document.metadata={"articleNumber":"9000000","pdfPath":"/iel7/1/2/09000000.pdf","pdfUrl":"/stamp/stamp.jsp?tp=&arnumber=9000000"};</script>`;
    assert.deepEqual(pdfLinksIn(document, 'https://ieeexplore.ieee.org/document/9000000'), [
      'https://ieeexplore.ieee.org/iel7/1/2/09000000.pdf',
      'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000',
    ]);
    const stamp = `<html><body><iframe src="https://ieeexplore.ieee.org/ielx7/1/2/09000000.pdf?tp=&amp;arnumber=9000000&amp;ref="></iframe></body></html>`;
    assert.deepEqual(pdfLinksIn(stamp, 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000'), [
      'https://ieeexplore.ieee.org/ielx7/1/2/09000000.pdf?tp=&arnumber=9000000&ref=',
    ]);
  });

  it('resolves relative links, skips duplicates, and never returns http', () => {
    const html = `<a href="/content/pdf/x.pdf">PDF</a><a href="/content/pdf/x.pdf">again</a><a href="http://mirror.example/x.pdf">mirror</a><a href="/about">about</a>`;
    assert.deepEqual(pdfLinksIn(html, 'https://publisher.example/article/x'), [
      'https://publisher.example/content/pdf/x.pdf',
    ]);
  });
});

describe('whether this proxy can open a window', () => {
  it('has never signed in when the profile directory does not exist', () => {
    assert.equal(everSignedIn(), false);
  });

  it('answers with a boolean, and a reason when it cannot', async () => {
    const ready = await availability();
    assert.equal(typeof ready.available, 'boolean');
    if (!ready.available) assert.match(ready.reason, /Playwright|Chromium|screen/);
  });

  it('reports the window closed and where the profile would be', async () => {
    const answer = await status();
    assert.equal(answer.window, 'closed');
    assert.equal(answer.everSignedIn, false);
    assert.equal(answer.profile, process.env.READER_PROFILE_DIR);
  });
});

describe('where the proxy\'s screen can be seen from elsewhere', () => {
  const saved = {};
  const set = (values) => {
    for (const key of ['READER_VIEWER_URL', 'READER_VIEWER_PORT', 'CODESPACE_NAME', 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN']) {
      if (!(key in saved)) saved[key] = process.env[key];
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  };
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  it('has no viewer on a machine with its own screen', () => {
    set({});
    try {
      assert.equal(viewerUrl(), undefined);
      assert.deepEqual(headedArgs(), []);
    } finally {
      restore();
    }
  });

  it('names the virtual desktop of a Codespace, and fills its screen', () => {
    set({ CODESPACE_NAME: 'fuzzy-space-abc123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' });
    try {
      assert.equal(
        viewerUrl(),
        'https://fuzzy-space-abc123-6080.app.github.dev/vnc.html?autoconnect=true&resize=scale&reconnect=true',
      );
      assert.deepEqual(headedArgs(), ['--start-maximized']);
    } finally {
      restore();
    }
  });

  it('takes an address given by hand over the one it would work out', () => {
    set({ READER_VIEWER_URL: 'https://desk.example.org/vnc.html', CODESPACE_NAME: 'x', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' });
    try {
      assert.equal(viewerUrl(), 'https://desk.example.org/vnc.html');
    } finally {
      restore();
    }
  });
});
