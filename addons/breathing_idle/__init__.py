# SPDX-License-Identifier: MIT OR Apache-2.0
addon_info = {
    "name": "Breathing idle",
    "version": (1, 2, 0),
    "author": "Rigby2D",
    "description": "Makes a looping 'breathe' animation: the upper body rises and settles, the head and arms follow a beat later.",
    "rigby": (0, 4, 1),
    "url": "https://github.com/jaisurya-dev-art/rigby2d/tree/develop/addons/breathing_idle",
}

# The motion follows how game idles are animated (DragonBones' own demo mecha breathes this way):
# nothing scales. The upper body lifts a little and tilts, the head counters the tilt and the arms
# drift, each a beat behind the chest, so the breath reads as weight moving, not a balloon swelling.
# The legs and hips are left alone, so the feet stay planted.

import math
import re

import rigby

LENGTH = 3.2  # seconds for one breath
INHALE = 0.45  # share of the breath spent rising; the rest settles back
LAG = 0.12  # how far behind the chest the head and arms move, as a share of the breath

TORSO = r"chest|torso|spine|body|ribs|upper_?body"
HEAD = r"head|neck"
UPPER_ARM = r"upper_?arm|shoulder|clavicle|^arm[_\-. ]|^arm$|[_\-. ]arm[_\-. ]?[lr]?$"
LOWER_ARM = r"fore_?arm|lower_?arm|hand|wrist"
SKIP = r"weapon|gun|sword|blade|fx|effect|ik|target|ctrl|control"


def _match(bone, pattern):
    return re.search(pattern, bone.name, re.IGNORECASE) is not None


def _height():
    """The rig's height in world units (from the bones' positions), to scale the motion to it."""
    ys = [b.world["y"] for b in rigby.bones()]
    return max(ys) - min(ys) if ys else 0.0


def _up_in_parent(bone, amount):
    """A translate key value that moves `bone` straight up by `amount` in the world."""
    parent = bone.parent
    if parent is None:
        return (0.0, amount)
    w = parent.world
    a = math.radians(w["rotation"])
    # World (0, amount) into the parent's rotated, scaled frame.
    x = amount * math.sin(a) / (w["scale_x"] or 1.0)
    y = amount * math.cos(a) / (w["scale_y"] or 1.0)
    return (x, y)


def _breath(anim, bone, channel, peak, lag=0.0):
    """Rest, rise to `peak` and settle back, starting `lag` (share of the breath) late; loops cleanly."""
    rest = 0.0 if channel == "rotate" else (0.0, 0.0)
    top = LENGTH * min(INHALE + lag, 0.9)
    hold = LENGTH * min(INHALE + lag + 0.1, 0.95)
    second = peak if channel == "rotate" else (peak[0], peak[1])
    held = peak * 1.08 if channel == "rotate" else (peak[0] * 1.08, peak[1] * 1.08)
    keys = [(0.0, rest), (LENGTH * lag, rest)] if lag else [(0.0, rest)]
    keys += [(top, second), (hold, held), (LENGTH, rest)]
    for t, v in keys:
        anim.key(bone, channel, t, v, "ease_in_out")


def register():
    @rigby.tool("Make a breathing idle", description="The upper body breathes (selected bones, or the chest, spine or torso)")
    def breathe(weight_shift=False):
        bones = [b for b in rigby.bones() if not _match(b, SKIP)]
        torso = rigby.selected_bones() or [b for b in bones if _match(b, TORSO)]
        if not torso:
            raise rigby.RigbyError("Select the bones that should breathe (no chest, spine or torso bone found)")
        names = {b.name for b in torso}
        # Lift only the lowest torso bones (their children ride along); every torso bone shares the tilt.
        lift = [b for b in torso if b.parent is None or b.parent.name not in names]
        heads = [b for b in bones if _match(b, HEAD) and b.name not in names]
        upper = [b for b in bones if _match(b, UPPER_ARM) and not _match(b, LOWER_ARM) and b.name not in names]
        lower = [b for b in bones if _match(b, LOWER_ARM) and b.name not in names]
        arm_names = {b.name for b in upper + lower}
        arm_ik = [c for c in rigby.constraints() if c.type == "ik" and c.settings.get("mix", 1) > 0 and any(b.name in arm_names for b in c.bones)]
        driven = {b.name for c in arm_ik for b in c.bones}

        height = _height()
        rise = min(max(height * 0.012, 1.0), 12.0) if height else 3.0
        name = "breathe"
        taken = {a.name for a in rigby.animations()}
        n = 2
        while name in taken:
            name = f"breathe {n}"
            n += 1
        anim = rigby.add_animation(name, LENGTH)

        for b in lift:
            _breath(anim, b, "translate", _up_in_parent(b, rise))
        tilt = 1.0 / max(len(torso), 1)
        for b in torso:
            _breath(anim, b, "rotate", -tilt)
        for b in heads:
            _breath(anim, b, "rotate", 1.2 / max(len(heads), 1), LAG)
        for b in upper:
            if b.name not in driven:
                _breath(anim, b, "rotate", 0.8 * (1 if b.world["x"] >= 0 else -1), LAG)
        for b in lower:
            if b.name not in driven:
                _breath(anim, b, "rotate", 0.6 * (1 if b.world["x"] >= 0 else -1), LAG * 1.6)
        for c in arm_ik:
            target = rigby.bone(c.target)
            _breath(anim, target, "translate", _up_in_parent(target, rise * 0.8), LAG)
        if weight_shift:
            # Three breath cycles over 9.3 seconds, plus a slower lateral sway. Both close at
            # the boundary, so the longer idle has variation without a loop seam.
            length = 9.3
            targets = [rigby.bone(c.target) for c in arm_ik]
            for b in torso + heads + upper + lower + targets:
                for channel in ("rotate", "translate"):
                    original = b.keys(channel, animation=anim.name)
                    for k in original:
                        b.delete_key(channel, time=k["time"], animation=anim.name)
                    for cycle in range(3):
                        for k in original:
                            t = (cycle + k["time"] / LENGTH) * length / 3
                            anim.key(b, channel, t, k["value"], "ease_in_out")
            # Add the shift to the torso's existing lift, never overwrite its breath curve.
            for b in lift + targets:
                keys = b.keys("translate", animation=anim.name)
                parent = b.parent
                angle = math.radians(parent.world["rotation"]) if parent else 0
                sx = parent.world["scale_x"] if parent else 1
                sy = parent.world["scale_y"] if parent else 1
                for k in keys:
                    sway = rise * 0.6 * math.sin(2 * math.pi * k["time"] / length)
                    value = (k["value"][0] + sway * math.cos(angle) / (sx or 1), k["value"][1] - sway * math.sin(angle) / (sy or 1))
                    anim.key(b, "translate", k["time"], value, "ease_in_out")
            anim.duration = length
        anim.open()
        rigby.status(f"Made '{name}': {len(torso)} breathing bone(s), {len(heads) + len(upper) + len(lower)} following")

    @rigby.tool("Make a breathing idle with weight shift", description="A longer 9.3-second idle with three breaths and a slow sway")
    def breathe_with_shift():
        breathe(weight_shift=True)


def unregister():
    pass
