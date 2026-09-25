## At a glance

- **What you will build:** a pruning-and-distillation pipeline that takes a pretrained decoder-only LM, scores every neuron, head, embedding channel and block by activation importance, cuts the least important ones to a target size, and retrains the pruned model with **logit distillation** from the original — the recipe the paper uses to turn Nemotron-4 15B into 8B and 4B models for a fraction of the cost of training from scratch.
- **The smallest faithful reproduction:** a 1.5B teacher pruned to about 0.8B, distilled on 1B tokens of public web text. It exercises every part of the method — importance estimation, width and depth pruning, the lightweight architecture search, distillation — at a scale one card can carry.
- **On your machine (1× T4, 16 GB, Colab free):** the small version fits with 8-bit Adam and a micro-batch of 2, and takes about five days of Colab sessions. The paper's own scale (15B → 8B on 94B tokens) is a cluster job: thousands of H100-hours.
- **What you will not get:** the paper's numbers. Its teacher, data and token budget are all larger; expect the *shape* of the result — a pruned-and-distilled model beating one trained from scratch on the same tokens — not its MMLU.

Worth building if you run models on your own hardware and want small ones that keep a large one's behaviour.

## What to build, and what to leave out

The paper is a set of best practices as much as a method. Most of it is cheap to build; the expensive parts are the teacher and the tokens.

| Component | In the paper | Build it? | Why |
| --- | --- | --- | --- |
| Activation-based importance (neurons, heads, embedding channels) | §3.1, Eq. 1–3 | **Yes** | The heart of it, and a few hundred lines. |
| Block importance for depth pruning (perplexity and BI) | §3.1 | **Yes** | Both scores are one forward pass each over a calibration set. |
| Iterative importance estimation | §3.1, ablated in §4 | **Skip** | The paper finds single-shot as good; keep a flag for it. |
| Lightweight neural architecture search over pruned candidates | §3.2 | **Simplify** | Enumerate 4 candidates instead of the paper's dozens; train each on 100M tokens. |
| Retraining with logit distillation | §3.3, Eq. 4 | **Yes** | The step that makes pruning work; a KL loss on the teacher's logits. |
| Intermediate-state distillation (hidden states, embeddings) | §3.3, Eq. 5–6 | **Simplify** | Implement the hidden-state term behind a flag; the paper only needs it for depth pruning. |
| Teacher = Nemotron-4 15B; 94B distillation tokens | §4 | **Substitute** | Not public, and not affordable. A 1.5B Apache-2.0 teacher and 1B tokens. |
| Instruction tuning of the pruned model | §4.3 | **Skip** | A separate recipe; the base-model comparison is the paper's claim. |

### Width first, depth second

The paper's fourth best practice: for models up to 15B, prune **width** (neurons, heads, embedding channels) rather than **depth** (whole blocks), and combine the two only after width alone. The plan follows it: the first milestone prunes width only, and depth pruning is a later, optional milestone. The alternative — depth first — is simpler to implement (delete blocks) but the paper shows it loses more accuracy at the same size.

### Single-shot importance, then retrain

Compute the importance scores once, on the unpruned teacher, and prune to the target in one step; the iterative variant (prune a little, re-score, repeat) is ablated in the paper and found not to help. It stays behind `--iterative` because it is three lines.

### Logits only, no temperature

The distillation loss is the KL divergence between the teacher's and the student's next-token distributions, at temperature 1, on every position of every sequence. The paper reports that adding the language-modelling loss on the ground truth *hurts*, so it is off by default, behind `--lm_weight`.

## Datasets

The paper distils on the second phase of Nemotron-4's own pretraining mix, which is not released. What matters about it is that it is **the teacher's own distribution**: clean web text plus code, at 8k context. The public substitute below is that kind of data.

| Dataset | For | Size | Licence | Where |
| --- | --- | --- | --- | --- |
| FineWeb-Edu, `sample-10BT` | Distillation tokens, and the candidates' 100M each | 10B tokens, ~28 GB parquet | ODC-By 1.0 | `HuggingFaceFW/fineweb-edu` |
| The same, first 1024 documents | Calibration set for importance estimation | 1024 × 4096 tokens | ODC-By 1.0 | sliced from the above |
| Qwen2.5-1.5B (base) | The teacher, and what is pruned | 1.5B parameters, 3.1 GB | Apache 2.0 | `Qwen/Qwen2.5-1.5B` |
| MMLU, HellaSwag, ARC, WinoGrande | Evaluation | a few hundred MB | mixed, all research-use | via `lm-evaluation-harness` |

