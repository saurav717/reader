## At a glance

- **What you will build:** a Transformer encoder–decoder from the paper's own parts — scaled dot-product attention, multi-head attention, sinusoidal positions, the position-wise feed-forward layer, residual connections with layer norm — trained with label smoothing and the warm-up learning-rate schedule, and decoded with beam search.
- **The smallest faithful reproduction:** the paper's *base* model shrunk to 3 layers, $d_{\text{model}} = 256$ and 4 heads, trained on Multi30k German→English (29k sentence pairs). It exercises every component and reaches a sensible BLEU in under an hour.
- **On your machine (1× T4, 16 GB, Colab free):** the small model trains in about 40 minutes. The paper's base model on WMT 2014 (4.5M pairs, 100k steps on 8 P100s) is a day on 8 GPUs; a single T4 would need about a week.
- **What you will not get:** 28.4 BLEU. Expect 35–38 BLEU on Multi30k, whose sentences are short and simple — and the *shape* of the paper's claim: attention alone, no recurrence, trained far faster than an RNN of the same size.

Worth building if you want to understand what every modern language model is made of, by making one.

## What to build, and what to leave out

| Component | In the paper | Build it? | Why |
| --- | --- | --- | --- |
| Scaled dot-product attention | §3.2.1, Eq. 1 | **Yes** | Ten lines, and the heart of it. |
| Multi-head attention with projections | §3.2.2 | **Yes** | The projections are what let heads attend to different things. |
| Sinusoidal positional encoding | §3.5 | **Yes** | Also try learned positions — the paper found them equivalent. |
| Position-wise feed-forward, residuals, layer norm | §3.3, §3.1 | **Yes** | Standard blocks; keep the paper's post-norm order for faithfulness. |
| Shared embedding and softmax weights | §3.4 | **Yes** | One line, saves a third of the parameters. |
| Learning-rate warm-up schedule | §5.3, Eq. 3 | **Yes** | Training diverges without it. |
| Label smoothing ($\epsilon_{ls} = 0.1$) | §5.4 | **Yes** | A few lines; worth about a point of BLEU. |
| Byte-pair encoding, 37k shared vocabulary | §5.1 | **Simplify** | A 8k SentencePiece model on Multi30k is enough. |
| Beam search, beam 4, length penalty 0.6 | §6.1 | **Simplify** | Greedy decoding first; beam search as a later milestone. |
| Checkpoint averaging | §6.1 | **Skip** | Matters for the last few tenths of a BLEU point only. |
| WMT 2014 En–De and En–Fr | §5.1 | **Substitute** | Multi30k; WMT is a cluster job. |

### Post-norm, as published

The paper applies layer norm *after* each residual sum. Nearly every Transformer since moves it *before* (pre-norm), which trains more stably without warm-up. Build post-norm first, because that is the paper; add a flag for pre-norm, and you will see why the field moved.

## Datasets

**Multi30k** (Elliott et al., 2016): 29,000 training pairs, 1,014 validation, 1,000 test, German–English captions. Short sentences, a small vocabulary, and a model that trains on one GPU in under an hour.

```bash title="Get Multi30k and train a shared 8k SentencePiece model"
pip install sentencepiece sacrebleu torchtext==0.17
python data/get_multi30k.py          # writes data/multi30k/{train,val,test}.{de,en}
python data/train_spm.py --vocab 8000 # writes data/spm8k.model
```

## Repository layout

```tree
transformer/
├── data/
│   ├── get_multi30k.py
│   └── train_spm.py
├── model/
│   ├── attention.py      # scaled dot-product, multi-head
│   ├── layers.py         # feed-forward, positional encoding, encoder/decoder layers
│   └── transformer.py    # the whole model, shared embeddings
├── train.py              # warm-up schedule, label smoothing, checkpoints
├── translate.py          # greedy, then beam search
└── eval.py               # sacreBLEU on the test set
```

## Starter files

```python title="model/attention.py"
import math, torch, torch.nn as nn, torch.nn.functional as F

def scaled_dot_product_attention(q, k, v, mask=None):
    """Eq. 1: softmax(QK^T / sqrt(d_k)) V, over the last two axes."""
    d_k = q.size(-1)
    scores = q @ k.transpose(-2, -1) / math.sqrt(d_k)
    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))
    weights = F.softmax(scores, dim=-1)
    return weights @ v, weights

class MultiHeadAttention(nn.Module):
    def __init__(self, d_model=512, h=8):
        super().__init__()
        assert d_model % h == 0
        self.h, self.d_k = h, d_model // h
        self.w_q, self.w_k, self.w_v, self.w_o = (nn.Linear(d_model, d_model) for _ in range(4))

    def forward(self, q, k, v, mask=None):
        b = q.size(0)
        split = lambda x, w: w(x).view(b, -1, self.h, self.d_k).transpose(1, 2)
        out, _ = scaled_dot_product_attention(split(q, self.w_q), split(k, self.w_k), split(v, self.w_v), mask)
        return self.w_o(out.transpose(1, 2).contiguous().view(b, -1, self.h * self.d_k))
```

```python title="train.py (the schedule and the loss)"
def lr_at(step, d_model=256, warmup=4000):
    """Eq. 3: linear warm-up, then inverse square-root decay."""
    step = max(step, 1)
    return d_model ** -0.5 * min(step ** -0.5, step * warmup ** -1.5)

criterion = nn.CrossEntropyLoss(ignore_index=PAD, label_smoothing=0.1)
```

## The pipeline, step by step

1. **Data.** Download Multi30k, train the SentencePiece model, encode both sides with BOS/EOS, batch by length to about 4,000 tokens a batch.
2. **Model.** Assemble `Transformer(n_layers=3, d_model=256, h=4, d_ff=1024, dropout=0.1)` with shared embeddings; check a forward pass on a batch and that the causal mask hides the future.
3. **Train.** Adam with $\beta_2 = 0.98$ and the warm-up schedule, label smoothing 0.1, 20 epochs; log the loss every 50 steps and validation BLEU every epoch.
4. **Decode.** Greedy first; then beam 4 with the length penalty, and compare BLEU.
5. **Ablate.** Drop the $\sqrt{d_k}$ scaling, then the positional encoding, then go to a single head — each is one flag, and each loses BLEU the way the paper's Table 3 says.

## Compute budget

| Run | Tokens seen | Time on 1× T4 | Expected BLEU |
| --- | --- | --- | --- |
| Small (3 layers, $d_{\text{model}}$ 256), Multi30k, 20 epochs | 25M | ~40 min | 35–38 |
| Base (6 layers, 512), Multi30k, 20 epochs | 25M | ~2.5 h | 36–39 (overfits) |
| Base, WMT 2014 En–De, 100k steps | 2.5B | ~7 days | ~27 |

## Constraints and pitfalls

- **Warm-up is not optional.** Post-norm Transformers diverge in the first few hundred steps without it.
- **Mask the padding in the encoder too**, not just the future in the decoder, or short sentences in a batch attend to padding.
- **Scale the embeddings by $\sqrt{d_{\text{model}}}$** (§3.4), or the positional encoding swamps them.
- **Check `torch.cuda.is_available()`**: the same code runs on CPU with `n_layers=2` and a batch of 512 tokens, just slowly.

## Milestones

1. A forward pass that produces the right shapes, with attention weights whose rows sum to one.
2. Loss under 3.0 on Multi30k after one epoch.
3. 30+ BLEU with greedy decoding.
4. Beam search adds about a point; the ablations each take one away.
