//
// STM32F4_I2C_DMA — master-only STM32 I2Cv1 (F1/F2/F4) model with DMA, written for ChibiOS's
// I2Cv1 driver (os/hal/ports/STM32/LLD/I2Cv1/hal_i2c_lld.c), which moves every data byte by DMA:
//
//   START -> EV5 (SB)            ISR writes the address to DR
//   EV6 TRA (ADDR|TXE)           ISR enables the TX DMA stream; DMA writes all bytes to DR
//   TX DMA complete              ISR sets ITEVTEN -> EV8_2 (BTF|TXE)
//   EV8_2                        reads DR, then either repeated START (read-after-write) or STOP
//   EV6 REC (ADDR)               ISR enables the RX DMA stream; bytes arrive with RxNE + RxDMARequest
//   RX DMA complete              ISR sets STOP
//
// Differences from Renode's STM32F1_I2C that matter here: ADDR is cleared by SR1-then-SR2 (the
// ChibiOS ISR reads SR2 first, so clearing on any SR2 read loses the EV6 match), RxNE is not
// raised before ADDR is cleared (clock stretching), a DR read outside a receive does not fake
// RxNE, STOP after a receive ends the transaction with FinishTransmission, and RxNE drives the
// RX DMA request. TX DMA (memory-to-peripheral) is executed by the DMA model at enable time.
//
// repl:  i2c1: I2C.STM32F4_I2C_DMA @ sysbus 0x40005400
//            EventInterrupt -> nvic@31
//            ErrorInterrupt -> nvic@32
//            RxDMARequest -> dma1@0
//        fram: I2C.Mb85rc256 @ i2c1 0x50
//
using System;
using System.Collections.Generic;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.I2C
{
    public class STM32F4_I2C_DMA : SimpleContainer<II2CPeripheral>, IDoubleWordPeripheral, IWordPeripheral, IBytePeripheral, IKnownSize
    {
        public STM32F4_I2C_DMA(IMachine machine) : base(machine)
        {
            machine.ClockSource.AddClockEntry(new ClockEntry(
                period: 1,
                frequency: ByteRateHz,
                handler: OnByteTime,
                owner: this,
                localName: "i2c-byte",
                enabled: false,
                workMode: WorkMode.OneShot
            ));
            Reset();
        }

        public override void Reset()
        {
            cr1 = 0; cr2 = 0; oar1 = 0; oar2 = 0; ccr = 0; trise = 2;
            ResetTransfer();
            ScheduleByte(false);
        }

        public long Size => 0x400;

        public GPIO EventInterrupt { get; } = new GPIO();
        public GPIO ErrorInterrupt { get; } = new GPIO();
        public GPIO RxDMARequest { get; } = new GPIO();
        public GPIO TxDMARequest { get; } = new GPIO();

        // Debugging aid: number of completed transactions (STOP seen).
        public ulong Transactions { get; private set; }

        public byte ReadByte(long offset) => (byte)ReadDoubleWord(offset);   // DMA moves DR as bytes
        public void WriteByte(long offset, byte value) => WriteDoubleWord(offset, value);
        public ushort ReadWord(long offset) => (ushort)ReadDoubleWord(offset);
        public void WriteWord(long offset, ushort value) => WriteDoubleWord(offset, value);

        public uint ReadDoubleWord(long offset)
        {
            lock(sync)
            {
                switch(offset)
                {
                case 0x00: return cr1;
                case 0x04: return cr2;
                case 0x08: return oar1;
                case 0x0C: return oar2;
                case 0x10: return ReadData();
                case 0x14:
                    sr1ReadSinceAddr = true;
                    return Sr1();
                case 0x18:
                    {
                        var v = Sr2();
                        if(addr && sr1ReadSinceAddr)
                        {
                            addr = false;
                            sr1ReadSinceAddr = false;
                            OnAddrCleared();
                        }
                        return v;
                    }
                case 0x1C: return ccr;
                case 0x20: return trise;
                default:
                    this.Log(LogLevel.Warning, "Read from unknown offset 0x{0:X}", offset);
                    return 0;
                }
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            lock(sync)
            {
                switch(offset)
                {
                case 0x00: WriteCr1(value); break;
                case 0x04:
                    cr2 = value & 0x1FFF;
                    UpdateInterrupts();
                    break;
                case 0x08: oar1 = value; break;
                case 0x0C: oar2 = value; break;
                case 0x10: WriteData((byte)value); break;
                case 0x14:
                    // rc_w0 error flags; only AF is modelled
                    if((value & Sr1Af) == 0) af = false;
                    break;
                case 0x1C: ccr = value; break;
                case 0x20: trise = value; break;
                default:
                    this.Log(LogLevel.Warning, "Write 0x{0:X} to unknown offset 0x{1:X}", value, offset);
                    break;
                }
            }
        }

        // ---- control -------------------------------------------------------------------------

        private void WriteCr1(uint value)
        {
            if((value & Cr1Swrst) != 0)
            {
                cr1 = value & Cr1Swrst;
                ResetTransfer();
                return;
            }
            var start = (value & Cr1Start) != 0;
            var stop = (value & Cr1Stop) != 0;
            cr1 = value & ~(Cr1Start | Cr1Stop);   // START/STOP self-clear immediately in this model

            if(stop)
            {
                DoStop();
            }
            if(start)
            {
                DoStart();
            }
            UpdateInterrupts();
        }

        private void DoStart()
        {
            if(state == State.Transmit && txBuffer.Count > 0)
            {
                // repeated start: hand the bytes written so far to the target, keep the transaction open
                child?.Write(txBuffer.ToArray());
                txBuffer.Clear();
            }
            ScheduleByte(false);
            sb = true; addr = false; btf = false; rxne = false; txe = false;
            msl = true; busy = true; tra = false;
            state = State.Address;
        }

        private void DoStop()
        {
            ScheduleByte(false);
            if(state == State.Transmit && txBuffer.Count > 0)
            {
                child?.Write(txBuffer.ToArray());
            }
            if(state != State.Idle)
            {
                child?.FinishTransmission();
                Transactions++;
            }
            ResetTransfer();
        }

        private void ResetTransfer()
        {
            txBuffer.Clear();
            state = State.Idle;
            sb = addr = btf = rxne = txe = false;
            msl = busy = tra = false;
            sr1ReadSinceAddr = false;
            child = null;
        }

        // ---- data ----------------------------------------------------------------------------

        private void WriteData(byte value)
        {
            switch(state)
            {
            case State.Address:
                {
                    sb = false;
                    var target = value >> 1;
                    var read = (value & 1) != 0;
                    if(!TryGetByAddress(target, out child))
                    {
                        this.Log(LogLevel.Debug, "No target at 0x{0:X2}, NACK", target);
                        child = null;
                        af = true;
                        state = State.Nack;
                        UpdateInterrupts();
                        return;
                    }
                    addr = true;
                    sr1ReadSinceAddr = false;
                    tra = !read;
                    if(read)
                    {
                        state = State.ReceiveWaitAddr;
                    }
                    else
                    {
                        state = State.Transmit;
                        txe = true;
                    }
                    UpdateInterrupts();
                    break;
                }
            case State.Transmit:
                txBuffer.Add(value);
                txe = false;
                btf = false;
                ScheduleByte(true);   // TXE/BTF come back one byte time after the last write
                break;
            default:
                this.Log(LogLevel.Debug, "DR write 0x{0:X2} in state {1}, ignored", value, state);
                break;
            }
        }

        private uint ReadData()
        {
            if(state == State.Receive && rxne)
            {
                var v = rxByte;
                rxne = false;
                btf = false;
                ScheduleByte(true);   // next byte (the target keeps sending until STOP)
                return v;
            }
            // e.g. EV8_2 "(void)dp->DR" to clear BTF
            btf = false;
            return 0;
        }

        private void OnAddrCleared()
        {
            if(state == State.ReceiveWaitAddr)
            {
                state = State.Receive;
                ScheduleByte(true);
            }
            else if(state == State.Transmit && DmaEnabled)
            {
                TxDMARequest.Blink();
            }
        }

        private void OnByteTime()
        {
            lock(sync)
            {
                switch(state)
                {
                case State.Transmit:
                    txe = true;
                    btf = true;
                    UpdateInterrupts();
                    break;
                case State.Receive:
                    if(rxne)
                    {
                        // previous byte not consumed: hardware would stretch; flag BTF
                        btf = true;
                        UpdateInterrupts();
                        break;
                    }
                    var data = child?.Read(1);
                    rxByte = (data != null && data.Length > 0) ? data[0] : (byte)0xFF;
                    rxne = true;
                    UpdateInterrupts();
                    if(DmaEnabled)
                    {
                        // the DMA stream reads DR synchronously, which schedules the next byte
                        RxDMARequest.Blink();
                    }
                    break;
                }
            }
        }

        // ---- status / interrupts --------------------------------------------------------------

        private uint Sr1()
        {
            uint v = 0;
            if(sb) v |= 1u << 0;
            if(addr) v |= 1u << 1;
            if(btf) v |= 1u << 2;
            if(rxne) v |= 1u << 6;
            if(txe) v |= 1u << 7;
            if(af) v |= Sr1Af;
            return v;
        }

        private uint Sr2()
        {
            uint v = 0;
            if(msl) v |= 1u << 0;
            if(busy) v |= 1u << 1;
            if(tra) v |= 1u << 2;
            return v;
        }

        private bool DmaEnabled => (cr2 & (1u << 11)) != 0;

        private void UpdateInterrupts()
        {
            var iterr = (cr2 & (1u << 8)) != 0;
            var itevt = (cr2 & (1u << 9)) != 0;
            var itbuf = (cr2 & (1u << 10)) != 0;
            var evt = sb || addr || btf || (itbuf && (txe || rxne));
            if(itevt && evt)
            {
                EventInterrupt.Blink();
            }
            if(iterr && af)
            {
                ErrorInterrupt.Blink();
            }
        }

        private void ScheduleByte(bool enable)
        {
            if(machine.SystemBus.TryGetCurrentCPU(out var cpu))
            {
                cpu.SyncTime();
            }
            machine.ClockSource.ExchangeClockEntryWith(OnByteTime,
                entry => entry.With(enabled: enable, value: 0));
        }

        private enum State { Idle, Address, Transmit, ReceiveWaitAddr, Receive, Nack }

        private const ulong ByteRateHz = 40000;   // ~400 kHz bus, 10 clocks per byte
        private const uint Cr1Start = 1u << 8;
        private const uint Cr1Stop = 1u << 9;
        private const uint Cr1Swrst = 1u << 15;
        private const uint Sr1Af = 1u << 10;

        private readonly object sync = new object();
        private readonly List<byte> txBuffer = new List<byte>();
        private II2CPeripheral child;
        private State state;
        private uint cr1, cr2, oar1, oar2, ccr, trise;
        private bool sb, addr, btf, rxne, txe, af, msl, busy, tra;
        private bool sr1ReadSinceAddr;
        private byte rxByte;
    }
}
