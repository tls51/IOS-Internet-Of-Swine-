# Internet of Swine (IoS) — Dashboard + Backend + ESP32

This connects three previously-disconnected pieces:

```
ESP32 (DHT22 + RTC + HC-SR04)
        │  HTTP POST (pushes readings every 10s)
        ▼
ios-backend/  (Node.js + Express + SQLite)
        │  HTTP GET (dashboard polls every 3s)
        ▼
index.html + css/ + js/   (your browser dashboard)
```

The dashboard no longer simulates data in `js/data.js` — it fetches real
readings from the backend, which stores everything permanently in a
SQLite file (`ios-backend/ios.db`). The ESP32 pushes new readings to the
backend instead of only printing to Serial.

This build is **read-only**: the dashboard displays sensor data and
schedules, but does not send commands back to the ESP32 to trigger
relays. Misting/bathing/cleaning "Active" badges are inferred from the
latest temperature reading and the schedule times, not a live relay
signal.

## 1. Run the backend

```bash
cd ios-backend
npm install
npm start
```

You should see:
```
IoS backend listening on http://0.0.0.0:3000
```

This creates `ios-backend/ios.db` automatically on first run — that's
your database. Default schedules and a 32°C threshold are seeded in.

## 2. Point the dashboard at the backend

Open `js/config.js` and set `apiBase` to wherever the backend is
running. If you're opening `index.html` on the same computer running
the backend, the default `http://localhost:3000` works as-is. If the
dashboard is opened from another device on your network, use the
backend machine's LAN IP instead, e.g. `http://192.168.1.50:3000`.

Then just open `index.html` in a browser (or serve the folder with any
static file server) and log in with `admin` / `ios2024`.

## 3. Flash the ESP32

Open `arduino/ios_sensor_node.ino` in the Arduino IDE. Edit the four
settings at the top:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "192.168.1.50";   // backend machine's LAN IP
const int   SERVER_PORT   = 3000;
```

The ESP32 now joins your WiFi as a normal device (station mode) so it
can reach the backend on your network — this replaces the old
`accesspoint_ios.ino` behavior of hosting its own isolated network,
since a device can't push to an external server while also acting as
its own island access point. Required libraries (install via Library
Manager): `DHT sensor library` (Adafruit), `RTClib` (Adafruit), and the
built-in `WiFi`/`HTTPClient` (already part of the ESP32 board package).

Wiring is unchanged from the original sketches, plus optional pins:

| Hardware Component | Pin(s)                                | Notes |
|--------------------|---------------------------------------|-------|
| DHT22 data         | GPIO4                                 | Temperature & Humidity |
| RTC DS3231         | SDA GPIO8, SCL GPIO9                  | Real-Time Clock (I2C) |
| Water Flow Sensor  | GPIO15                                | YF-S201B interrupt pin |
| Relay Module       | GPIO7 (ESP32-S3) or GPIO18 (standard) | Misting / Bathing Pump |
| Piezo Buzzer       | GPIO18 (optional)                     | `HAS_BUZZER true` |
| HC-SR04 TRIG       | GPIO5 (optional)                      | Water tank level |
| HC-SR04 ECHO       | GPIO6 (optional)                      | Water tank level |

### Relay Module & Buzzer Configuration Notes:

- **Active-LOW Relays**: Most 1-channel relay modules use Active-LOW logic (trigger when signal is `LOW`). Keep `#define RELAY_ACTIVE_LOW true` in `main.cpp`. If your relay module triggers on `HIGH`, change it to `false`.
- **Boot Self-Test**: The node now pulses the relay/buzzer 3 times on boot to verify wiring.
- **TEST_MODE**: Set `#define TEST_MODE true` near top of `main.cpp` to pulse the relay on every 10s sensor check during testing, even if room temperature is normal (< 74 THI). Set to `false` for production operation.
- **Standard ESP32 vs ESP32-S3**: On classic ESP32 (WROOM-32), pins 6-11 are reserved for flash memory. If using classic ESP32, change `#define RELAY_PIN 18` or `19`. On ESP32-S3, pin 7 works directly.

## API reference (backend)

**Ingest (called by the ESP32):**
- `POST /api/readings` — `{ temp, humidity, device_id }`
- `POST /api/water` — `{ level_pct, used_l, flow_lpm, device_id }`

**Read (called by the dashboard):**
- `GET /api/status` — current temp/humidity/THI/water/system state
- `GET /api/readings/history?range=24h|7d|30d` — chart data
- `GET /api/water/weekly` — weekly usage bar chart
- `GET /api/schedules?type=bath|clean` — schedule list
- `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`
- `GET /api/activity?limit=30` — activity log for the Reports page

## Notes / known limitations

- The dashboard's THI formula (`0.8T + (RH·T − 14.4)/100 + 46.4`, Celsius)
  and the old `dht_copy_*.ino` sketch's formula (Fahrenheit-based) didn't
  match. The backend now computes THI once, using the dashboard's
  formula, from raw temp/humidity — so there's a single source of truth.
- `used_l`/`flow_lpm` need a flow sensor that wasn't in the original
  wiring; the sketch currently pushes `0` for both rather than
  fabricating numbers. Add a flow sensor and update
  `readAndPushWater()` if you want real usage tracking.
- No authentication on the backend API — fine on a private home/farm
  network, but don't expose port 3000 to the public internet as-is.
