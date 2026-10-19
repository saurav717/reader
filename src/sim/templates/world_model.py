"""A world model from scratch: learn to predict what the simulator will show next, then let it dream.

The recipe is the one in Ha & Schmidhuber's "World Models" (2018), small enough to read in one sitting:

  1. collect episodes with a random policy, keeping the rendered frames and the actions
  2. an encoder squeezes each 64x64 frame into a latent vector z, and a decoder draws it back (a VAE)
  3. a recurrent dynamics model takes (z_t, a_t) and predicts z_{t+1}: the "world" in the world model
  4. a dream: give it a few real frames, then let it roll forward on its own predictions with the real actions,
     and compare what it imagines with what really happened

What to watch in the Sim pane:
  - loss/recon      how well a frame survives the round trip through z; the floor of every dream's error
  - loss/dynamics   one-step prediction error in latent space
  - the dream video real | imagined | difference, and the error curve over the horizon: it rises with the
                    horizon, because each prediction is fed its own last mistake (compounding error). Training
                    with --overshoot (multi-step losses) is the classic fix; DreamerV3 and TD-MPC2 go further.

    python world_model.py                 # the environment in env.py, if it renders
    python world_model.py --env ball      # a tiny built-in pixel world that needs nothing installed
"""
import argparse
import os

import gymnasium as gym
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from koios_telemetry import Run

SIZE = 64


class Ball(gym.Env):
    """A ball in a box, pushed by the action, bouncing off the walls: a world with physics a model can learn."""

    metadata = {"render_modes": ["rgb_array"], "render_fps": 20}

    def __init__(self, render_mode="rgb_array"):
        self.render_mode = render_mode
        self.action_space = gym.spaces.Box(-1.0, 1.0, (2,), np.float32)
        self.observation_space = gym.spaces.Box(0.0, 1.0, (4,), np.float32)
        self.t = 0

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.p = self.np_random.uniform(0.2, 0.8, 2)
        self.v = self.np_random.uniform(-0.03, 0.03, 2)
        self.t = 0
        return np.concatenate([self.p, self.v]).astype(np.float32), {}

    def step(self, action):
        self.v = np.clip(self.v + 0.004 * np.asarray(action, np.float64), -0.05, 0.05)
        self.p = self.p + self.v
        for i in range(2):
            if not 0.1 <= self.p[i] <= 0.9:
                self.v[i] = -self.v[i]
                self.p[i] = np.clip(self.p[i], 0.1, 0.9)
        self.t += 1
        return np.concatenate([self.p, self.v]).astype(np.float32), 0.0, False, self.t >= 100, {}

    def render(self):
        yy, xx = np.mgrid[0:SIZE, 0:SIZE] / SIZE
        d = (xx - self.p[0]) ** 2 + (yy - self.p[1]) ** 2
        img = np.full((SIZE, SIZE, 3), 30, np.uint8)
        img[d < 0.006] = (240, 170, 60)
        img[[0, -1], :] = img[:, [0, -1]] = 120
        return img


def parse():
    p = argparse.ArgumentParser(description="a world model")
    p.add_argument("--env", default="env.py", help='"env.py" for the project\'s environment, or "ball"')
    p.add_argument("--episodes", type=int, default=60)
    p.add_argument("--max-steps", type=int, default=100, help="steps kept from each episode")
    p.add_argument("--iterations", type=int, default=3000)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--seq", type=int, default=16, help="sequence length the dynamics trains on")
    p.add_argument("--latent", type=int, default=32)
    p.add_argument("--hidden", type=int, default=256)
    p.add_argument("--kl", type=float, default=1e-3, help="weight of the VAE's KL term")
    p.add_argument("--overshoot", type=int, default=1, help="train the dynamics on its own predictions this many steps ahead")
    p.add_argument("--context", type=int, default=5, help="real frames a dream starts from")
    p.add_argument("--horizon", type=int, default=40, help="frames a dream imagines")
    p.add_argument("--dream-every", type=int, default=250)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args()


