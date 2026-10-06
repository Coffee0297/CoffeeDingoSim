# ProfetLoadBank: the simulated harness

`renode/models/ProfetLoadBank.cs` is the load bank behind every module (docs/interfaces.md §5). There is one
instance per machine and one NDJSON TCP listener (default `127.0.0.1:7800`) shared by every instance in the
Renode process. Smoke test: run `node renode/test/bank_probe.mjs` from the repo root. It starts its own Renode
(monitor :1298, bank :7899, no firmware) and runs 30 checks.

## What it does every 1 ms of virtual time

1. Reads each output's drive. An output counts as on when its IN pin (a GPIO input) is high **or** its PWM
   timer is running (`CR1.CEN && CCR1 > 0`). Duty is `CCR1 / (ARR + 1)` (ChibiOS sets ARR = period − 1).
   Timers: PDM out1–8 use TIM3, 4, 5, 9, 10, 11, 12, 13; PDM-Max out1–4 use TIM3, 4, 5, 9; CANBoard
   DO1–4 use TIM3, 15, 16, 17. All are channel 1 (see `port_pwm.h`). `pwmDisableChannel` writes CCR1 = 0,
   which reads as off.
2. Computes each load's current:
   - Each load has its own on-clock. After `coolDownMs` off it restarts cold, otherwise it resumes.
   - The base is the `table` at `tableMs` with linear interpolation. It loops when `loopMs` > 0 and uses
     `steadyA` after the table ends.
   - Scaling: × `(V/13.8)^vExp`, then × ripple `1 + pct/100·sin(2π·hz·t)`.
   - PWM on-phase: `(1/d)^onPhaseExp` by default, `1+(kLR−1)(1−d)` for `pwm.model:"motor"`, and no scaling
     for `pwm.pwmable:false`.
   - Fault overlay, once `onMs ≥ atMs`: open → 0, short → `shortA`, stall → `stallA·V/13.8`,
     intermittent → 50–500 ms dropouts every 200–2000 ms, hires → ×0.6, wrongpart → ×2.
3. Combines loads per output:
   - Sums the loads, then applies ± `noisePct`. The noise is uniform and deterministic: a xorshift seeded
     from the machine name or from `seed`.
   - Clamps to the Profet saturation (63 / 16.4 / 96 A).
   - Converts to counts: `raw = round(I·1200·4095/(3.3·kILIS))`, clamped to 4095.
4. Feeds the ADC. A value is fed only when it changes. Reset clears the cache, so everything is fed again
   after a reset.
   - **PDM**: IS1 → IN0, IS2 → IN12, IS3_4 → IN13, IS5_6 → IN1, IS7_8 → IN2.
     - On the dual channels, DSEL picks the output: low = 3/5/7, high = 4/6/8. The value is re-fed
       **inside** the DSEL `OnGPIO`, not on the next tick.
     - BattVolt → IN3 (`V·4.7/51.7/3.3·4095`).
     - TEMP → IN16 = `tempRaw` (943 = 30 °C with the .resc cal words).
     - VREFINT → IN17 = `vrefRaw` (1500).
   - **PDM-Max**: IS1 → IN13, IS2 → IN12, IS3 → IN0, IS4 → IN1, BattVolt IN3, TEMP IN16, VREFINT IN17.
   - **CANBoard**: AI1–4 → `adc` IN1–4, AI5 → `adc2` IN1, TEMP → `adc` IN16.
     - The `adc` message carries the **terminal** mV, which is what the firmware reports as
       `fValMillivolts`. The bank applies the 4k7/10k divider itself.
     - `STM32F3_ADC` takes millivolts (`SetADCValue`). The F4 `STM32_ADC` takes raw counts
       (`FeedSample(raw, ch, -1)`).
5. Handles sleep and wake:
   - Every 10 ms it polls `SCB->SCR.SLEEPDEEP` (0xE000ED10 bit 2). When the bit sets, it sends `event sleep`.
   - While SLEEPDEEP is set, any CAN hub frame makes it toggle the CAN-RX GPIO once (at most every 50 ms)
     and send `event wake-pulse`. The firmware arms the PB8 / PA11 EXTI on both edges (`core/sleep.cpp`),
     so one toggle gives one edge.
   - A machine reset sends `event reset`. Any DI levels the bank holds are driven again after the reset.
6. Sends a `trace` every 100 ticks (10 Hz virtual).

## Attaching it to dingopdm_v7.repl

