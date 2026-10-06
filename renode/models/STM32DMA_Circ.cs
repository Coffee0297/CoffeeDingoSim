//
// STM32DMA_Circ — fork of Antmicro's STM32DMA (MIT, renode-infrastructure) adding CIRC (circular) mode.
//
// Why: ChibiOS's ADC driver runs ADC1 in continuous scan mode through a circular DMA stream
// (NDTR = channels x depth, CIRC set). The upstream model stops after NDTR reaches 0, so the
// sample array in RAM freezes after the first sweep and FeedSample changes never reach the
// firmware. This fork reloads NDTR and the offset when CIRC is set (TCIF still raised per sweep).
//
// Upstream: src/Emulator/Peripherals/Peripherals/DMA/STM32DMA.cs (Copyright (c) 2010-2025 Antmicro, MIT).
//
using System.Collections.Generic;
using System.Linq;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure.Registers;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.DMA
{
    public sealed class STM32DMA_Circ : BasicDoubleWordPeripheral, IKnownSize, IGPIOReceiver, INumberedGPIOOutput
    {
        public STM32DMA_Circ(IMachine machine) : base(machine)
        {
            streams = Enumerable
                .Range(0, NrOfStreams)
                .Select(id => new Stream(this, id))
                .ToArray();

            Connections = Enumerable
                .Range(0, NrOfStreams)
                .ToDictionary(idx => idx, idx => streams[idx].IRQ);

            engine = new DmaEngine(machine.GetSystemBus(this));

            transferCompleteIrqStatus = new IFlagRegisterField[NrOfStreams];

            DefineRegisters();
            Reset();
        }

        public override void Reset()
        {
            base.Reset();
            foreach(var stream in streams)
            {
                stream.Reset();
            }
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number >= streams.Length)
            {
                this.Log(LogLevel.Warning, "Attempted to signal DMA stream {0}. Maximum value is {1}", number, streams.Length - 1);
                return;
            }
            streams[number].OnGPIO(value);
        }

        // Monitor helper: how many peripheral requests each stream has served (debugging aid).
        public string RequestCounts => string.Join(" ", streams.Select(s => s.Requests.ToString()));

        public long Size => 0x400;

        public IReadOnlyDictionary<int, IGPIO> Connections { get; }

        private void DefineRegisters()
        {
            var streamRegOffset = new int[] {0, 6, 16, 22};

            var lowInterruptStatusReg = Registers.LowInterruptStatus.Define(this)
                .WithReservedBits(12, 4)
                .WithReservedBits(28, 4);
            var highInterruptStatusReg = Registers.HighInterruptStatus.Define(this)
                .WithReservedBits(12, 4)
                .WithReservedBits(28, 4);
            var lowInterruptClearReg = Registers.LowInterruptClear.Define(this)
                .WithReservedBits(12, 4)
                .WithReservedBits(28, 4);
            var highInterruptClearReg = Registers.HighInterruptClear.Define(this)
                .WithReservedBits(12, 4)
                .WithReservedBits(28, 4);

            for(var streamIdx = 0; streamIdx < NrOfStreams / 2; streamIdx++)
            {
                var lowStreamIdx = streamIdx;
                var offset = streamRegOffset[lowStreamIdx];
                var highStreamIdx = lowStreamIdx + 4;

                lowInterruptStatusReg
                    .WithTaggedFlag($"FEIF{lowStreamIdx}", offset)
                    .WithReservedBits(offset + 1, 1)
                    .WithTaggedFlag($"DMEIF{lowStreamIdx}", offset + 2)
                    .WithTaggedFlag($"TEIF{lowStreamIdx}", offset + 3)
                    .WithTaggedFlag($"HTIF{lowStreamIdx}", offset + 4)
                    .WithFlag(offset + 5, out transferCompleteIrqStatus[lowStreamIdx], FieldMode.Read, name: $"TCIF{lowStreamIdx}");

                highInterruptStatusReg
                    .WithTaggedFlag($"FEIF{highStreamIdx}", offset)
                    .WithReservedBits(offset + 1, 1)
                    .WithTaggedFlag($"DMEIF{highStreamIdx}", offset + 2)
                    .WithTaggedFlag($"TEIF{highStreamIdx}", offset + 3)
                    .WithTaggedFlag($"HTIF{highStreamIdx}", offset + 4)
                    .WithFlag(offset + 5, out transferCompleteIrqStatus[highStreamIdx], FieldMode.Read, name: $"TCIF{highStreamIdx}");

                lowInterruptClearReg
                    .WithTaggedFlag($"CFEIF{lowStreamIdx}", offset)
                    .WithReservedBits(offset + 1, 1)
                    .WithTaggedFlag($"CDMEIF{lowStreamIdx}", offset + 2)
                    .WithTaggedFlag($"CTEIF{lowStreamIdx}", offset + 3)
                    .WithTaggedFlag($"CHTIF{lowStreamIdx}", offset + 4)
                    .WithFlag(offset + 5, FieldMode.Set, name: $"CTCIF{lowStreamIdx}",
                        writeCallback: (_, value) => ClearIrqFlagOnCondition(transferCompleteIrqStatus[lowStreamIdx], value));

                highInterruptClearReg
                    .WithTaggedFlag($"CFEIF{highStreamIdx}", offset)
                    .WithReservedBits(offset + 1, 1)
                    .WithTaggedFlag($"CDMEIF{highStreamIdx}", offset + 2)
                    .WithTaggedFlag($"CTEIF{highStreamIdx}", offset + 3)
                    .WithTaggedFlag($"CHTIF{highStreamIdx}", offset + 4)
                    .WithFlag(offset + 5, FieldMode.Set, name: $"CTCIF{highStreamIdx}",
                        writeCallback: (_, value) => ClearIrqFlagOnCondition(transferCompleteIrqStatus[highStreamIdx], value));
            }
        }

        private void ClearIrqFlagOnCondition(IFlagRegisterField flag, bool condition)
        {
            if(condition)
            {
                flag.Value = false;
                UpdateInterrupts();
            }
        }

        private void UpdateInterrupts()
        {
            for(var streamId = 0; streamId < NrOfStreams; streamId++)
            {
                var stream = streams[streamId];
                var irqValue = stream.TransferCompleteIrqEnable && transferCompleteIrqStatus[streamId].Value;
                stream.IRQ.Set(irqValue);
            }
        }

        private readonly IFlagRegisterField[] transferCompleteIrqStatus;

        private readonly DmaEngine engine;
        private readonly Stream[] streams;

        private const int NrOfStreams = 8;
        private const int StreamStep = 0x18;

        private class Stream
        {
            public Stream(STM32DMA_Circ parent, int id)
            {
                this.parent = parent;
                this.id = id;

                DefineRegisters();
                Reset();
            }

            public void Reset()
            {
                dataOffset = 0;
                reloadValue = 0;
                Requests = 0;
                IRQ.Unset();
            }

            public void OnGPIO(bool value)
            {
                if(!value)
                {
                    return;
                }

                if(!isEnabled.Value)
                {
                    // Quiet: peripherals keep requesting after the driver disabled the stream (I2C after the last byte).
                    parent.Log(LogLevel.Noisy, "Request on disabled DMA stream {0}, ignoring", id);
                    return;
                }

                // Only transfers from peripheral are using interrupt driven approach.
                // In other cases we can just transfer all data immediately.
                if(direction.Value == Direction.PeripheralToMemory)
                {
                    Requests++;
                    PerformTransfer();
                }
            }

            public IGPIO IRQ { get; } = new GPIO();

            public bool TransferCompleteIrqEnable => transferCompleteIrqEnable.Value;

            public ulong Requests { get; private set; }

            private void DefineRegisters()
            {
                var streamOffset = id * StreamStep;

                (Registers.StreamConfiguration + streamOffset).Define(parent)
                    .WithFlag(0, out isEnabled, name: "EN", writeCallback: (_, value) => HandleEnable(value))
                    .WithTaggedFlag("DMEIE", 1)
                    .WithTaggedFlag("TEIE", 2)
                    .WithTaggedFlag("HTIE", 3)
                    .WithFlag(4, out transferCompleteIrqEnable, name: "TCIE")
                    .WithTaggedFlag("PFCTRL", 5)
                    .WithEnumField(6, 2, out direction, name: "DIR")
                    .WithFlag(8, out circular, name: "CIRC")
                    .WithFlag(9, out peripheralIncrementOffset, name: "PINC")
                    .WithFlag(10, out memoryIncrementOffset, name: "MINC")
                    .WithEnumField(11, 2, out peripheralDataSize, name: "PSIZE")
                    .WithEnumField(13, 2, out memoryDataSize, name: "MSIZE")
                    .WithTaggedFlag("PINCOS", 15)
                    .WithTag("PL", 16, 2)
                    .WithTaggedFlag("DBM", 18)
                    .WithTaggedFlag("CT", 19)
                    .WithTaggedFlag("TRBUFF", 20)
                    .WithTag("PBURST", 21, 2)
                    .WithTag("MBURST", 23, 2)
                    .WithReservedBits(25, 7);

                (Registers.StreamNumberOfData + streamOffset).Define(parent)
                    .WithValueField(0, 16, out nrOfData, name: "NDT",
                        writeCallback: (_, value) => reloadValue = value)
                    .WithReservedBits(16, 16);

                (Registers.StreamPeripheralAddress + streamOffset).Define(parent)
                    .WithValueField(0, 32, out peripheralAddress, name: "PAR");

                (Registers.StreamMemory0Address + streamOffset).Define(parent)
                    .WithValueField(0, 32, out memory0Address, name: "M0A");

                (Registers.StreamMemory1Address + streamOffset).Define(parent)
                    .WithTag("M1A", 0, 32);

                (Registers.StreamFIFOControl + streamOffset).Define(parent)
                    .WithEnumField(0, 2, out fifoThreshold, name: "FTH")
                    .WithFlag(2, out directMode, name: "DMDIS")
                    .WithTag("FS", 3, 3)
                    .WithReservedBits(6, 1)
                    .WithTaggedFlag("FEIE", 7)
                    .WithReservedBits(8, 24);
            }

            private void HandleEnable(bool value)
            {
                if(value)
                {
                    // A fresh enable always starts from the beginning of the buffer.
                    dataOffset = 0;
                    if(nrOfData.Value == 0 && reloadValue != 0)
                    {
                        nrOfData.Value = reloadValue;
                    }
                }
                // Only transfers from peripheral are using interrupt driven approach.
                // In other cases we can just transfer all data immediately.
                if(value && direction.Value != Direction.PeripheralToMemory)
                {
                    PerformTransfer();
                }
            }

            private void PerformTransfer()
            {
                if(CreateRequest() is Request request)
                {
                    var dataUnitSize = direction.Value == Direction.PeripheralToMemory ?
                        PeripheralDataSizeInBytes : MemoryDataSizeInBytes;
                    var nrOfDataUnits = request.Size / dataUnitSize;

                    nrOfData.Value -= (ulong)nrOfDataUnits;
                    dataOffset += (ulong)request.Size;
                    parent.engine.IssueCopy(request);

                    if(nrOfData.Value == 0)
                    {
                        parent.transferCompleteIrqStatus[id].Value = true;
                        dataOffset = 0;
                        if(circular.Value)
                        {
                            // Circular mode: hardware reloads NDTR and wraps the memory pointer.
                            nrOfData.Value = reloadValue;
                        }
                        parent.UpdateInterrupts();
                    }
                }
                else
                {
                    parent.Log(LogLevel.Warning, "Error in DMA configuration detected on stream {0}. Ignoring transfer request.", id);
                }
            }

            private Request? CreateRequest()
            {
                if(nrOfData.Value == 0)
                {
                    parent.Log(LogLevel.Noisy, "DMA stream {0}: request with no data to send, ignoring", id);
                    return null;
                }

                if(direction.Value == Direction.Reserved)
                {
                    parent.Log(LogLevel.Warning, "Attempting to create DMA request with direction set as Reserved. Ignoring operation.");
                    return null;
                }

                ulong sourceAddress;
                TransferType sourceTransferType;
                bool sourceIncrementOffset;

                ulong destinationAddress;
                TransferType destinationTransferType;
                bool destinationIncrementOffset;

                var memoryOffset = memoryIncrementOffset.Value ? dataOffset : 0;
                var peripheralOffset = peripheralIncrementOffset.Value ? dataOffset : 0;

                if(direction.Value == Direction.MemoryToPeripheral)
                {
                    sourceAddress = memory0Address.Value + memoryOffset;
                    sourceTransferType = DataSizeToTransferType(memoryDataSize.Value);
                    sourceIncrementOffset = memoryIncrementOffset.Value;
                    destinationAddress = peripheralAddress.Value + peripheralOffset;
                    destinationTransferType = DataSizeToTransferType(peripheralDataSize.Value);
                    destinationIncrementOffset = peripheralIncrementOffset.Value;
                }
                else
                {
                    // Memory to memory transfers use peripheral address as source address.
                    // Of course the same applies to peripheral to memory transfers.
                    sourceAddress = peripheralAddress.Value + peripheralOffset;
                    sourceTransferType = DataSizeToTransferType(peripheralDataSize.Value);
                    sourceIncrementOffset = peripheralIncrementOffset.Value;
                    destinationAddress = memory0Address.Value + memoryOffset;
                    destinationTransferType = DataSizeToTransferType(memoryDataSize.Value);
                    destinationIncrementOffset = memoryIncrementOffset.Value;
                }

                return new Request(
                    sourceAddress,
                    destinationAddress,
                    GetCurrentTransferSize(),
                    sourceTransferType,
                    destinationTransferType,
                    sourceIncrementOffset,
                    destinationIncrementOffset
                );
            }

            private TransferType DataSizeToTransferType(DataSize dataSize)
            {
                switch(dataSize)
                {
                case DataSize.Byte:
                    return TransferType.Byte;
                case DataSize.HalfWord:
                    return TransferType.Word;
                case DataSize.Word:
                    return TransferType.DoubleWord;
                default:
                    parent.Log(LogLevel.Warning, "Trying to cast Reserved (0x{0:X}) DataSize to TransferType. Defaulting to Byte.", (int)dataSize);
                    return TransferType.Byte;
                }
            }

            private int GetCurrentTransferSize()
            {
                switch(direction.Value)
                {
                case Direction.MemoryToMemory:
                    return (int)nrOfData.Value * MemoryDataSizeInBytes;
                case Direction.MemoryToPeripheral:
                    return (int)nrOfData.Value * PeripheralDataSizeInBytes;
                case Direction.PeripheralToMemory:
                    // One data unit per peripheral request (direct mode); the FIFO-threshold burst of the
                    // upstream model would over-read a single-register peripheral like the ADC DR / I2C DR.
                    return PeripheralDataSizeInBytes;
                default:
                    parent.Log(LogLevel.Warning, "Trying to get transfer size for Reserved DataSize. Defaulting to 0.");
                    return 0;
                }
            }

            private int PeripheralDataSizeInBytes => 1 << (int)peripheralDataSize.Value;

            private int MemoryDataSizeInBytes => 1 << (int)memoryDataSize.Value;

            private IFlagRegisterField isEnabled;
            private IFlagRegisterField transferCompleteIrqEnable;
            private IEnumRegisterField<Direction> direction;
            private IFlagRegisterField circular;
            private IFlagRegisterField peripheralIncrementOffset;
            private IFlagRegisterField memoryIncrementOffset;
            private IEnumRegisterField<DataSize> peripheralDataSize;
            private IEnumRegisterField<DataSize> memoryDataSize;
            private IValueRegisterField nrOfData;
            private IValueRegisterField peripheralAddress;
            private IValueRegisterField memory0Address;
            private IEnumRegisterField<FIFOThreshold> fifoThreshold;
            private IFlagRegisterField directMode;

            private ulong dataOffset;
            private ulong reloadValue;

            private readonly STM32DMA_Circ parent;
            private readonly int id;

            private enum Direction
            {
                PeripheralToMemory  = 0x0,
                MemoryToPeripheral  = 0x1,
                MemoryToMemory      = 0x2,
                Reserved            = 0x3,
            }

            private enum DataSize
            {
                Byte        = 0x0,
                HalfWord    = 0x1,
                Word        = 0x2,
                Reserved    = 0x3,
            }

            private enum FIFOThreshold
            {
                OneFourth       = 0x0,
                Half            = 0x1,
                ThreeFourths    = 0x2,
                Full            = 0x3,
            }
        }

        private enum Registers
        {
            LowInterruptStatus      = 0x0,  // DMA_LISR
            HighInterruptStatus     = 0x4,  // DMA_HISR
            LowInterruptClear       = 0x8,  // DMA_LIFCR
            HighInterruptClear      = 0xC,  // DMA_HIFCR
            StreamConfiguration     = 0x10, // DMA_SxCr
            StreamNumberOfData      = 0x14, // DMA_SxNDTR
            StreamPeripheralAddress = 0x18, // DMA_SxPAR
            StreamMemory0Address    = 0x1C, // DMA_SxM0AR
            StreamMemory1Address    = 0x20, // DMA_SxM1AR
            StreamFIFOControl       = 0x24, // DMA_SxFCR
        }
    }
}
