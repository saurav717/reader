// ===========================================================================
//  A simulation project's first files: the simulator's env.py, the
//  template's script, the telemetry module, setup.sh, and the briefing the
//  coding agents read (AGENTS.md, and CLAUDE.md pointing at it) — which makes
//  the telemetry the rule rather than a suggestion, and asks them to explain
//  each change in LEARNING.md as they go. The Python is kept as real files
//  under src/sim/ (run by the tests) and taken in here as text.
// ===========================================================================

import TELEMETRY from '../sim/koios_telemetry.py?raw';
import RANDOM from '../sim/templates/random_agent.py?raw';
import PPO from '../sim/templates/ppo.py?raw';
import SAC from '../sim/templates/sac.py?raw';
import SB3 from '../sim/templates/sb3.py?raw';
import WORLD_MODEL from '../sim/templates/world_model.py?raw';
import type { SimEnv, Simulator, TemplateId } from './simulators';
import { TEMPLATES, catalogueJson, dreamerTask, envPy, nativeEnvPy, needsLine, tdmpcTask } from './simulators';

export { TELEMETRY as KOIOS_TELEMETRY_PY };

/** Where the telemetry module goes in a project, and on the machine's helper path (src/lib/koiosHelper.ts). */
export const TELEMETRY_FILE = 'koios_telemetry.py';
/** The catalogue beside it, which `koios_telemetry.py use` reads. */
export const CATALOGUE_FILE = 'koios_simulators.json';

/** The simulation toolkit any project can carry: the telemetry module and the catalogue, for `python koios_telemetry.py use <simulator>`. */
export const simulationToolkit = (): Record<string, string> => ({ [TELEMETRY_FILE]: TELEMETRY, [CATALOGUE_FILE]: catalogueJson() });

export interface SimProject {
  title: string;
  files: Record<string, string>;
  /** The command waiting in the console: the setup, then the first run. */
  pending: string;
  /** The notebook's first cells, as text. */
  cells: { type: 'markdown' | 'code'; source: string }[];
}

const SCRIPTS: Partial<Record<TemplateId, string>> = { random: RANDOM, ppo: PPO, sac: SAC, sb3: SB3, 'world-model': WORLD_MODEL };

const BASE_REQUIREMENTS = ['numpy', 'imageio', 'imageio-ffmpeg', 'pillow', 'rerun-sdk'];

/** setup.sh: the simulator's install lines, the template's packages, and the doctor at the end. */
export function setupSh(sim: Simulator, template: TemplateId): string {
  const extra = [...BASE_REQUIREMENTS, ...TEMPLATES[template].needs];
  if (sim.api === 'gymnasium' || template === 'world-model') extra.push('"gymnasium>=1.0"');
  return `#!/usr/bin/env bash
# What this project needs, installed on the machine it runs on. Run it once per machine (on Colab, once a session).
set -e
${sim.install.join('\n')}
pip install -q ${[...new Set(extra)].join(' ')}
# What the machine can do: GPUs, off-screen rendering, video encoding, which simulators import.
python koios_telemetry.py doctor
`;
}

const commandOf = (template: TemplateId) => {
  const file = TEMPLATES[template].file;
  return file.endsWith('.sh') ? `bash ${file}` : `python ${file}`;
};

function dreamerSh(sim: Simulator, env?: SimEnv): string {
  const task = dreamerTask(sim, env)!;
  return `#!/usr/bin/env bash
# DreamerV3 (Hafner et al., "Mastering Diverse Domains through World Models", 2023), run as its repository publishes
# it, with its metrics.jsonl bridged into the Koios Sim pane as it trains. Needs JAX on a GPU.
set -e
[ -d dreamerv3 ] || git clone --depth 1 https://github.com/danijar/dreamerv3.git
pip install -q -U -r dreamerv3/requirements.txt
LOGDIR="runs-dreamer/$(date +%Y%m%d-%H%M%S)"
python dreamerv3/dreamerv3/main.py --logdir "$LOGDIR" --configs ${task.configs} size12m --task ${task.task} "$@" &
TRAIN=$!
python koios_telemetry.py bridge "$LOGDIR/metrics.jsonl" --name dreamerv3 --sim "${sim.id}/${task.task}" --until-pid $TRAIN
wait $TRAIN
`;
}