You need 1B tokens of the 10B sample, so stream it rather than download all of it. Tokenise once into a flat `uint32` memmap: with 4096-token sequences that is 4 GB, and the training loop reads it without a dataloader in the way.

```bash title="Get the teacher and a 1B-token slice of FineWeb-Edu"
pip install -q "transformers>=4.45" "datasets>=3.0" accelerate bitsandbytes lm-eval
huggingface-cli download Qwen/Qwen2.5-1.5B --local-dir models/teacher --exclude "*.safetensors.index.json.bak"
python scripts/prepare_data.py \
  --dataset HuggingFaceFW/fineweb-edu --config sample-10BT --split train \
  --tokenizer models/teacher --tokens 1_000_000_000 --seq_len 4096 \
  --out data/fineweb_edu_1b.bin
python scripts/prepare_data.py --tokenizer models/teacher --tokens 4_200_000 --seq_len 4096 --out data/calib.bin
```

```output
teacher: 1.54B parameters, 28 layers, hidden 1536, 12 heads (2 KV), intermediate 8960
data/fineweb_edu_1b.bin: 244,140 sequences × 4096 tokens (1.00B tokens, 4.0 GB)
data/calib.bin: 1,024 sequences × 4096 tokens
```

How much the substitution changes the result: the paper's own follow-up finds that distilling on data the teacher was **not** trained on costs accuracy unless the teacher is first fine-tuned on it briefly ("teacher correction"). Qwen2.5 saw a great deal of web text, so FineWeb-Edu is close to its distribution, but the pipeline keeps a `--correct_teacher` step of 50M tokens for the case where it is not.

```caveat verdict="refined" title="Distil on the teacher's own data"
The paper distils on the teacher's continued-pretraining data. Its follow-up, *LLM Pruning and Distillation in Practice: The Minitron Approach* (Sreenivas et al., 2024), adds **teacher correction** — fine-tune the teacher on the distillation data first — for the case, which is yours, where the data is not the teacher's. Budget it in when the teacher was not trained on your data.
```

## Repository layout

One package, three entry points — `prune`, `distill`, `evaluate` — and configs that name every number the paper gives or leaves out. Nothing here depends on a training framework: a plain PyTorch loop with `accelerate` for mixed precision and, later, more than one card.

```tree
minitron-repro/
├── configs/
│   ├── teacher.yaml            # which model, dtype, where it lives
│   ├── prune_width_0.8b.yaml   # the target: heads, neurons, channels to keep
│   ├── prune_depth_0.8b.yaml   # the depth variant, for milestone 8
│   └── distill.yaml            # tokens, batch, lr, the loss weights
├── minitron/
│   ├── __init__.py
│   ├── importance.py           # activation statistics: Eq. 1–3, block importance
│   ├── prune.py                # cut the weights to the chosen shape
│   ├── search.py               # enumerate candidates at the target size, short-train, pick
│   ├── distill.py              # the KL loss (Eq. 4) and the hidden-state term (Eq. 5)
│   ├── data.py                 # the memmap of tokens, batches, the calibration set
│   └── train.py                # the loop: accelerate, grad accumulation, checkpoints
├── scripts/
│   ├── prepare_data.py         # download, tokenise, write the memmap
│   ├── prune.py                # python -m scripts.prune configs/prune_width_0.8b.yaml
│   ├── distill.py              # python -m scripts.distill configs/distill.yaml
│   └── evaluate.sh             # lm-eval on the five benchmarks
├── tests/
│   ├── test_importance.py      # scores are permutation-equivariant; top-k picks the loud neurons
│   └── test_prune.py           # a pruned model's forward pass matches the sliced teacher's
├── data/                       # memmaps (gitignored)
├── models/                     # teacher, pruned candidates, checkpoints (gitignored)
├── Makefile                    # data, prune, distill, eval targets
├── requirements.txt
└── README.md
```

