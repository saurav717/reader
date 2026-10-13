A notebook that builds the paper's attention from scratch, checks it, and trains a tiny Transformer on this runtime.

```markdown notebook=new
# Attention Is All You Need — try it

Scaled dot-product attention and multi-head attention from §3.2, built in PyTorch and checked on the GPU; then a small Transformer trained for a few hundred steps so the loss curve can be watched.
```

```python
# showcase: setup
import math, time, torch, torch.nn as nn, torch.nn.functional as F
torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
print("device:", device, "-", torch.cuda.get_device_name(0) if device == "cuda" else "no GPU")
print("torch", torch.__version__)
```

```markdown
## Scaled dot-product attention (Eq. 1)

$$\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^{\top}}{\sqrt{d_k}}\right) V$$

where $Q$, $K$ and $V$ are the queries, keys and values and $d_k$ is the width of a key. The rows of the softmax are weights that sum to one.
```

```python
# showcase: attention
def attention(q, k, v, mask=None):
    scores = q @ k.transpose(-2, -1) / math.sqrt(q.size(-1))
    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))
    w = F.softmax(scores, dim=-1)
    return w @ v, w

q = k = v = torch.randn(1, 4, 8, device=device)
out, w = attention(q, k, v)
print("attention weights (rows sum to 1):")
print(w[0].cpu().numpy().round(2))
print("output shape:", tuple(out.shape))
```

```markdown
## Multi-head attention (§3.2.2)

The same attention $h = 8$ times on projected queries, keys and values, the heads concatenated and projected once more. The paper's point: each head can attend to a different kind of relation.
```

```python
# showcase: heads
class MultiHead(nn.Module):
    def __init__(self, d_model=512, h=8):
        super().__init__()
        self.h, self.d_k = h, d_model // h
        self.wq, self.wk, self.wv, self.wo = (nn.Linear(d_model, d_model) for _ in range(4))
    def forward(self, q, k, v, mask=None):
        b = q.size(0)
        split = lambda x, w: w(x).view(b, -1, self.h, self.d_k).transpose(1, 2)
        out, _ = attention(split(q, self.wq), split(k, self.wk), split(v, self.wv), mask)
        return self.wo(out.transpose(1, 2).reshape(b, -1, self.h * self.d_k))

mha = MultiHead().to(device)
x = torch.randn(2, 10, 512, device=device)
print("multi-head output:", tuple(mha(x, x, x).shape))
print("parameters:", sum(p.numel() for p in mha.parameters()))
```

```markdown
## Train a tiny Transformer

Two encoder layers, $d_{\text{model}} = 128$, on a copy task: the model learns to reproduce a sequence of tokens. Not translation, but the loss falls the way the paper's does, and in a few hundred steps on this runtime.
```

```python
# showcase: train
layer = nn.TransformerEncoderLayer(d_model=128, nhead=4, dim_feedforward=512, batch_first=True)
model = nn.Sequential(nn.Embedding(64, 128), nn.TransformerEncoder(layer, num_layers=2), nn.Linear(128, 64)).to(device)
opt = torch.optim.Adam(model.parameters(), lr=1e-3, betas=(0.9, 0.98))
t0 = time.time()
for step in range(1, 401):
    tokens = torch.randint(1, 64, (32, 16), device=device)
    loss = F.cross_entropy(model(tokens).flatten(0, 1), tokens.flatten())
    opt.zero_grad(); loss.backward(); opt.step()
    if step % 50 == 0:
        print(f"step {step:4d}  loss={loss.item():.3f}  {time.time() - t0:5.1f}s")
```

```python
# showcase: eval
with torch.no_grad():
    tokens = torch.randint(1, 64, (8, 16), device=device)
    acc = (model(tokens).argmax(-1) == tokens).float().mean().item()
print(f"accuracy on held-out sequences: {acc:.1%}")
print("peak GPU memory: %.0f MB" % (torch.cuda.max_memory_allocated() / 2**20) if device == "cuda" else "ran on the CPU")
```
