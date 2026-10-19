# Simulation: how it was built, checked and reviewed

The companion to [simulation.md](simulation.md), which describes *what* the simulation projects and the Sim pane
are. This one is the process: the order the work went in, every command that ran in the background and what came
of it (including the three the task list shows as *Failed*), the review of the change against the code that was
already there, and the checklist to run before merging or after changing any of it. Written so that someone who
was not in the session can retrace it, repeat it, and trust what it claims.

The branch is `claude/zealous-bardeen-vr8z49`; the first commit is `f941149`, the review fixes are the commit after.

---

## 1. The ask

Two questions, then a build request:

1. *What do people use for RL and robotics simulation?* Answered in the conversation, then turned into the
   catalogue (`src/lib/simulators.ts`): 31 simulators, each with its install, what it needs, and its environments.
2. *Can the site host world-model and RL work, with coding agents building it and telemetry so I can see and
   learn?* Yes; this is the build.
3. *As many simulation options as possible, every recommendation implemented, tools for the limitations, and
   documentation of what was done, the challenges and their resolution.*

## 2. The order of work

Each step was chosen so the next could be checked against something real rather than assumed.

| # | Step | Why in this order |
|---|---|---|
| 1 | Read the Playground: `src/lib/playground.ts`, `PlaygroundWorkspace.tsx`, the Metrics and TensorBoard panes, `telemetry.ts`, `koiosHelper.ts`, `colab.ts`'s `runQuietly` and the Jupyter contents helpers | To add to the app the way it is built: panes read the machine through the second kernel, helpers are written to `.reader/pylib`, the sync carries text. |
| 2 | Write `src/sim/koios_telemetry.py` and run it for real against Gymnasium and MuJoCo in a venv | The format had to exist and be proven before anything read it. The first run found the EGL-without-a-GPU problem (section 4). |
| 3 | Write the templates as real files (`src/sim/templates/*.py`) and the catalogue; generate projects from them with a small script and run each | Running them found the two learning bugs (PPO's shared body, torch's thread pool) that no amount of reading would have. |
| 4 | Write the pane's reader (`simTelemetry.ts`) with the same diagnostics as the Python, then the Sim pane, the picker and the project assembly | Two implementations of one rule set, held equal by a test (section 5). |
| 5 | Tests (`scripts/simulation.test.mjs`), `tsc`, the full suite, a production build | Section 5. |
| 6 | A UI harness: the real components in Vite with `runQuietly` swapped for a local Python, screenshotted in Chromium against the real runs | To see the pane and the picker drawn from actual files, not to trust the code. Found the H.264 caveat. |
| 7 | Docs, commit, push | |
| 8 | Review (this document, section 6): the three *Failed* tasks explained, the diff against existing code re-read, three fixes | |

## 3. The background tasks, one by one

The session's task list shows 26 finished tasks. The ones that mattered, in order, with what each established.
Durations are from the list.

