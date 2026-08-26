#!/usr/bin/env python3
"""
Extract hand IK goals from Unity humanoid pose clips.

The clips are authored in Unity's muscle space, which cannot be evaluated
outside Unity: a muscle value is normalised against limits held in the avatar
asset, so reconstructing bone rotations needs data this pipeline does not have.
The goal curves are a different matter. `LeftHandT`/`RightHandT` are the wrist
positions the pose resolves to, relative to the root, divided by the avatar's
scale — a measurement rather than a parameter, and portable as a ratio.

That is the quantity the gesture table is missing. A pose authored as
directions has no opinion about where the hands end up, so two hands that are
meant to meet do not, and the distance between them here says how far apart a
real clap leaves them.

Two constants come out of the T-pose clip and set the conversion:

  half-span    wrist-to-midline with the arms out  = trunk half-width + arm length
  wrist height wrist height above the root in that pose = root-to-shoulder rise

Everything else is reported as a ratio against those, which is what survives
the move to an avatar with different proportions.

Usage:
    python3 extract_pose_goals.py <unitypackage> [-o pose_goals.json]
"""

import argparse
import json
import math
import os
import re
import sys
import tarfile
import tempfile

# Wrists closer than this, as a fraction of the half-span, are touching. The
# gap between the two clusters is wide enough that the exact cut does not
# matter: contact poses land near 0.08 and the next ones up are past 0.14.
CONTACT_RATIO = 0.12

GOAL_KEYS = [f"{s}Hand{c}.{a}" for s in ("Left", "Right") for c in ("T",) for a in "xyz"]
BEND_KEYS = [
    f"{part} {axis}"
    for part in ("Spine", "Chest", "UpperChest")
    for axis in ("Front-Back", "Left-Right")
]

# One keyframe at t=0 holds the whole pose, and the curve's attribute name comes
# after its keys. Bounded so a malformed clip cannot run the match to the end of
# the file.
CURVE_RE = re.compile(
    r"time: 0\s*\n\s*value:\s*(-?[\d.eE+-]+)[\s\S]{0,400}?attribute:\s*(.+)"
)


def unpack(path, dest):
    """Unity packages are gzipped tars of GUID directories holding an asset and its path."""
    with tarfile.open(path, "r:gz") as tf:
        # Refuse absolute paths and links out of the destination. The archives
        # are trusted, but the default becomes an error in a later Python and
        # asking for the safe filter is the fix either way.
        tf.extractall(dest, filter="data")
    out = {}
    for guid in os.listdir(dest):
        meta = os.path.join(dest, guid, "pathname")
        asset = os.path.join(dest, guid, "asset")
        if os.path.exists(meta) and os.path.exists(asset):
            out[asset] = open(meta, encoding="utf-8").read().strip()
    return out


def read_curves(path):
    """Values at t=0, by attribute name. The editor copy of the curves is skipped."""
    text = open(path, "rb").read().decode("utf-8", errors="replace")
    text = text.split("m_EditorCurves")[0]
    values = {}
    for m in CURVE_RE.finditer(text):
        name = m.group(2).strip()
        values.setdefault(name, float(m.group(1)))
    return values


def goals(values):
    if any(k not in values for k in GOAL_KEYS):
        return None
    left = tuple(values[f"LeftHandT.{a}"] for a in "xyz")
    right = tuple(values[f"RightHandT.{a}"] for a in "xyz")
    return left, right


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("package", help="the .unitypackage holding the pose clips")
    ap.add_argument("-o", "--out", default="pose_goals.json")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        assets = unpack(args.package, tmp)
        clips = {a: p for a, p in assets.items() if p.endswith(".anim")}
        if not clips:
            sys.exit("no .anim clips in the package")

        # The reference pose. Every clip set ships a copy of it; any will do.
        ref = next((a for a, p in clips.items()
                    if os.path.basename(p) == "000_0000_Idle.anim"), None)
        if ref is None:
            sys.exit("no reference pose (000_0000_Idle.anim) in the package")
        ref_goals = goals(read_curves(ref))
        if ref_goals is None:
            sys.exit("the reference pose carries no hand goals")
        (lx, ly, _), (rx, _, _) = ref_goals
        half_span = abs(rx - lx) / 2
        shoulder_rise = ly
        if half_span <= 0 or shoulder_rise <= 0:
            sys.exit("the reference pose is not a T-pose; cannot calibrate")

        poses, seen = [], set()
        for asset, path in sorted(clips.items(), key=lambda kv: kv[1]):
            name = os.path.basename(path)[: -len(".anim")]
            # The idle is duplicated into every folder, and the hand-sign clips
            # drive fingers only.
            if name == "000_0000_Idle" or name in seen:
                continue
            values = read_curves(asset)
            g = goals(values)
            if g is None:
                continue
            seen.add(name)
            left, right = g
            sep = math.dist(left, right)
            mid = [(a + b) / 2 for a, b in zip(left, right)]
            poses.append({
                "name": name,
                "group": os.path.basename(os.path.dirname(path)),
                # Ratios, not raw values: these are what port to another rig.
                "gap": sep / half_span,
                "mid": {
                    "right": mid[0] / half_span,
                    "up": mid[1] / shoulder_rise,
                    "forward": mid[2] / half_span,
                },
                # How far the trunk is from upright. The mid point is measured
                # from the root and consumed against the chest, so a pose that
                # bends carries an offset between the two that this does not
                # resolve — sort by it and take from the top.
                "bend": sum(abs(values.get(k, 0.0)) for k in BEND_KEYS),
                "contact": sep / half_span < CONTACT_RATIO,
            })

    poses.sort(key=lambda p: (not p["contact"], p["bend"]))
    contact = [p for p in poses if p["contact"]]
    out = {
        "source": os.path.basename(args.package),
        "calibration": {
            "halfSpan": half_span,
            "shoulderRise": shoulder_rise,
            "note": "divide by these to compare against another rig's "
                    "(trunk half-width + arm length) and root-to-shoulder rise",
        },
        "poses": poses,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"{len(poses)} poses, {len(contact)} in contact -> {args.out}")
    if contact:
        gaps = sorted(p["gap"] for p in contact)
        print(f"  contact gap: {gaps[0]:.3f} - {gaps[-1]:.3f} "
              f"(median {gaps[len(gaps) // 2]:.3f}) of the half-span")
        upright = contact[: min(6, len(contact))]
        print("  most upright contact poses:")
        for p in upright:
            m = p["mid"]
            print(f"    {p['name']:<12} gap={p['gap']:.3f} "
                  f"right={m['right']:+.3f} up={m['up']:+.3f} forward={m['forward']:+.3f}")


if __name__ == "__main__":
    main()
