/*
 * FNB58 Web Monitor – Browser-only edition
 *
 * Talks to a FNIRSI FNB58 directly from the browser using:
 *   - Web Bluetooth API (BLE)
 *   - WebUSB API (USB)
 *
 * Protocol parsing is ported from the Python reference implementation in
 *   device/bluetooth_reader.py
 *   device/usb_reader.py
 */

// ---------------------------------------------------------------------------
// Constants (kept in sync with the Python implementation)
// ---------------------------------------------------------------------------

// Bluetooth LE
// The FNB58 exposes two relevant GATT services:
//   0xffe0 – may contain the notify characteristic (ffe4)
//   0xffe5 – contains the write characteristic (ffe9)
// Both must be listed in optionalServices so the browser grants access.
const BLE_SERVICE_UUIDS = [0xffe0, 0xffe5];
const BLE_WRITE_UUID    = '0000ffe9-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_UUID   = '0000ffe4-0000-1000-8000-00805f9b34fb';
const BLE_INIT_COMMANDS = [
  new Uint8Array([0xaa, 0x81, 0x00, 0xf4]),
  new Uint8Array([0xaa, 0x82, 0x00, 0xa7]),
];
const BLE_PACKET_LENGTHS = { 0x03: 14, 0x04: 12, 0x05: 7, 0x06: 6, 0x07: 4, 0x08: 17 };

// USB
const USB_VENDOR_ID = 0x0716;
const USB_PRODUCT_IDS = [0x5030, 0x5031]; // FNB48S, FNB58
const USB_KEEPALIVE = (() => {
  // b"\xaa\x83" + b"\x00" * 61 + b"\x9e"
  const buf = new Uint8Array(64);
  buf[0] = 0xaa;
  buf[1] = 0x83;
  buf[63] = 0x9e;
  return buf;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Maximum data points per chart (safety cap).
// At BLE 10 Hz this is ~1 hour; at USB 100 Hz ~6 minutes.
// Old data is NOT discarded below this limit so the full session
// history stays visible from t = 0.
const MAX_POINTS = 36000;
const $ = (id) => document.getElementById(id);

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function setConnected(connected, mode = '') {
  $('btn-disconnect').disabled = !connected;
  $('btn-ble').disabled = connected;
  $('btn-usb').disabled = connected;
  $('mode-label').textContent = connected ? `Connected (${mode})` : 'Disconnected';
}

function fmt(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

function logError(prefix, err) {
  console.error(prefix, err);
  const msg = `${prefix}: ${err.message || err}`;
  setStatus(msg, 'error');
  appendLog(msg, 'error');
}

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 200;

/** Escape a string for safe insertion into innerHTML. */
function htmlEscape(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Append a line to the on-screen debug log panel.
 * @param {string} message
 * @param {'info'|'warn'|'error'|'ok'} level
 */
function appendLog(message, level = 'info') {
  const panel = $('bt-log');
  if (!panel) return;

  const entry = document.createElement('div');
  entry.className = `log-entry log-${level}`;

  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  entry.innerHTML =
    `<span class="log-ts">${ts}</span>` +
    `<span class="log-badge log-badge-${level}">${level.toUpperCase()}</span>` +
    `<span class="log-msg">${htmlEscape(message)}</span>`;

  panel.appendChild(entry);

  // Keep the buffer bounded
  while (panel.children.length > MAX_LOG_ENTRIES) {
    panel.removeChild(panel.firstChild);
  }

  // Auto-scroll to bottom
  panel.scrollTop = panel.scrollHeight;
}

// ---------------------------------------------------------------------------
// Chart setup
// ---------------------------------------------------------------------------

const charts = {};

function makeChart(canvasId, label, color, yLabel) {
  const ctx = $(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + '33',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: 'linear',
          ticks: { color: '#9ca3af', maxTicksLimit: 6, callback: (v) => `${v.toFixed(1)}s` },
          grid: { color: '#1f2937' },
        },
        y: {
          ticks: { color: '#9ca3af' },
          grid: { color: '#1f2937' },
          title: { display: true, text: yLabel, color: '#9ca3af' },
        },
      },
      plugins: {
        legend: { labels: { color: '#e5e7eb' } },
      },
    },
  });
}

