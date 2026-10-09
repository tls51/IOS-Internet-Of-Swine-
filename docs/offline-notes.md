# Offline Architecture & Codebase Findings: Internet of Swine (IoS)

This document contains a complete technical inventory of the Internet of Swine (IoS) system across the dashboard front-end, Node.js SQLite backend, and ESP32-S3 firmware. No code changes have been applied.

---

## 1. API Routes Called by the Dashboard

The dashboard communicates via HTTP `fetch()` requests. The base URL is configured in `dashboard/js/config.js` (`apiBase: ''` by default, resolving to relative paths, with `'http://localhost:3000'` as a fallback).

### Primary Routes from `js/data.js`, `js/schedule.js`, and `js/config.js`:

#### From `dashboard/js/data.js`:

1. **`GET /api/status`**
   - **Trigger / Polling**: Polled every 3,000 ms (`POLL_MS`).
   - **Request**: No body (`GET`).
   - **Response JSON**:
     ```json
     {
       "temp": 30.2,
       "humidity": 87.6,
       "thi": 86.4,
       "thiStatus": {
         "label": "Danger Zone",
         "cls": "badge-danger",
         "color": "#EF4444"
       },
       "thiThresholds": {
         "normalMax": 74,
         "stressMax": 78,
         "extremeMax": 83
       },
       "operationDurations": {
         "mistDurationMin": 5,
         "mistPauseSec": 30
       },
       "malfunctions": [],
       "diagnostics": {
         "id": 1,
         "ts": 1727845000000,
         "dht_ok": true,
         "rtc_ok": true,
         "tank_ok": true,
         "flow_ok": true,
         "relay_ok": true,
         "details": {}
       },
       "waterLevel": 75.5,
       "waterUsed": 0.0,
       "flowRate": 0.0,
       "mistActive": false,
       "bathActive": false,
       "cleanActive": false,
       "pumpActive": false,
       "relayState": false,
       "manualPumpActive": false,
       "lastPumpTest": null,
       "threshold": 32,
       "lastReadingTs": 1727845000000,
       "lastWaterTs": 1727845000000
     }
     ```

2. **`GET /api/diagnostics`**
   - **Trigger / Polling**: Polled every 60,000 ms (`_diagTimer`).
   - **Request**: No body (`GET`).
   - **Response JSON**:
     ```json
     {
       "id": 1,
       "ts": 1727845000000,
       "dht_ok": true,
       "rtc_ok": true,
       "tank_ok": true,
       "flow_ok": true,
       "relay_ok": true,
       "details": {
         "dht": "Temp: 30.2°C | Humidity: 87.6% RH (DHT22 on GPIO 4)",
         "rtc": "RTC Time: 2026-10-02 13:00:00",
         "tank": "Echo: 526 us | Distance: 9.0 cm | Water Level: 45%",
         "flow": "Pin GPIO 15 (State: HIGH) | Pulses: 0 | Usage: 0.00L",
         "relay": "GPIO 18 connected to Water Pump Relay"
       }
     }
     ```
     *(Or `{"ok": false, "msg": "No diagnostics recorded yet"}` if uninitialized)*

3. **`POST /api/relay/test`**
   - **Trigger**: "Test Water Pump" button clicked (`DATA.testPump(durationMs)`).
   - **Request JSON**:
     ```json
     {
       "duration_ms": 3000
     }
     ```
   - **Response JSON**:
     ```json
     {
       "ok": true,
       "message": "Pump test command queued for 3000ms",
       "lastPumpTest": {
         "ts": 1727845000000,
         "duration_ms": 3000,
         "status": "Testing"
       }
     }
     ```

4. **`POST /api/relay/control`**
   - **Trigger**: "Manual Pump ON / OFF" button toggle (`DATA.controlPump(active)`).
   - **Request JSON**:
     ```json
     {
       "active": true
     }
     ```
   - **Response JSON**:
     ```json
     {
       "ok": true,
       "manualPumpActive": true,
       "relayState": true
     }
     ```

5. **`GET /api/readings/history?range=24h`**
   - **Trigger / Polling**: Polled every 30,000 ms (`HISTORY_POLL_MS`).
   - **Request**: Query parameter `range=24h` (also supports `7d`, `30d`).
   - **Response JSON**:
     ```json
     [
       {
         "time": "13:05",
         "ts": 1727845500000,
         "temp": 31.2,
         "humidity": 86.2,
         "thi": 86.4
       }
     ]
     ```

6. **`GET /api/water/weekly`**
   - **Trigger / Polling**: Polled every 30,000 ms (`HISTORY_POLL_MS`).
   - **Request**: No body (`GET`).
   - **Response JSON**:
     ```json
     [
       { "day": "Mon", "mist": 0, "bathe": 0, "clean": 0, "total": 12 },
       { "day": "Tue", "mist": 0, "bathe": 0, "clean": 0, "total": 0 },
       { "day": "Wed", "mist": 0, "bathe": 0, "clean": 0, "total": 15 },
       { "day": "Thu", "mist": 0, "bathe": 0, "clean": 0, "total": 8 },
       { "day": "Fri", "mist": 0, "bathe": 0, "clean": 0, "total": 22 },
       { "day": "Sat", "mist": 0, "bathe": 0, "clean": 0, "total": 14 },
       { "day": "Sun", "mist": 0, "bathe": 0, "clean": 0, "total": 5 }
     ]
     ```

