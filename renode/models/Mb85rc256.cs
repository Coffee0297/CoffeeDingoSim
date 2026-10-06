//
// MB85RC256V / MB85RC128A I2C FRAM model for Renode (CoffeeDingoSim) with file backing.
//
// 24xx-EEPROM style protocol as used by hardware/mb85rc.cpp in the firmware: a write transaction
// is [addrHi, addrLo, data...]; a read is a write of [addrHi, addrLo] followed by a repeated-start
// read that auto-increments. No page boundaries, no write delay (FRAM).
//
// repl:
//   fram: I2C.Mb85rc256 @ i2c1 0x50
//       size: 0x8000
// monitor:
//   sysbus.fram Filename @scenes/example/nv/PDM-01.bin   (loads it if it exists; saved after every write)
//   sysbus.fram Save
//
using System;
using System.IO;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.I2C
{
    public class Mb85rc256 : II2CPeripheral
    {
        public Mb85rc256(int size = 0x8000)
        {
            memory = new byte[size];
            Reset();
        }

        public void Reset()
        {
            address = 0;
            addressPhasePending = true;
        }

        public void Write(byte[] data)
        {
            var idx = 0;
            if(addressPhasePending)
            {
                if(data.Length < 2)
                {
                    this.Log(LogLevel.Warning, "Write shorter than the 2 address bytes, ignoring");
                    return;
                }
                address = ((data[0] << 8) | data[1]) % memory.Length;
                addressPhasePending = false;
                idx = 2;
            }
            var wrote = false;
            for(; idx < data.Length; idx++)
            {
                memory[address] = data[idx];
                address = (address + 1) % memory.Length;
                wrote = true;
            }
            if(wrote)
            {
                dirty = true;
            }
        }

        public byte[] Read(int count = 1)
        {
            var result = new byte[count];
            for(var i = 0; i < count; i++)
            {
                result[i] = memory[address];
                address = (address + 1) % memory.Length;
            }
            return result;
        }

        public void FinishTransmission()
        {
            addressPhasePending = true;
            if(dirty && !string.IsNullOrEmpty(Filename))
            {
                Save();
            }
            dirty = false;
        }

        // Backing file. Setting it loads the image when the file exists (size-clamped).
        public string Filename
        {
            get => filename;
            set
            {
                filename = value;
                if(string.IsNullOrEmpty(filename) || !File.Exists(filename))
                {
                    return;
                }
                var bytes = File.ReadAllBytes(filename);
                Array.Clear(memory, 0, memory.Length);
                Array.Copy(bytes, memory, Math.Min(bytes.Length, memory.Length));
                this.Log(LogLevel.Info, "Loaded {0} bytes from {1}", Math.Min(bytes.Length, memory.Length), filename);
            }
        }

        public void Save()
        {
            if(string.IsNullOrEmpty(Filename))
            {
                this.Log(LogLevel.Warning, "No Filename set, nothing saved");
                return;
            }
            var dir = Path.GetDirectoryName(Filename);
            if(!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllBytes(Filename, memory);
            this.Log(LogLevel.Debug, "Saved {0} bytes to {1}", memory.Length, Filename);
        }

        public void Erase()
        {
            Array.Clear(memory, 0, memory.Length);
            dirty = true;
        }

        public int Size => memory.Length;

        // Debug helper: first 16 bytes as hex.
        public string Head
        {
            get
            {
                var n = Math.Min(16, memory.Length);
                var s = new System.Text.StringBuilder();
                for(var i = 0; i < n; i++)
                {
                    s.Append(memory[i].ToString("X2")).Append(' ');
                }
                return s.ToString();
            }
        }

        private readonly byte[] memory;
        private int address;
        private bool addressPhasePending;
        private bool dirty;
        private string filename;
    }
}
