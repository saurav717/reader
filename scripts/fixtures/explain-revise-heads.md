<<<replace: Multi-head attention>>>
## Multi-head attention

Think of reading a sentence with a group of friends, each told to look for something different. One friend only cares about *who did what*. Another only tracks *which word came just before*. A third watches for *what a pronoun points back to*. Afterwards you pool their notes. That is multi-head attention: **h = 8 heads**, each its own small attention, each free to learn its own notion of "relevant", with the results glued back together.

The trick that keeps it cheap: each head works in a smaller space (d_k = 64 instead of 512), so eight small heads cost about the same as one big one. You get eight opinions for the price of one.

```figure caption="Three heads reading the same sentence. Each learns to look for something different, and their outputs are concatenated."
<svg viewBox="0 0 560 210" xmlns="http://www.w3.org/2000/svg">
  <text x="20" y="22" font-size="12" class="t-muted">head 1 — who did what</text>
  <text x="20" y="92" font-size="12" class="t-muted">head 2 — the word before</text>
  <text x="20" y="162" font-size="12" class="t-muted">head 3 — what “it” means</text>
  <g font-size="13" text-anchor="middle">
    <text x="230" y="50">The</text><text x="290" y="50">cat</text><text x="350" y="50">chased</text><text x="420" y="50">it</text>
    <text x="230" y="120">The</text><text x="290" y="120">cat</text><text x="350" y="120">chased</text><text x="420" y="120">it</text>
    <text x="230" y="190">The</text><text x="290" y="190">cat</text><text x="350" y="190">chased</text><text x="420" y="190">it</text>
  </g>
  <path d="M350 36 Q320 14 290 36" fill="none" class="s-accent" stroke-width="2.5" />
  <path d="M290 106 Q260 86 230 106 M350 106 Q320 86 290 106 M420 106 Q385 86 350 106" fill="none" class="s-muted" stroke-width="2" />
  <path d="M420 176 Q355 140 290 176" fill="none" class="s-accent" stroke-width="2.5" />
  <rect x="470" y="30" width="70" height="160" rx="10" class="f-soft" />
  <text x="505" y="104" font-size="12" text-anchor="middle">concat</text>
  <text x="505" y="120" font-size="12" text-anchor="middle">+ W_O</text>
</svg>
```

The paper's own visualisations show exactly this kind of specialisation. Nobody tells a head what to look for; training finds the split that helps.

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

Even with random weights the heads already disagree about where token 0 should look. That diversity is what training sharpens.

```caveat verdict="refined" title="All heads are needed"
Michel et al. (2019) found many heads can be pruned after training with little loss. Modern LLMs keep many *query* heads but share keys and values between them — multi-query (Shazeer, 2019) and grouped-query attention (Ainslie et al., 2023) — to shrink the KV cache at inference time.
```
<<<note>>>
Rewrote “Multi-head attention” around an analogy, with a figure of three heads reading the same sentence.