#### From `dashboard/js/schedule.js`:

7. **`GET /api/schedules?type={type}`**
   - **Trigger**: Initial page load and modal refresh (`type` is either `'bath'` or `'clean'`).
   - **Request**: Query parameter `type=bath` or `type=clean`.
   - **Response JSON**:
     ```json
     [
       {
         "id": 1,
         "type": "bath",
         "label": "Morning Bath",
         "time": "06:00",
         "duration": 15,
         "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
         "active": true
       }
     ]
     ```

8. **`POST /api/schedules`**
   - **Trigger**: Modal form save ("Add Schedule").
   - **Request JSON**:
     ```json
     {
       "type": "bath",
       "label": "Bath 06:00",
       "time": "06:00",
       "duration": 15,
       "days": ["Mon", "Wed", "Fri"]
     }
     ```
   - **Response JSON** (HTTP 201):
     ```json
     {
       "id": 3,
       "type": "bath",
       "label": "Bath 06:00",
       "time": "06:00",
       "duration": 15,
       "days": ["Mon", "Wed", "Fri"],
       "active": true
     }
     ```

9. **`PATCH /api/schedules/{id}`**
   - **Trigger**: Toggle schedule active/paused button.
   - **Request JSON**:
     ```json
     {
       "active": false
     }
     ```
   - **Response JSON**:
     ```json
     {
       "id": 1,
       "type": "bath",
       "label": "Morning Bath",
       "time": "06:00",
       "duration": 15,
       "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
       "active": false
     }
     ```

10. **`DELETE /api/schedules/{id}`**
    - **Trigger**: Delete schedule button (`×`).
    - **Request**: No body (`DELETE`).
    - **Response**: HTTP 204 No Content (empty body).

#### From `dashboard/js/config.js`:
- Contains no HTTP calls directly. Defines runtime constants:
  ```javascript
  const IOS_CONFIG = {
    apiBase: '',         // Relative paths for Node backend and ESP32 LittleFS
    pollMs: 3000,        // 3-second poll for /api/status
    historyPollMs: 30000 // 30-second poll for charts
  };
  ```

---

### Additional Dashboard Routes (Called in `app.js` and `pages.js`):

11. **`POST /api/settings/threshold`** (`js/app.js:209`)
    - Triggered on threshold slider release.
    - **Request JSON**: `{"value": 32}`
    - **Response JSON**: `{"value": 32}`

12. **`POST /api/settings/thi`** (`js/app.js:248`)
    - Triggered on "Save Thresholds" button.
    - **Request JSON**: `{"normalMax": 74, "stressMax": 78, "extremeMax": 83}`
    - **Response JSON**: `{"normalMax": 74, "stressMax": 78, "extremeMax": 83}`

13. **`POST /api/settings/durations`** (`js/app.js:298`)
    - Triggered on "Save Durations" button.
    - **Request JSON**: `{"mistDurationMin": 5, "mistPauseSec": 30}`
    - **Response JSON**: `{"mistDurationMin": 5, "mistPauseSec": 30}`

14. **`GET /api/reports/export?range={range}`** (`js/app.js:346`)
    - Triggered on "Export CSV" click (`window.location.href`).
    - **Response**: Direct CSV file attachment (`Content-Type: text/csv`).

15. **`GET /api/activity?limit=30`** (`js/pages.js:412`)
    - Triggered when opening Reports page.
    - **Response JSON**:
      ```json
      [
        {
          "id": 10,
          "ts": 1727845000000,
          "type": "Mist",
          "msg": "DHT22 reading — Temp 30.2°C, Humidity 87.6%, THI 86.4 (Danger Zone)"
        }
      ]
      ```

---

## 2. Hardcoded URLs and IP Addresses

| Location | File & Line | Value / Context |
|---|---|---|
| **ESP32 Firmware Target IP** | `arduino/.../src/main.cpp:22-23` | `const char* SERVER_HOST = "192.168.1.33";`<br>`const int SERVER_PORT = 3000;` |
| **ESP32 HTTP Client Endpoints** | `arduino/.../src/main.cpp:325, 422, 460` | `http://192.168.1.33:3000/api/status`<br>`http://192.168.1.33:3000/api/readings`<br>`http://192.168.1.33:3000/api/water` |
| **Dashboard Direct Host Example** | `dashboard/js/config.js:11` | `apiBase: 'http://192.168.1.61:3000'` (commented guidance for `file://` mode) |
| **Dashboard Default Fallbacks** | `dashboard/js/data.js:11`<br>`dashboard/js/schedule.js:10`<br>`dashboard/js/app.js:204, 229, 284, 341`<br>`dashboard/js/pages.js:410` | `'http://localhost:3000'` (used if `IOS_CONFIG` is undefined) |
| **Backend Listening Log** | `ios-backend/src/server.js:1461, 1465` | `http://0.0.0.0:3000`<br>`http://<this-machine-ip>:3000/api/readings` |
| **SVG XML Namespace (Non-network)** | `dashboard/js/charts.js:8` | `http://www.w3.org/2000/svg` (standard DOM element creation namespace) |
| **Historical Node IPs in DB** | `ios-backend/ios.db` | `192.168.1.61:3000`, `192.168.1.46:3000` (stored from previous test runs) |

