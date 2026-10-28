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

### 2026-10-09 — Part 7 (NVS Preferences settings + 24h RAM ring buffer history + LittleFS periodic persistence)

Done:
- **Settings persisted via Preferences (NVS)**:
  - Stored in `"ios_settings"` NVS namespace with keys under 15 characters (`thi_thresh`, `temp_thresh`, `thi_norm`, `thi_stress`, `thi_extr`, `mist_dur`, `mist_pause`, `min_water`).
  - Runtime settings variables initialized with defaults:
    - `thiThreshold = 85.0f` (cooling trigger setpoint)
    - `tempThreshold = 32.0f` (slider threshold)
    - `thiNormalMax = 74.0f` (Normal upper bound)
    - `thiStressMax = 78.0f` (Stressful upper bound)
    - `thiExtremeMax = 83.0f` (Extreme Heat upper bound)
    - `mistDurationMin = 5.0f` (mist run duration)
    - `mistPauseSec = 30.0f` (mist pause duration)
    - `minWaterLevelPct = 10.0f` (water safety gate)
  - `loadSettings()` called at boot in `setup()`.
  - `saveSettings()` called whenever settings change via HTTP.
  - REST endpoints implemented matching dashboard and Node backend:
    - `GET /api/settings` & `POST /api/settings`: unified full configuration object.
    - `GET /api/settings/threshold` & `POST /api/settings/threshold`: `{ "value": 32 }`.
    - `GET /api/settings/durations` & `POST /api/settings/durations`: `{ "mistDurationMin": 5, "mistPauseSec": 30 }`.
    - `GET /api/settings/thi` & `POST /api/settings/thi`: `{ "normalMax": 74, "stressMax": 78, "extremeMax": 83 }`.
  - Wired into `updatePump()` (dynamic THI trigger setpoint, mist duty cycle, water safety gate) and `handleStatus` (`/api/status` returns dynamic thresholds, durations, and dynamic `thiStatus` tier classification).
- **Readings History (~24h RAM ring buffer with RTC timestamps)**:
  - 288-record circular ring buffer in static RAM (`HISTORY_CAPACITY = 288`, 5-minute sampling interval = 24 hours).
  - Populates first reading immediately on boot once valid DHT reading is available, then every 5 minutes (`HISTORY_SAMPLE_INTERVAL_MS = 300000`).
  - Timestamps generated from UTC DS3231 RTC (`ts` in milliseconds, `time` in local UTC+8 `"HH:MM"`).
  - REST endpoints `GET /api/readings` and `GET /api/readings/history` (queried with `?range=24h` by `dashboard/js/data.js`).
  - Response streams chronological JSON array matching dashboard chart shape (`time`, `ts`, `temp`, `humidity`, `thi`) using `AsyncResponseStream` to prevent heap fragmentation.
- **LittleFS Periodic History Persistence (Minimal flash writes)**:
  - Persisted to `/history.json` on LittleFS.
  - Flush interval: constant 5 minutes (`HISTORY_SAVE_INTERVAL_MS = 300000`).
  - Flash wear protection: only writes to LittleFS if new readings were added (`historyDirty == true`), avoiding flash writes during sensor fault or idle.
  - Reloaded at boot via `loadHistory()` in `setup()` immediately after LittleFS mounts.
- **Auxiliary Routes**:
  - `GET /api/water/weekly`: returns 7-day water structure to avoid 404 logs from dashboard polling.
  - `GET /api/diagnostics`: returns hardware sensor test status.
- **`pio run` result**:
  - Built cleanly in release mode: SUCCESS (24.52 s).
  - RAM: 17.1% (used 56,128 bytes from 327,680 bytes — only +9,328 bytes for 24h history buffer + Preferences).
  - Flash: 26.9% (used 898,445 bytes from 3,342,336 bytes).

---

### 2026-10-09 — Part 8 (Token-based access control for control routes)

**Goal**: No Wi-Fi credentials or passwords in committed source. All mutating/control routes protected by a simple bearer token; read-only routes stay fully open.

**`secrets.h` / `.gitignore`**:
- `AUTH_TOKEN` added to `src/secrets.h` (gitignored). Never committed.
- `src/secrets.h.example` updated as a committed template so collaborators know what to create.
- Root `.gitignore` entries: `secrets.h` and `**/secrets.h` (belt-and-suspenders alongside the arduino-level `src/secrets.h` rule already present).

