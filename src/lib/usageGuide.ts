/**
 * What the Usage page says about each service it reports on: its tab, what it
 * is for, its plan and limits and what happens past them, what the numbers on
 * its tab mean, how to set it up, and where to manage it. The "About" panel at
 * the top of each tab (src/components/UsageGuide.tsx) and the Overview's cards
 * (src/components/UsageOverview.tsx) read it. The figures are the ones in
 * README.md, docs/deploy.md and wrangler.toml; a plan that changes is a change
 * here too.
 */

export type UsageTab = 'overview' | 'people' | 'invites' | 'ai' | 'search' | 'mail' | 'cloudflare' | 'cloud' | 'look';

export interface ServiceGuide {
  id: UsageTab;
  /** The tab's label. */
  tab: string;
  /** The service's name, in "About …" and on the Overview's card. */
  title: string;
  /** Under the page's title while the tab is open. */
  subtitle: string;
  /** One line on the Overview's card: what it is for. */
  purpose: string;
  /** The "About" panel's first lines, always shown. */
  summary: string;
  limits?: { what: string; allowance: string; past: string }[];
  counters?: { name: string; meaning: string }[];
  notes?: string[];
  /** Steps; `backticks` are shown as code. */
  setup?: string[];
  links?: { label: string; url: string }[];
}

/** The tab bar, in groups: the Overview alone, then people, the services Reader pays for, and what it runs on. */
export const GROUPS: { title: string; about: string; tabs: UsageTab[] }[] = [
  { title: '', about: '', tabs: ['overview'] },
  { title: 'People', about: 'who uses Koios, and who brought whom', tabs: ['people', 'invites'] },
  { title: 'Paid services', about: 'the accounts Koios spends on when people use it', tabs: ['ai', 'search', 'mail'] },
  { title: 'Infrastructure', about: 'what Koios itself runs on', tabs: ['cloudflare', 'cloud'] },
  { title: 'The site', about: 'how it looks and works for everyone', tabs: ['look'] },
];

