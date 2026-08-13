# Controls & interaction model

How the player touches the game: what every key and every touch control does,
and the interaction model those bindings serve. `DESIGN.md` is the authority on
content (chapters, dialogue, weapon stats, map).

## The principle that makes it work

**One contextual action button.** A single action control is wired to one
function whose label rewrites itself by context — `EXIT` while you are in a
vehicle, `COMMANDEER THE CRUISER` beside a police car. There is no separate enter key, exit key, or carjack key. Every
context-sensitive thing the player can do funnels through that one control, and
the HUD says what it will do right now.

That is the model to follow. Our current build has interactions scattered across
several unbound keys, which is why a playability probe found the sixteen-weapon
arsenal unreachable from the keyboard.

## Desktop

| key | action |
|---|---|
| `W A S D` / arrows | move — **on foot this RUNS, no key held** (see auto-run below) · drive · **helicopter: `W`/`S` tilt the disc fore/aft, `A`/`D` are the tail pedals** |
| `Alt` (hold) | **walk** — the slow gait, since full deflection is the run |
| `Shift` | run on foot (optional now — auto-run already does it) · nitro in a car · **helicopter: DESCEND** |
| `Space` | jump on foot · handbrake in a car · **helicopter: CLIMB** |
| `C` | crouch — **not `Ctrl`**: see the note below the table |
| **`F`** | **the contextual action** — enter / exit / carjack / swap vehicle / sleep at a safehouse / interact |
| `E` / `Q` | next / previous weapon |
| `R` | reload |
| `V` | cycle camera |
| `H` | horn |
| `LMB` | fire (a melee weapon swings — melee is a WEAPON, not a separate key) |
| `RMB` | aim |
| `B` | fire mode · **`Shift`+`B`** flips the minimap north-up / heading-up |
| `I` | inspect the weapon |
| **`J`** | **the mission key** — start the next chapter, take the offered side job, or skip a chapter intro that is playing |
| **`K`** | **abandon the live chapter or job. It ASKS FIRST**: one press arms and toasts `PRESS K AGAIN`, a second within 4 s commits, **`Shift`+`K`** commits outright |
| `U` | cycle to the next brother (refused mid-chapter, with a toast) |
| `M` | map · `O` story overview · `Tab` weapon wheel · `X` character switch · `P` phone · `N` radio station |
| `1`–`6` | pick straight out of this brother's loadout, in wheel order |
| `Esc` | pause |

Mouse drag rotates the camera; wheel zooms the chase distance (radius clamped
8–30, pitch 0.35–1.42 rad).

**AUTO-RUN: `W` is the run. `Alt` is the walk. `Shift` is optional.** Reported
as *"I always need to hold in the run button to move fast enough"*, and the
report was describing an asymmetry rather than a preference: a **gamepad** has
auto-sprinted at full stick since the controls were remapped
(`movement.latchInput` reads `|stick.moveY| > 0.94`), and the keyboard — where
that axis is always zero — was left out of the line. So a pad ran at 6.4–7.9 m/s
for free while WASD topped out at the 3.35 m/s jog unless `Shift` was held.
Full deflection now means the same thing on both devices.

What each control is worth on foot, on this build (`src/player/feeltest.mjs`
measures every one of them off the emitted body position, Carson):

| input | speed | notes |
|---|---|---|
| `W` | **6.40 m/s** | the brother's DESIGN.md run speed — 6.4 / 6.9 / 7.9 by brother |
| `Shift`+`W` | 6.40 m/s | identical. `Shift` still forces the run; it is never wrong to hold and never required |
| `Alt`+`W` | 1.72 m/s | the walk |
| stick, part-deflected | 1.72 → 3.35 m/s | the analogue ramp is untouched; the jog lives here and has no keyboard binding |
| `C` then `W` | 1.48 m/s | crouch beats the run, and `Alt` is not needed to hold it |
| `RMB`+`W` | 1.90 m/s | aiming drops the run on the frame the button goes down |

