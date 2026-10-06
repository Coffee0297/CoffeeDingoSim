// .resc generation, Renode flag probing, monitor client against a fake telnet monitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { generateResc, flagsFromHelp, cleanMonitor, createMonitor, findRenodeExe, replWithBankPort, monitorErrors, resetMacroName, runForArg, parseVtime, MONITOR_PROMPT } from '../server/renode.js';
import { pickAsset, resolveLocal } from '../server/firmware.js';

const scene = {
  name: 'resctest',
  modules: [
    { id: 'PDM-01', kind: 'pdm', baseId: 1664 }, { id: 'PDM-02', kind: 'pdm', baseId: 1696 },
    { id: 'MAX-1', kind: 'pdmmax', baseId: 1824 }, { id: 'CB-1', kind: 'canboard', baseId: 1632 },
  ],
};
const fw = { pdm: 'C:\\fw\\dingopdm_v7.elf', pdmmax: '/fw/dingopdmmax_v1.elf', canboard: '/fw/canboard_v2.elf' };

const BOARDS = { pdm: 'dingopdm_v7', pdmmax: 'dingopdmmax_v1', canboard: 'canboard_v2' };
const hasTemplate = (kind) => fs.existsSync(path.join(import.meta.dirname, '..', 'renode', 'templates', `${BOARDS[kind]}.resc.hbs`));

