"""
Bluetooth LE Reader for FNIRSI FNB58
Based on reverse-engineered protocol from parkerlreed's gist
"""

import asyncio
import binascii
import struct
import threading
from datetime import datetime
from collections import deque
from bleak import BleakClient, BleakScanner


class BluetoothReader:
    """Bluetooth LE communication with FNIRSI FNB58"""
    
    # Fallback Bluetooth UUIDs (used when dynamic discovery fails)
    WRITE_UUID = "0000ffe9-0000-1000-8000-00805f9b34fb"
    NOTIFY_UUID = "0000ffe4-0000-1000-8000-00805f9b34fb"
    
    # Short UUIDs to search for (covers both ffe9 and alternate write chars like ffe1)
    WRITE_SHORT_UUIDS = ["ffe9", "ffe1"]
    NOTIFY_SHORT_UUIDS = ["ffe4", "ffe1"]
    
    # Initialization commands
    INIT_COMMANDS = [
        bytes([0xaa, 0x81, 0x00, 0xf4]),
        bytes([0xaa, 0x82, 0x00, 0xa7])
    ]
    PACKET_LENGTHS = {
        0x03: 14,
        0x04: 12,
        0x05: 7,
        0x06: 6,
        0x07: 4,
        0x08: 17,
    }
    
    def __init__(self, device_address=None, device_name="FNB58"):
        self.device_address = device_address
        self.device_name = device_name
        self.client = None
        self.is_connected = False
        self.is_reading = False
        self.data_callback = None
        self.data_buffer = deque(maxlen=1000)
        self.loop = None
        self.thread = None
        # Resolved characteristic UUIDs (filled after connection)
        self._write_uuid = None
        self._notify_uuid = None
        self._rx_buffer = bytearray()
        self._latest_measurement = {
            'dp': 0.0,
            'dn': 0.0,
            'temperature': 0.0,
            'energy_wh': 0.0,
            'capacity_ah': 0.0,
            'record_seconds': 0,
            'power_on_seconds': 0,
        }
        self._device_metadata = {}
        
    async def scan_devices(self, timeout=10):
        """Scan for FNIRSI devices"""
        print(f"Scanning for Bluetooth devices (timeout: {timeout}s)...")
        devices = await BleakScanner.discover(timeout=timeout)
        
        fnirsi_devices = []
        for device in devices:
            if device.name and self.device_name in device.name:
                fnirsi_devices.append({
                    'address': device.address,
                    'name': device.name,
                    'rssi': device.rssi if hasattr(device, 'rssi') else None
                })
        
        return fnirsi_devices
    
    def _find_characteristic(self, short_uuids, required_property=None):
        """Search all services for a characteristic matching any of the given short UUIDs.

        Iterates ``short_uuids`` in order so callers can express preference (first
        match wins).  When ``required_property`` is given (e.g. ``"notify"`` or
        ``"write-without-response"``) only characteristics that advertise that
        property are returned.

        Args:
            short_uuids: List of 4-hex-digit UUID fragments to search for.
            required_property: Optional GATT property name that the characteristic
                must expose (matched case-insensitively against Bleak's property
                strings).

        Returns:
            The full characteristic UUID string if found, otherwise None.
        """
        for short in short_uuids:
            prefix = f"0000{short.lower()}"
            req_prop = required_property.lower() if required_property is not None else None
            for service in self.client.services:
                for char in service.characteristics:
                    if not char.uuid.lower().startswith(prefix):
                        continue
                    if req_prop is not None:
                        props = [p.lower() for p in char.properties]
                        if req_prop not in props:
                            continue
                    return char.uuid
        return None

    async def _connect_async(self):
        """Async connection handler"""
        # If no address provided, scan for device
        if not self.device_address:
            devices = await self.scan_devices()
            if not devices:
                raise ConnectionError(f"No {self.device_name} devices found")
            
            # Use the first device found
            self.device_address = devices[0]['address']
            print(f"Found device: {devices[0]['name']} at {self.device_address}")
        
        # Connect to device
        self.client = BleakClient(self.device_address)
        await self.client.connect()
        
        if not self.client.is_connected:
            raise ConnectionError("Failed to connect to device")
        
        print(f"Connected to {self.device_address}")

        # Log available services and characteristics for diagnostics
        print("Discovering GATT services...")
        for service in self.client.services:
            print(f"  Service: {service.uuid}")
            for char in service.characteristics:
                print(f"    Characteristic: {char.uuid}  props={char.properties}")

        # Resolve write and notify UUIDs dynamically across all services.
        # Pass required_property so we avoid picking e.g. ffe1-write as the
        # notify char when ffe4-notify exists (and vice versa).
        self._notify_uuid = self._find_characteristic(self.NOTIFY_SHORT_UUIDS, required_property="notify")
        self._write_uuid = self._find_characteristic(
            self.WRITE_SHORT_UUIDS,
            required_property="write-without-response"
        ) or self._find_characteristic(self.WRITE_SHORT_UUIDS, required_property="write")

        if self._notify_uuid:
            print(f"Notify characteristic resolved: {self._notify_uuid}")
        else:
            print(f"Warning: no notify characteristic found, tried {self.NOTIFY_SHORT_UUIDS}. "
                  f"Falling back to {self.NOTIFY_UUID}")
            self._notify_uuid = self.NOTIFY_UUID

        if self._write_uuid:
            print(f"Write characteristic resolved: {self._write_uuid}")
            # Send initialization commands
            for cmd in self.INIT_COMMANDS:
                try:
                    await self.client.write_gatt_char(self._write_uuid, cmd)
                    await asyncio.sleep(0.1)
                except Exception as e:
                    print(f"Warning: init command failed (non-fatal): {e}")
        else:
            print(f"Warning: no write characteristic found, tried {self.WRITE_SHORT_UUIDS}. "
                  "Skipping initialization commands.")
            self._write_uuid = self.WRITE_UUID
        
        self.is_connected = True
        return True
    
    def connect(self):
        """Connect to Bluetooth device (synchronous wrapper)"""
        # Create new event loop for this thread
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        
        # Run connection
        return self.loop.run_until_complete(self._connect_async())
    
    async def _start_reading_async(self):
        """Async reading handler"""
        
        def notification_handler(sender, data):
            """Handle incoming notifications"""
            readings = self._parse_data(data)
            for reading in readings:
                self.data_buffer.append(reading)

                if self.data_callback:
                    self.data_callback(reading)
        
        notify_uuid = self._notify_uuid

        # Start notifications
        try:
            await self.client.start_notify(notify_uuid, notification_handler)
            print(f"Bluetooth notifications enabled on {notify_uuid}")
        except Exception as e:
            raise ConnectionError(
                f"Could not enable notifications on {notify_uuid}: {e}. "
                "Check that the device exposes a notify characteristic."
            )
        
        # Keep reading until stopped
        while self.is_reading and self.client.is_connected:
            await asyncio.sleep(0.1)
        
        # Stop notifications
        try:
            await self.client.stop_notify(notify_uuid)
        except Exception:  # noqa: BLE001 – best-effort cleanup on disconnect
            pass
    
    def start_reading(self, callback=None):
        """Start reading data in background thread"""
        if not self.is_connected:
            raise ConnectionError("Device not connected")
        
        self.data_callback = callback
        self.is_reading = True
        
        # Start reading in background thread
        self.thread = threading.Thread(target=self._reading_thread, daemon=True)
        self.thread.start()
    
    def _reading_thread(self):
        """Thread function to run async reading"""
        if not self.loop:
            self.loop = asyncio.new_event_loop()
        
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._start_reading_async())
    
    def stop_reading(self):
        """Stop reading data"""
        self.is_reading = False
        if self.thread:
            self.thread.join(timeout=2)
    
    @staticmethod
    def _crc8_from_xmodem(data):
        """Return the low byte of CRC-16/XMODEM, matching the BLE framing."""
        return binascii.crc_hqx(data, 0) & 0xFF

    def _parse_framed_packets(self, data):
        """Parse variable-length framed BLE packets used by newer firmware."""
        self._rx_buffer.extend(data)
        packets = []
        index = 0

        while index < len(self._rx_buffer):
            if self._rx_buffer[index] != 0xAA:
                index += 1
                continue

            if index + 2 >= len(self._rx_buffer):
                break

            packet_type = self._rx_buffer[index + 1]
            payload_len = self._rx_buffer[index + 2]
            expected_len = self.PACKET_LENGTHS.get(packet_type)

            if expected_len is None or payload_len != expected_len:
                index += 1
                continue

            frame_end = index + 4 + payload_len
            if frame_end > len(self._rx_buffer):
                break

            payload_start = index + 3
            payload_end = payload_start + payload_len
            payload = bytes(self._rx_buffer[payload_start:payload_end])
            checksum = self._rx_buffer[payload_end]
            frame = bytes(self._rx_buffer[index:payload_end])

            if checksum != self._crc8_from_xmodem(frame):
                index += 1
                continue

            packets.append((packet_type, payload))
            index = frame_end

        if index:
            del self._rx_buffer[:index]

        return packets

    def _build_reading(self, voltage, current, power=None):
        if power is None:
            power = voltage * current
        return {
            'timestamp': datetime.now().isoformat(),
            'voltage': round(voltage, 5),
            'current': round(current, 5),
            'power': round(power, 5),
            'dp': round(self._latest_measurement.get('dp', 0.0), 3),
            'dn': round(self._latest_measurement.get('dn', 0.0), 3),
            'temperature': round(self._latest_measurement.get('temperature', 0.0), 1),
            'energy_wh': round(self._latest_measurement.get('energy_wh', 0.0), 5),
            'capacity_ah': round(self._latest_measurement.get('capacity_ah', 0.0), 5),
            'record_seconds': self._latest_measurement.get('record_seconds', 0),
            'power_on_seconds': self._latest_measurement.get('power_on_seconds', 0),
            'sample': 0
        }

    def _parse_framed_measurements(self, data):
        """Convert framed BLE packets into app readings."""
        had_framed_context = bool(self._rx_buffer) or (len(data) > 0 and data[0] == 0xAA)
        packets = self._parse_framed_packets(data)
        if not packets:
            return [], had_framed_context

        primary_measurement = None

        for packet_type, payload in packets:
            if packet_type == 0x03:
                model, fw_raw, serial = struct.unpack_from('<HHL', payload, 0)
                self._device_metadata.update({
                    'model': model,
                    'firmware_version': round(fw_raw / 100, 2),
                    'serial': serial,
                    'group_max': payload[12],
                    'group_current': payload[13],
                })
            elif packet_type == 0x04:
                voltage_raw, current_raw, power_raw = struct.unpack_from('<III', payload, 0)
                primary_measurement = {
                    'voltage': voltage_raw / 10000.0,
                    'current': current_raw / 10000.0,
                    'power': power_raw / 10000.0,
                }
            elif packet_type == 0x05:
                sign = 1 if payload[4] > 0 else -1
                self._latest_measurement['temperature'] = (
                    sign * struct.unpack_from('<H', payload, 5)[0] / 10.0
                )
            elif packet_type == 0x06:
                dp, dn = struct.unpack_from('<HH', payload, 0)
                self._latest_measurement['dp'] = dp / 1000.0
                self._latest_measurement['dn'] = dn / 1000.0
            elif packet_type == 0x07:
                voltage_raw, current_raw = struct.unpack_from('<HH', payload, 0)
                primary_measurement = primary_measurement or {
                    'voltage': voltage_raw / 1000.0,
                    'current': current_raw / 1000.0,
                    'power': (voltage_raw / 1000.0) * (current_raw / 1000.0),
                }
            elif packet_type == 0x08:
                self._latest_measurement['energy_wh'] = struct.unpack_from('<L', payload, 1)[0] / 100000.0
                self._latest_measurement['capacity_ah'] = struct.unpack_from('<L', payload, 5)[0] / 100000.0
                self._latest_measurement['record_seconds'] = struct.unpack_from('<L', payload, 9)[0]
                self._latest_measurement['power_on_seconds'] = struct.unpack_from('<L', payload, 13)[0]

        readings = []
        if primary_measurement:
            voltage = primary_measurement['voltage']
            current = primary_measurement['current']
            power = primary_measurement['power']

            if 0.0 <= voltage <= 150.0:
                readings.append(self._build_reading(voltage, current, power))

        return readings, True

    def _parse_legacy_data(self, data):
        """Parse the legacy fixed-offset BLE packet format."""
        # Constants from reverse engineering
        offset = 21
        scale = 10000
        
        # Voltage range filter
        min_voltage = 0.0
        max_voltage = 150.0
        
        if len(data) < offset + 12:
            return []
        
        try:
            # Unpack 3 signed 32-bit integers (voltage, current, power)
            voltage, current, power = (value / scale for value in struct.unpack_from('<iii', data, offset))
            
            # Filter out invalid readings
            if not (min_voltage <= voltage <= max_voltage):
                return []
            
            reading = {
                'timestamp': datetime.now().isoformat(),
                'voltage': round(voltage, 5),
                'current': round(current, 5),
                'power': round(power, 5),
                'dp': 0.0,  # Not available via Bluetooth
                'dn': 0.0,  # Not available via Bluetooth
                'temperature': 0.0,  # Not available via Bluetooth (yet)
                'sample': 0
            }
            
            return [reading]
            
        except Exception as e:
            print(f"Error parsing Bluetooth data: {e}")
            return []

    def _parse_data(self, data):
        """Parse BLE notifications from either the new framed or legacy format."""
        framed_readings, had_framed_context = self._parse_framed_measurements(data)
        if framed_readings:
            return framed_readings
        if had_framed_context:
            return []

        return self._parse_legacy_data(data)
    
    async def _disconnect_async(self):
        """Async disconnect handler"""
        if self.client and self.client.is_connected:
            await self.client.disconnect()
    
    def disconnect(self):
        """Disconnect from device"""
        self.stop_reading()
        
        if self.loop and self.client:
            try:
                self.loop.run_until_complete(self._disconnect_async())
            except:
                pass
        
        self.is_connected = False
    
    def get_device_info(self):
        """Get device information"""
        if not self.client:
            return None
        
        return {
            'address': self.device_address,
            'name': self.device_name,
            'connection_type': 'bluetooth',
            **self._device_metadata,
        }
