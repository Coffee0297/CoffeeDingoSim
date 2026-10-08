//
// Minimal Cortex-M DWT (0xE0001000): CTRL + CYCCNT. ChibiOS enables CYCCNT in port_init() and uses it
// for polled delays (port_rt_get_counter_value); without it every polled delay spins forever.
// CYCCNT = virtual time x PerformanceInMips (== core MHz), synced to the executing instruction first, so it
// counts through the idle time Renode skips (sharp edge 14) and is exact inside an ISR. ExecutedInstructions
// made a PWM input read ~45x the real frequency; ElapsedCycles only moves at sync points (+500 us on a fall).
//
// repl:  dwt: Miscellaneous.CortexMDwt @ sysbus 0xE0001000
//            cpu: cpu
//
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class CortexMDwt : IDoubleWordPeripheral, IKnownSize
    {
        public CortexMDwt(IMachine machine, ICPU cpu)
        {
            this.machine = machine;
            this.cpu = cpu as TranslationCPU;
            Reset();
        }

        public void Reset()
        {
            ctrl = 0x40000000;   // NUMCOMP = 4, no features beyond CYCCNT modelled
            offset = 0;
        }

        public long Size => 0x1000;

        public uint ReadDoubleWord(long off)
        {
            switch(off)
            {
            case 0x0: return ctrl;
            case 0x4: return (uint)(Cycles() - offset);
            default: return 0;
            }
        }

        public void WriteDoubleWord(long off, uint value)
        {
            switch(off)
            {
            case 0x0: ctrl = value; break;
            case 0x4: offset = Cycles() - value; break;
            default: break;
            }
        }

        // Read from the CPU thread (firmware access), where SyncTime is allowed.
        private ulong Cycles()
        {
            if(cpu == null)
            {
                return 0;
            }
            cpu.SyncTime();
            return (ulong)(machine.ElapsedVirtualTime.TimeElapsed.TotalNanoseconds * cpu.PerformanceInMips / 1000);
        }

        private readonly IMachine machine;
        private readonly TranslationCPU cpu;
        private uint ctrl;
        private ulong offset;
    }
}