```
// ---------------- load bank (renode/models/ProfetLoadBank.cs) ----------------
loadBank: Miscellaneous.ProfetLoadBank @ sysbus 0x5FFE0000
    board: "pdm"
    adc: adc1
    port: 7800

// Profet IN lines -> bank inputs 0..7 (out1..out8), DSEL lines -> 8..10
gpioPortB:
    10 -> loadBank@0     // out1 PB10
    12 -> loadBank@3     // out4 PB12
    1  -> loadBank@4     // out5 PB1
    14 -> loadBank@8     // DSEL 3/4 PB14

gpioPortC:
    8  -> loadBank@1     // out2 PC8
    6  -> loadBank@2     // out3 PC6
    4  -> loadBank@5     // out6 PC4
    5  -> loadBank@9     // DSEL 5/6 PC5

gpioPortA:
    7  -> loadBank@6     // out7 PA7
    4  -> loadBank@7     // out8 PA4
    5  -> loadBank@10    // DSEL 7/8 PA5

// bank outputs -> GPIO port inputs: DI1 PA10, DI2 PC9, CAN RX wake PB8
loadBank:
    0 -> gpioPortA@10
    1 -> gpioPortC@9
    8 -> gpioPortB@8
```

A `gpioPortX: n -> loadBank@k` entry replaces that pin's `-> exti@n` connection. That is fine here because
none of the IN or DSEL pins is a wake source. The bank → port entries drive the port's *input* side, which still
reaches EXTI.

### dingopdmmax_v1.repl

```
loadBank: Miscellaneous.ProfetLoadBank @ sysbus 0x5FFE0000
    board: "pdmmax"
    adc: adc1
    port: 7800

gpioPortB:
    14 -> loadBank@0     // out1 PB14
    0  -> loadBank@2     // out3 PB0
gpioPortC:
    7  -> loadBank@1     // out2 PC7
gpioPortA:
    6  -> loadBank@3     // out4 PA6

loadBank:
    0 -> gpioPortA@10    // DI1 PA10
    1 -> gpioPortC@9     // DI2 PC9
    8 -> gpioPortB@8     // CAN RX PB8
```

### canboard_v2.repl

```
loadBank: Miscellaneous.ProfetLoadBank @ sysbus 0x5FFE0000
    board: "canboard"
    adc: adc1
    adc2: adc2
    port: 7800

// DO1..DO4 watched (PA15, PB3, PB4, PB5)
gpioPortA:
    15 -> loadBank@0
gpioPortB:
    3  -> loadBank@1
    4  -> loadBank@2
    5  -> loadBank@3

// DI1..DI8 = PA5 PA6 PA7 PB0 PB1 PA8 PA9 PA10, CAN RX wake PA11
loadBank:
    0 -> gpioPortA@5
    1 -> gpioPortA@6
    2 -> gpioPortA@7
    3 -> gpioPortB@0
    4 -> gpioPortB@1
    5 -> gpioPortA@8
    6 -> gpioPortA@9
    7 -> gpioPortA@10
    8 -> gpioPortA@11
```

`Analog.STM32F3_ADC` declares a 0x400 window, so ADC1 at 0x50000000 and ADC2 at 0x50000100 overlap. Register
them with explicit windows. This form is tested in `renode/test/bank_canboard.resc`:

```
adc1: Analog.STM32F3_ADC @ sysbus <0x50000000, +0x100>
    referenceVoltage: 3.3
    externalEventFrequency: 1000000
adc2: Analog.STM32F3_ADC @ sysbus <0x50000100, +0x100>
    referenceVoltage: 3.3
    externalEventFrequency: 1000000
```

The CANBoard TEMP cal word (`0x1FFFF7B8`) must match `tempRaw` (default 943) to read 30 °C.

## .resc

```
include @renode/models/ProfetLoadBank.cs      # ONCE per Renode process, before the first .repl that uses it
...
mach create "PDM-01"
machine LoadPlatformDescription @renode/platforms/dingopdm_v7.repl
connector Connect sysbus.loadBank vehicle     # per machine: the bank sees hub frames for the wake pulse
```

Every machine's .repl can say `port: 7800`. The first bank opens the listener. If a later bank asks for a
different port, the bank logs it and ignores it. Including the `.cs` twice compiles a second assembly with a
second static listener, which fails with "cannot listen". Once the bank is attached, the manual
`sysbus.adc1 FeedSample …` lines in `pdm_single.resc` are no longer needed: the bank feeds
IN0/1/2/3/12/13/16/17 on its first tick and overrides them.

Constructor parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `board` | `"pdm"` | `"pdm"`, `"pdmmax"` or `"canboard"` |
| `adc` | — | the ADC the bank feeds |
| `adc2` | — | second ADC (CANBoard only) |
| `port` | 7800 | NDJSON listener port |
| `tempRaw` | 943 | TEMP channel value |
| `vrefRaw` | 1500 | VREFINT channel value |
| `vbattV` | 13.8 | initial battery voltage |
| `seed` | 0 | noise seed; 0 = derive from the machine name |

## Monitor methods (`sysbus.loadBank <Method> …`)