**Firmware (`main.cpp`)**:
- `isAuthorized(AsyncWebServerRequest*)` helper — checks in order:
  1. `X-Auth-Token: <token>` header (primary — what the dashboard sends).
  2. `Authorization: Bearer <token>` header (fallback for API clients).
  3. `?token=<token>` query param (last resort / curl one-liners).
  - Returns `true` unconditionally when `AUTH_TOKEN` is empty (open/dev mode).
- `sendUnauthorized(AsyncWebServerRequest*)` — sends HTTP 401 JSON:
  `{"ok":false,"error":"Unauthorized: Invalid or missing access token"}`.
- Auth guard applied to **all 11 mutating routes** (first statement inside each lambda):
  - `POST /api/schedules` (create)
  - `PATCH /api/schedules/*` and `PUT /api/schedules/*` (update / toggle)
  - `DELETE /api/schedules/*`
  - `POST /api/settings` (bulk)
  - `POST /api/settings/threshold`
  - `POST /api/settings/durations`
  - `POST /api/settings/thi`
  - `POST /api/time`
  - `POST /api/manual`
  - `POST /api/relay/control`
  - `POST /api/relay/test`
- **Read-only GET routes remain open** (no token required): `/api/status`, `/api/schedules`, `/api/readings`, `/api/readings/history`, `/api/settings/*`, `/api/diagnostics`, `/api/water/weekly`, `/api/info`.
- Global CORS headers via `DefaultHeaders::Instance()` expose `X-Auth-Token` and `Authorization` so browsers allow them from the dashboard origin.
- `server.onNotFound` handler: replies `204` to `OPTIONS` preflight; `404 JSON` to all other unknown paths.

**Dashboard**:
- `dashboard/js/config.js` — full rewrite:
  - `getAuthToken()` / `setAuthToken()` read/write `localStorage['ios_auth_token']`.
  - `promptForToken(message)` — shows `window.prompt` with server error message as context.
  - `authFetch(url, options)` — wrapper around `fetch()`:
    - For mutating methods (POST/PATCH/PUT/DELETE) attaches both `X-Auth-Token` and `Authorization: Bearer` headers from the stored token.
    - On `401` response: extracts `error`/`msg` from JSON body, prompts user for new token, stores it, retries the request **once**.
  - All helpers exposed on `window` and `IOS_CONFIG`.
- `dashboard/js/data.js` — `postJSON()` now calls `authFetch`; extracts 401 error body before throwing.
- `dashboard/js/schedule.js` — `createSchedule`, `toggleScheduleActive`, `deleteScheduleById` use `authFetch`.
- `dashboard/js/app.js` — settings save handlers use `authFetch`; `initTokenControls()` wires the `🔑 Token` topbar button to `promptForToken`; `boot()` calls `initTokenControls()`.
- `dashboard/index.html` — `🔑 Token` button added to `topbar-right` for manual token entry at any time.

**`pio run` result**:
- Built cleanly in release mode: SUCCESS (24.52 s).
- RAM: 17.1% (used 56,120 bytes from 327,680 bytes — +0 bytes vs Part 7; auth is pure logic, no heap).
- Flash: 26.9% (used 900,609 bytes from 3,342,336 bytes — +2,164 bytes for auth helpers and CORS/404 handlers).

### 2026-10-13 — Part 9 (MicroSD Offline Storage & Automatic Backend Database Synchronization)

**Goal**: Integrate a 6-pin SPI MicroSD card module (CS: GPIO 10, MOSI: GPIO 11, SCK: GPIO 12, MISO: GPIO 13) for persistent offline data logging whenever the ESP32-S3 cannot reach the Windows laptop backend server. Automatically synchronize pending offline readings with the Node.js/Express SQLite database once the server reconnects, with zero data loss, duplicate prevention, and zero disruption to real-time pump controls.

**Hardware & SPI Wiring**:
- Module: 6-pin SPI MicroSD breakout module.
- ESP32-S3 GPIO Mapping:
  - `CS`: GPIO 10 (Chip Select)
  - `MOSI`: GPIO 11 (SPI Data Output)
  - `SCK`: GPIO 12 (SPI Clock)
  - `MISO`: GPIO 13 (SPI Data Input)
  - `VCC`: 3.3V or 5V (ESP32-S3 GPIO pins are 3.3V; modules with onboard AMS1117-3.3V regulators and level shifters can take 5V, while bare 3.3V breakout boards must be connected to 3.3V).
  - `GND`: Common ground.
