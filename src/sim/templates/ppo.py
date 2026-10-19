"""PPO, in one file, in the style of CleanRL: Proximal Policy Optimization for discrete or continuous actions,
on flat observations or on images.

What to watch in the Sim pane:
  - episode return    should climb; flat for long means the agent isn't learning (see the diagnostics)
  - loss/approx_kl    how far each update moves the policy; above ~0.05 the updates are too big
  - loss/clipfrac     the share of samples PPO's clip cut off; a high one says the same
  - entropy           how random the policy still is; it should fall slowly, not collapse to 0
  - explained_var     how well the critic predicts returns; near 1 is good, near 0 or negative is a weak critic

    python ppo.py --total-steps 200000
"""
import argparse
import os
import time

import gymnasium as gym
import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical, Normal

from env import ENV_ID, SIM, make_env
from koios_telemetry import Run


def parse():
    p = argparse.ArgumentParser(description="PPO")
    p.add_argument("--total-steps", type=int, default=200_000)
    p.add_argument("--num-envs", type=int, default=8)
    p.add_argument("--num-steps", type=int, default=256, help="steps each env takes per update")
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--gae-lambda", type=float, default=0.95)
    p.add_argument("--minibatches", type=int, default=8)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--clip", type=float, default=0.2)
    p.add_argument("--ent-coef", type=float, default=0.0)
    p.add_argument("--vf-coef", type=float, default=0.5)
    p.add_argument("--max-grad-norm", type=float, default=0.5)
    p.add_argument("--target-kl", type=float, default=None)
    p.add_argument("--video-every", type=int, default=10, help="record env 0 every this many updates")
    p.add_argument("--seed", type=int, default=1)
    return p.parse_args()


def layer(module, std=np.sqrt(2), bias=0.0):
    nn.init.orthogonal_(module.weight, std)
    nn.init.constant_(module.bias, bias)
    return module


class Agent(nn.Module):
    def __init__(self, obs_space, act_space):
        super().__init__()
        shape = obs_space.shape
        self.image = len(shape) == 3
        if self.image:
            # Channels first for the convolutions; (H, W, C) images are turned round in forward.
            self.hwc = shape[-1] in (1, 3, 4) and shape[0] > 4
            c = shape[-1] if self.hwc else shape[0]
            self.body = nn.Sequential(
                layer(nn.Conv2d(c, 32, 8, stride=4)), nn.ReLU(),
                layer(nn.Conv2d(32, 64, 4, stride=2)), nn.ReLU(),
                layer(nn.Conv2d(64, 64, 3, stride=1)), nn.ReLU(), nn.Flatten())
            with torch.no_grad():
                n = self.body(torch.zeros(1, c, *(shape[:2] if self.hwc else shape[1:]))).shape[1]
            # One convolutional body for both heads, as in the Atari PPO: learning what is on screen once.
            self.body = nn.Sequential(self.body, layer(nn.Linear(n, 512)), nn.ReLU())
            self.critic_body = None
            width = 512
        else:
            # Separate bodies for the policy and the critic: with one shared, the value loss (returns in the hundreds)
            # swamps the policy's gradient once the whole gradient is clipped, and the policy stops moving.
            n = int(np.prod(shape))
            mlp = lambda: nn.Sequential(nn.Flatten(), layer(nn.Linear(n, 64)), nn.Tanh(), layer(nn.Linear(64, 64)), nn.Tanh())  # noqa: E731
            self.body, self.critic_body = mlp(), mlp()
            width = 64
        self.discrete = isinstance(act_space, gym.spaces.Discrete)
        out = act_space.n if self.discrete else int(np.prod(act_space.shape))
        self.actor = layer(nn.Linear(width, out), std=0.01)
        self.critic = layer(nn.Linear(width, 1), std=1.0)
        if not self.discrete:
            self.log_std = nn.Parameter(torch.zeros(1, out))

    def features(self, x):
        """What the policy head and the critic head each see."""
        if self.image:
            x = x.float() / 255.0 if x.dtype == torch.uint8 or x.max() > 1.5 else x.float()
            if self.hwc:
                x = x.permute(0, 3, 1, 2)
            h = self.body(x)
            return h, h
        return self.body(x), self.critic_body(x)

    def value(self, x):
        return self.critic(self.features(x)[1])

    def act(self, x, action=None):
        h, hc = self.features(x)
        logits = self.actor(h)
        dist = Categorical(logits=logits) if self.discrete else Normal(logits, self.log_std.expand_as(logits).exp())
        if action is None:
            action = dist.sample()
        logp = dist.log_prob(action)
        entropy = dist.entropy()
        if not self.discrete:
            logp, entropy = logp.sum(-1), entropy.sum(-1)
        return action, logp, entropy, self.critic(hc)


def thunk(index, gamma, seed):
    def make():
        env = make_env(render_mode="rgb_array" if index == 0 else None)
        if isinstance(env.observation_space, gym.spaces.Dict):
            env = gym.wrappers.FlattenObservation(env)
        env = gym.wrappers.RecordEpisodeStatistics(env)  # the raw returns, before any normalising below
        if isinstance(env.action_space, gym.spaces.Box):
            env = gym.wrappers.ClipAction(env)
            env = gym.wrappers.NormalizeObservation(env)
            env = gym.wrappers.NormalizeReward(env, gamma=gamma)
        env.action_space.seed(seed + index)
        return env

    return make


