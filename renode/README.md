# renode/ — the real dingoPDM firmware on Renode

The unmodified `dingopdm_v7.elf` boots in Renode 1.16.1, runs in real time, talks CAN through an SLCAN-over-TCP
bridge, keeps its config in a file-backed FRAM, and reads its battery, temperature and Profet current-sense
inputs from the simulator. Install Renode first: [`../tools/install-renode.md`](../tools/install-renode.md).

## Files

| File | What it is |
|---|---|
| `platforms/dingopdm_v7.repl` | STM32F446RE platform: 144 MHz core, 72 MHz timers, I2C FRAM + MCP9808, ADC1 on circular DMA, OTG stub, DWT, LEDs, load bank wiring |
| `models/STM32DMA_Circ.cs` | fork of Renode's `STM32DMA` with CIRC mode and one data unit per peripheral request (ADC scan) |
| `models/STM32F4_I2C_DMA.cs` | I2Cv1 master with DMA, written against the ChibiOS I2Cv1 driver's event sequence |
| `models/Mb85rc256.cs` | MB85RC256V FRAM, 2-byte address, file-backed (`Filename`), saved after every write |
| `models/Mcp9808.cs` | MCP9808 with correct IDs, limits, alert bits; `SetTemperature <C>` |
| `models/CortexMDwt.cs` | DWT CTRL + CYCCNT (ChibiOS polled delays) |
| `models/ChibiOsFix.cs` | workaround for Renode's ICSR.RETTOBASE and stale-active bugs (below); `sysbus.chibiosFix Install` after LoadELF |
| `models/SlcanTcpBridge.cs` | CAN hub member + SLCAN text server (docs/interfaces.md §6), `FramesSeen`, `FramesInjected` |
| `models/PacedCANHub.cs` | the vehicle CAN hub: per-receiver delivery one frame time apart (sharp edge 13), `Stats` |
| `models/load_models.py` | `coffeesim_load "<anchor>" "X.cs" …` compiles each model once per Renode process |
| `models/ProfetLoadBank.cs` | the load bank (see `BANK.md`) |
| `templates/car.resc.hbs`, `templates/dingopdm_v7.resc.hbs` | rendered by `server/renode.js generateResc` |
| `test/pdm_single.resc` | one PDM + bridge, hand-written (run from the repo root; `<FW>`/`<REPO>` placeholders for the firmware and nv paths) |
| `test/gen_single.mjs` | renders a one-PDM scene through the real templates into `test/gen/` |
| `test/start_empty.sh`, `test/mon.mjs`, `test/slcan_probe.mjs`, `test/canhelp.py` | test helpers |

## Run one PDM

Through the real templates (what the server does):

```
node renode/test/gen_single.mjs                     # -> renode/test/gen/r1single.resc (firmware: $SIM_FW_DIR or ../CoffeeDingoFW/build)
<renode> -P 1234 --disable-gui --plain <absolute path of this repo>/renode/test/gen/r1single.resc
node renode/test/mon.mjs start
node renode/test/slcan_probe.mjs 3 t0DF81F00000000000000     # Version request -> t0DE81F0000000505006B
```

`<renode>` is the executable `npm start` downloaded into `cache/renode` (or your `RENODE_EXE`).

Or the hand-written script, started empty so script errors are visible on the monitor. `pdm_single.resc` has
`<FW>` / `<REPO>` placeholders for the absolute firmware and nv paths; set them first:

```
./renode/test/start_empty.sh                        # Renode from RENODE_EXE / RENODE_DIR / cache/renode
MON_WAIT_MS=60000 node renode/test/mon.mjs '$elf=@/abs/fw/build/dingopdm_v7.elf' '$nv=@/abs/repo/renode/test/nv/PDM-01.bin' "include @renode/test/pdm_single.resc"
node renode/test/mon.mjs start
```

`start_empty.sh` only kills the Renode it started itself (`test/renode.pid`). Other tests may run their own.

## What was verified (2026-10-06, firmware 5.5.107 `CoffeeDingoFW/build/dingopdm_v7.elf`)

