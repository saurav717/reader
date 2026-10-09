# Publishing: merge, and that's all

Merging a pull request into `main` here publishes everything it changes:

- **The site.** The *Deploy site* workflow (`.github/workflows/deploy-site.yml`)
  runs `npm run build:pages` and puts the result in
  `saurav717/saurav717.github.io` under `reader/`. GitHub Pages then serves it
  at https://saurav717.github.io/reader/ within a minute or two. The build has
  the site's Worker compiled in (`build:pages`' default), and the workflow
  refuses to publish one without it.
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
