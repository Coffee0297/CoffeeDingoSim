# Test helpers: `include @renode/test/canhelp.py`, then
#   can_inject sysbus.can1 0xDF 1F00000000000000      deliver a frame straight to a controller
from Antmicro.Renode.Core.CAN import CANMessageFrame
import System

def mc_can_inject(dev, can_id, hexdata):
    data = System.Array[System.Byte]([int(hexdata[i:i + 2], 16) for i in range(0, len(hexdata), 2)])
    dev.OnFrameReceived(CANMessageFrame(int(str(can_id), 0), data))
    print("injected 0x%X %s" % (int(str(can_id), 0), hexdata))