| Check | Result | Evidence |
|---|---|---|
| boots, no hang in halInit/clock/OTG/I2C | PASS | status LED on, error LED off, ChibiOS threads scheduled |
| real-time speed | PASS | 21.5 s virtual in 21.5 s host (one PDM) |
| cyclic frames | PASS | Msg0–Msg4 at 10 Hz on 0x0E0–0x0E4 (default base 0x0DE) |
| Version request | PASS | `t0DF81F00000000000000` → `t0DE81F0000000505006B` = board 0, 5.5.107 |
| param Write / Read / Burn | PASS | Write 0x1000/0=1 echoed; Burn `t0DF81E01030800000000` → `…1E0103080100…` (ok=1) |
| config persistence (FRAM file) | PASS | new Renode process, Read 0x1000/0 → 1 |
| ADC path, cal words, VREFINT | PASS | Msg0 battery 0x008A = 13.8 V, board temp 0x012C = 30.0 °C (MCP9808) |
| Profet IS → current | PASS | out1 enabled, `sysbus.adc1 FeedSample 650 0 -1` → Msg1 out1 0x0064 = 10.0 A, total 10.0 A |
| digital input via the bank | PASS | DI1 enabled (0x1200/0=1), `sysbus.loadBank SetInput 1 true` → Msg0 byte0 = 01 |

## Sharp edges found (all fixed in these files)

1. **Clocks.** PLL M5 N180 P2 from 8 MHz gives SYSCLK **144 MHz**, not 180. APB1/2 = 36 MHz, timer clocks
   **72 MHz**. ChibiOS writes TIM2 PSC = 7199 for its 10 kHz tick, which only works at 72 MHz.
2. **ICSR.RETTOBASE reads 0 in an ISR** (TIM2 ISR read ICSR = 0x0000002C) in this Renode build. ChibiOS's
   `__port_irq_epilogue` then never preempts: the first `chThdSleep` parks the CPU in the idle thread for good.
   `ChibiOsFix.Install` repoints the epilogue's SCB literal (0xE000ED00) to a C# window that returns ICSR with
   RETTOBASE recomputed. A CPU hook on the same instruction also works but runs at 1–10 % of real time.
3. **DWT CYCCNT is not modelled**, so ChibiOS polled delays spin forever. Use `CortexMDwt.cs`.
4. **I2C DMA.** Renode's `STM32F1_I2C` ignores DMAEN, clears ADDR on any SR2 read, and fakes RxNE on a DR read.
   ChibiOS reads SR2 before SR1 and moves all data by DMA, so every transfer timed out. That ended in
   `SetFatalError(ErrTempSensor)` before the device thread, which answers requests, ever started. Use
   `STM32F4_I2C_DMA.cs`.
5. **DMA.** Upstream `STM32DMA` has no CIRC mode, so the ADC sample array froze after one sweep. In P2M mode it
   also used the FIFO-threshold burst size. Use `STM32DMA_Circ.cs`.
6. **ADC DR is read 16-bit by DMA**: `sysbus EnableAllTranslations sysbus.adc1`.
7. **Unfed ADC channels** return 0 with a warning on every conversion. VREFINT (IN17) **must** be fed, because
   `GetVDDA()` divides by it. The bank feeds IN0/1/2/3/12/13/16/17. `pdm_single.resc` feeds them by hand.
8. **Factory cal words** (`0x1FFF7A2A/2C/2E`) are zero in Renode's ROM. Write 1500/943/1194.
9. **Monitor scripting**: `$vars` are not expanded inside quotes, there is no `$ORIGIN`, and relative `@paths`
   resolve against the Renode install directory, not the cwd. Templates therefore use absolute paths.
   `include @x.cs` compiles a new assembly every time, so use `coffeesim_load`.
10. **`machine Reset` wipes the loaded ELF** ("PC does not lay in memory") unless the machine has a `reset`
    macro, defined while that machine is selected (Renode looks for `<machine>.reset`). It also runs on the
    firmware's own NVIC system reset, so without it a module that resets itself goes silent for good. Both
    board templates define it (ELF, ChibiOsFix, VTOR, config image, cal words).
11. Script errors during a startup `.resc` (passed on the command line with `-P`) are not in the log. Include
    the script from a monitor connection to see them.
12. **Stale NVIC active bit.** Under CAN load an external IRQ (seen: CAN1 RX0) can stay set in IABR after
    its handler returned, while the CPU runs thread code. ChibiOsFix then counts two active exceptions in
    every later ISR, never allows a preemption, and the module idles with its threads READY: silent on the
    bus, RX FIFO full. `ChibiOsFix` clears active bits seen while IPSR = 0 (Thread mode, where none can be
    active) from a 1 kHz check; `StaleActiveCleared` (window offset 0xC) counts the repairs.