---

## 3. CDN & External Links in index.html, CSS, and JS

- **`dashboard/index.html`**:
  - Contains **0 external CDN or web links**.
  - All stylesheets are local: `css/base.css`, `css/layout.css`, `css/components.css`, `css/charts.css`.
  - All scripts are local: `js/config.js`, `js/app.js`, `js/charts.js`, `js/data.js`, `js/pages.js`, `js/schedule.js`.
  - Icons are Unicode emojis rendered natively by the OS (`🐷`, `📊`, `🌡️`, `💧`, `🚿`, `🧹`, `⚙️`, etc.).
- **`dashboard/css/*.css`**:
  - Contains **0 external fonts or remote stylesheets** (no Google Fonts `@import`, no FontAwesome).
  - Uses native system fonts: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
  - `url(#grad-temp)` in `charts.css` references local SVG `<defs>` within the generated SVG DOM.
- **`dashboard/js/*.js`**:
  - Contains **0 external libraries or CDNs** (charts are drawn using vanilla SVG DOM manipulation in `charts.js`).
- **Conclusion**: The entire dashboard frontend is 100% offline-compatible and self-contained, suitable for hosting directly out of ESP32 LittleFS.

---

## 4. ESP32 Firmware Deep-Dive (`main.cpp`)

- **GPIO Pin Allocations**:
  - `DHT_PIN 4`: DHT22 data pin.
  - `SDA_PIN 8`: I2C SDA for DS3231 RTC.
  - `SCL_PIN 9`: I2C SCL for DS3231 RTC.
  - `TRIG_PIN 16`: HC-SR04 ultrasonic trigger pulse.
  - `ECHO_PIN 17`: HC-SR04 ultrasonic echo pulse.
  - `RELAY_PIN 18`: Single-channel active-LOW relay for misting water pump.
  - `BATH_RELAY_PIN 7`: Defined as `#define BATH_RELAY_PIN 7` on line 83, but not initialized or used in `setup()` or `loop()`. (A comment notes: *"Bath relay functions removed — bath/clean schedules now drive the misting pump relay via server-polled state"*).
  - `FLOW_SENSOR_PIN 5`: YF-S201 water flow sensor interrupt input (`INPUT_PULLUP`).

- **Sensor Code**:
  - **DHT22**: Initialized with `dht.begin()`. Sampled every 3,000 ms via `dht.readTemperature()` and `dht.readHumidity()`. If `isnan()` is encountered, it triggers `pumpOff()` as a fail-safe.
  - **DS3231 RTC**: Initialized with `Wire.begin(8, 9)` and `rtc.begin()`. Sampled each cycle with `rtc.now()`. Time-adjust line `rtc.adjust(...)` is commented out.
  - **HC-SR04 Ultrasonic**: 10 µs pulse on `TRIG_PIN`, measured via `pulseIn(ECHO_PIN, HIGH, 30000)`. Distance calculation: `duration * 0.0343 / 2.0`. Tank level conversion: empty at 14.0 cm (`TANK_EMPTY_CM`), full at 3.0 cm (`TANK_FULL_CM`):
    $$\text{level} = \frac{14.0 - \text{distance}}{14.0 - 3.0} \times 100.0$$
  - **YF-S201 Flow Sensor**: Interrupt attached via `attachInterrupt(digitalPinToInterrupt(5), flowPulseISR, RISING)`. Increments `volatile unsigned long flowPulseCount`. Evaluated every 1,000 ms: calibration constant `FLOW_PULSES_PER_LITER = 450.0`. Calculates `flowRateLPM` and accumulates `totalWaterUsedL`.

- **Relay Logic**:
  - Active-LOW relay definition: `#define RELAY_ON LOW`, `#define RELAY_OFF HIGH`.
  - Initialized to `pumpOff()` (`HIGH`) in `setup()`.
  - Activation logic:
    ```cpp
    bool shouldMist = (thi >= THI_DANGER) || serverBathActive || serverCleanActive;
    if (shouldMist && waterLevel >= MIN_WATER_LEVEL) {
        pumpOn();
    } else {
        pumpOff();
    }
    ```

- **THI Thresholds**:
  - `const float THI_DANGER = 85.0;`
  - Formula:
    $$\text{THI} = 0.8 \times T + \left(\frac{\text{RH}}{100.0}\right) \times (T - 14.4) + 46.4$$
  - Triggers pump when `thi >= 85.0`.

- **`MIN_WATER_LEVEL`**:
  - Line 67: `const float MIN_WATER_LEVEL = 0;`
  - Acts as a dry-run safety gate: if water level is below 0% or sensor returns error (`-1.0`), the pump cannot run.