`importance.py` owns statistics and nothing else: it registers forward hooks on the teacher, runs the calibration set, and returns one tensor of scores per prunable axis. `prune.py` turns scores into index sets and slices the weights; it never runs the model. `search.py` composes the two for several targets and calls `train.py` for a short run each. `distill.py` is just the loss. Keeping the four apart is what makes the ablations in the paper one flag each.

## Starter files

```file path="configs/prune_width_0.8b.yaml"
# The target shape. The paper prunes Nemotron-4 15B (hidden 6144, 48 heads,
# intermediate 24576, 32 layers) to 8B by width: hidden 4096, 32 heads,
# intermediate 16384, keeping every layer. This is the same ratios applied to
# Qwen2.5-1.5B (hidden 1536, 12 heads / 2 KV, intermediate 8960, 28 layers).
teacher: models/teacher
target_params: 0.8e9

width:
  hidden_size: 1024          # embedding channels to keep (Eq. 3 ranks them)
  num_attention_heads: 8     # heads to keep (Eq. 2); KV heads are kept whole
  intermediate_size: 5632    # MLP neurons to keep (Eq. 1)
depth:
  num_layers: 28             # width only: every block stays

importance:
  calibration: data/calib.bin
  batch_size: 8
  seq_len: 4096
  aggregate_batch: mean      # the paper's choice for the batch axis (Table 3)
  aggregate_seq: mean        # and for the sequence axis
  iterative: false           # single-shot (best practice 4)

out: models/pruned_0.8b
seed: 0
```

```file path="minitron/importance.py"
"""Activation-based importance, §3.1.

For every prunable axis the score of an element is the magnitude of the
activation that flows through it, over a small calibration set:

  neuron i in the MLP:     F_neuron(i) = sum_{B,L} X(W1_i^T)          (Eq. 1)
  head i in attention:     F_head(i)   = sum_{B,L} ||Attn(Q_i K_i V_i)||_2   (Eq. 2)
  embedding channel i:     F_emb(i)    = sum_{B,L} LN(X)_i             (Eq. 3)

where B is the batch axis, L the sequence axis, and the sums are replaced by
the aggregation the config names (mean, l2, variance). Depth: a block's
importance is the perplexity of the model with that block removed, or BI —
one minus the cosine between the block's input and output.
"""
from __future__ import annotations

import torch
from torch import nn

AGG = {
    "mean": lambda x, dim: x.mean(dim),
    "sum": lambda x, dim: x.sum(dim),
    "l2": lambda x, dim: x.pow(2).sum(dim).sqrt(),
    "var": lambda x, dim: x.var(dim),
}


class Importance:
    """Registers hooks on one decoder block per prunable tensor and accumulates scores."""

    def __init__(self, model: nn.Module, agg_batch: str = "mean", agg_seq: str = "mean"):
        self.model = model
        self.ab, self.aseq = AGG[agg_batch], AGG[agg_seq]
        self.neuron: list[torch.Tensor] = []   # one (intermediate,) tensor a layer
        self.head: list[torch.Tensor] = []     # one (num_heads,) tensor a layer
        self.emb = torch.zeros(model.config.hidden_size)
        self.handles = []

    def _hook_mlp(self, layer_idx: int):
        def hook(_module, _inp, out):            # out: (B, L, intermediate) — the gated activation
            score = self.aseq(self.ab(out.abs().float(), 0), 0)
            self.neuron[layer_idx] += score.cpu()
        return hook

    def _hook_heads(self, layer_idx: int, n_heads: int, head_dim: int):
        def hook(_module, inp, _out):            # inp[0]: (B, L, n_heads*head_dim) into o_proj
            x = inp[0].float().view(*inp[0].shape[:2], n_heads, head_dim)
            score = self.aseq(self.ab(x.norm(dim=-1), 0), 0)
            self.head[layer_idx] += score.cpu()
        return hook

    def _hook_emb(self, _module, _inp, out):     # out of the final norm: (B, L, hidden)
        self.emb += self.aseq(self.ab(out.abs().float(), 0), 0).cpu()

    @torch.no_grad()
    def run(self, batches) -> dict[str, torch.Tensor | list[torch.Tensor]]:
        cfg = self.model.config
        head_dim = cfg.hidden_size // cfg.num_attention_heads
        for i, block in enumerate(self.model.model.layers):
            self.neuron.append(torch.zeros(cfg.intermediate_size))
            self.head.append(torch.zeros(cfg.num_attention_heads))
            self.handles.append(block.mlp.act_fn.register_forward_hook(self._hook_mlp(i)))
            self.handles.append(block.self_attn.o_proj.register_forward_hook(self._hook_heads(i, cfg.num_attention_heads, head_dim)))
        self.handles.append(self.model.model.norm.register_forward_hook(self._hook_emb))
        for batch in batches:
            self.model(input_ids=batch.to(self.model.device))
        for h in self.handles:
            h.remove()
        return {"neuron": self.neuron, "head": self.head, "emb": self.emb}


@torch.no_grad()
def block_importance(model: nn.Module, batches) -> torch.Tensor:
    """BI, the paper's cheaper depth score: 1 − cos(input, output) of each block, averaged."""
    scores = torch.zeros(len(model.model.layers))
    for batch in batches:
        hs = model(input_ids=batch.to(model.device), output_hidden_states=True).hidden_states
        for i in range(len(scores)):
            x, y = hs[i].float().flatten(0, 1), hs[i + 1].float().flatten(0, 1)
            scores[i] += (1 - torch.cosine_similarity(x, y, dim=-1)).mean().cpu()
    return scores / len(batches)
```