function tdmpcSh(sim: Simulator, env?: SimEnv): string {
  const task = tdmpcTask(sim, env)!;
  return `#!/usr/bin/env bash
# TD-MPC2 (Hansen et al., "Scalable, Robust World Models for Continuous Control", 2024), run as its repository
# publishes it, with its eval.csv bridged into the Koios Sim pane. Its own setup is a conda file
# (tdmpc2/docker/environment.yaml); the pip line below covers the DMControl and Meta-World tasks.
set -e
[ -d tdmpc2 ] || git clone --depth 1 https://github.com/nicklashansen/tdmpc2.git
pip install -q torch tensordict torchrl hydra-core omegaconf termcolor pandas imageio imageio-ffmpeg h5py kornia dm_control gymnasium
cd tdmpc2/tdmpc2
python train.py task=${task} steps=\${STEPS:-1000000} model_size=\${SIZE:-5} enable_wandb=false save_csv=true save_video=false "$@" &
TRAIN=$!
cd ../..
python koios_telemetry.py bridge "tdmpc2/tdmpc2/logs/${task}/**/eval.csv" --name tdmpc2 --sim "${sim.id}/${task}" --until-pid $TRAIN
wait $TRAIN
`;
}

function isaacSh(env?: SimEnv): string {
  return `#!/usr/bin/env bash
# Isaac Lab: RSL-RL's PPO on a task, headless, recording videos. Needs Isaac Sim (an NVIDIA RTX GPU, Linux or
# Windows, Python 3.11) - see README.md. Its scalars are TensorBoard files under IsaacLab/logs (the TensorBoard pane
# draws them); its videos are bridged into the Sim pane as they are written.
set -e
[ -d IsaacLab ] || git clone --depth 1 https://github.com/isaac-sim/IsaacLab.git
TASK="\${TASK:-${env?.id ?? 'Isaac-Cartpole-v0'}}"
(cd IsaacLab && ./isaaclab.sh -p scripts/reinforcement_learning/rsl_rl/train.py --task "$TASK" --headless --video --video_interval 2000 "$@") &
TRAIN=$!
python koios_telemetry.py bridge "" --videos IsaacLab/logs/rsl_rl --name "isaaclab" --sim "isaaclab/$TASK" --until-pid $TRAIN
wait $TRAIN
`;
}

const WATCH: Record<TemplateId, string> = {
  random: 'the episode returns (the floor any learning must beat), the episode lengths, and the videos: is the world what you thought it was?',
  ppo: 'episode return climbing; loss/approx_kl under ~0.05; entropy falling slowly, not collapsing; explained_var rising towards 1.',
  sac: 'nothing for the first 5,000 steps (random play fills the buffer), then return climbing; alpha falling; q_mean near the real returns.',
  sb3: 'the same as PPO or SAC, under SB3’s own names (train/approx_kl, train/entropy_loss…).',
  'world-model': 'loss/recon falling (the frames survive the round trip); loss/dynamics falling; the dream video, and its error curve over the horizon.',
  native: 'the episode returns and the video of the first run: proof the simulator works here, before anything learns.',
  dreamerv3: 'episode returns from metrics.jsonl as Dreamer trains; its own losses (model, actor, critic) as the run’s numbers.',
  tdmpc2: 'the evaluation returns from eval.csv, every eval interval.',
  isaaclab: 'the videos as they are recorded, here; the rewards and losses in the TensorBoard pane.',
};