def make(args):
    if args.env == "ball":
        return Ball(), "builtin/ball"
    from env import ENV_ID, SIM, make_env

    env = make_env(render_mode="rgb_array")
    env.reset(seed=args.seed)
    if env.render() is None:
        raise RuntimeError("it does not render")
    return env, f"{SIM}/{ENV_ID}"


def to64(frame):
    f = np.asarray(frame)
    if f.ndim == 2:
        f = np.repeat(f[..., None], 3, -1)
    h, w = f.shape[:2]
    ys, xs = (np.arange(SIZE) * h // SIZE), (np.arange(SIZE) * w // SIZE)
    return f[ys][:, xs, :3]


def collect(env, args):
    """Random-policy episodes: frames (N, T, 64, 64, 3) uint8 and actions (N, T, A)."""
    discrete = isinstance(env.action_space, gym.spaces.Discrete)
    frames, actions = [], []
    env.action_space.seed(args.seed)
    for e in range(args.episodes):
        env.reset(seed=args.seed + e)
        fs, acts = [to64(env.render())], []
        for _ in range(args.max_steps):
            a = env.action_space.sample()
            _, _, terminated, truncated, _ = env.step(a)
            acts.append(np.eye(env.action_space.n)[a] if discrete else np.ravel(a).astype(np.float32))
            fs.append(to64(env.render()))
            if terminated or truncated:
                break
        if len(acts) >= args.seq + 1:
            frames.append(np.stack(fs[:-1]))
            actions.append(np.stack(acts).astype(np.float32))
    return frames, actions


class WorldModel(nn.Module):
    def __init__(self, action_dim, latent, hidden):
        super().__init__()
        self.enc = nn.Sequential(nn.Conv2d(3, 32, 4, 2, 1), nn.ReLU(), nn.Conv2d(32, 64, 4, 2, 1), nn.ReLU(), nn.Conv2d(64, 128, 4, 2, 1), nn.ReLU(), nn.Conv2d(128, 256, 4, 2, 1), nn.ReLU(), nn.Flatten(), nn.Linear(256 * 4 * 4, 2 * latent))
        self.dec_in = nn.Linear(latent, 256 * 4 * 4)
        self.dec = nn.Sequential(nn.ConvTranspose2d(256, 128, 4, 2, 1), nn.ReLU(), nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(), nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(), nn.ConvTranspose2d(32, 3, 4, 2, 1), nn.Sigmoid())
        self.rnn = nn.GRUCell(latent + action_dim, hidden)
        self.head = nn.Linear(hidden, latent)
        self.hidden = hidden

    def encode(self, x):
        mu, logvar = self.enc(x).chunk(2, -1)
        return mu, logvar.clamp(-8, 8)

    def decode(self, z):
        return self.dec(self.dec_in(z).view(-1, 256, 4, 4))

    def step(self, z, a, h):
        h = self.rnn(torch.cat([z, a], -1), h)
        return z + self.head(h), h  # predicts the change in z: easier than the whole of it


def main():
    args = parse()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cpu" and os.environ.get("KOIOS_TORCH_THREADS"):
        torch.set_num_threads(int(os.environ["KOIOS_TORCH_THREADS"]))  # the doctor says which is fastest here
    try:
        env, sim = make(args)
    except Exception as error:
        print(f"the project's environment can't give frames ({error}); using the built-in ball world")
        env, sim = Ball(), "builtin/ball"
    run = Run("world-model", config={**vars(args), "device": str(device)}, sim=sim, video_every=0)
    frames, actions = collect(env, args)
    if not frames:
        raise SystemExit("no episode was long enough: lower --seq")
    held_f, held_a = frames.pop(), actions.pop()  # one episode kept out, to dream on
    run.note(f"collected {len(frames)} episodes, {sum(len(f) for f in frames)} frames, action size {actions[0].shape[-1]}", step=0, tag="data")
    run.video("data", held_f, step=0, fps=float(env.metadata.get("render_fps") or 20), caption="an episode of the random policy the model learns from")
    model = WorldModel(actions[0].shape[-1], args.latent, args.hidden).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    img = lambda x: torch.as_tensor(x, device=device).permute(0, 1, 4, 2, 3).float() / 255.0  # noqa: E731

    for it in range(1, args.iterations + 1):
        idx = np.random.randint(0, len(frames), args.batch)
        starts = [np.random.randint(0, len(frames[i]) - args.seq) for i in idx]
        x = img(np.stack([frames[i][s:s + args.seq] for i, s in zip(idx, starts)]))  # B, T, 3, 64, 64
        a = torch.as_tensor(np.stack([actions[i][s:s + args.seq] for i, s in zip(idx, starts)]), device=device)
        B, T = x.shape[:2]
        mu, logvar = model.encode(x.flatten(0, 1))
        z = mu + torch.randn_like(mu) * (0.5 * logvar).exp()
        recon = F.mse_loss(model.decode(z), x.flatten(0, 1))
        kl = -0.5 * torch.mean(1 + logvar - mu.pow(2) - logvar.exp())
        target = mu.view(B, T, -1).detach()
        h = torch.zeros(B, model.hidden, device=device)
        dyn, count = 0.0, 0
        for t in range(T - 1):
            # Teacher forcing for the first step, then `overshoot` steps on the model's own predictions.
            zt, ht = target[:, t], h
            for k in range(min(args.overshoot, T - 1 - t)):
                zt, ht = model.step(zt, a[:, t + k], ht)
                dyn = dyn + F.mse_loss(zt, target[:, t + k + 1])
                count += 1
                if k == 0:
                    h_next = ht
            h = h_next
        dyn = dyn / max(count, 1)
        loss = recon + args.kl * kl + dyn
        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 100.0)
        opt.step()
        if it % 25 == 0:
            run.log({"loss/recon": recon.item(), "loss/kl": kl.item(), "loss/dynamics": dyn.item(), "loss/total": loss.item()}, step=it)
        if it % args.dream_every == 0 or it == args.iterations:
            dream(model, run, held_f, held_a, args, device, it)
    torch.save(model.state_dict(), f"{run.dir}/world_model.pt")
    run.checkpoint(f"{run.dir}/world_model.pt", step=args.iterations)
    run.finish()