```file path="minitron/distill.py"
"""The retraining loss, §3.3.

  L_logits = KL( p_teacher(x) || p_student(x) )     summed over the sequence   (Eq. 4)
  L_is     = sum_k || W_k h_student_k − h_teacher_k ||_2^2                    (Eq. 5, optional)

The paper distils at temperature 1 and finds that adding the plain
cross-entropy on the ground truth hurts, so lm_weight defaults to 0.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F


def logit_kl(student_logits: torch.Tensor, teacher_logits: torch.Tensor, temperature: float = 1.0) -> torch.Tensor:
    """KL(p_t || p_s), averaged over every position. Both logits: (B, L, V)."""
    t = F.log_softmax(teacher_logits.float() / temperature, dim=-1)
    s = F.log_softmax(student_logits.float() / temperature, dim=-1)
    # F.kl_div wants log-probabilities of the student first, and the target as probabilities.
    return F.kl_div(s, t, log_target=True, reduction="batchmean") * temperature**2 / student_logits.shape[1]


def hidden_state_loss(student_hidden: list[torch.Tensor], teacher_hidden: list[torch.Tensor], maps: torch.nn.ModuleList) -> torch.Tensor:
    """Eq. 5: a learned linear map lifts each chosen student state to the teacher's width."""
    total = student_hidden[0].new_zeros(())
    for k, (hs, ht) in enumerate(zip(student_hidden, teacher_hidden)):
        total = total + F.mse_loss(maps[k](hs.float()), ht.float())
    return total


def distillation_loss(student_out, teacher_out, labels, *, lm_weight: float = 0.0, is_weight: float = 0.0, maps=None) -> dict[str, torch.Tensor]:
    kl = logit_kl(student_out.logits, teacher_out.logits)
    loss = kl
    parts = {"kl": kl.detach()}
    if lm_weight:
        lm = F.cross_entropy(student_out.logits[:, :-1].flatten(0, 1).float(), labels[:, 1:].flatten())
        loss = loss + lm_weight * lm
        parts["lm"] = lm.detach()
    if is_weight and maps is not None:
        # TODO: pick the student/teacher layer pairs in the config (the paper maps every student layer to one of the teacher's)
        hs = hidden_state_loss(student_out.hidden_states[1:], teacher_out.hidden_states[1:], maps)
        loss = loss + is_weight * hs
        parts["is"] = hs.detach()
    parts["loss"] = loss
    return parts
```

