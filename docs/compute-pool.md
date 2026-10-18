# The pool: a project on several machines

A project runs on one machine: a Colab machine of its own, or a Jupyter
server of yours (a Companion on your computer, a GPU box). It can run on
several — a **pool**: the first machine and any number more, each a Colab
machine or a server, mixed as you like. A Colab T4 beside your own
computer's GPU is one pool.

This document is what the pool is, what it is not, and why: what Colab
allows, and what it does not. It is the note to come back to before asking
the pool to do something it cannot. How the pool is built — sessions,
kernels, the pool row — and how a run is picked up from another computer are
in [compute-continuity.md](compute-continuity.md), with figures.

## What the pool does

**Separate machines, one job each.** Every machine of the pool has its own
kernel, its own copy of the project's folder, its own row in the Runtime
pane and its own terminals. A command in the console goes to one machine
you pick, or to **all** of them at once. On all, each machine gets the same
command with its place in the pool in the environment:

| Variable        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| `KOIOS_RANK`    | this machine's number, from 0 (the first machine)       |
| `KOIOS_WORLD`   | how many machines got the command                       |
| `KOIOS_MACHINE` | what the machine is, in words: `Colab · T4`, `my-mac`  |

So one script runs a sweep, a few seeds, or an evaluation over slices of a
dataset side by side:

```python
import os
rank, world = int(os.environ.get("KOIOS_RANK", 0)), int(os.environ.get("KOIOS_WORLD", 1))
seed = 1000 + rank
shard = dataset.shard(num_shards=world, index=rank)
```

The files: a project kept in Drive (or on a server) is copied to every
machine before the command runs there, and results come back from each,
as **Copy & run** does for one machine. A project whose files are on its
first machine's disk has them there only; the other machines start empty,
and `git clone` or a copy is the first command.

Adding a machine: the bar's machine chip → **Run on more machines…**, or
the pool row's **Add a machine**. Taking one out stops its Colab runtime
(no more compute units) or shuts down its kernel.

## What the pool is not

**It is not one big machine.** A job on one machine of the pool sees that
machine's GPU and no other. Nothing here makes four T4s look like one GPU
with four times the memory, or runs one training step across them.

The reason is Colab's network, not the app's design:

- **Colab's runtimes take no incoming connections.** A runtime can call out
  (to pip, to Drive, to the Koios proxy) but nothing can call in. Two
  runtimes therefore cannot open a connection to each other. `torch.distributed`
  with NCCL or Gloo needs exactly that, so it cannot run between Colab
  machines.
- **Everything between two runtimes would go through the proxy.** That is
  possible — the proxy already carries each kernel's socket — but a relay
  through Cloudflare or a Node server moves tens of megabytes a second,
  against tens of gigabytes a second for NCCL inside one box. Sharing a
  100M-parameter model's gradients (200 MB in fp16) would take seconds a
  step; a step itself takes a fraction of a second. The GPUs would wait
  far more than they compute, and the job would run slower than on one.
- **Colab has no multi-GPU machines on any tier**, so "one bigger box" is
  not on offer either. For a real multi-GPU machine, point the project at a
  server of yours (a Companion on a box with several GPUs) and use
  `torch.distributed` there as usual.

What this leaves for later, if there is a call for it: a
`torch.distributed` backend over the proxy, usable for training that syncs
rarely or moves little — local SGD averaging every few hundred steps, or
adapters (LoRA) whose deltas are small. It would come with a warning when
a job's traffic per step exceeds what the link carries. It is not built.

## What Colab allows

- **Several runtimes at once, up to the plan's limit.** The free tier
  allows one; Pro and Pro+ allow more. When Colab refuses another (it
  answers 412), the new machine runs on the browser's shared runtime and
  the project says so. Stop a runtime in Colab under Runtime → Manage
  sessions to free a slot.
- **Each runtime costs its own units** while it is up, idle or not. The
  project's idle stop (Settings in the project dialog) applies to every
  Colab machine of the pool, each by its own last activity.
- **Outbound connections from a runtime**, which is what the Koios
  proxy's kernel socket and any future relay use.

## What Colab does not allow

- **Incoming connections**, as above.
- **Remote desktops, SSH shells and proxies that bypass its limits**, by
  its terms of use. The pool coordinates jobs through the same outbound
  socket the kernel already uses, and opens no shell to the outside; a
  general tunnel exposing a shell on a runtime would be outside the terms,
  and is not something the app will do.
- **Several accounts to get past the runtime limit**, by the same terms.
  The pool runs on the one signed-in account.

## Where things are

- The record: `pool` on a project (`src/lib/playground.ts`, `PoolMember`),
  with `machinesOf`, `memberScope` and `poolEnv`.
- The sessions: one a machine, by scope `<project>#<member>`
  (`src/lib/colab.ts`); `connectIn`, `interruptIn`, `stopRuntimeIn` and
  `probeIn` drive one by its scope, and the pulse reads every machine of
  the open project.
- The row and the add panel: `src/components/MachinePool.tsx`. The console's
  **on** selector, the per-machine terminals and the stacked Runtime panes:
  `src/components/PlaygroundWorkspace.tsx`.
