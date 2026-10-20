# Runtime checks

Run from the repository root with Node.js (no npm dependencies):

```bash
node tests/audio-regression.cjs index.html
node tests/runtime-regression.cjs
```

The audio checks execute the production scheduler and instrument sampler against
a controlled AudioContext. They cover audible start times, delayed frames,
release tails, mute, pause, seeking, track changes and volume automation. The
heard-onset history is checked independently of current note levels: repeated
notes retain separate attack IDs, and restoring sound cannot replay attacks that
occurred during a silent interval.

The runtime checks load the actual modules from `index.html`. They exercise mesh
construction, scene transforms, the 66-key chromatic instrument, camera bounds,
source selection, pause/pin behavior and renderer calls. Keyboard checks verify
39 uniformly spaced outer natural keys and 27 raised inner accidental keys, the
piano's groups of two and three black keys, separated pipe bodies, and all 66 idle
picking targets. The original scores still use 46 pitches, whose note IDs remain
valid. Selection markers stay at the real pipe mouths as steam moves away.

Pressure-steam tests advance the same instrument simulation through actual
heard-onset history. They verify that one attack makes one cloud, repeated notes
can produce overlapping clouds at the same mouth, and detached steam continues
to rise and dissipate after its voice finishes while the audio transport keeps
running. Scene time alone cannot move these volumes. Future starts, stopped or
muted transports, rewinds and reduced motion cannot leave active clouds or replay
old attacks. Reduced motion retains the current sounding mouth light.

The suite also checks quiet attacks, measured audio values, the weaker feed from
a sustained voice, deterministic chord admission and release of older clouds.
Limits are eight primary clouds, sixteen clouds including fading ones, and 128
ellipsoid lobes including sustain. Renderer checks exercise the actual instanced
draw route, finite instance data, ordering from back to front and delivery of
copied opaque depth to the steam shader. They do not infer visual correctness
from those numeric checks.

Ambient-code checks compare complete instructions with their exact line and
column spans in the real marked source. They include short pressure-cloud and
casting calls, complete multi-line transform extraction, and the real instruction
executed by a sustained feed after its main puff has expired. The single
historical echo must come from an earlier actual execution. Checks also cover
pause, pending pins, replay reset, stable source selection and user-controlled
history scrolling.

Projection checks feed actual scene bounds into the source placement helper in
portrait layouts. Separate geometry checks cover narrow portrait, landscape and
desktop safe margins, bounded connectors and local labels for distant notes.
They verify that a marker remains on its exact target, that a source cannot stay
live after its operation stops, and that clearing the intro layout removes its
placement. The cinema-to-exhibit projection is checked at the handoff frame.

Water-control checks execute the production motion module, impulse detector,
water driver, engine, clock and DOM controllers against controls parsed from the
current HTML. They verify that both sensor permission requests begin within the
same click, before either promise settles, and that a click or grant cannot
produce a wave. Synthetic orientation samples move the water; a measured
acceleration sequence produces a single sensor impulse. Disabling clears tilt,
target, speed, acceleration and any pending impulse immediately, while existing
water waves remain free to decay. Fresh orientation events cannot prolong an old
acceleration force.

Permission cases cover denial, absent APIs, an insecure context, one available
sensor, a thrown or rejected request, and APIs that emit only null/NaN data.
Controlled timers check the no-data warning and disappearance of status messages.
Engine integration checks cover one button handler, removal of the manual wave
shortcut/API and cooling panel, initialization, language changes, show completion,
replay and graphics failure with the removed DOM elements absent. With reduced
motion enabled, only a successful deliberate sensor activation unlocks the
initial water pause; ordinary sensor events preserve an explicit pause and cannot
replay an impulse later. A controlled thermal response also verifies that the
real engine and clock still apply the cooling rate and restore normal playback
speed outside cooling. Graphics, audio and the thermal response are substituted
in these engine integration fixtures; existing scene tests exercise the real
cooling simulation separately.

Run just these water checks with:

```bash
node tests/runtime-regression.cjs --only=water
```

DOM and WebGL uploads are substituted in the Node checks; these do not validate
browser CSS layout, font wrapping in a real browser, visible steam motion,
fragment-depth clipping or hardware audio. Sensor events, permission decisions
and timers are simulated. These checks do not test a physical phone, native
permission dialogs or browser transient-activation rules on a device.