```file path="minitron/train.py"
"""The distillation loop: the teacher frozen in bf16, the student trained with
accelerate, gradient accumulation to the paper's batch of 1024 sequences,
checkpoints every N steps so a Colab session that ends can pick up again."""
from __future__ import annotations

import math
import time
from pathlib import Path

import torch
from accelerate import Accelerator
from transformers import AutoModelForCausalLM

from minitron.data import TokenBatches
from minitron.distill import distillation_loss


def train(cfg: dict) -> None:
    acc = Accelerator(mixed_precision="bf16", gradient_accumulation_steps=cfg["grad_accum"])
    teacher = AutoModelForCausalLM.from_pretrained(cfg["teacher"], torch_dtype=torch.bfloat16).eval().requires_grad_(False)
    student = AutoModelForCausalLM.from_pretrained(cfg["student"], torch_dtype=torch.bfloat16)
    student.gradient_checkpointing_enable()
    if cfg.get("optimizer") == "adamw8bit":
        import bitsandbytes as bnb                      # 8-bit states: 16 → 10 bytes a parameter
        opt = bnb.optim.AdamW8bit(student.parameters(), lr=cfg["lr"], betas=(0.9, 0.95), weight_decay=0.1)
    else:
        opt = torch.optim.AdamW(student.parameters(), lr=cfg["lr"], betas=(0.9, 0.95), weight_decay=0.1)
    steps = cfg["tokens"] // (cfg["batch_size"] * cfg["seq_len"])
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, s / cfg["warmup"]) * (0.5 * (1 + math.cos(math.pi * min(1, s / steps)))))
    student, opt, sched = acc.prepare(student, opt, sched)
    teacher = teacher.to(acc.device)
    batches = TokenBatches(cfg["data"], cfg["micro_batch"], cfg["seq_len"], seed=cfg["seed"])
    out = Path(cfg["out"]); out.mkdir(parents=True, exist_ok=True)
    step = batches.resume(out)                          # picks up after the last checkpoint, if any
    t0 = time.time()
    for ids in batches:
        with acc.accumulate(student):
            with torch.no_grad():
                t_out = teacher(input_ids=ids)
            s_out = student(input_ids=ids)
            parts = distillation_loss(s_out, t_out, ids, lm_weight=cfg.get("lm_weight", 0.0))
            acc.backward(parts["loss"])
            acc.clip_grad_norm_(student.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        if acc.sync_gradients:
            step += 1
            if step % cfg["log_every"] == 0 and acc.is_main_process:
                tok_s = step * cfg["batch_size"] * cfg["seq_len"] / (time.time() - t0)
                acc.print(f"step {step}/{steps}  kl {parts['kl']:.4f}  lr {sched.get_last_lr()[0]:.2e}  {tok_s:,.0f} tok/s")
            if step % cfg["ckpt_every"] == 0 or step == steps:
                acc.wait_for_everyone()
                acc.unwrap_model(student).save_pretrained(out / f"step-{step}", safe_serialization=True)
                batches.save_state(out, step)
            if step >= steps:
                break
```

```file path="configs/distill.yaml"
# §4: batch 1024 × 8192 tokens, cosine to 10% of peak, warmup, WD 0.1, β=(0.9, 0.95).
# Scaled: 1B tokens, 4096 context, batch 256 sequences. On one 16 GB card the
# micro-batch is 2 with 128 accumulation steps; on an 80 GB card 16 and 16.
teacher: models/teacher
student: models/pruned_0.8b
data: data/fineweb_edu_1b.bin
out: models/distilled_0.8b

tokens: 1_000_000_000
seq_len: 4096
batch_size: 256          # sequences a step
micro_batch: 2           # sequences a card a forward pass — raise it on a bigger card
grad_accum: 128          # batch_size / (micro_batch × cards)

lr: 1.0e-4               # the paper's peak for 8B; higher is safe for a smaller student
warmup: 100
optimizer: adamw8bit     # plain adamw once there is memory to spare
lm_weight: 0.0           # the paper: ground-truth loss hurts (Table 5)
is_weight: 0.0           # hidden-state distillation, for depth-pruned students
log_every: 10
ckpt_every: 200          # ≈ every 200M tokens; a Colab session ends around 12 h
seed: 0
```

