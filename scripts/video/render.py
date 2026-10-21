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

W, H, FPS = 1920, 1080, 30


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


def view(z, cx, cy):
    """The part of the frame (0–1) a zoom of z about (cx, cy) shows: its left, top and width."""
    vw = 1 / z
    x0 = min(max(cx - vw / 2, 0.0), 1 - vw)
    y0 = min(max(cy - vw / 2, 0.0), 1 - vw)
    return x0, y0, vw


def warp(src, z, cx, cy):
    """The part of src a zoom of z about (cx, cy) shows, at W×H, to the sub-pixel."""
    sh, sw = src.shape[:2]
    x0, y0, vw = view(z, cx, cy)
    s = W / (vw * sw)
    m = np.float32([[s, 0, -x0 * sw * s], [0, s, -y0 * sh * s]])
    return cv2.warpAffine(src, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


# ------------------------------------------------------------- the light ---

DIM = 0.45  # how much of the light outside a spot is left
RAMP = 0.35  # seconds for a spot to come up or go down
GLIDE = 0.45  # seconds for the light to move from one spot to the next
GOLD = (106, 180, 216)  # BGR


def lerp_rects(a, b, u):
    return [{k: ra[k] + (rb[k] - ra[k]) * u for k in "xywh"} for ra, rb in zip(a, b)]


def rects_at(spot, t):
    samples = spot["samples"]
    before = [x for x in samples if x["at"] <= t]
    if not before:
        return samples[0]["rects"]
    prev = before[-1]
    after = [x for x in samples if x["at"] > t]
    if not after or len(after[0]["rects"]) != len(prev["rects"]):
        return prev["rects"]
    nxt = after[0]
    u = (t - prev["at"]) / max(1e-6, nxt["at"] - prev["at"])
    return lerp_rects(prev["rects"], nxt["rects"], u)


def light_at(spots, t):
    """The boxes lit at t in a take, and how strongly the rest is dimmed (0–1)."""
    for i, spot in enumerate(spots):
        prev = spots[i - 1] if i else None
        nxt = spots[i + 1] if i + 1 < len(spots) else None
        handed_in = prev is not None and spot["from"] - prev["to"] < 0.15
        handed_out = nxt is not None and nxt["from"] - spot["to"] < 0.15
        start = spot["from"] if handed_in else spot["from"] - RAMP / 2
        end = spot["to"] if handed_out else spot["to"] + RAMP
        if not (start <= t < end):
            continue
        rects = rects_at(spot, t)
        strength = 1.0
        if not handed_in:
            strength = min(strength, ease((t - start) / RAMP))
        if not handed_out:
            strength = min(strength, ease((end - t) / RAMP))
        # From the box before to this one, the light glides rather than jumps.
        if handed_in and t - spot["from"] < GLIDE:
            last = prev["samples"][-1]["rects"]
            if len(last) == len(rects):
                rects = lerp_rects(last, rects, ease((t - spot["from"]) / GLIDE))
        return rects, strength
    return [], 0.0


def lit(frame, rects, strength, z=1.0, cx=0.5, cy=0.5):
    """Dims the frame outside the boxes (0–1 of the take's frame), with soft edges and a thin gold line round each."""
    if strength <= 0 or not rects:
        return frame
    x0, y0, vw = view(z, cx, cy)
    q = 4  # the mask is drawn at a quarter size, then smoothed up
    mh, mw = H // q, W // q
    mask = np.zeros((mh, mw), np.float32)
    boxes = []
    for r in rects:
        bx0 = (r["x"] - x0) / vw * W
        by0 = (r["y"] - y0) / vw * H
        bx1 = (r["x"] + r["w"] - x0) / vw * W
        by1 = (r["y"] + r["h"] - y0) / vw * H
        boxes.append((bx0, by0, bx1, by1))
        cv2.rectangle(mask, (int(bx0 / q), int(by0 / q)), (int(math.ceil(bx1 / q)), int(math.ceil(by1 / q))), 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 1.6)
    mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    gain = 1 - strength * (1 - DIM) * (1 - mask)
    out = (frame.astype(np.float32) * gain[:, :, None])
    line = out.copy()
    for bx0, by0, bx1, by1 in boxes:
        cv2.rectangle(line, (int(round(bx0)), int(round(by0))), (int(round(bx1)), int(round(by1))), GOLD, 2, cv2.LINE_AA)
    a = 0.55 * strength
    return (line * a + out * (1 - a)).clip(0, 255).astype(np.uint8)


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
    spots = clip.get("spots") or []
    for k in range(n):
        i = min(len(source) - 1, int(round(k * speed * src_fps / FPS)))
        if i not in cache:
            cache.clear()
            frame = source[i]
            cache[i] = cv2.resize(frame, (target_w, int(round(sh * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else frame
        u = ease(k / max(1, n - 1))
        z = z0 + (z1 - z0) * u
        frame = warp(cache[i], z, cx, cy) if (z != 1 or target_w != W) else cv2.resize(cache[i], (W, H), interpolation=cv2.INTER_AREA)
        rects, strength = light_at(spots, clip["from"] + k * speed / FPS)
        yield lit(frame, rects, strength, z, cx, cy)


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


def main(plan):
    global W, H, FPS
    W, H, FPS = plan["width"], plan["height"], plan["fps"]
    fade = int(round(plan.get("crossfade", 0.4) * FPS))
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
            if previous is not None and k < fade and shot.get("fadeIn", True):
                a = ease((k + 1) / (fade + 1))
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


if __name__ == "__main__":
    main(json.load(open(sys.argv[1])))
