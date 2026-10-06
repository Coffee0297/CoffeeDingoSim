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
// repl:     chibiosFix: Miscellaneous.ChibiOsFix @ sysbus 0x5FFF1000
// monitor:  sysbus.chibiosFix Install          (after sysbus LoadELF, before start)
//
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

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

        public uint ReadDoubleWord(long offset)
        {
            var bus = machine.SystemBus;
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
                    return Report(string.Format("ChibiOsFix: literal 0xE000ED00 at 0x{0:X8} -> 0x{1:X8} (ICSR.RETTOBASE recomputed)", a, windowAddress));
                }
            }
            return Report("ChibiOsFix: SCB literal not found near __port_irq_epilogue; not patched");
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
    }
}