export const GUIDES: Record<UsageTab, ServiceGuide> = {
  look: {
    id: 'look',
    tab: 'Look',
    title: 'The look',
    subtitle: 'which of the site’s two looks every visitor gets: Koios, or the theme before it',
    purpose: 'One switch for the whole site: the Koios night, or Classic.',
    summary:
      'The site has two looks. Koios is the night: navy ground, gold hairlines and labels, headings in the light serif, and the armillary with one of the Titan’s lines where a page is empty. Classic is the theme before it. The choice made here is kept on the Worker and reaches every visitor on their next page load; the loading screen and the sign-in are the same either way.',
    notes: [
      'The choice is kept in the Worker’s SESSIONS namespace (wrangler.toml). Without one, the switch changes only the browser it is clicked in.',
      'Under the Koios look, Settings → Appearance offers Light, Dark and Koios, with Koios the default; under Classic it offers Light and Dark, and anyone set to Koios reads in Dark.',
      'Below the look: whether the playground agent’s long answers are written on the server (the AGENT_JOBS Durable Object), so a dropped connection or a closed page doesn’t end them. On unless switched off here.',
    ],
  },
  overview: {
    id: 'overview',
    tab: 'Overview',
    title: 'Overview',
    subtitle: 'every service Koios runs on, how each stands against its plan, and what needs you',
    purpose: '',
    summary: '',
  },

  people: {
    id: 'people',
    tab: 'People',
    title: 'People',
    subtitle: 'who signed in and what each person used on your accounts',
    purpose: 'Everyone signed in, and what each used on your accounts.',
    summary:
      'Everyone who signed in with Google gets a 30-day pass, and with it uses your accounts: Scholar searches, the in-reader browser, PDFs, web searches, AI answers and LaTeX compiles. This table is your Worker’s own count of each, per person per day. Click a person to see their days.',
    limits: [
      { what: 'Requests per person', allowance: '30 a minute (PERSON_LIMIT)', past: 'That person gets “too many … try again in a minute” (429) for Scholar, web search, AI, LaTeX and invitations. You, the owner, are never limited.' },
      { what: 'Sign-in attempts', allowance: '5 a minute per address (LOGIN_LIMIT)', past: 'The sixth is refused before Google is asked; the sign-in screen says to wait a minute.' },
      { what: 'PDFs without a pass', allowance: '60 a minute per address (PDF_LIMIT)', past: '“Too many files at once from this address”. Signed-in people are not limited.' },
      { what: 'History kept', allowance: '90 days', past: 'Older days drop off the tally.' },
    ],
    counters: [
      { name: 'Sign-ins', meaning: 'Google sign-ins swapped for a pass.' },
      { name: 'Scholar', meaning: 'Scholar pages asked through Serply or SerpApi, including asks that failed. Scholar asked directly (free) is not counted.' },
      { name: 'Serply credits', meaning: 'Credits Serply charged: a results page is 1, a profile up to 2, people up to 3.' },
      { name: 'SerpApi searches', meaning: 'Searches SerpApi charged, one per Scholar page; looking up people takes up to four.' },
      { name: 'Browser', meaning: 'Times the in-reader browser was opened (Cloudflare Browser Rendering, or Browserless for sites Cloudflare’s browser cannot pass).' },
      { name: 'PDFs', meaning: 'Files fetched with a pass, through a kept sign-in or Browserless. Plain open-access fetches by people not signed in are not counted.' },
      { name: 'Web searches', meaning: 'Searches made by Ask AI’s Web button through the proxy.' },
    ],
    notes: [
      'Answers from the proxy’s five-minute cache cost nothing and are not counted.',
      'A web search made through Serply or SerpApi also counts in that service’s column.',
      'Signed in with READER_TOKEN rather than Google, you appear as “owner”.',
      'Who may sign in at all is READER_EMAILS; who sees this page is READER_OWNERS.',
    ],
    setup: [
      'Sign-in needs `GOOGLE_CLIENT_ID` in wrangler.toml and the secret `READER_TOKEN`: `openssl rand -base64 32 | npx wrangler secret put READER_TOKEN`.',
      'To limit who may sign in: `npx wrangler secret put READER_EMAILS` (addresses or @domains).',
      'To name yourself the owner: `npx wrangler secret put READER_OWNERS` with your Google email.',
      'Changing READER_TOKEN ends every pass at once: everyone signs in again.',
    ],
    links: [{ label: 'Google OAuth client', url: 'https://console.cloud.google.com/apis/credentials' }],
  },

  invites: {
    id: 'invites',
    tab: 'Invitations',
    title: 'Invitations',
    subtitle: 'who invited whom — to a project, by email or by a link — and whether it took',
    purpose: 'Who invited whom, and how many joined.',
    summary:
      'Every invitation anyone sent: to a shared project, by email (“Invite someone”), or as a personal link with a note. One counts as taken when the person joins the project, or signs in for the first time after an email or from the link.',
    limits: [
      { what: 'Personal links', allowance: 'Good for 30 days', past: 'The link says it has run out; the inviter makes a new one.' },
      { what: 'Invitations by email', allowance: 'Your email plan’s sends (Email tab)', past: 'The invitation still stands; the share dialog says to send the link by hand.' },
      { what: 'Ledger', allowance: 'The last 5,000 invitations', past: 'The oldest drop off: a tally, not an archive.' },
    ],
    counters: [
      { name: 'Project / Email / Link', meaning: 'Invitations of each kind the person sent or made.' },
      { name: 'Sent', meaning: 'All of them. A withdrawn project invitation is not counted.' },
      { name: 'Took', meaning: 'How many were taken up: joined, or signed in.' },
      { name: 'Rate', meaning: 'Took as a share of Sent.' },
    ],
    notes: ['Costs nothing of its own: it is a Durable Object on your Cloudflare account (INVITES), counted on the Cloudflare tab.'],
    setup: ['Made by `npx wrangler deploy` (the INVITES binding in wrangler.toml); nothing else to set.'],
  },

  ai: {
    id: 'ai',
    tab: 'AI',
    title: 'AI models',
    subtitle: 'what Ask AI, Explain and Implementation cost on Claude, DeepSeek and Gemini',
    purpose: 'Ask AI, Explain and Implementation: Claude, DeepSeek, Gemini.',
    summary:
      'Ask AI, Explain and Implementation answer with Claude (Anthropic), DeepSeek or Gemini. With the site’s keys on the Worker, your accounts pay for everyone’s answers. Anyone can instead use their own Claude or DeepSeek key (Settings → AI models → Use my own key), which bills their account. Cost here is each answer’s tokens at list price.',
    limits: [
      { what: 'Who may use your keys', allowance: 'AI_FOR = "everyone" or "owners"', past: 'With "owners", others are told to add their own key (403).' },
      { what: 'Per person', allowance: '30 questions a minute', past: '“Too many questions at once” (429).' },
      { what: 'DeepSeek balance', allowance: 'Prepaid: what you topped up', past: 'At zero DeepSeek refuses; the DeepSeek card says the balance cannot pay. Top up at platform.deepseek.com.' },
      { what: 'Anthropic, Gemini', allowance: 'Your account’s credit and rate limits', past: 'The provider refuses and the answer shows its error. Check the provider’s console.' },
    ],
    counters: [
      { name: 'Cost', meaning: 'Tokens × list price per million (Claude Opus 5 $5 in / $25 out, Sonnet 5 $2 / $10, Haiku 4.5 $1 / $5; DeepSeek flash $0.28 / $0.42; Gemini 3.1 Pro $2 / $12, 3.8 Flash $0.75 / $3.75, 3.5 Flash-Lite $0.30 / $2.50), cached input at the cache rate.' },
      { name: 'Requests / Tokens', meaning: 'Answers, and tokens in and out.' },
      { name: 'Balance / From balance', meaning: 'DeepSeek’s own balance, checked hourly, and how much it fell between checks.' },
    ],
    notes: [
      'The provider’s own console is the bill: this is an estimate at list price.',
      'Answers on someone’s own key are reported by the app and counted here too, mixed in with those on yours.',
      'Claude’s web searches are Anthropic’s own, billed to the key at $10 a thousand, not through this proxy.',
      'Gemini is only ever on the site’s key.',
    ],
    setup: [
      'Put a key on the Worker: `npx wrangler secret put ANTHROPIC_KEY` (or `DEEPSEEK_KEY`, `GEMINI_KEY`).',
      'Decide who may use it: `AI_FOR = "everyone"` or `"owners"` in wrangler.toml.',
      'Set a spending limit at each provider, so a busy month cannot surprise you.',
    ],
    links: [
      { label: 'Anthropic console', url: 'https://console.anthropic.com' },
      { label: 'DeepSeek platform', url: 'https://platform.deepseek.com' },
      { label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
    ],
  },

  search: {
    id: 'search',
    tab: 'Search',
    title: 'Search',
    subtitle: 'Google Scholar through Serply or SerpApi, and the web searches behind Ask AI’s Web button',
    purpose: 'Google Scholar (Serply, SerpApi) and the Web button (Tavily).',
    summary:
      'Two kinds of paid search. Google Scholar finds what no free index has (theses, reports, profiles, every version of a paper); asked directly it is free but often refuses a server, so the Worker asks it through Serply or SerpApi. Ask AI’s Web button lets DeepSeek search and read the web, through the first key set of Tavily, Brave, Serply and SerpApi.',
    limits: [
      { what: 'Serply', allowance: '2,500 credits a month free', past: 'Serply refuses; with a SerpApi key too, the next ask goes there and Serply is asked last for 10 minutes.' },
      { what: 'SerpApi', allowance: 'A free allowance a month, then paid (see your SerpApi plan)', past: 'Refused the same way; Scholar is asked through Serply if it has a key.' },
      { what: 'Tavily', allowance: '1,000 credits a month free; a basic search is 1', past: 'Searches fail until the cycle turns, unless pay as you go is on at Tavily ($0.008 a credit).' },
      { what: 'Brave', allowance: '$5 of credit a month', past: 'Brave refuses until the month turns.' },
      { what: 'Per person', allowance: '30 a minute', past: '“Too many searches at once” (429).' },
    ],
    counters: [
      { name: 'Scholar asks', meaning: 'Scholar pages asked through a paid service, by everyone, over the period.' },
      { name: 'Serply credits / SerpApi searches', meaning: 'What each service charged for them.' },
      { name: 'Web searches', meaning: 'The Web button’s searches through the proxy. A page the model reads is fetched by the proxy itself and costs nothing.' },
      { name: 'Tavily credits this cycle', meaning: 'Tavily’s own count for the whole account, against the plan; marked at 70% and 90%.' },
    ],
    notes: [
      'Both are cached for five minutes: the same search again costs nothing.',
      'SCHOLAR_FIRST says which of Serply and SerpApi is asked first when both keys are set.',
      'With no Scholar key, Scholar is asked directly: free, but expect captchas.',
      'Tavily is checked hourly and when this page asks, at most every couple of minutes.',
    ],
    setup: [
      'Scholar: `npx wrangler secret put SERPLY_KEY` and/or `SERPAPI_KEY`; optionally `SCHOLAR_FIRST = "serply"` in wrangler.toml.',
      'Web button: `npx wrangler secret put TAVILY_KEY` (or `BRAVE_KEY`).',
      'At Tavily, turn on pay as you go with a cap if the free thousand is not enough.',
    ],
    links: [
      { label: 'Serply', url: 'https://serply.io' },
      { label: 'SerpApi', url: 'https://serpapi.com/manage-api-key' },
      { label: 'Tavily', url: 'https://app.tavily.com' },
      { label: 'Brave Search API', url: 'https://api-dashboard.search.brave.com' },
    ],
  },

  mail: {
    id: 'mail',
    tab: 'Email',
    title: 'Email',
    subtitle: 'the email the site sends: the plan’s sends used, delivery, and every send tried',
    purpose: 'Invitation emails, through Brevo (or SendGrid, Postmark, Resend).',
    summary:
      'The site emails an invitation when someone shares a project with an address, and when someone uses “Invite someone”. The Worker sends through a transactional email provider, from the sender you verified there. Without it nothing is emailed, and the share dialog says to send the link by hand.',
    limits: [
      { what: 'Brevo, free', allowance: '300 emails a day', past: 'Brevo refuses the rest of the day; the invitation stands without its email.' },
      { what: 'Resend, free', allowance: '100 a day, 3,000 a month', past: 'Refused the same way.' },
      { what: 'SendGrid, trial', allowance: '100 a day', past: 'Refused the same way.' },
      { what: 'Postmark, developer', allowance: '100 a month', past: 'Refused the same way.' },
      { what: 'Per person', allowance: '30 invitations a minute', past: 'The email is not sent; the link still works.' },
    ],
    counters: [
      { name: 'Sent today / this month', meaning: 'The provider’s count for the whole account, or the site’s own log where the provider has none — whichever is higher.' },
      { name: 'Credits left', meaning: 'What the provider says the plan has left (Brevo, SendGrid).' },
      { name: 'Delivered / bounced / blocked / spam', meaning: 'What happened to the emails, as the provider saw it. A hard bounce is an address that does not exist.' },
      { name: 'Sent by the site', meaning: 'Every email this Worker tried, with the provider’s reason when it refused (the last 2,000).' },
      { name: 'Blocked addresses', meaning: 'Addresses Brevo will not email again after a hard bounce, spam report or unsubscribe.' },
    ],
    notes: [
      'Sent from a Gmail address, receivers show “via brevo.com”, and strict institutions may refuse it; a domain of your own verified at the provider fixes both.',
      'Unblock only an address you know was fixed: emailing dead addresses hurts your sender reputation.',
      'A test email uses one of the plan’s sends.',
    ],
    setup: [
      'Make a free Brevo account and verify your sender (Senders, domains & dedicated IPs).',
      'Create an API key (SMTP & API → API keys) and give it to the Worker: `npx wrangler secret put MAIL_API_KEY`.',
      'Set `MAIL_FROM = "Koios <you@example.org>"` in wrangler.toml, exactly as verified, and deploy.',
      'On a paid plan, set `MAIL_DAILY_LIMIT` / `MAIL_MONTHLY_LIMIT` so the meters use it.',
      'Press Send a test mail below to check it.',
    ],
    links: [
      { label: 'Brevo dashboard', url: 'https://app.brevo.com' },
      { label: 'Brevo senders', url: 'https://app.brevo.com/senders/list' },
    ],
  },

  cloudflare: {
    id: 'cloudflare',
    tab: 'Cloudflare',
    title: 'Cloudflare',
    subtitle: 'your Cloudflare account: today’s use against the Free plan’s limits',
    purpose: 'The Worker every request goes through, its storage, and the browser.',
    summary:
      'Koios’s proxy is a Cloudflare Worker: every search, PDF, sign-in and AI answer goes through it. It keeps its state in Durable Objects (the tally, project rooms, invitations, the email log) and KV (kept sign-ins), and runs the in-reader browser on Browser Rendering. All of it is on the Workers Free plan, whose allowances are per day.',
    limits: [
      { what: 'Workers requests', allowance: '100,000 a day', past: 'The Worker answers with an error page until 00:00 UTC: Koios stops working.' },
      { what: 'Durable Objects', allowance: '100,000 requests, 13,000 GB-s, 5M rows read, 100,000 written a day; 5 GB stored', past: 'Operations fail until midnight UTC: tally, rooms and invitations stop.' },
      { what: 'KV', allowance: '100,000 reads; 1,000 writes, deletes and lists a day; 1 GB stored', past: 'Operations fail: kept sign-ins are not saved.' },
      { what: 'Browser Rendering', allowance: '10 minutes a day, 3 browsers at once, a few new ones a minute', past: 'The browser will not start (429); the pane says why and, when it is busy, retries.' },
    ],
    counters: [
      { name: 'Today', meaning: 'Use since 00:00 UTC, against the day’s allowance; storage is a total held.' },
      { name: 'Bars', meaning: 'The last 7 days, scaled to the busiest, each coloured by its share of the allowance.' },
    ],
    notes: [
      'Counts cover the whole Cloudflare account, every Worker on it, a few minutes behind.',
      'The Workers Paid plan ($5 a month) lifts these to monthly allowances, with hours of browser time.',
      'Sites whose bot check is Cloudflare’s own go through Browserless (BROWSERLESS_TOKEN) instead: about a thousand units a month free, a unit per half minute.',
    ],
    setup: [
      'In the dashboard: My Profile → API Tokens → Create Token → custom, with Account → Account Analytics → Read.',
      'Give it to the Worker: `npx wrangler secret put CLOUDFLARE_API_TOKEN`.',
      'Put `CLOUDFLARE_ACCOUNT_ID` in wrangler.toml (Workers & Pages → Account details) and deploy. Without them this tab shows the browser alone.',
    ],
    links: [
      { label: 'Cloudflare dashboard', url: 'https://dash.cloudflare.com' },
      { label: 'Workers plans', url: 'https://developers.cloudflare.com/workers/platform/pricing/' },
    ],
  },

  cloud: {
    id: 'cloud',
    tab: 'Google Cloud',
    title: 'Google Cloud',
    subtitle: 'your Google Cloud project: the LaTeX compiler, its services, billing and cost',
    purpose: 'The LaTeX compiler on Cloud Run, and what the project costs.',
    summary:
      'The LaTeX compiler — anyone signed in compiles with all of TeX Live — runs on Google Cloud Run in your project. This tab shows each Cloud Run service and VM with Start and Stop, the billing account, what the month cost by service, every charge, and the compiler against Cloud Run’s free tier.',
    limits: [
      { what: 'Cloud Run, free tier', allowance: '180,000 vCPU-s and 360,000 GiB-s a month — about 25 hours of compiling at 2 vCPU / 4 GiB', past: 'Billed to the project’s billing account; compiles keep working.' },
      { what: 'A compile', allowance: '4 minutes', past: 'Stopped, and the error says so.' },
      { what: 'The compiler’s image', allowance: '0.5 GB stored free', past: 'A few tens of cents a month.' },
      { what: 'GitHub Actions fallback', allowance: 'Free on a public repository; 2,000 minutes a month private', past: 'GitHub will not start runs until the month turns, unless spending is allowed on the account.' },
      { what: 'Billing account', allowance: 'Must be open, with a payment method', past: 'With billing off, Cloud Run stops and nothing compiles in the cloud.' },
    ],
    counters: [
      { name: 'Cost this month', meaning: 'From the billing export in BigQuery, after credits; it fills in within a day.' },
      { name: 'Services', meaning: 'Each Cloud Run service and VM, whether it is up, and what it served in 30 days. “Billed while idle” means minimum instances keep it running.' },
      { name: 'Compiler seconds', meaning: 'The Worker’s timing of each compile, times vCPU and GiB, against the free tier; Cloud Run’s own count runs a little higher.' },
    ],
    notes: [
      'Stop closes a Cloud Run service to the internet; stopping reader-latex stops compiles for everyone.',
      'A stopped VM still pays for its disk.',
      'Recharge opens Google’s payment page: Google takes payments only there.',
    ],
    setup: [
      'Make a service account `reader-usage` with roles Cloud Run Developer, Compute Instance Admin, Monitoring Viewer, BigQuery Job User and Data Viewer, and Billing Viewer on the billing account.',
      'Give the Worker its key: `npx wrangler secret put GCP_SERVICE_ACCOUNT_KEY < key.json`.',
      'For cost, turn on the billing export to BigQuery and set `GCP_BILLING_EXPORT_TABLE` in wrangler.toml.',
      'The compiler itself: `bash cloudrun/latex/deploy.sh`, then `LATEX_CLOUD_RUN_URL` and the secret `LATEX_CLOUD_RUN_TOKEN` (docs/deploy.md).',
    ],
    links: [
      { label: 'Billing', url: 'https://console.cloud.google.com/billing' },
      { label: 'Cloud Run', url: 'https://console.cloud.google.com/run' },
      { label: 'Budgets & alerts', url: 'https://console.cloud.google.com/billing/budgets' },
    ],
  },
};

/** Every tab, in the bar's order. */
export const TABS: UsageTab[] = GROUPS.flatMap((group) => group.tabs);
