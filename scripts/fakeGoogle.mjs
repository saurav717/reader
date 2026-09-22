/**
 * Google, without Google: enough of Identity Services and the Drive REST API
 * for the app to sign in, upload a file and read it back, all inside the page.
 *
 * Shared by the end-to-end scripts so that each one is about the flow it is
 * testing rather than about stubbing. Nothing here leaves the machine and no
 * Google account is involved.
 */

/**
 * A real one-page PDF. The browser's viewer has to render something, or a
 * screenshot of "it worked" is a screenshot of an empty pane.
 */
export function makePdf(lines) {
  const content = lines
    .map((line, index) => `BT /F1 ${index ? 11 : 22} Tf 64 ${700 - index * 28} Td (${line}) Tj ET`)
    .join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj${object}endobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** The settings a deployment would have once it is set up: client id, proxy. */
export function settingsScript(overrides = {}) {
  return {
    googleClientId: 'test.apps.googleusercontent.com',
    driveFolderName: 'Papers_collection',
    autoSync: true,
    savePdf: true,
    syncOnOpen: true,
    proxyBase: '/api',
    theme: 'light',
    readingMode: 'pdf',
    contactEmail: 'reader@example.org',
    githubRepo: '',
    githubBranch: 'main',
    githubToken: '',
    githubSync: false,
    ...overrides,
  };
}

/**
 * Installs the whole fake on a Playwright context: Identity Services in the
 * page, and the Drive API on the network. Returns the record of what Drive was
 * asked to do, which is what the assertions read.
 */
export async function installGoogle(context, { pdf, settings = settingsScript(), profile } = {}) {
  const drive = { files: new Map(), folders: new Map(), uploads: [], downloads: [] };
  let nextId = 1;

  await context.addInitScript(
    ([storedSettings]) => {
      // The app only ever calls initTokenClient and requestAccessToken, and
      // only ever reads the token out of the callback.
      window.google = {
        accounts: {
          oauth2: {
            initTokenClient: (config) => ({
              requestAccessToken: () =>
                setTimeout(
                  () =>
                    config.callback({
                      access_token: 'test-token',
                      expires_in: 3600,
                      scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
                    }),
                  10,
                ),
            }),
            revoke: (_token, done) => done && done(),
          },
        },
      };
      localStorage.setItem('reader.settings', JSON.stringify(storedSettings));
    },
    [settings],
  );

  const json = (route, body) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route('**/accounts.google.com/gsi/client*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }),
  );
  await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) =>
    json(route, profile || { name: 'Saurav Chennuri', email: 'reader@example.org' }),
  );

  await context.route('**/www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const id = `file-${nextId++}`;
      const body = request.postData() || '';
      const name = body.match(/"name":"([^"]+)"/)?.[1] || 'unknown';
      drive.uploads.push(name);
      drive.files.set(id, { name, body: name.endsWith('.pdf') ? pdf : Buffer.from(body) });
      return json(route, { id, name, webViewLink: `https://drive.google.com/file/d/${id}/view` });
    }

    const media = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (media && url.searchParams.get('alt') === 'media') {
      drive.downloads.push(media[1]);
      const file = drive.files.get(media[1]);
      return route.fulfill({
        status: file ? 200 : 404,
        contentType: 'application/pdf',
        body: file ? file.body : Buffer.from('missing'),
      });
    }

    if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
      const id = `folder-${nextId++}`;
      const name = JSON.parse(request.postData() || '{}').name;
      drive.folders.set(name, id);
      return json(route, { id, name });
    }

    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') || '';
      const name = query.match(/name = '([^']+)'/)?.[1];
      const folder = name && drive.folders.get(name);
      return json(route, { files: folder ? [{ id: folder, name }] : [] });
    }

    return json(route, {});
  });

  return drive;
}

/** Past the connect screen and into the app, with Drive connected. */
export async function connectAndEnter(page) {
  await page
    .getByRole('button', { name: /Connect Google Drive|Sign in with Google/i })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page
    .getByRole('button', { name: /Start reading|Not now/i })
    .first()
    .click();
}

/** The one-line PASS/FAIL reporter both scripts print. */
export function reporter() {
  const problems = [];
  const check = (label, condition, detail = '') => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) problems.push(label);
  };
  return { check, problems };
}
