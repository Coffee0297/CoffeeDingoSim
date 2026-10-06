//
// Minimal Cortex-M DWT (0xE0001000): CTRL + CYCCNT. ChibiOS enables CYCCNT in port_init() and uses it
// for polled delays (port_rt_get_counter_value); without it every polled delay spins forever.
// CYCCNT = CPU executed instructions (with PerformanceInMips == core MHz, 1 instruction = 1 cycle).
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

        private ulong Cycles() => cpu != null ? cpu.ExecutedInstructions : 0;

        private readonly TranslationCPU cpu;
        private uint ctrl;
        private ulong offset;
    }
}