```file path="Makefile"
# Every step of the plan, in order. `make all` runs them all; each is safe to rerun.
PY ?= python
CFG_PRUNE ?= configs/prune_width_0.8b.yaml
CFG_DISTILL ?= configs/distill.yaml

.PHONY: all data teacher prune search distill eval test

all: data prune distill eval

data: data/fineweb_edu_1b.bin data/calib.bin
data/fineweb_edu_1b.bin:
	$(PY) scripts/prepare_data.py --dataset HuggingFaceFW/fineweb-edu --config sample-10BT --split train \
	  --tokenizer models/teacher --tokens 1_000_000_000 --seq_len 4096 --out $@
data/calib.bin:
	$(PY) scripts/prepare_data.py --tokenizer models/teacher --tokens 4_200_000 --seq_len 4096 --out $@

teacher:
	huggingface-cli download Qwen/Qwen2.5-1.5B --local-dir models/teacher

prune: data/calib.bin
	$(PY) -m scripts.prune $(CFG_PRUNE)

search: data/calib.bin
	$(PY) -m minitron.search $(CFG_PRUNE) --candidates 4 --tokens 100_000_000

distill: data/fineweb_edu_1b.bin
	$(PY) -m scripts.distill $(CFG_DISTILL)

eval:
	bash scripts/evaluate.sh models/distilled_0.8b/step-953

test:
	$(PY) -m pytest -q tests
```

## The pipeline, step by step

```figure caption="The pipeline: a calibration set scores the teacher, the scores choose what to cut, the pruned model is retrained against the teacher's logits, and the same benchmarks judge both."
<svg viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="30" width="120" height="52" rx="10" class="f-soft"/>
  <text x="70" y="52" font-size="12" text-anchor="middle">Teacher</text>
  <text x="70" y="68" font-size="11" text-anchor="middle" class="t-muted">1.5B, frozen</text>
  <rect x="10" y="150" width="120" height="52" rx="10" class="f-yellow"/>
  <text x="70" y="172" font-size="12" text-anchor="middle">Calibration set</text>
  <text x="70" y="188" font-size="11" text-anchor="middle" class="t-muted">1024 × 4096 tokens</text>
  <path d="M130 56 H180" class="s-muted" stroke-width="2" fill="none"/>
  <path d="M130 176 Q160 176 175 130 T200 82" class="s-muted" stroke-width="2" fill="none"/>
  <rect x="180" y="30" width="130" height="52" rx="10" class="f-blue"/>
  <text x="245" y="52" font-size="12" text-anchor="middle">Importance</text>
  <text x="245" y="68" font-size="11" text-anchor="middle" class="t-muted">Eq. 1–3, hooks</text>
  <path d="M310 56 H350" class="s-muted" stroke-width="2" fill="none"/>
  <rect x="350" y="30" width="120" height="52" rx="10" class="f-blue"/>
  <text x="410" y="52" font-size="12" text-anchor="middle">Prune</text>
  <text x="410" y="68" font-size="11" text-anchor="middle" class="t-muted">top-k, slice weights</text>
  <path d="M470 56 H510" class="s-muted" stroke-width="2" fill="none"/>
  <rect x="510" y="30" width="120" height="52" rx="10" class="f-accent"/>
  <text x="570" y="52" font-size="12" text-anchor="middle" class="t-on">Distil</text>
  <text x="570" y="68" font-size="11" text-anchor="middle" class="t-on">KL on logits, 1B tok</text>
  <path d="M70 82 V120 Q70 130 80 130 H560 Q570 130 570 120 V82" class="s-accent" stroke-width="1.6" fill="none" stroke-dasharray="4 3"/>
  <text x="320" y="124" font-size="11" text-anchor="middle" class="t-accent">the teacher's logits, every step</text>
  <rect x="350" y="150" width="280" height="52" rx="10" class="f-green"/>
  <text x="490" y="172" font-size="12" text-anchor="middle">Evaluate both</text>
  <text x="490" y="188" font-size="11" text-anchor="middle" class="t-muted">MMLU · HellaSwag · ARC · WinoGrande</text>
  <path d="M570 82 V150" class="s-muted" stroke-width="2" fill="none"/>
</svg>
```

Build it in this order, and do not move on until the check passes:

1. **Data** (`make data`). Check: the memmap's token count matches, and decoding the first sequence gives readable English.
2. **Importance** (`python -m minitron.importance`). Check: `tests/test_importance.py` — permuting the teacher's neurons permutes the scores; the scores are not all equal; a neuron whose weights you zero scores zero.
3. **Prune to the teacher's own shape** (a no-op target). Check: `tests/test_prune.py` — the "pruned" model's logits equal the teacher's to 1e-5. This catches every off-by-one in the slicing before it costs a GPU-day.
4. **Prune to 0.8B.** Check: the pruned model's perplexity on the calibration set is bad but finite (the paper: it recovers with retraining), and its parameter count is within 5% of the target.
5. **Distil 100M tokens** as a smoke run. Check: the KL loss falls steadily; at the end the pruned model's perplexity is below the untrained baseline you get from step 4 by a wide margin.
6. **The search**, if you have the budget: 4 candidates × 100M tokens, keep the one with the lowest KL. Otherwise take the config's shape.
7. **Distil 1B tokens.** Check: the loss curve; the checkpoint every 200 steps; a session that ends resumes from it.
8. **Evaluate**, teacher and student on the same five benchmarks with the same harness and seeds.

