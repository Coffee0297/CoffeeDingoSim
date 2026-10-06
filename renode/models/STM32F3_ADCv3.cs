//
// STM32F3_ADCv3 — minimal STM32F3 ADC (ADCv3, RM0316 §15) for CoffeeDingoSim, enough for ChibiOS
// os/hal/ports/STM32/LLD/ADCv3 in circular continuous scan mode with DMA.
//
// Why not Renode's Analog.STM32F3_ADC: in 1.16.1+20260623 its regular sequence stops at SQR1 (SQ1..SQ4;
// SQR2..SQR4 are unhandled), so the CANBoard's 5-entry ADC1 scan (IN1..IN4, IN16) dereferences a null
// sequence slot and Renode dies with a NullReferenceException on the first sweep.
//
// Model:
//   - CR: ADVREGEN stored; ADCAL self-clears; ADEN -> ISR.ADRDY; ADDIS clears ADEN; ADSTART starts the
//     sequencer (reads 1 while running); ADSTP stops it (reads 0)
//   - the regular sequence (SQR1..SQR4, L+1 entries) is swept at SweepFrequency (default 1 kHz virtual)
//     while ADSTART is set and CFGR.CONT; once when CONT = 0. Each conversion latches DR, sets EOC and,
//     with CFGR.DMAEN, blinks DMARequest (wire it to the DMA channel; DMA reads DR synchronously).
//   - EOS after each sweep. OVR / AWD are never raised. IRQ = ISR & IER.
//   - every other register reads back what was written.
// Input values (held until changed): SetADCValue channel microVolts (same API as Renode's ADCs),
// SetMillivolts channel mV, SetRaw channel counts. Channel = ADC input number (IN1 = 1, TS = 16).
//
//   adc1: Analog.STM32F3_ADCv3 @ sysbus <0x50000000, +0x100>
//       referenceVoltage: 3.3
//       DMARequest -> dma1@1
//       IRQ -> adcIrq@0
//
using System;

