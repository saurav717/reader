## At a glance
- Attention compares every query with every key, scaled by $\sqrt{d_k}$, and mixes the values by the result.
- Several heads do this side by side, each in a smaller space.

## Scaled dot-product attention
Each position asks a question of every other position, and the answer is a weighted average of what they hold.

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V
$$

where
- $Q \in \mathbb{R}^{n \times d_k}$ holds the queries, one row per position;
- $K \in \mathbb{R}^{n \times d_k}$ holds the keys, and $V \in \mathbb{R}^{n \times d_v}$ the values.

Dividing by the square root of the key width keeps the scores from growing with the dimension, so the softmax stays soft and its gradients stay useful. Without it, a dot product of two random unit-variance vectors has variance $d_k$, and the largest score swamps the rest.

## Since then
| Claim | Verdict |
| --- | --- |
| Scaling by $\sqrt{d_k}$ is enough | Holds |