| Task | Result | What it established |
|---|---|---|
| Install deps and a Python venv with gymnasium | ok, 18 s | `gymnasium 1.x`, `mujoco 3.x`, `imageio-ffmpeg` in a venv under the scratchpad; `npm ci` for the repo. |
| Exercise the telemetry module end to end | **crashed by design**: the test script raises at the end | The run recorded its own crash (`status: crashed`, the traceback in the `end` event), three CartPole videos as MP4, a dream with per-frame error, a note; `summary` printed all of it. Also found: `doctor` crashed on `importlib.util.find_spec("google.colab")` when `google` isn't installed. Fixed with `_have()`. |
| Install OSMesa/EGL and recheck rendering | 12 s | With `libegl1` present but no GPU, `MUJOCO_GL=egl` fails inside MuJoCo. The library being there is not enough. |
| Prefer OSMesa without a GPU and retest MuJoCo video | 5 s | The renderer is now EGL only when `nvidia-smi` or a `/dev/dri/renderD*` node exists, else OSMesa. HalfCheetah rendered off-screen to a 64 KB H.264 MP4 (checked with ffmpeg: `h264 (High) yuv420p`). |
| Install CPU torch and SB3 for template testing | 5 m 36 s | CPU torch, SB3, Box2D (via swig). |
| Run generated PPO project on CartPole | 13 s | **Return flat** (22 → 28 over 60k steps). The pane's own diagnostic flagged it: *Return isn't improving*. Cause: one MLP body shared by actor and critic; the value loss dominated the clipped gradient. |
| Separate actor/critic bodies and rerun PPO | 21 s | 22 → 262 mean return, best 500, in 100k steps. *Return is climbing*. |
| Run SAC, SB3 and world-model projects | **Failed (exit 144)** | See section 3.1. SB3 on LunarLander finished inside it: −155 → −70, three videos. SAC was running at ~1 step/s. |
| Run SAC alone and time it | 8 m 21 s | Still ~3 learning steps/s with nothing else running: not contention. |
| Profile SAC | 1 m 43 s | All the time inside `torch._C._nn.linear` and `torch.relu`: 3 ms for a 256-wide layer. |
| Benchmark torch thread counts | 11 s | **0.26 ms on 1 thread, 25.1 ms on 4** for the same layer on this 4-CPU container. The thread pool against a CPU quota. |
| Single-thread default and doctor thread benchmark | 5 s | PPO and SAC set one CPU thread (`KOIOS_TORCH_THREADS` overrides); the doctor measures both and prints the export. |
| Validate SAC and world model with one thread | **Failed (exit 144)** | See section 3.1. SAC inside it finished: 15,000 steps in 2 m 17 s, best return 1000 (InvertedPendulum solved), 23 videos. |
| Check existing sync tests and typecheck | 33 s | `tsc -b` clean after the sync change. |
| Run the simulation tests / Fix tests and rerun | 14 s / 13 s | First run: 30/32. One test regex was wrong about PettingZoo (it imports its simulator inside `main()`); one needed `external`/`imports` options to load `playground.ts` as the other tests do. Then 32/32. |
| Picker styles and typecheck | 36 s | Clean. |
| Start harness and screenshot the Sim pane | **Failed** | See section 3.1: Playwright's default browser path, in a throwaway script. |
| Run harness from inside the repo and screenshot | 20 s | Vite needed to run from inside the repo to resolve packages; React needed pre-bundling. |
| Restart vite with pre-bundled React and screenshot | 23 s | The Sim pane drawn from the real SAC run (`docs/sim-pane.png`). |
| Screenshot the simulator picker | 4 s | `docs/sim-picker.png`, on the "Dexterous hands" filter. |
| Screenshot the world-model run in the pane | 13 s | `docs/sim-dream.png`: the dream video, the error over the horizon, the error over training. |
| Clean up, typecheck and run all tests | 1 m 04 s | `tsc` clean; **1736 of 1740 pass; 4 fail in `glass.test.mjs` ("glass wallpapers")**. |
| Run the glass tests on the base commit | 6 s | The same 4 fail on `main` at `5ce2022`, in a worktree with no change applied. Pre-existing, unrelated. |
| Production build check | 34 s | `vite build` succeeds; the telemetry module's text is in the bundle (the `?raw` import works in Vite as in the test bundler). |
| Add GIF override, update docs, rerun tests | 14 s | `KOIOS_VIDEO=gif`; 32/32. |
| Add screenshots, commit and push | 5 s | `f941149`, pushed. |

### 3.1 The three tasks marked *Failed*

None of the three is a failure of the code in this change. Each is the session's shell wrapper reporting on a
long command that was moved to the background and then ended by hand.

- **Run SAC, SB3 and world-model projects** and **Validate SAC and world model with one thread** both exited
  with code **144**. The commands ran three or two Python jobs in parallel with `&` and `wait`, exceeded the
  foreground limit, were moved to the background, and were then killed by me (`pkill -f world_model.py`,
  then `kill` on the remaining jobs) once I had what I needed from them: the first because SAC was crawling and I
  wanted to profile it alone; the second because the world model on the CPU was at ~1 iteration a second and the
  runs it had already written were enough to screenshot. Their output files show the jobs that completed
  (`Done`) and their summaries; the kill produces the 144.
- **Start harness and screenshot the Sim pane** failed in a throwaway Playwright script in the scratchpad:
  `browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-…`. The repo's
  `playwright` package expects a newer browser build than the one pre-installed in this environment. Fixed in the
  next task by launching with `executablePath: '/opt/pw-browsers/chromium'`, as the environment's notes say to.
  Nothing in the repository uses that script.

The world-model run that was killed had, by then, written `loss/recon`, `loss/dynamics`, two dreams and their
error curves, which is what `docs/sim-dream.png` shows; `simulation.md` reports those numbers and says the run
was not taken further on a CPU.

