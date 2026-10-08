//
// ProfetLoadBank — the simulated harness behind one dingoPDM / dingoPDM-Max / CANBoard in Renode
// (CoffeeDingoSim docs/interfaces.md §5). Bench usage and .repl wiring: renode/BANK.md.
//
//   * watches the Profet IN lines (and the PWM timers' CR1/ARR/CCR1) or the CANBoard DO lines,
//   * runs a 1 kHz virtual-time model of the loads on each output (inrush table, voltage, ripple,
//     faults, noise, PWM on-phase), clamps it to the Profet sense range and feeds the raw IS counts
//     into the ADC (`FeedSample(raw, ch, -1)` on the F4 ADC, `SetADCValue(ch, µV)` on a stock IADC),
//   * feeds BattVolt / TEMP / VREFINT, CANBoard analog inputs, drives the DI pins and the CAN-RX
//     wake pulse through its numbered GPIO outputs (`Connections`),
//   * speaks NDJSON on one TCP listener (default :7800) shared by every bank in the emulation.
//
// It is an ICAN as well so it can sit on the CAN hub and see traffic for the wake pulse:
//   connector Connect sysbus.loadBank vehicle
//
// GPIO inputs (gpioPortX: n -> loadBank@k)
//   pdm      0..7 = Profet IN out1..out8, 8 = DSEL 3/4 (PB14), 9 = DSEL 5/6 (PC5), 10 = DSEL 7/8 (PA5)
//   pdmmax   0..3 = Profet IN out1..out4
//   canboard 0..3 = DO1..DO4 (watched, reported as `do`)
// GPIO outputs (loadBank: k -> gpioPortX@n)
//   0..7 = DI1..DI8 (PDM: DI1 PA10, DI2 PC9; CANBoard: PA5 PA6 PA7 PB0 PB1 PA8 PA9 PA10)
//   8    = CAN RX wake pulse (PDM/PDM-Max PB8, CANBoard PA11)
//
// Include this file ONCE per Renode process: the TCP listener is a static of the compiled assembly.
//
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.CAN;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CAN;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class ProfetLoadBank : IDoubleWordPeripheral, IKnownSize, IGPIOReceiver, INumberedGPIOOutput, ICAN
    {
        public ProfetLoadBank(IMachine machine, string board = "pdm", IPeripheral adc = null, IPeripheral adc2 = null,
                              int port = 7800, uint tempRaw = 943, uint vrefRaw = 1500, double vbattV = 13.8, int seed = 0)
        {
            this.machine = machine;
            this.sysbus = machine.SystemBus;
            Board = (board ?? "pdm").Trim().ToLowerInvariant();
            this.tempRaw = tempRaw;
            this.vrefRaw = vrefRaw;
            vbatt = vbattV;
            this.seed = seed;
            feeders = new[] { MakeFeeder(adc, "adc"), MakeFeeder(adc2, "adc2") };
            f4Adc = adc as Antmicro.Renode.Peripherals.Analog.STM32_ADC;

            switch(Board)
            {
            case "pdm":
                nOut = 8;
                nDi = 2;
                kIlis = new double[] { 22950, 22950, 5950, 5950, 5950, 5950, 5950, 5950 };
                satA = new double[] { 63, 63, 16.4, 16.4, 16.4, 16.4, 16.4, 16.4 };
                isCh = new uint[] { 0, 12, 13, 13, 1, 1, 2, 2 };
                // DSEL input index per output (-1 = single channel); DSEL low selects the odd output (CH1)
                dselOf = new[] { -1, -1, 8, 8, 9, 9, 10, 10 };
                timers = new ulong[] { 0x40000400, 0x40000800, 0x40000C00, 0x40014000, 0x40014400, 0x40014800, 0x40001800, 0x40001C00 };
                battCh = 3;
                break;
            case "pdmmax":
                nOut = 4;
                nDi = 2;
                kIlis = new double[] { 35000, 35000, 35000, 35000 };
                satA = new double[] { 96, 96, 96, 96 };
                isCh = new uint[] { 13, 12, 0, 1 };
                dselOf = new[] { -1, -1, -1, -1 };
                timers = new ulong[] { 0x40000400, 0x40000800, 0x40000C00, 0x40014000 };
                battCh = 3;
                break;
            case "canboard":
                nOut = 0;
                nDi = 8;
                nDo = 4;
                nAn = 5;
                kIlis = new double[0];
                satA = new double[0];
                isCh = new uint[0];
                dselOf = new int[0];
                // DO1..4 PWM timebases TIM3, TIM15, TIM16, TIM17 (boards/canboard_v2/port_pwm.h)
                timers = new ulong[] { 0x40000400, 0x40014000, 0x40014400, 0x40014800 };
                battCh = -1;
                break;
            default:
                throw new ArgumentException($"ProfetLoadBank: unknown board '{board}' (pdm | pdmmax | canboard)");
            }

            var nCh = Math.Max(nOut, nDo);
            outputs = new List<Load>[nOut];
            for(var i = 0; i < nOut; i++)
            {
                outputs[i] = new List<Load>();
            }
            current = new double[nOut];
            peak = new double[nOut];
            raw = new uint[nOut];
            on = new bool[nCh];
            duty = new double[nCh];
            analogMv = new double[nAn];
            diState = new bool[8];

            var conns = new Dictionary<int, IGPIO>();
            for(var i = 0; i < 9; i++)
            {
                conns[i] = new GPIO();
            }
            Connections = conns;

            machine.ClockSource.AddClockEntry(new ClockEntry(
                period: 1,
                frequency: 1000,
                handler: Tick,
                owner: this,
                localName: "loadbank-tick",
                enabled: true,
                workMode: WorkMode.Periodic
            ));
            LoadBankHost.Register(this, port);
        }

        // ================================ public surface ===============================================

        public string Board { get; }
        public string MachineName
        {
            get
            {
                if(machineName == null && EmulationManager.Instance.CurrentEmulation.TryGetMachineName(machine, out var n))
                {
                    machineName = n;
                }
                return machineName ?? "?";
            }
        }

        public IReadOnlyDictionary<int, IGPIO> Connections { get; }
        public event Action<CANMessageFrame> FrameSent;

        public long Size => 0x100;

        // 0x00 + 4n: raw IS counts of output n+1; 0x40: vbatt mV; 0x44: ticks
        public uint ReadDoubleWord(long offset)
        {
            lock(sync)
            {
                var n = (int)(offset / 4);
                if(n < nOut)
                {
                    return raw[n];
                }
                if(offset == 0x40)
                {
                    return (uint)Math.Round(vbatt * 1000);
                }
                if(offset == 0x44)
                {
                    return (uint)ticks;
                }
                if(offset >= 0x80 && offset < 0xC0)
                {
                    // PWM source diagnostics per DI (i = (offset - 0x80) / 8): +0 last high time, +4 last period, ns
                    var i = (int)((offset - 0x80) / 8);
                    return (offset & 4) == 0 ? pwmHighNs[i] : pwmPeriodNs[i];
                }
                return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            lock(sync)
            {
                Array.Clear(inPin, 0, inPin.Length);
                lastFed.Clear();
                if(ticks > 0)
                {
                    ResetF4AdcSequencer();   // a module reset, not the machine's construction
                }
                timerPresent = null;
                wasDeepSleep = false;
                // the GPIO ports reset their input state too: re-assert the DI levels the harness holds
                for(var d = 0; d < nDi; d++)
                {
                    if(diState[d])
                    {
                        var idx = d;
                        pending.Enqueue(() => { Connections[idx].Set(false); Connections[idx].Set(true); });
                    }
                }
                if(ticks > 0)
                {
                    Emit("reset");
                }
            }
        }

        // machine -> bank: Profet IN / DSEL / CANBoard DO lines (machine thread)
        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number >= inPin.Length)
            {
                return;
            }
            lock(sync)
            {
                var old = inPin[number];
                inPin[number] = value;
                if(old != value && number >= 8 && Board == "pdm")
                {
                    // DSEL changed: re-feed the shared IS channel now, not at the next tick, otherwise the
                    // firmware's 60 us settle + read sees the other channel's current
                    for(var o = 0; o < nOut; o++)
                    {
                        if(dselOf[o] == number && Selected(o))
                        {
                            Feed(0, isCh[o], raw[o]);
                            PatchScanSlot(isCh[o], raw[o]);
                        }
                    }
                }
            }
        }

        // hub -> bank (any frame on the bus): wake pulse if the module sleeps
        public void OnFrameReceived(CANMessageFrame message)
        {
            Interlocked.Exchange(ref frameSeen, 1);
        }

        // ---------------------------------- monitor methods ---------------------------------------------

        public string LoadScene(string path)
        {
            var text = File.ReadAllText(path).Trim();
            var msgs = new List<Dictionary<string, object>>();
            try
            {
                var v = Json.Parse(text);
                if(v is List<object> arr)
                {
                    msgs.AddRange(arr.OfType<Dictionary<string, object>>());
                }
                else if(v is Dictionary<string, object> obj)
                {
                    msgs.Add(obj);
                }
            }
            catch(FormatException)
            {
                foreach(var line in text.Split('\n'))
                {
                    if(line.Trim().Length > 0)
                    {
                        msgs.Add(Json.Parse(line) as Dictionary<string, object>);
                    }
                }
            }
            var applied = 0;
            foreach(var m in msgs.Where(x => x != null))
            {
                var target = Json.S(m, "machine", null);
                if(target != null && target != "*" && target != MachineName)
                {
                    continue;
                }
                if(!m.ContainsKey("type"))
                {
                    m["type"] = "scene";
                }
                Apply(m);
                applied++;
            }
            return $"{applied} message(s) applied to {MachineName}";
        }

        public void Fault(int output, string kind, int atMs = 0)
        {
            lock(sync)
            {
                SetFault(output, null, kind, atMs);
            }
        }

        public void SetVbatt(double v)
        {
            lock(sync)
            {
                vbatt = v;
            }
        }

        public void SetNoise(double pct)
        {
            lock(sync)
            {
                noisePct = pct;
            }
        }

        public double Current(int output)
        {
            lock(sync)
            {
                return output >= 1 && output <= nOut ? current[output - 1] : double.NaN;
            }
        }

        public uint Raw(int output)
        {
            lock(sync)
            {
                return output >= 1 && output <= nOut ? raw[output - 1] : 0;
            }
        }

        public void SetInput(int di, bool value)
        {
            lock(sync)
            {
                pending.Enqueue(() => DriveDi(di, value));
            }
        }

        public void SetAnalog(int ch, double mV)
        {
            lock(sync)
            {
                if(ch >= 1 && ch <= nAn)
                {
                    analogMv[ch - 1] = mV;
                }
            }
        }

        public void SetTemp(double c)
        {
            SetBoardTemperature(c);
        }

        public void WakePulse()
        {
            Interlocked.Exchange(ref forcePulse, 1);
        }

        // Apply one bank-protocol message (the machine field may be omitted: this bank)
        public string Message(string json)
        {
            var m = Json.Parse(json) as Dictionary<string, object>;
            if(m == null)
            {
                return "not an object";
            }
            Apply(m);
            return "ok";
        }

        public string Dump()
        {
            lock(sync)
            {
                var w = new JsonWriter();
                w.Begin().Str("machine", MachineName).Str("board", Board).Num("t", Now()).Num("vbattV", vbatt)
                 .Num("noisePct", noisePct).Bool("deepSleep", wasDeepSleep);
                w.Arr("i", current).Arr("raw", raw.Select(x => (double)x)).Arr("on", on.Select(x => x ? 1.0 : 0))
                 .Arr("duty", duty.Select(x => Math.Round(x * 100, 1))).Arr("in", inPin.Select(x => x ? 1.0 : 0))
                 .Arr("di", diState.Take(nDi).Select(x => x ? 1.0 : 0)).Arr("mV", analogMv);
                w.Raw("fed", "{" + string.Join(",", lastFed.Select(kv => $"\"{(kv.Key >> 8 == 0 ? "adc" : "adc2")}:{kv.Key & 0xFF}\":{kv.Value}")) + "}");
                var sb = new StringBuilder("[");
                for(var o = 0; o < nOut; o++)
                {
                    sb.Append(o == 0 ? "" : ",").Append('[');
                    sb.Append(string.Join(",", outputs[o].Select(l =>
                        $"{{\"id\":{JsonWriter.Q(l.Id)},\"onMs\":{l.OnMs},\"active\":{(l.Active ? "true" : "false")},\"fault\":{(l.FaultKind == null ? "null" : JsonWriter.Q(l.FaultKind))}}}")));
                    sb.Append(']');
                }
                w.Raw("loads", sb.Append(']').ToString());
                return w.End();
            }
        }

        // ================================ protocol (any thread) ========================================

        internal string Hello()
        {
            return new JsonWriter().Begin().Str("type", "hello").Str("machine", MachineName).Str("board", Board)
                .Num("outputs", nOut).Num("inputs", nDi).Num("analog", nAn).Num("digitalOut", nDo).End();
        }

        internal void Apply(Dictionary<string, object> m)
        {
            var type = Json.S(m, "type", "");
            lock(sync)
            {
                switch(type)
                {
                case "scene":
                    ApplyScene(m);
                    break;
                case "fault":
                    SetFault((int)Json.D(m, "out", 0), Json.S(m, "load", null), Json.S(m, "kind", "clear"), Json.D(m, "atMs", 0));
                    break;
                case "vbatt":
                    vbatt = Json.D(m, "v", vbatt);
                    break;
                case "gpio":
                {
                    var pin = Json.S(m, "pin", "");
                    var val = Json.D(m, "value", 0) != 0;
                    if(pin.StartsWith("DI", StringComparison.OrdinalIgnoreCase) && int.TryParse(pin.Substring(2), out var di))
                    {
                        pending.Enqueue(() => DriveDi(di, val));
                    }
                    else
                    {
                        this.Log(LogLevel.Warning, "gpio: unknown pin '{0}'", pin);
                    }
                    break;
                }
                case "adc":
                {
                    var ch = (int)Json.D(m, "ch", 0);
                    if(ch >= 1 && ch <= nAn)
                    {
                        analogMv[ch - 1] = Json.D(m, "mV", 0);
                    }
                    break;
                }
                case "temp":
                    SetBoardTemperature(Json.D(m, "c", 25));
                    break;
                case "pwm":
                {
                    // {pin:"DI3", duty:<% of the period the pin is HIGH>, freq:<Hz>}; duty 0/100 or freq 0 = steady level
                    var pin = Json.S(m, "pin", "");
                    if(pin.StartsWith("DI", StringComparison.OrdinalIgnoreCase) && int.TryParse(pin.Substring(2), out var di) && di >= 1 && di <= nDi)
                    {
                        pwmPending.Enqueue(new PwmSet { Di = di, Duty = Json.D(m, "duty", 0), Freq = Json.D(m, "freq", 0) });
                    }
                    else
                    {
                        this.Log(LogLevel.Warning, "pwm: unknown pin '{0}' on {1}", pin, Board);
                    }
                    break;
                }
                default:
                    this.Log(LogLevel.Warning, "unknown message type '{0}'", type);
                    break;
                }
            }
        }

        // ================================ model ========================================================

        private class Load
        {
            public string Id;
            public double RatedA, VExp = 1, TableMs = 1, SteadyA, LoopMs, RippleHz, RipplePct, CoolDownMs = 1500;
            public double StallA, ShortA = 999, OnPhaseExp, KLR = 1;
            public bool Motor, Pwmable = true;
            public double[] Table = new double[0];
            public string FaultKind;
            public double FaultAtMs;
            // runtime
            public double OnMs, OffMs = double.MaxValue;
            public bool Active, Dropped;
            public double PhaseMs;
            public int Shares = 1;
        }

        private void ApplyScene(Dictionary<string, object> m)
        {
            if(m.ContainsKey("vbattV"))
            {
                vbatt = Json.D(m, "vbattV", vbatt);
            }
            if(m.ContainsKey("noisePct"))
            {
                noisePct = Json.D(m, "noisePct", noisePct);
            }
            var outs = Json.O(m, "outputs");
            var fresh = new List<Load>[nOut];
            for(var o = 0; o < nOut; o++)
            {
                fresh[o] = new List<Load>();
                var oc = outs == null ? null : Json.O(outs, (o + 1).ToString(CultureInfo.InvariantCulture));
                var loads = oc == null ? null : Json.A(oc, "loads");
                if(loads == null)
                {
                    continue;
                }
                foreach(var lo in loads.OfType<Dictionary<string, object>>())
                {
                    var l = new Load
                    {
                        Id = Json.S(lo, "id", $"o{o + 1}l{fresh[o].Count}"),
                        RatedA = Json.D(lo, "ratedA", 0),
                        VExp = Json.D(lo, "vExp", 1),
                        TableMs = Math.Max(1e-3, Json.D(lo, "tableMs", 1)),
                        LoopMs = Json.D(lo, "loopMs", 0),
                        CoolDownMs = Json.D(lo, "coolDownMs", 1500),
                        StallA = Json.D(lo, "stallA", 0),
                        ShortA = Json.D(lo, "shortA", 999),
                    };
                    var table = Json.A(lo, "table");
                    if(table != null)
                    {
                        l.Table = table.Select(x => x is double d ? d : 0).ToArray();
                    }
                    l.SteadyA = Json.D(lo, "steadyA", l.Table.Length > 0 ? l.Table[l.Table.Length - 1] : l.RatedA);
                    var rip = Json.O(lo, "ripple");
                    if(rip != null)
                    {
                        l.RippleHz = Json.D(rip, "hz", 0);
                        l.RipplePct = Json.D(rip, "pct", 0);
                    }
                    var pwm = Json.O(lo, "pwm");
                    if(pwm != null)
                    {
                        l.OnPhaseExp = Json.D(pwm, "onPhaseExp", 0);
                        l.Motor = Json.S(pwm, "model", "") == "motor";
                        l.KLR = Json.D(pwm, "kLR", Json.D(lo, "kLR", 1));
                        l.Pwmable = !(pwm.TryGetValue("pwmable", out var pw) && pw is bool b && !b);
                    }
                    if(lo.TryGetValue("fault", out var f) && f != null)
                    {
                        if(f is string fs)
                        {
                            l.FaultKind = fs == "clear" ? null : fs;
                        }
                        else if(f is Dictionary<string, object> fo)
                        {
                            var k = Json.S(fo, "kind", null);
                            l.FaultKind = k == "clear" ? null : k;
                            l.FaultAtMs = Json.D(fo, "atMs", 0);
                        }
                    }
                    // keep the thermal state of a load that survives the replace (same output, same id)
                    var prev = outputs[o].FirstOrDefault(p => p.Id == l.Id);
                    if(prev != null)
                    {
                        l.OnMs = prev.OnMs;
                        l.OffMs = prev.OffMs;
                        l.Active = prev.Active;
                    }
                    fresh[o].Add(l);
                }
            }
            // a load id that appears on several outputs is one physical load fed in parallel: split it
            var count = fresh.SelectMany(x => x).GroupBy(x => x.Id).ToDictionary(g => g.Key, g => g.Count());
            foreach(var l in fresh.SelectMany(x => x))
            {
                l.Shares = count[l.Id];
            }
            outputs = fresh;
        }

        private void SetFault(int output, string loadId, string kind, double atMs)
        {
            if(output < 1 || output > nOut)
            {
                this.Log(LogLevel.Warning, "fault: no output {0}", output);
                return;
            }
            foreach(var l in outputs[output - 1].Where(x => loadId == null || x.Id == loadId))
            {
                l.FaultKind = (kind == null || kind == "clear" || kind == "none") ? null : kind;
                l.FaultAtMs = atMs;
                l.Dropped = false;
                l.PhaseMs = 0;
            }
        }

        // ---------------------------------- 1 kHz tick (machine thread) --------------------------------

        private void Tick()
        {
            // PWM settings change clock entries, so they run here, outside `sync` (lock order, README 16)
            while(pwmPending.TryDequeue(out var p))
            {
                ApplyPwm(p);
            }
            lock(sync)
            {
                ticks++;
                while(pending.Count > 0)
                {
                    pending.Dequeue()();
                }
                if(rng == null)
                {
                    rng = new XorShift(seed != 0 ? (uint)seed : Fnv(MachineName));   // stable across runs (golden traces)
                }
                if(timerPresent == null)
                {
                    timerPresent = timers.Select(a => SafePeripheralAt(a)).ToArray();
                }

                ReadOutputDrive();
                if(nOut > 0)
                {
                    ModelOutputs();
                    for(var o = 0; o < nOut; o++)
                    {
                        if(dselOf[o] < 0 || Selected(o))
                        {
                            Feed(0, isCh[o], raw[o]);
                        }
                    }
                    Feed(0, (uint)battCh, (uint)Clamp(Math.Round(vbatt * 4.7 / 51.7 / 3.3 * 4095), 0, 4095));
                    Feed(0, 16, tempRaw);
                    Feed(0, 17, vrefRaw);
                }
                else
                {
                    // CANBoard: AI1..4 = ADC1 IN1..IN4, AI5 = ADC2 IN1; divider 4k7 / 10k (port.cpp AdcToVolts)
                    for(var a = 0; a < nAn; a++)
                    {
                        var pinMv = analogMv[a] * 10000.0 / 14700.0;
                        var r = (uint)Clamp(Math.Round(pinMv / 3300.0 * 4095), 0, 4095);
                        if(a < 4)
                        {
                            Feed(0, (uint)(a + 1), r);
                        }
                        else
                        {
                            Feed(1, 1, r);
                        }
                    }
                    Feed(0, 16, tempRaw);
                }

                SleepAndWake();

                if(ticks % 100 == 0)
                {
                    LoadBankHost.Broadcast(Trace());
                }
            }
        }

        private void ReadOutputDrive()
        {
            var n = Math.Max(nOut, nDo);
            for(var o = 0; o < n; o++)
            {
                var pwmRun = false;
                var d = 0.0;
                if(timerPresent[o])
                {
                    TryReadTimer(o);
                    var t = timerRegs[o];
                    if((t.Cr1 & 1) != 0 && t.Ccr > 0)
                    {
                        pwmRun = true;
                        d = Math.Min(1.0, t.Ccr / (double)(t.Arr + 1));
                    }
                }
                on[o] = inPin[o] || pwmRun;
                duty[o] = pwmRun ? d : (inPin[o] ? 1.0 : 0.0);
                pwmActive[o] = pwmRun && d < 1.0;
            }
        }

        private void ModelOutputs()
        {
            var nowMs = ticks;
            // shares: a split load divides between the outputs of its id that are on right now
            var onCount = new Dictionary<string, int>();
            for(var o = 0; o < nOut; o++)
            {
                foreach(var l in outputs[o])
                {
                    if(l.Shares > 1 && on[o])
                    {
                        onCount[l.Id] = onCount.TryGetValue(l.Id, out var c) ? c + 1 : 1;
                    }
                }
            }
            for(var o = 0; o < nOut; o++)
            {
                var sum = 0.0;
                foreach(var l in outputs[o])
                {
                    AdvanceClock(l, on[o]);
                    var i = LoadCurrent(l, duty[o], pwmActive[o], nowMs);
                    if(l.Shares > 1 && onCount.TryGetValue(l.Id, out var c) && c > 1)
                    {
                        i /= c;
                    }
                    sum += i;
                }
                if(on[o] && noisePct > 0 && sum > 0)
                {
                    sum *= 1 + rng.Uniform(-1, 1) * noisePct / 100.0;
                }
                sum = Clamp(sum, 0, satA[o]);
                current[o] = sum;
                if(sum > peak[o])
                {
                    peak[o] = sum;   // peak since the last trace: a trip in the first ms of an inrush is
                }                    // invisible in the 10 Hz instantaneous `i`
                raw[o] = (uint)Clamp(Math.Round(sum * 1200 * 4095 / (3.3 * kIlis[o])), 0, 4095);
            }
        }

        private static void AdvanceClock(Load l, bool requested)
        {
            if(requested)
            {
                if(!l.Active)
                {
                    l.Active = true;
                    if(l.OffMs >= l.CoolDownMs)
                    {
                        l.OnMs = 0;     // cold start
                    }
                    l.PhaseMs = 0;
                    l.Dropped = false;
                }
                else
                {
                    l.OnMs += 1;
                }
                l.OffMs = 0;
            }
            else
            {
                l.Active = false;
                if(l.OffMs < double.MaxValue)
                {
                    l.OffMs += 1;
                }
            }
        }

        private double LoadCurrent(Load l, double d, bool pwm, long nowMs)
        {
            if(!l.Active)
            {
                return 0;
            }
            var i = TableValue(l);
            if(vbatt > 0 && l.VExp != 0)
            {
                i *= Math.Pow(vbatt / 13.8, l.VExp);
            }
            if(l.RipplePct != 0 && l.RippleHz > 0)
            {
                i *= 1 + l.RipplePct / 100.0 * Math.Sin(2 * Math.PI * l.RippleHz * nowMs / 1000.0);
            }
            if(pwm && l.Pwmable && d > 0)
            {
                // the firmware samples inside the on window: feed the on-phase current
                i *= l.Motor ? 1 + (l.KLR - 1) * (1 - d) : Math.Pow(1 / d, l.OnPhaseExp);
            }
            if(l.FaultKind != null && l.OnMs >= l.FaultAtMs)
            {
                switch(l.FaultKind)
                {
                case "open":
                    i = 0;
                    break;
                case "short":
                    i = l.ShortA;
                    break;
                case "stall":
                    i = l.StallA * (vbatt > 0 ? vbatt / 13.8 : 1);
                    break;
                case "hires":
                    i *= 0.6;
                    break;
                case "wrongpart":
                    i *= 2;
                    break;
                case "intermittent":
                    if(l.PhaseMs <= 0)
                    {
                        l.Dropped = !l.Dropped;
                        l.PhaseMs = l.Dropped ? rng.Uniform(50, 500) : rng.Uniform(200, 2000);
                    }
                    l.PhaseMs -= 1;
                    if(l.Dropped)
                    {
                        i = 0;
                    }
                    break;
                }
            }
            return Math.Max(0, i);
        }

        private static double TableValue(Load l)
        {
            var t = l.Table;
            if(t.Length == 0)
            {
                return l.SteadyA;
            }
            var ms = l.OnMs;
            if(l.LoopMs > 0)
            {
                ms %= l.LoopMs;
            }
            var x = ms / l.TableMs;
            if(x >= t.Length - 1)
            {
                return l.LoopMs > 0 || x < t.Length ? t[t.Length - 1] : l.SteadyA;
            }
            var k = (int)x;
            return t[k] + (t[k + 1] - t[k]) * (x - k);
        }

        private bool Selected(int o)
        {
            // BTS7008 CH1 (outputs 3/5/7) on DSEL low, CH2 (4/6/8) on DSEL high (profet.cpp HandleDsel)
            var dselHigh = inPin[dselOf[o]];
            return (o % 2 == 1) == dselHigh;
        }

        // ---------------------------------- sleep / wake ------------------------------------------------

        private void SleepAndWake()
        {
            if(ticks % 10 == 0)
            {
                TryReadBus(0xE000ED10, ref scbScr);              // SCB->SCR, non-blocking (see TryReadBus)
                var deep = (scbScr & 0x4) != 0;                  // SLEEPDEEP
                if(deep && !wasDeepSleep)
                {
                    Emit("sleep");
                }
                wasDeepSleep = deep;
            }
            var frame = Interlocked.Exchange(ref frameSeen, 0) != 0;
            var force = Interlocked.Exchange(ref forcePulse, 0) != 0;
            if(force || (frame && wasDeepSleep && ticks - lastPulse >= 50))
            {
                lastPulse = ticks;
                Connections[8].Toggle();
                Emit("wake-pulse");
            }
        }

        // ---------------------------------- PWM source on a DI ----------------------------------------
        // One 1 MHz clock entry per DI: each firing flips the pin and re-arms itself for the next phase, so
        // edges land at their exact virtual time (the 1 kHz tick would quantise a 100 Hz duty to 10 %).

        private struct PwmSet { public int Di; public double Duty; public double Freq; }

        private void ApplyPwm(PwmSet p)
        {
            var i = p.Di - 1;
            var periodUs = p.Freq > 0 ? 1e6 / p.Freq : 0;
            var hi = (ulong)Math.Round(periodUs * p.Duty / 100.0);
            var lo = (ulong)Math.Round(periodUs) - Math.Min(hi, (ulong)Math.Round(periodUs));
            if(pwmEdge[i] == null)
            {
                var idx = i;
                pwmEdge[i] = () => PwmEdge(idx);
                machine.ClockSource.AddClockEntry(new ClockEntry(period: 1, frequency: 1000000, handler: pwmEdge[i],
                    owner: this, localName: "pwm-di" + p.Di, enabled: false, workMode: WorkMode.Periodic));
            }
            if(hi == 0 || lo == 0)
            {
                // steady: 0 % (or no frequency) = low, 100 % = high
                machine.ClockSource.ExchangeClockEntryWith(pwmEdge[i], e => e.With(enabled: false));
                pwmHi[i] = pwmLo[i] = 0;
                lock(sync)
                {
                    DriveDi(p.Di, hi > 0 && periodUs > 0);
                }
                return;
            }
            var running = pwmHi[i] != 0;
            pwmHi[i] = hi;
            pwmLo[i] = lo;
            if(!running)
            {
                // start on a rising edge; the new phase lengths apply from the next edge
                lock(sync)
                {
                    DriveDi(p.Di, true);
                }
                machine.ClockSource.ExchangeClockEntryWith(pwmEdge[i], e => e.With(period: hi, enabled: true, value: 0));
            }
        }

        private void PwmEdge(int i)
        {
            var hi = pwmHi[i];
            var lo = pwmLo[i];
            if(hi == 0)
            {
                return;
            }
            var level = !diState[i];
            diState[i] = level;
            Connections[i].Set(level);
            var now = machine.ElapsedVirtualTime.TimeElapsed.TotalNanoseconds;
            if(level)
            {
                pwmPeriodNs[i] = (uint)(now - pwmRiseNs[i]);
                pwmRiseNs[i] = now;
            }
            else
            {
                pwmHighNs[i] = (uint)(now - pwmRiseNs[i]);
            }
            machine.ClockSource.ExchangeClockEntryWith(pwmEdge[i], e => e.With(period: level ? hi : lo));
        }

        private readonly ConcurrentQueue<PwmSet> pwmPending = new ConcurrentQueue<PwmSet>();
        private readonly Action[] pwmEdge = new Action[8];
        private readonly ulong[] pwmHi = new ulong[8];
        private readonly ulong[] pwmLo = new ulong[8];
        private readonly ulong[] pwmRiseNs = new ulong[8];
        private readonly uint[] pwmHighNs = new uint[8];
        private readonly uint[] pwmPeriodNs = new uint[8];

        private void DriveDi(int di, bool value)
        {
            if(di < 1 || di > nDi)
            {
                this.Log(LogLevel.Warning, "gpio: DI{0} does not exist on {1}", di, Board);
                return;
            }
            diState[di - 1] = value;
            Connections[di - 1].Set(value);
        }

        private void SetBoardTemperature(double c)
        {
            boardTempC = c;
            var t = FindTempSensor();
            if(t == null)
            {
                this.Log(LogLevel.Warning, "temp: no MCP9808 model found on {0}", MachineName);
                return;
            }
            t.GetType().GetMethod("SetTemperature", new[] { typeof(double) })?.Invoke(t, new object[] { c });
        }

        private object FindTempSensor()
        {
            if(tempSensor == null)
            {
                tempSensor = machine.GetPeripheralsOfType<IPeripheral>()
                    .FirstOrDefault(p => p.GetType().Name.IndexOf("MCP9808", StringComparison.OrdinalIgnoreCase) >= 0);
            }
            return tempSensor;
        }

        private double ReadBoardTemperature()
        {
            var t = FindTempSensor();
            var prop = t?.GetType().GetProperty("Temperature");
            if(prop != null && prop.GetValue(t) is double d)
            {
                return d;
            }
            return boardTempC;
        }

        // ---------------------------------- ADC feed ----------------------------------------------------

        private Action<uint, uint> MakeFeeder(IPeripheral p, string what)
        {
            if(p == null)
            {
                return null;
            }
            if(p is Antmicro.Renode.Peripherals.Analog.STM32_ADC f4)
            {
                return (ch, r) => f4.FeedSample(r, ch, -1);
            }
            if(p is Antmicro.Renode.Peripherals.Sensor.IADC iadc)
            {
                // IADC.SetADCValue(channel, valueMicroVolts) in Renode 1.16.1: microvolts at the pin
                return (ch, r) => iadc.SetADCValue((int)ch, (uint)Math.Round(r * 3300000.0 / 4095));
            }
            var mi = p.GetType().GetMethod("FeedSample", new[] { typeof(uint), typeof(uint), typeof(int) });
            if(mi != null)
            {
                return (ch, r) => mi.Invoke(p, new object[] { r, ch, -1 });
            }
            this.Log(LogLevel.Error, "{0}: {1} has no FeedSample/SetADCValue", what, p.GetType().FullName);
            return null;
        }

        // Renode 1.16.1 STM32_ADC.Reset() keeps its scan position (currentChannelIdx) and leaves its
        // sampling timer running. After a module reset (`machine Reset` + LoadELF) the firmware's new
        // circular DMA scan then starts mid-sequence and every value lands in the wrong buffer slot
        // (seen as 6553.5 A / swapped currents after a second reset). Put the sequencer back at slot 0
        // and stop the timer, as a hardware reset does. Reflection: both fields are private.
        private void ResetF4AdcSequencer()
        {
            if(f4Adc == null)
            {
                return;
            }
            try
            {
                const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
                var t = typeof(Antmicro.Renode.Peripherals.Analog.STM32_ADC);
                t.GetField("currentChannelIdx", flags)?.SetValue(f4Adc, 0u);
                var timer = t.GetField("samplingTimer", flags)?.GetValue(f4Adc);
                timer?.GetType().GetProperty("Enabled")?.SetValue(timer, false);
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "cannot reset the ADC sequencer: {0}", e.Message);
            }
        }

        private readonly Antmicro.Renode.Peripherals.Analog.STM32_ADC f4Adc;
        private readonly double[] peak;

        // The F4 STM32_ADC model converts one channel per 100 us, so the PDM's 8-channel circular scan
        // refreshes a slot only every 800 us, while the firmware reads the shared IS3_4/5_6/7_8 slot
        // 60 us after flipping DSEL (profet.cpp HandleDsel). Real hardware converts the whole scan in a
        // few us. So on a DSEL change also write the value straight into the slot of the firmware's ADC
        // buffer: DMA2 stream 4 M0AR + 2 * (position of `ch` in ADC1 SQR1..3). Depth-1 buffer
        // (port.h ADC1_BUF_DEPTH 1); the next conversion of that slot writes the same value.
        private void PatchScanSlot(uint ch, uint value)
        {
            if(Board != "pdm" && Board != "pdmmax")
            {
                return;
            }
            try
            {
                const ulong adcBase = 0x40012000, stream4 = 0x40026400 + 0x10 + 0x18 * 4;
                var cr = sysbus.ReadDoubleWord(stream4);
                if((cr & 1) == 0)
                {
                    return;
                }
                var m0ar = sysbus.ReadDoubleWord(stream4 + 0xC);
                var sqr1 = sysbus.ReadDoubleWord(adcBase + 0x2C);
                var sqr2 = sysbus.ReadDoubleWord(adcBase + 0x30);
                var sqr3 = sysbus.ReadDoubleWord(adcBase + 0x34);
                var len = (int)((sqr1 >> 20) & 0xF) + 1;
                for(var k = 0; k < len; k++)
                {
                    var reg = k < 6 ? sqr3 : (k < 12 ? sqr2 : sqr1);
                    var sq = (reg >> (5 * (k % 6))) & 0x1F;
                    if(sq == ch)
                    {
                        sysbus.WriteWord(m0ar + (ulong)(2 * k), (ushort)value);
                        return;
                    }
                }
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Debug, "PatchScanSlot: {0}", e.Message);
            }
        }

        private void Feed(int adcIdx, uint ch, uint value)
        {
            var key = (adcIdx << 8) | (int)ch;
            if(lastFed.TryGetValue(key, out var old) && old == value)
            {
                return;
            }
            var f = feeders[adcIdx];
            if(f == null)
            {
                return;
            }
            lastFed[key] = value;
            f(ch, value);
        }

        // Tick runs as a clock-entry callback, i.e. with this machine's clock source locked. A sysbus read
        // takes the target's bus-access lock, and a CPU writing a timer (or SysTick) register holds that lock
        // while it asks the clock source for its entry: the two waited on each other (seen under
        // `emulation RunFor`: whole emulation frozen at 0 % CPU). So take the same lock without waiting and
        // read the peripheral directly; when the CPU is mid-access, keep the previous value.
        private bool TryReadBus(ulong addr, ref uint value)
        {
            if(!busTargets.TryGetValue(addr, out var t))
            {
                var locks = sysbus.GetType().GetField("peripheralAccessLocks", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(sysbus) as System.Collections.IDictionary;
                var reg = sysbus.WhatIsAt(addr);
                var p = reg?.Peripheral as IDoubleWordPeripheral;
                var l = p != null && locks != null && locks.Contains(p.GetHashCode()) ? locks[p.GetHashCode()] : null;
                t = (p != null && l != null) ? Tuple.Create(p, l, (long)(addr - reg.RegistrationPoint.Range.StartAddress)) : null;
                busTargets[addr] = t;
            }
            if(t == null || !System.Threading.Monitor.TryEnter(t.Item2))
            {
                return false;
            }
            try
            {
                value = t.Item1.ReadDoubleWord(t.Item3);
                return true;
            }
            finally
            {
                System.Threading.Monitor.Exit(t.Item2);
            }
        }

        private void TryReadTimer(int o)
        {
            if(timerRegs == null) timerRegs = new TimerRegs[timers.Length];
            var r = timerRegs[o];
            TryReadBus(timers[o], ref r.Cr1);
            TryReadBus(timers[o] + 0x2C, ref r.Arr);
            TryReadBus(timers[o] + 0x34, ref r.Ccr);
            timerRegs[o] = r;
        }

        private struct TimerRegs { public uint Cr1, Arr, Ccr; }

        private bool SafePeripheralAt(ulong addr)
        {
            try
            {
                return sysbus.WhatPeripheralIsAt(addr) != null;
            }
            catch(Exception)
            {
                return false;
            }
        }

        // ---------------------------------- output messages ---------------------------------------------

        private double Now() => machine.ElapsedVirtualTime.TimeElapsed.TotalSeconds;

        private string Trace()
        {
            var w = new JsonWriter().Begin().Str("type", "trace").Str("machine", MachineName).Num("t", Math.Round(Now(), 4));
            if(nOut > 0)
            {
                w.Arr("i", current.Select(x => Math.Round(x, 3))).Arr("peak", peak.Select(x => Math.Round(x, 3))).Arr("on", on.Select(x => x ? 1.0 : 0))
                 .Arr("duty", duty.Select(x => Math.Round(x * 100, 1))).Num("vbattV", Math.Round(vbatt, 3))
                 .Num("tempC", Math.Round(ReadBoardTemperature(), 2));
            }
            else
            {
                w.Arr("do", on.Select(x => x ? 1.0 : 0)).Arr("duty", duty.Select(x => Math.Round(x * 100, 1)))
                 .Arr("di", diState.Select(x => x ? 1.0 : 0)).Arr("mV", analogMv.Select(x => Math.Round(x, 1)));
            }
            Array.Clear(peak, 0, peak.Length);
            return w.End();
        }

        private void Emit(string what)
        {
            LoadBankHost.Broadcast(new JsonWriter().Begin().Str("type", "event").Str("machine", MachineName)
                .Num("t", Math.Round(Now(), 4)).Str("what", what).End());
        }

        private static uint Fnv(string s)
        {
            var h = 2166136261u;
            foreach(var c in s)
            {
                h = (h ^ c) * 16777619u;
            }
            return h;
        }

        private static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

        // ---------------------------------- state -------------------------------------------------------

        private readonly IMachine machine;
        private readonly IBusController sysbus;
        private readonly object sync = new object();
        private readonly int nOut, nDi, nDo, nAn, battCh, seed;
        private readonly double[] kIlis, satA, current, duty, analogMv;
        private readonly uint[] isCh, raw;
        private readonly int[] dselOf;
        private readonly ulong[] timers;
        private readonly bool[] on, diState;
        private readonly bool[] inPin = new bool[16];
        private readonly bool[] pwmActive = new bool[8];
        private readonly uint tempRaw, vrefRaw;
        private readonly Action<uint, uint>[] feeders;
        private readonly Dictionary<int, uint> lastFed = new Dictionary<int, uint>();
        private readonly Queue<Action> pending = new Queue<Action>();
        private List<Load>[] outputs;
        private bool[] timerPresent;
        private TimerRegs[] timerRegs;
        private uint scbScr;
        private readonly Dictionary<ulong, Tuple<IDoubleWordPeripheral, object, long>> busTargets = new Dictionary<ulong, Tuple<IDoubleWordPeripheral, object, long>>();
        private double vbatt, noisePct, boardTempC = 25;
        private long ticks, lastPulse = -1000;
        private bool wasDeepSleep;
        private int frameSeen, forcePulse;
        private object tempSensor;
        private string machineName;
        private XorShift rng;

        private class XorShift
        {
            public XorShift(uint s)
            {
                state = s == 0 ? 0x9E3779B9u : s;
            }

            public double Uniform(double lo, double hi)
            {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                return lo + (hi - lo) * (state / 4294967296.0);
            }

            private uint state;
        }
    }

    // ==================================== shared TCP listener ===========================================

    internal static class LoadBankHost
    {
        public static void Register(ProfetLoadBank bank, int port)
        {
            lock(sync)
            {
                banks.Add(bank);
                if(listener == null)
                {
                    try
                    {
                        listener = new TcpListener(IPAddress.Loopback, port);
                        listener.Start();
                        Port = port;
                        new Thread(AcceptLoop) { IsBackground = true, Name = "loadbank-accept" }.Start();
                        Logger.Log(LogLevel.Info, "ProfetLoadBank: NDJSON on 127.0.0.1:{0}", port);
                    }
                    catch(Exception e)
                    {
                        listener = null;
                        Logger.Log(LogLevel.Error, "ProfetLoadBank: cannot listen on {0}: {1}", port, e.Message);
                    }
                }
                else if(port != Port)
                {
                    Logger.Log(LogLevel.Warning, "ProfetLoadBank: port {0} ignored, the shared listener is on {1}", port, Port);
                }
                foreach(var c in clients)
                {
                    c.Send(bank.Hello());
                }
            }
        }

        public static int Port { get; private set; }

        public static void Broadcast(string line)
        {
            Client[] cs;
            lock(sync)
            {
                if(clients.Count == 0)
                {
                    return;
                }
                cs = clients.ToArray();
            }
            foreach(var c in cs)
            {
                c.Send(line);
            }
        }

        private static void AcceptLoop()
        {
            while(true)
            {
                TcpClient tc;
                try
                {
                    tc = listener.AcceptTcpClient();
                }
                catch(Exception e)
                {
                    Logger.Log(LogLevel.Warning, "ProfetLoadBank: accept failed: {0}", e.Message);
                    return;
                }
                tc.NoDelay = true;
                var c = new Client(tc);
                lock(sync)
                {
                    clients.Add(c);
                    foreach(var b in banks)
                    {
                        c.Send(b.Hello());
                    }
                }
                new Thread(() => ReadLoop(c)) { IsBackground = true, Name = "loadbank-reader" }.Start();
            }
        }

        private static void ReadLoop(Client c)
        {
            try
            {
                using(var reader = new StreamReader(c.Tcp.GetStream(), new UTF8Encoding(false)))
                {
                    string line;
                    while((line = reader.ReadLine()) != null)
                    {
                        if(line.Trim().Length > 0)
                        {
                            Handle(c, line);
                        }
                    }
                }
            }
            catch(Exception)
            {
            }
            lock(sync)
            {
                clients.Remove(c);
            }
            c.Close();
        }

        private static void Handle(Client c, string line)
        {
            Dictionary<string, object> m;
            try
            {
                m = Json.Parse(line) as Dictionary<string, object>;
            }
            catch(Exception e)
            {
                c.Send(Error("bad json: " + e.Message));
                return;
            }
            if(m == null)
            {
                c.Send(Error("not an object"));
                return;
            }
            var type = Json.S(m, "type", "");
            ProfetLoadBank[] bs;
            lock(sync)
            {
                bs = banks.ToArray();
            }
            if(type == "list")
            {
                var sb = new StringBuilder("{\"type\":\"machines\",\"items\":[");
                sb.Append(string.Join(",", bs.Select(b => new JsonWriter().Begin().Str("machine", b.MachineName)
                    .Str("board", b.Board).End())));
                c.Send(sb.Append("]}").ToString());
                return;
            }
            var target = Json.S(m, "machine", "*");
            var hit = 0;
            foreach(var b in bs.Where(b => target == "*" || b.MachineName == target))
            {
                try
                {
                    b.Apply(m);
                }
                catch(Exception e)
                {
                    c.Send(Error($"{b.MachineName}: {e.Message}"));
                }
                hit++;
            }
            if(hit == 0)
            {
                c.Send(Error($"no machine '{target}'"));
            }
        }

        private static string Error(string msg) => new JsonWriter().Begin().Str("type", "error").Str("msg", msg).End();

        private class Client
        {
            public Client(TcpClient tc)
            {
                Tcp = tc;
                new Thread(WriteLoop) { IsBackground = true, Name = "loadbank-writer" }.Start();
            }

            public TcpClient Tcp { get; }

            public void Send(string line)
            {
                if(!queue.IsAddingCompleted)
                {
                    queue.TryAdd(line + "\n");    // drop when a slow client falls 20000 lines behind
                }
            }

            public void Close()
            {
                queue.CompleteAdding();
                try { Tcp.Close(); } catch { }
            }

            private void WriteLoop()
            {
                try
                {
                    var s = Tcp.GetStream();
                    foreach(var line in queue.GetConsumingEnumerable())
                    {
                        var bytes = Encoding.UTF8.GetBytes(line);
                        s.Write(bytes, 0, bytes.Length);
                    }
                }
                catch(Exception)
                {
                }
            }

            private readonly BlockingCollection<string> queue = new BlockingCollection<string>(new ConcurrentQueue<string>(), 20000);
        }

        private static readonly object sync = new object();
        private static readonly List<ProfetLoadBank> banks = new List<ProfetLoadBank>();
        private static readonly List<Client> clients = new List<Client>();
        private static TcpListener listener;
    }

    // ==================================== tiny JSON =====================================================
    // Objects -> Dictionary<string, object>, arrays -> List<object>, numbers -> double, plus string/bool/null.
    // Self-contained so the model does not depend on which JSON assemblies the ad-hoc compiler references.

    internal static class Json
    {
        public static object Parse(string s)
        {
            var i = 0;
            var v = Value(s, ref i);
            Ws(s, ref i);
            if(i != s.Length)
            {
                throw new FormatException($"trailing data at {i}");
            }
            return v;
        }

        public static double D(Dictionary<string, object> m, string k, double def)
        {
            if(m != null && m.TryGetValue(k, out var v))
            {
                if(v is double d)
                {
                    return d;
                }
                if(v is bool b)
                {
                    return b ? 1 : 0;
                }
                if(v is string s && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p))
                {
                    return p;
                }
            }
            return def;
        }

        public static string S(Dictionary<string, object> m, string k, string def)
        {
            return m != null && m.TryGetValue(k, out var v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : def;
        }

        public static Dictionary<string, object> O(Dictionary<string, object> m, string k)
        {
            return m != null && m.TryGetValue(k, out var v) ? v as Dictionary<string, object> : null;
        }

        public static List<object> A(Dictionary<string, object> m, string k)
        {
            return m != null && m.TryGetValue(k, out var v) ? v as List<object> : null;
        }

        private static void Ws(string s, ref int i)
        {
            while(i < s.Length && char.IsWhiteSpace(s[i]))
            {
                i++;
            }
        }

        private static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if(i >= s.Length)
            {
                throw new FormatException("unexpected end");
            }
            var c = s[i];
            if(c == '{')
            {
                i++;
                var d = new Dictionary<string, object>();
                Ws(s, ref i);
                if(i < s.Length && s[i] == '}')
                {
                    i++;
                    return d;
                }
                while(true)
                {
                    Ws(s, ref i);
                    var k = Str(s, ref i);
                    Ws(s, ref i);
                    Expect(s, ref i, ':');
                    d[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if(i < s.Length && s[i] == ',')
                    {
                        i++;
                        continue;
                    }
                    Expect(s, ref i, '}');
                    return d;
                }
            }
            if(c == '[')
            {
                i++;
                var l = new List<object>();
                Ws(s, ref i);
                if(i < s.Length && s[i] == ']')
                {
                    i++;
                    return l;
                }
                while(true)
                {
                    l.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if(i < s.Length && s[i] == ',')
                    {
                        i++;
                        continue;
                    }
                    Expect(s, ref i, ']');
                    return l;
                }
            }
            if(c == '"')
            {
                return Str(s, ref i);
            }
            if(string.CompareOrdinal(s, i, "true", 0, 4) == 0)
            {
                i += 4;
                return true;
            }
            if(string.CompareOrdinal(s, i, "false", 0, 5) == 0)
            {
                i += 5;
                return false;
            }
            if(string.CompareOrdinal(s, i, "null", 0, 4) == 0)
            {
                i += 4;
                return null;
            }
            var start = i;
            while(i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0)
            {
                i++;
            }
            if(i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var num))
            {
                throw new FormatException($"bad value at {start}");
            }
            return num;
        }

        private static void Expect(string s, ref int i, char c)
        {
            if(i >= s.Length || s[i] != c)
            {
                throw new FormatException($"expected '{c}' at {i}");
            }
            i++;
        }

        private static string Str(string s, ref int i)
        {
            Expect(s, ref i, '"');
            var sb = new StringBuilder();
            while(i < s.Length)
            {
                var c = s[i++];
                if(c == '"')
                {
                    return sb.ToString();
                }
                if(c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if(i >= s.Length)
                {
                    break;
                }
                var e = s[i++];
                switch(e)
                {
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'u':
                    sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                    i += 4;
                    break;
                default: sb.Append(e); break;
                }
            }
            throw new FormatException("unterminated string");
        }
    }

    internal class JsonWriter
    {
        public JsonWriter Begin()
        {
            sb.Append('{');
            return this;
        }

        public JsonWriter Str(string k, string v) => Raw(k, Q(v));
        public JsonWriter Num(string k, double v) => Raw(k, N(v));
        public JsonWriter Bool(string k, bool v) => Raw(k, v ? "true" : "false");
        public JsonWriter Arr(string k, IEnumerable<double> v) => Raw(k, "[" + string.Join(",", v.Select(N)) + "]");

        public JsonWriter Raw(string k, string json)
        {
            if(sb.Length > 1)
            {
                sb.Append(',');
            }
            sb.Append(Q(k)).Append(':').Append(json);
            return this;
        }

        public string End() => sb.Append('}').ToString();

        public static string N(double v) => double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("0.######", CultureInfo.InvariantCulture);

        public static string Q(string s)
        {
            if(s == null)
            {
                return "null";
            }
            var sb = new StringBuilder("\"");
            foreach(var c in s)
            {
                if(c == '"' || c == '\\')
                {
                    sb.Append('\\').Append(c);
                }
                else if(c < 0x20)
                {
                    sb.Append("\\u").Append(((int)c).ToString("x4"));
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.Append('"').ToString();
        }

        private readonly StringBuilder sb = new StringBuilder();
    }
}
