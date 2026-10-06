# CoffeeDingoSim

Vehicle simulator for **dingoPDM / dingoPDM-Max / CANBoard**: the real firmware images run in
[Renode](https://renode.io) on a virtual CAN bus; a graphical canvas lets you drop bulbs, pumps, fans, switches,
rotary knobs, keypads, an engine and a battery and wire them to the modules of a dingoConfig project *by name*;
any dingoConfig (original or fork) connects to the bus as if a USB-CAN stick were plugged in.

Status: **under construction**. File formats and protocols (scene, load bank, SLCAN bridge, WebSocket) are
described in [`docs/interfaces.md`](docs/interfaces.md).

## Run

```
npm install
npm run build        # Svelte UI → app/dist
npm start            # http://localhost:8787  (downloads Renode into cache/renode on first start)
```

`RENODE_EXE` / `RENODE_DIR` point at an existing Renode instead (see
[`tools/install-renode.md`](tools/install-renode.md)). The default scene is `scenes/example` (two dingoPDMs and a
CANBoard, project `scenes/example/example-vehicle.json`); pick another with `SIM_SCENE=<name>`.

Open the UI, **Load project** (a dingoConfig `.json`, e.g. `scenes/example/example-vehicle.json`),
**Populate**, **Start** Renode, then connect dingoConfig to the bridge:

- fork: adapter `SLCAN`, port `tcp://127.0.0.1:7778`
- original: adapter `SLCAN`, port `COM6` after installing a virtual COM pair with the
  [signed com0com installer](https://alge-timing.com/alge/download/driver/Com0ComSetup.exe) — see
  [`tools/install-com0com.md`](tools/install-com0com.md)

## Layout

| Path | What |
|---|---|
| `server/` | Node 24: web/ws server, Renode launcher + monitor, bank and bridge links, DBC telemetry decode, record/replay, MCP |
| `app/` | Svelte 5 + Svelte Flow canvas, charts, Renode and runs panels |
| `lib/` | pure JS shared by all: component library and curve shapes, pre-check, DBC, SLCAN, param protocol, project import, populate, engine, battery |
| `renode/` | platform descriptions, C# models (load bank, SLCAN bridge, MCP9808, OTG stub), script templates, DBCs, bring-up tools in `renode/test/` |
| `scenes/` | scene files (`scenes/example`: example project and scene; `renode/test/e2e_vehicle.mjs` records its golden run); per-module FRAM/flash images and recorded runs are generated here |
| `tools/` | install notes, CI script |

Tests: `npm test` (Node's built-in runner, no extra dependencies). End-to-end run against real Renode and
firmware: `node renode/test/e2e_vehicle.mjs` (firmware from `SIM_FW_DIR`, default `../CoffeeDingoFW/build`).