## Compute budget

The paper's own budget, for scale: distilling 15B → 8B on 94B tokens costs a teacher forward pass and a student forward-and-backward on every token, $2 \cdot 15 \times 10^9 \cdot 94 \times 10^9 + 6 \cdot 8 \times 10^9 \cdot 94 \times 10^9 \approx 7.3 \times 10^{21}$ FLOPs — about 5,000 H100-hours at 40% utilisation. That is what makes the paper's claim, that this beats training an 8B from scratch on the same tokens (which would be $6 \cdot 8 \times 10^9 \cdot 94 \times 10^9 = 4.5 \times 10^{21}$, plus the teacher you already have), cheap rather than free.

The scaled version, a 1.5B teacher and a 0.8B student:

```compute
{
  "params_b": 0.8,
  "tokens_b": 1.0,
  "phases": [
    {"name": "Importance estimation", "flops": 1.3e16, "memory_gb": 5, "parallel": false, "note": "one forward pass of the teacher over 4.2M calibration tokens, with hooks"},
    {"name": "Candidate search", "flops": 3.1e18, "memory_gb": 22, "note": "4 pruned candidates, 100M distillation tokens each; skip it to save a third of the total"},
    {"name": "Distillation, 1B tokens", "flops": 7.8e18, "memory_gb": 22, "note": "teacher forward (2 × 1.5B) + student forward and backward (6 × 0.8B), a token at a time"},
    {"name": "Evaluation", "h100_hours": 0.5, "memory_gb": 6, "note": "five benchmarks, teacher and student, with lm-eval"}
  ],
  "min_vram_gb": 22,
  "shrink": "8-bit AdamW saves 5 GB, a micro-batch of 2 with 128 accumulation steps saves most of the activations, and a 2048 context halves the rest: together they bring it under 16 GB. LoRA on the student is a last resort — the paper retrains every weight.",
  "ram_gb": 16,
  "disk_gb": 40
}
```

The sums: distillation is $2 P_t T + 6 P_s T$ with $P_t = 1.5 \times 10^9$, $P_s = 0.8 \times 10^9$, $T = 10^9$, so $3 \times 10^{18} + 4.8 \times 10^{18} = 7.8 \times 10^{18}$ FLOPs. The search is four tenths of that. Importance estimation is one forward pass, $2 P_t \cdot 4.2 \times 10^6$. The memory is the student with AdamW states in mixed precision (16 bytes a parameter, 12.8 GB), the teacher in bf16 (3 GB), and activations with gradient checkpointing at a micro-batch of 2 and 4096 context (about 6 GB). Utilisation is what the page assumes above; a T4 has no bf16 and runs fp16 with a loss scaler, which the loop's `Accelerator` handles if you set `mixed_precision="fp16"` there.

| Scale | Teacher → student | Tokens | Where it runs | What it shows |
| --- | --- | --- | --- | --- |
| The paper | 15B → 8B, 8B → 4B | 94B | a cluster, thousands of H100-hours | the headline numbers |
| Faithful, small | 1.5B → 0.8B | 1B | one card, days | every part of the method, at a size where the effect is clear |
| Smallest that tests the idea | 0.5B → 0.3B (`Qwen2.5-0.5B`) | 100M | a T4, an afternoon | that pruning + distillation beats pruning alone; not that it beats training from scratch |

## Constraints and pitfalls

