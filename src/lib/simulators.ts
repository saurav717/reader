// ===========================================================================
//  The simulators a playground can start from: what each is for, how it is
//  installed, where it can run (Colab, a CPU, any GPU, an RTX GPU only), a
//  few of its environments, and how a project for it is put together. Pure
//  data and string-making, for the tests; the picker is
//  src/components/SimPicker.tsx and the files are assembled in
//  src/lib/simProject.ts. docs/simulation.md says why each is here and what
//  is hard about running it from a browser.
//
//  Two kinds of simulator: those that speak Gymnasium's API (`api:
//  'gymnasium'`), which every template can drive through the project's
//  env.py, and those with an API of their own (`native`) — JAX-batched
//  ones, engines, servers — which start from a rollout written for them,
//  logging to the same telemetry.
// ===========================================================================

export type SimFamily = 'classic' | 'locomotion' | 'manipulation' | 'games' | 'multiagent' | 'driving' | 'embodied' | 'offline';

export const FAMILIES: { id: SimFamily; label: string; text: string }[] = [
  { id: 'classic', label: 'Classic control', text: 'Small, fast, CPU-only: where every algorithm is first checked.' },
  { id: 'locomotion', label: 'Physics & locomotion', text: 'Rigid-body physics: walkers, runners, quadrupeds, humanoids.' },
  { id: 'manipulation', label: 'Arms & hands', text: 'Robot arms, grippers and dexterous hands: reaching, picking, in-hand rotation.' },
  { id: 'games', label: 'Games & open worlds', text: 'Atari, procedural worlds, Doom, NetHack, Minecraft: pixels and long horizons.' },
  { id: 'multiagent', label: 'Multi-agent', text: 'Several agents in one world, cooperating or competing.' },
  { id: 'driving', label: 'Driving', text: 'Traffic, roads and cars, from 2D lanes to photorealistic towns.' },
  { id: 'embodied', label: 'Engines & 3D worlds', text: 'Game engines and indoor scenes: Unity, Godot, Habitat.' },
  { id: 'offline', label: 'Datasets', text: 'Recorded episodes to learn a world model or a policy from, without simulating.' },
];

/** What a simulator needs of the machine. `rtx`: an NVIDIA RTX-class GPU (Isaac Sim's ray tracing), never Colab. */
export type GpuNeed = 'no' | 'helps' | 'needs' | 'rtx';

export interface SimEnv {
  id: string;
  label: string;
  space: 'discrete' | 'continuous' | 'multi';
  /** Observations are images. */
  pixels?: boolean;
  /** A dexterous hand. */
  hand?: boolean;
}

export interface Simulator {
  id: string;
  name: string;
  family: SimFamily;
  /** One line: what it is. */
  blurb: string;
  /** What it is good for, and who uses it. */
  good: string;
  /** What to import to know it is installed: the doctor's list (src/sim/koios_telemetry.py, SIMULATORS) has the same. */
  module: string;
  /** Shell lines that install it, in order: setup.sh runs them. */
  install: string[];
  gpu: GpuNeed;
  /** Runs on a Colab runtime as it comes (with a GPU runtime when `gpu` is 'needs'). */
  colab: boolean;
  /** Linux only (or Linux and Windows): macOS is out. */
  linux?: boolean;
  /** Renders off-screen, so videos can be recorded on a machine with no display. */
  video: boolean;
  api: 'gymnasium' | 'native';
  /** Lines at the top of env.py before make_env: imports that register the environments. */
  imports?: string;
  /** The body of `_make(env_id, render_mode)` in env.py, indented four spaces; default gym.make. */
  make?: string;
  /** For `native`: the project's main.py, with __ENV__ for the environment's id. */
  native?: string;
  envs: SimEnv[];
  docs: string;
  /** What is hard about it, said before it bites. */
  caveats?: string[];
}

const GYM_MAKE = '    return gym.make(resolve(env_id), render_mode=render_mode)';

// --------------------------------------------------------- native mains ----

const PLAYGROUND_MAIN = String.raw`"""MuJoCo Playground: GPU-batched MuJoCo (MJX) environments, trained with Brax's PPO in minutes on one GPU.

    python main.py              # a random rollout, recorded: does it install, run and render here?
    python main.py --train      # PPO with the environment's own tuned settings, then the trained policy, recorded
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse
import functools

import jax
from mujoco_playground import registry, wrapper

ENV_ID = "__ENV__"


def rollout(env, policy, run, name, steps=500):
    reset, step = jax.jit(env.reset), jax.jit(env.step)
    key = jax.random.PRNGKey(0)
    state = reset(key)
    states, ret = [state], 0.0
    for _ in range(steps):
        key, sub = jax.random.split(key)
        state = step(state, policy(state.obs, sub))
        states.append(state)
        ret += float(state.reward)
        run.count()
        if bool(state.done):
            break
    run.episode(ret, len(states) - 1)
    frames = env.render(states[::2], height=240, width=320)
    run.video(name, frames, fps=1.0 / env.dt / 2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--train", action="store_true")
    p.add_argument("--steps", type=int, default=0, help="training steps; 0 keeps the tuned number")
    args = p.parse_args()
    run = Run("train" if args.train else "random", config={"env": ENV_ID, **vars(args)}, sim=f"mujoco_playground/{ENV_ID}")
    env = registry.load(ENV_ID)
    run.note(f"observation size {env.observation_size}, action size {env.action_size}, dt {env.dt}", step=0, tag="spaces")
    if not args.train:
        rollout(env, lambda obs, key: jax.random.uniform(key, (env.action_size,), minval=-1.0, maxval=1.0), run, "random")
        run.finish()
        return
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.training.agents.ppo import train as ppo
    from mujoco_playground.config import dm_control_suite_params, locomotion_params, manipulation_params

    if ENV_ID in registry.dm_control_suite.ALL_ENVS:
        params = dm_control_suite_params.brax_ppo_config(ENV_ID)
    elif ENV_ID in registry.locomotion.ALL_ENVS:
        params = locomotion_params.brax_ppo_config(ENV_ID)
    else:
        params = manipulation_params.brax_ppo_config(ENV_ID)
    params = dict(params)
    if args.steps:
        params["num_timesteps"] = args.steps
    run.note(f"PPO, tuned settings: {params}", step=0, tag="config")

    def progress(step, metrics):
        reward = metrics.get("eval/episode_reward")
        if reward is not None:
            run.episode(float(reward), step=int(step))
        run.log({k: float(v) for k, v in metrics.items() if k != "eval/episode_reward" and getattr(v, "ndim", 0) == 0}, step=int(step))

    # As the Playground's own notebooks do: the network's sizes come with the tuned settings.
    network = params.pop("network_factory", None)
    factory = functools.partial(ppo_networks.make_ppo_networks, **network) if network else ppo_networks.make_ppo_networks
    make_inference, policy_params, _ = ppo.train(environment=env, eval_env=registry.load(ENV_ID), wrap_env_fn=wrapper.wrap_for_brax_training, network_factory=factory, progress_fn=progress, **params)
    inference = jax.jit(make_inference(policy_params, deterministic=True))
    rollout(env, lambda obs, key: inference(obs, key)[0], run, "trained", steps=1000)
    run.finish()


if __name__ == "__main__":
    main()
`;

const BRAX_MAIN = String.raw`"""Brax: physics in JAX, thousands of environments at once on one accelerator, with PPO and SAC built in.

    python main.py              # a random rollout, recorded
    python main.py --train      # Brax's PPO, then the trained policy, recorded
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import jax
from brax import envs
from brax.io import image

ENV_ID = "__ENV__"


def rollout(env, policy, run, name, steps=300):
    reset, step = jax.jit(env.reset), jax.jit(env.step)
    key = jax.random.PRNGKey(0)
    state = reset(key)
    states, ret = [state.pipeline_state], 0.0
    for _ in range(steps):
        key, sub = jax.random.split(key)
        state = step(state, policy(state.obs, sub))
        states.append(state.pipeline_state)
        ret += float(state.reward)
        run.count()
        if bool(state.done):
            break
    run.episode(ret, len(states) - 1)
    run.video(name, image.render_array(env.sys, states[::2], 240, 320), fps=1.0 / env.dt / 2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--train", action="store_true")
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--backend", default="mjx", help="mjx, generalized, positional or spring")
    args = p.parse_args()
    run = Run("train" if args.train else "random", config={"env": ENV_ID, **vars(args)}, sim=f"brax/{ENV_ID}")
    env = envs.get_environment(ENV_ID, backend=args.backend)
    if not args.train:
        rollout(env, lambda obs, key: jax.random.uniform(key, (env.action_size,), minval=-1.0, maxval=1.0), run, "random")
        run.finish()
        return
    from brax.training.agents.ppo import train as ppo

    def progress(step, metrics):
        if "eval/episode_reward" in metrics:
            run.episode(float(metrics["eval/episode_reward"]), step=int(step))
        run.log({k: float(v) for k, v in metrics.items() if getattr(v, "ndim", 0) == 0 and k != "eval/episode_reward"}, step=int(step))

    make_inference, params, _ = ppo.train(environment=env, num_timesteps=args.steps, num_evals=20, episode_length=1000, normalize_observations=True, action_repeat=1, unroll_length=5, num_minibatches=32, num_updates_per_batch=4, discounting=0.97, learning_rate=3e-4, entropy_cost=1e-2, num_envs=2048, batch_size=1024, progress_fn=progress)
    inference = jax.jit(make_inference(params, deterministic=True))
    rollout(env, lambda obs, key: inference(obs, key)[0], run, "trained", steps=1000)
    run.finish()


if __name__ == "__main__":
    main()
`;

