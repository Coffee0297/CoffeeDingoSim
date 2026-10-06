# CANBoard v2 on Renode

The real CANBoard firmware (`canboard_v2.elf`, STM32F303K8, app at `0x08004000`) boots in Renode
1.16.1+20260623git3f5a91013. `renode/test/cb_probe.mjs` checks it end to end and passes on every item:

| Check | Evidence (cb_probe.mjs run, 2026-10-06) |
|---|---|
| a) boots without hang | 0x642 ×30 in 3 s, PC moving |
| b) cyclic frames from default base 0x640 | 0x642 / 0x643 / 0x644 at 10 Hz each. 0x645.. are sent only when their functions are enabled |
| c) Version on 0x641 → reply on 0x640 | `1F 02 00 00 05 05 00 6B`: boardId 2, 5.5.107 |
| d) analog input → telemetry | bank `SetAnalog 1 1500`, `4 2750`, `5 4000` gives 0x642 `ADCVolt_1` 1.499 V, `ADCVolt_4` 2.749 V, 0x643 `ADCVolt5` 4.000 V, `BoardTemp` 30 |
| e) base ID burn persists | write 0x660 → burn → `machine Reset` → talks on 0x660. A fresh Renode process reloads the nv file and still talks on 0x660 |
| first boot | an erased config sector makes the firmware write its defaults, so the nv file exists (2048 B) after the first boot |
| template | `cb_template.mjs` renders a one-CANBoard scene with `server/renode.js generateResc`, includes it over the monitor with no errors, boots it, and passes `runMacro $reset_<id>` |
| DI | bank `SetInput 1/5/8 true` plus enabling DI1/5/8 (param `0x1200+i`/0 = 1) gives 0x644 byte 4 = `0x91` |

## Files

| File | What |
|---|---|
| `platforms/canboard_v2.repl` | The board: cortex-m4f @ 72 MHz, NVIC, 64 KB flash, 12 KB SRAM, 4 KB CCM, system-memory page (cal words), RCC/SYSCFG/ADC-common register files, PWR, EXTI, GPIOA/B/F, DMA1, ADC1/2, bxCAN, TIM2/3/15/16/17 @ 72 MHz, DWT, DBGMCU, load bank, chibiosFix |
| `models/STM32F3_FlashController.cs` | FLASHv1 interface (KEYR unlock, PER+AR+STRT 2 KB page erase, PG half-word, EOP). The config sector `0x0800F800`+2 KB is file-backed: `Filename`, `Save`, `Load` |
| `models/STM32F3_ADCv3.cs` | Minimal F3 ADC: ADVREGEN/ADCAL/ADEN/ADRDY/ADSTART/ADSTP, a full SQR1..SQR4 sequencer, CONT sweep at 1 kHz virtual, `DMARequest` GPIO. Inputs: `SetRaw ch counts`, `SetMillivolts ch pin-mV`, `SetADCValue ch µV`, `FeedSample raw ch -1` (used by the bank) |
| `models/STM32F3_DMA.cs` | Upstream master `STM32G0DMA` (channel DMA with CIRC), renamed. One local fix: CCR.EN reads back |
| `templates/canboard_v2.resc.hbs` | Machine template for `server/renode.js`: `${name} ${kind} ${board} ${repl} ${elf} ${nv} ${hub} ${bankPort} ${calWords} ${canConnect} ${macro} ${models} ${modelsAnchor}`. `${bankLine}` is kept as a comment, like in the PDM template |
| `test/cb_single.resc` | Single board, hub `vehicle`, SLCAN bridge on :7787, nv `renode/test/nv/CB-01.bin`, plus a `reset` macro. `<REPO>`/`<FW>` placeholders, rendered by `cb_start.sh` |
| `test/cb_start.sh` | Starts or restarts **only its own** Renode (PID in `test/cb_renode.pid`), with the monitor on :1244. `-` starts the monitor only. Renode from `RENODE_EXE` / `RENODE_DIR` / `cache/renode`; firmware from `SIM_FW_DIR` (default `../CoffeeDingoFW/build`) |
| `test/cb_probe.mjs` | Items a–e above (it deletes `nv/CB-01.bin` first) |
| `test/cb_template.mjs` | Template render, include, boot and reset-macro check |

