//
// PacedCANHub — a CAN hub that delivers frames to each attached controller one at a time, no faster than
// the wire carries them. Drop-in for `emulation CreateCANHub`:
//
//   coffeesim_load "<anchor>" "PacedCANHub.cs"
//   emulation CreatePacedCANHub "vehicle"          (optional 2nd argument: bitrate, default 500000)
//   connector Connect sysbus.can1 vehicle
//   vehicle Stats                                   (per-port delivered / queued / peak queue)
//
// Why: Renode's CANHub hands a frame to every other machine at the sender's timestamp, and a machine
// that is ahead in time only sees it at the next quantum sync. The simulated modules also boot in
// lockstep, so their cyclic messages go out at the same instants. A receiver then gets a whole burst at
// one virtual instant and its 3-deep bxCAN FIFO overflows: ~8 % of the frames a CANBoard was sent were
// lost whatever the send rate. On a real bus arbitration serialises those frames one frame time apart.
// Here each receiver has its own queue, drained by a clock entry on its own machine at one frame per
// frame time.
//
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.CAN;
using Antmicro.Renode.Exceptions;
using Antmicro.Renode.Peripherals;
using Antmicro.Renode.Peripherals.CAN;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Tools.Network
{
    public static class PacedCANHubExtensions
    {
        public static void CreatePacedCANHub(this Emulation emulation, string name, int bitrate = 500000)
        {
            emulation.ExternalsManager.AddExternal(new PacedCANHub(bitrate), name);
        }
    }

    public class PacedCANHub : IExternal, IConnectable<ICAN>
    {
        public PacedCANHub(int bitrate)
        {
            if(bitrate <= 0)
            {
                throw new ConstructionException("bitrate must be positive");
            }
            // one full 8-byte standard data frame: 47 + 64 bits + ~10 % stuffing = 122 bit times
            // ponytail: every frame is paced as an 8-byte one; shorter frames would fit tighter on a real bus
            deliveryHz = (ulong)Math.Max(1, bitrate / 122);
        }

        public void AttachTo(ICAN iface)
        {
            if(!EmulationManager.Instance.CurrentEmulation.TryGetMachineForPeripheral(iface, out var machine))
            {
                throw new RecoverableException("PacedCANHub: the CAN controller is not part of any machine");
            }
            lock(sync)
            {
                if(ports.ContainsKey(iface))
                {
                    return;
                }
                var port = new Port(this, iface, machine);
                ports.Add(iface, port);
                iface.FrameSent += port.OnSent;
                machine.ClockSource.AddClockEntry(new ClockEntry(period: 1, frequency: deliveryHz, handler: port.DeliverOne,
                    owner: iface, localName: "can-pace", enabled: true, workMode: WorkMode.Periodic));
            }
        }

        public void DetachFrom(ICAN iface)
        {
            lock(sync)
            {
                if(ports.TryGetValue(iface, out var port))
                {
                    iface.FrameSent -= port.OnSent;
                    port.Machine.ClockSource.TryRemoveClockEntry(port.DeliverOne);
                    ports.Remove(iface);
                }
            }
        }

        // Diagnostics: per-port sent/delivered counts of frames with this standard id (-1 = off). `vehicle WatchId 0x661`
        public int WatchId { get; set; } = -1;

        public string Stats
        {
            get
            {
                var sb = new StringBuilder();
                lock(sync)
                {
                    foreach(var p in ports.Values)
                    {
                        sb.AppendLine(p.ToString());
                    }
                }
                return sb.ToString();
            }
        }

        private void Transmit(Port from, CANMessageFrame frame)
        {
            Port[] targets;
            lock(sync)
            {
                targets = ports.Values.Where(p => p != from).ToArray();
            }
            var now = TimeDomainsManager.Instance.VirtualTimeStamp;
            foreach(var t in targets)
            {
                t.Machine.HandleTimeDomainEvent<CANMessageFrame>(t.Enqueue, frame, now, null);
            }
        }

        private readonly ulong deliveryHz;
        private readonly object sync = new object();
        private readonly Dictionary<ICAN, Port> ports = new Dictionary<ICAN, Port>();

        private class Port
        {
            public Port(PacedCANHub hub, ICAN iface, IMachine machine)
            {
                this.hub = hub;
                Iface = iface;
                Machine = machine;
                machine.TryGetAnyName(iface, out var periph);
                EmulationManager.Instance.CurrentEmulation.TryGetMachineName(machine, out var mach);
                name = $"{mach}:{periph}";
            }

            public ICAN Iface { get; }
            public IMachine Machine { get; }

            public void OnSent(CANMessageFrame frame)
            {
                sent++;
                if(frame.Id == hub.WatchId)
                {
                    sentWatched++;
                }
                hub.Transmit(this, frame);
            }

            // Runs in this receiver's time domain (HandleTimeDomainEvent).
            public void Enqueue(CANMessageFrame frame)
            {
                lock(queue)
                {
                    queue.Enqueue(frame);
                    peak = Math.Max(peak, queue.Count);
                }
            }

            // Clock entry on the receiver's machine: at most one frame per frame time. A frame is also held
            // while the receiver already has 2 pending in a FIFO: an idle Renode CPU is advanced to the end of
            // the quantum in one step, so all clock events of that quantum fire before its firmware runs again
            // and a 1 ms quantum would hand it ~4 frames at once (measured: ~10 % overruns at 1 ms, none at
            // 100 us). After MaxHoldTicks (~10 ms) the frame goes anyway, so a firmware that really stops
            // draining still overruns as on hardware.
            public void DeliverOne()
            {
                CANMessageFrame frame;
                lock(queue)
                {
                    if(queue.Count == 0)
                    {
                        return;
                    }
                    if(FifoPending() >= 2 && held < MaxHoldTicks)
                    {
                        held++;
                        holds++;
                        return;
                    }
                    held = 0;
                    frame = queue.Dequeue();
                }
                delivered++;
                if(frame.Id == hub.WatchId)
                {
                    deliveredWatched++;
                }
                if(FifoPending() >= 3)
                {
                    overrunAtDelivery++;
                }
                Iface.OnFrameReceived(frame);
            }

            // Frames pending in the receiving STMCAN's RX FIFOs (0 when the controller is not an STMCAN).
            private uint FifoPending()
            {
                if(fifoProbe == null)
                {
                    const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
                    try
                    {
                        // STMCAN keeps one Queue per FIFO in its private RxFifo[] (the RFR register reports
                        // Count & 3; its FifoMessagesPending field is never updated)
                        var fifos = Iface.GetType().GetField("RxFifo", any)?.GetValue(Iface) as System.Collections.ICollection[];
                        probeOk = fifos != null && fifos.Length > 0;
                        fifoProbe = probeOk ? (Func<uint>)(() => (uint)fifos.Max(q => q.Count)) : (() => 0u);
                    }
                    catch(Exception)
                    {
                        fifoProbe = () => 0u;
                    }
                }
                return fifoProbe();
            }

            public override string ToString()
            {
                lock(queue)
                {
                    return $"{name} sent {sent} delivered {delivered} queued {queue.Count} peak {peak} fifo-full {(probeOk ? overrunAtDelivery.ToString() : "n/a")} holds {holds} watched sent {sentWatched} delivered {deliveredWatched}";
                }
            }

            private readonly PacedCANHub hub;
            private readonly string name;
            private readonly Queue<CANMessageFrame> queue = new Queue<CANMessageFrame>();
            private ulong sent, delivered, overrunAtDelivery, sentWatched, deliveredWatched;
            private Func<uint> fifoProbe;
            private bool probeOk;
            private int held;
            private ulong holds;
            private const int MaxHoldTicks = 40;   // ~10 ms at 500 kbit/s
            private int peak;
        }
    }
}
