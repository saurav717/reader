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
- **The desktop app.** The *Desktop app* workflow builds Reader for macOS,
  Windows and Linux and publishes it as the release `app-v<Companion version>`
  (see [desktop-app.md](desktop-app.md)), when the merge touches the app or the
  Companion. The site's **Download for …** offers the newest, and **Settings → Updates → Update** brings an
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

## Once more: the key that seals people's tokens

The Worker keeps the tokens people connect — an Overleaf account's Git token
and email, a GitHub token and its login — so that no browser holds them. It
seals each with a key of its own, `SECRETS_KEY`, used for nothing else
(`worker/secrets.js`): every person and every kind of secret gets a key
derived from it, each sealed value is bound to its owner, and records in KV
are filed under a keyed hash of the email, never the email itself. Without
it the Worker keeps nothing new and says so; set it **before** the merge
that brings it deploys:

```sh
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY
```

(or Cloudflare dashboard → Workers & Pages → reader-arxiv-proxy → Settings →
Variables and Secrets → Add → Secret). Keep a copy somewhere safe: a new key
can't open what the old one sealed, so changing it means everyone connects
their accounts again. Overleaf tokens kept before it (sealed with a key from
`LATEX_CLOUD_RUN_TOKEN`) are sealed again with it, and moved, the first time
they are read; a GitHub token still in someone's browser moves to the
Worker the next time they open the site signed in. A token unused for six
months is forgotten, and a GitHub token past the expiry GitHub gave it, or
that GitHub no longer takes, at once.

## Optional: Sign in with GitHub, and Reader's GitHub App

Projects → Connections → GitHub offers up to three ways in, and each person
picks: **Reader's GitHub App** (recommended: only the repositories they tick,
an eight-hour token the Worker renews), **Sign in with GitHub** (an OAuth App:
one click, as in VS Code, but every repository of theirs), or **a pasted
token** (always there). The two sign-ins appear once the Worker has their IDs;
set up either or both. Both send people back to the Worker:

    https://reader-arxiv-proxy.es16btech11007.workers.dev/github/callback

(your Worker's address, then `/github/callback`).

**Reader's GitHub App** (github.com → Settings → Developer settings → GitHub
Apps → New GitHub App):

1. **GitHub App name**: anything, e.g. *Reader papers*. **Homepage URL**:
   `https://saurav717.github.io/reader/`.
2. Under **Identifying and authorizing users**: **Redirect URI** (called
   *Callback URL* on older versions of the form) is the address above;
   **Allow wildcard matching** unticked; keep **Expire user authorization
   tokens** ticked; leave **Request user authorization (OAuth) during
   installation** and **Enable Device Flow** unticked (Reader starts the
   sign-in itself). Under **Post installation**: **Setup URL** empty,
   **Redirect on update** unticked.