const ROBOSUITE_MAIN = String.raw`"""robosuite: robot arms on MuJoCo (Panda, Sawyer, UR5e…) and tasks for them: Lift, Stack, Door, NutAssembly.

    python main.py --episodes 3
For learning, robosuite.wrappers.GymWrapper turns an environment into a Gymnasium one that ppo.py-style code takes.
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import numpy as np
import robosuite as suite

ENV_ID = "__ENV__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=3)
    p.add_argument("--robot", default="Panda")
    args = p.parse_args()
    run = Run("random", config={"env": ENV_ID, **vars(args)}, sim=f"robosuite/{ENV_ID}", video_every=1)
    env = suite.make(ENV_ID, robots=args.robot, has_renderer=False, has_offscreen_renderer=True, use_camera_obs=False, control_freq=20, horizon=200)
    low, high = env.action_spec
    for _ in range(args.episodes):
        env.reset()
        frames, ret, t, done = [] if run.wants_video() else None, 0.0, 0, False
        while not done:
            _, reward, done, _ = env.step(np.random.uniform(low, high))
            ret, t = ret + reward, t + 1
            run.count()
            if frames is not None:
                run.grab(lambda: env.sim.render(width=256, height=256, camera_name="frontview")[::-1], frames)
        run.episode(ret, t, success=bool(env._check_success()))
        if frames:
            run.video("random", frames, fps=20)
    run.finish()


if __name__ == "__main__":
    main()
`;

const MANISKILL_MAIN = String.raw`"""ManiSkill 3: GPU-parallel manipulation on SAPIEN, thousands of scenes at once, with PPO and SAC baselines in its repo.

    python main.py --episodes 3
Its environments are Gymnasium ones, batched, with torch tensors in and out (num_envs > 1 for speed).
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import gymnasium as gym
import mani_skill.envs  # noqa: F401  (registers the environments)


ENV_ID = "__ENV__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=3)
    args = p.parse_args()
    run = Run("random", config={"env": ENV_ID, **vars(args)}, sim=f"maniskill/{ENV_ID}", video_every=1)
    env = gym.make(ENV_ID, num_envs=1, obs_mode="state", render_mode="rgb_array")
    for episode in range(args.episodes):
        env.reset(seed=episode)
        frames, ret, t, done, info = [], 0.0, 0, False, {}
        while not done:
            _, reward, terminated, truncated, info = env.step(env.action_space.sample())
            ret, t = ret + float(reward[0]), t + 1
            done = bool(terminated[0]) or bool(truncated[0])
            run.count()
            run.grab(lambda: env.render()[0].cpu().numpy(), frames)
        success = info.get("success")
        run.episode(ret, t, success=bool(success[0]) if success is not None else None)
        if frames:
            run.video("random", frames, fps=20)
    run.finish()


if __name__ == "__main__":
    main()
`;

const GENESIS_MAIN = String.raw`"""Genesis: a fast, Python-native physics platform (rigid bodies, soft bodies, fluids) for robotics.

    python main.py --gpu
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import genesis as gs
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--steps", type=int, default=300)
    args = p.parse_args()
    run = Run("franka-wiggle", config=vars(args), sim="genesis/__ENV__")
    gs.init(backend=gs.gpu if args.gpu else gs.cpu)
    scene = gs.Scene(show_viewer=False, sim_options=gs.options.SimOptions(dt=0.01))
    scene.add_entity(gs.morphs.Plane())
    robot = scene.add_entity(gs.morphs.MJCF(file="__ENV__"))
    camera = scene.add_camera(res=(320, 240), pos=(3.0, -1.0, 2.0), lookat=(0.0, 0.0, 0.5), fov=35, GUI=False)
    scene.build()
    dofs = robot.n_dofs
    frames = []
    for t in range(args.steps):
        target = 0.5 * np.sin(np.linspace(0, np.pi, dofs) + t / 30.0)
        robot.control_dofs_position(target)
        scene.step()
        run.count()
        if t % 2 == 0:
            run.grab(lambda: camera.render()[0], frames)
        if t % 25 == 0:
            run.log({"q/mean": float(np.mean(robot.get_dofs_position().cpu().numpy()))}, step=t)
    run.video("wiggle", frames, fps=50)
    run.finish()


if __name__ == "__main__":
    main()
`;

const PYBULLET_MAIN = String.raw`"""PyBullet: the Bullet physics engine from Python, on any CPU, with URDF robots from pybullet_data.

    python main.py --steps 400
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import numpy as np
import pybullet as p
import pybullet_data

URDF = "__ENV__"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=400)
    args = parser.parse_args()
    run = Run("random-joints", config=vars(args), sim=f"pybullet/{URDF}")
    p.connect(p.DIRECT)  # no window
    p.setAdditionalSearchPath(pybullet_data.getDataPath())
    p.setGravity(0, 0, -9.81)
    p.loadURDF("plane.urdf")
    robot = p.loadURDF(URDF, [0, 0, 0.5])
    joints = [j for j in range(p.getNumJoints(robot)) if p.getJointInfo(robot, j)[2] in (p.JOINT_REVOLUTE, p.JOINT_PRISMATIC)]
    run.note(f"{len(joints)} moving joints", step=0)
    view = p.computeViewMatrixFromYawPitchRoll([0, 0, 0.3], 2.0, 45, -30, 0, 2)
    proj = p.computeProjectionMatrixFOV(60, 1.0, 0.1, 20)
    frames = []
    for t in range(args.steps):
        if t % 50 == 0:
            targets = np.random.uniform(-1, 1, len(joints))
            p.setJointMotorControlArray(robot, joints, p.POSITION_CONTROL, targetPositions=targets)
        p.stepSimulation()
        run.count()
        if t % 4 == 0:
            run.grab(lambda: np.reshape(p.getCameraImage(256, 256, view, proj, renderer=p.ER_TINY_RENDERER)[2], (256, 256, 4))[..., :3], frames)
        if t % 20 == 0:
            pos, _ = p.getBasePositionAndOrientation(robot)
            run.log({"base/x": pos[0], "base/y": pos[1], "base/z": pos[2]}, step=t)
    run.video("random-joints", frames, fps=60)
    run.finish()


if __name__ == "__main__":
    main()
`;

const DRAKE_MAIN = String.raw`"""Drake: model-based design and verification for robotics (MIT/TRI): multibody dynamics, optimisation, control.

    python main.py
A pendulum simulated and logged; Drake's strength is its models and optimisers, which an agent can build on here.
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import numpy as np
from pydrake.all import DiagramBuilder, Simulator
from pydrake.examples import PendulumPlant


def main():
    run = Run("pendulum", sim="drake/__ENV__")
    builder = DiagramBuilder()
    plant = builder.AddSystem(PendulumPlant())
    diagram = builder.Build()
    simulator = Simulator(diagram)
    context = simulator.get_mutable_context()
    plant_context = plant.GetMyMutableContextFromRoot(context)
    plant.get_input_port().FixValue(plant_context, [0.0])
    plant_context.get_mutable_continuous_state_vector().SetFromVector([1.0, 0.0])
    for i in range(200):
        simulator.AdvanceTo(i * 0.02)
        theta, thetadot = plant_context.get_continuous_state_vector().CopyToVector()
        run.log({"theta": float(theta), "thetadot": float(thetadot), "energy": float(0.5 * thetadot ** 2 - 9.81 * np.cos(theta))}, step=i)
    run.finish()


if __name__ == "__main__":
    main()
`;

const CRAFTER_MAIN = String.raw`"""Crafter: a 2D Minecraft-like world with 22 achievements, made to test general abilities (Hafner, 2021).

    python main.py --episodes 3
The observation is the 64x64 image itself; achievements are logged as the run's numbers.
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import crafter
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=3)
    args = p.parse_args()
    run = Run("random", config=vars(args), sim="crafter/__ENV__", video_every=1)
    env = crafter.Env(seed=0)
    actions = len(crafter.constants.actions)
    for _ in range(args.episodes):
        obs = env.reset()
        frames, ret, t, done, info = [obs], 0.0, 0, False, {}
        while not done:
            obs, reward, done, info = env.step(np.random.randint(actions))
            ret, t = ret + reward, t + 1
            run.count()
            if len(frames) < 600:
                frames.append(obs)
        run.episode(ret, t)
        run.log({f"achievement/{k}": v for k, v in info.get("achievements", {}).items()})
        if run.episodes == 1 or run.wants_video(run.episodes - 1):
            run.video("random", frames, fps=15)
    run.finish()


if __name__ == "__main__":
    main()
`;

