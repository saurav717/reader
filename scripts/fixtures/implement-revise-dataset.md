<<<replace: Datasets>>>
## Datasets

Swapped for the smallest download that still gives a billion clean tokens: the `sample-10BT` shard of FineWeb-Edu is 28 GB, but streaming it and stopping at 1B tokens fetches about 3 GB, in well under an hour on Colab's link.

| Dataset | For | Size | Licence | Where |
| --- | --- | --- | --- | --- |
| FineWeb-Edu, `sample-10BT`, streamed to 1B tokens | Distillation tokens | ~3 GB fetched, 4 GB tokenised | ODC-By 1.0 | `HuggingFaceFW/fineweb-edu` |
| The first 1024 documents of it | Calibration set | 1024 × 4096 tokens | ODC-By 1.0 | sliced from the above |
| Qwen2.5-1.5B (base) | The teacher | 3.1 GB | Apache 2.0 | `Qwen/Qwen2.5-1.5B` |

```bash title="Stream a billion tokens, stop, and tokenise"
python scripts/prepare_data.py \
  --dataset HuggingFaceFW/fineweb-edu --config sample-10BT --split train --streaming \
  --tokenizer models/teacher --tokens 1_000_000_000 --seq_len 4096 \
  --out data/fineweb_edu_1b.bin
```

```output
streamed 1,040,112 documents (3.1 GB) in 41 min
data/fineweb_edu_1b.bin: 244,140 sequences × 4096 tokens (1.00B tokens, 4.0 GB)
```

<<<note>>>
Datasets now stream the FineWeb-Edu sample and stop at a billion tokens, about an hour's download.
