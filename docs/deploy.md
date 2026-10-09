# Publishing: merge, and that's all

Merging a pull request into `main` here publishes everything it changes:

- **The site.** The *Deploy site* workflow (`.github/workflows/deploy-site.yml`)
  runs `npm run build:pages` and puts the result in
  `saurav717/saurav717.github.io` under `reader/`. GitHub Pages then serves it
  at https://saurav717.github.io/reader/ within a minute or two. The build has
  the site's Worker compiled in (`build:pages`' default), and the workflow
  refuses to publish one without it.
- **The proxy.** The *Deploy worker* workflow deploys the Cloudflare Worker
  when a merge changes it (below).
- **The Mac app.** The *macOS app* workflow builds Reader.app and publishes it
  as the release `app-v<Companion version>` (see [macos-app.md](macos-app.md)),
  when the merge touches the app or the Companion. The site's **Download for
  macOS** offers the newest, and **Settings → This computer → Update** brings an
  installed Companion up to the version the site serves.

## Once: the token the site needs

A workflow here can't write to another repository on its own. Give it a token
for the site's repository, and nothing else:

1. On GitHub: your picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Name** it "Reader site deploy", pick an **Expiration** (a year is fine; the
   workflow says when it has run out), and under **Repository access** choose
   **Only select repositories** → `saurav717/saurav717.github.io`.
3. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Leave everything else as it is.
4. **Generate token** and copy it.
5. In **github.com/saurav717/reader → Settings → Secrets and variables →
   Actions → New repository secret**, name it `SITE_DEPLOY_TOKEN` and paste it.

Until it is there, *Deploy site* says so and does nothing, and a site update is a
pull request to the site's repository, as before.

## Once more: the token the Worker needs

The *Deploy worker* workflow (`.github/workflows/deploy-worker.yml`) deploys
the proxy, `reader-arxiv-proxy`, when a merge changes `worker/`, `server/` or
`wrangler.toml`, as `npm run deploy:worker` does by hand. Its secrets
(`READER_TOKEN`, `READER_OWNERS`, the keys) stay as they are. It needs a
Cloudflare token:

1. In the Cloudflare dashboard: your profile → **API Tokens** → **Create Token**
   → the **Edit Cloudflare Workers** template → **Use template**.
2. Under **Account Resources**, pick your account; under **Zone Resources**,
   **All zones** is fine (the Worker is on workers.dev). **Continue to summary**
   → **Create Token**, and copy it.
3. Your **Account ID** is on the Workers & Pages overview page, on the right.
4. In **github.com/saurav717/reader → Settings → Secrets and variables →
   Actions**, add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID`
   (the ID).

Until they are there, *Deploy worker* says so on a merge and deploys nothing;
`npm run deploy:worker` from a computer signed in to Cloudflare still does it.
