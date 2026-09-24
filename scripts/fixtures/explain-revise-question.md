<<<insert after: Training and results>>>
## Why label smoothing helps BLEU but hurts perplexity

Perplexity rewards a model for putting as much probability as it can on the one reference word. Label smoothing (ε = 0.1) forbids exactly that: the training target becomes 90% on the right word and 10% spread over the rest, so the model learns never to be fully sure.

That costs perplexity by construction. But BLEU is computed on the *decoded* sentence, found by beam search, and an over-confident model is a poor guide for the search. It commits early to a word, and the beam can no longer recover when a better continuation appears later. A slightly unsure model keeps more good options alive in the beam, and the sentences it ends with overlap the reference better.

```caveat verdict="holds" title="Label smoothing for sequence models"
Still widely used in translation and speech. Müller et al. (2019) showed a trade-off the paper did not see: smoothed models are better calibrated, but make worse teachers for distillation.
```
<<<note>>>
Added a section after “Training and results” answering why label smoothing trades perplexity for BLEU.