## 4. What testing found that reading would not have

| Found | Where | Fix |
|---|---|---|
| EGL fails without a GPU even when its library is installed | first MuJoCo render on this container | choose EGL only with a GPU present, else OSMesa |
| `find_spec("google.colab")` raises when `google` isn't installed | `doctor` | `_have()` guards it |
| PPO with a shared actor-critic body doesn't learn CartPole | first PPO run; flagged by the pane's own diagnostic | separate bodies for flat observations, shared CNN for images, as CleanRL does |
| torch's default thread pool is ~100× slower than one thread on a small CPU container | SAC at 3 steps/s; profile; benchmark | one thread by default in PPO and SAC; the doctor measures both |
| The sync copied PNGs (in its default bring-back rules) as text, corrupting them on Colab's kernel path | reading `pullBack` while planning video fetching | binary files left on the machine; the pane fetches them byte for byte |
| Open-source Chromium can't play H.264 | the pane's `<video>` stuck at 0:00 in the screenshot | `KOIOS_VIDEO=gif` |
| "No episodes logged" fired on a world-model run, which has none by design | first world-model summary | the finding skips runs with dreams |
| `summary` printed "0 env steps/s" on finished runs | SB3 summary | speed shown only while running |

## 5. Verification matrix

What was run, where, and what passed. "Here" is this repository's cloud container: Linux, 4 CPUs, no GPU, no
display, Python 3.13, Node 22.

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc -b` | clean |
| VS Code extension types | `npm run typecheck:vscode` | clean |
| New tests | `node --test scripts/simulation.test.mjs` | 32/32 (catalogue integrity; every generated `.py` parses under Python; event parsing; incremental reads equal whole reads; all ten diagnostic cases; **TypeScript and Python findings identical on the same runs**; the module writing a crashed run, videos, dreams; `bridge` on DreamerV3-style JSONL and TD-MPC2-style CSV; `note` from the CLI; `doctor`; the on-machine listing and chunked media code; the media code refusing a path outside the project; `isBinaryPath`) |
| Full suite | `npm test` | 1736/1740; the 4 failures are `glass.test.mjs` and fail identically on `main` |
| Production build | `npx vite build` | succeeds; the Python module text is in `assets/index-*.js` |
| Worker | `npm run check:worker` (wrangler dry run) | succeeds (the Worker is untouched) |
| CI | `.github/workflows/deploy-site.yml` runs `npm ci && npm run build:pages` on pull requests; `deploy-worker.yml` runs seven unrelated test files | both exercised locally above |
| PPO template | CartPole-v1, 100k steps, 1 thread | 22 → 262 mean return, best 500 |
| SAC template | InvertedPendulum-v5, 15k steps, 1 thread | best return 1000 in 2 m 17 s, 23 videos |
| SB3 template | LunarLander-v3, PPO, 20k steps | −155 → −70 mean return, videos of the policy |
| World-model template | CartPole and the built-in ball world, CPU | losses and dreams logged; error rising over the horizon |
| Random-agent template | CartPole, InvertedPendulum, HalfCheetah via `run.wrap` | episodes, videos |
| Off-screen video | MuJoCo through OSMesa | H.264 MP4, confirmed with ffmpeg |
| The UI | Sim pane and picker in Chromium against the real runs | `docs/sim-pane.png`, `docs/sim-dream.png`, `docs/sim-picker.png` |

Not run here, and why: the JAX simulators (Brax, MuJoCo Playground, Craftax, gymnax), ManiSkill, Genesis, Isaac
Lab, CARLA, Habitat, MineRL, Unity ML-Agents and Godot need a GPU, a server, a JDK, conda or an engine binary.
Their starters follow each project's documented API and are checked to parse. **They are the first thing to run
on a GPU machine**, and `simulation.md` says so.

## 6. The review: does it break anything that was there?

Every file that existed before and was touched, what changed, and why it is safe. (New files can't break
existing behaviour except through these.)

| File | Change | Risk considered | Verdict |
|---|---|---|---|
| `scripts/bundle.mjs` | an esbuild plugin for `?raw` imports | affects every test's bundling | the full suite ran through it: same results as before, the 4 glass failures pre-existing |
| `src/components/Charts.tsx` | `LineChart` takes optional `marks` | every existing chart | drawn only when passed; nothing passes it but the Sim pane |
| `src/lib/playground.ts` | `start` gains `'sim'`; `isBinaryPath`; `pushFolder`, `pullBack`, `pullEdits` skip binary files | records with `start: 'sim'` read by an older build; the sync's behaviour | nothing switches on `start` (grepped); `normalise` keeps the value. The sync carried text: on a Jupyter server a binary read already returned null (400) and was skipped silently; on Colab's kernel path it was decoded as UTF-8 and written back corrupted. Now both skip and report it. **A behaviour change, and a fix.** |
| `src/components/PlaygroundWorkspace.tsx` | the Sim tab, its glyph and palette entry; `ensureHelper` also writes `koios_telemetry.py` (48 KB) to `.reader/pylib` | one more write per machine per tab before the first command | wrapped in the existing `.catch(() => undefined)`; a failed write leaves `helperOn` unset so it is retried; `.reader/` is in the default ignore rules so it is never synced. The "skipped" wording in the Sync report updated to say "over 2 MB, or not text" (review fix) |
| `src/components/Playground.tsx` | the seventh start card and `fromSim` | the home's grid is `repeat(3, …)` | seven cards wrap to a third row; no layout change needed |
| `src/styles.css` | new `.sim-*` classes and `.cell-chart .mark` | collisions | all new names; `.mark` scoped under `.cell-chart` |
| `package.json` | `simulation.test.mjs` in `test` and `test:unit` | CI | the Python tests skip themselves without `python3`; the numpy ones without numpy; none need a simulator |
| `README.md` | the Playground section: "Seven ways to start", a *A simulation* subsection | | prose only |

Review fixes made after the first commit (section 2, step 8):

1. **Notebook cells assumed the project folder.** The generated notebook's cells ran `!bash setup.sh`, but a
   playground notebook's kernel starts where the machine starts it (Colab's `/content`, a server's home); only
   the console `cd`s into the folder (`shellCell`). The cells now say so and show a `%cd` first.
2. **The Sync report's "over 2 MB"** now also names "not text (videos, images, weights)".
3. **The run listing walked the whole project tree** every 3–15 s with `glob('**/events.jsonl')`, including
   `node_modules` and `data/`. It is now an `os.walk` that prunes those folders and stops six levels down; the
   Python `find_runs` does the same, so `summary` and the pane see the same runs. A run under `data/` is not
   found, by design.

## 6.1 A second look, with a game and a made-up world

After the review, two more runs were made specifically to see the pane as someone training a game-playing agent
or dreaming a world would see it: SB3's PPO on LunarLander (a Box2D game) for 60k steps, and the world-model
template on its built-in ball world, both with `KOIOS_VIDEO=gif` so the screenshot browser could play them, and
with a note added from the terminal as an agent would (`koios_telemetry.py note … --by agent`). The live
screenshot found one more thing:

- **Series of one prefix on one chart only when their scales are close.** SB3 logs everything under `train/`,
  so `train/value_loss` (~1000) and `train/learning_rate` (0.0003) shared a chart on which only the big one
  could be read, and the four-name legend overflowed the pane. `scalarCharts` now lets a prefix's names share a
  chart only while their largest values are within 20× of each other (a test covers SB3's names), and the legend
  wraps. The screenshots in `simulation.md` were retaken after the fix.

## 6.2 Live 3D

Asked for after the first review: a live, orbitable 3D view of the simulation rather than clips. Built on Rerun,
in this order, each step checked before the next:

1. A smoke test of the SDK here: log a box and a ball, serve, load the web viewer in headless Chromium with a
   software rasterizer. Found that `rr.save()` replaces the stream sink, then that `set_sinks` with
   `serve_grpc`'s server does the same: the pairing that works is `GrpcServerSink` + `FileSink` in one
   `set_sinks`.
2. `koios_telemetry`: the sinks, the viewer, the `live3d` event, scalars/episodes/notes mirrored, `scene()` for
   MuJoCo geoms, `scene_step()`. A Humanoid-v5 run showed a speck: MuJoCo's 40 m floor; capped, and a default
   blueprint added.
3. The Companion's `PortProxy` (0.18.0), with a unit test that proves answers stream (three chunks 50 ms apart
   must arrive as three), the ticket is the credential, POSTs carry body/path/query, nothing-listening is a 502,
   websockets relay. The first run of the POST test failed in the test's own upstream handler, not the proxy.
4. The end-to-end chain through the real handler: the viewer page came through; the stream didn't — Rerun's URL
   parser refuses a path before `/proxy`. Resolved by streaming `scene.rrd` over HTTP from the run (`_RrdTail`),
   which the viewer loads from any URL. Then the humanoid moved live through the proxy.
5. The Sim pane's Live 3D section, with the harness feeding it a paired-Companion server pointed at the proxy:
   `docs/sim-live3d.png`. The first screenshot showed the Colab fallback instead: Vite caches files under
   `node_modules` as immutable, where the harness lived, so the edited page never reached the browser until the
   dev server restarted with `--force`.

Three background commands in this phase ended with code 144 again: each was a long command whose Python child
(a run holding ports, a proxy) I ended by hand once it had served its purpose; the `pkill -f` pattern also
matched the shell running it twice, which is why the pattern changed to `[r]r-smoke`.

## 6.3 Experiments and the paper toolkit

Asked for next: results logged automatically where they are accessible, Drive by default, moved elsewhere on
request, with notes by the app's model or the signed-in coding agent; and a paper's reimplementation able to reach
the simulators through the agents. Built in this order:

1. The record (`src/lib/experiments.ts`) and the logbook's new field, the Worker's cleaning and ops, the store's
   ops and broadcast handling: pure first, with `scripts/experiments.test.mjs` pinning the digest (its own first
   numbers were wrong: the first tenth of 0, 2, 4… is 5), the caps, the Markdown, the Worker's refusals, and the
   room keeping and removing records. Two assertions in `project-room.test.mjs` compared an empty logbook's
   exact shape and gained `experiments: []`; nothing else in the suite changed.
2. The filing (`src/lib/experimentFiling.ts`): the whole `events.jsonl` read in pieces, media fetched within the
   caps and written as bytes (`writeBase64` added to the Jupyter and kernel hosts; Drive had it), the record kept
   and remembered; the notes through `streamModel`; moving between places.
3. The tab, the auto-filer with its toast, the Sim pane's filed line.
4. The catalogue as JSON on the machine and `koios_telemetry.py use` / `simulators`, tested against the page's
   own `envPy` byte for byte, and run for real: `use gymnasium CartPole-v1` on a bare folder, then the random agent
   on it.
5. End to end here, with a Jupyter server started in the container as "a computer of yours" and the harness
   calling the real `fileRun` on the finished LunarLander run: the files (events, five GIFs, report.md,
   report.json) landed under `experiments/…` on that server and the Experiments tab drew the record
   (`docs/experiments-tab.png`). Drive itself cannot be reached from here (no Google sign-in), so the Drive
   place is exercised only by the same code path's Jupyter twin; and no model key is available here, so the
   notes were not generated in this session.

## 6.4 The paper, in the folder

A screenshot after the merge showed Claude Code, on Colab, asked to implement a paper, fetching it from arXiv with
its web tool: the project had given it a title, an abstract and a plan, and nothing else of the paper. Asked why,
when the reader holds the PDF, the reflowed text, the Explain page and the plan — built in this order:

1. Where the full text comes from, read first: the Ask window's `fullText` is read off the page's DOM
   (`src/lib/screen.ts`), which exists only while the paper is on screen; the Playground has no such DOM. The
   reader's own reflow of the PDF (`loadPaperContentFromPdf`) and arXiv's HTML (`loadPaperContent`) both give
   HTML, so the folder's file is made by walking that HTML into Markdown (`src/lib/paperMarkdown.ts`) — the PDF
   first, as the reader itself prefers, arXiv's rendering when there is no PDF, the abstract alone when neither
   can be read, and the front matter says which.
2. The gathering and the writing (`src/lib/paperContext.ts`): one fetch of the PDF — Drive first, the proxy
   after, as the reader's own open does — serves both the text and `paper/paper.pdf`; the Explain page from the
   reader's cache or Drive through `loadExplanation`; written where missing or changed, with a report of what
   was written, kept and could not be had, and a line for the agent pane.
3. The briefings, one line in one place (`PAPER_FILES_NOTE`): the plan file, `AGENTS.md`, the Claude Code and
   Codex request and briefing, the agent by the files, and the page's own agent, which also gets the text in its
   request (`ProjectView.paper.fullText`, read from the folder's own file so the two never differ).
4. The workspace: the files put in place as a project with a cited paper opens, and awaited again before the
   agent's first request and before Claude Code or Codex write the project, so no agent starts without them.

What testing found: the first bundling of the prompt builder failed in Node — importing the gathering module
pulled pdf.js and its Vite `?worker&url` worker import into `projectAgent.ts`'s test bundle. The names moved to
a module of their own (`paperFiles.ts`) so the prompt builders import no reader machinery, and the test bundler
(`scripts/bundle.mjs`) learned to answer a `?worker&url` import with an empty address, which also lets the
gathering module load in Node with pdf.js external. The Markdown walk needs a DOM, so its test runs the bundled
module in Chromium through Playwright (skipped, not failed, on a machine with no Chromium); the writing is tested
against a folder in memory with the gathering stood in for — all written the first time, nothing fetched again
the second, the explanation rewritten only when it changed, a text-only folder told so. `scripts/paper-context.test.mjs`,
nine tests; the full suite otherwise unchanged.

## 6.5 The agent runs its commands; Claude Code's web tools off

Asked next: the agent redirected to the files (not just told), writing the code where it is and running it on the
connected machine or GPU through the editor's terminal. Three things, in order:

1. Claude Code's `--disallowedTools WebFetch WebSearch` whenever the project has the paper in its folder
   (`noWeb` in `runArgv`, pinned in `cli-agent.test.mjs`); Codex has no web search unless its command line asks,
   and the page never asks.
2. The page's own agent runs its commands. `askAgent` grew a `run` callback: when a reply holds ```` ```sh run ````
   blocks and the callback is there, the reply's files are written first, each command is run in the project's
   console through the workspace's own `run` (which pushes the folder when it is kept elsewhere, as for a typed
   command), the console entry's output is read back from the kernel state, clipped head and tail, and the loop goes
   round again with it — 3 commands a round, 6 rounds, then the rest are buttons as before. `Stop` interrupts the
   kernel; the saved job is let go of at the first command so a reload never re-runs one. The pane shows each run
   folded under its command with how it ended, and a **runs commands** tick (on by default, kept per browser).