`Shift` keeps its binding on purpose rather than being reused as the walk
modifier: the same action carries the **vehicle nitro**, the pad's own
full-stick sprint, and probes outside `src/player/` that press it
(`src/weapons/arsenalprobe.mjs --sprint`). `Alt` is where GTA V puts
*character walk slowly*, and it is not `Ctrl` — the modifier-key rule below is
about `Ctrl` reaching the browser, and `Input._onKeyDown` cancels everything
that is not `Ctrl`/`Meta`.

**Looking up: the reticle reaches 72°, not 34°.** Reported as *"cannot shoot at
police helicopter while on foot — the view range is limited and cannot aim that
high"*. A police heli orbits at 40–80 m, i.e. 50–70° above the horizon, and the
third-person ceiling was **+34°** — measured at that ceiling, the character's
own head sat 4.9° off the reticle, so the crosshair was effectively resting on
his skull and the rounds (which are fired down the camera axis) went with it.
The ceiling is now **+72°** in the chase and close views, **+66°** in the far
view (its boom is 1.62× as long and swings that much further), and first person
is unchanged at +76°. Above **+34°** the boom shortens and tucks up
(`CAMERA.highLook`) so it does not swing into the pavement — below that angle
nothing about the camera moved, which `src/player/camtest.mjs` (`look.inert`)
asserts to the micron.

**Mouse-look comes back on its own.** Every overlay that needs the cursor —
menu, map, phone, story, cheat panel, cutscene, result card — releases pointer
lock on the way up and takes it back on the way down (`ui._syncPause`), so the
camera is live again on the frame the last one closes. Where the browser refuses
a lock it was not asked for by a gesture, a click on the world still buys it —
and **that click does not fire**: `Input._onMouseDown` swallows the trigger edge
of the click that restores the lock, but only in a browser that has granted one
before, or a build where pointer lock is unavailable would have no fire button
at all.

**No modifier key is a held game control, and no key means two things.** Crouch
was `Ctrl` as well as `C`, and `Input._onKeyDown` exempts `e.ctrlKey` from
`preventDefault` so devtools and refresh survive — which meant that while crouch
was held, `R` reloaded the page, `S` opened Save Page As, and `Ctrl`+`W`/`T`/`N`
are reserved by the user agent and cannot be cancelled at all. Crouching and
walking forward closed the tab. Separately, `B` was flipping the fire mode and
the minimap at once. Anything that has to share a key takes `Shift`, and both
readers test the modifier — `src/weapons/index.js` declines a `B` carrying it.

## The mission keys, and the panel that names one of them

**`J` is the key the game tells you to press.** The HUD's objective panel shows
`NEXT CHAPTER`, the chapter's number and title, and the line **`PRESS J`**; when
the story is finished it shows the nearest `SIDE JOB` and the same line. Every
mission toast ends the same way — `PRESS J` to start, `PRESS J TO RETRY` after a
failure, `REPLAY · PRESS J` on a chapter you have already cleared. A touch build
has no J, so `ui._touchify` rewrites that exact phrase to **`TAP JOB`** at the
one choke point every toast flows through. The literal string is load-bearing:
do not reword it in a toast without reading `_touchify`.

**`K` abandons, and it asks first.** `K` sits one key from `J`, and it used to
throw a live chapter away on a single press with a FAILED card as the only
warning it had happened. Now the first press ARMS it and toasts `PRESS K AGAIN`;
a second press within **4 s** commits; **`Shift`+`K` commits outright** for
anyone who knows what the key does. The window is measured in UNSCALED time
(`ctx.time.raw`), because a chapter runs at whatever the clock is doing — 0.22
under the weapon wheel, 0.12 in a hitstop — and a confirmation measured in
simulated seconds would be a different length every time it was offered. It also
cannot survive a pause: raw time keeps running behind a menu, so a window armed
before the menu has expired by the time it comes down. The arming is keyed to
the chapter it was armed on, so a question asked about one chapter can never
answer for the next. A side job takes the same key on the same terms, from
`src/game/jobs.js`, and the two can never collide — at most one of them is live.

