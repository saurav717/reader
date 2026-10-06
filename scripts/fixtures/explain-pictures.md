## At a glance

- **The claim:** a sequence model built from attention alone, with no recurrence, translates better and trains faster.
- **The mechanism:** every word looks at every other word in one step, weighted by how well a query matches a key.
- **The result:** a new state of the art on WMT 2014 English–German, in a fraction of the training time.

Anyone who works with sequence models should read it: nearly every large model since is built on it.

## The architecture

The whole model is on one page of the paper, and it is worth looking at before anything else. Read it from the bottom: the source sentence enters the encoder on the left, goes up through a stack of identical layers, and the decoder on the right reads both what it has written so far and what the encoder made of the source.

```image figure="1" caption="The Transformer, as the paper draws it: the encoder stack on the left, the decoder on the right"
The model architecture figure from the paper.
```

Two things in it matter most. Every layer has a residual path around it, so the signal from the input reaches the top unchanged; and the only place the two halves meet is the cross-attention in the decoder.

## What attention looks at

An attention head is easiest to understand from what it does to a real sentence. Below is a map of one head's weights: each row a word, each column the words it draws on. The bright diagonal band is a head attending to the word just before it; the bright column is a head that has learned to look at the verb.

```image search="transformer self-attention weights heatmap sentence" wiki="Attention (machine learning)" caption="An attention map: each row a word, each column how much of each other word it takes in"
A heatmap of attention weights over a sentence.
```

## Where it went next

The idea of attention is older than this paper; what the paper showed is that it is enough on its own.

```image wiki="Attention (machine learning)" caption="Attention, as Wikipedia pictures it"
The lead image of Wikipedia's article on attention.
```

## A figure the paper does not have

```image figure="9" caption="There is no Figure 9 in this paper"
```

Nothing more here.