For the water controls, also inspect a real mobile browser: the phone button
should remain in the top playback toolbar during and after the show, with a
comfortable touch target and a highlighted active state. Grant sensor access
while holding the phone still, then tilt and move it; only the physical movement
should disturb the water. Repeat with denied permissions and with reduced motion
enabled. Disable while the phone is tilted: existing waves should settle, with
no continuing force or delayed pulse. The scene must remain uncovered during
cooling, and status messages should disappear below the toolbar.

For native shader compilation on Linux with EGL and GLES libraries installed:

```bash
node tests/runtime-regression.cjs --dump-shaders=/tmp/zloto-shaders.json
python3 tests/compile-shaders-egl.py /tmp/zloto-shaders.json
```

This compiles and links the exact cinema and exhibit shader pairs using an
offscreen GLES context. It does not install a browser or require a running server.
The pressure-steam vertex and fragment shaders are included. Native animation
QA should also replay sequential production scene draws and instance buffers
against real opaque depth, preserve HDR until the production tone mapping, and
inspect the onset, detached tail, repeated pitch and chord over time. A controlled
partially intersecting volume and a fully occluded volume are needed to test
depth clipping when a natural plume clears the open mouth. Shader compilation or
a single attractive frame alone does not establish those behaviors.

For a manual visual check, enable sound, replay the scene, and check that the outer
ivory mouths and raised inner graphite mouths form recognizable piano groups.
Check that a pressure puff expands, separates from its mouth, curls and fades,
with a weaker feed for a sustained note. Repeat the same pitch before its previous
cloud expires; both attacks should remain distinct. Play a chord and then a quiet
note. Clouds should have soft volumetric edges, pass naturally behind solid
objects, and avoid bright closed rings or flat visible billboards. Pause, mute,
set volume to zero, seek and restart; none should produce a delayed replay of
old attacks. Soft notes should remain visible without obscuring the pipe mouths
or the central scene.
The source should sit directly in the background, close to the scene, with one
emphasized complete instruction and at most one faint historical echo on desktop.
Long transforms should wrap with their closing punctuation visible. A nearby
pipe should have a short connecting line; a distant pipe should have a short
local pointer labelled with its selected note. Tap a pipe to pin its operation,
expand and collapse the code, and pause during the casting stage. Check both
portrait and landscape layouts, and repeat
with the system's reduced-motion preference enabled. A pinned pipe whose cloud
and sustain have finished should show `CZEKA` / `WAITING` until its next real
execution; changing source must not scroll the expanded history automatically.

## Published routes and document navigation

Run from the repository root after generating the publication files:

```bash
node scripts/build.cjs
node scripts/build.cjs --check
node tests/routes.test.cjs
node tests/router-integration.test.cjs
node tests/static-routes.test.cjs
```

The route-model checks cover parsing and serialization independently of the DOM.
The router integration checks execute the actual bootstrap, localization and
router scripts against controls parsed from `index.html`. They verify that URL
languages override saved preferences; an explicit CV language survives a UI
language change, including when both languages initially match; and document
formats, canonical URLs, metadata and language alternatives remain consistent.
They also exercise normal links, modified clicks, new-tab and download semantics,
History API failure, and Back/Forward without creating extra history entries.
Returning home restores the recorded scroll position and focus target, while
inactive views remain hidden and inert. Local `file:` previews also exercise
initial and changed section hashes, and a hash update that makes an unchanged
document language an explicit selection.

The integration harness substitutes DOM, history and animation scheduling, and
keeps document media offline. It does not validate native browser layout, actual
screen-reader behavior, remote document availability or embedded PDF rendering.
The existing audio and rendering suites remain separate and unchanged.

The static-route checks build into temporary directories and start a short-lived
HTTP file server on `127.0.0.1` with **no SPA fallback**. They verify physical home,
CV and score entrypoints, parameter-preserving directory redirects, real 404s for
unknown paths and missing assets, initial metadata and visible views, skip links,
and ordinary HTML/PDF fallback links when JavaScript is unavailable. They also
rebuild from the generated root document to check deterministic, idempotent
output. The temporary files and listener are removed when the checks finish.
These tests need permission to bind a local TCP port in restricted environments.

The local server tests the generated file contract, not GitHub's deployed CDN.
After publishing, a browser check should cover direct links and reloads for
`/zloto/cv/` and `/zloto/score/`, language and PDF choices, Back/Forward, and opening
links in a new tab. The deployed response status and slash redirect should also
be checked directly; a development server with automatic SPA rewrites can hide
the original missing-entrypoint regression.