const PRIMER: Record<TemplateId, string> = {
  random: `## Where to start

An environment is a loop: it gives an **observation**, takes an **action**, and gives back a **reward** and the next
observation, until the episode ends (**terminated**: the task ended; **truncated**: time ran out). The **return** is
the sum of the rewards in an episode, and maximising it is the whole job of an RL agent. A random agent's return is
the baseline: anything that learns should beat it.`,
  ppo: `## PPO in a paragraph

PPO collects a batch of experience with the current policy, estimates how much better each action was than expected
(the **advantage**, with GAE), and nudges the policy towards the better actions, but only a little: the **clip**
stops any update from moving the policy far from the one that collected the data. A **critic** (value function)
learns to predict returns so the advantages are less noisy. Read ppo.py top to bottom: it is all there.`,
  sac: `## SAC in a paragraph

SAC learns two **Q-functions** (how good an action is in a state) from a **replay buffer** of past transitions, and a
**policy** that picks actions the Q-functions like while staying as random as possible: it maximises return plus
**entropy**. The temperature **alpha** sets that trade-off and tunes itself. Off-policy learning reuses every
transition many times, so SAC needs far fewer steps than PPO; that is why it is the default for robot arms and hands.`,
  sb3: `## Stable-Baselines3

A library of well-tested algorithms behind one call. Use it for a trustworthy baseline; when you want to know why
something happens, read the one-file versions (ppo.py, sac.py) where every line is in view.`,
  'world-model': `## World models in a paragraph

A world model learns to predict what the environment will do: from the current state and an action, the next state.
Here the state is a small latent vector **z** learned by a VAE from the frames, and a recurrent network predicts the
next z. An agent can then **imagine**: plan or learn inside the model instead of the simulator (Dreamer learns its
whole policy in imagination). The dream comparison shows how far the imagination can be trusted, and how quickly
errors **compound** when the model feeds on its own predictions.`,
  native: `## Where to start

This simulator has its own API rather than Gymnasium's. main.py runs it once and records what it sees. To learn on
it, either use its own training code (the README links it) or wrap it as a gymnasium.Env in env.py, after which
ppo.py, sac.py and world_model.py all work on it.`,
  dreamerv3: `## DreamerV3 in a paragraph

DreamerV3 learns a world model (a recurrent state-space model: deterministic memory plus stochastic latents) from
replayed experience, then trains an actor and a critic entirely on imagined rollouts inside it. Its tricks
(symlog predictions, free bits, return normalisation) let one set of hyperparameters work across Atari, DMC,
Crafter and Minecraft.`,
  tdmpc2: `## TD-MPC2 in a paragraph

TD-MPC2 learns a latent dynamics model without reconstructing pixels (only what predicts reward and value), and acts
by **planning**: at every step it searches action sequences in the latent model (MPPI) and executes the first
action. A learned Q-function scores what lies beyond the planning horizon.`,
  isaaclab: `## Isaac Lab in a paragraph

Isaac Lab runs thousands of copies of a robot task in parallel on the GPU in NVIDIA's Isaac Sim, and trains with
PPO (RSL-RL) for minutes to hours. Domain randomisation (masses, friction, delays) makes the policy robust enough to
move to a real robot.`,
};

function readme(title: string, sim: Simulator, env: SimEnv | undefined, template: TemplateId): string {
  const t = TEMPLATES[template];
  return `# ${title}

${sim.name}${env ? `, **${env.label}** (\`${env.id}\`)` : ''}, started from **${t.name}**: ${t.text}

${sim.blurb} ${sim.good}

- Runs on: ${needsLine(sim)}
- Docs: ${sim.docs}
${(sim.caveats ?? []).map((c) => `- Note: ${c}`).join('\n')}

## Run it

\`\`\`
bash setup.sh          # installs, then checks the machine (doctor)
${commandOf(template)}
\`\`\`

Open the **Sim** pane on the right: the run's episodes, numbers, videos, notes and what looks wrong appear there as
it goes. Watch ${WATCH[template]}

## Files

- \`env.py\`: the environment, made in one place (\`make_env\`)
- \`${t.file}\`: the ${t.name.toLowerCase()}
- \`koios_telemetry.py\`: what every run logs, and \`python koios_telemetry.py summary | doctor | tail | note | bridge\`;
  with rerun-sdk installed, a live 3D view of a MuJoCo scene in the Sim pane and \`runs/<run>/scene.rrd\`
- \`runs/<run>/\`: \`run.json\`, \`events.jsonl\` and \`media/\` for each run
- \`AGENTS.md\`: what a coding agent is told here; \`LEARNING.md\`: the notes it keeps for you
`;
}

