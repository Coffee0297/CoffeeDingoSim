//
// STM32F3_FlashController — FLASHv1 interface of the STM32F0/F1/F3 (RM0316 §4.5) for CoffeeDingoSim,
// with the CANBoard's config sector backed by a file.
//
// Registers: ACR 0x00, KEYR 0x04, OPTKEYR 0x08, SR 0x0C, CR 0x10, AR 0x14, OBR 0x1C, WRPR 0x20.
//   - unlock: KEYR <- 0x45670123, 0xCDEF89AB (a wrong key locks until reset); CR.LOCK relocks
//   - page erase: CR.PER, AR = address, CR.STRT -> the 2 KB page is filled with 0xFF, SR.EOP latched
//   - program: CR.PG set, the CPU writes half-words straight into the flash MappedMemory (Renode
//     cannot trap writes to executable memory), SR.EOP reads 1 while PG is set
//   - SR.BSY always 0, PGERR/WRPRTERR never raised; EOP/PGERR/WRPRTERR are write-1-to-clear
// This is exactly what ChibiOS' STM32F3xx/hal_efl_lld.c needs (flashStartEraseSector / flashProgram).
//
// Persistence: `Filename` names an image of the persisted region (default the config sector,
// 0x0800F800 .. +2 KB). Setting it loads the file if it exists, else fills the region with 0xFF
// (erased). The region is saved after every page erase, when CR.PG goes 1 -> 0 and on CR.LOCK;
// `Save` / `Load` do it by hand. The region is re-applied after a machine reset.
//
//   flash_controller: MTD.STM32F3_FlashController @ sysbus 0x40022000
//       flash: flash
//   sysbus.flash_controller Filename @scenes/x/nv/CB-1.bin
//
using System;
using System.IO;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure.Registers;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Memory;

namespace Antmicro.Renode.Peripherals.MTD
{
    public class STM32F3_FlashController : BasicDoubleWordPeripheral, IKnownSize
    {
        public STM32F3_FlashController(IMachine machine, MappedMemory flash, long persistOffset = 0xF800,
                                       int persistSize = 0x800, int pageSize = 0x800) : base(machine)
        {
            this.flash = flash;
            PersistOffset = persistOffset;
            PersistSize = persistSize;
            this.pageSize = pageSize;
            DefineRegisters();
            Reset();
        }

        public override void Reset()
        {
            base.Reset();
            locked = true;
            keyIndex = 0;
            keyDisabled = false;
            eop = false;
            // memories may be reset/reloaded after us: re-apply the image once the machine runs again
            if(!string.IsNullOrEmpty(filename))
            {
                machine.LocalTimeSource.ExecuteInNearestSyncedState(_ => Load());
                Load();
            }
        }

        public long Size => 0x400;

        public long PersistOffset { get; set; }
        public int PersistSize { get; set; }

        public string Filename
        {
            get => filename;
            set
            {
                filename = value;
                if(string.IsNullOrEmpty(filename))
                {
                    return;
                }
                if(File.Exists(filename))
                {
                    Load();
                }
                else
                {
                    var erased = new byte[PersistSize];
                    for(var i = 0; i < erased.Length; i++) { erased[i] = 0xFF; }
                    flash.WriteBytes(PersistOffset, erased, 0, erased.Length);
                    this.Log(LogLevel.Info, "{0} does not exist yet; config region erased (0xFF)", filename);
                }
            }
        }

