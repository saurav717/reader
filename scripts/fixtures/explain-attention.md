## At a glance

- **The claim:** a sequence model needs no recurrence and no convolution. Attention alone — every token looking at every other token — is enough, and it trains far faster.
- **The mechanism:** *scaled dot-product attention*, run as several heads in parallel, stacked six layers deep in an encoder and a decoder.
- **The result:** a new state of the art on WMT 2014 English→German (28.4 BLEU) and English→French (41.8), for a fraction of the training cost of the previous best models.
- **Why it matters now:** this is the architecture under nearly every large language model since — though most of its details have been changed along the way.

Worth reading closely if you work with any modern language, vision or speech model.

## The problem: recurrence is a queue

In 2017 the best translation systems were recurrent networks with attention bolted on. An RNN reads a sentence one token at a time, and each step waits for the one before it. That has two costs the paper goes after.

First, **training cannot be parallelised along the sequence**: a 50-token sentence is 50 steps in a row, however many GPUs you have. Second, **distant words are far apart**: information from token 1 has to survive 49 updates to reach token 50, so long-range dependencies are hard to learn.

Self-attention fixes both at once. Every token is compared with every other token in a single matrix multiply, so the whole sentence is processed in parallel, and any two tokens are exactly **one step** apart.

```figure caption="An RNN passes information along a chain, one step at a time (top). Self-attention connects every token to every other directly, in one parallel step (bottom)."
<svg viewBox="0 0 560 250" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="16" font-size="12" class="t-muted">RNN — O(n) sequential steps between token 1 and token n</text>
  <g>
    <rect x="20" y="34" width="70" height="34" rx="8" class="f-soft" />
    <rect x="130" y="34" width="70" height="34" rx="8" class="f-soft" />
    <rect x="240" y="34" width="70" height="34" rx="8" class="f-soft" />
    <rect x="350" y="34" width="70" height="34" rx="8" class="f-soft" />
    <rect x="460" y="34" width="70" height="34" rx="8" class="f-soft" />
    <text x="55" y="56" font-size="13" text-anchor="middle">the</text>
    <text x="165" y="56" font-size="13" text-anchor="middle">cat</text>
    <text x="275" y="56" font-size="13" text-anchor="middle">sat</text>
    <text x="385" y="56" font-size="13" text-anchor="middle">on</text>
    <text x="495" y="56" font-size="13" text-anchor="middle">mat</text>
    <path d="M90 51 H128 M200 51 H238 M310 51 H348 M420 51 H458" class="s-muted" stroke-width="2" fill="none" />
    <path d="M122 46 l7 5 -7 5 M232 46 l7 5 -7 5 M342 46 l7 5 -7 5 M452 46 l7 5 -7 5" class="s-muted" stroke-width="2" fill="none" />
  </g>
  <text x="0" y="118" font-size="12" class="t-muted">Self-attention — every pair is 1 step apart, all computed at once</text>
  <g fill="none" class="s-accent" stroke-width="1.4" opacity="0.75">
    <path d="M55 200 Q110 140 165 200" /><path d="M55 200 Q165 110 275 200" /><path d="M55 200 Q220 90 385 200" /><path d="M55 200 Q275 70 495 200" />
    <path d="M165 200 Q220 150 275 200" /><path d="M165 200 Q275 120 385 200" /><path d="M165 200 Q330 100 495 200" />
    <path d="M275 200 Q330 150 385 200" /><path d="M275 200 Q385 125 495 200" /><path d="M385 200 Q440 150 495 200" />
  </g>
  <g>
    <rect x="20" y="200" width="70" height="34" rx="8" class="f-accent" />
    <rect x="130" y="200" width="70" height="34" rx="8" class="f-accent" />
    <rect x="240" y="200" width="70" height="34" rx="8" class="f-accent" />
    <rect x="350" y="200" width="70" height="34" rx="8" class="f-accent" />
    <rect x="460" y="200" width="70" height="34" rx="8" class="f-accent" />
    <text x="55" y="222" font-size="13" text-anchor="middle" class="t-on">the</text>
    <text x="165" y="222" font-size="13" text-anchor="middle" class="t-on">cat</text>
    <text x="275" y="222" font-size="13" text-anchor="middle" class="t-on">sat</text>
    <text x="385" y="222" font-size="13" text-anchor="middle" class="t-on">on</text>
    <text x="495" y="222" font-size="13" text-anchor="middle" class="t-on">mat</text>
  </g>
</svg>
```

The price is that comparing every token with every other is **O(n²)** in the sequence length. At sentence length that is cheap; the paper's Table 1 argues it is cheaper than an RNN whenever the sequence is shorter than the model width.