- **Infinite Loops (`while(1)`)**:
  - **Critical blocker found in `setup()` (lines 506-515)**:
    ```cpp
    if (!rtc.begin())
    {
        Serial.println("RTC NOT FOUND!");
        while (1)
        {
            delay(1000);
        }
    }
    ```
    **Consequence**: If the DS3231 RTC is disconnected, unpowered, or missing pull-ups on GPIO 8/9, the ESP32 completely freezes in this loop and never boots Wi-Fi, never reads DHT22/tank sensors, and never starts the web server/client.

- **Hardcoded Wi-Fi Credentials**:
  - STA Wi-Fi (connects to barn router):
    - SSID: `"Converge_2.4GHz_51BD"`
    - Password: `"Khe5ME92"`
  - AP Wi-Fi (ESP32 local hotspot):
    - SSID: `"ESP32-Misting-System"`
    - Password: `"12345678"`
  - Mode: `WiFi.mode(WIFI_AP_STA)` (runs SoftAP and Station simultaneously).
  - STA connection attempt timeout: 15,000 ms.

- **HTTP Client Code**:
  - **Polling `/api/status`**: Every 5,000 ms (`SCHEDULE_POLL_INTERVAL`) via `HTTPClient http` to `http://192.168.1.33:3000/api/status`. Performs manual substring matching for `"bathActive"` and `"cleanActive"` to set `serverBathActive` and `serverCleanActive`.
  - **Posting `/api/readings`**: Every 3,000 ms (`SENSOR_INTERVAL`), posts JSON `{"temp": ..., "humidity": ..., "device_id": "esp32-s3-01"}` to `http://192.168.1.33:3000/api/readings`.
  - **Posting `/api/water`**: Every 3,000 ms if `waterLevel >= 0`, posts JSON `{"level_pct": ..., "used_l": ..., "flow_lpm": ..., "device_id": "esp32-s3-01"}` to `http://192.168.1.33:3000/api/water`.

---

## 5. Backend Server Routes & Return Payloads (`server.js`)

Below is the complete reference of what each route in `server.js` returns so that an ESP32 local server can emulate and match them:

| Method & Route | Request Body / Query | Status | Response JSON Payload / Description |
|---|---|---|---|
| **`GET /api/status`** | None | 200 | Full system status object with `temp`, `humidity`, `thi`, `thiStatus`, `thiThresholds`, `operationDurations`, `malfunctions`, `diagnostics`, `waterLevel`, `waterUsed`, `flowRate`, `mistActive`, `bathActive`, `cleanActive`, `pumpActive`, `relayState`, `manualPumpActive`, `lastPumpTest`, `threshold`, `lastReadingTs`, `lastWaterTs`. |
| **`POST /api/readings`** | `{"temp": float, "humidity": float, "device_id": string}` | 201 | `{"ok": true, "thi": float}` *(Returns 400 if `temp` or `humidity` is not a number)* |
| **`POST /api/water`** | `{"level_pct": float, "used_l": float, "flow_lpm": float, "device_id": string}` | 201 | `{"ok": true, "level_pct": float, "used_l": float, "flow_lpm": float}` |
| **`GET /api/readings/history`** | Query `?range=24h` (`7d`, `30d`) | 200 | Array of `[{"time": "HH:MM", "ts": number, "temp": float, "humidity": float, "thi": float}]` |
| **`GET /api/water/weekly`** | None | 200 | Array of 7 objects: `[{"day": "Mon", "mist": 0, "bathe": 0, "clean": 0, "total": number}, ...]` |
| **`GET /api/schedules`** | Query `?type=bath` or `clean` | 200 | Array of `[{"id": number, "type": "bath", "label": string, "time": "HH:MM", "duration": number, "days": string[], "active": boolean}]` |
| **`POST /api/schedules`** | `{"type": string, "label": string, "time": "HH:MM", "duration": number, "days": string[]}` | 201 | Created schedule object including generated numeric `id` and `active: true`. |
| **`PATCH /api/schedules/:id`**| Partial of `{label, time, duration, days, active}` | 200 | Updated schedule object `{"id": id, ...}` *(404 if ID not found)* |
| **`DELETE /api/schedules/:id`**| None | 204 | Empty response body. |
| **`GET /api/schedules/debug`** | None | 200 | `{"serverTime": string, "serverTimezoneOffsetMinutes": number, "today": string, "nowMin": number, "bath": [...], "clean": [...]}` |
| **`GET /api/settings/threshold`**| None | 200 | `{"value": float}` (default 32) |
| **`POST /api/settings/threshold`**| `{"value": float}` | 200 | `{"value": float}` *(400 if value < 20 or > 50)* |
| **`GET /api/settings/durations`**| None | 200 | `{"mistDurationMin": float, "mistPauseSec": float}` |
| **`POST /api/settings/durations`**| `{"mistDurationMin": float, "mistPauseSec": float}` | 200 | `{"mistDurationMin": float, "mistPauseSec": float}` |
| **`GET /api/settings/thi`** | None | 200 | `{"normalMax": float, "stressMax": float, "extremeMax": float}` |
| **`POST /api/settings/thi`** | `{"normalMax": float, "stressMax": float, "extremeMax": float}` | 200 | `{"normalMax": float, "stressMax": float, "extremeMax": float}` |
| **`GET /api/reports/export`**| Query `?range=24h` | 200 | Raw CSV string with headers: `Timestamp,DateTime,Temperature_C,Humidity_Pct,THI,THI_Status` |
| **`GET /api/activity`** | Query `?limit=30` | 200 | Array of `[{"id": number, "ts": number, "type": string, "msg": string}]` |
| **`POST /api/relay/test`** | `{"duration_ms": number}` | 200 | `{"ok": true, "message": string, "lastPumpTest": {"ts": number, "duration_ms": number, "status": "Testing"}}` |
| **`POST /api/relay/control`**| `{"active": boolean}` | 200 | `{"ok": true, "manualPumpActive": boolean, "relayState": boolean}` |
| **`GET /api/relay/command`** | None (ESP32 command consumer) | 200 | `{"command": {"command": "test_pump"|"pump_on"|"pump_off", "duration_ms": number, "ts": number} | null, "manualPumpActive": boolean}` |
| **`POST /api/relay/status`** | `{"relay_on": bool, "test_completed": bool, "flow_pulses": number, "flow_lpm": number}` | 200 | `{"ok": true, "relayState": boolean, "lastPumpTest": object}` |
| **`POST /api/diagnostics`** | `{"dht_ok": bool, "rtc_ok": bool, "tank_ok": bool, "flow_ok": bool, "relay_ok": bool, "details": object|string}` | 201 | `{"ok": true, "diagnostics": object}` |
| **`GET /api/diagnostics`** | None | 200 | Latest diagnostic object or `{"ok": false, "msg": "No diagnostics recorded yet"}` |
| **`GET /api/health`** | None | 200 | `{"ok": true, "time": number}` |
| **Static Assets** | Path requests | 200 | Serves files from `../../dashboard` directory (`index.html`, `css/*`, `js/*`). |

