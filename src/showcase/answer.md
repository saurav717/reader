The paper defines it in **§3.2.1, Scaled Dot-Product Attention**. Each query is compared with every key by a dot product, the products are divided by $\sqrt{d_k}$ so the softmax stays in a region with useful gradients, and the softmax weights are used to take a weighted sum of the values — [the definition itself](passage:1). The scaling is the one thing that separates it from ordinary dot-product attention, and the paper says why it matters for large $d_k$ in [the paragraph after the formula](passage:2).

Multi-head attention (§3.2.2) is the same operation run $h = 8$ times in parallel on projected queries, keys and values — [here](passage:3).

```passages
{"quote": "We compute the dot products of the query with all keys, divide each by", "label": "Scaled dot-product attention, defined", "section": "3.2.1 Scaled Dot-Product Attention", "page": 4, "show": true}
{"quote": "We suspect that for large values of dk, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients", "label": "Why the dot products are scaled", "section": "3.2.1 Scaled Dot-Product Attention", "page": 4}
{"quote": "we found it beneficial to linearly project the queries, keys and values h times with different, learned linear projections", "label": "Multi-head attention", "section": "3.2.2 Multi-Head Attention", "page": 4}
```
