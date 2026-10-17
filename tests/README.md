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
construction, scene transforms, the 46-pitch instrument, camera bounds, source
selection, pause/pin behavior and renderer calls. DOM and WebGL uploads are
substituted; these checks do not validate browser CSS layout or hardware audio.

For native shader compilation on Linux with EGL and GLES libraries installed:

```bash
node tests/runtime-regression.cjs --dump-shaders=/tmp/zloto-shaders.json
python3 tests/compile-shaders-egl.py /tmp/zloto-shaders.json
```

This compiles and links the exact cinema and exhibit shader pairs using an
offscreen GLES context. It does not install a browser or require a running server.

For a manual visual check, enable sound, replay the scene, tap a pipe to pin its
operation, expand and collapse the code, and pause during the casting stage.
Check both portrait and landscape layouts. A pinned inactive pipe should show
`CZEKA` / `WAITING` until its next sounding note.