```caveat verdict="refined" title="“Quadratic cost is fine”"
True for 2017 sentence-level translation, where n ≈ 50. It became *the* bottleneck once models read whole documents: most of the long-context work since — sparse and linear attention, and above all FlashAttention (Dao et al., 2022), which keeps the maths exact but reorganises it around GPU memory — exists because of this line.
```

## Scaled dot-product attention

Each token is turned into three vectors: a **query** (what am I looking for?), a **key** (what do I contain?) and a **value** (what do I hand over if chosen?). A token's output is an average of all the values, weighted by how well its query matches each key:

`Attention(Q, K, V) = softmax(Q Kᵀ / √d_k) · V`

That is the whole mechanism. The softmax turns match scores into weights that sum to one, so the output is a *soft lookup*: like a dictionary, but it returns a blend of the entries whose keys are closest.

```figure caption="The pipeline, left to right: match queries against keys, scale, normalise into weights, and use the weights to mix the values."
<svg viewBox="0 0 560 150" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="22" width="44" height="34" rx="7" class="f-blue" /><text x="26" y="44" font-size="13" text-anchor="middle">Q</text>
  <rect x="4" y="74" width="44" height="34" rx="7" class="f-yellow" /><text x="26" y="96" font-size="13" text-anchor="middle">K</text>
  <path d="M48 39 H80 M48 91 H80 V60" fill="none" class="s-muted" stroke-width="1.6" />
  <rect x="80" y="44" width="88" height="34" rx="7" class="f-soft" /><text x="124" y="66" font-size="12" text-anchor="middle">MatMul QKᵀ</text>
  <path d="M168 61 H192" class="s-muted" stroke-width="1.6" />
  <rect x="192" y="44" width="82" height="34" rx="7" class="f-soft" /><text x="233" y="66" font-size="12" text-anchor="middle">÷ √d_k</text>
  <path d="M274 61 H298" class="s-muted" stroke-width="1.6" />
  <rect x="298" y="44" width="82" height="34" rx="7" class="f-accent" /><text x="339" y="66" font-size="12" text-anchor="middle" class="t-on">softmax</text>
  <path d="M380 61 H410" class="s-muted" stroke-width="1.6" />
  <rect x="410" y="44" width="72" height="34" rx="7" class="f-soft" /><text x="446" y="66" font-size="12" text-anchor="middle">× V</text>
  <rect x="410" y="104" width="72" height="34" rx="7" class="f-green" /><text x="446" y="126" font-size="13" text-anchor="middle">V</text>
  <path d="M446 104 V78" class="s-muted" stroke-width="1.6" />
  <path d="M482 61 H510" class="s-muted" stroke-width="1.6" />
  <text x="514" y="66" font-size="12">out</text>
  <text x="339" y="30" font-size="11" text-anchor="middle" class="t-accent">weights sum to 1</text>
</svg>
```

```python title="Self-attention over four tokens, from scratch"
import numpy as np
rng = np.random.default_rng(0)

def attention(Q, K, V):
    scores = Q @ K.T / np.sqrt(K.shape[-1])      # how well each query matches each key
    w = np.exp(scores - scores.max(-1, keepdims=True))
    w /= w.sum(-1, keepdims=True)                 # softmax over the keys
    return w @ V, w                               # a weighted average of the values

tokens = ["the", "cat", "sat", "down"]
X = rng.normal(size=(4, 8))
out, w = attention(X, X, X)                       # self-attention: Q = K = V = X
print("attention weights (rows sum to 1):")
for t, row in zip(tokens, w):
    print(f"  {t:>5}", np.round(row, 2))
print("output shape:", out.shape)
```

```output
attention weights (rows sum to 1):
    the [0.6 0.1 0.2 0.1]
    cat [0.02 0.89 0.04 0.05]
    sat [0.15 0.2  0.56 0.1 ]
   down [0.08 0.3  0.11 0.51]
output shape: (4, 8)
```

### Why divide by √d_k?

The dot product of two random d-dimensional vectors has variance d. With d = 512 the scores are huge, the softmax puts almost all its weight on one key, and its gradient all but vanishes. Dividing by √d brings the variance back to 1 whatever the width, so the model can still spread its attention and still learn. The cell shows the effect directly.

```python title="Without the scale, softmax saturates as the width grows"
import numpy as np
rng = np.random.default_rng(0)

def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)

# 1000 random queries against 10 keys: how peaked is the softmax?
for d in [4, 64, 512]:
    q, K = rng.normal(size=(1000, d)), rng.normal(size=(10, d))
    raw = softmax(q @ K.T).max(-1).mean()
    scaled = softmax(q @ K.T / np.sqrt(d)).max(-1).mean()
    print(f"d={d:>3}  mean top weight: unscaled={raw:.2f}  scaled={scaled:.2f}")
```