- **Grouped-query attention.** Qwen2.5 has 12 query heads and 2 KV heads; a pruned head count must stay a multiple of the KV heads, and pruning a KV head means pruning its whole group. The paper's teacher has the same constraint (48 heads, 8 KV). `prune.py` rounds the target down to a multiple and says so.
- **Tied embeddings.** The input embedding and the output projection share weights in this teacher; prune the embedding channels once and both change. Check the tie survives `save_pretrained`.
- **RMSNorm weights are per channel.** When embedding channels go, so must their norm weights in every layer, and the rotary embedding's dimension is per head, not per channel — it does not change.
- **fp16 on a T4.** No bf16, so the loss scaler can overflow on the first steps of a badly pruned model; a warmup of 100 steps and gradient clipping at 1.0 are in the config for that reason.
- **The teacher's logits are large.** $B \times L \times V$ in fp32 for a 150k vocabulary at micro-batch 2 and 4096 context is 4.9 GB; compute the KL in chunks along the sequence, or in bf16, before raising the micro-batch.
- **Licences.** The teacher is Apache 2.0 and FineWeb-Edu is ODC-By; both allow a released model. The paper's models carry the NVIDIA Open Model licence, which does not matter unless you use them.
- **The mistake everyone makes:** comparing the distilled student to the teacher. The paper's comparison is to a model of the *student's* size trained from scratch on the same tokens; that is the claim, and it needs a baseline run you also have to budget for (another $6 P_s T$).

## Evaluation

The paper evaluates base models with 5-shot MMLU and zero-shot HellaSwag, ARC-Challenge, WinoGrande and others through the same harness; its numbers for the models it produced, copied from its Table 1, are what a full-scale reproduction would match (check them against the PDF before trusting a digit):

| Model | MMLU (5-shot) | HellaSwag | ARC-C | WinoGrande |
| --- | --- | --- | --- | --- |
| Nemotron-4 15B (teacher) | 64.2 | 82.3 | 55.5 | 79.1 |
| Minitron 8B | 64.5 | 80.7 | 51.9 | 79.0 |
| Minitron 4B | 58.6 | 75.0 | 50.9 | 74.0 |

For the scaled version the numbers to beat are your own: the teacher's, the pruned-but-untrained model's, and — the paper's real baseline — a 0.8B model trained from scratch on the same 1B tokens. Expect a run-to-run spread of about 0.5 points on MMLU and 1 point on the others at this size; three seeds settle it.

```bash title="The five benchmarks, teacher and student, with lm-eval"
for m in models/teacher models/distilled_0.8b/step-953; do
  lm_eval --model hf --model_args pretrained=$m,dtype=bfloat16 \
    --tasks mmlu,hellaswag,arc_challenge,winogrande --num_fewshot 5 --batch_size 8 \
    --output_path results/$(basename $m)
done
```

```python title="The headline: did distillation recover what pruning lost?"
import numpy as np
rng = np.random.default_rng(0)
# Perplexity on a held-out slice, as a smoke run of the pipeline would print it.
# The paper's picture: pruning alone is catastrophic, retraining recovers most of it.
teacher, pruned, distilled = 9.8, 412.0, 12.6
recovered = (np.log(pruned) - np.log(distilled)) / (np.log(pruned) - np.log(teacher))
print(f"teacher ppl {teacher:.1f}   pruned {pruned:.1f}   distilled {distilled:.1f}")
print(f"log-perplexity gap recovered by distillation: {recovered:.0%}")
```

```output
teacher ppl 9.8   pruned 412.0   distilled 12.6
log-perplexity gap recovered by distillation: 93%
```

## Milestones

1. **Data ready** — the memmap decodes to English, 1B tokens exactly. *Half a day, mostly download.*
2. **Importance tests green** — scores respond to permutation and to zeroed weights. *A day.*
3. **No-op prune matches the teacher** — logits equal to 1e-5. *Half a day, and the day you save later.*
4. **A 0.8B pruned model** — parameter count within 5%, finite perplexity. *An hour.*
5. **100M-token smoke run** — the KL falls; perplexity far below step 4's. *Eight hours on your T4.*
6. **Checkpoint and resume** — kill the run, restart it, the loss curve continues. *An hour.*
7. **The 1B-token distillation** — done, with the curve saved. *Four to five days of sessions on your T4; six hours on an H100.*
8. **Evaluation** — teacher and student on the five benchmarks, three seeds. *Two hours.*
9. **The from-scratch baseline** — the same tokens, the student's shape, no teacher. *Another four days on your T4; the comparison the paper makes.*
10. **Depth pruning, optional** — `prune_depth_0.8b.yaml`, with the hidden-state term on. *Repeat 4–8.*
