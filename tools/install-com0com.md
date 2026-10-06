# Virtual COM pair for the original dingoConfig (Windows)

The simulator presents its virtual CAN bus as an SLCAN serial device so **any** dingoConfig (the original Blazor
tool or the fork) connects to it like a USB-CAN stick: one end of a virtual null-modem pair is opened by the
simulator (`SIM_BRIDGE=serial:COM5`), the other end (`COM6`) is picked in dingoConfig as "SLCAN, COM6".

## Why this is the only Windows path for the original tool

The original dingoConfig speaks SLCAN over a serial port, PCAN (needs PEAK hardware), SocketCAN (Linux) or its
own replay. It has no TCP option. So on Windows the bridge has to be a COM port. The fork additionally accepts
`tcp://127.0.0.1:7778` (no driver needed) — use that when you only need the fork.

## Driver signing caveat (read before installing)

com0com is a kernel driver. Windows 10 1607+ and Windows 11 only load kernel drivers signed through the Microsoft
Dev Portal unless Secure Boot is off. The classic SourceForge `com0com-3.0.0.0` package is **reported not to load**
on such systems. Options, in order of preference:

1. **Signed com0com build** — the ALGE-Timing installer:
   <https://alge-timing.com/alge/download/driver/Com0ComSetup.exe>. Install as Administrator, then run
   `setupc.exe` from `C:\Program Files (x86)\com0com\` and create a pair:
   ```
   setupc install PortName=COM5 PortName=COM6
   ```
   Check in Device Manager → Ports that `COM5` and `COM6` appear without a warning icon.
2. **Disable Secure Boot** in the BIOS and install the SourceForge package. Not recommended on a work laptop.
3. **Skip the driver**: use the fork with `tcp://127.0.0.1:7778`, or run the original tool on Linux/WSL2 against a
   `vcan0` created by Renode's SocketCAN bridge, or put a real USB-CAN stick in loopback (two interfaces).

## Error code 52 in Device Manager

"Windows cannot verify the digital signature" (code 52) on `com0com - bus for serial port pair emulator` means
the driver is not Microsoft-signed and Secure Boot blocks it. The SourceForge / BrickBot builds (Comodo
certificate, 2016) do this on Windows 11. Uninstall it (`C:\Program Files (x86)\com0com\uninstall.exe` as
Administrator), install a build Windows accepts, and check that Device Manager ▸ Ports lists the pair without
a warning icon.

## Settings

- Simulator: `SIM_BRIDGE=serial:COM5` (env) or `globals.bridge = "serial:COM5"` in the scene file. Several
  transports at once are comma-separated: `SIM_BRIDGE=tcp:7778,serial:COM5` serves the fork over TCP and the
  original dingoConfig over the COM pair on the same simulated bus.
  Baud rate is nominal on a virtual pair; the simulator opens 115200.
- dingoConfig: Adapter `SLCAN`, port `COM6`, any bitrate (the virtual bus ignores it).
- The simulator answers the fork's `I` identify with the first PDM's base id and honours the `X` filter; the
  original tool never sends them.

## Quick test

1. `npm start` in CoffeeDingoSim, open <http://localhost:8787>, Start Renode.
2. In dingoConfig connect to `COM6`, "Add from CAN": every module of the scene appears with its project base id.
3. Read / Write / Burn / Reset a module — the FRAM/flash images under `scenes/<name>/nv/` persist the config.