---

## 6. Current `platformio.ini` & `data_dir` Value

File path: `arduino/ios_sensor_node/ios-sensor-node/platformio.ini`

### Verbatim Contents:
```ini
; PlatformIO Project Configuration File
;
;   Build options: build flags, source filter
;   Upload options: custom upload port, speed and extra flags
;   Library options: dependencies, extra library storages
;   Advanced options: extra scripting
;
; Please visit documentation for the other options and examples
; https://docs.platformio.org/page/projectconf.html

[env:esp32-s3-devkitc-1]
platform = espressif32
board = esp32-s3-devkitc-1         ; change this if you have a specific board
                           ; (e.g. esp32-s3-devkitc-1, esp32-c3-devkitm-1)s
                           ; run `pio boards esp32` to list options
framework = arduino

monitor_speed = 115200

lib_deps =
    adafruit/DHT sensor library@^1.4.6
    adafruit/RTClib@^2.1.4
    adafruit/Adafruit Unified Sensor@^1.1.14

board_build.filesystem = littlefs
data_dir = ../../../dashboard
```

### Key Configuration Metrics:
- **Target Environment**: `[env:esp32-s3-devkitc-1]`
- **Platform**: `espressif32`
- **Board**: `esp32-s3-devkitc-1`
- **Framework**: `arduino`
- **Filesystem**: `littlefs` (`board_build.filesystem = littlefs`)
- **`data_dir`**: `../../../dashboard` under `[platformio]` (not `[env:]` — PIO 6 ignores `data_dir` on the env section).
  - *Path resolution*: From `arduino/ios_sensor_node/ios-sensor-node/`, three directory steps upward point directly to the project root's `dashboard/` folder containing `index.html`, `css/`, and `js/`.

---

## Running log

### 2026-10-02 — Part 1 (firmware hosts dashboard + `/api/status`)

Done:
- LittleFS + Async web server on ESP32-S3. AP SSID remains `ESP32-Misting-System`. AP password and STA credentials moved to `src/secrets.h` (gitignored). Example file: `src/secrets.h.example`.
- `GET /api/status` returns live cached `temp`, `hum`/`humidity`, `thi`, `waterLevel`, `pumpOn` plus dashboard aliases `pumpActive`, `relayState`, `mistActive`.
- Existing DHT/RTC/tank/flow/relay and HTTP-client-to-PC backend code left in place.
- `pio run` SUCCESS (~30 s). RAM 14.3%, flash 30.0%. First build warned that `data_dir` under `[env:]` is unknown; moved to `[platformio]`.

Human must:
- Copy/edit `src/secrets.h` and set a real AP password (not `12345678`; current placeholder is `replace-with-ap-password`).
- Upload firmware **and** LittleFS (`uploadfs`) themselves.
- Connect to the AP, open `http://192.168.4.1/`, check serial for LittleFS mount, hit `/api/status`.

Not done yet (later parts): full `/api/status` payload (schedules, diagnostics, history), local schedule engine, dropping the PC HTTP client. RTC `while(1)` halt on missing DS3231 is unchanged. STA still uses `delay(500)` in `setupWiFi()` (not in `loop()`). `pio` is not on PATH; used `%USERPROFILE%\.platformio\penv\Scripts\pio.exe`.

### 2026-10-02 — Part 2 (dashboard relative URLs + /api/info helper)