function initCharts() {
  charts.voltage = makeChart('chart-voltage', 'Voltage (V)', '#60a5fa', 'V');
  charts.current = makeChart('chart-current', 'Current (A)', '#f87171', 'A');
  charts.power   = makeChart('chart-power',   'Power (W)',   '#34d399', 'W');
}

let firstTimestamp = null;

function fmtDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function inferProtocol(dp, dn) {
  if (!Number.isFinite(dp) || !Number.isFinite(dn)) return '—';
  if (dp > 0.55 && dp < 0.75 && dn > 0.55 && dn < 0.75) return 'QC 2.0';
  if (dp > 1.8 && dp < 2.8 && dn > 1.8 && dn < 2.8) return 'QC 3.0';
  if (dp > 2.6 && dp < 3.0 && dn < 0.7) return 'FCP';
  if (dp > 1.1 && dp < 1.3 && dn < 0.7) return 'SCP';
  if (dp > 2.6 && dp < 3.0 && dn > 2.6 && dn < 3.0) return 'VOOC';
  if (dp > 0.45 && dp < 0.65 && dn > 1.8 && dn < 2.8) return 'PD';
  if (dp > 2.0 && dp < 3.0 && dn > 0.45 && dn < 0.65) return 'PPS';
  if (dp < 0.2 && dn < 0.2) return 'DCP';
  return '—';
}

function pushReading(reading) {
  const now = performance.now() / 1000;
  if (firstTimestamp === null) firstTimestamp = now;
  const t = now - firstTimestamp;

  const pairs = [
    ['voltage', reading.voltage],
    ['current', reading.current],
    ['power', reading.power],
  ];

  for (const [key, value] of pairs) {
    const ds = charts[key].data.datasets[0].data;
    if (ds.length < MAX_POINTS) ds.push({ x: t, y: value });
    charts[key].update('none');
  }

  $('value-voltage').textContent     = fmt(reading.voltage, 4) + ' V';
  $('value-current').textContent     = fmt(reading.current, 4) + ' A';
  $('value-power').textContent       = fmt(reading.power, 4) + ' W';
  $('value-dp').textContent          = fmt(reading.dp, 3) + ' V';
  $('value-dn').textContent          = fmt(reading.dn, 3) + ' V';
  $('value-temp').textContent        = fmt(reading.temperature, 1) + ' °C';
  $('value-energy').textContent      = fmt(reading.energyWh, 4) + ' Wh';
  $('value-capacity').textContent    = fmt(reading.capacityAh * 1000, 2) + ' mAh';
  $('value-protocol').textContent    = reading.protocol || '—';
  $('value-runtime').textContent     = fmtDuration(reading.recordSeconds);
  $('value-poweron').textContent     = fmtDuration(reading.powerOnSeconds);
}

// ---------------------------------------------------------------------------
// Bluetooth driver
// ---------------------------------------------------------------------------