- SPI initialization: `SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN)`.
- Mount options: `SD.begin(SD_CS_PIN, SPI, 4000000, "/sd", 5, false)`. `format_if_empty` is strictly `false` to prevent accidental card formatting.

**Firmware (`main.cpp`)**:
- **Offline / Online State Machine**:
  - `backendOnline` flag determined via non-blocking health check (`GET http://<BACKEND_HOST>:<PORT>/api/health`) every 20 seconds (`BACKEND_HEALTH_CHECK_INTERVAL_MS = 20000`).
  - Fast 1,500 ms connection timeout avoids blocking sensor sampling or pump control loops.
  - If Wi-Fi is disconnected or health check fails, `backendOnline` transitions to `false`.
- **MicroSD Data Logging (`/ios/offline_readings.jsonl`)**:
  - Automatically triggered on the 5-minute telemetry interval (`handleTelemetrySample()`) whenever offline or whenever unsynchronized pending records exist.
  - Appends independent, single-line JSONL records containing:
    - Stable record ID: `esp32-<epoch>-<seq>`
    - Original DS3231 UTC timestamp: `ts` / `ts_ms` (milliseconds)
    - Validated RTC status: `rtc_valid: true/false`. If RTC is invalid/lost power, `ts` is explicitly `null` (not fabricated uptime) and `uptime_ms` is recorded.
    - Sensor data: `temp` (°C), `humidity` (% RH), `thi` (swine index), `thi_label` (Normal, Stressful, Extreme Heat, Danger Zone)
    - Water management: `water_level` / `water_level_pct` (%), `flow_lpm` (L/min), `water_used` / `water_used_l` (L)
    - Pump control: `pump_on` (boolean), `pump_reason` (thi_cooling, manual, scheduled, low_water, mist_pause, idle).
  - File is append-only; full file is never loaded into RAM.
- **Crash-Resilient Progress Tracking (`/ios/sync_pos.json`)**:
  - Tracks confirmed synchronized byte offset (`synced_offset`), total synced records (`synced_count`), and last sync timestamp (`last_sync_ts`).
  - Saved to SD card only after server acknowledgment.
  - Boot recovery: `calculatePendingRecords()` seeks to `synced_offset` and counts remaining `\n` to end of file, accurately calculating `sdPendingCount` without loading records into memory.
- **Automatic Batch Synchronization (`syncBatch()`)**:
  - When `backendOnline == true && sdPendingCount > 0`:
    - Reads small batch of 15 records (`SYNC_BATCH_SIZE = 15`) from `sdSyncedOffset`.
    - Dispatches HTTP `POST /api/readings/batch` with 3,500 ms timeout.
    - Runs once every 500 ms (`SYNC_BATCH_INTERVAL_MS`), yielding CPU to main loop so pump control and sensor sampling never stall.
    - On HTTP 200/201 response with matching `accepted_ids`: advances `sdSyncedOffset`, decrements `sdPendingCount`, updates `lastSyncTs`, and saves `sync_pos.json`.
    - On failure: marks `backendOnline = false` and pauses sync without advancing offset.
- **Diagnostics & Status Endpoints**:
  - Enhanced `/api/status`: includes `sdStatus` ("Ready" | "Missing" | "Error"), `backendOnline`, `pendingOfflineCount`, `lastSyncTs`, `syncInProgress`.
  - Enhanced `/api/diagnostics`: includes `sd_ok` and hardware details.
  - Added `/api/sd/status` and `/api/offline/status`.
  - Serial monitor output periodically logs MicroSD state, pending queue count, and backend online/offline mode.

**Backend (`ios-backend/src/db.js` & `src/server.js`)**:
- `POST /api/readings/batch`: accepts up to 100 JSON records within a single SQLite transaction.
- `insertOfflineBatch(records)`:
  - Uses `INSERT OR IGNORE INTO offline_readings` keyed by stable `id`.
  - Auto-mirrors valid records into `readings` and `water_readings` tables so historical trend charts reflect offline periods.
  - Idempotency & Retry Safety: duplicate records from retransmissions (when acknowledgments are dropped) are acknowledged in `accepted_ids` without inserting duplicate rows.
  - Accepts both field naming variants (`water_level` / `water_level_pct`, `water_used` / `water_used_l`).
- `GET /api/offline/status`: returns total synced records and latest sync timestamp.
- `GET /api/health`: lightweight ping returning `{"ok":true,"time":...}`.