CDN inventory (index.html, css/, js/): **none**. No Google Fonts, no unpkg/jsDelivr/CDNJS, no Chart.js/jQuery. Charts are local SVG (`http://www.w3.org/2000/svg` is a DOM namespace, not a network fetch). `dashboard/vendor/` was not created (nothing to vendor).

Hardcoded hosts removed from dashboard JS. `apiBase` stays `''`; all fetches use relative paths such as `/api/status`. Fallback when `IOS_CONFIG` is missing is also `''` (was `http://localhost:3000`). Comment IP `192.168.1.61:3000` removed from `config.js`.

`GET /api/info` helper in `js/config.js`: expects `{"mode":"device"}` or `{"mode":"cloud"}`; on failure/404 defaults to `"device"`; toggles `[data-mode]` visibility. No `data-mode` sections in HTML yet. Firmware and Node backend do **not** implement `/api/info` yet (helper 404 → device). Existing API routes unchanged.

Dashboard size: **141,902 bytes (138.58 KB)** across 11 files. **No file over 200 KB.**

Node static check (all 200): `/`, `/index.html`, `css/base.css`, `layout.css`, `components.css`, `charts.css`, `js/config.js`, `app.js`, `charts.js`, `data.js`, `pages.js`, `schedule.js`. `/api/info` is 404 on the backend (by design for this part).

`pio run` executed and verified: SUCCESS (15.61 s, RAM: 14.3%, Flash: 30.0%).

### 2026-10-09 — Part 3 (non-blocking sensor reads + HTTP client removal + live /api/status)

Done:
- **HTTP client code removed from firmware**:
  - Removed `#include <HTTPClient.h>` and HTTPClient library dependency.
  - Removed backend PC target configuration (`SERVER_HOST = "192.168.1.33"`, `SERVER_PORT = 3000`).
  - Removed backend schedule poller `pollScheduleStatus()`, `SCHEDULE_POLL_INTERVAL` (5,000 ms), and `lastSchedulePoll`.
  - Removed telemetry push functions: `sendDHTToBackend()` (POST `/api/readings`) and `sendWaterToBackend()` (POST `/api/water`).
  - Removed unused `DEVICE_ID = "esp32-s3-01"`.
  - Removed all HTTP client calls from `loop()`.
- **Non-blocking sensor reads with `millis()` timers**:
  - **DHT22**: Sampled on 3,000 ms timer (`DHT_INTERVAL`). Same pin (`DHT_PIN 4`) and THI formula (`0.8*T + (RH/100)*(T - 14.4) + 46.4`). NaN readings set values to `NAN` and fail-safe the pump without halting or returning early from `loop()`.
  - **HC-SR04**: Sampled on 2,000 ms timer (`DISTANCE_INTERVAL`). Same pins (`TRIG_PIN 16`, `ECHO_PIN 17`) and calculations (`duration * 0.0343 / 2.0`, tank level mapping: empty 14.0 cm, full 3.0 cm).
  - **YF-S201**: Calculated on 1,000 ms timer (`calculateWaterFlow()`). Same pin (`FLOW_SENSOR_PIN 5`, interrupt on RISING) and calculations (`FLOW_PULSES_PER_LITER = 450.0`, `flowRateLPM`, `totalWaterUsedL`).
  - **Wi-Fi reconnect**: Throttled with a 10,000 ms `millis()` timer in `loop()` to avoid thrashing the network stack when unconnected.
  - **Serial monitor reporting**: Output moved to a 3,000 ms `millis()` timer (`SERIAL_PRINT_INTERVAL`).
  - **Strictly zero `delay()` calls** in `loop()` or web request handlers.
- **`/api/status` returns real live values**:
  - Now returns live sensor states for `temp`, `humidity`, `hum`, `thi`.
  - Full `thiStatus` object (`label`, `cls`, `color`) matching dashboard THI thresholds.
  - `thiThresholds` (`normalMax: 74`, `stressMax: 78`, `extremeMax: 83`).
  - `operationDurations` (`mistDurationMin: 5`, `mistPauseSec: 30`).
  - `malfunctions: []`, `diagnostics: null`.
  - Real live `waterLevel`, `waterUsed` (`totalWaterUsedL`), and `flowRate` (`flowRateLPM`).
  - Live relay/pump states: `pumpOn`, `pumpActive`, `relayState`, `mistActive`.
  - Retains local schedule/manual flags: `bathActive: false`, `cleanActive: false`, `manualPumpActive: false`, `lastPumpTest: null`, `threshold: 32`.
- **Pump logic untouched**:
  - Condition: `(!isnan(lastThi) && lastThi >= THI_DANGER) || serverBathActive || serverCleanActive`.
  - Gate: `waterLevel >= MIN_WATER_LEVEL`.
- **`pio run` result**:
  - Built cleanly in release mode: SUCCESS (10.81 s).
  - RAM: 13.6% (used 44,624 bytes of 327,680 bytes).
  - Flash: 24.7% (used 826,677 bytes of 3,342,336 bytes — saved ~178 KB by eliminating HTTPClient).

### 2026-10-09 — Part 4 (DS3231 fault tolerance + POST /api/time + UTC storage + Set Time UI)