class BleDriver {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.rxBuffer = new Uint8Array(0);
    this.latest = {
      dp: 0,
      dn: 0,
      temperature: 0,
      energyWh: 0,
      capacityAh: 0,
      recordSeconds: 0,
      powerOnSeconds: 0,
    };
  }

  static available() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  async connect(onReading) {
    if (!BleDriver.available()) {
      throw new Error('Web Bluetooth is not supported in this browser');
    }

    appendLog('Scanning for FNB58 ...');
    setStatus('Scanning for FNB58 ...');
    this.device = await navigator.bluetooth.requestDevice({
      // Multiple filters are OR-combined by the browser.
      // Name-prefix covers most firmware versions; service-UUID filters
      // cover devices that only advertise via GATT service (no name).
      filters: [
        { namePrefix: 'FNB' },
        { namePrefix: 'FNIRSI' },
        { services: [0xffe0] },
        { services: [0xffe5] },
      ],
      optionalServices: BLE_SERVICE_UUIDS,
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      appendLog('Bluetooth disconnected', 'warn');
      setStatus('Bluetooth disconnected', 'warn');
      setConnected(false);
    });

    appendLog(`Connecting to ${this.device.name || this.device.id} ...`);
    setStatus(`Connecting to ${this.device.name || this.device.id} ...`);
    const server = await this.device.gatt.connect();

    // Enumerate all primary services and log them for diagnostics.
    const services = await server.getPrimaryServices();
    appendLog(`${services.length} GATT service(s) found`);

    // Resolve write and notify characteristics independently across all services.
    // On most FNB58 firmware versions the write char (ffe9) lives in service ffe5
    // while the notify char (ffe4) may live in service ffe0 – they are NOT in the
    // same service.
    let writeChar  = null;
    let notifyChar = null;

    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (_) { /* empty service */ }

      const props = (c) =>
        Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(', ');

      appendLog(`  Service ${svc.uuid}: ${chars.length} characteristic(s)`);
      for (const c of chars) {
        appendLog(`    ${c.uuid}  [${props(c)}]`);
        const uuid = c.uuid.toLowerCase();
        if (!writeChar  && uuid.startsWith('0000ffe9')) writeChar  = c;
        if (!notifyChar && uuid.startsWith('0000ffe4')) notifyChar = c;
      }
    }

    if (!notifyChar) {
      const msg = 'Notify characteristic (ffe4) not found - cannot continue';
      appendLog(msg, 'error');
      throw new Error(msg);
    }
    appendLog(`Notify characteristic found: ${notifyChar.uuid}`, 'ok');

    if (!writeChar) {
      appendLog('Write characteristic (ffe9) not found - skipping init commands', 'warn');
    } else {
      appendLog(`Write characteristic found: ${writeChar.uuid}`, 'ok');
    }

    notifyChar.addEventListener('characteristicvaluechanged', (evt) => {
      const readings = this._parse(evt.target.value);
      for (const reading of readings) onReading(reading);
    });
    await notifyChar.startNotifications();
    appendLog('Notifications enabled');

    if (writeChar) {
      for (const cmd of BLE_INIT_COMMANDS) {
        try {
          await writeChar.writeValue(cmd);
          await new Promise((r) => setTimeout(r, 100));
        } catch (err) {
          appendLog(`Init command failed (non-fatal): ${err.message}`, 'warn');
        }
      }
      appendLog('Init commands sent');
    }

    this.writeChar  = writeChar;
    this.notifyChar = notifyChar;

    const label = this.device.name || this.device.id;
    appendLog(`Bluetooth connected: ${label}`, 'ok');
    setStatus(`Bluetooth connected: ${label}`, 'ok');
    setConnected(true, 'Bluetooth');
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      try { await this.notifyChar.stopNotifications(); } catch (_) {}
      this.device.gatt.disconnect();
    }
    this.device = this.writeChar = this.notifyChar = null;
  }

  _crc8FromXmodem(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= (b << 8);
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc & 0xff;
  }

  _parsePackets(chunk) {
    const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
    merged.set(this.rxBuffer);
    merged.set(chunk, this.rxBuffer.length);

    const packets = [];
    let index = 0;
    while (index < merged.length) {
      if (merged[index] !== 0xaa) {
        index += 1;
        continue;
      }
      if (index + 2 >= merged.length) break;

      const type = merged[index + 1];
      const len = merged[index + 2];
      const expectedLen = BLE_PACKET_LENGTHS[type];
      if (!expectedLen || len !== expectedLen) {
        index += 1;
        continue;
      }

      const frameEnd = index + 4 + len;
      if (frameEnd > merged.length) break;

      const payloadStart = index + 3;
      const payloadEnd = payloadStart + len;
      const payload = merged.slice(payloadStart, payloadEnd);
      const checksum = merged[payloadEnd];
      const frame = merged.slice(index, payloadEnd);

      if (checksum !== this._crc8FromXmodem(frame)) {
        index += 1;
        continue;
      }

      packets.push({ type, payload });
      index = frameEnd;
    }

    this.rxBuffer = merged.slice(index);
    return packets;
  }

  _buildReading(voltage, current, power = voltage * current) {
    return {
      timestamp: Date.now(),
      voltage,
      current,
      power,
      dp: this.latest.dp,
      dn: this.latest.dn,
      temperature: this.latest.temperature,
      energyWh: this.latest.energyWh,
      capacityAh: this.latest.capacityAh,
      recordSeconds: this.latest.recordSeconds,
      powerOnSeconds: this.latest.powerOnSeconds,
      protocol: inferProtocol(this.latest.dp, this.latest.dn),
    };
  }

  _parse(dataView) {
    const packets = this._parsePackets(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength));
    if (!packets.length) return [];

    let primaryMeasurement = null;
    for (const { type, payload } of packets) {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      if (type === 0x04) {
        primaryMeasurement = {
          voltage: dv.getUint32(0, true) / 10000,
          current: dv.getUint32(4, true) / 10000,
          power: dv.getUint32(8, true) / 10000,
        };
      } else if (type === 0x05) {
        const sign = payload[4] > 0 ? 1 : -1;
        this.latest.temperature = sign * (dv.getUint16(5, true) / 10);
      } else if (type === 0x06) {
        this.latest.dp = dv.getUint16(0, true) / 1000;
        this.latest.dn = dv.getUint16(2, true) / 1000;
      } else if (type === 0x07) {
        if (!primaryMeasurement) {
          const voltage = dv.getUint16(0, true) / 1000;
          const current = dv.getUint16(2, true) / 1000;
          primaryMeasurement = { voltage, current, power: voltage * current };
        }
      } else if (type === 0x08) {
        this.latest.energyWh = dv.getUint32(1, true) / 100000;
        this.latest.capacityAh = dv.getUint32(5, true) / 100000;
        this.latest.recordSeconds = dv.getUint32(9, true);
        this.latest.powerOnSeconds = dv.getUint32(13, true);
      }
    }

    if (!primaryMeasurement || primaryMeasurement.voltage < 0 || primaryMeasurement.voltage > 150) {
      return [];
    }

    return [this._buildReading(
      primaryMeasurement.voltage,
      primaryMeasurement.current,
      primaryMeasurement.power
    )];
  }
}