**The vehicle instrument cluster has no keys at all.** Speed, gear and RPM, and
the aircraft faces — altitude, climb rate, rotor, pitch and bank — appear when
you are in something that publishes them and vanish when you get out. A field
with no producer reads -1 and its row is hidden rather than drawn as a zero, so
a boat shows no rev counter and a car shows no altimeter. There is nothing to
toggle and nothing to learn.

## Flying the Riverhop

The helicopter is the one vehicle whose controls do not read off the table
above, so it gets its own. **A player who has only read the table must be able
to get off the ground**, which is why the collective is spelled out here rather
than folded into "handbrake in a vehicle".

| key | in the helicopter |
|---|---|
| **`Space`** | **COLLECTIVE UP — climb.** Held. Same key as jump on foot: `Space` is "up" in both contexts |
| **`Shift`** | **COLLECTIVE DOWN — descend.** Held. Hold it all the way to the ground to land |
| neither | **holds the altitude it is at.** Let go and it hovers — it does not sink |
| `W` / `S` | cyclic: tilts the disc nose-down / nose-up. **This is how it moves.** `W` does not make it go up, it makes it go *forward* |
| `A` / `D` | tail pedals — yaw, which is how you point it |
| `F` | get in / get out. Getting out at altitude is a fall, not a landing |

Three things that surprise people, all of them deliberate:

- **There is a four-and-a-half second wind-up.** The rotor is a governed head,
  so thrust goes as the square of a spool that starts at zero. Nothing happens
  when you first pull the collective on a cold machine; that is the governor,
  not a dead key.
- **`W` is not a throttle.** A helicopter accelerates by tilting its disc, so
  holding `W` noses over and the machine leans into the direction it is going.
  It also does not stop when you let go.
- **It sags in a hard turn.** A banked disc puts less of its thrust into
  holding the machine up. Feed in some `Space` through the turn.

> The binding used to be the other way round — `Shift` up, `Space` down. `Space`
> climbs now: it is what every other game with a flyable vehicle does, and what
> the on-foot `Space` already means. See the header of
> `src/vehicles/heli.js` for the measurement that came with the change: the old
> `Shift`-to-climb had never worked at all, because the sprint control is
> routed through the nitro bottle and a helicopter has no throttle to open it.

**`Shift`-to-descend is live now.** It was not, and the reason is worth keeping:
`Space` reached the machine raw as `handbrake`, but `Shift` went through the
NITRO BOTTLE, which only opens above a throttle pedal — and a helicopter has no
throttle pedal to open it with. Measured on that build, a pilot at 87.7 m
holding the descend control for 25 seconds ended up at 93.0 m: **he could not
land.** The fix is in `VehicleHandler._stepDrive` (`src/player/vehicle.js`): a
`plane` or `heli` now takes the sprint channel STRAIGHT THROUGH as `boost`
rather than through the bottle, and the car path is untouched. The same defect
was grounding the aeroplanes, which read `boost` as the throttle lever — holding
`Shift` in a Skylark delivered `input.boost 0` for ten seconds, so the lever
stayed at zero and it never rolled. One fix, both aircraft.

So the collective is two-way and this table describes the build. If you are
looking for the shape of the original bug: it was a resource meter sitting in
the middle of a flight control, invisible from either end.

## Mobile / touch — the part we do not have at all

`isTouch()`: `'ontouchstart' in window || navigator.maxTouchPoints > 0 || innerWidth <= 760`.

**Layout**
- **Left: virtual joystick** (`#joy` + `#joyKnob`). Knob clamps to the pad radius,
  reports `x`/`y` in −1..1. Tracks a specific `touch.identifier` so a second
  finger elsewhere cannot steal it. Resets to centre on `touchend`/`touchcancel`.
