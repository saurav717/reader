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
  macOS** offers the newest, and **Settings → Updates → Update** brings an
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

## Once more: the LaTeX compiler (Write tab → Compile on → The cloud)

Anyone signed in to the reader can compile a paper with all of TeX Live,
with nothing to install or set up. The compiler is a small service on
**Google Cloud Run** (`cloudrun/latex`: TeX Live and `server.py`): the
Worker hands it the paper's files and waits, and the PDF is back in
seconds — no queue, nothing stored but the PDF and log, which the Worker
keeps for the page for an hour (`worker/latex.js`). TeX runs as an
unprivileged user, without shell escape, unable to open absolute paths,
and is stopped after 4 minutes. Where Cloud Run isn't set up, the Worker
uses GitHub Actions instead (below).

It runs with nothing between compiles (minimum 0 instances) on request-based
billing, so it costs only while compiling: Cloud Run's free tier — 180,000
vCPU-seconds and 360,000 GiB-seconds a month — is about 25 hours of
compiling at 2 vCPU and 4 GiB. The Usage page shows how much of it is used.
The first compile after a quiet spell waits for an instance to start
(a TeX Live image is large: some seconds). The image in Artifact Registry
is about 2.5 GB, a few tens of cents a month past its 0.5 GB free storage.

Set up once:

1. A Google Cloud project with billing on (the free tier needs an account),
   and its APIs:

   ```sh
   gcloud config set project YOUR_PROJECT
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com
   ```

2. A service account for GitHub to deploy with, and a key for it:

   ```sh
   gcloud iam service-accounts create reader-deploy
   SA=reader-deploy@YOUR_PROJECT.iam.gserviceaccount.com
   for role in run.admin artifactregistry.admin iam.serviceAccountUser; do
     gcloud projects add-iam-policy-binding YOUR_PROJECT --member "serviceAccount:$SA" --role "roles/$role"
   done
   gcloud iam service-accounts keys create key.json --iam-account "$SA"
   ```

   (Where keys are forbidden by the organisation's policy, use Workload
   Identity Federation instead: repository variables
   `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`.)

3. In GitHub, Settings → Secrets and variables → Actions:
   - variable **`GCP_PROJECT`** — the project id (and **`GCP_REGION`** if
     not `us-central1`);
   - secret **`GCP_SA_KEY`** — the contents of `key.json` (then delete the file);
   - secret **`LATEX_CLOUD_RUN_TOKEN`** — `openssl rand -base64 32`; the
     Worker gets the same.

4. Run **Deploy LaTeX compiler** from the Actions tab (it also runs on each
   merge that changes `cloudrun/latex`). Its summary prints the service's
   address.

5. Tell the Worker: put the address in `wrangler.toml` as
   `LATEX_CLOUD_RUN_URL` (in `[vars]`, where it is commented out), and

   ```sh
   npx wrangler secret put LATEX_CLOUD_RUN_TOKEN   # the same string as GitHub's
   ```

   then deploy the Worker. Compiles go to Cloud Run from then on.

The service allows unauthenticated calls (an organisation that forbids
`allUsers` will refuse the deploy): it refuses every compile without the
token, and is reached only over HTTPS.

### The fallback: GitHub Actions

Where the Worker has no Cloud Run compiler (below), it compiles on GitHub Actions.

Anyone signed in to the reader can compile a paper with all of TeX Live,
with nothing to install or set up: the Worker hands the paper to the
**LaTeX compile** workflow in this repository (`.github/workflows/latex-compile.yml`),
which fetches it back from the Worker, compiles it, and posts the PDF to the
Worker for the page (`worker/latex.js`). This repository is public, so a
paper is never committed to it and the workflow prints nothing of it; the
files are deleted once compiled, the PDF and log within the hour. Every hop
is HTTPS (TLS 1.2 or newer), and both ends refuse anything else. Actions
minutes are free and unlimited on a public repository.

It takes two secrets, set once:

1. **`LATEX_RUNNER_TOKEN`** — any long random string, the same in two places,
   so only this workflow can fetch a paper from the Worker:

   ```sh
   openssl rand -base64 32          # copy what it prints
   npx wrangler secret put LATEX_RUNNER_TOKEN
   ```

   and in GitHub: Settings → Secrets and variables → Actions → New
   repository secret, named `LATEX_RUNNER_TOKEN`, with the same value.

2. **`LATEX_GITHUB_TOKEN`** — so the Worker can start the workflow: a
   fine-grained personal access token (github.com/settings/personal-access-tokens),
   repository access *Only select repositories* → this one, permission
   **Actions: Read and write**, with an expiry. Then:

   ```sh
   npx wrangler secret put LATEX_GITHUB_TOKEN
   ```

Optional: a Worker var `LATEX_REPO` (owner/repo) if the workflow is in
another repository, and a repository variable `LATEX_WORKER` if the Worker
is not at `https://reader-arxiv-proxy.es16btech11007.workers.dev`. Until both
secrets are set, the Write tab says the site has no compiler set up yet.
The jobs are kept in the `SESSIONS` KV namespace the Worker already has.