// ---------------------------------------------------------------------------
// USB driver
// ---------------------------------------------------------------------------

class UsbDriver {
  constructor() {
    this.device = null;
    this.epIn = null;
    this.epOut = null;
    this.interfaceNumber = 0;
    this.reading = false;
    this.isFnb58 = false;
  }

  static available() {
    return !!(navigator.usb && navigator.usb.requestDevice);
  }

  async connect(onReading) {
    if (!UsbDriver.available()) {
      throw new Error('WebUSB is not supported in this browser');
    }

    setStatus('Choose FNB58 USB device ...');
    this.device = await navigator.usb.requestDevice({
      filters: USB_PRODUCT_IDS.map((productId) => ({ vendorId: USB_VENDOR_ID, productId })),
    });

    await this.device.open();
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    // Locate the interface and bulk/interrupt endpoints.
    const cfg = this.device.configuration;
    let chosen = null;
    for (const intf of cfg.interfaces) {
      const alt = intf.alternates[0];
      const epIn  = alt.endpoints.find((e) => e.direction === 'in');
      const epOut = alt.endpoints.find((e) => e.direction === 'out');
      if (epIn && epOut) {
        chosen = { interfaceNumber: intf.interfaceNumber, epIn, epOut };
        break;
      }
    }
    if (!chosen) throw new Error('No USB endpoints found');

    this.interfaceNumber = chosen.interfaceNumber;
    this.epIn = chosen.epIn.endpointNumber;
    this.epOut = chosen.epOut.endpointNumber;

    await this.device.claimInterface(this.interfaceNumber);
    this.isFnb58 = this.device.productId === 0x5031;

    setStatus(`USB connected: ${this.device.productName || 'FNIRSI'}`, 'ok');
    setConnected(true, 'USB');

    this.reading = true;
    this._readLoop(onReading).catch((err) => logError('USB Lesefehler', err));
  }