```output
d=  4  mean top weight: unscaled=0.59  scaled=0.37
d= 64  mean top weight: unscaled=0.87  scaled=0.33
d=512  mean top weight: unscaled=0.95  scaled=0.31
```

```caveat verdict="holds" title="The √d_k scaling"
Still the default everywhere. Later work tuned *where* the normalisation happens (QK-norm, which normalises queries and keys before the product, is common in large models) but the reasoning in the paper is sound and unchanged.
```

## Multi-head attention

One attention map can only express one notion of “relevant”. So the paper runs **h = 8 heads** in parallel, each with its own small projections (d_k = 64 instead of 512), then concatenates their outputs and mixes them with one more matrix. The total cost is about the same as a single full-width head.

The payoff is that heads specialise: in the paper's visualisations one head tracks the previous word, another resolves what a pronoun refers to, another follows syntax. Each head is a different question asked of the same sentence.

```python title="Eight heads are one reshape away from one"
import numpy as np
rng = np.random.default_rng(0)
d_model, h = 64, 8
d_k = d_model // h
X = rng.normal(size=(6, d_model))                 # 6 tokens
Wq, Wk, Wv = (rng.normal(size=(d_model, d_model)) / np.sqrt(d_model) for _ in range(3))

def split(M):                                     # (6, 64) -> (8 heads, 6, 8)
    return M.reshape(6, h, d_k).transpose(1, 0, 2)

Q, K, V = split(X @ Wq), split(X @ Wk), split(X @ Wv)
scores = Q @ K.transpose(0, 2, 1) / np.sqrt(d_k)  # (8, 6, 6): one map per head
w = np.exp(scores - scores.max(-1, keepdims=True)); w /= w.sum(-1, keepdims=True)
heads = w @ V                                     # (8, 6, 8)
out = heads.transpose(1, 0, 2).reshape(6, d_model)
print("per-head maps:", w.shape, " concatenated:", out.shape)
print("token 0 attends most to, per head:", w[:, 0].argmax(-1))
```

```output
per-head maps: (8, 6, 6)  concatenated: (6, 64)
token 0 attends most to, per head: [0 3 1 1 0 2 2 2]
```

```caveat verdict="refined" title="All heads are needed"
Michel et al. (2019) found many heads can be pruned after training with little loss. Modern LLMs keep many *query* heads but share keys and values between them — multi-query (Shazeer, 2019) and grouped-query attention (Ainslie et al., 2023) — to shrink the KV cache at inference time.
```

## Where is each word? Positional encoding

Attention is a weighted *average*, so it is blind to order: shuffle the tokens and each output is the same. The paper adds a fixed signal to every input embedding — sines and cosines at geometrically spaced frequencies — so that position is part of what each token carries.

The design choice is subtle: for these signals, the similarity between two positions depends only on the **distance** between them, not where they are. The cell checks that.

```python title="Sinusoidal positions: similarity depends only on the gap"
import numpy as np

def sinusoidal(n_pos, d):
    pos = np.arange(n_pos)[:, None]
    i = np.arange(d // 2)[None, :]
    angle = pos / 10000 ** (2 * i / d)
    pe = np.zeros((n_pos, d))
    pe[:, 0::2], pe[:, 1::2] = np.sin(angle), np.cos(angle)
    return pe

pe = sinusoidal(512, 64)
# The dot product between two positions depends (mostly) on how far apart they are:
for gap in [1, 4, 16, 64]:
    sims = [pe[p] @ pe[p + gap] for p in (10, 100, 300)]
    print(f"gap={gap:>2}  similarity at p=10,100,300:", np.round(sims, 2))
```

```output
gap= 1  similarity at p=10,100,300: [30.92 30.92 30.92]
gap= 4  similarity at p=10,100,300: [23.93 23.93 23.93]
gap=16  similarity at p=10,100,300: [19.37 19.37 19.37]
gap=64  similarity at p=10,100,300: [13.91 13.91 13.91]
```

```caveat verdict="superseded" title="Sinusoidal, absolute position encodings"
Largely replaced. Learned absolute positions (BERT, GPT-2) came first; today most LLMs use **rotary embeddings, RoPE** (Su et al., 2021), which rotate queries and keys so relative position enters the dot product itself, or **ALiBi** (Press et al., 2022). The paper's hope that sinusoids would *extrapolate* to longer sequences than seen in training did not really hold in practice.
```

## The block: residuals, LayerNorm and the feed-forward layer

Each of the six encoder layers is attention followed by a small two-layer MLP applied to every token separately (512 → 2048 → 512). Each sub-layer is wrapped in a **residual connection** and followed by **layer normalisation**: `LayerNorm(x + Sublayer(x))`.