const CRAFTAX_MAIN = String.raw`"""Craftax: Crafter (and a much harder NetHack-like extension) rewritten in JAX, a billion steps an hour on one GPU.

    python main.py --steps 2000
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import jax
import numpy as np
from craftax.craftax_env import make_craftax_env_from_name


ENV_ID = "__ENV__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=2000)
    args = p.parse_args()
    run = Run("random", config={"env": ENV_ID, **vars(args)}, sim=f"craftax/{ENV_ID}")
    env = make_craftax_env_from_name(ENV_ID, auto_reset=True)
    params = env.default_params
    key = jax.random.PRNGKey(0)
    key, sub = jax.random.split(key)
    obs, state = env.reset(sub, params)
    step = jax.jit(env.step)
    ret, t, frames = 0.0, 0, []
    for i in range(args.steps):
        key, k1, k2 = jax.random.split(key, 3)
        obs, state, reward, done, _ = step(k2, state, env.action_space(params).sample(k1), params)
        ret, t = ret + float(reward), t + 1
        run.count()
        if np.ndim(obs) == 3 and len(frames) < 400:
            frames.append(np.asarray(obs))
        if bool(done):
            run.episode(ret, t, step=i)
            ret, t = 0.0, 0
    if frames:
        run.video("random", frames, fps=10)
    run.finish()


if __name__ == "__main__":
    main()
`;

const GYMNAX_MAIN = String.raw`"""gymnax: classic control and MinAtar in JAX, so whole training runs jit-compile and run thousands of envs at once.

    python main.py --steps 5000
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

import gymnax
import jax

ENV_ID = "__ENV__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=5000)
    args = p.parse_args()
    run = Run("random", config={"env": ENV_ID, **vars(args)}, sim=f"gymnax/{ENV_ID}")
    env, params = gymnax.make(ENV_ID)
    key = jax.random.PRNGKey(0)
    key, sub = jax.random.split(key)
    obs, state = env.reset(sub, params)
    step = jax.jit(env.step)
    ret, t = 0.0, 0
    for i in range(args.steps):
        key, k1, k2 = jax.random.split(key, 3)
        obs, state, reward, done, _ = step(k2, state, env.action_space(params).sample(k1), params)
        ret, t = ret + float(reward), t + 1
        run.count()
        if bool(done):
            run.episode(ret, t, step=i)
            ret, t = 0.0, 0
    run.finish()


if __name__ == "__main__":
    main()
`;

const MINERL_MAIN = String.raw`"""MineRL: Minecraft as an environment, with human demonstrations (BASALT tasks). Needs Java 8 (a JDK) and the old
OpenAI gym API; a first start compiles Minecraft, which takes a while.

    python main.py
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import gym
import minerl  # noqa: F401  (registers the environments)


def main():
    run = Run("walk", sim="minerl/__ENV__", video_every=1)
    env = gym.make("__ENV__")
    obs = env.reset()
    frames, ret, t, done = [obs["pov"]], 0.0, 0, False
    while not done and t < 600:
        action = env.action_space.noop()
        action["forward"], action["jump"], action["camera"] = 1, int(t % 20 == 0), [0, 2]
        obs, reward, done, _ = env.step(action)
        frames.append(obs["pov"])
        ret, t = ret + reward, t + 1
        run.count()
    run.episode(ret, t)
    run.video("walk", frames, fps=20)
    env.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const MLAGENTS_MAIN = String.raw`"""Unity ML-Agents: environments built in the Unity engine. The registry downloads prebuilt examples (Linux, macOS);
your own Unity build is a file_name away. ML-Agents' Python package pins Python 3.10.

    python main.py --episodes 5
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

from mlagents_envs.registry import default_registry


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=5)
    args = p.parse_args()
    run = Run("random", config=vars(args), sim="mlagents/__ENV__")
    env = default_registry["__ENV__"].make(no_graphics=True)
    env.reset()
    behavior = list(env.behavior_specs)[0]
    spec = env.behavior_specs[behavior]
    run.note(f"behavior {behavior}: observations {[o.shape for o in spec.observation_specs]}, actions {spec.action_spec}", step=0)
    returns = {}
    while run.episodes < args.episodes:
        decision, terminal = env.get_steps(behavior)
        for agent in terminal.agent_id:
            run.episode(returns.pop(agent, 0.0) + float(terminal[agent].reward))
        for agent in decision.agent_id:
            returns[agent] = returns.get(agent, 0.0) + float(decision[agent].reward)
        env.set_actions(behavior, spec.action_spec.random_action(len(decision)))
        env.step()
        run.count(len(decision))
    env.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const GODOT_MAIN = String.raw`"""Godot RL Agents: environments made in the Godot engine, trained from Python. Download an example game first:

    gdrl.env_from_hub -r edbeeching/godot_rl___ENV__
    python main.py --env-path examples/godot_rl___ENV__/bin/__ENV__.x86_64
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env.vec_monitor import VecMonitor
from godot_rl.wrappers.stable_baselines_wrapper import StableBaselinesGodotEnv


class Koios(BaseCallback):
    def __init__(self, run):
        super().__init__()
        self.run = run

    def _on_step(self):
        for info in self.locals.get("infos", []):
            if "episode" in info:
                self.run.episode(info["episode"]["r"], info["episode"]["l"], step=self.num_timesteps)
        return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--env-path", required=True)
    p.add_argument("--steps", type=int, default=200_000)
    args = p.parse_args()
    run = Run("ppo", config=vars(args), sim="godot_rl/__ENV__")
    env = VecMonitor(StableBaselinesGodotEnv(env_path=args.env_path, show_window=False, speedup=8))
    model = PPO("MultiInputPolicy", env, verbose=0)
    model.learn(args.steps, callback=Koios(run))
    env.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const PETTINGZOO_MAIN = String.raw`"""PettingZoo: the Gymnasium of multi-agent RL, here with its parallel API: every agent acts at once.

    python main.py --episodes 3
For training: SuperSuit's wrappers turn a parallel env into a vector env that SB3 or CleanRL's PPO learns from.
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse
import importlib

ENV_ID = "__ENV__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=3)
    args = p.parse_args()
    run = Run("random", config={"env": ENV_ID, **vars(args)}, sim=f"pettingzoo/{ENV_ID}", video_every=1)
    env = importlib.import_module(f"pettingzoo.{ENV_ID}").parallel_env(render_mode="rgb_array")
    for episode in range(args.episodes):
        env.reset(seed=episode)
        returns, frames, t = {a: 0.0 for a in env.agents}, [], 0
        while env.agents:
            actions = {a: env.action_space(a).sample() for a in env.agents}
            _, rewards, _, _, _ = env.step(actions)
            for agent, reward in rewards.items():
                returns[agent] = returns.get(agent, 0.0) + reward
            t += 1
            run.count(len(actions))
            if t % 2 == 0:
                run.grab(env.render, frames)
        run.episode(sum(returns.values()), t)
        run.log({f"return/{a}": r for a, r in list(returns.items())[:12]})
        if frames:
            run.video("random", frames, fps=15)
    env.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const METADRIVE_MAIN = String.raw`"""MetaDrive: a light driving simulator with procedurally generated roads and traffic, for generalisation research.

    python main.py --episodes 3
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse

from metadrive.envs import MetaDriveEnv


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=3)
    args = p.parse_args()
    run = Run("random", config=vars(args), sim="metadrive/__ENV__", video_every=1)
    env = MetaDriveEnv(dict(num_scenarios=10, start_seed=0, use_render=False, traffic_density=0.1))
    for episode in range(args.episodes):
        env.reset(seed=episode)
        frames, ret, t, done, info = [], 0.0, 0, False, {}
        while not done:
            _, reward, terminated, truncated, info = env.step(env.action_space.sample())
            ret, t, done = ret + reward, t + 1, terminated or truncated
            run.count()
            run.grab(lambda: env.render(mode="topdown", window=False, screen_size=(300, 300)), frames)
        run.episode(ret, t, success=info.get("arrive_dest"))
        if frames:
            run.video("random", frames, fps=20)
    env.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const CARLA_MAIN = String.raw`"""CARLA: a photorealistic urban driving simulator on Unreal Engine. It is a server: start it first, on a GPU machine
(docker run --gpus all --net=host carlasim/carla:0.9.15 ./CarlaUE4.sh -RenderOffScreen), then this client.

    python main.py --seconds 30
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import argparse
import queue

