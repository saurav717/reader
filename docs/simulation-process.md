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

## 7. Checklist: before merging, or after changing any of it

```
npx tsc -b && npm run typecheck:vscode
node --test scripts/simulation.test.mjs          # 32 tests; needs python3 for 14 of them
npm test                                         # expect only glass.test.mjs's 4 pre-existing failures
npx vite build --outDir /tmp/build && grep -l "koios_telemetry: what a simulation run" /tmp/build/assets/*.js
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
