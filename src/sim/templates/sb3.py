"""Stable-Baselines3: tried and tested implementations (PPO, SAC, TD3, DQN, A2C) behind one call, with the Koios
telemetry attached through a callback. Use it to get a baseline quickly; read ppo.py or sac.py to see the inside.

    pip install stable-baselines3
    python sb3.py --algo PPO --total-steps 200000
"""
import argparse

import gymnasium as gym
import numpy as np
from stable_baselines3 import A2C, DQN, PPO, SAC, TD3
from stable_baselines3.common.callbacks import BaseCallback

from env import ENV_ID, SIM, make_env
from koios_telemetry import Run

ALGOS = {"PPO": PPO, "SAC": SAC, "TD3": TD3, "DQN": DQN, "A2C": A2C}


class Koios(BaseCallback):
    """Sends what SB3 logs (its losses, rates and episode statistics) to the run, and records a video now and then."""

    def __init__(self, run: Run, video_every_steps: int):
        super().__init__()
        self.run = run
        self.every = video_every_steps
        self.next_video = 0

    def _on_step(self) -> bool:
        self.run.count(self.training_env.num_envs)
        self.run.scene_step()
        for info in self.locals.get("infos", []):
            if "episode" in info:
                self.run.episode(info["episode"]["r"], info["episode"]["l"], step=self.num_timesteps, success=info.get("is_success"))
        if self.every and self.num_timesteps >= self.next_video:
            self.next_video += self.every
            self.record()
        return True

    def _on_rollout_end(self) -> None:
        values = {k: v for k, v in self.model.logger.name_to_value.items() if isinstance(v, (int, float, np.floating))}
        if values:
            self.run.log(values, step=self.num_timesteps)

    def record(self):
        env = make_env(render_mode="rgb_array")
        obs, _ = env.reset()
        frames, done = [], False
        while not done and len(frames) < 600:
            action, _ = self.model.predict(obs, deterministic=True)
            obs, _, terminated, truncated, _ = env.step(action)
            done = terminated or truncated
            if not self.run.grab(env.render, frames):
                break
        if frames:
            self.run.video("policy", frames, step=self.num_timesteps, fps=float(env.metadata.get("render_fps") or 30))
        env.close()


def main():
    p = argparse.ArgumentParser(description="Stable-Baselines3")
    p.add_argument("--algo", default="PPO", choices=list(ALGOS))
    p.add_argument("--total-steps", type=int, default=200_000)
    p.add_argument("--video-every", type=int, default=25_000, help="record the policy every this many steps")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()
    run = Run(f"sb3-{args.algo.lower()}", config={**vars(args), "env": ENV_ID}, sim=f"{SIM}/{ENV_ID}")
    # Every chart in the Sim pane is labelled: what its x counts, and what each of SB3's numbers measures.
    run.axes({"rollout/ep_rew_mean": "mean episode return", "rollout/ep_len_mean": "mean episode length (steps)", "time/fps": "env steps / s",
              "train/value_loss": "value loss", "train/policy_gradient_loss": "policy-gradient loss", "train/entropy_loss": "entropy loss (−entropy)",
              "train/approx_kl": "approx. KL to the old policy", "train/clip_fraction": "fraction of ratios clipped", "train/learning_rate": "learning rate",
              "train/explained_variance": "explained variance of returns", "train/loss": "total loss", "train/actor_loss": "actor loss",
              "train/critic_loss": "critic loss", "train/ent_coef": "entropy coefficient", "train/ent_coef_loss": "entropy-coefficient loss",
              "train/n_updates": "gradient updates so far", "train/std": "action std", "train/clip_range": "PPO clip range"}, x="environment steps")
    env = make_env()
    # Dict observations (a goal beside the state, an image beside numbers) go to SB3's MultiInputPolicy as they are.
    policy = "MultiInputPolicy" if isinstance(env.observation_space, gym.spaces.Dict) else "CnnPolicy" if len(env.observation_space.shape or ()) == 3 else "MlpPolicy"
    model = ALGOS[args.algo](policy, env, seed=args.seed, verbose=0)
    run.note(f"{args.algo} with {policy} on {env.observation_space} -> {env.action_space}", step=0, tag="spaces")
    run.scene(env)  # a MuJoCo env, live in the Sim pane's 3D view; nothing for the others
    model.learn(total_timesteps=args.total_steps, callback=Koios(run, args.video_every))
    model.save(f"{run.dir}/model")
    run.checkpoint(f"{run.dir}/model.zip", step=args.total_steps)
    # The evaluation: the default protocol (10 seeded episodes, deterministic) unless the paper's is wired in here — read
    # paper/paper.md for how the paper evaluates, pass its numbers as paper={...}, and say so in the protocol.
    run.evaluate(make_env, lambda obs: model.predict(obs, deterministic=True)[0], episodes=10, seed=args.seed + 1000, step=args.total_steps)
    run.finish()


if __name__ == "__main__":
    main()