13. **Quantum bursts.** Renode's `CANHub` hands a frame to the other machines at the sender's timestamp and a
    machine ahead in time sees it at the next quantum sync, while the modules also send their cyclic frames
    in lockstep. A receiver then gets ~10 frames at one instant and its 3-deep bxCAN FIFO overflows.
    `PacedCANHub.cs` (`emulation CreatePacedCANHub`) delivers to each receiver one frame time apart;
    `vehicle Stats` / `vehicle WatchId <id>` give per-port counters. That made a 1 ms quantum usable
    (0.31x -> ~0.7x real time with 7 machines at 100 us).
14. **Idle CPUs skip to the quantum end.** A Renode CPU with nothing to run is advanced to the end of the
    quantum in one step, so every clock event of that quantum (paced deliveries included) fires before its
    firmware runs again: at a 1 ms quantum ~10 % of deliveries met a full FIFO (none at 100 us). The paced hub
    therefore holds a frame while the receiver has 2 pending (`holds` in `vehicle Stats`), up to ~10 ms, then
    delivers anyway so a firmware that really stops draining still overruns. Note: STMCAN's
    `FifoMessagesPending` field is never updated; the real depth is its private `RxFifo[]` queues.
15. **Bursty tool traffic.** `SlcanTcpBridge` injects one frame per ms (a USB/serial adapter); injecting a
    whole host burst in one tick overflowed the receivers.
16. **Lock order in models.** Never change a clock entry while holding a model lock that a clock callback
    also takes (`STM32F4_I2C_DMA` did: the whole emulation deadlocked at 0 % CPU). Record the request under
    the lock, apply it after.
    Bus reads from a clock callback are the same trap: sysbus holds the target's access lock, and a CPU
    writing a timer/SysTick register holds that lock while asking the clock source. `ProfetLoadBank` reads
    PWM timers and SCB->SCR with `TryReadBus` (`Monitor.TryEnter` on sysbus's private per-peripheral lock,
    keeping the last value when busy); it froze the emulation under `emulation RunFor`.

## Not verified / open

- Multi-PDM and CANBoard scenes (`car.resc.hbs` is rendered and tested with one PDM only).
- Sleep/wake (WFI + `NVIC_SystemReset`) and the OpenBLT bootloader in sector 0.
- PWM outputs (timer model output-compare vs ChibiOS PWM driver); duty reading is the bank's job.
- The bank's `${bankLine}` (`sysbus.loadBank Configure …`) is left as a comment: the bank has no `Configure`.
  Board and port come from the `.repl`.

## API notes for model authors (Renode 1.16.1, verified here)

- **GPIO wiring (.repl)**: `gpioPortB:` then indented `10 -> loadBank@0` connects port output pin 10 to the
  bank's input 0. A peripheral exposing `INumberedGPIOOutput.Connections` is wired as `loadBank:` then
  `0 -> gpioPortA@10`, which drives the port's *input* side, shows in IDR and still reaches EXTI. A pin
  connection replaces that pin's `-> exti@n` entry. Named GPIO properties use `DMARequest -> dma2@4`.
- **Periodic virtual-time callbacks (C#)**: `machine.ClockSource.AddClockEntry(new ClockEntry(period: 1,
  frequency: 1000, handler: Tick, owner: this, localName: "x", enabled: true, workMode: WorkMode.Periodic))`
  (`using Antmicro.Renode.Time`). Reschedule one-shots with `ExchangeClockEntryWith(handler, e => e.With(enabled: true, value: 0))`.
- **Frames from a foreign thread** (sockets) must be queued and raised from a clock entry, never from the
  socket thread (see `SlcanTcpBridge.cs`).
- **FeedSample**: `sysbus.adc1 FeedSample <raw> <ADC input number> -1` holds the value. A positive repeat
  queues values, then the channel reads 0. The channel is the input number, not the scan slot.
- **Timer registers from C#**: `machine.SystemBus.ReadDoubleWord(0x40000400 + 0x00/0x2C/0x34)` gives TIM3
  CR1/ARR/CCR1 with no side effects.
- **CPU hooks**: from C# `((ICpuSupportingGdb)cpu).AddHook(addr, (c, pc) => …)`. From Python the argument
  must be a callable, not a script string. Any hook on a hot path costs a lot of speed, so prefer a data patch
  or a peripheral window.
- **Byte access**: DMA moves I2C DR as bytes, so a peripheral that DMA touches must implement `IBytePeripheral`
  (or enable translations for it).
- **Injecting a frame into a controller** from the monitor: `include @renode/test/canhelp.py`, then
  `can_inject sysbus.can1 0xDF "1F00000000000000"`.