using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Analog
{
    public class STM32F3_ADCv3 : IDoubleWordPeripheral, IWordPeripheral, IKnownSize
    {
        public STM32F3_ADCv3(IMachine machine, double referenceVoltage = 3.3, ulong sweepFrequency = 1000)
        {
            ReferenceVoltage = referenceVoltage;
            IRQ = new GPIO();
            DMARequest = new GPIO();
            sweepTimer = new LimitTimer(machine.ClockSource, sweepFrequency, this, "sweep", limit: 1,
                                        direction: Direction.Ascending, enabled: false, eventEnabled: true, autoUpdate: true);
            sweepTimer.LimitReached += Sweep;
            Reset();
        }

        public void Reset()
        {
            Array.Clear(regs, 0, regs.Length);
            sweepTimer.Enabled = false;
            enabled = false;
            running = false;
            IRQ.Unset();
            DMARequest.Unset();
        }

        public long Size => 0x100;

        public GPIO IRQ { get; }
        public GPIO DMARequest { get; }
        public double ReferenceVoltage { get; set; }
        public ulong Conversions { get; private set; }

        public void SetRaw(int channel, int raw)
        {
            CheckChannel(channel);
            values[channel] = (ushort)Math.Max(0, Math.Min(4095, raw));
        }

        public void SetMillivolts(int channel, double millivolts)
        {
            SetRaw(channel, (int)Math.Round(millivolts / (ReferenceVoltage * 1000.0) * 4095.0));
        }

        // F4 STM32_ADC-style entry point (raw counts; repeat ignored, values are always held).
        // ProfetLoadBank finds it by reflection: FeedSample(uint raw, uint channel, int repeat).
        public void FeedSample(uint raw, uint channel, int repeat = -1)
        {
            SetRaw((int)channel, (int)raw);
        }

        public void SetADCValue(int channel, uint valueMicroVolts)
        {
            SetMillivolts(channel, valueMicroVolts / 1000.0);
        }

        public int GetRaw(int channel)
        {
            CheckChannel(channel);
            return values[channel];
        }

        public uint ReadDoubleWord(long offset)
        {
            var idx = Index(offset);
            if(idx < 0)
            {
                return 0;
            }
            switch((Reg)offset)
            {
            case Reg.CR:
                var v = regs[idx] & ~(CR_ADEN | CR_ADDIS | CR_ADSTART | CR_ADSTP | CR_ADCAL);
                if(enabled) { v |= CR_ADEN; }
                if(running) { v |= CR_ADSTART; }
                return v;
            case Reg.DR:
                regs[(int)Reg.ISR / 4] &= ~ISR_EOC;
                UpdateIrq();
                return regs[idx] & 0xFFFF;
            default:
                return regs[idx];
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            var idx = Index(offset);
            if(idx < 0)
            {
                return;
            }
            switch((Reg)offset)
            {
            case Reg.ISR:
                regs[idx] &= ~value;   // write 1 to clear
                UpdateIrq();
                return;
            case Reg.IER:
                regs[idx] = value;
                UpdateIrq();
                return;
            case Reg.CR:
                regs[idx] = value & ~(CR_ADCAL | CR_ADSTART | CR_ADSTP | CR_ADDIS);
                if((value & CR_ADDIS) != 0)
                {
                    enabled = false;
                    Stop();
                }
                else if((value & CR_ADEN) != 0 && !enabled)
                {
                    enabled = true;
                    regs[(int)Reg.ISR / 4] |= ISR_ADRDY;
                    UpdateIrq();
                }
                if((value & CR_ADSTP) != 0)
                {
                    Stop();
                }
                else if((value & CR_ADSTART) != 0 && enabled && !running)
                {
                    Start();
                }
                return;
            case Reg.DR:
                return;
            default:
                regs[idx] = value;
                return;
            }
        }

        public ushort ReadWord(long offset) => (ushort)(ReadDoubleWord(offset & ~3L) >> (int)((offset & 2) * 8));

        public void WriteWord(long offset, ushort value)
        {
            var aligned = offset & ~3L;
            var shift = (int)((offset & 2) * 8);
            var idx = Index(aligned);
            if(idx < 0)
            {
                return;
            }
            var cur = (Reg)aligned == Reg.ISR ? 0u : regs[idx];
            WriteDoubleWord(aligned, (cur & ~(0xFFFFu << shift)) | ((uint)value << shift));
        }

        private void Start()
        {
            running = true;
            if((regs[(int)Reg.CFGR / 4] & CFGR_CONT) != 0)
            {
                sweepTimer.Value = 0;
                sweepTimer.Enabled = true;
            }
            // first sweep right away (single mode: the only one)
            Sweep();
        }

        private void Stop()
        {
            running = false;
            sweepTimer.Enabled = false;
        }

        private void Sweep()
        {
            if(!running || !enabled)
            {
                return;
            }
            var sqr = new[] { regs[(int)Reg.SQR1 / 4], regs[(int)Reg.SQR2 / 4], regs[(int)Reg.SQR3 / 4], regs[(int)Reg.SQR4 / 4] };
            var length = (int)(sqr[0] & 0xF) + 1;
            var cfgr = regs[(int)Reg.CFGR / 4];
            var resBits = 12 - 2 * (int)((cfgr >> 3) & 3);
            var leftAlign = (cfgr & (1u << 5)) != 0;
            for(var n = 1; n <= length; n++)
            {
                // SQ1..SQ4 in SQR1 (bits 6+6k), SQ5..SQ9 SQR2, SQ10..SQ14 SQR3, SQ15..SQ16 SQR4 (bits 6k)
                int reg, pos;
                if(n <= 4) { reg = 0; pos = 6 * n; }
                else { reg = n / 5; pos = 6 * ((n - 5) % 5); }
                var ch = (int)((sqr[reg] >> pos) & 0x1F);
                var raw = ch < values.Length ? (uint)values[ch] : 0u;
                raw >>= 12 - resBits;
                if(leftAlign) { raw <<= 16 - resBits; }
                regs[(int)Reg.DR / 4] = raw;
                regs[(int)Reg.ISR / 4] |= ISR_EOSMP | ISR_EOC;
                Conversions++;
                if((cfgr & CFGR_DMAEN) != 0)
                {
                    DMARequest.Blink();
                }
            }
            regs[(int)Reg.ISR / 4] |= ISR_EOS;
            if((cfgr & CFGR_CONT) == 0)
            {
                Stop();
            }
            UpdateIrq();
        }

        private void UpdateIrq()
        {
            IRQ.Set((regs[(int)Reg.ISR / 4] & regs[(int)Reg.IER / 4] & 0x7FF) != 0);
        }

        private int Index(long offset)
        {
            if(offset < 0 || offset >= Size || (offset & 3) != 0)
            {
                this.Log(LogLevel.Warning, "Unaligned/out of range access at 0x{0:X}", offset);
                return -1;
            }
            return (int)(offset / 4);
        }

        private void CheckChannel(int channel)
        {
            if(channel < 0 || channel >= values.Length)
            {
                throw new Exceptions.RecoverableException($"channel {channel} out of range 0..{values.Length - 1}");
            }
        }

        private readonly uint[] regs = new uint[0x40];
        private readonly ushort[] values = new ushort[19];
        private readonly LimitTimer sweepTimer;
        private bool enabled;
        private bool running;

        private const uint ISR_ADRDY = 1u << 0;
        private const uint ISR_EOSMP = 1u << 1;
        private const uint ISR_EOC = 1u << 2;
        private const uint ISR_EOS = 1u << 3;
        private const uint CR_ADEN = 1u << 0;
        private const uint CR_ADDIS = 1u << 1;
        private const uint CR_ADSTART = 1u << 2;
        private const uint CR_ADSTP = 1u << 4;
        private const uint CR_ADCAL = 1u << 31;
        private const uint CFGR_DMAEN = 1u << 0;
        private const uint CFGR_CONT = 1u << 13;

        private enum Reg
        {
            ISR = 0x00,
            IER = 0x04,
            CR = 0x08,
            CFGR = 0x0C,
            SQR1 = 0x30,
            SQR2 = 0x34,
            SQR3 = 0x38,
            SQR4 = 0x3C,
            DR = 0x40,
        }
    }
}
