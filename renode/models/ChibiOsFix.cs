//
// ChibiOsFix — makes ChibiOS's ISR preemption work on Renode.
//
// Bug (Renode 1.16.1+20260623git3f5a91013): inside an ISR, SCB->ICSR reads with RETTOBASE (bit 11)
// = 0 even when the ISR is the only active exception (TIM2 ISR read ICSR = 0x0000002C). ChibiOS's
// ARMv7-M __port_irq_epilogue() only redirects the exception return to __port_switch_from_isr when
// RETTOBASE is set, so without a fix no interrupt ever preempts a thread and the firmware stalls in
// the idle thread after the first sleep.
//
// Fix (no CPU hook, so the interrupt path stays at full speed): __port_irq_epilogue loads the SCB
// base 0xE000ED00 from its literal pool and then reads ICSR at [base + 4]. Install() rewrites that
// one literal word to point at this peripheral, whose offset 4 returns the real ICSR with bit 11
// recomputed (set when at most one exception is active: NVIC IABR0..7 + SHCSR active bits).
// Located from the ELF symbol, so it survives firmware rebuilds; patch is in RAM-backed flash only.
//
// Second bug, same root (Renode NVIC bookkeeping): an external IRQ can stay marked ACTIVE in IABR after
// its handler has returned (seen on CAN1 RX0 under bus load: ICSR.VECTACTIVE = 36 while the CPU ran the
// idle thread). Every later ISR then counts two active exceptions, the recomputed RETTOBASE stays 0,
// no ISR ever preempts again, and the module sits in the idle thread with its threads READY and its CAN
// FIFO full, silent on the bus. Install() also adds a 1 kHz check: if the CPU is in Thread mode
// (IPSR = 0) on 3 checks in a row no exception can be active, so the bit is stale and is completed in the NVIC; the
// pending interrupts then run and their epilogue preempts as usual. StaleActiveCleared counts repairs.
//
// repl:     chibiosFix: Miscellaneous.ChibiOsFix @ sysbus 0x5FFF1000
// monitor:  sysbus.chibiosFix Install          (after sysbus LoadELF, before start)
//
using System;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;
using Antmicro.Renode.Peripherals.IRQControllers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class ChibiOsFix : IDoubleWordPeripheral, IKnownSize
    {
        public ChibiOsFix(IMachine machine, ulong windowAddress = 0x5FFF1000)
        {
            this.machine = machine;
            this.windowAddress = windowAddress;
        }

        public void Reset() { }

        public long Size => 0x10;

        public ulong PatchedLiteralAddress { get; private set; }
        public ulong Redirects { get; private set; }   // ISR exits that were allowed to preempt
        public ulong StaleActiveCleared { get; private set; }   // stale NVIC active bits completed

        public uint ReadDoubleWord(long offset)
        {
            var bus = machine.SystemBus;
            if(offset == 0xC)
            {
                return (uint)StaleActiveCleared;   // diagnostics only: the patched epilogue reads offset 4 alone
            }
            if(offset != 4)
            {
                return bus.ReadDoubleWord(0xE000ED00 + (ulong)offset);
            }
            var icsr = bus.ReadDoubleWord(0xE000ED04);
            var n = 0;
            for(ulong i = 0; i < 8; i++)
            {
                n += PopCount(bus.ReadDoubleWord(0xE000E300 + 4 * i));
            }
            n += PopCount(bus.ReadDoubleWord(0xE000ED24) & 0xD8B);
            if(n <= 1)
            {
                Redirects++;
                return icsr | 0x800;
            }
            return icsr & ~0x800u;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            machine.SystemBus.WriteDoubleWord(0xE000ED00 + (ulong)offset, value);
        }

        public string Install()
        {
            var bus = machine.SystemBus;
            ulong baseAddr;
            try
            {
                baseAddr = bus.GetSymbolAddress("__port_irq_epilogue");
            }
            catch(Exception)
            {
                return Report("ChibiOsFix: __port_irq_epilogue not found (load the ELF first)");
            }
            var hasTest = false;
            for(ulong off = 0; off < 0x40; off += 2)
            {
                var hw0 = bus.ReadWord(baseAddr + off);
                var hw1 = bus.ReadWord(baseAddr + off + 2);
                if((hw0 & 0xFFF0) == 0xF410 && (hw1 & 0x70FF) == 0x6000)   // ANDS.W Rx, Rx, #0x800
                {
                    hasTest = true;
                    break;
                }
            }
            if(!hasTest)
            {
                return Report("ChibiOsFix: RETTOBASE test not found in __port_irq_epilogue; not patched");
            }
            var start = (baseAddr + 3) & ~3UL;
            for(ulong a = start; a < baseAddr + 0x80; a += 4)
            {
                if(bus.ReadDoubleWord(a) == 0xE000ED00)
                {
                    bus.WriteDoubleWord(a, (uint)windowAddress);
                    PatchedLiteralAddress = a;
                    InstallStaleActiveCheck();
                    return Report(string.Format("ChibiOsFix: literal 0xE000ED00 at 0x{0:X8} -> 0x{1:X8} (ICSR.RETTOBASE recomputed)", a, windowAddress));
                }
            }
            return Report("ChibiOsFix: SCB literal not found near __port_irq_epilogue; not patched");
        }

        // Idempotent: Install() runs again after every module reset.
        private void InstallStaleActiveCheck()
        {
            cpu = machine.SystemBus.GetCPUs().OfType<CortexM>().FirstOrDefault();
            nvic = machine.GetPeripheralsOfType<NVIC>().FirstOrDefault();
            if(cpu == null || nvic == null)
            {
                return;
            }
            machine.ClockSource.TryRemoveClockEntry(ClearStaleActive);
            machine.ClockSource.AddClockEntry(new ClockEntry(period: 1, frequency: 1000, handler: ClearStaleActive,
                owner: this, localName: "chibios-stale-active", enabled: true, workMode: WorkMode.Periodic));
        }

        // A bit is completed only after 3 consecutive Thread-mode checks (2 ms) saw it active. A single check
        // can catch a handler that is genuinely running (it read IPSR = 0 hundreds of times per hour), and
        // completing that IRQ desyncs Renode's NVIC active stack ("complete not active IRQ", then INVSTATE
        // faults and wedged cores). A stale bit never clears, so the delay costs nothing.
        private void ClearStaleActive()
        {
            var bus = machine.SystemBus;
            var thread = (cpu.XProgramStatusRegister & 0x1FF) == 0;
            for(var w = 0; w < 8; w++)
            {
                var now = thread ? bus.ReadDoubleWord(0xE000E300 + 4 * (ulong)w) : 0u;
                var active = now & seen1[w] & seen2[w];
                seen2[w] = now & seen1[w];
                seen1[w] = now;
                for(var b = 0; active != 0 && b < 32; b++, active >>= 1)
                {
                    if((active & 1) != 0)
                    {
                        nvic.CompleteIRQ(16 + 32 * w + b);   // exception number = IRQ + 16
                        StaleActiveCleared++;
                    }
                }
            }
        }

        private string Report(string msg)
        {
            this.Log(LogLevel.Info, msg);
            return msg;
        }

        private static int PopCount(uint v)
        {
            var n = 0;
            while(v != 0)
            {
                v &= v - 1;
                n++;
            }
            return n;
        }

        private readonly IMachine machine;
        private readonly ulong windowAddress;
        private CortexM cpu;
        private NVIC nvic;
        private readonly uint[] seen1 = new uint[8];
        private readonly uint[] seen2 = new uint[8];
    }
}