Done:
- **DS3231 failure unblocked**:
  - Removed fatal `while(1)` freeze on `!rtc.begin()`.
  - Added global `rtcOk = false` flag on init error, logs `ERROR: RTC DS3231 NOT FOUND! Continuing without RTC.`, and proceeds to initialize all other hardware, Wi-Fi, and HTTP server.
  - Safe guards around `rtc.now()` in `loop()` / serial printing / `/api/status` to prevent I2C bus hangs when RTC is absent.
- **RTC stored in UTC & conversion to local only for display**:
  - **Design decision**: Hardware RTC registers and timestamps are strictly kept in UTC (`epoch` in seconds, matching standard Unix timestamp).
  - Conversion to local time (UTC+8 / Asia/Manila, Philippine Standard Time via `LOCAL_TIMEZONE_OFFSET_SEC = 28800`) happens **only** at the presentation layer:
    - Serial monitor display (`printStatusToSerial`) converts UTC `DateTime` to UTC+8 for human readability.
    - Dashboard display converts UTC epoch to local time via JavaScript `new Date((epoch + elapsed) * 1000).toLocaleTimeString()`.
  - Storing UTC avoids Daylight Saving shifts, timezone ambiguities, and clock skew in upcoming offline scheduling engines.
- **POST `/api/time` endpoint**:
  - Accepts JSON payload: `{"epoch": <UTC seconds>}`.
  - Validates `epoch` is present, numeric, and within valid range (`1704067200` [2024-01-01] to `4102444799` [2099-12-31]). Rejects bad formats or millisecond values with HTTP 400.
  - Attempts `rtc.begin()` if RTC was previously disconnected. Returns HTTP 503 if RTC hardware remains unavailable.
  - Calls `rtc.adjust(DateTime((uint32_t)epoch))` to calibrate RTC hardware.
  - Returns `{"ok": true, "epoch": <number>, "rtcOk": true}`.
- **GET `/api/info` endpoint**:
  - Returns `{"mode": "device"}` for dashboard device/cloud mode discovery.
- **`/api/status` enhancements**:
  - Added `rtcOk` (boolean).
  - Added `epoch` (live UTC seconds if `rtcOk == true`, else `null`).
- **Dashboard "Set time" button (device mode only)**:
  - Added `#btn-sync-time-top` in `#topbar .topbar-right` with `data-mode="device"`.
  - Added RTC synchronization status card with `#btn-set-time` in `#page-auto` (Automation / Settings page) with `data-mode="device"`.
  - Clicking "Set time" extracts current browser/phone UTC epoch (`Math.floor(Date.now() / 1000)`) and calls `POST /api/time`.
  - Topbar `#live-time` displays live synchronized RTC device clock converted to browser's local time, or `RTC Error` if RTC is offline.
  - Settings page `#rtc-status-text` displays live RTC status (`OK (Synchronized)` / `OK` / `Hardware Error / Not Detected`).
- **`pio run` result**:
  - Built cleanly in release mode: SUCCESS (5.55 s).
  - RAM: 13.6% (used 44,632 bytes of 327,680 bytes).
  - Flash: 25.0% (used 837,165 bytes of 3,342,336 bytes).

### 2026-10-09 — Part 5 (unified updatePump engine + misting cycle + manual override + constants)

Done:
- **Unified `updatePump()` engine function**:
  - Implemented single function called in `loop()` evaluating:
    `pumpOn = waterOk && (thiTrigger || scheduled || manual)`.
  - Dispatches physical active-LOW relay commands via `pumpOn()` / `pumpOff()`.
- **Water safety threshold (`waterOk`)**:
  - Replaced legacy `MIN_WATER_LEVEL = 0` with `const float MIN_WATER_LEVEL_PCT = 10.0;`.
  - `waterOk = (lastWaterLevel >= MIN_WATER_LEVEL_PCT)`. Blocks pump activation on empty/low tank (<10%) or sensor error (`-1.0`).
- **Single THI threshold constant**:
  - `const float THI_THRESHOLD = 85.0;`.
  - **Kept value vs old**: Kept `85.0` (from the original firmware `THI_DANGER = 85.0` misting setpoint). The old backend classification had two intermediate tiers: `78.0` (`stressMax`) and `83.0` (`extremeMax`). Threshold `85.0` triggers cooling when severe heat stress danger is entered.
- **Misting duty cycle**:
  - Uses `const unsigned long MIST_DURATION_MIN = 5;` (5 minutes ON) and `const unsigned long MIST_PAUSE_SEC = 30;` (30 seconds pause).
  - State machine uses non-blocking `millis()` tracking to oscillate `thiTrigger` between ON and PAUSE phases while THI remains above `THI_THRESHOLD`.
- **Manual override with automatic timeout (`POST /api/manual`)**:
  - `const unsigned long MANUAL_DEFAULT_RUN_MS = 60000;` (1 minute default).
  - `const unsigned long MANUAL_MAX_RUN_MS = 180000;` (3 minutes safety maximum).
  - Endpoint `POST /api/manual` parses JSON (e.g. `{"active": true, "duration_sec": 60}` or `{"active": false}`) and sets flags with `manualExpiryTime`. Zero `delay()`.
  - Automatically turns off when `millis() >= manualExpiryTime`.
  - Also aliased `/api/relay/control` and `/api/relay/test` for seamless dashboard compatibility.
