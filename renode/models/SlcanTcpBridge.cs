//
// SlcanTcpBridge — joins a Renode CANHub as an ICAN member and exposes the bus as SLCAN text over
// TCP (CoffeeDingoSim docs/interfaces.md §6). One client at a time; a new connection replaces the old.
//
//   hub -> client : every frame as tIIILDD..\r (11-bit) / TIIIIIIIILDD..\r (29-bit), r/R for RTR
//   client -> hub : the same frame commands; O C S<n> L F Z<n> -> "\r"; V -> "V1013\r";
//                   N -> "NSIM0\r"; anything else -> "\a"
//
// Frames from the socket are queued and injected from a 1 kHz virtual-time clock entry, so they
// enter the emulation on the machine thread and in emulated time order.
//
// It is a sysbus peripheral only so it has a machine and a clock (the 4-byte window reads
// FramesSeen). Add it to any one machine:
//   machine LoadPlatformDescriptionFromString "slcanBridge: CAN.SlcanTcpBridge @ sysbus 0x5FFF0000 { port: 7777 }"
//   connector Connect sysbus.slcanBridge vehicle
//
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

using Antmicro.Renode.Core;
using Antmicro.Renode.Core.CAN;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.CAN
{
    public class SlcanTcpBridge : ICAN, IDoubleWordPeripheral, IKnownSize
    {
        public SlcanTcpBridge(IMachine machine, int port = 7777)
        {
            this.machine = machine;
            Port = port;
            machine.ClockSource.AddClockEntry(new ClockEntry(
                period: 1,
                frequency: 1000,
                handler: DrainInbound,
                owner: this,
                localName: "slcan-inject",
                enabled: true,
                workMode: WorkMode.Periodic
            ));
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "slcan-accept" };
            acceptThread.Start();
            writerThread = new Thread(WriteLoop) { IsBackground = true, Name = "slcan-writer" };
            writerThread.Start();
            this.Log(LogLevel.Info, "SLCAN bridge listening on 127.0.0.1:{0}", port);
        }

        public int Port { get; }
        public ulong FramesSeen => Interlocked.Read(ref framesSeen);      // hub -> client
        public ulong FramesInjected => Interlocked.Read(ref framesInjected); // client -> hub
        public bool ClientConnected => client != null;

        public event Action<CANMessageFrame> FrameSent;

        public void OnFrameReceived(CANMessageFrame message)
        {
            Interlocked.Increment(ref framesSeen);
            var line = Encode(message);
            this.Log(LogLevel.Debug, "hub->tcp {0}", line.TrimEnd('\r'));
            if(client != null)
            {
                outbound.TryAdd(line);   // never block the machine thread on a slow client
            }
        }

        public void Reset()
        {
            while(inbound.TryDequeue(out _)) { }
        }

        public long Size => 4;
        public uint ReadDoubleWord(long offset) => (uint)FramesSeen;
        public void WriteDoubleWord(long offset, uint value) { }

        // ---- injection (machine thread) -----------------------------------------------------

        private void DrainInbound()
        {
            while(inbound.TryDequeue(out var frame))
            {
                Interlocked.Increment(ref framesInjected);
                this.Log(LogLevel.Debug, "tcp->hub {0}", Encode(frame).TrimEnd('\r'));
                FrameSent?.Invoke(frame);
            }
        }

        // ---- sockets ------------------------------------------------------------------------

        private void AcceptLoop()
        {
            while(true)
            {
                TcpClient c;
                try
                {
                    c = listener.AcceptTcpClient();
                }
                catch(Exception e)
                {
                    this.Log(LogLevel.Warning, "accept failed: {0}", e.Message);
                    return;
                }
                c.NoDelay = true;
                var old = client;
                client = c;
                try { old?.Close(); } catch { }
                this.Log(LogLevel.Info, "SLCAN client connected from {0}", c.Client.RemoteEndPoint);
                var reader = new Thread(() => ReadLoop(c)) { IsBackground = true, Name = "slcan-reader" };
                reader.Start();
            }
        }

        private void ReadLoop(TcpClient c)
        {
            var buf = new byte[4096];
            var line = new StringBuilder();
            try
            {
                var s = c.GetStream();
                while(true)
                {
                    var n = s.Read(buf, 0, buf.Length);
                    if(n <= 0)
                    {
                        break;
                    }
                    for(var i = 0; i < n; i++)
                    {
                        var ch = (char)buf[i];
                        if(ch == '\r' || ch == '\n')
                        {
                            if(line.Length > 0)
                            {
                                HandleCommand(line.ToString());
                                line.Clear();
                            }
                        }
                        else if(line.Length < 64)
                        {
                            line.Append(ch);
                        }
                    }
                }
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Debug, "reader ended: {0}", e.Message);
            }
            if(client == c)
            {
                client = null;
                this.Log(LogLevel.Info, "SLCAN client disconnected");
            }
            try { c.Close(); } catch { }
        }

        private void WriteLoop()
        {
            foreach(var line in outbound.GetConsumingEnumerable())
            {
                var c = client;
                if(c == null)
                {
                    continue;
                }
                try
                {
                    var bytes = Encoding.ASCII.GetBytes(line);
                    c.GetStream().Write(bytes, 0, bytes.Length);
                }
                catch(Exception e)
                {
                    this.Log(LogLevel.Debug, "write failed: {0}", e.Message);
                }
            }
        }

        private void Reply(string s)
        {
            if(client != null)
            {
                outbound.TryAdd(s);
            }
        }

        private void HandleCommand(string cmd)
        {
            switch(cmd[0])
            {
            case 't':
            case 'T':
            case 'r':
            case 'R':
                if(TryDecode(cmd, out var frame))
                {
                    inbound.Enqueue(frame);
                }
                else
                {
                    Reply("\a");
                }
                break;
            case 'O':
            case 'C':
            case 'S':
            case 'L':
            case 'F':
            case 'Z':
                Reply("\r");
                break;
            case 'V':
                Reply("V1013\r");
                break;
            case 'N':
                Reply("NSIM0\r");
                break;
            default:
                Reply("\a");
                break;
            }
        }

        // ---- SLCAN text -----------------------------------------------------------------------

        private static string Encode(CANMessageFrame f)
        {
            var sb = new StringBuilder(32);
            var data = f.Data ?? new byte[0];
            var dlc = Math.Min(data.Length, 8);
            if(f.ExtendedFormat)
            {
                sb.Append(f.RemoteFrame ? 'R' : 'T');
                sb.Append(f.Id.ToString("X8"));
            }
            else
            {
                sb.Append(f.RemoteFrame ? 'r' : 't');
                sb.Append((f.Id & 0x7FF).ToString("X3"));
            }
            sb.Append(dlc.ToString("X1"));
            if(!f.RemoteFrame)
            {
                for(var i = 0; i < dlc; i++)
                {
                    sb.Append(data[i].ToString("X2"));
                }
            }
            sb.Append('\r');
            return sb.ToString();
        }

        private static bool TryDecode(string s, out CANMessageFrame frame)
        {
            frame = null;
            var ext = s[0] == 'T' || s[0] == 'R';
            var rtr = s[0] == 'r' || s[0] == 'R';
            var idLen = ext ? 8 : 3;
            if(s.Length < 1 + idLen + 1)
            {
                return false;
            }
            try
            {
                var id = Convert.ToUInt32(s.Substring(1, idLen), 16);
                var dlc = Convert.ToInt32(s.Substring(1 + idLen, 1), 16);
                if(dlc > 8)
                {
                    return false;
                }
                var data = new byte[rtr ? 0 : dlc];
                if(!rtr)
                {
                    if(s.Length < 2 + idLen + dlc * 2)
                    {
                        return false;
                    }
                    for(var i = 0; i < dlc; i++)
                    {
                        data[i] = Convert.ToByte(s.Substring(2 + idLen + i * 2, 2), 16);
                    }
                }
                frame = new CANMessageFrame(id, data, extendedFormat: ext, remoteFrame: rtr);
                return true;
            }
            catch(FormatException)
            {
                return false;
            }
        }

        private readonly IMachine machine;
        private readonly TcpListener listener;
        private readonly Thread acceptThread;
        private readonly Thread writerThread;
        private readonly ConcurrentQueue<CANMessageFrame> inbound = new ConcurrentQueue<CANMessageFrame>();
        private readonly BlockingCollection<string> outbound = new BlockingCollection<string>(new ConcurrentQueue<string>(), 100000);
        private volatile TcpClient client;
        private ulong framesSeen;
        private ulong framesInjected;
    }
}
