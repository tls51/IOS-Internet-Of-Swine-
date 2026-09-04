# Internet of Swine (IoS) — Smart Swine Barn Environmental & Water Management System

An automated Internet of Things (IoT) system designed for swine barns to optimize climate control, water usage, and sanitation.

## 🎯 Project Objectives & Implementation

1. **Monitor Heat Temperature and Humidity Level**:
   - Collects high-precision environmental data via DHT22 sensor and real-time DS3231 RTC clock.
   - Computes the Swine **Temperature-Humidity Index (THI)** dynamically: `THI = 0.8·T + (RH/100)·(T - 14.4) + 46.4`.
   - Displays live telemetry, gauges, 24-hour trends, and heat stress classification (*Normal*, *Stressful*, *Extreme Heat*, *Danger Zone*).

2. **Develop a Water Monitoring System**:
   - Monitors water reservoir / tank level in real time using an HC-SR04 ultrasonic sensor.
   - Renders visual tank fill graphics and status indicators (*Sufficient supply*, *Refill soon*, *Critical*).

3. **Develop a Water Usage System**:
   - Tracks total daily consumption in Liters (L) and instantaneous flow rate in Liters/min (LPM).
   - Categorizes water consumption breakdown (*Misting*, *Bathing*, *Cleaning*) and visualizes weekly historical usage trends.

4. **Create a Web-Based Admin Dashboard**:
   - **User Authentication**: Secure admin login (`admin` / `ios2024`) with automatic session preservation across page refreshes.
   - **Bathing & Cleaning Scheduling**: Full schedule management (CRUD) allowing custom trigger times, run durations (minutes), day selections, and instant toggle pause/resume.
   - **Adjust Temperature Thresholds & Operation Durations**:
     - *Mist Cooling Temperature Threshold*: Interactive slider to adjust cooling activation temperature (°C).
     - *THI Stress Thresholds*: Customizable boundary inputs for Normal, Stressful, and Extreme heat stress levels.
     - *Operation Durations*: Configurable misting active cycle duration (min) and pause interval (sec).
   - **Environmental & Water Telemetry**: Single-pane-of-glass dashboard for live temperature, humidity, THI, water tank level %, and flow metrics.
   - **Notify & Alert System**: Real-time diagnostic alert banner delivering alerts for:
     - Critical THI levels and severe heat stress warnings.
     - Low water tank supply levels (< 20%).
     - System malfunctions (sensor timeouts, abnormal out-of-range sensor readings, hardware communication dropouts).
   - **Generate System Reports**: Generates environmental and activity logs with one-click **CSV report export** for 24-hour, 7-day, and 30-day timeframes.
   - **Operate With or Without Internet Connectivity (ESP32 Local Hosting / Dual-Mode)**: Functions on local offline Wi-Fi / LAN networks without relying on external cloud dependencies.

---

## 🏗 System Architecture

```
ESP32 (DHT22 + RTC + HC-SR04 + YF-S201B)
        │  HTTP POST (pushes telemetry every 10s)
        ▼
ios-backend/  (Node.js + Express + SQLite)
        │  HTTP GET / POST / PATCH (dashboard polls status every 3s)
        ▼
Web Dashboard (HTML5 + CSS3 + Vanilla JS)
```

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

### Relay Module & Water Pump Testing:

- **Web Dashboard Testing**: Navigate to **Automatic Systems** (`Auto Systems` in the sidebar). Use the **"🧪 Test Water Pump (3s Pulse)"** button or toggle **"💧 Manual Pump ON/OFF"** for live testing with real-time status and diagnostics.
- **Serial Monitor Commands**: Open the Serial Monitor at `115200 baud` and type:
  - `test pump` or `pump test` — Triggers a 3-second water pump relay test, monitors flow sensor pulses in real time, and logs results.
  - `pump on` / `relay on` — Manually turns ON the relay / water pump.
  - `pump off` / `relay off` — Manually turns OFF the relay / water pump.
  - `test` / `diag` / `status` — Runs full hardware self-test across all 5 subsystems (DHT22, RTC, HC-SR04, Flow Sensor, Relay).
- **Active-LOW Relays**: Most 1-channel relay modules use Active-LOW logic (trigger when signal is `LOW`). Keep `#define RELAY_ACTIVE_LOW true` in `main.cpp`. If your relay module triggers on `HIGH`, change it to `false`.
- **Standard ESP32 vs ESP32-S3**: On classic ESP32 (WROOM-32), pins 6-11 are reserved for flash memory. If using classic ESP32, change `#define RELAY_PIN 18` or `19`. On ESP32-S3, pin 7 works directly.

## API reference (backend)

**Ingest (called by the ESP32):**
- `POST /api/readings` — `{ temp, humidity, device_id }`
- `POST /api/water` — `{ level_pct, used_l, flow_lpm, device_id }`
- `POST /api/diagnostics` — `{ dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, details }`
- `POST /api/relay/status` — `{ relay_on, test_completed, flow_pulses, flow_lpm }`

**Read & Control (called by the dashboard & ESP32):**
- `GET /api/status` — current temp/humidity/THI/water/system state, operation durations, relay state, & diagnostics
- `POST /api/relay/test` — `{ duration_ms }` triggers timed water pump test
- `POST /api/relay/control` — `{ active: true/false }` toggles manual water pump override
- `GET /api/relay/command` — polled by ESP32 to receive test and toggle commands from dashboard
- `GET /api/readings/history?range=24h|7d|30d` — chart telemetry data
- `GET /api/water/weekly` — weekly usage bar chart
- `GET /api/schedules?type=bath|clean` — schedule list
- `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id` — schedule management
- `GET /api/settings/threshold`, `POST /api/settings/threshold` — mist cooling temperature threshold
- `GET /api/settings/durations`, `POST /api/settings/durations` — misting run duration & pause interval
- `GET /api/settings/thi`, `POST /api/settings/thi` — customize THI stress classification boundaries
- `GET /api/reports/export?range=24h|7d|30d` — CSV system report export download
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