- **Scheduled operation**:
  - `scheduled = false` (stub for now, pending local schedule engine in Part 6).
- **`/api/status` additions**:
  - `pumpState`: `"ON"` or `"OFF"`.
  - `pumpReason`: `"manual"`, `"scheduled"`, `"thi_cooling"`, `"low_water"`, `"mist_pause"`, or `"idle"`.
- **New constants summary**:
  - `MIN_WATER_LEVEL_PCT = 10.0`
  - `THI_THRESHOLD = 85.0`
  - `MIST_DURATION_MIN = 5`
  - `MIST_PAUSE_SEC = 30`
  - `MANUAL_DEFAULT_RUN_MS = 60000`
  - `MANUAL_MAX_RUN_MS = 180000`
- **`pio run` result**:
  - Built cleanly in release mode: SUCCESS (5.34 s).
  - RAM: 13.6% (used 44,648 bytes of 327,680 bytes).
  - Flash: 25.2% (used 841,493 bytes of 3,342,336 bytes).




### 2026-10-09 — Part 6 (LittleFS schedule persistence + /api/schedules CRUD + isScheduleActiveNow C++ port)

Done:
- **`/schedules.json` on LittleFS**:
  - `loadSchedules()` called in `setup()` immediately after `LittleFS.begin()` succeeds.
  - Missing file → `scheduleCount = 0` (empty list); no starter file is written — device creates it on first `POST /api/schedules`.
  - `saveSchedules()` is called **only** when data changes (POST/PATCH/PUT/DELETE). GET is pure read, no flash write.
- **JSON shape** (exact match of `dashboard/js/schedule.js`):
  - `id` (string, e.g. `"s1"`) — server-assigned monotone counter (`nextScheduleId`).
  - `type` (`"bath"` | `"clean"`) — matches dashboard `_modalType`.
  - `label` (string) — matches dashboard `Bath HH:MM` / `Clean HH:MM` auto-label.
  - `time` (`"HH:MM"`) — local time (UTC+8) string, matches `modal-time` input.
  - `duration` (integer minutes) — matches `modal-dur` input.
  - `days` (array of `"Mon"`,`"Tue"`,`"Wed"`,`"Thu"`,`"Fri"`,`"Sat"`,`"Sun"`) — matches dashboard `DAYS` array and `_selectedDays`.
  - `active` (boolean) — toggle state, matches `s.active` in renderList.
- **REST endpoints** (all use exactly the dashboard call signatures):
  - `GET /api/schedules?type=bath|clean` → JSON array of matching schedules.
  - `POST /api/schedules` `{ type, label, time, duration, days[] }` → 201 + new schedule object.
  - `PATCH /api/schedules/{id}` `{ active: bool }` → 200 + updated object. (Dashboard calls `PATCH` for toggle.)
  - `PUT /api/schedules/{id}` — accepted for full updates (same handler as PATCH).
  - `DELETE /api/schedules/{id}` → 204 No Content.
- **`isScheduleActiveNow()` C++ port** (faithful port of the JS logic from `schedule.js`):
  - Returns `false` immediately if `!s.active`, `!rtcOk`, or `s.dayCount == 0`.
  - Reads UTC from `rtc.now()` then converts to local (UTC+8) via `TimeSpan(LOCAL_TIMEZONE_OFFSET_SEC)`.
  - Gets `dayOfTheWeek()` (0=Sun...6=Sat, same convention as JS `Date.getDay()`).
  - Computes `nowMinutes = hour*60 + minute`, `startMin` (parsed from `"HH:MM"` with `sscanf`), `endMin = startMin + duration`.
  - **Midnight-crossing** (`endMin > 1440`): checks `nowDow == schedDow && nowMinutes >= startMin` OR `nowDow == nextDow && nowMinutes < (endMin - 1440)`. Identical to JS logic.
  - Normal window (`endMin <= 1440`): `nowDow == schedDow && nowMinutes in [startMin, endMin)`.
  - `dayStringToRtcDow()` translates `"Mon"`...`"Sun"` -> 0...6 using RTClib's convention (0=Sunday).
- **`anyScheduleActive()`**: iterates all loaded schedules, returns `true` on first match.
- **`updatePump()` wired**: replaced `bool scheduled = false;` stub with `bool scheduled = anyScheduleActive();`.
- **`setupScheduleRoutes(server)`** called at the top of `setupWebServer()`, registering all 5 HTTP handlers before other routes.
- **`MAX_SCHEDULES = 20`** guard prevents runaway flash writes; returns HTTP 507 when full.
- **Dashboard fields matched**: all 7 fields (`id`, `type`, `label`, `time`, `duration`, `days[]`, `active`) are fully implemented. No dashboard fields were unmatched.
- **`pio run` result**:
  - Built cleanly in release mode: SUCCESS (9.22 s).
  - RAM: 14.3% (used 46,800 bytes of 327,680 bytes).
  - Flash: 26.4% (used 881,621 bytes of 3,342,336 bytes).
