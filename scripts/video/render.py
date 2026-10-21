"""
Composes the frames of a video from the plan scripts/video/edit.mjs writes
(.video/work/<name>/plan.json) and pipes them to ffmpeg.

Every zoom is a sub-pixel affine warp, so a slow push glides instead of
stepping a whole pixel at a time (ffmpeg's zoompan rounds the crop to
whole pixels, which is the shimmer a slow zoom shows). The footage is
first brought down with area averaging to the size the zoom needs, so text
stays crisp rather than aliased.

    python3 scripts/video/render.py .video/work/<name>/plan.json
"""
import json
import math
import subprocess
import sys

import cv2
import numpy as np

plan = json.load(open(sys.argv[1]))
W, H, FPS = plan["width"], plan["height"], plan["fps"]
FADE = int(round(plan.get("crossfade", 0.4) * FPS))


def ease(u):
    u = min(1.0, max(0.0, u))
    return (1 - math.cos(math.pi * u)) / 2


def load_rgba(path):
    image = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if image.shape[2] == 3:
        image = np.dstack([image, np.full(image.shape[:2], 255, np.uint8)])
    return image


class Overlay:
    """A full-frame RGBA picture, composited only over the box where it has ink."""

    def __init__(self, path):
        rgba = load_rgba(path)
        alpha = rgba[:, :, 3]
        ys, xs = np.nonzero(alpha)
        if len(xs) == 0:
            self.box = None
            return
        self.box = (ys.min(), ys.max() + 1, xs.min(), xs.max() + 1)
        y0, y1, x0, x1 = self.box
        self.rgb = rgba[y0:y1, x0:x1, :3].astype(np.float32)
        self.alpha = (alpha[y0:y1, x0:x1].astype(np.float32) / 255.0)[:, :, None]

    def over(self, frame, opacity=1.0):
        if self.box is None or opacity <= 0:
            return frame
        y0, y1, x0, x1 = self.box
        a = self.alpha * opacity
        region = frame[y0:y1, x0:x1].astype(np.float32)
        frame[y0:y1, x0:x1] = (self.rgb * a + region * (1 - a)).astype(np.uint8)
        return frame


