#!/usr/bin/env bash
# Start a headless Renode (monitor on :${MON_PORT:-1234}, log in renode/test/run.log) and return when
# the monitor is up. Kills only the instance this script started before (renode/test/renode.pid),
# never other Renode processes (other tests may be running).
cd "$(dirname "$0")/../.."
# Renode: RENODE_EXE, else the first renode.exe under ${RENODE_DIR:-cache/renode} (npm start downloads it there).
RENODE="${RENODE_EXE:-$(find "${RENODE_DIR:-cache/renode}" -maxdepth 3 -iname renode.exe 2>/dev/null | head -n 1)}"
[ -n "$RENODE" ] || { echo "Renode not found: set RENODE_EXE or RENODE_DIR, or run npm start once to download it into cache/renode"; exit 1; }
RENODE="$(cygpath -w "$RENODE" 2>/dev/null || echo "$RENODE")"
PORT=${MON_PORT:-1234}
if [ -f renode/test/renode.pid ]; then
  powershell -NoProfile -Command "Stop-Process -Id (Get-Content renode\\test\\renode.pid) -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1
  sleep 2
fi
rm -f renode/test/run.log
powershell -NoProfile -Command "\$p = Start-Process -FilePath '$RENODE' -ArgumentList '--disable-gui','--plain','-P','$PORT' -WorkingDirectory '$(pwd -W)' -RedirectStandardOutput 'renode\test\run.log' -RedirectStandardError 'renode\test\run.err' -PassThru -WindowStyle Hidden; \$p.Id | Out-File -Encoding ascii renode\test\renode.pid"
for i in $(seq 1 60); do
  sleep 1
  grep -q "Monitor available" renode/test/run.log 2>/dev/null && exit 0
done
echo "renode did not come up"; exit 1
