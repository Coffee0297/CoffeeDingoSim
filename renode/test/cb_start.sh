#!/usr/bin/env bash
# Start a headless Renode for the CANBoard tests (monitor :1244, log renode/test/cb_run.log) and wait for the monitor.
# Kills ONLY the Renode started by a previous cb_start.sh (PID in renode/test/cb_renode.pid).
#   bash renode/test/cb_start.sh [script.resc | -]     (default renode/test/cb_single.resc; - = monitor only)
cd "$(dirname "$0")/../.."
# Renode: RENODE_EXE, else the first renode.exe under ${RENODE_DIR:-cache/renode} (npm start downloads it there).
RENODE="${RENODE_EXE:-$(find "${RENODE_DIR:-cache/renode}" -maxdepth 3 -iname renode.exe 2>/dev/null | head -n 1)}"
[ -n "$RENODE" ] || { echo "Renode not found: set RENODE_EXE or RENODE_DIR, or run npm start once to download it into cache/renode"; exit 1; }
RENODE="$(cygpath -w "$RENODE" 2>/dev/null || echo "$RENODE")"
SCRIPT="${1:-renode/test/cb_single.resc}"
# .resc files with <REPO>/<FW> placeholders are rendered into renode/test/gen/ (gitignored) first:
# <REPO> = this repo, <FW> = ${SIM_FW_DIR:-../CoffeeDingoFW/build}
if [ "$SCRIPT" != "-" ] && grep -qE '<REPO>|<FW>' "$SCRIPT"; then
  REPO="$(pwd -W 2>/dev/null || pwd)"
  FW="${SIM_FW_DIR:-$REPO/../CoffeeDingoFW/build}"
  FW="$(cd "$FW" 2>/dev/null && (pwd -W 2>/dev/null || pwd) || echo "$FW")"
  mkdir -p renode/test/gen
  sed -e "s#<REPO>#$REPO#g" -e "s#<FW>#$FW#g" "$SCRIPT" > "renode/test/gen/$(basename "$SCRIPT")"
  SCRIPT="renode/test/gen/$(basename "$SCRIPT")"
fi
PORT="${CB_MON_PORT:-1244}"
ARGS="'--disable-gui','--plain','-P','$PORT'"
[ "$SCRIPT" != "-" ] && ARGS="$ARGS,'$SCRIPT'"
if [ -f renode/test/cb_renode.pid ]; then
  OLD=$(tr -dc '0-9' < renode/test/cb_renode.pid)
  [ -n "$OLD" ] && powershell -NoProfile -Command "Stop-Process -Id $OLD -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1
  sleep 1
fi
rm -f renode/test/cb_run.log
powershell -NoProfile -Command "\$p = Start-Process -FilePath '$RENODE' -ArgumentList $ARGS -WorkingDirectory '$(pwd -W)' -RedirectStandardOutput 'renode\test\cb_run.log' -RedirectStandardError 'renode\test\cb_run.err' -PassThru -WindowStyle Hidden; \$p.Id | Out-File -Encoding ascii renode\test\cb_renode.pid"
for i in $(seq 1 90); do sleep 1; grep -q "Monitor available" renode/test/cb_run.log 2>/dev/null && { echo "renode up (pid $(tr -dc '0-9' < renode/test/cb_renode.pid))"; exit 0; }; done
echo "renode did not come up"; exit 1
