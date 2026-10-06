//
// MCP9808 I2C temperature sensor model for Renode (CoffeeDingoSim).
//
// Protocol: write [reg] then read 2 bytes (16-bit big-endian); write [reg, hi, lo] for 16-bit
// registers; resolution (0x08) is an 8-bit register. The firmware (hardware/mcp9808.cpp) checks
// MANUF_ID 0x0054 / DEVICE_ID 0x0400 at boot and treats a mismatch as a fatal error, writes the
// limits and reads them back for comparison, and reads the ambient register (0x05) whose top
// three bits carry the under/over/critical flags.
//
// Monitor: `sysbus.tempSensor SetTemperature 85` (degrees C), `sysbus.tempSensor Temperature`.
//
using System;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;

namespace Antmicro.Renode.Peripherals.I2C
{
    public class MCP9808 : II2CPeripheral
    {
        public MCP9808()
        {
            Reset();
        }

        public void Reset()
        {
            registerPointer = null;
            readOffset = 0;
            config = 0;
            upper = 0;
            lower = 0;
            crit = 0;
            resolution = 3;
            // temperature is deliberately NOT reset: it is bench stimulus, not device state
        }

        public void Write(byte[] data)
        {
            if(data.Length == 0)
            {
                return;
            }
            registerPointer = data[0];
            readOffset = 0;
            if(data.Length == 1)
            {
                return;
            }
            switch(registerPointer.Value)
            {
            case 0x01:
                config = Be16(data, 1);
                break;
            case 0x02:
                upper = Be16(data, 1);
                break;
            case 0x03:
                lower = Be16(data, 1);
                break;
            case 0x04:
                crit = Be16(data, 1);
                break;
            case 0x08:
                resolution = (byte)(data[1] & 0x03);
                break;
            default:
                this.Log(LogLevel.Warning, "Write to read-only or unknown register 0x{0:X2}", registerPointer.Value);
                break;
            }
        }

        public byte[] Read(int count = 1)
        {
            if(!registerPointer.HasValue)
            {
                this.Log(LogLevel.Warning, "Read without a register pointer, returning zeros");
                return new byte[count];
            }
            byte[] src;
            switch(registerPointer.Value)
            {
            case 0x01: src = Split(config); break;
            case 0x02: src = Split(upper); break;
            case 0x03: src = Split(lower); break;
            case 0x04: src = Split(crit); break;
            case 0x05: src = Split(AmbientRegister()); break;
            case 0x06: src = Split(0x0054); break;
            case 0x07: src = Split(0x0400); break;
            case 0x08: src = new byte[] { resolution }; break;
            default:   src = new byte[] { 0, 0 }; break;
            }
            // The I2C master may fetch a register one byte per call: keep a cursor within the register.
            var result = new byte[count];
            for(var i = 0; i < count; i++, readOffset++)
            {
                result[i] = readOffset < src.Length ? src[readOffset] : (byte)0;
            }
            return result;
        }

        public void FinishTransmission()
        {
            // keep the pointer (repeated reads of the same register), restart at its first byte
            readOffset = 0;
        }

        // Bench stimulus, in degrees C. Resolution is 0.0625 C.
        public double Temperature { get; set; } = 30.0;

        public void SetTemperature(double celsius)
        {
            Temperature = celsius;
            this.Log(LogLevel.Info, "Board temperature set to {0:F2} C", celsius);
        }

        private ushort AmbientRegister()
        {
            var t = Temperature;
            var raw = (int)Math.Round(t * 16.0);
            ushort reg;
            if(raw < 0)
            {
                reg = (ushort)((raw & 0x0FFF) | 0x1000);
            }
            else
            {
                reg = (ushort)(raw & 0x0FFF);
            }
            if(t >= LimitToCelsius(crit))
            {
                reg |= 0x8000;
            }
            if(t > LimitToCelsius(upper))
            {
                reg |= 0x4000;
            }
            if(t < LimitToCelsius(lower))
            {
                reg |= 0x2000;
            }
            return reg;
        }

        private static double LimitToCelsius(ushort raw)
        {
            var v = (raw & 0x0FFF) / 16.0;
            if((raw & 0x1000) != 0)
            {
                v -= 256;
            }
            return v;
        }

        private static ushort Be16(byte[] d, int i)
        {
            var hi = i < d.Length ? d[i] : (byte)0;
            var lo = i + 1 < d.Length ? d[i + 1] : (byte)0;
            return (ushort)((hi << 8) | lo);
        }

        private static byte[] Split(int v)
        {
            return new byte[] { (byte)((v >> 8) & 0xFF), (byte)(v & 0xFF) };
        }

        private byte? registerPointer;
        private int readOffset;
        private ushort config;
        private ushort upper;
        private ushort lower;
        private ushort crit;
        private byte resolution;
    }
}