  async disconnect() {
    this.reading = false;
    if (this.device) {
      try { await this.device.releaseInterface(this.interfaceNumber); } catch (_) {}
      try { await this.device.close(); } catch (_) {}
    }
    this.device = null;
  }

  async _readLoop(onReading) {
    // Refresh interval depends on device type (mirrors usb_reader.py)
    const refreshMs = this.isFnb58 ? 1000 : 3;
    let nextSend = performance.now();

    while (this.reading) {
      try {
        const result = await this.device.transferIn(this.epIn, 64);
        if (result.status === 'ok' && result.data && result.data.byteLength >= 1) {
          const readings = this._decodePacket(result.data);
          for (const r of readings) onReading(r);
        }

        const now = performance.now();
        if (now >= nextSend) {
          nextSend = now + refreshMs;
          await this.device.transferOut(this.epOut, USB_KEEPALIVE);
        }
      } catch (err) {
        if (this.reading) {
          console.warn('USB Transferfehler:', err);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }

  /**
   * Decode a 64-byte HID packet into up to 4 readings.
   * Mirrors device/usb_reader.py::_decode_packet.
   */
  _decodePacket(dataView) {
    const readings = [];
    const offsets = [1, 17, 33, 49];

    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i];
      if (off + 14 >= dataView.byteLength) break;

      const voltage = dataView.getUint32(off + 0, true) / 100000.0;
      const current = dataView.getUint32(off + 4, true) / 100000.0;
      const dp      = dataView.getUint16(off + 8, true) / 1000.0;
      const dn      = dataView.getUint16(off + 10, true) / 1000.0;
      const temp    = dataView.getUint16(off + 13, true) / 10.0;
      const power   = voltage * current;

      readings.push({
        timestamp: Date.now(),
        voltage,
        current,
        power,
        dp,
        dn,
        temperature: temp,
        sample: i,
      });
    }
    return readings;
  }
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

let activeDriver = null;

async function connectBle() {
  if (activeDriver) return;
  appendLog('--- Bluetooth connection attempt ---');
  const driver = new BleDriver();
  try {
    await driver.connect(pushReading);
    activeDriver = driver;
  } catch (err) {
    logError('Bluetooth connection failed', err);
  }
}

async function connectUsb() {
  if (activeDriver) return;
  appendLog('--- USB connection attempt ---');
  const driver = new UsbDriver();
  try {
    await driver.connect(pushReading);
    activeDriver = driver;
  } catch (err) {
    logError('USB connection failed', err);
  }
}

async function disconnect() {
  if (!activeDriver) return;
  try {
    await activeDriver.disconnect();
  } catch (err) {
    console.warn(err);
  }
  activeDriver = null;
  firstTimestamp = null;
  setStatus('Disconnected', 'info');
  setConnected(false);
}

function checkSupport() {
  const bleOk = BleDriver.available();
  const usbOk = UsbDriver.available();

  $('btn-ble').disabled = !bleOk;
  $('btn-usb').disabled = !usbOk;

  const notes = [];
  if (!bleOk) notes.push('Web Bluetooth unavailable');
  if (!usbOk) notes.push('WebUSB unavailable');
  if (!window.isSecureContext) notes.push('Page must be opened over HTTPS or localhost');

  if (notes.length) {
    $('support-note').textContent = notes.join(' · ');
    $('support-note').classList.remove('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  checkSupport();
  $('btn-ble').addEventListener('click', connectBle);
  $('btn-usb').addEventListener('click', connectUsb);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-clear-log').addEventListener('click', () => {
    const panel = $('bt-log');
    if (panel) panel.innerHTML = '';
  });
});