import numpy as np
import carla


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="localhost")
    p.add_argument("--seconds", type=float, default=30)
    args = p.parse_args()
    run = Run("autopilot", config=vars(args), sim="carla/__ENV__")
    client = carla.Client(args.host, 2000)
    client.set_timeout(20.0)
    world = client.load_world("__ENV__")
    settings = world.get_settings()
    settings.synchronous_mode, settings.fixed_delta_seconds = True, 0.05
    world.apply_settings(settings)
    client.get_trafficmanager().set_synchronous_mode(True)
    library = world.get_blueprint_library()
    car = world.spawn_actor(library.filter("vehicle.*model3*")[0], world.get_map().get_spawn_points()[0])
    car.set_autopilot(True)
    camera_bp = library.find("sensor.camera.rgb")
    camera_bp.set_attribute("image_size_x", "320")
    camera_bp.set_attribute("image_size_y", "240")
    camera = world.spawn_actor(camera_bp, carla.Transform(carla.Location(x=-6, z=3), carla.Rotation(pitch=-15)), attach_to=car)
    images = queue.Queue()
    camera.listen(images.put)
    frames = []
    try:
        for t in range(int(args.seconds / 0.05)):
            world.tick()
            image = images.get(timeout=5)
            if t % 2 == 0:
                frames.append(np.frombuffer(image.raw_data, np.uint8).reshape(240, 320, 4)[..., 2::-1])
            v = car.get_velocity()
            run.log({"speed_kmh": 3.6 * float(np.linalg.norm([v.x, v.y, v.z]))}, step=t)
    finally:
        camera.destroy()
        car.destroy()
        settings.synchronous_mode = False
        world.apply_settings(settings)
    run.video("autopilot", frames, fps=10)
    run.finish()


if __name__ == "__main__":
    main()
`;

const HABITAT_MAIN = String.raw`"""Habitat-Sim: fast photorealistic 3D indoor scenes for embodied AI (navigation, rearrangement). Get the test scenes:

    python -m habitat_sim.utils.datasets_download --uids habitat_test_scenes --data-path data/
    python main.py
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import habitat_sim
import numpy as np

SCENE = "data/scene_datasets/habitat-test-scenes/__ENV__.glb"


def main():
    run = Run("walk", sim="habitat/__ENV__")
    backend = habitat_sim.SimulatorConfiguration()
    backend.scene_id = SCENE
    rgb = habitat_sim.CameraSensorSpec()
    rgb.uuid, rgb.sensor_type, rgb.resolution = "rgb", habitat_sim.SensorType.COLOR, [240, 320]
    agent = habitat_sim.agent.AgentConfiguration(sensor_specifications=[rgb])
    sim = habitat_sim.Simulator(habitat_sim.Configuration(backend, [agent]))
    frames = []
    for t in range(200):
        action = np.random.choice(["move_forward", "move_forward", "turn_left", "turn_right"])
        obs = sim.step(action)
        frames.append(obs["rgb"][..., :3])
        position = sim.get_agent(0).get_state().position
        run.log({"x": float(position[0]), "z": float(position[2])}, step=t)
    run.video("walk", frames, fps=10)
    sim.close()
    run.finish()


if __name__ == "__main__":
    main()
`;

const MINARI_MAIN = String.raw`"""Minari: datasets of recorded episodes (the successor of D4RL), for offline RL and for learning world models
without running a simulator. This reads a dataset, logs its episodes and replays one in the environment it came from.

    python main.py
