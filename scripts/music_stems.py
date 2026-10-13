#!/usr/bin/env python3
"""PG1 Sound stems: Demucs separation, basic-pitch MIDI, BPM and key.

    python scripts/music_stems.py <master.wav> <out_dir> [--no-vocals-midi]

Run by scripts/music-render.mjs (lib/music/export.mjs) on the render
worker (.github/workflows/music-render.yml, CPU only). Prints one JSON line
on stdout, the manifest:

    {"stems": {"drums": path, "bass": path, "vocals": path, "other": path},
     "midi": {"bass": path, "vocals": path, "other": path},
     "bpm": 92.3, "key": "F# minor"}

Everything else (progress, warnings) goes to stderr.
"""

import json
import os
import subprocess
import sys

STEMS = ("drums", "bass", "vocals", "other")
MELODIC = ("bass", "vocals", "other")

# Krumhansl-Kessler key profiles.
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")


def log(msg):
    print(f"[music-stems] {msg}", file=sys.stderr, flush=True)


def separate(master, out_dir):
    """Demucs htdemucs on the CPU; returns {stem: wav path}."""
    subprocess.run(
        [sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu", "-o", out_dir, master],
        check=True, stdout=sys.stderr, stderr=sys.stderr,
    )
    base = os.path.splitext(os.path.basename(master))[0]
    folder = os.path.join(out_dir, "htdemucs", base)
    stems = {s: os.path.join(folder, f"{s}.wav") for s in STEMS}
    for s, path in stems.items():
        if not os.path.isfile(path):
            raise SystemExit(f"demucs made no {s} stem at {path}")
    return stems


def transcribe(stems, out_dir, skip):
    """basic-pitch MIDI for each melodic stem; returns {stem: mid path}."""
    from basic_pitch.inference import predict  # imported late: slow to load

    midi = {}
    for s in MELODIC:
        if s in skip:
            continue
        log(f"transcribing {s}")
        _, midi_data, notes = predict(stems[s])
        if not notes:
            log(f"no notes found in {s}; no MIDI for it")
            continue
        path = os.path.join(out_dir, f"{s}.mid")
        midi_data.write(path)
        midi[s] = path
    return midi


def correlate(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    return num / (da * db) if da and db else 0.0


def key_from_chroma(chroma):
    """The best-matching major or minor key for a 12-bin chroma vector."""
    best = (-2.0, "")
    for tonic in range(12):
        rotated = chroma[tonic:] + chroma[:tonic]
        for profile, mode in ((MAJOR, "major"), (MINOR, "minor")):
            r = correlate(rotated, profile)
            if r > best[0]:
                best = (r, f"{NAMES[tonic]} {mode}")
    return best[1]


def analyse(master):
    """Tempo and key from the master (librosa, installed with basic-pitch)."""
    import librosa
    import numpy as np

    y, sr = librosa.load(master, sr=22050, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    harmonic = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr).mean(axis=1).tolist()
    return round(bpm, 2), key_from_chroma(chroma)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    master, out_dir = argv[1], argv[2]
    skip = {"vocals"} if "--no-vocals-midi" in argv[3:] else set()
    os.makedirs(out_dir, exist_ok=True)
    log("separating stems (htdemucs, cpu)")
    stems = separate(master, out_dir)
    midi = transcribe(stems, out_dir, skip)
    log("detecting tempo and key")
    bpm, key = analyse(master)
    print(json.dumps({"stems": stems, "midi": midi, "bpm": bpm, "key": key}), flush=True)


if __name__ == "__main__":
    main(sys.argv)
