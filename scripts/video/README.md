# Videos from the showcase

Two scripts turn the showcase (`components/Showcase.tsx`) into a finished video. No camera, no screen-recording app, no budget.

```bash
npm run build && npm start &                     # the app, on :8080
npm i --prefix .video/fonts @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource-variable/newsreader
node scripts/video/record.mjs                    # → .video/raw/raw.mp4 and timeline.json
node scripts/video/edit.mjs scripts/video/ad.json  # → .video/ad.mp4
```

- **`record.mjs`** runs the showcase on the real *Attention Is All You Need* PDF. The scene cards are hidden, and the indexes are answered locally, so every take is the same. It captures each frame through Chrome's screencast at 3072×1728. `timeline.json` says when each scene began.
- **`edit.mjs`** follows an edit decision list. **`ad.json`** is the 50-second ad. Each shot is either a title card over one of the night scenes in `public/loading/`, or one or more clips of the footage. A clip is `from` and `to` in seconds of `raw.mp4`, plus an optional `speed`, and a `zoom` from one value to another about a point `at` (0–1 of the frame). Each shot can have a caption (`*words*` come out gold and italic) and a line of voice-over.
- The voice-over is OpenAI's `gpt-4o-mini-tts`. Set `OPENAI_API_KEY`, or run where a proxy adds it. Each line is kept in `.video/vo/`, so re-cutting costs nothing until the words change.

The model's and Colab's parts are the showcase's replay, not live calls.