test('generateResc: real templates, absolute paths, ports, cal words, reset macros, isolation', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'resc-'));
  const r = generateResc(scene, fw, { outDir: out, nvDir: path.join(out, 'nv'), bridgePort: 7777, bankPort: 7821, isolate: ['PDM-02'] });
  assert.ok(fs.existsSync(r.path));
  assert.equal(path.basename(r.path), 'resctest.resc');
  const text = fs.readFileSync(r.path, 'utf8');
  const expected = scene.modules.filter((m) => hasTemplate(m.kind));
  assert.deepEqual(r.modules, expected.map((m) => m.id));
  for (const m of scene.modules.filter((x) => !expected.includes(x))) assert.ok(r.skipped.some((s) => s.id === m.id), `${m.id} reported as skipped`);
  for (const m of expected) {
    assert.match(text, new RegExp(`mach create "${m.id}"`), `machine ${m.id}`);
    assert.ok(text.includes(`/nv/${m.id}.bin`), `nv image of ${m.id}`);
    assert.ok(text.includes(`macro ${resetMacroName(m.id)}`), `reset macro of ${m.id}`);
  }
  assert.ok(text.includes('C:/fw/dingopdm_v7.elf'), 'windows path normalised');
  assert.ok(!text.includes('\\'), 'no backslashes');
  assert.ok(!/emulation CreateSlcanTcpBridge|loadBank Configure/.test(text), 'no dead fallback commands');
  assert.match(text, /slcanBridge: CAN\.SlcanTcpBridge @ sysbus 0x5FFF0000 \{ port: 7777 \}/);
  for (const m of text.replace(/^#.*$/gm, '').matchAll(/@(\S+)/g)) if (!m[1].startsWith('sysbus')) assert.match(m[1], /^([A-Za-z]:\/|\/)/, `absolute: ${m[1]}`);
  assert.match(fs.readFileSync(path.join(out, 'resctest.dingopdm_v7.repl'), 'utf8'), /port: 7821/);
  assert.ok(text.includes('0x1FFF7A2A 1500'), 'F4 VREFINT cal');
  const block = (id) => { const i = text.indexOf(`mach create "${id}"`); return text.slice(i, text.indexOf('mach clear', i)); };
  assert.match(block('PDM-01'), /^connector Connect sysbus\.can1 vehicle$/m);
  assert.doesNotMatch(block('PDM-02'), /^connector Connect sysbus\.can1 vehicle/m);
  assert.match(block('PDM-02'), /^connector Connect sysbus\.can1 iso_PDM_02$/m);
  assert.deepEqual(r.isolated, ['PDM-02']);
  assert.ok(!/\$\{\w+\}/.test(text.replace(/^#.*$/gm, '')), 'no unfilled placeholders');
  fs.rmSync(out, { recursive: true, force: true });
});

test('generateResc: only filter, missing firmware, nothing to simulate', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'resc-'));
  const r = generateResc(scene, { pdm: '/fw/dingopdm_v7.elf' }, { outDir: out, nvDir: out, only: ['PDM-01', 'CB-1'] });
  assert.deepEqual(r.modules, ['PDM-01']);
  assert.throws(() => generateResc({ name: 'x', modules: [] }, fw, { outDir: out, nvDir: out }), /no module can be simulated/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('replWithBankPort rewrites only the bank port', () => {
  const repl = 'can1: CAN.STMCAN @ sysbus 0x1\n    port: 1\nloadBank: Miscellaneous.ProfetLoadBank @ sysbus 0x5FFE0000\r\n    board: "pdm"\r\n    adc: adc1\r\n    port: 7800\r\n';
  const out = replWithBankPort(repl, 7899);
  assert.match(out, /port: 7899\r\n$/);
  assert.match(out, /0x1\n    port: 1\n/);
});

test('monitorErrors finds failed script commands, ignores normal output', () => {
  assert.deepEqual(monitorErrors('coffeesim_load: compiled X.cs\nChibiOsFix: literal'), []);
  assert.equal(monitorErrors("There was an error executing command 'foo'\nok").length, 1);
  assert.equal(monitorErrors('Could not find file C:/x.repl').length, 1);
});

test('runForArg / parseVtime', () => {
  assert.equal(runForArg(0.1), '0:0:0.1');
  assert.equal(runForArg(3725.5), '1:2:5.5');
  assert.equal(parseVtime('Elapsed Virtual Time: 00:01:02.500000'), 62.5);
  assert.equal(parseVtime('nothing'), null);
});

test('monitor client: a command sent right after connect keeps its reply (connect timer bug)', async () => {
  const server = net.createServer((s) => {
    s.write('(monitor) ');
    s.on('data', (d) => { if (d.toString().includes('slow')) setTimeout(() => s.write('slow\r\ndone\r\n(monitor) '), 3500); });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mon = createMonitor({ port: server.address().port, timeoutMs: 8000 });
  await mon.connect(2, 50);
  assert.equal(await mon.cmd('slow'), 'done');
  mon.close();
  server.close();
});

test('monitor client: stale prompts and machine prompts inside a macro do not end a reply early', async () => {
  const server = net.createServer((s) => {
    s.write('(monitor) ');
    s.on('data', (d) => {
      const c = d.toString().trim();
      if (c === 'pause') s.write('pause\r\n(monitor) ');
      if (c.startsWith('runMacro')) {
        // a stale prompt first, then the echo, a machine prompt in the middle, the final prompt last
        s.write('(monitor) ');
        setTimeout(() => s.write(`${c}\r\nreset done\r\n(PDM-01) `), 20);
        setTimeout(() => s.write('more\r\n(monitor) '), 60);
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mon = createMonitor({ port: server.address().port, timeoutMs: 3000 });
  await mon.connect(2, 50);
  assert.equal(await mon.cmd('pause'), '');
  assert.equal(await mon.cmd('runMacro $reset_PDM_01', 3000, { until: MONITOR_PROMPT }), 'reset done\n(PDM-01) more');
  mon.close();
  server.close();
});

test('flagsFromHelp picks headless flags', () => {
  assert.deepEqual(flagsFromHelp('  --disable-gui  BOOLEAN\n  --disable-xwt\n  -p, --plain'), ['--disable-gui', '--plain']);
  assert.deepEqual(flagsFromHelp('  --disable-xwt'), ['--disable-xwt']);
});

test('cleanMonitor strips ANSI and telnet negotiation', () => {
  assert.equal(cleanMonitor('\xff\xfb\x01\x1b[32mhello\x1b[0m\r\n(monitor) '), 'hello\n(monitor) ');
});

test('monitor client: serialised commands resolve at the prompt', async () => {
  const seen = [];
  const server = net.createServer((s) => {
    s.write(Buffer.from([0xff, 0xfb, 0x01]));
    s.write('Renode, version 1.16\r\n(monitor) ');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        seen.push(cmd);
        const reply = cmd.startsWith('emulation GetTimeSourceInfo') ? 'Elapsed Virtual Time: 00:01:02.500000\r\n' : '';
        setTimeout(() => s.write(`${cmd}\r\n${reply}\x1b[0m(${cmd.startsWith('mach set') ? 'PDM-01' : 'monitor'}) `), 5);
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mon = createMonitor({ port: server.address().port, timeoutMs: 2000 });
  await mon.connect(2, 50);
  const [a, b, c] = await Promise.all([mon.cmd('start'), mon.cmd('mach set "PDM-01"'), mon.cmd('emulation GetTimeSourceInfo')]);
  assert.equal(a, '');
  assert.equal(b, '');
  assert.match(c, /Elapsed Virtual Time: 00:01:02.5/);
  assert.deepEqual(seen, ['start', 'mach set "PDM-01"', 'emulation GetTimeSourceInfo']);
  mon.close();
  await new Promise((r) => server.close(r));
});

test('firmware: asset pick + local resolution', () => {
  const rel = { tag: 'v5.5.106', assets: [{ name: 'canboard_v2_FW_v5-5-106.elf', url: 'u1' }, { name: 'dingopdm_v7_FW_v5-5-106.elf', url: 'u2' }] };
  assert.equal(pickAsset(rel, 'pdm').url, 'u2');
  assert.equal(pickAsset(rel, 'pdmmax'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  fs.writeFileSync(path.join(dir, 'dingopdm_v7.elf'), '');
  assert.equal(resolveLocal(dir, 'pdm'), path.join(dir, 'dingopdm_v7.elf'));
  assert.throws(() => resolveLocal(dir, 'canboard'));
  assert.equal(findRenodeExe(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
