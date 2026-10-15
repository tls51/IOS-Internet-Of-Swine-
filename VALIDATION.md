# Validation completed October 14, 2026

## Node and database

Tests used isolated copies of the uploaded database; the uploaded `ios.db` retains its original 6,925 environmental readings.

| Check | Result |
|---|---|
| Original Node Bath/Clean creation | Both return HTTP 201. The user's live rejection is not reproduced by the original backend routes. |
| Original report queries | 24h returns zero readings; unsupported `all` also falls back to 24h and returns zero. |
| Corrected All saved query | Returns all 6,925 original readings. |
| RTC-invalid telemetry import | An uptime of 120,000 ms is preserved separately. Its reading appears at receipt time in the current range. |
| Duplicate retry | No extra reading is inserted; its ID is still acknowledged. |
| Forced SQLite transaction failure | HTTP 500, `ok:false`, no accepted IDs. |
| CSV export | All 6,926 test readings appear: 6,925 original records plus one controlled import. |
| Reopen saved SQLite data | Readings and newly added schedules remain present. |
| JavaScript syntax | All eight JavaScript files pass `node --check`. |

## Interface

DOM interaction tests loaded the actual corrected scripts and called the local Node backend. Passed: Bath and Clean creation/reload, keeping the form open and showing a simulated HTTP 503 error, 24h/7d/30d/all fetches, single-reading SVG coordinates without NaN/Infinity, empty-chart messages and CSV download-link generation.

These are DOM interaction checks, rather than a full browser layout review. The attachments did not include your CSS and the available browser installation could not be downloaded. Keep your existing stylesheets.

## Firmware

**PASS: the delivered `main.cpp` compiles and links for ESP32-S3.**

Test environment:

- PlatformIO `espressif32` 6.10.0, Arduino-ESP32 2.0.17.
- Generic `esp32-s3-devkitc-1` board configuration (default N8 build).
- ESPAsyncWebServer 3.6.0, AsyncTCP 3.5.0, ArduinoJson 7.4.2.
- RTClib 2.1.4, Adafruit BusIO 1.17.4, DHT sensor library 1.4.6 and Adafruit Unified Sensor 1.1.15.
- Reported static RAM: 71,028 bytes. Firmware flash: 1,013,981 bytes.

The test build uses placeholder credentials. No firmware binary is included for flashing. Your actual `platformio.ini` and `secrets.h` were not attached; keep the board/flash/PSRAM settings for your ESP32-S3 N16R8 and compile the source in that project.

No physical relay, sensor, SD card or power-cycle test was performed. In particular, compile success does not verify your wiring or SD-card durability. Cleaning retains its original lack of an assigned relay output.
