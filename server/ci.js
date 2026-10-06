// Headless golden-run gate:
//   npm run ci -- --scene scenes/example --firmware build/ --golden runs/golden.run.json [--tol 10]
// Loads the scene, ensures Renode + firmware, starts paused, replays the golden run's actions with
// RunFor steps, diffs the new run against the golden one, prints a table, exits 1 on any difference
// (2 on setup errors).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneDir, events } from './state.js';
import { createSim, ensureDirs } from './sim.js';
import { readRun, diffRuns, formatDiff } from './record.js';

/** Parse `--key value` / `--flag` arguments. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

const waitFor = (pred, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (pred() || Date.now() - t0 > ms) { clearInterval(iv); resolve(pred()); } }, 100);
});

/**
 * --golden path: absolute; else relative to the cwd when that file exists (`scenes/example/runs/x`);
 * else relative to the scene folder (`runs/golden.run.json`).
 */
export function resolveGolden(p, sceneName, cwd = process.cwd()) {
  if (path.isAbsolute(p)) return p;
  const fromCwd = path.resolve(cwd, p);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(sceneDir(sceneName), p);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sceneArg = String(args.scene || 'scenes/example');
  const sceneName = path.basename(sceneArg.replace(/[\\/]scene\.sim\.json$/, '').replace(/[\\/]+$/, ''));
  ensureDirs();
  const sim = await createSim({ scene: sceneName, bridge: args.bridge || 'none' });
  // progress: bring-up / start / error lines of the Renode log, and the virtual time every 10 s
  const logRe = args.verbose ? /./ : /^\[(bringup|sim)\]|error|fail/i;
  const onMsg = (m) => { if (m.type === 'renode' && m.log?.length === 1 && logRe.test(m.log[0])) console.log(`[renode] ${m.log[0]}`); };
  events.on('broadcast', onMsg);
  const t0 = Date.now();
  const progress = setInterval(() => console.log(`[ci] host ${Math.round((Date.now() - t0) / 1000)} s, virtual ${sim.state.renode.vtime.toFixed(1)} s, renode ${sim.state.renode.status}`), 10000);
  progress.unref();
  let code = 0;
  try {
    if (!sim.state.scene?.modules?.length) throw new Error(`scene ${sceneName} has no modules`);
    const goldenPath = String(args.golden || 'runs/golden.run.json');
    const goldenAbs = resolveGolden(goldenPath, sceneName);
    const golden = readRun(sceneName, goldenAbs);
    console.log(`[ci] scene ${sceneName}, golden ${goldenPath} (${golden.actions?.length ?? 0} actions, ${golden.durationS ?? '?'} s)`);
    await sim.renodeCmd({ cmd: 'start', firmware: args.firmware ? path.resolve(String(args.firmware)) : undefined, paused: true });
    const linked = await waitFor(() => sim.state.bank.connected && sim.state.bus.connected, Number(args['link-timeout'] || 30000));
    if (!linked) console.warn('[ci] warning: bank/bus links not both connected; continuing');
    // let every module boot and settle before the first action, like the recording did (golden.settleS)
    const settle = Number(args.settle ?? golden.settleS ?? 3);
    if (settle > 0) await sim.renodeCmd({ cmd: 'runfor', seconds: settle });
    const { run } = await sim.record({ cmd: 'replay', run: goldenAbs });
    const diff = diffRuns(golden, readRun(sceneName, run), { tolPct: Number(args.tol || 10) });
    console.log(formatDiff(diff));
    console.log(`[ci] run saved: scenes/${sceneName}/runs/${run}`);
    code = diff.ok ? 0 : 1;
  } catch (e) {
    console.error(`[ci] error: ${e.message}`);
    code = 2;
  } finally {
    clearInterval(progress);
    events.off('broadcast', onMsg);
    await sim.close();
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c));
}
