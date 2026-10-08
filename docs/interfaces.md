# CoffeeDingoSim — interfaces

Reference for the file formats and wire protocols between the parts of the simulator: scene file, component
library, load-bank NDJSON, SLCAN bridge, Renode control and the server ↔ UI WebSocket. Firmware facts come from
[CoffeeDingoFW](https://github.com/Coffee0297/CoffeeDingoFW). Example project:
`scenes/example/example-vehicle.json`.

## 1. Repo layout

```
package.json                 root: "type": "module"; scripts: start, dev, build, test, ci
server/                      Node 24 (ESM). index.js (http + ws), renode.js, bank.js, bus.js, bridge.js,
                             project.js, firmware.js, record.js, mcp.js
app/                         Svelte 5 + Vite SPA (vite root = app/). src/App.svelte, src/Canvas.svelte,
                             src/nodes/*.svelte, src/Palette.svelte, src/SideChart.svelte, src/RenodePanel.svelte,
                             src/RunsPanel.svelte, src/ws.js (client store)
lib/                         pure ESM JS, no Node/browser-only APIs (shared by server, app and tests):
                             components.js, components/*.json, shapes.js, precheck.js, dbc.js, slcan.js,
                             paramproto.js, engine.js, battery.js, populate.js, scene.js
renode/                      platforms/*.repl, models/*.cs, templates/*.resc.hbs (plain ${} templating, no lib),
                             dbc/*.dbc (copied from firmware), SimEngine.dbc
scenes/<name>/               scene.sim.json, nv/<module>.bin (gitignored), runs/*.run.json (gitignored except
                             runs/golden.run.json)
tools/                       install-com0com.md, install-renode.md, ci.sh
test/                        node --test files (*.test.js)
```

Tests: `node --test test/` must pass with zero dependencies installed beyond package.json. Every lib module ships
at least one test. No TypeScript; JSDoc types welcome.

## 2. Firmware facts everyone relies on (from CoffeeDingoFW)

- CAN IDs per module: `base+0` config TX (module → tool), `base+1` config RX (tool → module), `base+2+n` cyclic
  TX message n. DBCs in `renode/dbc/` are written for the DEFAULT base (PDM `0x0DE` → Msg0 = 224, CANBoard
  `0x640`); decode by `msgIndex = frameId − (base + 2)`. PDM: 28 cyclic msgs; CANBoard: 10.
- Param frame (both directions, DLC 8): `[cmd, idxLo, idxHi, subIdx, v0, v1, v2, v3]` (value little-endian u32).
  `cmd`: Read 1, Write 2, ReadParamNotFound 5, ReadAll 10, BurnSettings 30, Version 31, Sleep 32, Bootloader 33,
  CheckCrc 34, OutputTest see `core/enums.h`. Base ID = param index `0x0000` sub `0` (UInt16, 0..0x7FF).
  CAN speed = `0x0000/1`. Write reply echoes `[2, idx, sub, value]`.
- Burn: send `[30, 1, 3, 8, 0,0,0,0]` on `base+1`; reply `[30,1,3,8, ok, 0,0,0]` on `base+0`.
- Version: send `[31, 0..0]` (DLC 8) on `base+1`; reply `[31, boardId, 0, 0, major, minor, buildHi, buildLo]`,
  boardId 0 = PDM, 1 = PDM-Max, 2 = CANBoard. Current firmware 5.5.107.
- PDM Msg1/Msg2: outputs 1–4 / 5–8 current, u16 LE each, 0.1 A/bit. Msg3: byte n = state nibbles
  (low = output 2n+1, high = output 2n+2): Off 0, On 1, Overcurrent 2, Fault 3, Warning 4, OpenLoad 5; byte 4
  wiper outs, byte 6 flashers, byte 7 timers. Msg4: OC counts. Msg23: duty per output (only when PWM used).
  Everything else: parse from the DBC.
- Profet sense: `raw = clamp(I · 1200 · 4095 / (3.3 · kILIS), 0, 4095)`; kILIS 22950 (PDM out 1–2),
  5950 (PDM out 3–8, dual with DSEL), 35000 (PDM-Max). Saturation 63 A / 16.4 A / 96 A. Firmware noise floor
  0.5 / 0.2 / 1.0 A.
- Keypads: Blink Marine buttons `nodeId+0x180`, firmware → keypad `+0x200/+0x300/+0x400/+0x500`, NMT `0x000`;
  Grayhill buttons `+0x180`, LEDs `+0x200/+0x300`. Frame layouts: `functions/keypad/{blink,grayhill}/`.

## 3. Scene file — `scenes/<name>/scene.sim.json`

```jsonc
{
  "version": 1,
  "name": "example",
  "project": { "path": "scenes/example/example-vehicle.json", "hash": "sha1" },   // repo-relative when inside the repo
  "firmware": {                                   // per board kind
    "pdm":      { "source": "release", "tag": "v5.5.106" },      // or {"source":"local","path":"<firmware build dir>"}
    "pdmmax":   { "source": "release", "tag": "testing-latest" },
    "canboard": { "source": "local",   "path": "../CoffeeDingoFW/build" },
    "bootloader": false
  },
  "modules": [                                    // from the project; id = project module name
    { "id": "PDM-01", "kind": "pdm", "baseId": 1664, "pos": {"x": 0, "y": 0},
      "outputs":   [{ "n": 1, "name": "Low Beam x2", "enabled": true, "currentLimit": 12,
                      "inrushCurrentLimit": 50, "inrushTime": 1000, "resetMode": 0, "resetTime": 1000,
                      "resetCountLimit": 0, "pwmEnabled": false, "fixedDutyCycle": 0, "frequency": 0,
                      "primaryOutput": -1, "openLoadLimit": 0, "warnLimit": 0 }],   // openLoadLimit / warnLimit (A) optional
      "inputs":    [{ "n": 1, "name": "digitalInput0", "enabled": false, "mode": 0, "pull": 0, "invert": false }],
      "analogIn":  [],                            // canboard only: {n,name,enabled,rotary:{numPos,points[],positionNames[],tolerance}}
      "digitalOut": [] },                         // canboard only: {n,name,enabled}
    { "id": "CB-1", "kind": "canboard", "baseId": 1632, "pos": {"x": 0, "y": 400}, "outputs": [], "inputs": [...],
      "analogIn": [...], "digitalOut": [...] }
  ],
  "nodes": [                                      // everything that is not a module
    { "id": "n1", "type": "load",    "pos": {"x":1,"y":1}, "data": { "component": "halogen_headlight", "preset": "H4 low 55 W",
                                                            "ratedA": 3.99, "ratedW": 55, "fault": null, "guess": false } },
    { "id": "n2", "type": "switch",  "pos": {}, "data": { "kind": "toggle", "level": "12v", "state": false } },   // kind: toggle|momentary|3pos
    { "id": "n3", "type": "rotary",  "pos": {}, "data": { "positions": [{"name":"OFF","mV":500}], "index": 0, "noiseMv": 20 } },
    { "id": "n4", "type": "keypad",  "pos": {}, "data": { "model": "blink", "keys": 8, "nodeId": 21, "pressed": [false,...], "leds": [] } },
    { "id": "n5", "type": "cangen",  "pos": {}, "data": { "dbc": "renode/SimEngine.dbc", "frames": [{"id": 512, "cycleMs": 100, "signals": {"RPM": 850}}] } },
    { "id": "n6", "type": "engine",  "pos": {}, "data": { "state": "off", "throttle": 0, "speedKph": 0 } },      // state: off|ign|crank|run
    { "id": "n7", "type": "battery", "pos": {}, "data": { "vocV": 12.6, "riOhm": 0.015, "altV": 14.2 } },
    { "id": "n8", "type": "wiper",   "pos": {}, "data": { "ratedW": 60, "slowRps": 0.7, "fastRps": 1.2 } },
    { "id": "n9", "type": "pwmsrc",  "pos": {}, "data": { "level": "12v", "duty": 50, "freq": 100, "on": true } }   // level: 12v|gnd (open collector)
  ],
  "edges": [ { "id": "e1", "from": { "node": "n1", "handle": "supply" }, "to": { "node": "PDM-01", "handle": "out:1" } } ],
  "globals": { "noisePct": 1, "forceOutputsOn": false }  // forceOutputsOn: bring-up binds every enabled output to Always On
}
```

Handles. Module nodes (targets unless noted): `out:<n>`, `di:<n>`, `ai:<n>`, `do:<n>` (source), `vbatt` (source),
`temp` (source). Load: `supply` (source). Switch: `contact` (source). Rotary: `wiper` (source). Wiper node:
`supply` (source), `run` + `speed` (targets, from `do:<n>`), `park` (source → `di:<n>`). PWM source: `out` (source →
`di:<n>` of an input in PWM mode; action `{kind:'pwm', node, duty?, freq?, on?, level?}`). Engine: `alternator`
(source → battery `alt`), `fan` (target, from a load's `supply`… i.e. a second edge from the fan load). Battery:
`alt` (target), supply is implicit to every module. Fault object: `{ "kind": "open|short|stall|intermittent|hires|wrongpart", "atMs": 0 }`.

Edge rules: a load has exactly one `supply` edge; several loads may share one `out:<n>`; an `out:<n>` handle of a
paired/follower output (`primaryOutput >= 0`) accepts the same load as its primary (current split 50/50).

## 4. Component library — `lib/components/*.json`, `lib/components.js`

JSON entry:
```jsonc
{ "id": "halogen_headlight", "group": "Lighting", "name": "Halogen headlight", "family": "filament",
  "icon": "bulb", "keywords": ["low beam","high beam","head","spot","fog","driving","aux"],
  "defaults": { "kCold": 10, "tauMs": "10 + 0.6*W", "vExp": 0.55, "coolDownMs": 1500 },
  "presets": [ { "name": "H4 low 55 W", "W": 55 }, { "name": "H7 55 W", "W": 55 }, { "name": "100 W aux", "W": 100 } ],
  "pwm": { "onPhaseExp": 0.45 },
  "source": "tungsten cold/hot resistance ~1:10; tau from bench lore" }
```
Families: filament, led, hid, motor, actuator, coil, solenoid2, heater, ptc, glow, electronics,
amplifier, pulsed, strobe, compressor, resistive, wiper, table. Numeric defaults may be expressions in `W`
(rated watts) and `A` (rated amps), evaluated by `shapes.js` with a tiny safe evaluator (no `eval`).

`components.js` API:
```js
export function listComponents()                       // [{id, group, name, family, presets, icon}]
export function instantiate(id, { preset?, ratedW?, ratedA?, nominalV = 13.8 }) // → instance {component, ratedA, ratedW, params}
export function render(instance, { tableMs = 1, horizonMs = 10000 }) // → bank load object (section 5 "loads[]")
export function matchKeyword(outputName)               // → { id, multiplier, parts:[{id, presetName?}], guess:boolean }
```
`matchKeyword(name)`: `parts` = one unit (composites / `L+R` give several parts); `multiplier` repeats the whole
unit. Load count = `parts.length × multiplier`. Plural "relays"/"triggers" count as two coils.

Render options: slow families (heater, ptc, glow, compressor, hid) are rendered with
`{tableMs:100, horizonMs:600000}`, everything else with `{tableMs:1, horizonMs:10000}`; `scene.toBankScenes`
picks this per family.

`precheck.js`: `precheck(loadObjects[], outputConfig, kILIS) → [{level:'info'|'warn', text}]` (peak vs inrush
limit/time, steady vs currentLimit, saturation, open-load floor).

## 5. Bank protocol — TCP :7800, NDJSON, one JSON object per line, UTF-8

Direction bank → app unless marked (in). `machine` is the Renode machine name = project module id. Virtual time
`t` in seconds (float). Currents in A. All arrays are indexed `output-1`.

```jsonc
{ "type": "hello", "machine": "PDM-01", "board": "pdm", "outputs": 8, "inputs": 2, "analog": 0, "digitalOut": 0 }
{ "type": "scene", "machine": "PDM-01", "vbattV": 13.8, "noisePct": 1,                                   // (in) full replace for that machine
  "outputs": { "1": { "loads": [ { "id": "n1", "ratedA": 3.99, "vExp": 0.55, "tableMs": 1,
                                   "table": [39.9, 38.1, ...],            // A at t = k·tableMs while ON, from cold
                                   "steadyA": 3.99,                         // after the table ends
                                   "ripple": { "hz": 0, "pct": 0 }, "coolDownMs": 1500,
                                   "stallA": 0, "shortA": 999,              // for faults stall/short
                                   "pwm": { "onPhaseExp": 0.45 },
                                   "fault": null } ] } } }
{ "type": "fault", "machine": "PDM-04", "out": 1, "load": "n9", "kind": "stall", "atMs": 0 }           // (in) kind: open|short|stall|intermittent|hires|wrongpart|clear
{ "type": "vbatt", "machine": "*", "v": 12.2 }                                                        // (in) "*" = every machine
{ "type": "gpio", "machine": "PDM-01", "pin": "DI1", "value": 1 }                                     // (in) DI<n>; CANBoard DI1..8
{ "type": "pwm", "machine": "CB-2", "pin": "DI1", "duty": 25, "freq": 100 }                           // (in) duty = % HIGH; 0/100 or freq 0 = steady
{ "type": "adc", "machine": "CB-1", "ch": 1, "mV": 1500 }                                             // (in) CANBoard analog input n
{ "type": "temp", "machine": "PDM-03", "c": 85.0 }                                                    // (in) MCP9808 ambient
{ "type": "list" }                                                                                    // (in)
{ "type": "machines", "items": [ { "machine": "PDM-01", "board": "pdm", "outputs": 8 } ] }
{ "type": "trace", "machine": "PDM-01", "t": 12.345, "i": [0, 4.1, 0, 0, 0, 0, 0, 0], "on": [0,1,0,0,0,0,0,0],
  "duty": [0,100,0,0,0,0,0,0], "vbattV": 13.6, "tempC": 31.0 }                                      // 10 Hz virtual
{ "type": "trace", "machine": "CB-1", "t": 12.3, "do": [1,0,0,0], "di": [0,0,0,0,0,0,0,0], "mV": [500,1800,0,0,0] }
{ "type": "event", "machine": "PDM-01", "t": 30.0, "what": "wake-pulse" | "sleep" | "reset" }
```
Bank behaviour: per output, sum loads; each load keeps its own on-clock (starts when the output is requested on:
IN pin high or its timer running with CCR>0), restarts cold after `coolDownMs` off; `i = table[k]` or `steadyA`,
× `(V/13.8)^vExp`, × ripple, × fault overlay (open → 0; short → `shortA`; stall → `stallA`; intermittent → random
50–500 ms dropouts; hires → ×0.6; wrongpart → ×2), ± `noisePct`; PWM: on-phase `i · (1/duty)^onPhaseExp`
when duty < 1; paired outputs split 50/50; clamp to saturation; `FeedSample(raw, adcChannel, -1)`. DSEL
re-feed inside the GPIO callback.

Optional load-object fields: `loopMs` (strobe/pulsed — the table is one period; the bank loops it),
`settled:false` (curve not settled at `horizonMs`; `steadyA` = last table value), `pwm.model:'motor'` + `kLR`
(on-phase `steady·(1+(kLR−1)(1−duty))`), `pwm.pwmable:false`.

## 6. Bridge protocol — TCP :7777, SLCAN text, `\r`-terminated lines

Hub → client: every hub frame as `tIIILDD…\r` (std) or `TIIIIIIIILDD…\r` (ext), uppercase hex. Client → hub:
same for frames to inject; `O`, `C`, `S<n>`, `L`, `F`, `Z<n>` → reply `\r`; `V` → `V1013\r`; `N` → `NSIM0\r`;
unknown → `\a`. The Node app is the only TCP client; it fans out to the dingoConfig transport (COM port / tcp /
vcan) and keeps the fork's `I`/`X` extensions (`I` → `I` + 3-hex of the first PDM base + `\r`) in `bridge.js`.
`lib/slcan.js`: `encode(frame) → string`, `decode(line) → {id, ext, dlc, data:Uint8Array} | {cmd}`.

## 7. Renode control

Launch: `<renodeDir>/Renode.exe -P <monitorPort> --disable-gui --console <generated.resc>` (adjust flags to what
the installed build accepts; `renode.js` probes `--help`). Monitor over telnet on `<monitorPort>`; prompts end
with `) `. Commands used: `start`, `pause`, `emulation RunFor "0:0:60"`, `mach set "PDM-01"`, `machine Reset`,
`sysbus.loadBank <Method> …`, `quit`. The generated `.resc` creates the hub, the bridge, every machine from its
template with `$elf`, `$name`, `$nv` (FRAM/flash image path) and writes the ROM calibration words.

## 8. Server ↔ UI — WebSocket `/ws`, JSON

Server → UI:
```jsonc
{ "type": "snapshot", "scene": {...}, "renode": {...}, "modules": {...}, "components": [...], "runs": [...] }
{ "type": "scene", "scene": {...} }                                   // after any server-side change (populate, load)
{ "type": "telemetry", "module": "PDM-01", "t": 12.3, "outputs": [ { "n": 1, "state": "On", "currentA": 4.1, "duty": 100, "ocCount": 0 } ],
  "inputs": [false,false], "positions": [], "asleep": false, "vbattV": 13.6, "tempC": 31 }
{ "type": "trace", "machine": "PDM-01", "t": 12.3, "i": [...], "on": [...] }
{ "type": "bus", "frame": { "id": 1666, "dlc": 8, "data": [..], "dir": "rx" } }                     // throttled, for the log view
{ "type": "renode", "status": "stopped|downloading|starting|running|paused|error", "vtime": 12.3, "log": ["..."] }
{ "type": "keypad", "node": "n4", "leds": [ { "key": 0, "color": "red", "blink": false } ] }
{ "type": "toast", "level": "info|warn|error", "text": "..." }
```
UI → server:
```jsonc
{ "type": "scene", "scene": {...} }                                   // full replace (debounced 300 ms by the UI)
{ "type": "action", "action": { "kind": "switch", "node": "n2", "state": true } }
{ "type": "action", "action": { "kind": "rotary", "node": "n3", "index": 2 } }
{ "type": "action", "action": { "kind": "keypad", "node": "n4", "key": 3, "pressed": true } }
{ "type": "action", "action": { "kind": "fault", "node": "n1", "fault": { "kind": "stall", "atMs": 0 } } }   // fault null = clear
{ "type": "action", "action": { "kind": "battery", "node": "n7", "vocV": 12.0 } }
{ "type": "action", "action": { "kind": "engine", "node": "n6", "state": "run", "throttle": 20 } }
{ "type": "action", "action": { "kind": "temp", "module": "PDM-03", "c": 85 } }
{ "type": "action", "action": { "kind": "renode", "cmd": "start|stop|pause|resume|runfor|reset|sleep|wake", "seconds": 60, "module": "PDM-03" } }
{ "type": "action", "action": { "kind": "renode", "cmd": "inspect", "module": "CB-1", "read": [1073767436] } }   // PC, BASEPRI, PRIMASK, xPSR + sysbus words (diagnostics)
{ "type": "action", "action": { "kind": "renode", "cmd": "hubstats", "watch": 1633 } }   // per-module CAN delivery counters (PacedCANHub); watch = count one id
{ "type": "populate", "projectPath": "..." }
{ "type": "record", "cmd": "start|stop|replay|golden|diff", "run": "2026-10-06T10-00-00.run.json" }
```
REST (JSON): `GET /api/snapshot`, `GET /api/components`, `GET /api/project?path=`, `POST /api/scene`,
`GET /api/firmware/releases` → `[{tag, assets:[{name,url}]}]`, `GET /api/runs`, `GET /api/run/:name`.
Recording = the UI→server `action` stream stamped with Renode virtual time plus the telemetry stream.

## 9. Project import — `lib/project.js` (pure) + `server/project.js` (fs)

Input: dingoConfig `ConfigFile` JSON (fork and original share the schema; unknown keys ignored):
`PdmDevices[]`, `PdmMaxDevices[]?`, `CanboardDevices[]`, `DbcDevices[]`, `BlinkMarineKeypads[]`, `GrayhillKeypads[]`.
Output: the `modules[]` of section 3. `lib/populate.js`: `populate(modules, components) → {nodes, edges, notes[]}`
(multipliers `x2`, composites `+ & and L+R`, keyword match, sizing 60 % of
`currentLimit`, rotary knobs from `analogIn[].rotary`, switches from enabled inputs, wiper relay wiring, always a
battery and an engine). `notes[]` = config observations (reset mode None, inrush above saturation…).
The optional output fields `openLoadLimit` (A) and `warnLimit` (A) are read by precheck and the populate notes.