def warp(src, z, cx, cy):
    """The part of src a zoom of z about (cx, cy) shows, at W×H, to the sub-pixel."""
    sh, sw = src.shape[:2]
    vw, vh = sw / z, sh / z
    x0 = min(max(cx * sw - vw / 2, 0.0), sw - vw)
    y0 = min(max(cy * sh - vh / 2, 0.0), sh - vh)
    s = W / vw
    m = np.float32([[s, 0, -x0 * s], [0, s, -y0 * s]])
    return cv2.warpAffine(src, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def footage_frames(clip):
    """Frames of one clip: its stretch of the take, at its speed, pushed in as it asks."""
    src_fps = clip["srcFps"]
    first = int(round(clip["from"] * src_fps))
    last = int(round(clip["to"] * src_fps))
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-ss", f"{first / src_fps:.4f}", "-i", clip["file"], "-frames:v", str(last - first + 1), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    sw, sh = clip["srcW"], clip["srcH"]
    size = sw * sh * 3
    source = []
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        source.append(np.frombuffer(buf, np.uint8).reshape(sh, sw, 3))
    proc.wait()
    if not source:
        raise SystemExit(f"no frames from {clip['file']} {clip['from']}–{clip['to']}")
    z0, z1 = clip.get("zoom", [1, 1])
    cx, cy = clip.get("at", [0.5, 0.5])
    # Brought down once, with area averaging, to the size the largest zoom needs.
    target_w = min(sw, int(round(W * max(z0, z1, 1) * 1.02)))
    scale = target_w / sw
    n = clip["frames"]
    speed = clip.get("speed", 1)
    cache = {}
    for k in range(n):
        i = min(len(source) - 1, int(round(k * speed * src_fps / FPS)))
        if i not in cache:
            cache.clear()
            frame = source[i]
            cache[i] = cv2.resize(frame, (target_w, int(round(sh * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else frame
        u = ease(k / max(1, n - 1))
        z = z0 + (z1 - z0) * u
        yield warp(cache[i], z, cx, cy) if (z != 1 or target_w != W) else cv2.resize(cache[i], (W, H), interpolation=cv2.INTER_AREA)


def card_frames(shot):
    """A title card: the night scene drifting in, the words faded up over it."""
    bg = cv2.imread(shot["background"])
    fx, fy = shot.get("focus", [0.5, 0.5])
    layers = [(Overlay(layer["file"]), layer["at"]) for layer in shot["layers"]]
    n = shot["length"]
    drift = shot.get("drift", 0.08)
    for k in range(n):
        frame = warp_view(bg, fx, fy, 1.0 + drift * k / max(1, n - 1))
        t = k / FPS
        for overlay, (start, length) in layers:
            if t >= start:
                overlay.over(frame, ease((t - start) / length) if length else 1.0)
        yield frame


def warp_view(bg, fx, fy, z):
    """W×H out of a covered background, at zoom z, centred toward its focus."""
    bh, bw = bg.shape[:2]
    base = max(W / bw, H / bh)
    vw, vh = W / (base * z), H / (base * z)
    x0 = (bw - vw) * fx
    y0 = (bh - vh) * fy
    s = W / vw
    m = np.float32([[s, 0, -x0 * s], [0, s, -y0 * s]])
    return cv2.warpAffine(bg, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def still_frames(shot):
    """A diagram: full-frame pictures, each crossfaded in at its time."""
    steps = [(load_rgba(step["file"])[:, :, :3], step["at"]) for step in shot["steps"]]
    n = shot["length"]
    for k in range(n):
        t = k / FPS
        frame = steps[0][0].copy()
        for i in range(1, len(steps)):
            image, at = steps[i]
            if t >= at:
                a = ease((t - at) / 0.6)
                frame = cv2.addWeighted(image, a, frame, 1 - a, 0) if a < 1 else image.copy()
        yield frame


def shot_frames(shot):
    if shot["kind"] == "card":
        yield from card_frames(shot)
        return
    if shot["kind"] == "still":
        yield from still_frames(shot)
        return
    last = None
    for clip in shot["clips"]:
        for frame in footage_frames(clip):
            last = frame
            yield frame
        for _ in range(clip.get("holdFrames", 0)):
            yield last.copy()
    for _ in range(shot.get("tailFrames", 0)):
        yield last.copy()


encoder = subprocess.Popen(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
     "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", plan["picture"]],
    stdin=subprocess.PIPE,
)

previous = None
total = 0
for index, shot in enumerate(plan["shots"]):
    overlays = [(Overlay(o["file"]), o) for o in shot.get("overlays", [])]
    written = 0
    for k, frame in enumerate(shot_frames(shot)):
        if k >= shot["length"]:
            break
        frame = np.ascontiguousarray(frame)
        t = k / FPS
        for overlay, spec in overlays:
            start, end = spec["from"], spec.get("to", shot["length"] / FPS)
            if start <= t <= end:
                opacity = min(ease((t - start) / 0.35), ease((end - t) / 0.3))
                overlay.over(frame, opacity)
        # Into each shot from the last frame of the one before.
        if previous is not None and k < FADE and shot.get("fadeIn", True):
            a = ease((k + 1) / (FADE + 1))
            frame = cv2.addWeighted(frame, a, previous, 1 - a, 0)
        if index == 0 and k < 15:
            frame = (frame.astype(np.float32) * (k / 15)).astype(np.uint8)
        remaining = shot["length"] - k
        if index == len(plan["shots"]) - 1 and remaining <= 24:
            frame = (frame.astype(np.float32) * (remaining / 24)).astype(np.uint8)
        encoder.stdin.write(frame.tobytes())
        previous = frame
        written += 1
    # A shot shorter than planned is held on its last frame.
    while written < shot["length"]:
        encoder.stdin.write(previous.tobytes())
        written += 1
    total += written
    print(f"  {index + 1:2d}  {shot['name']:<14} {written / FPS:6.1f} s", flush=True)

encoder.stdin.close()
encoder.wait()
print(f"  {total / FPS:.1f} s of picture → {plan['picture']}")
