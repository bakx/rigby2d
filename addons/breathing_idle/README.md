# Breathing idle

A looping "breathe" animation in one click, ready to play under other animations.

## Tools

In the **Scripts** menu:

- **Make a breathing idle**: adds a 3.2-second animation named `breathe` (or `breathe 2`, … when
  that name is taken). The upper body rises a little and settles, tilting slightly; the head counters
  the tilt and the arms drift, a beat behind the chest, mirrored per side. When arm IK is on, the IK
  targets move instead, so the arms follow. Nothing is scaled, and the hips and legs are left alone,
  so the feet stay planted. The selected bones breathe; with nothing selected, it uses the bones
  named chest, spine, torso or body. Weapon and effect bones are skipped. The motion is sized to the
  character's height.
- **Make a breathing idle with weight shift**: the same, as a 9.3-second loop with three breaths and
  a slow sideways sway, so the repeat is harder to spot.

The animation starts and ends on the same pose, so it loops cleanly. Play it on its own track to
keep a character alive while it stands still.
