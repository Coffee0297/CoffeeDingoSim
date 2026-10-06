# Install Renode

Nothing to install by hand on Windows: on the first Renode start `server/renode.js` downloads the nightly
portable build (<https://builds.renode.io/renode-latest.windows-portable-dotnet.zip>, about 148 MB, .NET 8 runtime
bundled) into `cache/renode-dl/` and extracts it into `cache/renode/` (`cache/` is gitignored; `SIM_CACHE_DIR`
moves it). The Renode panel shows the `downloading` status meanwhile.

Lookup order (`ensureRenode` in `server/renode.js`):

1. `RENODE_EXE` — full path of the executable.
2. `RENODE_DIR` — a directory searched two levels deep for `renode.exe` / `renode`.
3. Windows: `cache/renode`, downloaded as above when empty. Linux: `renode` on `PATH` (`tools/ci.sh` installs the
   portable Linux build into `RENODE_DIR`, default `~/.cache/renode`).

Manual install (offline machine): download the zip above, extract it anywhere and set `RENODE_DIR` to that
directory (or extract it into `cache/renode`). Check it with `renode.exe --version`; the build these notes were
verified with prints `Renode v1.16.1.8972, build 3f5a9101-202606230453, .NET 8.0.10`.

The scripts under `renode/test/` resolve Renode the same way (`RENODE_EXE`, else `RENODE_DIR`, else
`cache/renode`).

## Flags (from `renode.exe --help` of this build)

| Need | Flag |
|---|---|
| no GUI / headless | `--disable-gui` (alias `--disable-xwt`) |
| monitor over telnet | `-P <port>`. 0 picks a free port, -1 disables both port and GUI monitor |
| monitor in this console instead | `--console` |
| plain output, no colour codes | `--plain` (`-p`) |
| run a script at startup | pass the `.resc` path as the last argument. `-e "cmd;cmd"` runs commands after it |
| PID file | `--pid-file <path>` |
| quit | monitor command `quit`, or kill the process |

Server launch line: `renode.exe -P 1234 --disable-gui --plain <scene>.resc`. Script errors in that startup
script do not reach the log, so include the script from a monitor connection when debugging.

## Peripheral classes used (all present in this build)

`CPU.CortexM` (`cortex-m4f`), `IRQControllers.NVIC`, `Analog.STM32_ADC`, `Analog.STM32F3_ADC`, `CAN.STMCAN`,
`MTD.STM32F4_FlashController`, `Timers.STM32_Timer`, `GPIOPort.STM32_GPIOPort`, `I2C.STM32F1_I2C` (replaced, see
`renode/README.md`), `I2C.MB85RC1MT` (exists but is the 1 Mbit / 17-bit-address part, so it is not used),
`Miscellaneous.LED`, `Python.PythonPeripheral`, CAN hub (`emulation CreateCANHub`). Not present:
`MTD.STM32F0_FlashController`. Stock platform: `platforms/cpus/stm32f4.repl`. `renode/platforms/dingopdm_v7.repl`
is self-contained and does not `using` it, because the stock file downloads an SVD and tags the USB range.
