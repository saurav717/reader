<<<replace: Scaled dot-product attention>>>
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

```motion title="One token looks the others up" figure="The pipeline, left to right: match queries against keys, scale, normalise into weights, and use the weights to mix the values."
{"nodes":[{"id":"x","kind":"input","label":"the cat sat down","col":0,"row":1},
          {"id":"q","kind":"box","label":"Q = xW_Q","col":1,"row":0,"tone":"blue"},
          {"id":"k","kind":"box","label":"K = xW_K","col":1,"row":1,"tone":"yellow"},
          {"id":"v","kind":"box","label":"V = xW_V","col":1,"row":2},
          {"id":"w","kind":"dist","label":"softmax(QKᵀ/√d)","col":2,"row":1,"values":[0.25,0.25,0.25,0.25],"labels":["the","cat","sat","down"],"tone":"accent"},
          {"id":"out","kind":"box","label":"Σ w·V","col":3,"row":1,"tone":"pink","step":3}],
 "edges":[{"from":"x","to":"q","flow":"forward"},{"from":"x","to":"k","flow":"forward"},{"from":"x","to":"v","flow":"forward"},
          {"from":"q","to":"w","flow":"forward","step":1},{"from":"k","to":"w","flow":"forward","step":1},
          {"from":"w","to":"out","flow":"forward","step":3},{"from":"v","to":"out","flow":"forward","step":3}],
 "steps":[{"caption":"Every token is turned into a query, a key and a value."},
          {"caption":"Each query is matched against every key, and the scores are scaled by √d.","highlight":["q","k"]},
          {"caption":"The softmax turns the scores into weights that sum to one: \"cat\" mostly attends to itself.","highlight":["w"],"set":{"w":[0.02,0.89,0.04,0.05]}},
          {"caption":"The output is the values, mixed by those weights.","highlight":["out"],"dim":["q","k"]}]}
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
<<<note>>>
Added a scene after the pipeline figure: one token looking the others up, a step a paragraph.
