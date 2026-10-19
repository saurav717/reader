# Simulation: simulators, world models, and runs you can watch

The Playground can start a **simulation project**: any of 31 simulators, one of its environments, and a
starting point (a random agent, PPO, SAC, Stable-Baselines3, a world model from scratch, DreamerV3, TD-MPC2,
Isaac Lab). Every project writes its runs in one format, `koios_telemetry`, and the **Sim pane** beside the
editor draws them as they happen: episodes and returns, the numbers, the videos, a world model's dreams against
what really happened, the notes that the code and the coding agents leave on the timeline, and what looks wrong
with what to try. Coding agents (Claude Code, Codex, the page's own) are told to use the telemetry and to explain
each change in `LEARNING.md`, so the person can follow and learn.

![the picker on "Dexterous hands": six simulators with hands, Gymnasium-Robotics chosen, its Shadow-hand environments and the templates](sim-picker.png)

| A SAC run on InvertedPendulum | A world model's dream on the ball world |
|---|---|
| ![the Sim pane: finished, "Return is climbing", the return chart with its running mean, 23 videos, the losses](sim-pane.png) | ![the Sim pane on a world-model run: the data video, the dream, the error over the horizon rising after the 5 given frames, the error over training](sim-dream.png) |

This document records what was built, what was hard about it, and how each difficulty was handled.
[simulation-process.md](simulation-process.md) is the process: the order of work, every background run and its
result, the review against the existing code, and the checklist. It is a log
as much as a design. Each entry under [Challenges](#challenges-and-how-they-are-handled) says what is resolved,
what is worked around and what is still open.

---

## What is built

| Piece | Where | What it does |
|---|---|---|
| The telemetry module | `src/sim/koios_telemetry.py` | `Run`: episodes, numbers, videos, dreams, notes, checkpoints, heartbeats, crash capture. CLI: `doctor`, `summary`, `tail`, `note`, `bridge`. One file, no install. |
| The catalogue | `src/lib/simulators.ts` | 31 simulators in 8 families: install lines, GPU needs, Colab or not, example environments, a Gymnasium `env.py` or a native starter for each. |
| The templates | `src/sim/templates/*.py` | `random_agent.py`, `ppo.py`, `sac.py`, `sb3.py`, `world_model.py`: real files, run by hand on CartPole, InvertedPendulum and LunarLander (see [Verified](#verified)). |
| Project assembly | `src/lib/simProject.ts` | `env.py`, the template, `setup.sh`, `README.md`, `AGENTS.md` (+ `CLAUDE.md`), `LEARNING.md`, the telemetry module; DreamerV3, TD-MPC2 and Isaac Lab run scripts with their logs bridged. |
| The picker | `src/components/SimPicker.tsx` | **A simulation** on the Playground's home: filter by family, "Dexterous hands", "Runs on Colab", search; pick an environment and a template. |
| The Sim pane | `src/components/SimPane.tsx`, `src/lib/simTelemetry.ts` | The right-hand pane's **Sim** tab: run picker, status, findings, return and success charts, videos, dreams, grouped numbers with notes as dashed marks, timeline, traceback, config, checkpoints, and the machine's doctor. |
| Sync fix | `src/lib/playground.ts` (`isBinaryPath`) | The sync carries text; binary files (videos, images, weights) are now left where they are instead of being copied as broken text. |
| Tests | `scripts/simulation.test.mjs` | Catalogue integrity, every generated `.py` parses, parsing and diagnostics, and the Python module run for real: its events read by the pane's parser, its findings equal to the pane's. |

### The simulators

| Family | Simulators |
|---|---|
| Classic control | Gymnasium classic control, Box2D, gymnax (JAX) |
| Physics & locomotion | MuJoCo (Gymnasium), DeepMind Control Suite, MuJoCo Playground (MJX), Brax, PyBullet, Drake |
| Arms & hands | Gymnasium-Robotics (Shadow hand, Adroit, Fetch), MyoSuite, Meta-World, robosuite, ManiSkill 3, Genesis, Isaac Lab |
| Games & open worlds | Atari (ALE), MiniGrid, Crafter, Craftax, ViZDoom, NetHack (NLE), MineRL |
| Multi-agent | PettingZoo |
| Driving | highway-env, MetaDrive, CARLA |
| Engines & 3D worlds | Unity ML-Agents, Godot RL Agents, Habitat-Sim |
| Datasets | Minari (D4RL's successor) |

Dexterous hands specifically: the Shadow hand and Adroit (Gymnasium-Robotics), MyoSuite's musculoskeletal hand,
the LEAP hand (MuJoCo Playground), the D'Claw (ManiSkill), and the Allegro and Shadow hands in Isaac Lab.

### Templates, and what each teaches

| Template | For | What to watch |
|---|---|---|
| Random agent | every Gymnasium simulator | the floor: what chance scores; does it render here |
| PPO (one file) | discrete or continuous, flat or pixel observations | return; `approx_kl` < ~0.05; entropy falling slowly; `explained_var` → 1 |
| SAC (one file) | continuous control: arms, hands, MuJoCo | return after the random warm-up; `alpha` falling; `q_mean` against real returns |
| Stable-Baselines3 | a tested baseline; `MultiInputPolicy` for dict observations (goal-conditioned hands) | SB3's own names |
| World model from scratch | anything that renders, or a built-in ball world | `loss/recon`, `loss/dynamics`, the dream video and its error over the horizon |
| Starter (native) | simulators with their own API (JAX, engines, servers) | a first recorded rollout; Brax and MuJoCo Playground also train with `--train` |
| DreamerV3, TD-MPC2 | their repositories, as published (DMC, Atari, Crafter; DMC, Meta-World) | their metrics, bridged |
| Isaac Lab | RSL-RL PPO on an Isaac Lab task, headless | videos bridged; scalars in the TensorBoard pane |

---

## The telemetry format (schema 1)

A run is a folder, `runs/<name>-<YYYYmmdd-HHMMSS>/`:

- `run.json`: `{schema, id, name, sim, config, started, status, host, argv, pid}`, rewritten at the end with
  `status` (`finished` / `crashed` / `stopped`), `ended` and `error`.
- `events.jsonl`: one JSON object a line, appended and flushed as it happens. Every event has `kind` and `t`
  (machine seconds); most have `step` (**environment steps**, so runs compare).
- `media/`: MP4 (H.264, `yuv420p`, `faststart`), else GIF, else `.npz` frames.

| `kind` | Fields |
|---|---|
| `start` | `name`, `sim`, `config`, `host`, `resumed` |
| `scalars` | `step`, `values: {name: number}`; names group by their prefix (`loss/policy`) |
| `episode` | `step`, `index`, `return`, `length?`, `success?`, `extra?` |
| `media` | `step`, `name`, `path` (from the run's folder), `type` (`video`, `gif`, `image`, `frames`), `frames?`, `fps?`, `bytes`, `caption?` |
| `dream` | `step`, `name`, `path`, `type`, `error: [per-frame MSE]`, `context` (frames given, not predicted), `fps`, `horizon` |
| `note` | `step`, `text`, `by` (`code`, `agent`, `human`, `koios`), `tag?` (`problem`, `spaces`, `config`…) |
| `checkpoint` | `step`, `path`, `metrics` |
| `heartbeat` | every 10 s from a thread: `step`, `env_steps`, `sps` |
| `end` | `status`, `step`, `episodes`, `elapsed`, `error?` (the traceback) |

NaN and the infinities are written as the strings `"nan"`, `"inf"`, `"-inf"`: JSON has no NaN, and a NaN loss is
exactly what has to be seen.

---

## Challenges, and how they are handled

### 1. A browser can't reach the machine's ports, and Colab's least of all
*Resolved.* Nothing is served from the machine. The pane runs a few lines of Python in the runtime's small second
kernel (`runQuietly`, the same path the TensorBoard pane takes) that lists the runs and returns the focused run's
file **from the byte where the last read stopped**, ending on a whole line. A long run costs only its new lines;
a file longer than 6 MB is read from its last part on first sight (and the pane says so). Polls run every 3 s
while a run is live, every 15 s otherwise, and at once while there is more of the file to read.

### 2. The sync carries text up to 2 MB, and videos are binary
*Resolved, and a bug fixed on the way.* The sync read every file as text, so a `.png` brought back by the default
rules (`*.png` is one) arrived corrupted. Binary files are now left where they are (`isBinaryPath`), and the Sim
pane fetches media **from the machine, byte for byte, in 2 MB base64 chunks**, played from a blob (up to 64 MB a
file; past that it says where the file is). The fetch refuses any path outside the project's folder.

### 3. No display: simulators that open windows fail on Colab and servers
*Resolved, and verified.* `koios_telemetry` picks an off-screen renderer **at import**, before any simulator
loads: on Linux with no `DISPLAY`, `MUJOCO_GL=egl` when there is a GPU (an `nvidia-smi` or a `/dev/dri` render
node), else `osmesa`; pygame gets `SDL_VIDEODRIVER=dummy`. Choosing EGL merely because its library is present was
wrong: on a CPU container the library exists and fails (found while testing here). Every generated `env.py` and
starter imports the telemetry first, and a test checks that order. `run.grab(render, frames)` and `run.wrap` turn
a renderer that fails into one note on the timeline ("rendering failed, so no videos… run the doctor"), and the
run goes on training. The doctor renders a small MuJoCo scene in a subprocess to prove it works.

### 4. Which simulator runs where
*Resolved for what can be known in advance.* Each catalogue entry says `gpu: no | helps | needs | rtx`,
`colab`, `linux`, `video`. The picker shows it on each card and filters by "Runs on Colab"; the place step warns
when an RTX-only or GPU-only simulator is about to go to Colab (`placeWarning`). On the machine, `python
koios_telemetry.py doctor` (and the pane's "This machine" section) reports GPUs, EGL / OSMesa / Vulkan, ffmpeg,
Java, torch and JAX, and which of the 31 simulators import.

### 5. Isaac Lab needs an NVIDIA RTX GPU, never Colab
*Worked around.* It runs on a machine added as a Jupyter server (a lab box, a rented RTX GPU) through the existing
Companion / server path. Its own training script runs headless with `--video`; its videos are **bridged** into the
Sim pane as they are written and its scalars, which RSL-RL writes as TensorBoard files, show in the TensorBoard
pane. Isaac Sim's install (Python 3.11, NVIDIA's package index) is left to its guide, linked from the project:
pinning it here would go stale within a release. *Open:* starting and stopping rented GPUs from the page, which
the Playground's own design lists as not built.

### 6. Existing codebases log their own way
*Resolved for the common formats.* `python koios_telemetry.py bridge <metrics.jsonl | .csv | glob> [--videos DIR]
[--follow | --until-pid PID]` follows another codebase's log as it grows and writes a Koios run: step keys
(`step`, `global_step`, `_step`, `frame`…), episode keys (`episode/score`, `episode_reward`, `eval/episode_reward`…),
lengths and success; videos are copied in when they stop growing. DreamerV3 (`metrics.jsonl`), TD-MPC2
(`eval.csv`), SB3 (`progress.csv`) and Isaac Lab's video folders are covered; the run scripts start training,
bridge until its process ends, then close the run. *Open:* a bridge from W&B-only codebases (DIAMOND), which
would need W&B's offline files.

### 7. Torch on a small CPU can be a hundred times slower with more threads
*Found while testing, resolved.* SAC ran at ~3 steps a second here. Profiling showed every tiny layer taking
milliseconds; a benchmark gave **0.26 ms on one thread against 25 ms on four**, the thread pool fighting a
container's CPU quota. Colab's two-core CPUs see the same, more mildly. PPO and SAC now use one thread on the CPU
(`KOIOS_TORCH_THREADS` to change it); SAC then did 15,000 steps in 2 minutes and solved InvertedPendulum. The
doctor measures both on each machine and prints the `export` to use.

### 8. A shared actor-critic body stopped PPO from learning
*Found while testing, resolved.* The first PPO shared one MLP body between the policy and the critic. The value
loss (returns in the hundreds) dominated the gradient, the whole gradient was clipped to 0.5, and the policy's part
shrank to nothing: `approx_kl` ~1e-4, `clipfrac` 0, return flat. **The pane's own diagnostic said "Return isn't
improving"** on that run. Flat observations now get separate bodies, as CleanRL does (images keep one shared
CNN, as the Atari PPO does); CartPole then climbed from 22 to 262 mean return in 100k steps, best 500.

### 9. Colab sessions end
*Partly resolved by what exists.* The `koios` checkpoint helper (`.reader/pylib/koios`) saves on a cadence and on
SIGTERM, and the page offers to resume elsewhere. The telemetry records `checkpoint` events, writes a heartbeat
every 10 s, and a run that stops writing for two minutes shows as **stalled** with what to try. `Run(resume=dir)`
carries on writing to the same run. AGENTS.md tells agents to checkpoint and resume. *Open:* tying `Run(resume)`
to `KOIOS_RESUME` automatically.

### 10. Agents must keep the telemetry and explain themselves
*Resolved by the briefing, checked by the pane.* Every project's `AGENTS.md` (Codex reads it; `CLAUDE.md`
includes it for Claude Code) makes the telemetry a rule: one `Run`, episodes, environment steps on the x axis,
videos on a schedule, dreams for world models, **a note for every change with its reason** (`run.note(...)` or
`python koios_telemetry.py note runs/<run> "…" --by agent` from a terminal), `LEARNING.md` entries written for a
learner, and `python koios_telemetry.py summary` read before changing anything. Agent notes appear as dashed lines
on every chart, so "the return jumped here" sits next to "lr 3e-4 → 1e-4: approx_kl was 0.2".

### 11. Two implementations of the diagnostics
*Resolved by a test.* The findings exist in Python (for agents, in `summary`) and in TypeScript (for the pane).
`scripts/simulation.test.mjs` runs both on the same ten synthetic runs (improving, no learning, collapse, NaN,
entropy collapse, exploding value loss, crashed, stalled, world-model drift, world model not improving) and
requires the same findings. The rule ids match.

### 12. Long and noisy runs
*Resolved.* Scalars are thinned on arrival past 20,000 points a series and drawn downsampled; returns are drawn
with a running mean (window n/10, at least 5); videos are recorded one episode in `video_every`, capped at 600
frames and 256 px, so a run's media stays megabytes, not gigabytes.

### 13. Versions move
*Worked around.* Gymnasium ids change version (`-v4` to `-v5`); `env.py`'s `resolve()` takes the newest
registered version of the name asked for. `make_env` retries without a render mode for environments that don't
offer `rgb_array`. Simulators with fragile installs say so on their card (Box2D's swig, MineRL's JDK 8,
ML-Agents' Python 3.10, Habitat's conda).

### 14. Not every browser plays H.264
*Worked around.* Videos are MP4/H.264, which Chrome, Edge, Safari and Firefox play. Open-source Chromium builds
(the one Playwright drives, some Linux packages) ship without H.264: found when screenshotting the pane, where
the player loaded the video but stayed at 0:00. `KOIOS_VIDEO=gif` makes the module write GIFs instead, which every
browser plays, at a larger size.

---

## Verified

On this repository's Linux container (4 CPUs, no GPU), with `gymnasium 1.x`, `mujoco 3.x`, CPU torch:

- `ppo.py` on CartPole-v1, 100k steps: mean return 22 → 262, best 500, three videos; finding: *Return is climbing*.
- `sac.py` on InvertedPendulum-v5, 15k steps: 2 min 17 s, best return 1000, 23 videos.
- `sb3.py` (PPO) on LunarLander-v3, 20k steps: mean return −155 → −70, videos of the policy.
- `world_model.py` on CartPole and on the built-in ball world: reconstruction and dynamics losses logged, dream
  videos with per-frame error. On the ball world, after 600 iterations, the error stayed near 6e-3 for the five
  given frames and rose to 8e-3 by frame 45: compounding error, visible on the horizon chart.
- The Sim pane and the picker, rendered in Chromium against these runs (the kernel call replaced by a local
  Python): findings, charts, the video list, the dream view and the hands filter all drawn from the real files.
- MuJoCo off-screen rendering through OSMesa to H.264 MP4.
- The doctor, the summary, `note` and `bridge` from the CLI.

Not run here (no GPU, or a server to install): the JAX simulators, ManiSkill, Genesis, Isaac Lab, CARLA, Habitat,
MineRL, ML-Agents, Godot. Their starters follow each project's documented API and every generated file is
checked to parse; they are the first thing to try on a GPU machine.

## Next

- Compare runs: two or more runs' returns on one chart (before and after an agent's change).
- An "Ask the agent about this run" button that sends the summary and the findings to the agent pane.
- `Run(resume=…)` from `KOIOS_RESUME`, so a resumed run continues its own timeline.
- Rented GPUs started from the page (the Playground design's open item), for Isaac Lab and CARLA.
- A W&B offline bridge, for DIAMOND and other W&B-only codebases.
