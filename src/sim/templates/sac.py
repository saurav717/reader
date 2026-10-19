"""SAC, in one file: Soft Actor-Critic for continuous control (MuJoCo, dm_control, robot arms and hands).

Off-policy: it keeps every transition in a replay buffer and learns from random batches of it, so it needs far
fewer environment steps than PPO on the same task, at more compute a step. It maximises return plus the policy's
entropy, with the temperature alpha tuned so the policy stays as random as `target entropy` asks.

What to watch in the Sim pane:
  - episode return   climbs after the first `--learning-starts` steps of random play
  - loss/q           the critics' error; it grows as returns grow (bigger targets), but should not explode
  - alpha            the temperature; it falls as the policy grows sure of itself
  - q_mean           what the critics think a state is worth; far above the real returns means overestimation

    python sac.py --total-steps 100000
"""
import argparse
import os

import gymnasium as gym
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from env import ENV_ID, SIM, make_env
from koios_telemetry import Run


def parse():
    p = argparse.ArgumentParser(description="SAC")
    p.add_argument("--total-steps", type=int, default=100_000)
    p.add_argument("--buffer", type=int, default=1_000_000)
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--learning-starts", type=int, default=5_000)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--tau", type=float, default=0.005)
    p.add_argument("--policy-lr", type=float, default=3e-4)
    p.add_argument("--q-lr", type=float, default=1e-3)
    p.add_argument("--video-every", type=int, default=20, help="record one episode in this many")
    p.add_argument("--seed", type=int, default=1)
    return p.parse_args()


def mlp(i, o, width=256):
    return nn.Sequential(nn.Linear(i, width), nn.ReLU(), nn.Linear(width, width), nn.ReLU(), nn.Linear(width, o))


class Actor(nn.Module):
    def __init__(self, obs_dim, act_space):
        super().__init__()
        n = int(np.prod(act_space.shape))
        self.net = mlp(obs_dim, 2 * n)
        self.register_buffer("scale", torch.as_tensor((act_space.high - act_space.low) / 2.0, dtype=torch.float32))
        self.register_buffer("bias", torch.as_tensor((act_space.high + act_space.low) / 2.0, dtype=torch.float32))

    def forward(self, obs):
        mean, log_std = self.net(obs).chunk(2, -1)
        log_std = log_std.clamp(-5, 2)
        normal = torch.distributions.Normal(mean, log_std.exp())
        u = normal.rsample()
        y = torch.tanh(u)  # squashed into the action bounds
        logp = (normal.log_prob(u) - torch.log(self.scale * (1 - y.pow(2)) + 1e-6)).sum(-1)
        return y * self.scale + self.bias, logp, torch.tanh(mean) * self.scale + self.bias