**Dashboard Frontend**:
- Topbar & Sidebar: connection dot and label reflect both ESP32 connectivity and backend status:
  - Green: "Online · Backend Connected"
  - Amber: "Offline Mode · Backend Unreachable" (local AP active, monitoring continuing)
  - Red: "Disconnected · Device Unreachable"
- Automation page (`#page-auto`): added dedicated "MicroSD Offline Storage & Automatic Synchronization" status card:
  - MicroSD Card: Ready (Mounted) / Missing / Error badge
  - Backend Database: Online (Connected) / Offline (Unreachable) badge
  - Pending Offline Records: realtime counter (e.g. "0 pending" or "N pending")
  - Sync Status: "Idle" or "🔄 Synchronizing…" with timestamp of last successful sync.
- Diagnostics grid: added MicroSD SPI Storage status item.

**`pio run` result**:
- Built cleanly in release mode: SUCCESS (32.30 s).
- RAM: 17.6% (used 57,732 bytes of 327,680 bytes — +1,612 bytes for SD/SPI + HTTPClient).
- Flash: 29.8% (used 997,477 bytes of 3,342,336 bytes — +96,868 bytes for SPI, SD, and HTTPClient libraries).

---

### Part 10: Schedule and Configuration Saving Fixes, Misting Schedules, and Water-Level Sensor Enhancements

#### 1. Diagnosis & Fixes for "Failed to Save"
- **Root Cause 1 (Backend SQLite CHECK constraint)**: The `schedules` table schema originally had `CHECK(type IN ('bath','clean'))`. Any attempt to create or query a schedule outside of these two types rejected the operation.
  - *Fix*: In [db.js](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/ios-backend/src/db.js), extended the table schema to `CHECK(type IN ('bath','clean','mist'))` and implemented an automatic startup table migration `migrateSchedulesType()` using `ALTER TABLE ... RENAME` + recreation to preserve existing user schedules without database reset.
  - *Fix*: In [server.js](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/ios-backend/src/server.js), updated `GET /api/schedules`, `POST /api/schedules`, and `GET /api/schedules/debug` type validation from `['bath','clean']` to `['bath','clean','mist']`.
- **Root Cause 2 (Dashboard DOM Mapping)**: In `schedule.js`, `reloadList()` had hardcoded element lookups assuming only `bath` and `clean`. Creating a schedule of another type failed silently or threw errors when updating count badges.
  - *Fix*: Added dynamic ID mapping in [schedule.js](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/dashboard/js/schedule.js) supporting `mist`, `bath`, and `clean` with dedicated toast alerts, icons (`🌫️`, `🚿`, `🧹`), and list views.
- **Root Cause 3 (Corruptible LittleFS File Writes on ESP32)**: Direct writes to `/schedules.json` could leave zero-byte or corrupt files if interrupted by a power cut.
  - *Fix*: In [main.cpp](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/arduino/ios_sensor_node/ios-sensor-node/src/main.cpp), changed `saveSchedules()` to use atomic file replacement: write to `/schedules.tmp`, verify serialization, close, remove old file, and rename to `/schedules.json`.

#### 2. Multi-Relay Operation Logic
- **Misting (GPIO 18, Active-LOW)**:
  - Activates when THI exceeds threshold (`thi_cooling`), during active misting schedules (`type: "mist"`), or via manual pump override.
  - Subject to water level gate: automatically shuts off when water level is below `minWaterLevelPct`.
- **Bathing (GPIO 7, Active-LOW)**:
  - Activates strictly during scheduled bathing windows (`type: "bath"`).
  - Controlled by dedicated `bathOn()` and `bathOff()` routines on `BATH_RELAY_PIN` (GPIO 7).
  - Subject to water level gate to prevent dry pump running.
- **Cleaning (No Physical Hardware Assigned Yet)**:
  - Schedules can be created, edited, toggled, and persisted safely in LittleFS and SQLite.
  - The firmware tracks active cleaning periods and logs them, but intentionally leaves both GPIO 18 and GPIO 7 in their OFF states to prevent cross-activating the wrong line.
- **Relay Safety & Priority**:
  - `updatePump()` evaluates operations independently rather than collapsing them into a single relay.
  - Reason strings in `/api/status`: `manual` > `scheduled` > `thi_cooling` > `low_water` > `mist_pause` > `idle`.

