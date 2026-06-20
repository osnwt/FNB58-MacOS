# FNB58 Web Monitor (Browser Edition)

Static, serverless version of the FNB58 monitor. It talks directly to the
FNIRSI FNB58 from the browser via **Web Bluetooth** or **WebUSB**.

This version is intended for GitHub Pages deployment through
`.github/workflows/pages.yml` and does not require Python or Docker in
production.

## Local Preview

```bash
python3 -m http.server -d web 8000
```

Then open `http://localhost:8000`.

> Web Bluetooth and WebUSB only work in a secure context, which means
> `https://...` or `http://localhost`.

## Browser Support

| API           | Chrome / Edge / Opera | Firefox | Safari |
| ------------- | --------------------- | ------- | ------ |
| Web Bluetooth | ✅                    | ❌      | ❌     |
| WebUSB        | ✅                    | ❌      | ❌     |

On Linux, WebUSB may require a udev rule for vendor ID `0x0716`.
On Windows, a WinUSB driver may be required, for example via Zadig.

## BLE Coverage

The browser monitor now understands the newer framed BLE notifications used by
recent FNB58 firmware:

- `0x04` precise voltage/current/power frame
- `0x05` temperature
- `0x06` D+ / D-
- `0x07` fallback voltage/current sample
- `0x08` energy, capacity, runtime counters

The protocol handling mirrors the Python reference implementation in:

- `device/bluetooth_reader.py`
- `device/usb_reader.py`

## GitHub Pages

After enabling **Settings -> Pages -> Build and deployment -> Source: GitHub Actions**
in the repository, pushes to `main` that touch `web/**` or the Pages workflow
will publish this app at:

`https://<owner>.github.io/FNB58-MacOS/`