function agents(title: string, sim: Simulator, env: SimEnv | undefined, template: TemplateId): string {
  return `# ${title}

A simulation project in Koios: ${sim.name}${env ? ` (${env.id})` : ''}, started from the ${TEMPLATES[template].name} template. The person
working here is learning: keep the code small and readable, explain what you do, and make every run visible.

## The simulator

${sim.blurb} ${sim.good} Docs: ${sim.docs}
Runs on: ${needsLine(sim)}.${(sim.caveats ?? []).map((c) => `\n- ${c}`).join('')}
Install with \`bash setup.sh\`. ${sim.api === 'gymnasium' ? 'The environment is made in one place, `make_env` in `env.py`; every script imports it from there.' : 'It has its own API: `main.py` shows it. Wrap it as a `gymnasium.Env` in `env.py` to use the Gymnasium templates.'}

## Telemetry is required

Every script that runs the simulator logs through \`koios_telemetry.Run\` (\`koios_telemetry.py\`, in this folder:
read it). The Koios Sim pane reads \`runs/*/events.jsonl\` on the machine and draws only that.

- One \`Run\` a process: \`run = Run(name, config=vars(args), sim=f"{SIM}/{ENV_ID}")\`. Import \`koios_telemetry\`
  before any simulator: it chooses the off-screen renderer (EGL or OSMesa) at import.
- Episodes: \`run.wrap(env)\` for one env, \`run.log_vector(infos, step)\` for vector envs with
  \`RecordEpisodeStatistics\`, or \`run.episode(return, length, step=..., success=...)\`.
- Numbers: \`run.log({...}, step=env_steps)\`. The step is **environment steps**, never updates, so runs compare.
  Group names with a slash: \`loss/policy\`, \`loss/value\`, \`eval/return\`.
- Videos: record one episode in \`video_every\` (render_mode="rgb_array"), \`run.video(name, frames, step)\`; never
  every episode. \`run.grab(env.render, frames)\` survives a machine that can't render.
- World models: \`run.dream(name, real_frames, imagined_frames, step, context=k)\` whenever open-loop prediction is
  evaluated, so the pane can show real against imagined and the error over the horizon.
- Every change you make to a run (a hyperparameter, the reward, the network, the algorithm) gets a note with the
  reason: \`run.note("lr 3e-4 -> 1e-4: approx_kl was 0.2", by="agent")\` in code, or from the terminal
  \`python koios_telemetry.py note runs/<run> "what and why" --by agent\`.
- Live 3D: with \`rerun-sdk\` installed (setup.sh does it) a run streams to a Rerun viewer the Sim pane embeds and
  writes \`scene.rrd\`; \`run.wrap(env)\` and \`run.scene(env)\` put a MuJoCo env's bodies in it, \`run.scene_step()\` moves
  them (PPO and SB3 call it each step). Log your own 3D through \`run._rr\` (the rerun module) under \`world/…\`.
- Evaluation, the way the paper does it: \`run.evaluation({metric: value, ...}, step=..., episodes=N, protocol="how it
  was measured", paper={metric: the paper's number, "source": "Table 2"})\` whenever the policy (or the model) is
  evaluated formally, apart from the training episodes. Papers evaluate differently — a mean return over N seeded
  episodes, a success rate, a normalised score, a prediction error — so read how the paper does it (its full text is in
  paper/paper.md when the project started from one) and measure that; keep the paper's reported numbers in
  \`paper_results.json\` and pass them as \`paper=\`. When the paper gives no protocol, \`run.evaluate(make_env, act,
  episodes=10)\` is the default (seeded episodes, deterministic actions, mean/std return, success rate, one video) and
  says so. The Sim pane and the logbook show ours against the paper's.
- \`run.finish()\` at the end; a crash is recorded by itself.
- Another codebase's logs: \`python koios_telemetry.py bridge <metrics.jsonl|.csv> --videos <dir> --follow\`.

## Before you change anything

Run \`python koios_telemetry.py summary\` and read it: each run's status, returns, last values, and the diagnostics
(no learning, collapse, NaN, entropy collapse, exploding value loss, world-model drift), each with what to try.
\`python koios_telemetry.py doctor\` says what this machine can simulate and whether it renders off-screen.

## Explain as you go

After each change, add an entry at the top of \`LEARNING.md\`: the date, what you changed, why, the idea behind it
in two or three plain sentences, and what to look for in the Sim pane to see whether it worked. Write for someone
learning RL and world models, not for a reviewer.

## The machine

Size runs for it: \`torch.cuda.is_available()\` (or JAX's devices) decides; on a CPU, use fewer envs and steps and
say so. Colab sessions end (idle stops, a 12-hour cap): save checkpoints on a cadence and resume from the latest
(\`import koios; ck = koios.checkpoint("checkpoints", every_minutes=10)\` is on the path in the Koios console).
Keep data and weights out of the synced files (\`data/\`, \`*.pt\`): the sync carries text up to 2 MB.
`;
}