## Commands

From the CoffeeDingoSim repo root:

```sh
node renode/test/cb_probe.mjs          # full a–e check, ~2.5 min, leaves no Renode running
node renode/test/cb_template.mjs       # server template path
bash renode/test/cb_start.sh           # interactive: Renode + cb_single.resc, monitor :1244
MON_PORT=1244 node renode/test/mon.mjs 'mach set "CB-01"' start
SLCAN_PORT=7787 node renode/test/slcan_probe.mjs 3 t64181F00000000000000     # Version request
MON_PORT=1244 node renode/test/mon.mjs 'mach set "CB-01"' 'sysbus.loadBank SetAnalog 1 1500'
```

## Pin and channel map (boards/canboard_v2/board.h, port.cpp)

| Signal | Pin | Renode | Bank |
|---|---|---|---|
| AI1..AI4 | PA0..PA3 | `adc1` IN1..IN4 → `adc1_samples[0..3]` | `adc` ch 1..4 |
| AI5 | PA4 | `adc2` IN1 | `adc2` ch 1 |
| Temperature sensor | — | `adc1` IN16 (5th scan slot) | `tempRaw` (943 = 30 °C with the cal words below) |
| DI1..DI8 | PA5 PA6 PA7 PB0 PB1 PA8 PA9 PA10 | GPIO inputs | bank outputs 0..7 |
| CAN RX (wake) | PA11 | — | bank output 8 |
| DO1..DO4 | PA15 PB3 PB4 PB5 | GPIO outputs (software PWM) | bank inputs 0..3 |
| DO PWM timebase | — | TIM3, TIM15, TIM16, TIM17 (ch1, 1 MHz tick, 100 Hz default) | read by the bank |
| CAN_ID_1 / CAN_ID_2 | PB7 / PB6 | not modelled | — |

- **Analog scaling.** Terminal mV = pin mV × 14700 / 10000 (4k7 over 10k). Raw = pin mV / 3300 × 4095. The
  firmware reports terminal mV (`GetAdcVolts` × 1000) in 0x642 / 0x643.
- **Cal words.** `TS_CAL1 0x1FFFF7B8 = 943`, `VREFINT_CAL 0x1FFFF7BA = 1500`, `TS_CAL2 0x1FFFF7C2 = 1194`. These
  match `server/renode.js CAL_WORDS.canboard`. Temperature = 30 + (raw − 943) / 251 × 80.
- **IRQs (F303 vectors).** DMA1 ch1..7 → 11..17, ADC1_2 → 18, CAN TX/RX0/RX1/SCE → 19..22, TIM15/16/17 →
  24/25/26, TIM2 → 28, TIM3 → 29, EXTI 0..4 → 6..10, 9_5 → 23, 15_10 → 40.
- **Clocks (mcuconf.h).** HSE 8 MHz × 9 = 72 MHz. APB1 = 36 MHz and APB2 = 72 MHz, so every timer runs at
  72 MHz. The ADC runs at AHB/4.
- **Digital inputs are disabled by default.** Param `0x1200+i` sub 0 (`bEnabled`) must be 1, otherwise
  `DigitalInput_n` in 0x644 stays 0 whatever the pin level.

## What it took (Renode 1.16.1+20260623 sharp edges)

1. **No stock STM32F3 platform.** The `.repl` is composed by hand. Peripherals sit at RM0316 addresses, with
   GPIO on AHB2 (`0x48000000`). ADC1 at `0x50000000` and ADC2 at `0x50000100` are registered with
   `<addr, +0x100>` windows.
2. **RCC.** Stock `STM32F0_RCC` tags `CSR.LSIRDY`, and ChibiOS waits on the LSI. The `.repl` uses a Python
   register file whose ready bits mirror their enable bits, with `SWS = SW`.