3. **Webhook**: untick **Active**.
4. **Permissions → Repository permissions**: **Contents: Read and write**,
   **Administration: Read and write** (to make a private repository for a
   project's code; leave it out and people make them on GitHub instead),
   **Metadata: Read-only** (always on). Nothing else.
5. **Where can this GitHub App be installed?** *Only on this account* if Reader
   is yours alone; *Any account* if others sign in to it.
6. **Create GitHub App**. On its page: copy the **Client ID**, **Generate a new
   client secret** and copy it, and note its name in its address
   (github.com/apps/**reader-papers**): the slug.

```sh
npx wrangler secret put GITHUB_APP_CLIENT_ID       # the Client ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET   # the client secret
npx wrangler secret put GITHUB_APP_SLUG            # e.g. reader-papers
```

After signing in, each person chooses its repositories (Connections →
**Choose repositories**, which opens github.com/apps/<slug>/installations/new).

**Sign in with GitHub** (github.com → Settings → Developer settings → OAuth
Apps → New OAuth App): **Application name** *Reader*, **Homepage URL** as
above, **Authorization callback URL** the address above; **Register
application**, then copy the **Client ID** and **Generate a new client
secret**.

```sh
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

Both sign-ins use PKCE and a one-time state bound to the person; the Worker
keeps the tokens sealed with `SECRETS_KEY` (above), renews the GitHub App's,
and on **Disconnect** revokes the person's grant with GitHub.

## Optional: mail, for invitations to a shared project

Sharing a project (README, *Working on a project together*) invites people
by Google email. With mail set up, each invitation is also an email to that
address with the project's link — so someone who has never opened Reader is
told where to go and that signing in with Google is all it takes. The
Worker sends through Brevo, SendGrid, Postmark or Resend (`server/mail.js`),
from a sender the provider has verified.

**With a personal email, no domain** (Brevo, SendGrid and Postmark verify one
address of your own; Resend needs a domain). With Brevo, which has a free
plan:

1. Make an account at brevo.com. Under **Senders & IP → Senders**, add a
   sender: the name *Reader* and your own address. Brevo mails that address
   a confirmation; confirm it.
2. Under **SMTP & API → API keys**, generate a key (it starts with
   `xkeysib-`) and copy it.
3. In the repository: `npx wrangler secret put MAIL_API_KEY`, and paste the
   key.
4. In `wrangler.toml` under `[vars]`: `MAIL_FROM = "Reader <you@gmail.com>"`,
   the address exactly as you verified it.
5. `npm run deploy:worker`. Open the Worker's `/health`: it answers
   `"mail":true`.
6. In the app, share a project and invite another address of yours: the
   mail arrives from your address, *via Brevo*, with you as the reply-to.

A mail sent "from" an address at a domain that is not yours is marked so by
the receiver (Gmail shows *via brevo.com*), and a domain with a strict DMARC
policy — many institutions' — may refuse it: a gmail.com address goes
through; an institutional one may not. **With a domain of your own**, add it
under the provider's Senders → Domains, put the DNS records it gives you on
the domain, and set `MAIL_FROM = "Reader <noreply@your-domain>"`: no "via",
and nothing a receiver can hold against it.

```bash
npx wrangler secret put MAIL_API_KEY     # xkeysib-… (Brevo), SG.… (SendGrid), a Postmark server token, or re_… (Resend)
```

`MAIL_PROVIDER` names the provider when the key's shape does not. Without a
key and a sender, nothing is sent and the dialog gives the owner the link to
send. The same mail setting serves **Invite someone** (Settings, under the
Google account): an email about Reader to anyone, with the site's address —
which also offers a personal link with a QR code, and your own mail app,
neither of which needs mail on the Worker.

The invitations ledger — who invited whom, by project, mail or link, and
whether it took — is a Durable Object bound as `INVITES` (`wrangler.toml`,
migration v6); `npx wrangler deploy` makes it. It feeds the projects waiting
for someone on Home, and the **Invitations** tab of the Usage page, which is
the owner's (`READER_OWNERS`).

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
(a TeX Live image is large: some seconds). Cloud Run reads an image's files
only as they are first opened, so a new instance compiles a small paper of
the usual packages as it starts, and the Write tab's wake-up waits for that:
the formats, packages and fonts are then read before the paper's first
compile, not during it. XeLaTeX's and LuaLaTeX's font caches are built into
the image, not by each instance. The image in Artifact Registry
is about 2.5 GB, a few tens of cents a month past its 0.5 GB free storage.

Like Overleaf's, the compiler keeps each paper's folder between compiles —
TeX's `.aux`, `.bbl` and `.toc` too — so a compile sends only the files that
changed and TeX reruns only what it must; the Write tab compiles as you type.
The folders are in the instance's memory, so the service runs one instance
(taking four compiles at once) and a paper's next compile finds its folder.
While Cloud Run is picked, the Write tab wakes the instance when it opens and
every ten minutes, so a compile seldom waits for one to start; to never wait,
deploy with `MIN_INSTANCES=1 bash cloudrun/latex/deploy.sh` (billed while
idle — see Cloud Run's pricing — and the folders then live as long as it does).

Set up once, in the project `reader-509409`:

1. In console.cloud.google.com, pick the project, and make sure it has a
   billing account (≡ → Billing; the free tier needs one).

2. Open Cloud Shell (the **>_** icon, top right) and run:

   ```sh
   git clone https://github.com/saurav717/reader && cd reader
   bash cloudrun/latex/deploy.sh
   ```

   It turns on Cloud Run, Artifact Registry and Cloud Build, builds the
   image with Cloud Build (5–10 minutes: all of TeX Live), deploys it, and
   prints **`LATEX_CLOUD_RUN_URL`** and **`LATEX_CLOUD_RUN_TOKEN`**. Run it
   again (after `git pull`) to deploy a newer `server.py`; the token is kept.
   Another project: `bash cloudrun/latex/deploy.sh OTHER_PROJECT_ID`.

3. Tell the Worker: the address goes in `wrangler.toml` as
   `LATEX_CLOUD_RUN_URL` (in `[vars]`, where it is commented out), and the
   token is a secret — Cloudflare dashboard → Workers & Pages →
   reader-arxiv-proxy → Settings → Variables and Secrets → Add → Secret,
   or `npx wrangler secret put LATEX_CLOUD_RUN_TOKEN`. Once the Worker is
   deployed, compiles go to Cloud Run.

Or deploy from GitHub instead, on each merge that changes `cloudrun/latex`
(`.github/workflows/deploy-latex-cloudrun.yml`): a service account with
Cloud Run Admin, Artifact Registry Admin and Service Account User, and in
the repository's Actions settings the variable `GCP_PROJECT`, the secret
`GCP_SA_KEY` (the account's JSON key; or the variables
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`), and the secret
`LATEX_CLOUD_RUN_TOKEN` — the same token the service already has, or the
next deploy changes it.

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

## Google Cloud on the Usage page

The Usage page has two tabs. **People & services** is who used what. **Google
Cloud** is your project as Google reports it:

- the billing account and whether billing is on;
- this month's cost by service;
- every Cloud Run service and Compute Engine VM, with its state, its requests
  and instance time over 30 days, and **Start** / **Stop**;
- the charges and credits of the last 90 days;
- the LaTeX compiler's free tier, which used to sit in the middle of the
  single page.

The Worker reads all of this as a service account (`worker/gcloud.js`). Set it
up once, in Cloud Shell:

```sh
PROJECT=reader-509409
gcloud iam service-accounts create reader-usage --project $PROJECT --display-name "Reader Usage page"
SA=reader-usage@$PROJECT.iam.gserviceaccount.com
for role in roles/run.developer roles/compute.instanceAdmin.v1 roles/monitoring.viewer roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role $role
done
# The billing account itself: Viewer, so the page can name it.
gcloud billing accounts add-iam-policy-binding "$(gcloud billing projects describe $PROJECT --format 'value(billingAccountName.basename())')" \
  --member serviceAccount:$SA --role roles/billing.viewer
# Run.developer may change a service but not act as its runtime account:
gcloud iam service-accounts add-iam-policy-binding "$(gcloud projects describe $PROJECT --format 'value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser
gcloud iam service-accounts keys create key.json --iam-account $SA
```

Then give the Worker the key, and delete it from Cloud Shell:

```sh
npx wrangler secret put GCP_SERVICE_ACCOUNT_KEY < key.json && rm key.json
```

Cost and transactions come from the billing export. Google has no other API
for them. To turn the export on, go to console → Billing → Billing export →
BigQuery export and pick **Standard usage cost**. Then name its table in
`wrangler.toml`, as `GCP_BILLING_EXPORT_TABLE`. The table fills in a few hours
after it is turned on.

How Start and Stop work:

- **Cloud Run.** Cloud Run has no stopped state. **Stop** closes the service
  to the internet (ingress internal only), and **Start** opens it again. A
  service with no minimum instances costs nothing while closed. Stopping
  `reader-latex` stops compiles for everyone until it is started.
- **Compute Engine.** A VM is stopped and started as Compute Engine does it.
  A stopped VM still pays for its disk.

**Recharge** opens the billing account's payment page in the Cloud console.
Google takes payments, prepayments and added funds only there, never through
an API. Payments you made are listed on the same page.