The residual path is what lets a deep stack train at all — gradients flow straight down it. The MLP is where most of the parameters are, and later interpretability work suggests it is where much of a model's factual “memory” lives.

```figure caption="The paper puts LayerNorm after the residual add (Post-LN, left). Almost every model since puts it before the sub-layer, leaving the residual path clean (Pre-LN, right)."
<svg viewBox="0 0 560 230" xmlns="http://www.w3.org/2000/svg">
  <text x="130" y="16" font-size="12" text-anchor="middle" class="t-muted">Post-LN (the paper)</text>
  <text x="420" y="16" font-size="12" text-anchor="middle" class="t-muted">Pre-LN (used today)</text>
  <path d="M130 220 V30" class="s-muted" stroke-width="1.5" fill="none" />
  <path d="M130 196 H60 V150" class="s-muted" stroke-width="1.5" fill="none" />
  <rect x="20" y="116" width="80" height="34" rx="7" class="f-blue" /><text x="60" y="138" font-size="12" text-anchor="middle">Attention</text>
  <path d="M60 116 V96 H122" class="s-muted" stroke-width="1.5" fill="none" />
  <circle cx="130" cy="96" r="9" class="f-paper s-ink" stroke-width="1.5" /><text x="130" y="100" font-size="13" text-anchor="middle">+</text>
  <rect x="90" y="46" width="80" height="30" rx="7" class="f-yellow" /><text x="130" y="66" font-size="12" text-anchor="middle">LayerNorm</text>
  <path d="M420 220 V30" class="s-accent" stroke-width="2.5" fill="none" />
  <path d="M420 206 H340 V186" class="s-muted" stroke-width="1.5" fill="none" />
  <rect x="300" y="156" width="80" height="30" rx="7" class="f-yellow" /><text x="340" y="176" font-size="12" text-anchor="middle">LayerNorm</text>
  <rect x="300" y="104" width="80" height="34" rx="7" class="f-blue" /><text x="340" y="126" font-size="12" text-anchor="middle">Attention</text>
  <path d="M340 156 V138 M340 104 V80 H412" class="s-muted" stroke-width="1.5" fill="none" />
  <circle cx="420" cy="80" r="9" class="f-paper s-ink" stroke-width="1.5" /><text x="420" y="84" font-size="13" text-anchor="middle">+</text>
  <text x="440" y="200" font-size="11" class="t-accent">clean residual path</text>
</svg>
```

```caveat verdict="superseded" title="Post-LN placement"
Post-LN trains poorly without a careful learning-rate warm-up, and gets worse with depth. Xiong et al. (2020) showed why; Pre-LN is now the standard (GPT-2 onward), usually with **RMSNorm** instead of LayerNorm. The ReLU feed-forward has likewise mostly given way to gated variants such as **SwiGLU** (Shazeer, 2020).
```

## Training and results

The base model trained for 12 hours on 8 P100 GPUs; the big one for 3.5 days. Two tricks mattered: a learning-rate schedule that **warms up** linearly for 4,000 steps then decays with the inverse square root of the step, and **label smoothing** (ε = 0.1), which makes the model less certain — it hurts perplexity but improves BLEU.

On English→German the big model scored 28.4 BLEU, more than 2 points above the best previous result *including ensembles*, at roughly a tenth of the training FLOPs of the best convolutional and recurrent models.

```caveat verdict="refined" title="BLEU as the measure of translation quality"
BLEU numbers from different papers are often not comparable (tokenisation differs — Post, 2018, introduced sacreBLEU for this reason), and BLEU correlates only loosely with human judgement. Translation is now judged with learned metrics such as COMET and with human evaluation. The paper's *relative* gains are not in doubt.
```

## Since then

The paper's core idea has held up better than almost any in the field: attention over a whole sequence, in parallel, is still the centre of nearly every frontier model. Almost every *detail* around it has been changed.

| Claim or choice in the paper | Verdict | What to use today |
| --- | --- | --- |
| Attention alone is enough; no recurrence | Holds | Transformers everywhere — with state-space models (Mamba) as a serious alternative for very long sequences |
| √d_k scaling | Holds | The same, often with QK-norm |
| Quadratic cost is acceptable | Refined | FlashAttention, sliding-window or sparse attention for long contexts |
| 8 independent heads | Refined | Grouped-query attention |
| Sinusoidal absolute positions | Superseded | RoPE or ALiBi |
| Post-LN, ReLU MLP | Superseded | Pre-LN with RMSNorm, SwiGLU MLP |
| Encoder–decoder for everything | Refined | Decoder-only for language models; encoder–decoder still common for translation and speech |
| BLEU gains | Refined | Report sacreBLEU and COMET alongside |

If you are implementing a Transformer today, read this paper for the *why*, and a recent open model's code (Llama-style) for the *how*.