#### 3. HC-SR04 Water-Level Sensor Repairs
- **Root Cause for `null`**: In the API, `waterLevel` was serialized as `null` whenever `lastWaterLevel < 0.0`. When `pulseIn()` timed out or returned `0` (no echo pulse received within 30ms), `readDistance()` immediately returned `-1.0`, keeping `lastWaterLevel` at `-1.0` indefinitely.
- **Software Enhancements**:
  - In [main.cpp](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/arduino/ios_sensor_node/ios-sensor-node/src/main.cpp):
    - Added clean 4µs pre-trigger LOW grounding and clean 10µs trigger pulse.
    - Added an automatic 1ms retry if the first pulse return is 0 to filter transient noise.
    - Clamped calculated water level percentage strictly between `0.0%` and `100.0%`.
    - In `updatePump()`, when `lastWaterLevel < 0.0` (sensor error), effective water level is treated as `0.0%` (safe state) so the system defaults to low-water protection instead of risking dry pump damage.
- **Hardware Notes for Users**:
  - HC-SR04 operates at 5V VCC and outputs a 5V logic ECHO pulse. The ESP32-S3 GPIO pins operate at 3.3V logic.
  - If the water level remains `null` on hardware, ensure a voltage divider (e.g. 1kΩ / 2kΩ resistors) or a 5V-to-3.3V logic level shifter is installed on the HC-SR04 ECHO line (GPIO 17).
  - Verify that HC-SR04 VCC is connected to 5V (not 3.3V, as HC-SR04 requires 5V to fire ultrasonic transducers properly).