3. The regime is told to the model in the request's `<where>` block, not the cached system prompt, so the cache
   holds across a change of tick.

Not verified here: a real model and machine running the loop end to end (no model key, no Colab in the container).
The pieces around it are pinned — the `<where>` wording, the output clipping, the argv — and the loop itself is the
reads loop with a second branch, typechecked. The first live run should ask for something small (a syntax error
planted in `main.py`, say) and watch the console and the pane.

## 6.6 Watching the agents, a Project for every implementation, and a sign-in that stays

Three asks at once, built in this order:

1. **Watching.** `CliAgent`'s poll already parsed each step; it now calls back on an edit event, and the
   workspace's `onAgentEdit` pulls the working copy home after 2.5 s (debounced, one at a time) and reloads the
   open files. No new parsing: the same events the pane draws.
2. **A Project for every implementation.** `useProjectForImplementation` (store-bound) around two pure helpers in
   `projects.ts` (`projectNameFor`, `projectQuestionFor`, pinned in `projects.test.mjs`): find the Project whose
   `playgroundId` is the playground's, else create a collection, make it a project with the paper as core and the
   playground as code, and add the paper to it. Called at both places a paper becomes a playground.
3. **A sign-in that stays** (`src/lib/googleStay.ts`). The desktop app's code flow brought to the page: the
   Worker's callback page now posts the code to its opener when it has one (the app's `reader-app://` link
   otherwise, unchanged), the page exchanges it at `/google/desktop/token` with PKCE and keeps the refresh token
   in `localStorage`; `tokenFor` and `renewQuietly` try the kept grant first, so a new tab signs in by itself and
   a token that ran out is renewed with no window; the renewal banner hides when `renewsItself()`; sign-out revokes
   through `/google/desktop/revoke`. The `/health` mapping had declared `googleDesktop` without reading it — fixed.
   `scripts/google-stay.test.mjs`: the grants kept and found, PKCE, the consent address, the renewal and the
   grant forgotten on `invalid_grant`, with `loadTogether` so the proxy address set reaches the module.

