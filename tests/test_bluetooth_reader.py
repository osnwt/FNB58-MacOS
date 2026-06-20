import struct
import unittest

from device.bluetooth_reader import BluetoothReader


def make_frame(packet_type, payload):
    frame = bytes([0xAA, packet_type, len(payload), *payload])
    checksum = BluetoothReader._crc8_from_xmodem(frame)
    return frame + bytes([checksum])


class BluetoothReaderParsingTests(unittest.TestCase):
    def test_parses_firmware_115_framed_stream_across_split_notifications(self):
        reader = BluetoothReader()

        temp_payload = bytes([0, 0, 0, 0, 1]) + struct.pack('<H', 235)
        dpdn_payload = struct.pack('<HHH', 600, 2100, 0)
        group_payload = struct.pack('<BIIII', 1, 12345, 23456, 789, 4567)
        bus_payload = struct.pack('<HH', 5000, 1234)

        stream = b''.join([
            make_frame(0x05, temp_payload),
            make_frame(0x06, dpdn_payload),
            make_frame(0x08, group_payload),
            make_frame(0x07, bus_payload),
        ])

        split_at = 11
        self.assertEqual(reader._parse_data(stream[:split_at]), [])

        readings = reader._parse_data(stream[split_at:])
        self.assertEqual(len(readings), 1)

        reading = readings[0]
        self.assertEqual(reading['voltage'], 5.0)
        self.assertEqual(reading['current'], 1.234)
        self.assertEqual(reading['power'], 6.17)
        self.assertEqual(reading['temperature'], 23.5)
        self.assertEqual(reading['dp'], 0.6)
        self.assertEqual(reading['dn'], 2.1)
        self.assertEqual(reading['energy_wh'], 0.12345)
        self.assertEqual(reading['capacity_ah'], 0.23456)
        self.assertEqual(reading['record_seconds'], 789)
        self.assertEqual(reading['power_on_seconds'], 4567)

    def test_prefers_precise_type_04_measurement_when_present(self):
        reader = BluetoothReader()
        frame = bytes.fromhex(
            'aa0606e30ce30c050069'
            'aa07042d4fd9070a'
            'aa040ccb170300824e00006937060024'
            'aa0507f389010001780144'
        )

        readings = reader._parse_data(frame)
        self.assertEqual(len(readings), 1)

        reading = readings[0]
        self.assertEqual(reading['voltage'], 20.2699)
        self.assertEqual(reading['current'], 2.0098)
        self.assertEqual(reading['power'], 40.7401)
        self.assertEqual(reading['dp'], 3.299)
        self.assertEqual(reading['dn'], 3.299)
        self.assertEqual(reading['temperature'], 37.6)

    def test_parses_legacy_fixed_offset_packet(self):
        reader = BluetoothReader()
        payload = bytearray(40)
        struct.pack_into('<iii', payload, 21, 51234, 9876, 50602)

        readings = reader._parse_data(bytes(payload))
        self.assertEqual(len(readings), 1)

        reading = readings[0]
        self.assertEqual(reading['voltage'], 5.1234)
        self.assertEqual(reading['current'], 0.9876)
        self.assertEqual(reading['power'], 5.0602)
        self.assertEqual(reading['dp'], 0.0)
        self.assertEqual(reading['dn'], 0.0)
        self.assertEqual(reading['temperature'], 0.0)


if __name__ == '__main__':
    unittest.main()