@torch.no_grad()
def dream(model, run, frames, actions, args, device, step):
    n = min(len(frames), args.context + args.horizon)
    x = torch.as_tensor(frames[:n], device=device).permute(0, 3, 1, 2).float() / 255.0
    a = torch.as_tensor(actions[:n], device=device)
    mu, _ = model.encode(x)
    h = torch.zeros(1, model.hidden, device=device)
    z = mu[:1]
    imagined = [model.decode(z)[0]]
    for t in range(n - 1):
        z_pred, h = model.step(z, a[t:t + 1], h)
        # Real frames while in the context, then only its own predictions: that is the dream.
        z = mu[t + 1:t + 2] if t + 1 < args.context else z_pred
        imagined.append(model.decode(z_pred if t + 1 >= args.context else z)[0])
    imagined = torch.stack(imagined).permute(0, 2, 3, 1).cpu().numpy()
    errors = run.dream("dream", frames[:n], imagined, step=step, fps=10, context=args.context)
    if errors:
        rest = errors[args.context:] or errors
        run.log({"dream/error_first": rest[0], "dream/error_last": rest[-1], "dream/error_mean": float(np.mean(rest))}, step=step)
        # The world model's evaluation: open-loop prediction error over the horizon (lower is better). A paper may
        # measure it otherwise (PSNR, SSIM, a downstream task): read paper/paper.md and log that instead, with its numbers.
        run.evaluation({"dream/error_first": rest[0], "dream/error_last": rest[-1], "dream/error_mean": float(np.mean(rest))}, name="open-loop", step=step, protocol=f"per-frame MSE of imagined against real frames after {args.context} context frames, {len(rest)} steps ahead", higher_is_better=False)


if __name__ == "__main__":
    main()