Not verified here: the popup against real Google (no sign-in in the container); the exchange and refresh calls are
the same the desktop app makes, tested in `google-desktop.test.mjs` against the Worker's handler.

## 6.7 The evaluation event

Asked for an evaluation event, with the caveat that papers evaluate their simulations differently. So the event is
open — any metrics, the protocol in words, the paper's numbers beside ours, which way is better — and the choice of
protocol is pushed to the agent reading the paper, with a stated default for when the paper gives none. Built in
this order: the Python (`Run.evaluation`, `Run.evaluate`, `read_run`, `summary`), the TypeScript parser and the
pure comparison (`evaluationRows`, `higherIsBetter`, `latestEvaluations`), the record (digest, Markdown table,
list line, the Worker's cleaning, with an empty or malformed list dropped rather than kept), the pane's table, the
five templates, the briefings, the schema row. Tests: the module writes one by hand and runs the default protocol
on a fake env (no Gymnasium needed) and the pane's parser reads both back, the summary prints them against the
paper; the comparison's signs and percentages; the record's table and the Worker's cleaning. Not run here: a real
policy evaluated on a real simulator (no simulator installed in the container); the template code paths are the
same calls, typechecked by Python's parser only.

## 6.8 Data on Drive, compute on Colab

Asked: Colab's disk is small; the data should be where the person chooses — Drive by default — whatever holds the
code. Read first: the reader's own rule against mounting Drive in a kernel, and the moves' way of letting a machine
reach Drive with a Worker-held token. Built on that: `koios_data.py` (a Drive client cut down from the mover's,
plus `path`, `fetch`, `save`, `sync`, `ls` and a local plan for the machine's disk), the Worker's `data` plan (one
line: a move that moves nothing), the page's `dataStore.ts` (the place, the link, the environment and the file
beside the module, the renewal), the workspace writing both before every command and agent, the panel's section,
the telemetry's self-sync and the checkpoint helper's copy, and the briefings. Tested without Drive: the local plan
end to end (path, save, sync, fetch, ls), a `Run` whose folder is synced to a local place and a checkpoint copied
there, the Worker's `data` plan starting and serving its token to the key, and the environment strings. Not run
here: Drive itself (no sign-in in the container) — the client is the mover's, which has run against Drive, with the
listing cached per folder and the MD5 check before an upload the only additions.

## 7. Checklist: before merging, or after changing any of it

```
npx tsc -b && npm run typecheck:vscode
node --test scripts/simulation.test.mjs scripts/experiments.test.mjs scripts/paper-context.test.mjs scripts/google-stay.test.mjs scripts/data-store.test.mjs scripts/moves.test.mjs   # python3 for some, Chromium for one
npm test                                         # expect only glass.test.mjs's 4 pre-existing failures
npx vite build --outDir /tmp/build && grep -l "koios_telemetry: what a simulation run" /tmp/build/assets/*.js
(cd companion && python -m unittest $(ls tests/test_*.py | sed 's#/#.#; s#\.py$##'))   # the Companion: 157 tests, its port proxy's included
```

And on a machine with Python (a venv is enough), the thing itself:

```
python -m venv v && . v/bin/activate && pip install "gymnasium[classic-control]" torch imageio imageio-ffmpeg
node -e "..."   # or: start a simulation project in the app, Gymnasium / CartPole-v1 / PPO, and copy its files out
python koios_telemetry.py doctor               # rendering, ffmpeg, the thread advice
python ppo.py --total-steps 100000             # expect the return to climb past 200
python koios_telemetry.py summary              # expect "Return is climbing"
```

On a GPU machine, additionally: Brax or MuJoCo Playground with `--train`, ManiSkill's starter, and Isaac Lab's
`train_isaaclab.sh` on an RTX card. None has run yet.

## 8. How to extend it

- **A simulator**: one entry in `SIMULATORS` (`src/lib/simulators.ts`): `module` must match the doctor's list in
  `koios_telemetry.py` (a test enforces it); for a Gymnasium one give `imports`/`make`, for a native one a
  `native` starter that imports `koios_telemetry` before the simulator (a test checks the order) and logs with
  `Run`. `caveats` for what will bite.
- **A template**: a file in `src/sim/templates/`, imported `?raw` in `simProject.ts`, an entry in `TEMPLATES`,
  and `templatesFor` deciding when it is offered. Keep its "what to watch" line in `WATCH` and its primer in
  `PRIMER`: they go into `README.md` and `LEARNING.md` of every project.
- **A finding**: add the rule to `diagnose` in both `koios_telemetry.py` and `simTelemetry.ts` with the same id,
  and a synthetic case to `CASES` in the test, which requires both to agree on it.
- **An event kind**: write it in `Run._event`, read it in `read_run` (Python) and `applyEvents` (TypeScript);
  bump `SCHEMA` only if an old reader would misread it.