"""
from koios_telemetry import Run  # first: it picks an off-screen renderer before a simulator loads

import minari
import numpy as np

DATASET = "__ENV__"


def main():
    run = Run("dataset", sim=f"minari/{DATASET}", video_every=0)
    data = minari.load_dataset(DATASET, download=True)
    run.note(f"{data.total_episodes} episodes, {data.total_steps} steps; observations {data.observation_space}, actions {data.action_space}", step=0, tag="data")
    first = None
    for i, episode in enumerate(data.iterate_episodes()):
        first = first or episode
        run.episode(float(np.sum(episode.rewards)), len(episode.rewards), step=i)
    try:
        env = data.recover_environment(render_mode="rgb_array")
        env.reset(seed=int(first.id) if first is not None else 0)
        frames = []
        for action in first.actions[:400]:
            env.step(action)
            run.grab(env.render, frames)
        if frames:
            run.video("replay", frames, fps=30, caption="the first episode's actions, replayed (from a fresh reset, so it can drift)")
    except Exception as error:
        run.note(f"no replay: {error}", tag="problem")
    run.finish()


if __name__ == "__main__":
    main()
`;

// ------------------------------------------------------------ catalogue ----

export const SIMULATORS: Simulator[] = [
  {
    id: 'gymnasium',
    name: 'Gymnasium classic control',
    family: 'classic',
    blurb: 'CartPole, Acrobot, MountainCar, Pendulum: the standard API and its smallest worlds.',
    good: 'Checking that an algorithm learns at all, in seconds, on any CPU. Every other simulator here is measured against its API.',
    module: 'gymnasium',
    install: ['pip install "gymnasium[classic-control]>=1.0"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    envs: [
      { id: 'CartPole-v1', label: 'CartPole: balance a pole', space: 'discrete' },
      { id: 'Acrobot-v1', label: 'Acrobot: swing up a double pendulum', space: 'discrete' },
      { id: 'MountainCar-v0', label: 'MountainCar: build momentum (sparse reward)', space: 'discrete' },
      { id: 'Pendulum-v1', label: 'Pendulum: swing up and hold', space: 'continuous' },
      { id: 'MountainCarContinuous-v0', label: 'MountainCar, continuous', space: 'continuous' },
    ],
    docs: 'https://gymnasium.farama.org/environments/classic_control/',
  },
  {
    id: 'box2d',
    name: 'Box2D',
    family: 'classic',
    blurb: 'LunarLander, BipedalWalker and CarRacing on the Box2D 2D physics engine.',
    good: 'The next step up from classic control: contact physics, a walker, and CarRacing for learning from pixels.',
    module: 'Box2D',
    install: ['pip install swig', 'pip install "gymnasium[box2d]>=1.0"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    envs: [
      { id: 'LunarLander-v3', label: 'LunarLander: land between the flags', space: 'discrete' },
      { id: 'BipedalWalker-v3', label: 'BipedalWalker: walk over rough ground', space: 'continuous' },
      { id: 'CarRacing-v3', label: 'CarRacing: drive a track from pixels', space: 'continuous', pixels: true },
    ],
    docs: 'https://gymnasium.farama.org/environments/box2d/',
    caveats: ['Box2D builds from source on some platforms: swig is installed first for that.'],
  },
  {
    id: 'mujoco',
    name: 'MuJoCo (Gymnasium)',
    family: 'locomotion',
    blurb: 'Hopper, HalfCheetah, Ant, Humanoid: the continuous-control benchmarks of most RL papers.',
    good: 'Comparing against published numbers for PPO, SAC, TD3. MuJoCo is the physics engine most robot learning uses.',
    module: 'mujoco',
    install: ['pip install "gymnasium[mujoco]>=1.0"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    envs: [
      { id: 'HalfCheetah-v5', label: 'HalfCheetah: run forward', space: 'continuous' },
      { id: 'Hopper-v5', label: 'Hopper: hop without falling', space: 'continuous' },
      { id: 'Walker2d-v5', label: 'Walker2d: walk on two legs', space: 'continuous' },
      { id: 'Ant-v5', label: 'Ant: a quadruped', space: 'continuous' },
      { id: 'Humanoid-v5', label: 'Humanoid: the hard one', space: 'continuous' },
      { id: 'InvertedPendulum-v5', label: 'InvertedPendulum: a quick check', space: 'continuous' },
    ],
    docs: 'https://gymnasium.farama.org/environments/mujoco/',
    caveats: ['Videos need an off-screen OpenGL: EGL on a GPU, OSMesa on a CPU. koios_telemetry picks one; the doctor checks it renders.'],
  },
  {
    id: 'dm_control',
    name: 'DeepMind Control Suite',
    family: 'locomotion',
    blurb: 'cartpole-swingup, walker-walk, cheetah-run, finger-spin…: DeepMind’s MuJoCo tasks, through Shimmy.',
    good: 'The benchmark of the world-model papers (Dreamer, TD-MPC2, PlaNet), from states or from pixels.',
    module: 'dm_control',
    install: ['pip install "gymnasium>=1.0" dm_control "shimmy[dm-control]"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import shimmy\n\ngym.register_envs(shimmy)',
    make: '    env = gym.make(resolve(f"dm_control/{env_id}-v0"), render_mode=render_mode)\n    return gym.wrappers.FlattenObservation(env)',
    envs: [
      { id: 'cartpole-swingup', label: 'cartpole-swingup', space: 'continuous' },
      { id: 'walker-walk', label: 'walker-walk', space: 'continuous' },
      { id: 'cheetah-run', label: 'cheetah-run', space: 'continuous' },
      { id: 'finger-spin', label: 'finger-spin', space: 'continuous' },
      { id: 'reacher-easy', label: 'reacher-easy', space: 'continuous' },
      { id: 'humanoid-walk', label: 'humanoid-walk', space: 'continuous' },
    ],
    docs: 'https://github.com/google-deepmind/dm_control',
  },
  {
    id: 'mujoco_playground',
    name: 'MuJoCo Playground (MJX)',
    family: 'locomotion',
    blurb: 'GPU-batched MuJoCo: the DM Control tasks, Go1/Berkeley Humanoid locomotion, LEAP hand, Panda, trained in minutes.',
    good: 'Sim-to-real robot learning at scale on one GPU: thousands of environments at once, policies trained in minutes.',
    module: 'mujoco_playground',
    install: ['pip install -U "jax[cuda12]"', 'pip install playground'],
    gpu: 'needs',
    colab: true,
    linux: true,
    video: true,
    api: 'native',
    native: PLAYGROUND_MAIN,
    envs: [
      { id: 'CartpoleBalance', label: 'CartpoleBalance', space: 'continuous' },
      { id: 'CheetahRun', label: 'CheetahRun', space: 'continuous' },
      { id: 'Go1JoystickFlatTerrain', label: 'Go1 quadruped, following a joystick', space: 'continuous' },
      { id: 'LeapCubeReorient', label: 'LEAP hand: turn a cube in the hand', space: 'continuous', hand: true },
      { id: 'PandaPickCube', label: 'Panda arm: pick up a cube', space: 'continuous' },
    ],
    docs: 'https://playground.mujoco.org',
    caveats: ['JAX on a GPU (a Colab GPU runtime works); on a CPU it runs, slowly.', 'The first step compiles for a minute or more: that is XLA, not a hang.'],
  },
  {
    id: 'brax',
    name: 'Brax',
    family: 'locomotion',
    blurb: 'Physics in JAX: ant, humanoid, halfcheetah… thousands at once, with PPO and SAC built in.',
    good: 'Fast iteration on locomotion: whole training runs compile to the accelerator.',
    module: 'brax',
    install: ['pip install -U "jax[cuda12]"', 'pip install brax'],
    gpu: 'needs',
    colab: true,
    linux: true,
    video: true,
    api: 'native',
    native: BRAX_MAIN,
    envs: [
      { id: 'ant', label: 'ant', space: 'continuous' },
      { id: 'halfcheetah', label: 'halfcheetah', space: 'continuous' },
      { id: 'humanoid', label: 'humanoid', space: 'continuous' },
      { id: 'hopper', label: 'hopper', space: 'continuous' },
      { id: 'reacher', label: 'reacher', space: 'continuous' },
    ],
    docs: 'https://github.com/google/brax',
  },
  {
    id: 'gymnasium_robotics',
    name: 'Gymnasium-Robotics',
    family: 'manipulation',
    blurb: 'Fetch arm, Shadow Dexterous Hand, Adroit hand and AntMaze, goal-conditioned on MuJoCo.',
    good: 'Dexterous in-hand manipulation (the Shadow hand tasks) and goal-conditioned RL with sparse rewards (HER).',
    module: 'gymnasium_robotics',
    install: ['pip install "gymnasium>=1.0" gymnasium-robotics'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import gymnasium_robotics\n\ngym.register_envs(gymnasium_robotics)',
    envs: [
      { id: 'HandManipulateBlock-v1', label: 'Shadow hand: rotate a block', space: 'continuous', hand: true },
      { id: 'HandManipulateEgg-v1', label: 'Shadow hand: rotate an egg', space: 'continuous', hand: true },
      { id: 'HandReach-v2', label: 'Shadow hand: reach with the fingertips', space: 'continuous', hand: true },
      { id: 'AdroitHandDoor-v1', label: 'Adroit hand: open a door', space: 'continuous', hand: true },
      { id: 'FetchReach-v4', label: 'Fetch: reach a point', space: 'continuous' },
      { id: 'FetchPickAndPlace-v4', label: 'Fetch: pick and place', space: 'continuous' },
    ],
    docs: 'https://robotics.farama.org',
    caveats: ['Rewards are sparse (success or not): plain PPO rarely learns them; SAC with HER (SB3) does.'],
  },
  {
    id: 'myosuite',
    name: 'MyoSuite',
    family: 'manipulation',
    blurb: 'Musculoskeletal models: a human hand and arm driven by muscles, not motors.',
    good: 'Neuromechanical control: dexterity as a body does it, with 39 muscles in the hand.',
    module: 'myosuite',
    install: ['pip install myosuite'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import myosuite  # noqa: F401  (registers the environments)',
    envs: [
      { id: 'myoHandPoseRandom-v0', label: 'Hand: reach a pose', space: 'continuous', hand: true },
      { id: 'myoHandReachRandom-v0', label: 'Hand: fingertips to targets', space: 'continuous', hand: true },
      { id: 'myoElbowPose1D6MRandom-v0', label: 'Elbow: one joint, six muscles', space: 'continuous' },
    ],
    docs: 'https://github.com/MyoHub/myosuite',
    caveats: ['Its render() is not Gymnasium’s everywhere: when it gives no frame, the run says so and trains without videos.'],
  },
  {
    id: 'metaworld',
    name: 'Meta-World',
    family: 'manipulation',
    blurb: 'Fifty manipulation tasks with one Sawyer arm: reach, push, open a drawer, hammer a nail.',
    good: 'Multi-task and meta-RL: the same arm, many tasks, success rates to compare.',
    module: 'metaworld',
    install: ['pip install "gymnasium>=1.0" metaworld'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import metaworld  # noqa: F401  (registers Meta-World/*)',
    make: '    return gym.make("Meta-World/MT1", env_name=env_id, render_mode=render_mode)',
    envs: [
      { id: 'reach-v3', label: 'reach', space: 'continuous' },
      { id: 'push-v3', label: 'push', space: 'continuous' },
      { id: 'drawer-open-v3', label: 'drawer-open', space: 'continuous' },
      { id: 'pick-place-v3', label: 'pick-place', space: 'continuous' },
    ],
    docs: 'https://metaworld.farama.org',
  },
  {
    id: 'robosuite',
    name: 'robosuite',
    family: 'manipulation',
    blurb: 'Robot arms on MuJoCo (Panda, Sawyer, UR5e, Kinova) with tasks: Lift, Stack, Door, NutAssembly.',
    good: 'Realistic arm control (operational-space controllers) and the robomimic imitation datasets.',
    module: 'robosuite',
    install: ['pip install robosuite'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: ROBOSUITE_MAIN,
    envs: [
      { id: 'Lift', label: 'Lift a cube', space: 'continuous' },
      { id: 'Stack', label: 'Stack two cubes', space: 'continuous' },
      { id: 'Door', label: 'Open a door', space: 'continuous' },
      { id: 'NutAssembly', label: 'Put nuts on pegs', space: 'continuous' },
    ],
    docs: 'https://robosuite.ai',
  },
  {
    id: 'maniskill',
    name: 'ManiSkill 3',
    family: 'manipulation',
    blurb: 'GPU-parallel manipulation on SAPIEN: pick, push, peg insertion, dexterous hands, mobile manipulators.',
    good: 'Fast, visual manipulation learning: thousands of rendered scenes a second on one GPU.',
    module: 'mani_skill',
    install: ['pip install --upgrade mani_skill torch'],
    gpu: 'helps',
    colab: true,
    linux: true,
    video: true,
    api: 'native',
    native: MANISKILL_MAIN,
    envs: [
      { id: 'PickCube-v1', label: 'Pick a cube', space: 'continuous' },
      { id: 'PushCube-v1', label: 'Push a cube', space: 'continuous' },
      { id: 'PegInsertionSide-v1', label: 'Insert a peg', space: 'continuous' },
      { id: 'RotateValveLevel0-v1', label: 'D’Claw hand: turn a valve', space: 'continuous', hand: true },
    ],
    docs: 'https://maniskill.readthedocs.io',
    caveats: ['Rendering needs Vulkan; the doctor says whether the machine has it.'],
  },
  {
    id: 'genesis',
    name: 'Genesis',
    family: 'manipulation',
    blurb: 'A Python-native physics platform: rigid and soft bodies, fluids, and fast parallel simulation.',
    good: 'Robots with soft or deformable things around them, and fast locomotion training.',
    module: 'genesis',
    install: ['pip install torch', 'pip install genesis-world'],
    gpu: 'helps',
    colab: true,
    video: true,
    api: 'native',
    native: GENESIS_MAIN,
    envs: [
      { id: 'xml/franka_emika_panda/panda.xml', label: 'Franka Panda arm', space: 'continuous' },
      { id: 'xml/universal_robots_ur5e/ur5e.xml', label: 'UR5e arm', space: 'continuous' },
    ],
    docs: 'https://genesis-world.readthedocs.io',
  },
  {
    id: 'pybullet',
    name: 'PyBullet',
    family: 'locomotion',
    blurb: 'The Bullet engine from Python: URDF robots, a CPU renderer that needs no OpenGL at all.',
    good: 'Anything with a URDF, on any machine, with pictures even where OpenGL is missing.',
    module: 'pybullet',
    install: ['pip install pybullet'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: PYBULLET_MAIN,
    envs: [
      { id: 'r2d2.urdf', label: 'R2D2', space: 'continuous' },
      { id: 'kuka_iiwa/model.urdf', label: 'KUKA iiwa arm', space: 'continuous' },
      { id: 'franka_panda/panda.urdf', label: 'Franka Panda arm', space: 'continuous' },
      { id: 'quadruped/minitaur.urdf', label: 'Minitaur quadruped', space: 'continuous' },
    ],
    docs: 'https://pybullet.org',
  },
  {
    id: 'isaaclab',
    name: 'Isaac Lab',
    family: 'manipulation',
    blurb: 'NVIDIA’s robot learning framework on Isaac Sim: quadrupeds, humanoids, Allegro and Shadow hands, on the GPU.',
    good: 'Sim-to-real at scale with photoreal rendering: the industry’s path for legged robots and dexterous hands.',
    module: 'isaaclab',
    install: ['# Isaac Lab installs with Isaac Sim, on an RTX GPU, Linux or Windows, Python 3.11:', '# https://isaac-sim.github.io/IsaacLab/main/source/setup/installation/pip_installation.html', 'git clone --depth 1 https://github.com/isaac-sim/IsaacLab.git || true'],
    gpu: 'rtx',
    colab: false,
    linux: true,
    video: true,
    api: 'native',
    envs: [
      { id: 'Isaac-Cartpole-v0', label: 'Cartpole (the first check)', space: 'continuous' },
      { id: 'Isaac-Velocity-Flat-Anymal-D-v0', label: 'ANYmal-D walking', space: 'continuous' },
      { id: 'Isaac-Repose-Cube-Allegro-Direct-v0', label: 'Allegro hand: in-hand cube reorientation', space: 'continuous', hand: true },
      { id: 'Isaac-Repose-Cube-Shadow-Direct-v0', label: 'Shadow hand: in-hand cube reorientation', space: 'continuous', hand: true },
      { id: 'Isaac-Lift-Cube-Franka-v0', label: 'Franka: lift a cube', space: 'continuous' },
    ],
    docs: 'https://isaac-sim.github.io/IsaacLab/',
    caveats: ['Needs an NVIDIA RTX-class GPU: not Colab. Add the lab server or a rented RTX machine as a Jupyter server, and run it there.', 'Its numbers go to TensorBoard (the TensorBoard pane draws them); its videos are bridged into the Sim pane.'],
  },
  {
    id: 'drake',
    name: 'Drake',
    family: 'locomotion',
    blurb: 'Model-based design for robotics: multibody dynamics, trajectory optimisation, control (TRI/MIT).',
    good: 'Control theory and optimisation next to learning: a model to plan with, not only to sample from.',
    module: 'pydrake',
    install: ['pip install drake'],
    gpu: 'no',
    colab: true,
    video: false,
    api: 'native',
    native: DRAKE_MAIN,
    envs: [{ id: 'pendulum', label: 'A pendulum', space: 'continuous' }],
    docs: 'https://drake.mit.edu',
  },
  {
    id: 'ale',
    name: 'Atari (ALE)',
    family: 'games',
    blurb: 'Pong, Breakout, Montezuma’s Revenge…: the Arcade Learning Environment, from pixels.',
    good: 'Learning from pixels, the DQN lineage, and world models of games (DreamerV3, IRIS, DIAMOND).',
    module: 'ale_py',
    install: ['pip install "gymnasium[atari]>=1.0"'],
    gpu: 'helps',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import ale_py\n\ngym.register_envs(ale_py)',
    make: '    env = gym.make(resolve(env_id), render_mode=render_mode, frameskip=1)\n    env = gym.wrappers.AtariPreprocessing(env, frame_skip=4, screen_size=84, grayscale_obs=True)\n    return gym.wrappers.FrameStackObservation(env, 4)',
    envs: [
      { id: 'ALE/Pong-v5', label: 'Pong', space: 'discrete', pixels: true },
      { id: 'ALE/Breakout-v5', label: 'Breakout', space: 'discrete', pixels: true },
      { id: 'ALE/SpaceInvaders-v5', label: 'Space Invaders', space: 'discrete', pixels: true },
      { id: 'ALE/MontezumaRevenge-v5', label: 'Montezuma’s Revenge (exploration)', space: 'discrete', pixels: true },
    ],
    docs: 'https://ale.farama.org',
    caveats: ['Learning Atari takes millions of frames: a GPU and an hour or more for Pong with PPO.'],
  },
  {
    id: 'minigrid',
    name: 'MiniGrid',
    family: 'games',
    blurb: 'Small grid worlds with keys, doors and goals: fast, partially observed, sparse rewards.',
    good: 'Exploration, memory and curriculum research on a laptop.',
    module: 'minigrid',
    install: ['pip install minigrid'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import minigrid  # noqa: F401  (registers the environments)\nfrom minigrid.wrappers import ImgObsWrapper',
    make: '    env = gym.make(resolve(env_id), render_mode=render_mode)\n    return gym.wrappers.FlattenObservation(ImgObsWrapper(env))',
    envs: [
      { id: 'MiniGrid-Empty-8x8-v0', label: 'Empty room', space: 'discrete' },
      { id: 'MiniGrid-DoorKey-5x5-v0', label: 'Door and key', space: 'discrete' },
      { id: 'MiniGrid-FourRooms-v0', label: 'Four rooms', space: 'discrete' },
    ],
    docs: 'https://minigrid.farama.org',
  },
  {
    id: 'crafter',
    name: 'Crafter',
    family: 'games',
    blurb: 'A 2D Minecraft-like survival world with 22 achievements.',
    good: 'Testing general abilities (exploration, long-term reasoning) cheaply; a DreamerV3 benchmark.',
    module: 'crafter',
    install: ['pip install crafter'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: CRAFTER_MAIN,
    envs: [{ id: 'reward', label: 'Crafter with rewards', space: 'discrete', pixels: true }],
    docs: 'https://github.com/danijar/crafter',
  },
  {
    id: 'craftax',
    name: 'Craftax',
    family: 'games',
    blurb: 'Crafter, and a far harder NetHack-like world, rewritten in JAX: a billion steps an hour on one GPU.',
    good: 'Open-ended RL at speed: long horizons with JAX-compiled training.',
    module: 'craftax',
    install: ['pip install -U "jax[cuda12]"', 'pip install craftax'],
    gpu: 'needs',
    colab: true,
    linux: true,
    video: true,
    api: 'native',
    native: CRAFTAX_MAIN,
    envs: [
      { id: 'Craftax-Symbolic-v1', label: 'Craftax, symbolic observations', space: 'discrete' },
      { id: 'Craftax-Pixels-v1', label: 'Craftax, pixels', space: 'discrete', pixels: true },
      { id: 'Craftax-Classic-Symbolic-v1', label: 'Craftax-Classic (Crafter)', space: 'discrete' },
    ],
    docs: 'https://github.com/MichaelTMatthews/Craftax',
  },
  {
    id: 'gymnax',
    name: 'gymnax',
    family: 'classic',
    blurb: 'Classic control, bsuite and MinAtar in JAX: whole training loops jit-compiled.',
    good: 'Learning how JAX RL works (PureJaxRL), and sweeping hundreds of seeds at once.',
    module: 'gymnax',
    install: ['pip install gymnax'],
    gpu: 'helps',
    colab: true,
    video: false,
    api: 'native',
    native: GYMNAX_MAIN,
    envs: [
      { id: 'CartPole-v1', label: 'CartPole', space: 'discrete' },
      { id: 'Breakout-MinAtar', label: 'MinAtar Breakout', space: 'discrete' },
      { id: 'SpaceInvaders-MinAtar', label: 'MinAtar Space Invaders', space: 'discrete' },
    ],
    docs: 'https://github.com/RobertTLange/gymnax',
  },
  {
    id: 'vizdoom',
    name: 'ViZDoom',
    family: 'games',
    blurb: 'Doom from pixels: first-person 3D navigation and combat, fast and light.',
    good: 'Visual RL in a 3D first-person world without a GPU-hungry engine.',
    module: 'vizdoom',
    install: ['pip install vizdoom'],
    gpu: 'helps',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'from vizdoom import gymnasium_wrapper  # noqa: F401  (registers Vizdoom*)',
    envs: [
      { id: 'VizdoomBasic-v0', label: 'Basic: shoot the monster', space: 'discrete', pixels: true },
      { id: 'VizdoomCorridor-v0', label: 'Deadly corridor', space: 'discrete', pixels: true },
      { id: 'VizdoomHealthGathering-v0', label: 'Health gathering', space: 'discrete', pixels: true },
    ],
    docs: 'https://vizdoom.farama.org',
  },
  {
    id: 'nle',
    name: 'NetHack (NLE)',
    family: 'games',
    blurb: 'The NetHack Learning Environment: a procedurally generated roguelike, one of the hardest tests in RL.',
    good: 'Long-horizon reasoning, symbolic observations, and LLM agents in a game.',
    module: 'nle',
    install: ['pip install nle'],
    gpu: 'no',
    colab: true,
    linux: true,
    video: false,
    api: 'gymnasium',
    imports: 'import nle  # noqa: F401  (registers NetHack*)',
    envs: [
      { id: 'NetHackScore-v0', label: 'Score', space: 'discrete' },
      { id: 'NetHackChallenge-v0', label: 'The NeurIPS challenge', space: 'discrete' },
    ],
    docs: 'https://github.com/heiner/nle',
    caveats: ['It renders as text, so there are no videos; returns and notes still come.'],
  },
  {
    id: 'minerl',
    name: 'MineRL',
    family: 'games',
    blurb: 'Minecraft itself, with the BASALT tasks and human demonstrations.',
    good: 'Learning from video and demonstrations in an open world (VPT, BASALT).',
    module: 'minerl',
    install: ['# MineRL needs Java 8 (a JDK) on the machine: sudo apt-get install -y openjdk-8-jdk', 'pip install git+https://github.com/minerllabs/minerl'],
    gpu: 'helps',
    colab: false,
    linux: true,
    video: true,
    api: 'native',
    native: MINERL_MAIN,
    envs: [
      { id: 'MineRLBasaltFindCave-v0', label: 'Find a cave', space: 'multi', pixels: true },
      { id: 'MineRLBasaltMakeWaterfall-v0', label: 'Make a waterfall', space: 'multi', pixels: true },
    ],
    docs: 'https://minerl.readthedocs.io',
    caveats: ['A first start builds Minecraft (several minutes); it needs a JDK 8 and a virtual display on some systems.'],
  },
  {
    id: 'mlagents',
    name: 'Unity ML-Agents',
    family: 'embodied',
    blurb: 'Environments built in the Unity engine, trained from Python; prebuilt examples download by name.',
    good: 'Games and 3D worlds you design yourself, with the engine’s physics and tools.',
    module: 'mlagents_envs',
    install: ['pip install mlagents-envs'],
    gpu: 'helps',
    colab: true,
    video: false,
    api: 'native',
    native: MLAGENTS_MAIN,
    envs: [
      { id: '3DBall', label: '3DBall: balance a ball', space: 'continuous' },
      { id: 'GridWorld', label: 'GridWorld', space: 'discrete' },
      { id: 'Basic', label: 'Basic', space: 'discrete' },
      { id: 'PushBlock', label: 'PushBlock', space: 'discrete' },
    ],
    docs: 'https://github.com/Unity-Technologies/ml-agents',
    caveats: ['mlagents-envs pins Python 3.10; on a newer Python use a virtual environment or the Companion’s.'],
  },
  {
    id: 'godot_rl',
    name: 'Godot RL Agents',
    family: 'embodied',
    blurb: 'Games made in the open-source Godot engine, trained with SB3, CleanRL, Sample Factory or RLlib.',
    good: 'Your own 3D game as an environment, with an engine that is free and light.',
    module: 'godot_rl',
    install: ['pip install godot-rl stable-baselines3'],
    gpu: 'helps',
    colab: true,
    video: false,
    api: 'native',
    native: GODOT_MAIN,
    envs: [
      { id: 'JumperHard', label: 'JumperHard', space: 'multi' },
      { id: 'BallChase', label: 'BallChase', space: 'multi' },
    ],
    docs: 'https://github.com/edbeeching/godot_rl_agents',
    caveats: ['An exported game binary is needed: the example ones come from the Hub with gdrl.env_from_hub.'],
  },
  {
    id: 'habitat',
    name: 'Habitat-Sim',
    family: 'embodied',
    blurb: 'Photorealistic 3D indoor scenes at thousands of frames a second, for embodied navigation.',
    good: 'Embodied AI: point-goal and object navigation, rearrangement, from first-person views.',
    module: 'habitat_sim',
    install: ['# Habitat-Sim installs with conda, not pip:', 'conda install -y habitat-sim withbullet headless -c conda-forge -c aihabitat'],
    gpu: 'helps',
    colab: false,
    linux: true,
    video: true,
    api: 'native',
    native: HABITAT_MAIN,
    envs: [
      { id: 'skokloster-castle', label: 'Skokloster castle (test scene)', space: 'discrete', pixels: true },
      { id: 'apartment_1', label: 'An apartment (test scene)', space: 'discrete', pixels: true },
    ],
    docs: 'https://aihabitat.org',
    caveats: ['Conda only, on Linux or macOS; a lab server is the usual place for it.'],
  },
  {
    id: 'pettingzoo',
    name: 'PettingZoo',
    family: 'multiagent',
    blurb: 'Multi-agent environments with one API: Butterfly’s cooperative games, classic board games and more.',
    good: 'Cooperation, competition and emergent behaviour among several learning agents.',
    module: 'pettingzoo',
    install: ['pip install "pettingzoo[butterfly]"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: PETTINGZOO_MAIN,
    envs: [
      { id: 'butterfly.pistonball_v6', label: 'Pistonball: 20 pistons move a ball', space: 'multi' },
      { id: 'butterfly.cooperative_pong_v5', label: 'Cooperative Pong', space: 'multi' },
      { id: 'butterfly.knights_archers_zombies_v10', label: 'Knights, archers, zombies', space: 'multi' },
    ],
    docs: 'https://pettingzoo.farama.org',
  },
  {
    id: 'highway_env',
    name: 'highway-env',
    family: 'driving',
    blurb: 'Lane changes, merges, roundabouts, parking and intersections in a light 2D traffic simulator.',
    good: 'Decision-making for driving, quickly, on a CPU.',
    module: 'highway_env',
    install: ['pip install highway-env'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'gymnasium',
    imports: 'import highway_env\n\ngym.register_envs(highway_env)',
    envs: [
      { id: 'highway-v0', label: 'Highway', space: 'discrete' },
      { id: 'merge-v0', label: 'Merge', space: 'discrete' },
      { id: 'roundabout-v0', label: 'Roundabout', space: 'discrete' },
      { id: 'intersection-v0', label: 'Intersection', space: 'discrete' },
    ],
    docs: 'https://highway-env.farama.org',
  },
  {
    id: 'metadrive',
    name: 'MetaDrive',
    family: 'driving',
    blurb: 'Procedurally generated roads and traffic, and real-world scenarios replayed, in a light 3D simulator.',
    good: 'Generalisation and safe driving: train on some maps, test on unseen ones.',
    module: 'metadrive',
    install: ['pip install metadrive-simulator'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: METADRIVE_MAIN,
    envs: [{ id: 'MetaDriveEnv', label: 'Generated maps with traffic', space: 'continuous' }],
    docs: 'https://metadrive-simulator.readthedocs.io',
  },
  {
    id: 'carla',
    name: 'CARLA',
    family: 'driving',
    blurb: 'Photorealistic urban driving on Unreal Engine, with sensors: cameras, LiDAR, radar.',
    good: 'Autonomous driving with realistic perception; the CARLA leaderboard.',
    module: 'carla',
    install: ['pip install carla==0.9.15', '# and the server, on a GPU machine: docker run --gpus all --net=host carlasim/carla:0.9.15 ./CarlaUE4.sh -RenderOffScreen'],
    gpu: 'needs',
    colab: false,
    linux: true,
    video: true,
    api: 'native',
    native: CARLA_MAIN,
    envs: [
      { id: 'Town01', label: 'Town01', space: 'continuous', pixels: true },
      { id: 'Town03', label: 'Town03', space: 'continuous', pixels: true },
    ],
    docs: 'https://carla.readthedocs.io',
    caveats: ['A server (8 GB+ of GPU memory) the client connects to; the client’s version must match the server’s.'],
  },
  {
    id: 'minari',
    name: 'Minari datasets',
    family: 'offline',
    blurb: 'Recorded episodes (the successor of D4RL): MuJoCo, Adroit hands, mazes, Atari.',
    good: 'Offline RL and world models trained on data, with no simulator running.',
    module: 'minari',
    install: ['pip install "minari[all]"'],
    gpu: 'no',
    colab: true,
    video: true,
    api: 'native',
    native: MINARI_MAIN,
    envs: [
      { id: 'mujoco/halfcheetah/expert-v0', label: 'HalfCheetah, expert', space: 'continuous' },
      { id: 'D4RL/door/human-v2', label: 'Adroit door, human demonstrations', space: 'continuous', hand: true },
      { id: 'D4RL/pointmaze/umaze-v2', label: 'Point maze', space: 'continuous' },
    ],
    docs: 'https://minari.farama.org',
  },
];

export const simulatorById = (id: string | undefined) => SIMULATORS.find((sim) => sim.id === id);

/**
 * The catalogue as the machine gets it: koios_simulators.json beside the
 * telemetry module, which `python koios_telemetry.py simulators` lists and
 * `python koios_telemetry.py use <simulator> [env]` writes env.py, setup.sh
 * (and a native starter) from — so a coding agent can wire any project to a
 * simulator from the terminal, a paper's reimplementation included.
 */
export const catalogueJson = () =>
  `${JSON.stringify(
    {
      schema: 1,
      simulators: SIMULATORS.map((sim) => ({ id: sim.id, name: sim.name, family: sim.family, blurb: sim.blurb, good: sim.good, module: sim.module, install: sim.install, gpu: sim.gpu, colab: sim.colab, linux: Boolean(sim.linux), video: sim.video, api: sim.api, imports: sim.imports ?? null, make: sim.make ?? null, native: sim.native ?? null, envs: sim.envs, docs: sim.docs, caveats: sim.caveats ?? [] })),
    },
    null,
    1,
  )}\n`;

// ------------------------------------------------------------ templates ----

export type TemplateId = 'random' | 'ppo' | 'sac' | 'sb3' | 'world-model' | 'native' | 'dreamerv3' | 'tdmpc2' | 'isaaclab';

export interface SimTemplate {
  id: TemplateId;
  name: string;
  text: string;
  /** What it adds to the requirements. */
  needs: string[];
  /** The file it writes, run as `python <file>`. */
  file: string;
}

export const TEMPLATES: Record<TemplateId, SimTemplate> = {
  random: { id: 'random', name: 'Random agent', text: 'The sanity check: does it install, run and record here, and what does chance score.', needs: [], file: 'random_agent.py' },
  ppo: { id: 'ppo', name: 'PPO (one file)', text: 'CleanRL-style PPO for discrete or continuous actions, flat or pixel observations: every line readable.', needs: ['torch'], file: 'ppo.py' },
  sac: { id: 'sac', name: 'SAC (one file)', text: 'Soft Actor-Critic for continuous control: off-policy, sample-efficient, the arm-and-hand workhorse.', needs: ['torch'], file: 'sac.py' },
  sb3: { id: 'sb3', name: 'Stable-Baselines3', text: 'PPO, SAC, TD3, DQN, A2C from the tested library, wired to the telemetry: a baseline in minutes.', needs: ['torch', 'stable-baselines3'], file: 'sb3.py' },
  'world-model': { id: 'world-model', name: 'World model from scratch', text: 'A VAE and a recurrent dynamics model learn the simulator from its frames, then dream: real against imagined.', needs: ['torch'], file: 'world_model.py' },
  native: { id: 'native', name: 'Starter', text: 'A first run on the simulator’s own API, recorded and logged, for an agent to build on.', needs: [], file: 'main.py' },
  dreamerv3: { id: 'dreamerv3', name: 'DreamerV3 (its repository)', text: 'Hafner’s world-model agent, cloned and run as published, its metrics bridged into the Sim pane.', needs: [], file: 'run_dreamer.sh' },
  tdmpc2: { id: 'tdmpc2', name: 'TD-MPC2 (its repository)', text: 'Hansen’s model-based agent that plans in a learned latent space, its eval CSV bridged into the Sim pane.', needs: [], file: 'run_tdmpc2.sh' },
  isaaclab: { id: 'isaaclab', name: 'Isaac Lab training', text: 'RSL-RL PPO on an Isaac Lab task, headless, its videos bridged into the Sim pane and its scalars to TensorBoard.', needs: [], file: 'train_isaaclab.sh' },
};

/** The templates a simulator can start from, the first being the one to suggest. */
export function templatesFor(sim: Simulator, env?: SimEnv): TemplateId[] {
  if (sim.id === 'isaaclab') return ['isaaclab'];
  const out: TemplateId[] = [];
  if (sim.api === 'gymnasium') {
    out.push('random');
    const multi = env?.space === 'multi';
    if (!multi) out.push('ppo');
    if (!env || env.space === 'continuous') out.push('sac');
    if (!multi && sim.id !== 'nle') out.push('sb3');
    if (sim.video) out.push('world-model');
  } else {
    out.push('native');
    out.push('world-model');
  }
  if (dreamerTask(sim, env)) out.push('dreamerv3');
  if (tdmpcTask(sim, env)) out.push('tdmpc2');
  return out;
}

/** DreamerV3's --configs and --task for a simulator's environment, when its repository supports it. */
export function dreamerTask(sim: Simulator, env?: SimEnv): { configs: string; task: string } | null {
  const id = env?.id ?? sim.envs[0]?.id ?? '';
  if (sim.id === 'dm_control') return { configs: 'dmc_proprio', task: `dmc_${id.replace(/-/g, '_')}` };
  if (sim.id === 'ale') return { configs: 'atari', task: `atari_${id.replace(/^ALE\//, '').replace(/-v\d+$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}` };
  if (sim.id === 'crafter') return { configs: 'crafter', task: 'crafter_reward' };
  return null;
}

/** TD-MPC2's task name for a simulator's environment, when its repository supports it. */
export function tdmpcTask(sim: Simulator, env?: SimEnv): string | null {
  const id = env?.id ?? sim.envs[0]?.id ?? '';
  if (sim.id === 'dm_control') return id;
  if (sim.id === 'metaworld') return `mw-${id.replace(/-v\d+$/, '')}`;
  return null;
}

/** What a simulator needs, as a short line for its card. */
export function needsLine(sim: Simulator): string {
  const gpu = { no: 'any CPU', helps: 'faster on a GPU', needs: 'a GPU', rtx: 'an RTX GPU' }[sim.gpu];
  return [gpu, sim.colab ? 'Colab' : 'not Colab', sim.linux ? 'Linux' : '', sim.video ? '' : 'no video'].filter(Boolean).join(' · ');
}

/** Why this simulator won't run where it is about to: a word for the place-picking step, or null. */
export function placeWarning(sim: Simulator, onColab: boolean): string | null {
  if (onColab && !sim.colab) return `${sim.name} doesn’t run on Colab${sim.gpu === 'rtx' ? ': it needs an NVIDIA RTX GPU' : ''}. Pick a server you added (a lab machine, a rented GPU) instead.`;
  if (onColab && sim.gpu === 'needs') return `${sim.name} needs a GPU: choose a GPU runtime (T4 or better) for Colab.`;
  return null;
}

// ------------------------------------------------------------- env.py ----

const RESOLVE = `def resolve(env_id):
    """The id as registered, or the newest registered version of it when that one isn't (versions move: -v4, -v5)."""
    if env_id in gym.registry:
        return env_id
    base = env_id.rsplit("-v", 1)[0]
    found = [k for k in gym.registry if k.rsplit("-v", 1)[0] == base and k.rsplit("-v", 1)[-1].isdigit()]
    return max(found, key=lambda k: int(k.rsplit("-v", 1)[1])) if found else env_id`;

/** env.py for a Gymnasium simulator: SIM, ENV_ID and make_env, which every template imports. */
export function envPy(sim: Simulator, envId: string): string {
  const body = sim.make ?? GYM_MAKE;
  return `"""The environment this project runs: ${sim.name}, ${envId}.

Every script imports make_env from here, so another environment is another ENV_ID (or another body for _make).
"""
import koios_telemetry  # noqa: F401  (first: it picks an off-screen renderer before any simulator loads)
import gymnasium as gym
${sim.imports ? `${sim.imports}\n` : ''}
SIM = ${JSON.stringify(sim.id)}
ENV_ID = ${JSON.stringify(envId)}


${RESOLVE}


def _make(env_id, render_mode):
${body}


def make_env(render_mode=None, env_id=None):
    """A new environment; render_mode="rgb_array" to record it. An env that can't render that way is made without."""
    env_id = env_id or ENV_ID
    try:
        return _make(env_id, render_mode)
    except Exception:
        if render_mode is None:
            raise
        return _make(env_id, None)
`;
}

/** env.py for a native simulator: only what the world-model template needs (no Gymnasium env to make). */
export function nativeEnvPy(sim: Simulator, envId: string): string {
  return `"""The environment this project runs: ${sim.name}, ${envId}. It has an API of its own (see main.py), so make_env
is not a Gymnasium one: world_model.py falls back to its built-in world unless you write one here that renders.
"""
SIM = ${JSON.stringify(sim.id)}
ENV_ID = ${JSON.stringify(envId)}


def make_env(render_mode=None, env_id=None):
    raise NotImplementedError("${sim.name} has its own API: wrap it as a gymnasium.Env here to use the Gymnasium templates")
`;
}