- **Right: a camera drag zone** (`#camZone`) covering the rest of the screen.
  Drag to orbit — `camTargetAlpha` from x, `camBeta` from y, clamped 0.35–1.42.
  Also identifier-tracked, and `passive: true` because it never needs to
  `preventDefault`.
- **Held buttons** (`down`/`up`, with a `.held` CSS class for feedback):
  `bFire`, `bRun` (sprint), `bBrake`.
  - `src/ui/touch.js` synthesises key codes rather than a second input path, so
    `bRun` is `ShiftLeft` and `bBrake` is `Space`. **In the helicopter that
    means BRAKE climbs and RUN descends** — the buttons work, the labels lie.
    They want a flight context: `bBrake` → `CLIMB`, `bRun` → `DESCEND`.
    `src/ui/` owns that.
- **Tap buttons**: `bAct` (the contextual action — relabels to `EXIT` in a
  vehicle), `bWep` (cycle weapon).
- **HUD taps**: radio, map, missions, settings, and the weapon box itself cycles
  on tap.
- **Overlay buttons**: respawn, busted, retry mission, continue, end.

**Two mobile traps we must not miss**
1. `document.addEventListener('gesturestart', e => e.preventDefault())` — kills
   iOS pinch-zoom over the canvas.
2. A double-tap guard: swallow a `touchend` within 300 ms of the previous one
   *unless* the target is inside `#settings`, `#mapModal` or `.overlay` — so
   menus stay usable while the game surface never zooms.

Every touch handler that calls `preventDefault` is registered `{passive:false}`;
the ones that don't are `{passive:true}`. Getting that wrong costs scroll
performance or breaks the control outright.

## Interaction rules worth copying

- `tryEnterExit()` uses a **5.5 m** radius and toasts "No vehicle nearby" on a
  miss — the player always gets feedback, even for a no-op.
- Stealing a **police** car raises the wanted level immediately.
- **The crew hops in with you**: allies within 30 m board the vehicle and are
  hidden; a toast says so. This is a signature of the DeCarlo-brothers premise.
- **Bikes keep the rider visible** (`setRidePose`) — the player mesh stays and is
  posed onto the bike, rather than being hidden as it is in a car.
- Entering swaps the vehicle meters into the HUD and changes the camera radius by
  vehicle class (bus 22, aircraft 24, default 18).
- Exiting probes around the car for a spot that is not inside a building and not
  in water before placing you.
- Everything the player does produces a **toast** in the character's accent
  colour. Feedback on every action, always.

## Test / cheat menu

Not part of the shipped control scheme — a tool for whoever is testing the game.

**`` ` ``** (backquote) or **F8**, the button on the left edge of the HUD, or
**CHEATS** on the touch nav. Six tabs:

| tab | what it does |
|---|---|
| VEHICLES | spawn any class, or spawn and get straight in; clear what you spawned |
| WEAPONS | give any of the 16, unlock everything, refill, infinite ammo |
| TELEPORT | the map waypoint, 12 districts, 6 landmarks, ~56 service POIs |
| WORLD | time of day, **day length**, weather, wanted level |
| PLAYER | switch brother, heal, armour, godmode, cash |
| MISSIONS | jump to any chapter for the active brother, or abort |

Every list is **enumerated from the owning subsystem at runtime** — the vehicle
tab picked up the bus, bicycle and helicopter with no edit — so it cannot go
stale the way a hardcoded list does.

Five ways out (`` ` ``, Escape, the button, ✕, CLOSE), and it never writes
`time.scale` itself: `ui._updateModalPause` stays the single owner of the clock,
because a sticky overlay pinning the sim at zero once hung the whole test suite
for 74 minutes.

**Hidden under `?capture=1` and for `navigator.webdriver`**, so it can never
appear in a review capture or a marketing screenshot. `?cheats=1` forces it on
for probes. Gated by `npm run cheats` (52/52).