        public void Save()
        {
            if(string.IsNullOrEmpty(filename))
            {
                return;
            }
            var dir = Path.GetDirectoryName(Path.GetFullPath(filename));
            if(!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllBytes(filename, flash.ReadBytes(PersistOffset, PersistSize));
            this.Log(LogLevel.Debug, "Saved 0x{0:X} bytes at flash+0x{1:X} to {2}", PersistSize, PersistOffset, filename);
        }

        public void Load()
        {
            if(string.IsNullOrEmpty(filename) || !File.Exists(filename))
            {
                return;
            }
            var bytes = File.ReadAllBytes(filename);
            var n = Math.Min(bytes.Length, PersistSize);
            flash.WriteBytes(PersistOffset, bytes, 0, n);
            this.Log(LogLevel.Debug, "Loaded {0} bytes from {1} to flash+0x{2:X}", n, filename, PersistOffset);
        }

        private void DefineRegisters()
        {
            Registers.AccessControl.Define(this, 0x30)
                .WithValueField(0, 32, name: "ACR");

            Registers.Key.Define(this)
                .WithValueField(0, 32, FieldMode.Write, writeCallback: (_, v) => ConsumeKey((uint)v), name: "FKEYR");

            Registers.OptionKey.Define(this)
                .WithValueField(0, 32, FieldMode.Write, name: "OPTKEYR");

            Registers.Status.Define(this)
                .WithFlag(0, FieldMode.Read, valueProviderCallback: _ => false, name: "BSY")
                .WithReservedBits(1, 1)
                .WithFlag(2, FieldMode.Read | FieldMode.WriteOneToClear, name: "PGERR")
                .WithReservedBits(3, 1)
                .WithFlag(4, FieldMode.Read | FieldMode.WriteOneToClear, name: "WRPRTERR")
                .WithFlag(5, valueProviderCallback: _ => eop || program.Value,
                          writeCallback: (_, v) => { if(v) { eop = false; } }, name: "EOP")
                .WithReservedBits(6, 26);

            Registers.Control.Define(this, 0x80)
                .WithFlag(0, out program, name: "PG")
                .WithFlag(1, out pageErase, name: "PER")
                .WithFlag(2, out massErase, name: "MER")
                .WithReservedBits(3, 1)
                .WithFlag(4, name: "OPTPG")
                .WithFlag(5, name: "OPTER")
                .WithFlag(6, valueProviderCallback: _ => false, name: "STRT")   // operations complete instantly
                .WithFlag(7, valueProviderCallback: _ => locked, writeCallback: (_, v) => { if(v) { Relock(); } }, name: "LOCK")
                .WithReservedBits(8, 1)
                .WithFlag(9, name: "OPTWRE")
                .WithFlag(10, name: "ERRIE")
                .WithReservedBits(11, 1)
                .WithFlag(12, name: "EOPIE")
                .WithFlag(13, name: "OBL_LAUNCH")
                .WithReservedBits(14, 18)
                .WithWriteCallback((oldValue, newValue) => OnControl((uint)oldValue, (uint)newValue));

            Registers.Address.Define(this)
                .WithValueField(0, 32, out address, name: "FAR");

            Registers.OptionByte.Define(this, 0x00FF00FF)   // RDP level 0, user bytes default
                .WithValueField(0, 32, FieldMode.Read, name: "OBR");

            Registers.WriteProtection.Define(this, 0xFFFFFFFF)
                .WithValueField(0, 32, FieldMode.Read, name: "WRPR");
        }

        private void ConsumeKey(uint value)
        {
            if(keyDisabled)
            {
                return;
            }
            if(keyIndex < Keys.Length && Keys[keyIndex] == value)
            {
                if(++keyIndex == Keys.Length)
                {
                    locked = false;
                    keyIndex = 0;
                    this.Log(LogLevel.Debug, "Flash unlocked");
                }
                return;
            }
            this.Log(LogLevel.Warning, "Wrong flash key 0x{0:X8}; locked until reset", value);
            keyDisabled = true;
            Relock();
        }

        private void Relock()
        {
            if(!locked)
            {
                locked = true;
                keyIndex = 0;
                Save();
            }
        }

        private void OnControl(uint oldValue, uint newValue)
        {
            if(locked && (newValue & 0x47) != 0)
            {
                // hardware ignores CR writes while locked; the model only warns
                this.Log(LogLevel.Warning, "CR write 0x{0:X} while flash is locked", newValue);
            }
            if((oldValue & 1) != 0 && (newValue & 1) == 0)
            {
                Save();   // end of a program sequence
            }
            if((newValue & (1 << 6)) != 0)
            {
                // STRT
                if(pageErase.Value)
                {
                    var off = (long)(address.Value - FlashBase) & ~(long)(pageSize - 1);
                    if(off >= 0 && off + pageSize <= flash.Size)
                    {
                        Fill(off, pageSize);
                        this.Log(LogLevel.Debug, "Erased page at 0x{0:X8}", FlashBase + (ulong)off);
                    }
                    else
                    {
                        this.Log(LogLevel.Warning, "Page erase address 0x{0:X8} outside flash", address.Value);
                    }
                }
                else if(massErase.Value)
                {
                    Fill(0, (int)flash.Size);
                    this.Log(LogLevel.Warning, "Mass erase: the whole flash (including the app) is now 0xFF");
                }
                eop = true;
                Save();
            }
        }

        private void Fill(long offset, int size)
        {
            var erased = new byte[size];
            for(var i = 0; i < size; i++) { erased[i] = 0xFF; }
            flash.WriteBytes(offset, erased, 0, size);
        }

        private readonly MappedMemory flash;
        private readonly int pageSize;
        private string filename;
        private bool locked;
        private bool keyDisabled;
        private int keyIndex;
        private bool eop;
        private IFlagRegisterField program;
        private IFlagRegisterField pageErase;
        private IFlagRegisterField massErase;
        private IValueRegisterField address;

        private const ulong FlashBase = 0x08000000;
        private static readonly uint[] Keys = { 0x45670123, 0xCDEF89AB };

        private enum Registers
        {
            AccessControl = 0x00,
            Key = 0x04,
            OptionKey = 0x08,
            Status = 0x0C,
            Control = 0x10,
            Address = 0x14,
            OptionByte = 0x1C,
            WriteProtection = 0x20,
        }
    }
}