3. **The stock `Analog.STM32F3_ADC` crashes Renode.** Its sequencer only models SQR1 (SQ1..SQ4). The
   CANBoard's 5-entry scan (IN1..IN4, IN16) dereferences a null slot, and the process dies with a
   `NullReferenceException` in `SwitchToNextChannel`. It also needs an `IDMA`, and the built-in `STM32G0DMA`
   is not assignable to that parameter. `STM32F3_ADCv3.cs` replaces it.
4. **DMA.** The built-in `STM32G0DMA` dropped every ADC request after the first sweep ("channel is disabled
   or has data count set to 0"). Master's copy has the same flaw: CCR.EN has `valueProviderCallback: _ => false`.
   With that callback, any CCR read-modify-write by ChibiOS disables the channel. `STM32F3_DMA.cs` makes EN
   read back its value.
5. **The ELF load overwrites the config sector.** The `.bss` program header is loaded at its LMA
   (`0x0800DDC0`, 9528 zero bytes), which runs past the end of flash and over `0x0800F800`. Set
   `flash_controller Filename` after `LoadELF`, and run `flash_controller Load` after every reload (the reset
   macros do this).
6. **`machine Reset` wipes the ELF and the ROM words.** `cb_single.resc` defines `macro reset`. The template
   defines `${macro}`, which the server runs: Reset, LoadELF, chibiosFix Install, VTOR, flash Load, cal words.
7. **Shared with the PDM.** `ChibiOsFix.cs` (RETTOBASE), `CortexMDwt.cs` (CYCCNT), `load_models.py`
   (compile once, absolute @paths).

## Protocol facts verified here

- **A base-ID write takes effect immediately.** It goes to the live config, not to staging. The write echo
  `[2,0,0,0,0x60,0x06,0,0]` already comes back on the **new** base (0x660). From then on the module answers
  only on new base + 1, and its cyclic frames move to 0x662.. before any burn. So the burn
  `[30,1,3,8,0,0,0,0]` must be sent to **new base + 1** (0x661), and its reply `[30,1,3,8,1,0,0,0]` comes on
  0x660. A burn sent to 0x641 is ignored, and the change is then lost at the next reset. The bring-up sequence
  in `server/bringup.js` follows this.
- The burn reply byte 4 is the `WriteConfig()` result (1 = ok).

## Open issues

- **The load bank's IADC path feeds mV where Renode expects µV.** `ProfetLoadBank.MakeFeeder` calls
  `IADC.SetADCValue(ch, mV)` for a stock `STM32F3_ADC`, but this build's signature is
  `SetADCValue(Int32 channel, UInt32 valueMicroVolts)`. It is not hit on the CANBoard: `STM32F3_ADCv3` is not
  `IADC`, so the bank uses `FeedSample(raw, ch, -1)` with exact counts. BANK.md still describes the stock
  `STM32F3_ADC`; on this platform the ADC is `STM32F3_ADCv3`.
- **Bank port.** The `.repl` says `port: 7800`. When another Renode holds 7800, the bank logs
  "cannot listen" and keeps running, and its monitor commands still work. The server rewrites the port per
  scene (`replWithBankPort`).
- **Firmware: possible filter bug when the CAN filter is enabled.** `ApplyConfig` puts filter 0 on
  `nBaseId - 1`, while the config RX is `nBaseId + 1` (`core/config_handler.cpp`). This is inactive with the
  default `bCanFilterEnabled = false` and was not exercised in Renode.
- Not verified: DO PWM against the timer model (the bank reads CCR1 / ARR), sleep and wake (`CAN_SLEEP FALSE`
  on this board anyway), the OpenBLT bootloader in sectors 0–7 (not loaded), CAN bit-rate changes, and
  `CAN_ID_1/2` pins (left floating).
- `logLevel 3 sysbus.dma1` in the template hides the DMA model's unhandled-bit warnings (TEIE/PL/CTEIF
  tags). They are harmless.
- The ADC never raises OVR or AWD. The ADC1_2 IRQ is wired, but ChibiOS only enables OVR/AWD interrupts, so
  it never fires.
