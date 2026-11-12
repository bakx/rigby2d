# SPDX-License-Identifier: MIT OR Apache-2.0
addon_info = {
    "name": "Mirror tools",
    "version": (1, 1, 0),
    "author": "Rigby2D",
    "description": "Mirror the selected bones across X = 0, and swap left and right in their names.",
    "rigby": (0, 4, 1),
    "url": "https://github.com/jaisurya-dev-art/rigby2d/tree/develop/addons/mirror_tools",
}

import re

import rigby

# Name pairs, tried in order: _l/_r, .L/.R, Left/Right and left/right.
_SIDES = [(r"_l\b", "_r"), (r"_r\b", "_l"), (r"\.L\b", ".R"), (r"\.R\b", ".L"), ("Left", "Right"), ("Right", "Left"), ("left", "right"), ("right", "left")]


def swap_side(name):
    """The name for the other side: arm_l -> arm_r, hand.L -> hand.R, leftEye -> rightEye."""
    for pattern, other in _SIDES:
        if re.search(pattern, name):
            return re.sub(pattern, other, name, count=1)
    return name


def register():
    @rigby.tool("Mirror selected bones", description="Flip the selected bones' setup across X = 0")
    def mirror_bones():
        bones = rigby.selected_bones()
        if not bones:
            raise rigby.RigbyError("Select the bones to mirror first")
        result = rigby.mirror_bones(bones)
        rigby.status(f"Mirrored {len(result['bones'])} bone(s)")

    @rigby.tool("Duplicate mirrored chains", description="Copy selected chains and artwork across world X = 0")
    def duplicate_mirror():
        bones = rigby.selected_bones()
        if not bones:
            raise rigby.RigbyError("Select the chain roots first")
        names = {b.name: swap_side(b.name) if swap_side(b.name) != b.name else b.name + "_mirror" for b in rigby.bones()}
        result = rigby.mirror_bones(bones, duplicate=True, names=names)
        rigby.status(f"Duplicated {len(result['bones'])} mirrored bone(s)")

    @rigby.tool("Swap left/right in names", description="arm_l <-> arm_r, hand.L <-> hand.R, left <-> right")
    def swap_names():
        bones = rigby.selected_bones() or rigby.bones()
        taken = {b.name for b in rigby.bones()}
        moving = {b.name for b in bones if swap_side(b.name) != b.name}
        # Only a collision outside the set being swapped prevents a rename.
        pairs = [(b, swap_side(b.name)) for b in bones if b.name in moving and (swap_side(b.name) not in taken or swap_side(b.name) in moving)]
        for i, (b, new) in enumerate(pairs):
            temp = f"__mirror_swap_{i}"
            while temp in taken:
                temp += "_"
            taken.add(temp)
            b.name = temp
        for b, new in pairs:
            b.name = new
        rigby.status(f"Renamed {len(pairs)} bone(s)")


def unregister():
    pass
