"""
A contact sheet of a take with its spots lit, to check what the video will
light up without cutting it: one frame every few seconds, the time on each.

    python3 scripts/video/spots.py <take> [every-seconds]   # → .video/takes/<take>/spots.png
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import render  # noqa: E402

take = sys.argv[1]
every = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
root = os.path.join(os.path.dirname(__file__), "..", "..", ".video", "takes", take)
spots = json.load(open(os.path.join(root, "spots.json")))
raw = os.path.join(root, "raw.mp4")
length = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw]))
tiles = []
t = 0.0
while t < length:
    png = subprocess.check_output(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", raw, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"])
    frame = cv2.resize(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR), (render.W, render.H), interpolation=cv2.INTER_AREA)
    rects, strength = render.light_at(spots, t)
    frame = cv2.resize(render.lit(frame, rects, strength), (640, 360), interpolation=cv2.INTER_AREA)
    cv2.putText(frame, f"{t:.1f}s", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2, cv2.LINE_AA)
    tiles.append(frame)
    t += every
cols = 4
while len(tiles) % cols:
    tiles.append(np.zeros_like(tiles[0]))
sheet = np.vstack([np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)])
cv2.imwrite(os.path.join(root, "spots.png"), sheet)
print(os.path.join(root, "spots.png"))
