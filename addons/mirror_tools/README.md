# Mirror tools

Build one side of a rig, then mirror it.

## Tools

In the **Scripts** menu:

- **Mirror selected bones**: reflects complete selected chains across world X = 0, including
  nested, rotated and scaled parents.
- **Duplicate mirrored chains**: creates the opposite bones with their slots, attachments and
  skin overrides. Existing destination names are reported instead of overwritten.
- **Swap left/right in names**: renames the selected bones (or every bone, when none is selected)
  to the other side: `arm_l` ↔ `arm_r`, `hand.L` ↔ `hand.R`, `leftEye` ↔ `rightEye`. A name that
  belongs to another selected bone is swapped in two passes; collisions outside the selection
  are left alone.

Each tool is one undo step.