function learning(template: TemplateId): string {
  return `# Learning notes

The coding agents add an entry at the top each time they change something: what, why, the idea behind it, and what
to look for in the Sim pane. Add your own questions here too; the agents read this file.

${PRIMER[template]}

## What to watch

${WATCH[template]}
`;
}

/** Every file of a new simulation project, and what waits in its console. */
export function simProject(sim: Simulator, env: SimEnv | undefined, template: TemplateId, title: string): SimProject {
  const envId = env?.id ?? sim.envs[0]?.id ?? '';
  const files: Record<string, string> = {
    'README.md': readme(title, sim, env, template),
    'AGENTS.md': agents(title, sim, env, template),
    'CLAUDE.md': '@AGENTS.md\n',
    'LEARNING.md': learning(template),
    'setup.sh': setupSh(sim, template),
    [TELEMETRY_FILE]: TELEMETRY,
    [CATALOGUE_FILE]: catalogueJson(),
    'env.py': sim.api === 'gymnasium' ? envPy(sim, envId) : nativeEnvPy(sim, envId),
  };
  if (sim.native && sim.api === 'native' && template !== 'isaaclab') files['main.py'] = sim.native.replace(/__ENV__/g, envId);
  const script = SCRIPTS[template];
  if (script) files[TEMPLATES[template].file] = script;
  if (template === 'dreamerv3') files[TEMPLATES.dreamerv3.file] = dreamerSh(sim, env);
  if (template === 'tdmpc2') files[TEMPLATES.tdmpc2.file] = tdmpcSh(sim, env);
  if (template === 'isaaclab') files[TEMPLATES.isaaclab.file] = isaacSh(env);
  const run = commandOf(template);
  return {
    title,
    files,
    pending: `bash setup.sh && ${run}`,
    // The console in Files runs in the project's folder; a notebook cell runs where the kernel started (Colab's
    // /content, a server's home), so the cells say to change into the folder first rather than assuming it.
    cells: [
      { type: 'markdown', source: `# ${title}\n\n${sim.name}${env ? ` · ${env.label}` : ''} · ${TEMPLATES[template].name}.\n\nThe project's files and its console are in **Files**, where \`bash setup.sh && ${run}\` waits for a click and runs in the project's folder; the **Sim** pane on the right draws the runs. To run the scripts from this notebook instead, change into the folder first: its path on the machine is shown over the console.` },
      { type: 'code', source: `# %cd <the project's folder on the machine, as shown over the console in Files>\n!bash setup.sh && ${run}` },
      { type: 'code', source: '!python koios_telemetry.py summary   # every run, digested, with what looks wrong and what to try' },
    ],
  };
}
