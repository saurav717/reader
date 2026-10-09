# reader-companion

Connects a computer to the reader's Playground. It runs a Jupyter server on
`127.0.0.1` that only the reader's site may call, keeps its token across
restarts, and pairs with the page in one click, so nothing is copied or pasted.

```bash
curl -LsSf https://saurav717.github.io/reader/companion.sh | sh
```

or, with [uv](https://github.com/astral-sh/uv) already installed:

```bash
uvx --from https://saurav717.github.io/reader/companion/reader_companion-0.1.0-py3-none-any.whl reader-companion
```

Options: `--root` (the folder the page may use, `~/Reader` by default),
`--port` (47321), `--site` (the reader's address), `--name`, `--no-browser`.
Its settings and token live in `~/.reader-companion/config.json`.

The wheel is built into the site by `npm run build:pages`
(`scripts/build-companion.mjs`). `python -m unittest discover companion/tests`
runs its tests.
