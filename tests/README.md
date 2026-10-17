# Runtime checks

Run from the repository root with Node.js (no npm dependencies):

```bash
node tests/audio-regression.cjs index.html
node tests/runtime-regression.cjs
```

The audio checks execute the production scheduler and instrument sampler against
a controlled AudioContext. They cover audible start times, delayed frames,
release tails, mute, pause, seeking, track changes and volume automation.

The runtime checks load the actual modules from `index.html`. They exercise mesh
construction, scene transforms, the 66-key chromatic instrument, camera bounds,
source selection, pause/pin behavior and renderer calls. Keyboard checks verify
39 uniformly spaced outer natural keys and 27 inner accidental keys, the piano's
groups of two and three black keys, separated pipe bodies, and all 66 idle picking
targets. The original scores still use 46 pitches, whose note IDs remain valid.

Airflow tests check that the heard audio clock controls both the plume and the
short onset puff, scene time cannot move them independently, future or stopped
notes have no visible flow, and dense chords respect the draw budget. They verify
that soft notes retain a readable plume height while reported audio levels remain
unchanged, puffs expand and release on actual note age, and reduced motion keeps a
static cue without puffs. Ambient-code checks compare the
displayed text with the real marked source and verify that its single historical
echo comes from an earlier actual execution. They also cover pause, pending pins,
replay reset and user-controlled history scrolling.

DOM and WebGL uploads are substituted; these checks do not validate browser CSS
layout, visual airflow direction, shader animation or hardware audio.

For native shader compilation on Linux with EGL and GLES libraries installed:

```bash
node tests/runtime-regression.cjs --dump-shaders=/tmp/zloto-shaders.json
python3 tests/compile-shaders-egl.py /tmp/zloto-shaders.json
```

This compiles and links the exact cinema and exhibit shader pairs using an
offscreen GLES context. It does not install a browser or require a running server.

For a manual visual check, enable sound, replay the scene, and check that the outer
ivory mouths and inner ebony mouths form recognizable piano groups. Check that
air bends into each sounding mouth and rises above it, with bright packets moving
in the flow direction and a brief expanding puff on the heard onset. Soft notes
should remain visible without obscuring the pipe mouths or the central scene.
The source should sit directly in the
background with one emphasized current line and at most one faint historical
echo. Tap a pipe to pin its operation, expand and collapse the code, and pause
during the casting stage. Check both portrait and landscape layouts, and repeat
with the system's reduced-motion preference enabled. A pinned inactive pipe
should show `CZEKA` / `WAITING` until its next sounding note; changing source must
not scroll the expanded history automatically.