def main():
    args = parse()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cpu":
        # Small networks run fastest on one CPU thread: torch's pool costs more than it gives at this size, and on a
        # container with a CPU quota it can be a hundred times slower. `python koios_telemetry.py doctor` measures it.
        torch.set_num_threads(int(os.environ.get("KOIOS_TORCH_THREADS", "1")))
    run = Run("sac", config={**vars(args), "env": ENV_ID, "device": str(device)}, sim=f"{SIM}/{ENV_ID}", video_every=args.video_every)
    env = make_env(render_mode="rgb_array")
    if isinstance(env.observation_space, gym.spaces.Dict):
        env = gym.wrappers.FlattenObservation(env)
    if not isinstance(env.action_space, gym.spaces.Box):
        raise SystemExit(f"SAC is for continuous actions; {ENV_ID} has {env.action_space}. Try ppo.py.")
    env = run.wrap(env)
    obs_dim = int(np.prod(env.observation_space.shape))
    act_dim = int(np.prod(env.action_space.shape))
    actor = Actor(obs_dim, env.action_space).to(device)
    q1, q2 = mlp(obs_dim + act_dim, 1).to(device), mlp(obs_dim + act_dim, 1).to(device)
    q1_target, q2_target = mlp(obs_dim + act_dim, 1).to(device), mlp(obs_dim + act_dim, 1).to(device)
    q1_target.load_state_dict(q1.state_dict())
    q2_target.load_state_dict(q2.state_dict())
    q_opt = torch.optim.Adam(list(q1.parameters()) + list(q2.parameters()), lr=args.q_lr)
    pi_opt = torch.optim.Adam(actor.parameters(), lr=args.policy_lr)
    target_entropy = -float(act_dim)
    log_alpha = torch.zeros(1, requires_grad=True, device=device)
    a_opt = torch.optim.Adam([log_alpha], lr=args.q_lr)

    size = min(args.buffer, args.total_steps)
    B = {"o": np.zeros((size, obs_dim), np.float32), "a": np.zeros((size, act_dim), np.float32), "r": np.zeros(size, np.float32), "o2": np.zeros((size, obs_dim), np.float32), "d": np.zeros(size, np.float32)}
    obs, _ = env.reset(seed=args.seed)
    env.action_space.seed(args.seed)
    for step in range(1, args.total_steps + 1):
        if step < args.learning_starts:
            action = env.action_space.sample()
        else:
            with torch.no_grad():
                action = actor(torch.as_tensor(obs, dtype=torch.float32, device=device).reshape(1, -1))[0][0].cpu().numpy()
        obs2, reward, terminated, truncated, _ = env.step(action)
        i = (step - 1) % size
        # A time limit (truncated) is not a terminal state: the value after it is still bootstrapped.
        B["o"][i], B["a"][i], B["r"][i], B["o2"][i], B["d"][i] = np.ravel(obs), action, reward, np.ravel(obs2), float(terminated)
        obs = obs2
        if terminated or truncated:
            obs, _ = env.reset()
        if step < args.learning_starts:
            continue
        idx = np.random.randint(0, min(step, size), args.batch)
        o, a, r, o2, d = (torch.as_tensor(B[k][idx], device=device) for k in ("o", "a", "r", "o2", "d"))
        with torch.no_grad():
            a2, logp2, _ = actor(o2)
            alpha = log_alpha.exp()
            target_q = torch.min(q1_target(torch.cat([o2, a2], 1)), q2_target(torch.cat([o2, a2], 1))).flatten() - alpha * logp2
            y = r + args.gamma * (1 - d) * target_q
        qa1, qa2 = q1(torch.cat([o, a], 1)).flatten(), q2(torch.cat([o, a], 1)).flatten()
        q_loss = F.mse_loss(qa1, y) + F.mse_loss(qa2, y)
        q_opt.zero_grad()
        q_loss.backward()
        q_opt.step()
        if step % 2 == 0:  # the policy and the temperature every other step, as in the paper's reference
            pi, logp, _ = actor(o)
            pi_loss = (log_alpha.exp().detach() * logp - torch.min(q1(torch.cat([o, pi], 1)), q2(torch.cat([o, pi], 1))).flatten()).mean()
            pi_opt.zero_grad()
            pi_loss.backward()
            pi_opt.step()
            a_loss = (-log_alpha.exp() * (logp.detach() + target_entropy)).mean()
            a_opt.zero_grad()
            a_loss.backward()
            a_opt.step()
        with torch.no_grad():
            for net, target in ((q1, q1_target), (q2, q2_target)):
                for p, tp in zip(net.parameters(), target.parameters()):
                    tp.mul_(1 - args.tau).add_(args.tau * p)
        if step % 1000 == 0:
            run.log({"loss/q": q_loss.item(), "loss/policy": pi_loss.item(), "alpha": log_alpha.exp().item(), "q_mean": qa1.mean().item(), "entropy": -logp.mean().item()}, step=step)
    torch.save(actor.state_dict(), f"{run.dir}/actor.pt")
    run.checkpoint(f"{run.dir}/actor.pt", step=args.total_steps)
    env.close()
    # The evaluation: the default protocol (10 seeded episodes, the policy's mean action) unless the paper's is wired in
    # here — read paper/paper.md for how the paper evaluates, pass its numbers as paper={...}, and say so in the protocol.
    with torch.no_grad():
        def act(obs):
            return actor(torch.as_tensor(np.asarray(obs), dtype=torch.float32, device=device).reshape(1, -1))[2][0].cpu().numpy()
        def eval_env(**kw):
            e = make_env(**kw)
            return gym.wrappers.FlattenObservation(e) if isinstance(e.observation_space, gym.spaces.Dict) else e
        run.evaluate(eval_env, act, episodes=10, seed=args.seed + 1000, step=args.total_steps)
    run.finish()


if __name__ == "__main__":
    main()