#### 4. Dashboard Enhancements
- Added **"🌫️ Misting Schedule"** tab to sidebar navigation and page view in [index.html](file:///c:/Users/vinch/IOS-Internet-Of-Swine-/dashboard/index.html).
- Added `page-mist` container with schedule counter and "+ Add Schedule" modal launcher.
- Updated `schedule.js` modal logic with preset defaults (11:00 AM, 5 min duration, Mon/Wed/Fri) and dynamic icons.
- Updated pump status description to list both GPIO 18 (Misting) and GPIO 7 (Bathing).

#### 5. Verification Results
- **PlatformIO Compilation (`pio run`)**:
  - Status: **SUCCESS** (28.59 s)
  - RAM: 17.6% (57,740 bytes of 327,680 bytes)
  - Flash: 29.9% (998,093 bytes of 3,342,336 bytes)
- **Backend Node.js Verification**:
  - SQLite table auto-migration executed cleanly.
  - Schedule CRUD unit test for `type: "mist"` (create, update, toggle active, list, delete) executed with 100% pass rate.



---

### Phase 1 Bug & Logic Fixes Summary (2026-10-28)

1. **BUG-05 (Water Counter & Rollover Persistence)**:
   - NVS namespace `"ios_water"` persists `todayWaterUsedL`, `totalWaterUsedL`, `mistWaterUsedL`, `bathWaterUsedL`, `cleanWaterUsedL`, `otherWaterUsedL`, and `lastWaterDay`.
   - Restored on boot via `loadWaterCounters()`. Handles power drops across midnight by archiving previous day usage.
   - Throttled persistence: immediately on relay-off (`pumpOff()`, `bathOff()`, `cleanOff()`), on midnight rollover, and every 5 minutes in `loop()` if water volume increased.

2. **BUG-06 (30-Day Persisted Water History Ring in Device Mode)**:
   - LittleFS ring buffer stored in `/water_daily.json` (up to 30 days).
   - Functions `loadDailyWaterHistory()`, `saveDailyWaterHistory()`, `recordCompletedDayWater(...)`.
   - `/api/water/weekly` and `/api/water/usage` now return real historical days instead of hardcoded 0.0 values, computing totals dynamically.

3. **BUG-07 (Device-Mode Reports Graceful Fallback)**:
   - In `main.cpp`, `/api/readings`, `/api/readings/history`, and `/api/reports/export` no longer reject `7d` and `30d` with HTTP 400; they return available 24h history with `X-Limited-History: 24h`.
   - In `data.js`, default report range is set to `'24h'` in device mode.
   - In `pages.js` and `app.js`, `7d` and `30d` tabs in `#page-reports` are disabled early in device mode.

4. **BUG-01 (Backend Total Count)**:
   - In `db.js` line 385, updated `total: count + offlineCount`.

5. **BUG-04 (Session TTL Overflow Safety)**:
   - Replaced flawed `now < createdAt` with overflow-safe unsigned subtraction `(uint32_t)(nowMs - adminSessions[i].createdAtMs) > (ADMIN_SESSION_TTL_SEC * 1000UL)`.
   - Oldest session lookup in `createAdminSession()` safely selects maximum elapsed milliseconds.

6. **LOGIC-01 (THI Boundary Consistency)**:
   - Aligned classification and alert thresholds across `server.js`, `data.js`, `pages.js`, and `main.cpp`:
     - Normal: `< normalMax`
     - Stressful: `< stressMax`
     - Extreme Heat: `< extremeMax` (triggers `WARNING: Extreme heat stress detected`)
     - Danger Zone: `>= extremeMax` (triggers `DANGER: THI exceeds extreme limit`)

7. **LOGIC-02 (Cloud vs. Device Session Auto-Resume)**:
   - `app.js` auto-resumes on network error only when `IOS_CONFIG.mode === 'device'`.
   - In cloud mode, network failures display an informative message and do not bypass the login screen.

8. **SEC-01 (Sanitized Credentials & Startup Warning)**:
   - Replaced credentials leakage with generic `"Invalid credentials"` error in both `server.js` and `main.cpp`.
   - Added startup warning in `server.js` if `IOS_ADMIN_PASS` is not set.

9. **SEC-05 & SEC-06 (Endpoint Authentication & Dashboard authFetch Migration)**:
   - Added `requireAuth` (`isAuthorized`) to `/api/reports/export`, `/api/reports/summary`, `/api/water/usage`, `/api/water/weekly`, `/api/water/breakdown`.
   - Migrated dashboard CSV export buttons and data fetchers to `authFetch` with session credentials.

10. **PERF-04 (Non-blocking FreeRTOS syncBatch Task)**:
    - Moved `syncBatch()` from the main Arduino loop to `syncBatchTask` pinned to Core 0 with recursive mutex protection (`FsLock`), keeping Core 1 completely responsive for sensors and pump timing.

---

## 13. Phase 2 Implementation Summary (Committed & Verified)

1. **BUG-02 (Encapsulated Schedule Count)**:
   - Added `scheduleCount()` in `db.js` and removed raw `db.db` access in `server.js` (`db.scheduleCount() >= 20`).

2. **BUG-03 (404 on Missing Schedule Delete)**:
   - `DELETE /api/schedules/:id` checks SQLite changes count and returns `HTTP 404` with `{ ok: false, error: 'Schedule not found' }` if 0 rows were deleted.

3. **BUG-08 (Offset Truncation Guard & Idempotent Sync)**:
   - Clamped `sdSyncedOffset` to `fileSize` upon file truncation instead of resetting to 0.
   - Enhanced `db.js` `insertOfflineBatch` to check existing timestamps for clock-valid offline records, ensuring sync is strictly idempotent.

4. **LOGIC-03 (Preserve Water Consumption on Reboot)**:
   - In `calculateWaterUsageForRows()`, when `curr < prev` (reboot reset), `curr` is now added to `totalUsage`, capturing water consumed between the reboot and the first reading.

5. **LOGIC-04 (Today Water Breakdown Aligned to Local Date)**:
   - `db.js` `getWaterUsage()` now returns `todayBreakdown`.
   - `pages.js` `updateWater()` checks `todayBreakdown`, `today`, and matches `localDateStr` (`YYYY-MM-DD`). If absent, it renders 0.0 values rather than showing yesterday's breakdown.

6. **LOGIC-05 (Water Range Supports 24h, 7d, 30d)**:
   - `data.js` `refreshWaterUsage()` allows `'24h'`, `'7d'`, and `'30d'`.
   - ESP32 `/api/water/usage` accepts `?range=24h` and returns 1 day of water breakdown.

7. **LOGIC-07 (Align Schedule Duration Cap to 1440 Min)**:
   - Set `MAX_SCHEDULE_DURATION_MIN = 1440` in `schedule.js`.
   - Updated modal duration validation and `<input id="modal-dur" ... max="1440" />` in `index.html`.

8. **LOGIC-08 & LOGIC-09 (Pre-RTC Markers, Backfill & 24h Exclusion)**:
   - In `main.cpp`, `ActivityRecord` tracks `uptimeMs`. When the RTC synchronizes (NTP, backend time, manual `/api/time`), `backfillActivityTimestamps()` backfills any pre-RTC zero timestamps.
   - Filtered out `historyRing[idx].ts < 1704067200000ULL` or `historyRing[idx].ts < since` when `since > 0` in `/api/readings` and `/api/reports/export`.

9. **LOGIC-11 (Safe Schedule Deletion Rollback)**:
   - Replaced flawed index-based loop in `main.cpp` with a pre-deletion snapshot of `schedules` and `scheduleCount`, restoring cleanly from backup if LittleFS persistence fails.

10. **SEC-02 (Password Hashing & Timing-Safe Verification)**:
    - Node.js backend uses `crypto.scryptSync` with random salt and `crypto.timingSafeEqual` for admin login verification.
    - ESP32 firmware uses salted SHA-256 (`mbedtls_sha256`) and `constantTimeCompare` for password and token comparisons.

11. **PERF-02 (Activity Log RAM Buffering & Throttled Flush)**:
    - In `main.cpp`, `appendActivity()` writes to in-RAM circular buffer and marks `activityDirty = true`.
    - Log is flushed to LittleFS on a 60-second timer, upon accumulating 10 entries, or before shutdown, minimizing flash sector wear.

12. **PERF-03 (Incremental Pending Record Tracking)**:
    - `sdPendingCount` is updated incrementally on SD writes and batch completions without performing blocking full-file scans during regular operation.

---

## Phase 3 Summary: Edge Cases, Protocol Hardening & Efficiency

1. **LOGIC-06 (Preemption & Mist State Reset)**:
   - In `main.cpp`, when a scheduled bath or clean takes over (`shouldBath || shouldClean` or active `schedBath`/`schedClean`), the misting cycle tracking variables (`mistCycleRunning = false`, `mistInOnPhase = false`, `thiOffSince = 0`) are explicitly reset. This prevents phantom mist re-triggers upon conclusion of scheduled cycles.

2. **LOGIC-10 (Clean Up & Anchor in `weeklyWaterUsage()`)**:
   - In `db.js`, `weeklyWaterUsage()` anchors reference time directly to `Date.now()` during regular dashboard operation (zero database overhead), while preserving historical replay capability when `sinceMs` is provided. `querySince` uses `Math.min(sinceMs, startMidnightUtc)`.

3. **SEC-03 (Constant-Time Token Comparison)**:
   - In `server.js`, `isAuthorized()` compares `AUTH_TOKEN` using `crypto.timingSafeEqual` with matching length guards.
   - In `main.cpp`, token comparisons use `constantTimeCompare()` to eliminate timing attack vectors.

4. **SEC-04 (Single Standardized Authorization Header & Clean CORS)**:
   - In `dashboard/js/config.js`, `authFetch()` now emits only the standard `Authorization: Bearer <token>` header, eliminating redundant `X-Session-Token` and `X-Auth-Token` headers.
   - In `server.js` and `main.cpp`, readers continue supporting cookie fallback and standard Bearer parsing.
   - In `main.cpp`, CORS `Access-Control-Allow-Headers` has been cleaned up to `"Content-Type, Authorization"`.

5. **PERF-01 (Backend Status Caching with Event Invalidation)**:
   - In `server.js`, `GET /api/status` caches the full aggregated system status with a 2-second TTL (`STATUS_CACHE_TTL_MS = 2000`).
   - Mutations (schedule creation/update/deletion, threshold updates, duration changes, relay manual control) call `invalidateStatusCache()` for immediate consistency.

6. **PERF-05 (Idempotent Dashboard Polling Start/Stop)**:
   - In `dashboard/js/data.js`, `DATA.start()` includes a running guard (`let _running = false`). Calling `DATA.start()` when already active early-returns without duplicating polling intervals.
   - `DATA.stop()` safely clears and nullifies timers and resets `_running = false`.

7. **RELB-01 (Safe Integer Indexing for Schedules)**:
   - In `main.cpp`, `idx` in schedule PATCH/PUT and DELETE routes was converted from `int8_t` to standard `int`, removing the unsafe narrowing cast and preventing overflow if `MAX_SCHEDULES` is increased.

8. **RELB-02 (Fixed Buffer Storage for SD Status & Error Strings)**:
   - In `main.cpp`, `sdLastError` was converted from a bare pointer `const char*` to a fixed-size `static char sdLastError[80]` buffer, manipulated safely via `strlcpy()` and cleared via `sdLastError[0] = '\0'`. This eliminates pointer aliasing and lifetime issues.
