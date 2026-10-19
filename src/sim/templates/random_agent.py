"""A random agent: the sanity check before any learning.

It answers the questions every simulation project starts with: does the environment install and run here, what
does it observe, what can it do, how long is an episode, what does a random policy score, and can this machine
record it. Open the Sim pane while it runs; the returns it logs are the floor any learning has to beat.

    python random_agent.py --episodes 20
"""
import argparse

from env import ENV_ID, SIM, make_env
from koios_telemetry import Run


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--episodes", type=int, default=20)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--video-every", type=int, default=5, help="record one episode in this many")
    args = parser.parse_args()

    run = Run("random", config={**vars(args), "env": ENV_ID}, sim=f"{SIM}/{ENV_ID}", video_every=args.video_every)
    env = run.wrap(make_env(render_mode="rgb_array"))
    print("observations:", env.observation_space)
    print("actions:     ", env.action_space)
    run.note(f"observations {env.observation_space}; actions {env.action_space}", step=0, tag="spaces")
    env.action_space.seed(args.seed)
    for episode in range(args.episodes):
        env.reset(seed=args.seed + episode)
        done = False
        while not done:
            _, _, terminated, truncated, _ = env.step(env.action_space.sample())
            done = terminated or truncated
    env.close()
    run.finish()
    print(f"{args.episodes} episodes logged to {run.dir}")


if __name__ == "__main__":
    main()