| Method | Effect |
|---|---|
| `LoadScene @path` | file holding one `scene` message, an array of messages, or NDJSON; entries for other machines are skipped |
| `Fault 1 "stall" 0` | fault on every load of out1 (`clear` removes) |
| `SetVbatt 12.2`, `SetNoise 1` | supply / noise |
| `Current 1` → A, `Raw 1` → counts | last modelled value |
| `SetInput 1 true` | drive DI1 |
| `SetAnalog 1 1500` | CANBoard AI1 terminal mV |
| `SetTemp 85` | forwards to the machine's MCP9808 (`SetTemperature`), logs a warning if there is none |
| `WakePulse` | toggle CAN RX now (for a Node server that prefers the monitor to the hub path) |
| `Message "<json>"` | apply one protocol message to this bank (quoting JSON in the monitor is awkward, so prefer `LoadScene`) |
| `OnGPIO 0 true` | IGPIOReceiver entry, e.g. to fake an IN line without firmware |
| `Dump` | JSON state: currents, raw, on, duty, inputs, DI, mV, fed ADC values, per-load clocks and faults |

Reading the bank's bus window with `ReadDoubleWord`: `0x00+4n` is the raw value of output n+1, `0x40` is
vbatt in mV and `0x44` is the tick count.

## Protocol details beyond docs/interfaces.md §5

- A message with no `machine`, or with `"*"`, goes to every bank. An unknown machine gets
  `{"type":"error","msg":…}` back, and so does bad JSON. A new bank sends `hello` to clients that are already
  connected.
- `scene` replaces everything, with one exception: a load whose id is still on the same output keeps its
  on-clock. Editing a scene therefore does not re-inrush a lamp that is already hot.
- A load id that appears on several outputs is one physical load fed in parallel (paired outputs). Its current
  is divided by the number of those outputs that are on.
- Load field defaults: `vExp` 1, `tableMs` 1, `coolDownMs` 1500, `shortA` 999. `steadyA` defaults to the last
  table value, or `ratedA` if there is no table. A load's `fault` can be `null`, a kind string, or
  `{kind, atMs}`.
- `trace.i` is the **on-phase** current the bank feeds, which is what the firmware samples. It is not the PWM
  average. `duty` is in %, and a plain IN-driven output reports 100. CANBoard traces carry `do`, `duty`, `di`
  and `mV`.
- `event.what` is one of `sleep`, `wake-pulse` or `reset`.

## Renode 1.16.1 facts learned (portable build, .NET 8)

- `include @x.cs` compiles fine against plain BCL and Renode types. The model carries its own JSON parser, so
  it does not depend on which assemblies the ad-hoc compiler references. The portable folder ships both
  `System.Text.Json.dll` and `Newtonsoft.Json.dll`, but neither was tried from a script.
- To be reachable as `sysbus.loadBank …`, a peripheral must be registered on sysbus. Implement
  `IDoubleWordPeripheral, IKnownSize` and give it an unused address.
- A one-line `LoadPlatformDescriptionFromString "…"` cannot hold GPIO connection entries:
  `gpioPortB: 10 -> loadBank@0` fails with "Syntax error, unexpected '1'". Use a triple-quoted multi-line
  string in the .resc: `machine LoadPlatformDescriptionFromString """ … """`.
- Numbered GPIO outputs come from `INumberedGPIOOutput.Connections`, a `Dictionary<int, IGPIO>` of
  `new GPIO()`. Wire them in .repl as `loadBank:` followed by an indented `0 -> gpioPortA@10`.
- `STM32_GPIOPort.OnGPIO` on an input pin forwards to the pin's connections and shows up in IDR. So
  `sysbus.gpioPortB OnGPIO 10 true` reaches the bank.
- On the F4 `STM32_ADC`, `FeedSample(v, ch, -1)` replaces the held sample. The converter latches the sample
  when a conversion starts, so a single-conversion register poke reads the previous value in DR. This does not
  matter for the firmware's circular scan.
- `STM32F3_ADC` has no `FeedSample`. Use `IADC.SetADCValue(ch, mV)` and `GetADCValue`.
- `STM32_Timer` CR1/ARR/CCR1 can be read through `machine.SystemBus.ReadDoubleWord` without warnings. The NVIC
  exposes SCR, so reading `0xE000ED10` gives SLEEPDEEP.
- `EmulationManager.Instance.CurrentEmulation.TryGetMachineName(machine, out name)` returns the name given to
  `mach create`. Machines in one emulation share virtual time
  (`machine.ElapsedVirtualTime.TimeElapsed.TotalSeconds`).
- The stock `platforms/cpus/stm32f4.repl` downloads an SVD from dl.antmicro.com when it loads, so it needs
  network access once.

## Open issues

- **Sleep detection is untested with real firmware.** It reads SCR.SLEEPDEEP and has not been run against a
  firmware `EnterStopMode`. Mapping `AIRCR.SYSRESETREQ` to a machine reset is the platform's job (NVIC); the bank
  only reports `reset`.
- **Wake pulse needs the hub connection.** The bank only sees frames after
  `connector Connect sysbus.loadBank vehicle`. Without it, call `WakePulse` from the monitor.
- **The CANBoard path ran on a stand-in platform.** It was exercised on the F4 test platform with F3 ADCs, not
  on `canboard_v2.repl`. The F3 ADC channel index is assumed to equal the input number (IN1 → 1).
- **PWM duty on CANBoard DOs is reported (`duty`) but not used in any model.**