def main():
    args = parse()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cpu":
        # Small networks run fastest on one CPU thread: torch's pool costs more than it gives at this size, and on a
        # container with a CPU quota it can be a hundred times slower. `python koios_telemetry.py doctor` measures it.
        torch.set_num_threads(int(os.environ.get("KOIOS_TORCH_THREADS", "1")))
    run = Run("ppo", config={**vars(args), "env": ENV_ID, "device": str(device)}, sim=f"{SIM}/{ENV_ID}")
    envs = gym.vector.SyncVectorEnv([thunk(i, args.gamma, args.seed) for i in range(args.num_envs)])
    agent = Agent(envs.single_observation_space, envs.single_action_space).to(device)
    optimizer = torch.optim.Adam(agent.parameters(), lr=args.lr, eps=1e-5)
    run.note(f"observations {envs.single_observation_space}, actions {envs.single_action_space}, {sum(p.numel() for p in agent.parameters())} parameters", step=0, tag="spaces")
    run.scene(envs.envs[0])  # a MuJoCo env: the first one, live in the Sim pane's 3D view (nothing for the others)

    T, N = args.num_steps, args.num_envs
    obs = torch.zeros((T, N) + envs.single_observation_space.shape, device=device)
    actions = torch.zeros((T, N) + envs.single_action_space.shape, device=device)
    logps, rewards, dones, values = (torch.zeros((T, N), device=device) for _ in range(4))

    step = 0
    next_obs, _ = envs.reset(seed=args.seed)
    next_obs = torch.as_tensor(next_obs, device=device, dtype=torch.float32)
    next_done = torch.zeros(N, device=device)
    updates = max(1, args.total_steps // (T * N))
    started = time.time()
    for update in range(1, updates + 1):
        # Anneal the learning rate to zero over the run, as the PPO paper does for its continuous tasks.
        optimizer.param_groups[0]["lr"] = args.lr * (1.0 - (update - 1.0) / updates)
        frames = [] if args.video_every and (update == 1 or update % args.video_every == 0) else None
        for t in range(T):
            step += N
            obs[t], dones[t] = next_obs, next_done
            with torch.no_grad():
                action, logp, _, value = agent.act(next_obs)
            values[t], actions[t], logps[t] = value.flatten(), action, logp
            o, reward, terminated, truncated, infos = envs.step(action.cpu().numpy())
            run.count(N)
            run.scene_step()
            if frames is not None and len(frames) < 400:
                frame = envs.envs[0].render()
                if frame is not None:
                    frames.append(frame)
            rewards[t] = torch.as_tensor(reward, device=device, dtype=torch.float32).view(-1)
            next_obs = torch.as_tensor(o, device=device, dtype=torch.float32)
            next_done = torch.as_tensor(np.logical_or(terminated, truncated), device=device, dtype=torch.float32)
            run.log_vector(infos, step=step)
        if frames:
            run.video("env0", frames, step=step, fps=float(envs.envs[0].metadata.get("render_fps") or 30))

        # Generalised advantage estimation: how much better each action did than the critic expected.
        with torch.no_grad():
            next_value = agent.value(next_obs).reshape(1, -1)
            advantages = torch.zeros_like(rewards)
            last = 0
            for t in reversed(range(T)):
                nonterminal = 1.0 - (next_done if t == T - 1 else dones[t + 1])
                nv = next_value if t == T - 1 else values[t + 1]
                delta = rewards[t] + args.gamma * nv * nonterminal - values[t]
                advantages[t] = last = delta + args.gamma * args.gae_lambda * nonterminal * last
            returns = advantages + values

        b_obs = obs.reshape((-1,) + envs.single_observation_space.shape)
        b_actions = actions.reshape((-1,) + envs.single_action_space.shape)
        b_logps, b_adv, b_ret, b_val = logps.reshape(-1), advantages.reshape(-1), returns.reshape(-1), values.reshape(-1)
        batch = T * N
        mb = batch // args.minibatches
        clipfracs = []
        for _ in range(args.epochs):
            order = np.random.permutation(batch)
            for start in range(0, batch, mb):
                idx = order[start:start + mb]
                _, new_logp, entropy, new_value = agent.act(b_obs[idx], b_actions[idx].long() if agent.discrete else b_actions[idx])
                ratio = (new_logp - b_logps[idx]).exp()
                with torch.no_grad():
                    approx_kl = ((ratio - 1) - (new_logp - b_logps[idx])).mean()
                    clipfracs.append(((ratio - 1.0).abs() > args.clip).float().mean().item())
                adv = b_adv[idx]
                adv = (adv - adv.mean()) / (adv.std() + 1e-8)
                pg_loss = torch.max(-adv * ratio, -adv * ratio.clamp(1 - args.clip, 1 + args.clip)).mean()
                v_loss = 0.5 * ((new_value.flatten() - b_ret[idx]) ** 2).mean()
                loss = pg_loss - args.ent_coef * entropy.mean() + args.vf_coef * v_loss
                optimizer.zero_grad()
                loss.backward()
                grad_norm = nn.utils.clip_grad_norm_(agent.parameters(), args.max_grad_norm)
                optimizer.step()
            if args.target_kl is not None and approx_kl > args.target_kl:
                run.note(f"stopped the epochs early: KL {approx_kl:.3f} > target {args.target_kl}", step=step, tag="kl")
                break

        var = b_ret.var()
        run.log({
            "loss/policy": pg_loss.item(), "loss/value": v_loss.item(), "loss/approx_kl": approx_kl.item(),
            "loss/clipfrac": float(np.mean(clipfracs)), "entropy": entropy.mean().item(),
            "explained_var": float("nan") if var == 0 else (1 - (b_ret - b_val).var() / var).item(),
            "grad_norm": float(grad_norm), "lr": optimizer.param_groups[0]["lr"], "sps": step / (time.time() - started),
        }, step=step)

    torch.save(agent.state_dict(), f"{run.dir}/agent.pt")
    run.checkpoint(f"{run.dir}/agent.pt", step=step)
    envs.close()
    run.finish()


if __name__ == "__main__":
    main()
