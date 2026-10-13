#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <AsyncJson.h>
#include <ArduinoJson.h>
#include <RTClib.h>
#include <Preferences.h>
#include <SPI.h>
#include <SD.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include "DHT.h"
#include "secrets.h"

// ============================================================
// WIFI
// ============================================================

// STA SSID/password and AP password come from secrets.h (gitignored).

// AP Wi-Fi
const char* AP_SSID = "ESP32-Misting-System";

AsyncWebServer server(80);

// Live cached sensor states
float lastTemp = NAN;
float lastHum = NAN;
float lastThi = NAN;
float lastWaterLevel = -1.0;
bool pumpIsOn = false;

// ============================================================
// DHT22
// ============================================================

#define DHT_PIN 4
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

const unsigned long DHT_INTERVAL = 3000;
unsigned long lastDHTRead = 0;

// ============================================================
// RTC DS3231
// ============================================================

RTC_DS3231 rtc;
bool rtcOk = false;
bool rtcTimeValid = false;

// RTC runs in UTC internally; convert to local timezone only for display
const int LOCAL_TIMEZONE_OFFSET_SEC = 8 * 3600; // UTC+8 (Asia/Manila)

// SDA = GPIO 8
// SCL = GPIO 9
#define SDA_PIN 8
#define SCL_PIN 9

// ============================================================
// HC-SR04
// ============================================================

#define TRIG_PIN 16
#define ECHO_PIN 17

// Tank measurements
const float TANK_EMPTY_CM = 14.0;
const float TANK_FULL_CM = 3.0;

const unsigned long DISTANCE_INTERVAL = 2000;
unsigned long lastDistanceRead = 0;

// ============================================================
// MISTING RELAY
// ============================================================

#define RELAY_PIN 18

// Active LOW relay
#define RELAY_ON LOW
#define RELAY_OFF HIGH

// ============================================================
// BATHING RELAY (channel definition retained)
// ============================================================
#define BATH_RELAY_PIN 7

// ============================================================
// SYSTEM SETTINGS & PREFERENCES (NVS)
// ============================================================

Preferences preferences;

// Setting limits and validation ranges
const float MIN_WATER_LEVEL_MIN     = 10.0f;
const float MIN_WATER_LEVEL_MAX     = 100.0f;
const float MIST_DURATION_MIN_LIMIT = 1.0f;
const float MIST_DURATION_MAX_LIMIT = 30.0f;
const float MIST_PAUSE_MIN_LIMIT    = 1.0f;
const float MIST_PAUSE_MAX_LIMIT    = 600.0f;
const float THI_THRESHOLD_MIN       = 60.0f;
const float THI_THRESHOLD_MAX       = 100.0f;
const float TEMP_THRESHOLD_MIN      = 20.0f;
const float TEMP_THRESHOLD_MAX      = 50.0f;

// Runtime settings with defaults (matching dashboard expectations)
float thiThreshold     = 85.0f; // Mist cooling THI setpoint
float tempThreshold    = 32.0f; // Mist cooling temp slider threshold (°C)
float thiNormalMax     = 74.0f; // THI upper bound for Normal tier
float thiStressMax     = 78.0f; // THI upper bound for Stressful tier
float thiExtremeMax    = 83.0f; // THI upper bound for Extreme Heat tier
float mistDurationMin  = 5.0f;  // Mist active duration in minutes
float mistPauseSec     = 30.0f; // Mist pause duration in seconds
float minWaterLevelPct = 10.0f; // Minimum water tank percentage gate

void loadSettings() {
    if (preferences.begin("ios_settings", true)) { // read-only
        thiThreshold     = preferences.getFloat("thi_thresh", 85.0f);
        tempThreshold    = preferences.getFloat("temp_thresh", 32.0f);
        thiNormalMax     = preferences.getFloat("thi_norm", 74.0f);
        thiStressMax     = preferences.getFloat("thi_stress", 78.0f);
        thiExtremeMax    = preferences.getFloat("thi_extr", 83.0f);
        mistDurationMin  = preferences.getFloat("mist_dur", 5.0f);
        mistPauseSec     = preferences.getFloat("mist_pause", 30.0f);
        minWaterLevelPct = preferences.getFloat("min_water", 10.0f);
        preferences.end();
        Serial.println("Settings loaded from Preferences (NVS).");
    } else {
        Serial.println("No NVS settings found, using defaults.");
    }
}

void saveSettings() {
    if (preferences.begin("ios_settings", false)) { // read-write
        preferences.putFloat("thi_thresh", thiThreshold);
        preferences.putFloat("temp_thresh", tempThreshold);
        preferences.putFloat("thi_norm", thiNormalMax);
        preferences.putFloat("thi_stress", thiStressMax);
        preferences.putFloat("thi_extr", thiExtremeMax);
        preferences.putFloat("mist_dur", mistDurationMin);
        preferences.putFloat("mist_pause", mistPauseSec);
        preferences.putFloat("min_water", minWaterLevelPct);
        preferences.end();
        Serial.println("Settings saved to Preferences (NVS).");
    } else {
        Serial.println("ERROR: Could not open Preferences (NVS) for writing.");
    }
}

static void settingsToJson(JsonObject obj) {
    obj["threshold"]          = tempThreshold;
    obj["thiThreshold"]       = thiThreshold;
    JsonObject thiThresh      = obj["thiThresholds"].to<JsonObject>();
    thiThresh["normalMax"]    = thiNormalMax;
    thiThresh["stressMax"]    = thiStressMax;
    thiThresh["extremeMax"]   = thiExtremeMax;
    JsonObject opDur          = obj["operationDurations"].to<JsonObject>();
    opDur["mistDurationMin"]  = mistDurationMin;
    opDur["mistPauseSec"]     = mistPauseSec;
    obj["minWaterLevelPct"]   = minWaterLevelPct;
}

bool validateSettings(float minWater, float mistDur, float mistPause,
                      float thiThr, float tempThr, float normalMax,
                      float stressMax, float extremeMax, String &err)
{
    if (isnan(minWater) || minWater < MIN_WATER_LEVEL_MIN || minWater > MIN_WATER_LEVEL_MAX) {
        err = "minWaterLevelPct must be between " + String(MIN_WATER_LEVEL_MIN, 1) + " and " + String(MIN_WATER_LEVEL_MAX, 1);
        return false;
    }
    if (isnan(mistDur) || mistDur < MIST_DURATION_MIN_LIMIT || mistDur > MIST_DURATION_MAX_LIMIT) {
        err = "mistDurationMin must be between " + String(MIST_DURATION_MIN_LIMIT, 1) + " and " + String(MIST_DURATION_MAX_LIMIT, 1);
        return false;
    }
    if (isnan(mistPause) || mistPause < MIST_PAUSE_MIN_LIMIT || mistPause > MIST_PAUSE_MAX_LIMIT) {
        err = "mistPauseSec must be between " + String(MIST_PAUSE_MIN_LIMIT, 1) + " and " + String(MIST_PAUSE_MAX_LIMIT, 1);
        return false;
    }
    if (isnan(thiThr) || thiThr < THI_THRESHOLD_MIN || thiThr > THI_THRESHOLD_MAX) {
        err = "thiThreshold must be between " + String(THI_THRESHOLD_MIN, 1) + " and " + String(THI_THRESHOLD_MAX, 1);
        return false;
    }
    if (isnan(tempThr) || tempThr < TEMP_THRESHOLD_MIN || tempThr > TEMP_THRESHOLD_MAX) {
        err = "tempThreshold must be between " + String(TEMP_THRESHOLD_MIN, 1) + " and " + String(TEMP_THRESHOLD_MAX, 1);
        return false;
    }
    if (isnan(normalMax) || isnan(stressMax) || isnan(extremeMax) ||
        !(normalMax < stressMax && stressMax < extremeMax)) {
        err = "THI thresholds must satisfy normalMax < stressMax < extremeMax";
        return false;
    }
    return true;
}

// ============================================================
// READINGS HISTORY (24h RAM Ring Buffer + LittleFS Persistence)
// ============================================================

#define HISTORY_CAPACITY 288 // 24 hours at 5-minute sampling (288 * 5 min = 1440 min = 24h)
#define HISTORY_FILE "/history.json"

const unsigned long HISTORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000UL; // Sample every 5 minutes
const unsigned long HISTORY_SAVE_INTERVAL_MS   = 5 * 60 * 1000UL; // Flush to LittleFS every 5 minutes (constant, 5-10 min)

struct HistoryRecord {
    char     time[6];    // "HH:MM" local time string
    uint64_t ts;         // UTC timestamp in milliseconds
    float    temp;
    float    humidity;
    float    thi;
};

HistoryRecord historyRing[HISTORY_CAPACITY];
size_t historyCount = 0;
size_t historyHead = 0;
bool historyDirty = false;
unsigned long lastHistorySample = 0;
unsigned long lastHistorySave = 0;

void addHistorySample(float temp, float hum, float thi) {
    HistoryRecord &rec = historyRing[historyHead];
    rec.temp = temp;
    rec.humidity = hum;
    rec.thi = thi;

    if (rtcOk) {
        DateTime nowUtc = rtc.now();
        rec.ts = (uint64_t)nowUtc.unixtime() * 1000ULL;
        DateTime nowLocal = nowUtc + TimeSpan(LOCAL_TIMEZONE_OFFSET_SEC);
        snprintf(rec.time, sizeof(rec.time), "%02d:%02d", nowLocal.hour(), nowLocal.minute());
    } else {
        unsigned long nowMs = millis();
        rec.ts = (uint64_t)nowMs;
        unsigned long totalSec = nowMs / 1000UL;
        unsigned long hours = (totalSec / 3600UL) % 24;
        unsigned long minutes = (totalSec / 60UL) % 60;
        snprintf(rec.time, sizeof(rec.time), "%02lu:%02lu", hours, minutes);
    }

    historyHead = (historyHead + 1) % HISTORY_CAPACITY;
    if (historyCount < HISTORY_CAPACITY) {
        historyCount++;
    }
    historyDirty = true;
}

void loadHistory() {
    historyCount = 0;
    historyHead = 0;
    historyDirty = false;

    if (!LittleFS.exists(HISTORY_FILE)) {
        Serial.println("history.json not found — starting with empty history.");
        return;
    }

    File f = LittleFS.open(HISTORY_FILE, "r");
    if (!f) {
        Serial.println("ERROR: Could not open history.json for reading.");
        return;
    }

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, f);
    f.close();

    if (err) {
        Serial.print("ERROR: history.json parse error: ");
        Serial.println(err.c_str());
        return;
    }

    JsonArray arr = doc.as<JsonArray>();
    for (JsonObject obj : arr) {
        HistoryRecord &rec = historyRing[historyHead];
        const char* timeStr = obj["time"] | "00:00";
        strncpy(rec.time, timeStr, sizeof(rec.time) - 1);
        rec.time[sizeof(rec.time) - 1] = '\0';
        rec.ts = obj["ts"] | 0ULL;
        rec.temp = obj["temp"] | 0.0f;
        rec.humidity = obj["humidity"] | 0.0f;
        rec.thi = obj["thi"] | 0.0f;

        historyHead = (historyHead + 1) % HISTORY_CAPACITY;
        if (historyCount < HISTORY_CAPACITY) {
            historyCount++;
        }
    }

    Serial.print("Loaded ");
    Serial.print(historyCount);
    Serial.println(" history reading(s) from LittleFS.");
}

void saveHistory() {
    File f = LittleFS.open(HISTORY_FILE, "w");
    if (!f) {
        Serial.println("ERROR: Could not open history.json for writing.");
        return;
    }

    f.print('[');
    for (size_t i = 0; i < historyCount; i++) {
        size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
        if (i > 0) f.print(',');
        f.printf("{\"time\":\"%s\",\"ts\":%llu,\"temp\":%.1f,\"humidity\":%.1f,\"thi\":%.1f}",
            historyRing[idx].time,
            (unsigned long long)historyRing[idx].ts,
            historyRing[idx].temp,
            historyRing[idx].humidity,
            historyRing[idx].thi);
    }
    f.print(']');
    f.close();
    Serial.println("History saved to LittleFS.");
}

// ============================================================
// MICROSD OFFLINE STORAGE & AUTOMATIC DATABASE SYNCHRONIZATION
// ============================================================

#define SD_CS_PIN   10
#define SD_MOSI_PIN 11
#define SD_SCK_PIN  12
#define SD_MISO_PIN 13

#define SD_LOG_FILE  "/ios/offline_readings.jsonl"
#define SD_SYNC_FILE "/ios/sync_pos.json"

enum SdStatus {
    SD_STATUS_UNKNOWN,
    SD_STATUS_READY,
    SD_STATUS_MISSING,
    SD_STATUS_ERROR
};

SdStatus sdCardStatus = SD_STATUS_UNKNOWN;
bool sdMounted = false;

// Backend availability
bool backendOnline = false;
unsigned long lastBackendHealthCheck = 0;
const unsigned long BACKEND_HEALTH_CHECK_INTERVAL_MS = 20000; // 20s non-blocking interval

// Sync progress tracking
uint32_t sdSyncedOffset = 0;     // byte offset in offline_readings.jsonl confirmed synced
uint32_t sdSyncedCount = 0;      // total records confirmed synced
uint32_t sdPendingCount = 0;     // number of records awaiting sync
uint64_t lastSyncTs = 0;         // UTC timestamp (ms) of last successful sync
bool syncInProgress = false;
unsigned long lastSyncBatchAttempt = 0;
const unsigned long SYNC_BATCH_INTERVAL_MS = 500; // delay between batches
const size_t SYNC_BATCH_SIZE = 15;                // 15 records per batch

// Sequence counter for deterministic unique record IDs
static uint32_t recordSeq = 0;

const char* getSdStatusString() {
    switch (sdCardStatus) {
        case SD_STATUS_READY:   return "Ready";
        case SD_STATUS_MISSING: return "Missing";
        case SD_STATUS_ERROR:   return "Error";
        default:                return "Unknown";
    }
}

void loadSyncProgress() {
    sdSyncedOffset = 0;
    sdSyncedCount  = 0;
    lastSyncTs     = 0;

    if (!sdMounted || !SD.exists(SD_SYNC_FILE)) {
        return;
    }

    File f = SD.open(SD_SYNC_FILE, FILE_READ);
    if (!f) return;

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, f);
    f.close();

    if (!err) {
        sdSyncedOffset = doc["synced_offset"] | 0;
        sdSyncedCount  = doc["synced_count"]  | 0;
        lastSyncTs     = doc["last_sync_ts"]   | 0ULL;
        Serial.printf("MicroSD: Loaded sync progress — offset: %u, syncedCount: %u\n", sdSyncedOffset, sdSyncedCount);
    }
}

void saveSyncProgress() {
    if (!sdMounted) return;

    File f = SD.open(SD_SYNC_FILE, FILE_WRITE);
    if (!f) {
        Serial.println("ERROR: Could not open sync_pos.json for writing.");
        return;
    }

    JsonDocument doc;
    doc["synced_offset"] = sdSyncedOffset;
    doc["synced_count"]  = sdSyncedCount;
    doc["last_sync_ts"]   = lastSyncTs;

    serializeJson(doc, f);
    f.close();
}

void calculatePendingRecords() {
    sdPendingCount = 0;
    if (!sdMounted || !SD.exists(SD_LOG_FILE)) {
        return;
    }

    File f = SD.open(SD_LOG_FILE, FILE_READ);
    if (!f) return;

    size_t fileSize = f.size();
    if (sdSyncedOffset > fileSize) {
        sdSyncedOffset = 0;
    }

    if (f.seek(sdSyncedOffset)) {
        uint32_t count = 0;
        uint8_t buf[256];
        while (f.available()) {
            int n = f.read(buf, sizeof(buf));
            for (int i = 0; i < n; i++) {
                if (buf[i] == '\n') count++;
            }
        }
        sdPendingCount = count;
    }
    f.close();
    Serial.printf("MicroSD: Found %u pending offline record(s) (file size: %u bytes)\n", sdPendingCount, (unsigned int)fileSize);
}

void initMicroSD() {
    Serial.println("Initializing MicroSD SPI bus (CS: 10, MOSI: 11, SCK: 12, MISO: 13)...");
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

    // format_if_empty = false to prevent accidental card wipes
    if (!SD.begin(SD_CS_PIN, SPI, 4000000, "/sd", 5, false)) {
        uint8_t cardType = SD.cardType();
        if (cardType == CARD_NONE) {
            sdCardStatus = SD_STATUS_MISSING;
            Serial.println("WARNING: MicroSD card not inserted (Missing). Continuing in RAM/LittleFS mode.");
        } else {
            sdCardStatus = SD_STATUS_ERROR;
            Serial.println("ERROR: MicroSD mount or filesystem error. Continuing in RAM/LittleFS mode.");
        }
        sdMounted = false;
        return;
    }

    uint8_t cardType = SD.cardType();
    if (cardType == CARD_NONE) {
        sdCardStatus = SD_STATUS_MISSING;
        sdMounted = false;
        Serial.println("WARNING: MicroSD card type is CARD_NONE.");
        return;
    }

    sdCardStatus = SD_STATUS_READY;
    sdMounted = true;
    uint64_t cardSizeMB = SD.cardSize() / (1024 * 1024);
    Serial.printf("MicroSD mounted successfully. Card Size: %llu MB\n", cardSizeMB);

    if (!SD.exists("/ios")) {
        SD.mkdir("/ios");
    }

    loadSyncProgress();
    calculatePendingRecords();
}

bool checkBackendHealth() {
    if (WiFi.status() != WL_CONNECTED) {
        backendOnline = false;
        return false;
    }

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(1500); // 1.5s non-blocking timeout

    String url = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/health";
    if (!http.begin(client, url)) {
        backendOnline = false;
        return false;
    }

    int httpCode = http.GET();
    bool ok = false;
    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        if (payload.indexOf("\"ok\":true") >= 0 || payload.indexOf("\"ok\": true") >= 0) {
            ok = true;
        }
    }
    http.end();

    if (ok != backendOnline) {
        backendOnline = ok;
        Serial.printf("Backend connection status changed: %s\n", backendOnline ? "ONLINE" : "OFFLINE");
    }
    return backendOnline;
}

bool logOfflineReading(float temp, float hum, float thi,
                       float waterLevel, float flowRate, float waterUsed,
                       bool pumpOn, const char* pumpReason) {
    if (!sdMounted) {
        Serial.println("WARNING: MicroSD not mounted — offline reading cannot be logged to SD.");
        return false;
    }

    File f = SD.open(SD_LOG_FILE, FILE_APPEND);
    if (!f) {
        Serial.println("ERROR: Failed to open " SD_LOG_FILE " for appending.");
        sdCardStatus = SD_STATUS_ERROR;
        return false;
    }

    recordSeq++;
    char recordId[36];
    uint64_t tsMs = 0;
    bool hasValidRtc = (rtcOk && rtcTimeValid);

    if (hasValidRtc) {
        DateTime nowUtc = rtc.now();
        tsMs = (uint64_t)nowUtc.unixtime() * 1000ULL;
        snprintf(recordId, sizeof(recordId), "esp32-%lu-%u", (unsigned long)nowUtc.unixtime(), recordSeq);
    } else {
        snprintf(recordId, sizeof(recordId), "esp32-up%lu-%u", millis(), recordSeq);
    }

    const char* thiLabel = "Normal";
    if (!isnan(thi)) {
        if (thi < thiNormalMax)       thiLabel = "Normal";
        else if (thi <= thiStressMax) thiLabel = "Stressful";
        else if (thi <= thiExtremeMax) thiLabel = "Extreme Heat";
        else                           thiLabel = "Danger Zone";
    }

    JsonDocument doc;
    doc["id"] = recordId;
    if (hasValidRtc) {
        doc["ts"] = tsMs;
        doc["ts_ms"] = tsMs;
        doc["rtc_valid"] = true;
    } else {
        doc["ts"] = nullptr;
        doc["ts_ms"] = nullptr;
        doc["rtc_valid"] = false;
        doc["uptime_ms"] = millis();
    }

    if (!isnan(temp)) doc["temp"] = temp; else doc["temp"] = nullptr;
    if (!isnan(hum))  doc["humidity"] = hum; else doc["humidity"] = nullptr;
    if (!isnan(thi))  doc["thi"] = thi; else doc["thi"] = nullptr;
    doc["thi_label"] = thiLabel;

    if (waterLevel >= 0) {
        doc["water_level"] = waterLevel;
        doc["water_level_pct"] = waterLevel;
    } else {
        doc["water_level"] = nullptr;
        doc["water_level_pct"] = nullptr;
    }

    doc["flow_lpm"] = flowRate;
    doc["water_used"] = waterUsed;
    doc["water_used_l"] = waterUsed;
    doc["pump_on"] = pumpOn;
    doc["pump_reason"] = pumpReason ? pumpReason : "idle";

    serializeJson(doc, f);
    f.print('\n');
    f.flush();
    f.close();

    sdPendingCount++;
    Serial.printf("MicroSD: Logged reading %s. Pending sync: %u\n", recordId, sdPendingCount);
    return true;
}

bool sendTelemetryDirect(float temp, float hum, float thi,
                         float waterLevel, float flowRate, float waterUsed,
                         bool pumpOn, const char* pumpReason) {
    if (WiFi.status() != WL_CONNECTED) {
        backendOnline = false;
        return false;
    }

    recordSeq++;
    char recordId[36];
    uint64_t tsMs = 0;
    bool hasValidRtc = (rtcOk && rtcTimeValid);

    if (hasValidRtc) {
        DateTime nowUtc = rtc.now();
        tsMs = (uint64_t)nowUtc.unixtime() * 1000ULL;
        snprintf(recordId, sizeof(recordId), "esp32-%lu-%u", (unsigned long)nowUtc.unixtime(), recordSeq);
    } else {
        snprintf(recordId, sizeof(recordId), "esp32-up%lu-%u", millis(), recordSeq);
    }

    const char* thiLabel = "Normal";
    if (!isnan(thi)) {
        if (thi < thiNormalMax)       thiLabel = "Normal";
        else if (thi <= thiStressMax) thiLabel = "Stressful";
        else if (thi <= thiExtremeMax) thiLabel = "Extreme Heat";
        else                           thiLabel = "Danger Zone";
    }

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    JsonObject obj = arr.add<JsonObject>();
    obj["id"] = recordId;
    if (hasValidRtc) {
        obj["ts"] = tsMs;
        obj["ts_ms"] = tsMs;
        obj["rtc_valid"] = true;
    } else {
        obj["ts"] = nullptr;
        obj["ts_ms"] = nullptr;
        obj["rtc_valid"] = false;
        obj["uptime_ms"] = millis();
    }
    if (!isnan(temp)) obj["temp"] = temp; else obj["temp"] = nullptr;
    if (!isnan(hum))  obj["humidity"] = hum; else obj["humidity"] = nullptr;
    if (!isnan(thi))  obj["thi"] = thi; else obj["thi"] = nullptr;
    obj["thi_label"] = thiLabel;
    if (waterLevel >= 0) {
        obj["water_level"] = waterLevel;
        obj["water_level_pct"] = waterLevel;
    } else {
        obj["water_level"] = nullptr;
        obj["water_level_pct"] = nullptr;
    }
    obj["flow_lpm"] = flowRate;
    obj["water_used"] = waterUsed;
    obj["water_used_l"] = waterUsed;
    obj["pump_on"] = pumpOn;
    obj["pump_reason"] = pumpReason ? pumpReason : "idle";

    String payload;
    serializeJson(arr, payload);

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(2500);
    String url = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/readings/batch";
    if (!http.begin(client, url)) {
        backendOnline = false;
        return false;
    }
    http.addHeader("Content-Type", "application/json");

    int code = http.POST(payload);
    bool success = false;
    if (code == 200 || code == 201) {
        backendOnline = true;
        if (hasValidRtc) lastSyncTs = tsMs;
        else lastSyncTs = (uint64_t)millis();
        success = true;
    } else {
        backendOnline = false;
        Serial.printf("Direct telemetry push failed (HTTP %d).\n", code);
    }
    http.end();
    return success;
}

void handleTelemetrySample(float temp, float hum, float thi,
                           float waterLevel, float flowRate, float waterUsed,
                           bool pumpOn, const char* pumpReason) {
    if (backendOnline && sdPendingCount == 0) {
        if (sendTelemetryDirect(temp, hum, thi, waterLevel, flowRate, waterUsed, pumpOn, pumpReason)) {
            Serial.println("Telemetry: Sent live reading to backend database.");
            return;
        }
    }

    logOfflineReading(temp, hum, thi, waterLevel, flowRate, waterUsed, pumpOn, pumpReason);
}

void syncBatch() {
    if (!backendOnline || !sdMounted || sdPendingCount == 0 || syncInProgress) {
        return;
    }

    if (!SD.exists(SD_LOG_FILE)) {
        sdPendingCount = 0;
        return;
    }

    File f = SD.open(SD_LOG_FILE, FILE_READ);
    if (!f) {
        Serial.println("ERROR: Could not open offline_readings.jsonl for reading.");
        return;
    }

    size_t fileSize = f.size();
    if (sdSyncedOffset >= fileSize) {
        f.close();
        sdPendingCount = 0;
        return;
    }

    if (!f.seek(sdSyncedOffset)) {
        Serial.println("ERROR: Could not seek to sdSyncedOffset.");
        f.close();
        return;
    }

    syncInProgress = true;

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    size_t batchCount = 0;
    uint32_t nextOffset = sdSyncedOffset;

    while (f.available() && batchCount < SYNC_BATCH_SIZE) {
        String line = f.readStringUntil('\n');
        uint32_t currentPos = f.position();
        line.trim();
        if (line.length() == 0) {
            nextOffset = currentPos;
            continue;
        }

        JsonDocument lineDoc;
        DeserializationError err = deserializeJson(lineDoc, line);
        if (err) {
            Serial.printf("WARNING: Corrupt JSONL record at offset %u, skipping line.\n", nextOffset);
            nextOffset = currentPos;
            continue;
        }

        arr.add(lineDoc.as<JsonObject>());
        batchCount++;
        nextOffset = currentPos;
    }
    f.close();

    if (batchCount == 0) {
        sdSyncedOffset = nextOffset;
        saveSyncProgress();
        sdPendingCount = 0;
        syncInProgress = false;
        return;
    }

    String payload;
    serializeJson(arr, payload);

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(3500);
    String url = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/readings/batch";
    if (!http.begin(client, url)) {
        backendOnline = false;
        syncInProgress = false;
        return;
    }
    http.addHeader("Content-Type", "application/json");

    int code = http.POST(payload);
    if (code == 200 || code == 201) {
        String resStr = http.getString();
        JsonDocument resDoc;
        DeserializationError resErr = deserializeJson(resDoc, resStr);

        bool accepted = false;
        if (!resErr && resDoc["ok"].as<bool>()) {
            JsonArray acceptedArr = resDoc["accepted_ids"].as<JsonArray>();
            if (acceptedArr.size() >= batchCount) {
                accepted = true;
            }
        }

        if (accepted) {
            sdSyncedOffset = nextOffset;
            sdSyncedCount += batchCount;
            if (sdPendingCount >= batchCount) {
                sdPendingCount -= batchCount;
            } else {
                sdPendingCount = 0;
            }

            if (rtcOk && rtcTimeValid) {
                lastSyncTs = (uint64_t)rtc.now().unixtime() * 1000ULL;
            } else {
                lastSyncTs = (uint64_t)millis();
            }

            saveSyncProgress();
            Serial.printf("SYNC SUCCESS: Uploaded %u records. Remaining: %u\n", (unsigned int)batchCount, (unsigned int)sdPendingCount);
        } else {
            Serial.println("WARNING: Batch response did not confirm all accepted IDs. Will retry.");
        }
    } else {
        Serial.printf("SYNC FAILED: HTTP %d. Pausing sync.\n", code);
        backendOnline = false;
    }
    http.end();
    syncInProgress = false;
}

// ============================================================
// PUMP CONTROL & RUNTIME LIMITS
// ============================================================

// Manual override runtime limits
const unsigned long MANUAL_DEFAULT_RUN_MS = 60000;  // 1 minute default runtime
const unsigned long MANUAL_MAX_RUN_MS = 180000;     // 3 minutes maximum runtime safety cutoff

// Manual override state
bool manualActive = false;
unsigned long manualStartTime = 0;
unsigned long manualExpiryTime = 0;

// Current pump reason string for /api/status and logging
const char* currentPumpReason = "idle";

// Type of the first currently-active schedule ("bath", "clean", "mist", or "")
static char activeScheduleType[8] = "";

// ============================================================
// SCHEDULE ENGINE (LittleFS-backed, matches dashboard JSON shape)
// ============================================================

// Maximum number of schedules stored on device
#define MAX_SCHEDULES 20

// Path in LittleFS where schedules are persisted
#define SCHEDULES_FILE "/schedules.json"

// Dashboard day-string order: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
// RTClib dayOfTheWeek() convention: 0=Sunday ... 6=Saturday
// The dashboard stores days[] as 3-char strings: "Mon","Tue","Wed","Thu","Fri","Sat","Sun"

struct Schedule {
    char     id[12];       // e.g. "s1", "s2", …
    char     type[8];      // "bath" or "clean"
    char     label[48];    // human-readable label
    char     time[6];      // "HH:MM" local time (UTC+8)
    uint16_t duration;     // minutes
    char     days[7][4];   // up to 7 day strings ("Mon"…"Sun") + NUL
    uint8_t  dayCount;     // number of valid entries in days[]
    bool     active;
};

Schedule schedules[MAX_SCHEDULES];
uint8_t  scheduleCount  = 0;
uint32_t nextScheduleId = 1; // monotone counter for new IDs

// ── Day-string → RTClib dayOfTheWeek() (0=Sun…6=Sat) ─────────────────────
static int8_t dayStringToRtcDow(const char* d) {
    if (strcmp(d, "Sun") == 0) return 0;
    if (strcmp(d, "Mon") == 0) return 1;
    if (strcmp(d, "Tue") == 0) return 2;
    if (strcmp(d, "Wed") == 0) return 3;
    if (strcmp(d, "Thu") == 0) return 4;
    if (strcmp(d, "Fri") == 0) return 5;
    if (strcmp(d, "Sat") == 0) return 6;
    return -1;
}

// ── C++ port of dashboard isScheduleActiveNow() ───────────────────────────
// Checks whether the current local time falls inside the schedule window.
// Supports midnight-crossing durations (e.g. 23:30 + 60 min = 00:30 next day).
bool isScheduleActiveNow(const Schedule &s) {
    if (!s.active)       return false;
    if (!rtcOk)          return false;
    if (!rtcTimeValid)   return false;
    if (s.dayCount == 0) return false;

    // Convert UTC epoch to local time (UTC+8)
    DateTime nowUtc   = rtc.now();
    DateTime nowLocal = nowUtc + TimeSpan(LOCAL_TIMEZONE_OFFSET_SEC);

    uint8_t  nowDow     = nowLocal.dayOfTheWeek(); // 0=Sun…6=Sat
    uint16_t nowMinutes = (uint16_t)(nowLocal.hour() * 60u + nowLocal.minute());

    // Parse schedule start "HH:MM"
    int sHH = 0, sMM = 0;
    sscanf(s.time, "%d:%d", &sHH, &sMM);
    uint16_t startMin = (uint16_t)(sHH * 60 + sMM);
    uint16_t endMin   = startMin + s.duration; // may exceed 1440

    for (uint8_t i = 0; i < s.dayCount; i++) {
        int8_t schedDow = dayStringToRtcDow(s.days[i]);
        if (schedDow < 0) continue;

        if (endMin <= 1440) {
            // Normal window (no midnight crossing)
            if (nowDow == (uint8_t)schedDow &&
                nowMinutes >= startMin &&
                nowMinutes <  endMin) {
                return true;
            }
        } else {
            // Midnight-crossing: active in two calendar days
            uint16_t overflow = endMin - 1440; // minutes active into next day
            int8_t   nextDow  = (schedDow + 1) % 7;

            if (nowDow == (uint8_t)schedDow && nowMinutes >= startMin) {
                return true; // current-day portion
            }
            if (nowDow == (uint8_t)nextDow && nowMinutes < overflow) {
                return true; // next-day portion
            }
        }
    }
    return false;
}

// ── Check all schedules; returns true if any is currently active ──────────
bool anyScheduleActive() {
    for (uint8_t i = 0; i < scheduleCount; i++) {
        if (isScheduleActiveNow(schedules[i])) {
            strncpy(activeScheduleType, schedules[i].type, sizeof(activeScheduleType) - 1);
            activeScheduleType[sizeof(activeScheduleType) - 1] = '\0';
            return true;
        }
    }
    activeScheduleType[0] = '\0';
    return false;
}

// ── Serialize one Schedule struct → JsonObject ────────────────────────────
static void scheduleToJson(JsonObject obj, const Schedule &s) {
    obj["id"]       = s.id;
    obj["type"]     = s.type;
    obj["label"]    = s.label;
    obj["time"]     = s.time;
    obj["duration"] = s.duration;
    obj["active"]   = s.active;
    JsonArray days  = obj["days"].to<JsonArray>();
    for (uint8_t d = 0; d < s.dayCount; d++) {
        days.add(s.days[d]);
    }
}

// ── Load schedules from LittleFS; missing file → empty list ───────────────
void loadSchedules() {
    scheduleCount  = 0;
    nextScheduleId = 1;

    if (!LittleFS.exists(SCHEDULES_FILE)) {
        Serial.println("schedules.json not found — starting with empty list.");
        return;
    }

    File f = LittleFS.open(SCHEDULES_FILE, "r");
    if (!f) {
        Serial.println("ERROR: Could not open schedules.json for reading.");
        return;
    }

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, f);
    f.close();

    if (err) {
        Serial.print("ERROR: schedules.json parse error: ");
        Serial.println(err.c_str());
        return;
    }

    JsonArray arr = doc.as<JsonArray>();
    for (JsonObject obj : arr) {
        if (scheduleCount >= MAX_SCHEDULES) break;

        Schedule &s = schedules[scheduleCount];

        const char* idStr = obj["id"] | "s0";
        strncpy(s.id, idStr, sizeof(s.id) - 1);
        s.id[sizeof(s.id) - 1] = '\0';

        // Keep nextScheduleId above the highest stored id number
        uint32_t numId = (uint32_t)atoi(s.id + 1); // skip leading 's'
        if (numId >= nextScheduleId) nextScheduleId = numId + 1;

        strncpy(s.type,  obj["type"]  | "bath",   sizeof(s.type)  - 1);
        strncpy(s.label, obj["label"] | "",        sizeof(s.label) - 1);
        strncpy(s.time,  obj["time"]  | "00:00",   sizeof(s.time)  - 1);
        s.type[sizeof(s.type)-1]   = '\0';
        s.label[sizeof(s.label)-1] = '\0';
        s.time[sizeof(s.time)-1]   = '\0';

        s.duration = obj["duration"] | 15;
        s.active   = obj["active"]   | true;

        s.dayCount = 0;
        JsonArray days = obj["days"].as<JsonArray>();
        for (const char* d : days) {
            if (!d || s.dayCount >= 7) break;
            strncpy(s.days[s.dayCount], d, 3);
            s.days[s.dayCount][3] = '\0';
            s.dayCount++;
        }

        scheduleCount++;
    }

    Serial.print("Loaded ");
    Serial.print(scheduleCount);
    Serial.println(" schedule(s) from flash.");
}

// ── Persist all schedules to LittleFS (called only when data changes) ─────
void saveSchedules() {
    const char *tmpFile = "/schedules.tmp";
    File f = LittleFS.open(tmpFile, "w");
    if (!f) {
        Serial.println("ERROR: Could not open /schedules.tmp for writing.");
        return;
    }

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (uint8_t i = 0; i < scheduleCount; i++) {
        scheduleToJson(arr.add<JsonObject>(), schedules[i]);
    }

    if (serializeJson(doc, f) == 0) {
        Serial.println("ERROR: Failed to serialize schedules to /schedules.tmp");
        f.close();
        LittleFS.remove(tmpFile);
        return;
    }
    f.close();

    // Atomic replacement: remove old file and rename tmp
    if (LittleFS.exists(SCHEDULES_FILE)) {
        LittleFS.remove(SCHEDULES_FILE);
    }
    if (LittleFS.rename(tmpFile, SCHEDULES_FILE)) {
        Serial.println("schedules.json saved safely.");
    } else {
        Serial.println("ERROR: Failed to rename /schedules.tmp to /schedules.json");
    }
}

// ============================================================
// ACCESS CONTROL & TOKEN AUTHENTICATION
// ============================================================

bool isAuthorized(AsyncWebServerRequest *request) {
    if (!AUTH_TOKEN || strlen(AUTH_TOKEN) == 0) {
        return true; // No token configured, allow all
    }

    if (request->hasHeader("X-Auth-Token")) {
        const AsyncWebHeader *h = request->getHeader("X-Auth-Token");
        if (h && h->value().equals(AUTH_TOKEN)) {
            return true;
        }
    }

    if (request->hasHeader("Authorization")) {
        const AsyncWebHeader *h = request->getHeader("Authorization");
        if (h) {
            String val = h->value();
            if (val.startsWith("Bearer ")) {
                val = val.substring(7);
            }
            val.trim();
            if (val.equals(AUTH_TOKEN)) {
                return true;
            }
        }
    }

    return false;
}

void sendUnauthorized(AsyncWebServerRequest *request) {
    request->send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized: Invalid or missing access token\"}");
}

// ── Register /api/schedules CRUD routes ───────────────────────────────────
void setupScheduleRoutes(AsyncWebServer &srv) {

    // GET /api/schedules?type=bath|clean
    srv.on("/api/schedules", HTTP_GET, [](AsyncWebServerRequest *request) {
        String typeFilter = "";
        if (request->hasParam("type")) {
            typeFilter = request->getParam("type")->value();
        }

        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (uint8_t i = 0; i < scheduleCount; i++) {
            if (typeFilter.length() == 0 ||
                strcmp(schedules[i].type, typeFilter.c_str()) == 0) {
                scheduleToJson(arr.add<JsonObject>(), schedules[i]);
            }
        }

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // POST /api/schedules  — create a new schedule; server assigns id + active=true
    AsyncCallbackJsonWebHandler *postHandler =
        new AsyncCallbackJsonWebHandler("/api/schedules",
            [](AsyncWebServerRequest *request, JsonVariant &json) {
                if (!isAuthorized(request)) {
                    sendUnauthorized(request);
                    return;
                }
                if (!json.is<JsonObject>()) {
                    request->send(400, "application/json",
                        "{\"ok\":false,\"msg\":\"Expected JSON object\"}");
                    return;
                }
                if (scheduleCount >= MAX_SCHEDULES) {
                    request->send(507, "application/json",
                        "{\"ok\":false,\"msg\":\"Schedule list full (max 20)\"}");
                    return;
                }

                JsonObject obj = json.as<JsonObject>();
                Schedule &s = schedules[scheduleCount];

                snprintf(s.id, sizeof(s.id), "s%lu", (unsigned long)nextScheduleId++);

                strncpy(s.type,  obj["type"]  | "bath",   sizeof(s.type)  - 1);
                strncpy(s.label, obj["label"] | "",        sizeof(s.label) - 1);
                strncpy(s.time,  obj["time"]  | "00:00",   sizeof(s.time)  - 1);
                s.type[sizeof(s.type)-1]   = '\0';
                s.label[sizeof(s.label)-1] = '\0';
                s.time[sizeof(s.time)-1]   = '\0';

                s.duration = obj["duration"] | 15;
                // active not sent by dashboard on create; default true
                s.active = obj["active"].is<bool>() ? obj["active"].as<bool>() : true;

                s.dayCount = 0;
                if (obj["days"].is<JsonArray>()) {
                    for (const char* d : obj["days"].as<JsonArray>()) {
                        if (!d || s.dayCount >= 7) break;
                        strncpy(s.days[s.dayCount], d, 3);
                        s.days[s.dayCount][3] = '\0';
                        s.dayCount++;
                    }
                }

                scheduleCount++;
                saveSchedules();

                JsonDocument res;
                scheduleToJson(res.to<JsonObject>(), schedules[scheduleCount - 1]);
                String resJson;
                serializeJson(res, resJson);
                request->send(201, "application/json", resJson);
            });
    postHandler->setMethod(HTTP_POST);
    srv.addHandler(postHandler);

    // PATCH /api/schedules/{id}  — partial update (dashboard uses PATCH for toggle)
    // PUT   /api/schedules/{id}  — full update (accepted for completeness)
    auto patchLambda = [](AsyncWebServerRequest *request, JsonVariant &json) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        String path    = request->url();
        String idParam = path.substring(path.lastIndexOf('/') + 1);

        int8_t idx = -1;
        for (uint8_t i = 0; i < scheduleCount; i++) {
            if (strcmp(schedules[i].id, idParam.c_str()) == 0) {
                idx = (int8_t)i;
                break;
            }
        }

        if (idx < 0) {
            request->send(404, "application/json",
                "{\"ok\":false,\"msg\":\"Schedule not found\"}");
            return;
        }

        Schedule &s = schedules[idx];

        if (json.is<JsonObject>()) {
            JsonObject obj = json.as<JsonObject>();
            if (obj["active"].is<bool>())        s.active   = obj["active"].as<bool>();
            if (obj["duration"].is<int>())       s.duration = obj["duration"].as<uint16_t>();
            if (obj["time"].is<const char*>()) {
                strncpy(s.time, obj["time"].as<const char*>(), sizeof(s.time) - 1);
                s.time[sizeof(s.time)-1] = '\0';
            }
            if (obj["label"].is<const char*>()) {
                strncpy(s.label, obj["label"].as<const char*>(), sizeof(s.label) - 1);
                s.label[sizeof(s.label)-1] = '\0';
            }
            if (obj["days"].is<JsonArray>()) {
                s.dayCount = 0;
                for (const char* d : obj["days"].as<JsonArray>()) {
                    if (!d || s.dayCount >= 7) break;
                    strncpy(s.days[s.dayCount], d, 3);
                    s.days[s.dayCount][3] = '\0';
                    s.dayCount++;
                }
            }
        }

        saveSchedules();

        JsonDocument res;
        scheduleToJson(res.to<JsonObject>(), s);
        String resJson;
        serializeJson(res, resJson);
        request->send(200, "application/json", resJson);
    };

    AsyncCallbackJsonWebHandler *patchHandler =
        new AsyncCallbackJsonWebHandler("/api/schedules/*", patchLambda);
    patchHandler->setMethod(HTTP_PATCH);
    srv.addHandler(patchHandler);

    AsyncCallbackJsonWebHandler *putHandler =
        new AsyncCallbackJsonWebHandler("/api/schedules/*", patchLambda);
    putHandler->setMethod(HTTP_PUT);
    srv.addHandler(putHandler);

    // DELETE /api/schedules/{id}
    srv.on("/api/schedules/*", HTTP_DELETE, [](AsyncWebServerRequest *request) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        String path    = request->url();
        String idParam = path.substring(path.lastIndexOf('/') + 1);

        int8_t idx = -1;
        for (uint8_t i = 0; i < scheduleCount; i++) {
            if (strcmp(schedules[i].id, idParam.c_str()) == 0) {
                idx = (int8_t)i;
                break;
            }
        }

        if (idx < 0) {
            request->send(404, "application/json",
                "{\"ok\":false,\"msg\":\"Schedule not found\"}");
            return;
        }

        // Shift remaining entries left to close the gap
        for (uint8_t i = (uint8_t)idx; i < scheduleCount - 1; i++) {
            schedules[i] = schedules[i + 1];
        }
        scheduleCount--;
        saveSchedules();

        request->send(204);
    });
}

// ============================================================
// YF-S201 WATER FLOW SENSOR
// ============================================================

#define FLOW_SENSOR_PIN 5

// Common YF-S201 calibration:
// approximately 450 pulses = 1 liter
const float FLOW_PULSES_PER_LITER = 450.0;

// Pulse counter
volatile unsigned long flowPulseCount = 0;

// Flow calculation
unsigned long lastFlowCalculation = 0;
unsigned long lastFlowPulseCount = 0;

float flowRateLPM = 0.0;
float totalWaterUsedL = 0.0;

// ============================================================
// SERIAL TIMING
// ============================================================

const unsigned long SERIAL_PRINT_INTERVAL = 3000;
unsigned long lastSerialPrint = 0;

// ============================================================
// YF-S201 INTERRUPT
// ============================================================

void IRAM_ATTR flowPulseISR()
{
    flowPulseCount++;
}

// ============================================================
// MISTING PUMP HARDWARE FUNCTIONS
// ============================================================

void pumpOn()
{
    digitalWrite(RELAY_PIN, RELAY_ON);
    pumpIsOn = true;
}

void pumpOff()
{
    digitalWrite(RELAY_PIN, RELAY_OFF);
    pumpIsOn = false;
}

// ── Bathing relay (BATH_RELAY_PIN = GPIO 7, active-LOW) ───────────────────
void bathOn()
{
    digitalWrite(BATH_RELAY_PIN, RELAY_ON);
}

void bathOff()
{
    digitalWrite(BATH_RELAY_PIN, RELAY_OFF);
}

// ============================================================
// PUMP LOGIC ENGINE (called every loop)
// pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
// ============================================================

void updatePump()
{
    // 1. Check manual override expiry (turns off automatically)
    if (manualActive)
    {
        if ((long)(millis() - manualExpiryTime) >= 0)
        {
            manualActive = false;
            manualExpiryTime = 0;
        }
    }
    bool manual = manualActive;

    // 2. Scheduled: evaluate all stored schedules against current RTC local time
    //    anyScheduleActive() writes the matched type into activeScheduleType[].
    bool scheduled = anyScheduleActive();

    // Classify what kind of scheduled operation is active
    bool schedMist  = scheduled && (strcmp(activeScheduleType, "mist")  == 0);
    bool schedBath  = scheduled && (strcmp(activeScheduleType, "bath")  == 0);
    bool schedClean = scheduled && (strcmp(activeScheduleType, "clean") == 0);

    // 3. THI trigger with mist on/off cycle
    bool thiCondition = (!isnan(lastThi) && lastThi >= thiThreshold);

    static bool mistCycleRunning = false;
    static bool mistInOnPhase = false;
    static unsigned long mistPhaseStartTime = 0;

    if (thiCondition)
    {
        if (!mistCycleRunning)
        {
            mistCycleRunning = true;
            mistInOnPhase = true;
            mistPhaseStartTime = millis();
        }
        else
        {
            unsigned long elapsed = millis() - mistPhaseStartTime;
            if (mistInOnPhase)
            {
                if (elapsed >= (unsigned long)(mistDurationMin * 60000.0f))
                {
                    mistInOnPhase = false;
                    mistPhaseStartTime = millis();
                }
            }
            else
            {
                if (elapsed >= (unsigned long)(mistPauseSec * 1000.0f))
                {
                    mistInOnPhase = true;
                    mistPhaseStartTime = millis();
                }
            }
        }
    }
    else
    {
        mistCycleRunning = false;
        mistInOnPhase = false;
    }

    bool thiTrigger = mistInOnPhase;

    // 4. Water level gate: waterOk = water level >= minWaterLevelPct
    //    If sensor reads -1 (error), treat as 0% (no water) to prevent unsafe operation.
    float effectiveLevel = (lastWaterLevel >= 0) ? lastWaterLevel : 0.0f;
    bool waterOk = (effectiveLevel >= minWaterLevelPct);

    // 5. Misting relay (GPIO 18): THI cooling, mist schedule, or manual override
    bool shouldMist = waterOk && (thiTrigger || schedMist || manual);

    // 6. Bathing relay (GPIO 7): bath schedule only (water safety gate applies)
    bool shouldBath = waterOk && schedBath;

    // 7. Cleaning (no dedicated hardware relay yet):
    //    We log the intent but do not activate any other relay to avoid incorrect
    //    operation. If a hardware output is wired in the future, add it here.
    // (schedClean is tracked in currentPumpReason but drives nothing)

    // 8. Overall "something is pumping" for status / data logging
    bool shouldPump = shouldMist || shouldBath;

    // 9. Track state reason (priority: manual > bath > mist_sched > thi > clean > low_water > idle)
    if (shouldMist && manual)
    {
        currentPumpReason = "manual";
    }
    else if (shouldBath)
    {
        currentPumpReason = "scheduled";
    }
    else if (shouldMist && schedMist)
    {
        currentPumpReason = "scheduled";
    }
    else if (shouldMist && thiTrigger)
    {
        currentPumpReason = "thi_cooling";
    }
    else if (schedClean)
    {
        // Clean schedule is active but has no hardware relay yet
        currentPumpReason = "idle";
    }
    else if (!waterOk && (manual || scheduled || thiTrigger || thiCondition))
    {
        currentPumpReason = "low_water";
    }
    else if (thiCondition && !thiTrigger)
    {
        currentPumpReason = "mist_pause";
    }
    else
    {
        currentPumpReason = "idle";
    }

    // 10. Apply misting relay state (GPIO 18)
    if (shouldMist)
    {
        pumpOn();
    }
    else
    {
        pumpOff();
    }

    // 11. Apply bathing relay state (GPIO 7)
    if (shouldBath)
    {
        bathOn();
    }
    else
    {
        bathOff();
    }

    // pumpIsOn reflects the misting relay (used in legacy status/logging)
    // bathActive / cleanActive are derived in /api/status from activeScheduleType
    (void)shouldPump; // suppress unused warning if needed
}

// ============================================================
// WIFI SETUP
// ============================================================

void setupWiFi()
{
    // STA + AP at the same time
    WiFi.mode(WIFI_AP_STA);

    // Start ESP32 Access Point
    WiFi.softAP(AP_SSID, AP_PASSWORD);

    // Connect to router
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long startTime = millis();

    while (WiFi.status() != WL_CONNECTED &&
           millis() - startTime < 15000)
    {
        delay(500);
    }
}

// ============================================================
// WIFI RECONNECT
// ============================================================

void reconnectWiFi()
{
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck < 10000)
    {
        return;
    }
    lastWiFiCheck = millis();

    if (WiFi.status() == WL_CONNECTED)
    {
        return;
    }

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ============================================================
// LOCAL WEB SERVER (LittleFS dashboard + /api/status + /api/time + /api/manual)
// ============================================================

void handleStatus(AsyncWebServerRequest *request)
{
    JsonDocument doc;

    if (isnan(lastTemp)) {
        doc["temp"] = nullptr;
    } else {
        doc["temp"] = lastTemp;
    }

    if (isnan(lastHum)) {
        doc["hum"] = nullptr;
        doc["humidity"] = nullptr;
    } else {
        doc["hum"] = lastHum;
        doc["humidity"] = lastHum;
    }

    if (isnan(lastThi)) {
        doc["thi"] = nullptr;
        doc["thiStatus"] = nullptr;
    } else {
        doc["thi"] = lastThi;

        JsonObject thiStatus = doc["thiStatus"].to<JsonObject>();
        if (lastThi < thiNormalMax) {
            thiStatus["label"] = "Normal";
            thiStatus["cls"] = "badge-blue";
            thiStatus["color"] = "#3B82F6";
        } else if (lastThi <= thiStressMax) {
            thiStatus["label"] = "Stressful";
            thiStatus["cls"] = "badge-warn";
            thiStatus["color"] = "#F59E0B";
        } else if (lastThi <= thiExtremeMax) {
            thiStatus["label"] = "Extreme Heat";
            thiStatus["cls"] = "badge-orange";
            thiStatus["color"] = "#F97316";
        } else {
            thiStatus["label"] = "Danger Zone";
            thiStatus["cls"] = "badge-danger";
            thiStatus["color"] = "#EF4444";
        }
    }

    JsonObject thiThresholds = doc["thiThresholds"].to<JsonObject>();
    thiThresholds["normalMax"] = thiNormalMax;
    thiThresholds["stressMax"] = thiStressMax;
    thiThresholds["extremeMax"] = thiExtremeMax;

    JsonObject opDurations = doc["operationDurations"].to<JsonObject>();
    opDurations["mistDurationMin"] = mistDurationMin;
    opDurations["mistPauseSec"] = mistPauseSec;

    doc["malfunctions"].to<JsonArray>();
    doc["diagnostics"] = nullptr;

    // RTC status and current UTC epoch
    doc["rtcOk"] = rtcOk;
    doc["rtcTimeValid"] = rtcTimeValid;
    if (rtcOk) {
        DateTime nowUtc = rtc.now();
        doc["epoch"] = nowUtc.unixtime();
    } else {
        doc["epoch"] = nullptr;
    }

    if (lastWaterLevel < 0) {
        doc["waterLevel"] = nullptr;
    } else {
        doc["waterLevel"] = lastWaterLevel;
    }

    doc["waterUsed"] = totalWaterUsedL;
    doc["flowRate"] = flowRateLPM;

    // Pump state & reason
    doc["pumpOn"] = pumpIsOn;
    doc["pumpActive"] = pumpIsOn;
    doc["pumpState"] = pumpIsOn ? "ON" : "OFF";
    doc["pumpReason"] = currentPumpReason;
    doc["reason"] = currentPumpReason;
    doc["relayState"] = pumpIsOn;
    doc["mistActive"] = (strcmp(currentPumpReason, "thi_cooling") == 0) || 
                        ((strcmp(currentPumpReason, "scheduled") == 0) && (strcmp(activeScheduleType, "mist") == 0)) ||
                        (manualActive);
    doc["bathActive"]  = (strcmp(currentPumpReason, "scheduled") == 0) && (strcmp(activeScheduleType, "bath")  == 0);
    doc["cleanActive"] = (strcmp(activeScheduleType, "clean") == 0);
    doc["manualPumpActive"] = manualActive;
    doc["threshold"] = tempThreshold;
    doc["thiThreshold"] = thiThreshold;

    // MicroSD and Backend Sync Status
    doc["sdStatus"] = getSdStatusString();
    doc["backendOnline"] = backendOnline;
    doc["pendingOfflineCount"] = sdPendingCount;
    if (lastSyncTs > 0) {
        doc["lastSyncTs"] = (unsigned long long)lastSyncTs;
    } else {
        doc["lastSyncTs"] = nullptr;
    }
    doc["syncInProgress"] = syncInProgress;

    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

void setupSettingsRoutes(AsyncWebServer &srv) {
    // GET /api/settings
    srv.on("/api/settings", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        settingsToJson(doc.to<JsonObject>());
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // POST /api/settings
    AsyncCallbackJsonWebHandler *postSettingsHandler = new AsyncCallbackJsonWebHandler("/api/settings",
        [](AsyncWebServerRequest *request, JsonVariant &json) {
            if (!isAuthorized(request)) {
                sendUnauthorized(request);
                return;
            }
            if (!json.is<JsonObject>()) {
                request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Expected JSON object\"}");
                return;
            }
            JsonObject obj = json.as<JsonObject>();

            float newTempThr    = tempThreshold;
            float newThiThr     = thiThreshold;
            float newMinWater   = minWaterLevelPct;
            float newNormalMax  = thiNormalMax;
            float newStressMax  = thiStressMax;
            float newExtremeMax = thiExtremeMax;
            float newMistDur    = mistDurationMin;
            float newMistPause  = mistPauseSec;

            if (obj["threshold"].is<float>())          newTempThr = obj["threshold"].as<float>();
            if (obj["temp_threshold"].is<float>())     newTempThr = obj["temp_threshold"].as<float>();
            if (obj["thiThreshold"].is<float>())       newThiThr = obj["thiThreshold"].as<float>();
            if (obj["thi_threshold"].is<float>())      newThiThr = obj["thi_threshold"].as<float>();
            if (obj["minWaterLevelPct"].is<float>())   newMinWater = obj["minWaterLevelPct"].as<float>();
            if (obj["min_water"].is<float>())          newMinWater = obj["min_water"].as<float>();

            if (obj["thiThresholds"].is<JsonObject>()) {
                JsonObject tt = obj["thiThresholds"].as<JsonObject>();
                if (tt["normalMax"].is<float>())  newNormalMax = tt["normalMax"].as<float>();
                if (tt["stressMax"].is<float>())  newStressMax = tt["stressMax"].as<float>();
                if (tt["extremeMax"].is<float>()) newExtremeMax = tt["extremeMax"].as<float>();
            }
            if (obj["normalMax"].is<float>())  newNormalMax = obj["normalMax"].as<float>();
            if (obj["stressMax"].is<float>())  newStressMax = obj["stressMax"].as<float>();
            if (obj["extremeMax"].is<float>()) newExtremeMax = obj["extremeMax"].as<float>();

            if (obj["operationDurations"].is<JsonObject>()) {
                JsonObject od = obj["operationDurations"].as<JsonObject>();
                if (od["mistDurationMin"].is<float>()) newMistDur = od["mistDurationMin"].as<float>();
                if (od["mistPauseSec"].is<float>())    newMistPause = od["mistPauseSec"].as<float>();
            }
            if (obj["mistDurationMin"].is<float>()) newMistDur = obj["mistDurationMin"].as<float>();
            if (obj["mistPauseSec"].is<float>())    newMistPause = obj["mistPauseSec"].as<float>();

            String err;
            if (!validateSettings(newMinWater, newMistDur, newMistPause,
                                  newThiThr, newTempThr, newNormalMax,
                                  newStressMax, newExtremeMax, err)) {
                JsonDocument errDoc;
                errDoc["ok"] = false;
                errDoc["msg"] = err;
                String errJson;
                serializeJson(errDoc, errJson);
                request->send(400, "application/json", errJson);
                return;
            }

            tempThreshold    = newTempThr;
            thiThreshold     = newThiThr;
            minWaterLevelPct = newMinWater;
            thiNormalMax     = newNormalMax;
            thiStressMax     = newStressMax;
            thiExtremeMax    = newExtremeMax;
            mistDurationMin  = newMistDur;
            mistPauseSec     = newMistPause;

            saveSettings();

            JsonDocument res;
            settingsToJson(res.to<JsonObject>());
            String resJson;
            serializeJson(res, resJson);
            request->send(200, "application/json", resJson);
        });
    postSettingsHandler->setMethod(HTTP_POST);
    srv.addHandler(postSettingsHandler);

    // GET /api/settings/threshold
    srv.on("/api/settings/threshold", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["value"] = tempThreshold;
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // POST /api/settings/threshold {"value": 32}
    AsyncCallbackJsonWebHandler *postThreshHandler = new AsyncCallbackJsonWebHandler("/api/settings/threshold",
        [](AsyncWebServerRequest *request, JsonVariant &json) {
            if (!isAuthorized(request)) {
                sendUnauthorized(request);
                return;
            }
            if (!json.is<JsonObject>()) {
                request->send(400, "application/json", "{\"error\":\"Expected JSON object\"}");
                return;
            }
            JsonObject obj = json.as<JsonObject>();
            if (!obj["value"].is<float>()) {
                request->send(400, "application/json", "{\"error\":\"value must be a number\"}");
                return;
            }
            float newTempThr = obj["value"].as<float>();
            String err;
            if (!validateSettings(minWaterLevelPct, mistDurationMin, mistPauseSec,
                                  thiThreshold, newTempThr, thiNormalMax,
                                  thiStressMax, thiExtremeMax, err)) {
                JsonDocument errDoc;
                errDoc["error"] = err;
                String errJson;
                serializeJson(errDoc, errJson);
                request->send(400, "application/json", errJson);
                return;
            }
            tempThreshold = newTempThr;
            saveSettings();

            JsonDocument res;
            res["value"] = tempThreshold;
            String resJson;
            serializeJson(res, resJson);
            request->send(200, "application/json", resJson);
        });
    postThreshHandler->setMethod(HTTP_POST);
    srv.addHandler(postThreshHandler);

    // GET /api/settings/durations
    srv.on("/api/settings/durations", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["mistDurationMin"] = mistDurationMin;
        doc["mistPauseSec"]    = mistPauseSec;
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // POST /api/settings/durations {"mistDurationMin": 5, "mistPauseSec": 30}
    AsyncCallbackJsonWebHandler *postDurHandler = new AsyncCallbackJsonWebHandler("/api/settings/durations",
        [](AsyncWebServerRequest *request, JsonVariant &json) {
            if (!isAuthorized(request)) {
                sendUnauthorized(request);
                return;
            }
            if (!json.is<JsonObject>()) {
                request->send(400, "application/json", "{\"error\":\"Expected JSON object\"}");
                return;
            }
            JsonObject obj = json.as<JsonObject>();
            float newMistDur   = mistDurationMin;
            float newMistPause = mistPauseSec;
            if (obj["mistDurationMin"].is<float>()) {
                newMistDur = obj["mistDurationMin"].as<float>();
            }
            if (obj["mistPauseSec"].is<float>()) {
                newMistPause = obj["mistPauseSec"].as<float>();
            }

            String err;
            if (!validateSettings(minWaterLevelPct, newMistDur, newMistPause,
                                  thiThreshold, tempThreshold, thiNormalMax,
                                  thiStressMax, thiExtremeMax, err)) {
                JsonDocument errDoc;
                errDoc["error"] = err;
                String errJson;
                serializeJson(errDoc, errJson);
                request->send(400, "application/json", errJson);
                return;
            }

            mistDurationMin = newMistDur;
            mistPauseSec    = newMistPause;
            saveSettings();

            JsonDocument res;
            res["mistDurationMin"] = mistDurationMin;
            res["mistPauseSec"]    = mistPauseSec;
            String resJson;
            serializeJson(res, resJson);
            request->send(200, "application/json", resJson);
        });
    postDurHandler->setMethod(HTTP_POST);
    srv.addHandler(postDurHandler);

    // GET /api/settings/thi
    srv.on("/api/settings/thi", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["normalMax"]  = thiNormalMax;
        doc["stressMax"]  = thiStressMax;
        doc["extremeMax"] = thiExtremeMax;
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // POST /api/settings/thi {"normalMax": 74, "stressMax": 78, "extremeMax": 83}
    AsyncCallbackJsonWebHandler *postThiHandler = new AsyncCallbackJsonWebHandler("/api/settings/thi",
        [](AsyncWebServerRequest *request, JsonVariant &json) {
            if (!isAuthorized(request)) {
                sendUnauthorized(request);
                return;
            }
            if (!json.is<JsonObject>()) {
                request->send(400, "application/json", "{\"error\":\"Expected JSON object\"}");
                return;
            }
            JsonObject obj = json.as<JsonObject>();
            float newNormalMax  = thiNormalMax;
            float newStressMax  = thiStressMax;
            float newExtremeMax = thiExtremeMax;
            if (obj["normalMax"].is<float>())  newNormalMax = obj["normalMax"].as<float>();
            if (obj["stressMax"].is<float>())  newStressMax = obj["stressMax"].as<float>();
            if (obj["extremeMax"].is<float>()) newExtremeMax = obj["extremeMax"].as<float>();

            String err;
            if (!validateSettings(minWaterLevelPct, mistDurationMin, mistPauseSec,
                                  thiThreshold, tempThreshold, newNormalMax,
                                  newStressMax, newExtremeMax, err)) {
                JsonDocument errDoc;
                errDoc["error"] = err;
                String errJson;
                serializeJson(errDoc, errJson);
                request->send(400, "application/json", errJson);
                return;
            }

            thiNormalMax  = newNormalMax;
            thiStressMax  = newStressMax;
            thiExtremeMax = newExtremeMax;
            saveSettings();

            JsonDocument res;
            res["normalMax"]  = thiNormalMax;
            res["stressMax"]  = thiStressMax;
            res["extremeMax"] = thiExtremeMax;
            String resJson;
            serializeJson(res, resJson);
            request->send(200, "application/json", resJson);
        });
    postThiHandler->setMethod(HTTP_POST);
    srv.addHandler(postThiHandler);
}

void setupReadingsRoutes(AsyncWebServer &srv) {
    auto handleReadings = [](AsyncWebServerRequest *request) {
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        response->addHeader("Access-Control-Allow-Origin", "*");
        response->print('[');
        for (size_t i = 0; i < historyCount; i++) {
            size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
            if (i > 0) response->print(',');
            response->printf("{\"time\":\"%s\",\"ts\":%llu,\"temp\":%.1f,\"humidity\":%.1f,\"thi\":%.1f}",
                historyRing[idx].time,
                (unsigned long long)historyRing[idx].ts,
                historyRing[idx].temp,
                historyRing[idx].humidity,
                historyRing[idx].thi);
        }
        response->print(']');
        request->send(response);
    };

    srv.on("/api/readings", HTTP_GET, handleReadings);
    srv.on("/api/readings/history", HTTP_GET, handleReadings);

    // GET /api/reports/export — streams history as CSV; ?range= accepted and ignored (device holds 24 h only)
    srv.on("/api/reports/export", HTTP_GET, [](AsyncWebServerRequest *request) {
        AsyncResponseStream *response = request->beginResponseStream("text/csv");
        response->addHeader("Content-Disposition", "attachment; filename=\"readings.csv\"");
        response->addHeader("Access-Control-Allow-Origin", "*");
        response->print("time,ts,temp,humidity,thi\n");
        for (size_t i = 0; i < historyCount; i++) {
            size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
            response->printf("%s,%llu,%.1f,%.1f,%.1f\n",
                historyRing[idx].time,
                (unsigned long long)historyRing[idx].ts,
                historyRing[idx].temp,
                historyRing[idx].humidity,
                historyRing[idx].thi);
        }
        request->send(response);
    });
}

void setupAuxRoutes(AsyncWebServer &srv) {
    srv.on("/api/water/weekly", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json",
            "[{\"day\":\"Mon\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Tue\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Wed\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Thu\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Fri\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Sat\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0},"
            "{\"day\":\"Sun\",\"mist\":0,\"bathe\":0,\"clean\":0,\"total\":0}]");
    });

    srv.on("/api/diagnostics", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["dht_ok"]   = !isnan(lastTemp) && !isnan(lastHum);
        doc["rtc_ok"]   = rtcOk;
        doc["tank_ok"]  = (lastWaterLevel >= 0);
        doc["flow_ok"]  = true;
        doc["relay_ok"] = true;
        doc["sd_ok"]    = (sdCardStatus == SD_STATUS_READY);
        JsonObject details = doc["details"].to<JsonObject>();
        details["dht"]   = "DHT22 on GPIO 4";
        details["rtc"]   = rtcOk ? "DS3231 on GPIO 8/9" : "DS3231 Not Detected";
        details["tank"]  = "HC-SR04 on GPIO 16/17";
        details["flow"]  = "YF-S201 on GPIO 5";
        details["relay"] = "Relay on GPIO 18";
        details["sd"]    = (sdCardStatus == SD_STATUS_READY) ? "MicroSD SPI (CS:10, MOSI:11, SCK:12, MISO:13)" :
                           (sdCardStatus == SD_STATUS_MISSING) ? "MicroSD Card Not Inserted" : "MicroSD Card Init/Mount Error";

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // GET /api/sd/status
    srv.on("/api/sd/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["sdStatus"] = getSdStatusString();
        doc["mounted"] = sdMounted;
        doc["backendOnline"] = backendOnline;
        doc["pendingOfflineCount"] = sdPendingCount;
        doc["syncedCount"] = sdSyncedCount;
        doc["lastSyncTs"] = lastSyncTs > 0 ? (unsigned long long)lastSyncTs : 0;
        doc["syncInProgress"] = syncInProgress;
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // GET /api/offline/status (mirrors backend offline status endpoint)
    srv.on("/api/offline/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["ok"] = true;
        doc["sdStatus"] = getSdStatusString();
        doc["backendOnline"] = backendOnline;
        doc["pendingOfflineCount"] = sdPendingCount;
        doc["totalSynced"] = sdSyncedCount;
        doc["lastSyncTs"] = lastSyncTs > 0 ? (unsigned long long)lastSyncTs : 0;
        doc["syncInProgress"] = syncInProgress;
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // No event log yet, placeholder.
    srv.on("/api/activity", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "[]");
    });
}

void setupWebServer()
{
    // Settings CRUD: GET/POST /api/settings, /api/settings/threshold, /api/settings/durations, /api/settings/thi
    setupSettingsRoutes(server);

    // Readings History: GET /api/readings, GET /api/readings/history
    setupReadingsRoutes(server);

    // Auxiliary routes: GET /api/water/weekly, GET /api/diagnostics
    setupAuxRoutes(server);

    // Schedule CRUD: GET/POST /api/schedules, PATCH/PUT/DELETE /api/schedules/{id}
    setupScheduleRoutes(server);

    // Mode discovery for dashboard
    server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"mode\":\"device\"}");
    });

    server.on("/api/status", HTTP_GET, handleStatus);

    // POST /api/time {"epoch": <UTC seconds>}
    AsyncCallbackJsonWebHandler *timeHandler = new AsyncCallbackJsonWebHandler("/api/time", [](AsyncWebServerRequest *request, JsonVariant &json) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        if (!json.is<JsonObject>()) {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Expected JSON object with 'epoch' field\"}");
            return;
        }

        JsonObject obj = json.as<JsonObject>();
        if (!obj["epoch"].is<uint32_t>() && !obj["epoch"].is<uint64_t>() && !obj["epoch"].is<long>()) {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Missing or invalid 'epoch' field\"}");
            return;
        }

        uint64_t epochVal = obj["epoch"].as<uint64_t>();

        // Range validation: UTC seconds between 2024-01-01 and 2099-12-31
        if (epochVal < 1704067200ULL || epochVal > 4102444799ULL) {
            request->send(400, "application/json", "{\"ok\":false,\"msg\":\"Epoch out of range (must be UTC seconds between 2024 and 2099)\"}");
            return;
        }

        // Attempt re-init if RTC was previously not detected
        if (!rtcOk) {
            rtcOk = rtc.begin();
        }

        if (!rtcOk) {
            request->send(503, "application/json", "{\"ok\":false,\"msg\":\"RTC DS3231 hardware unavailable\"}");
            return;
        }

        rtc.adjust(DateTime((uint32_t)epochVal));
        rtcTimeValid = true;

        Serial.print("RTC successfully adjusted to UTC epoch: ");
        Serial.println((uint32_t)epochVal);

        JsonDocument resDoc;
        resDoc["ok"] = true;
        resDoc["epoch"] = epochVal;
        resDoc["rtcOk"] = true;

        String resJson;
        serializeJson(resDoc, resJson);
        request->send(200, "application/json", resJson);
    });

    timeHandler->setMethod(HTTP_POST);
    server.addHandler(timeHandler);

    // POST /api/manual {"active": bool, "duration_sec": number, "duration_ms": number}
    // Web handler ONLY sets flags with expiry and max run time — no delay(), no hardware access
    AsyncCallbackJsonWebHandler *manualHandler = new AsyncCallbackJsonWebHandler("/api/manual", [](AsyncWebServerRequest *request, JsonVariant &json) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        bool turnOn = true;
        unsigned long durationMs = MANUAL_DEFAULT_RUN_MS;

        if (json.is<JsonObject>()) {
            JsonObject obj = json.as<JsonObject>();
            if (obj["active"].is<bool>() && !obj["active"].as<bool>()) {
                turnOn = false;
            }
            if (obj["duration_ms"].is<unsigned long>()) {
                durationMs = obj["duration_ms"].as<unsigned long>();
            } else if (obj["duration_sec"].is<unsigned long>()) {
                durationMs = obj["duration_sec"].as<unsigned long>() * 1000UL;
            } else if (obj["duration"].is<unsigned long>()) {
                durationMs = obj["duration"].as<unsigned long>() * 1000UL;
            }
        }

        if (!turnOn) {
            manualActive = false;
            manualExpiryTime = 0;
        } else {
            if (durationMs > MANUAL_MAX_RUN_MS || durationMs == 0) {
                durationMs = MANUAL_MAX_RUN_MS;
            }
            manualActive = true;
            manualStartTime = millis();
            manualExpiryTime = millis() + durationMs;
        }

        JsonDocument resDoc;
        resDoc["ok"] = true;
        resDoc["manual"] = manualActive;
        resDoc["duration_ms"] = manualActive ? (manualExpiryTime - millis()) : 0;
        resDoc["max_run_ms"] = MANUAL_MAX_RUN_MS;

        String resJson;
        serializeJson(resDoc, resJson);
        request->send(200, "application/json", resJson);
    });
    manualHandler->setMethod(HTTP_POST);
    server.addHandler(manualHandler);

    // Dashboard legacy route aliases for manual control
    AsyncCallbackJsonWebHandler *relayControlHandler = new AsyncCallbackJsonWebHandler("/api/relay/control", [](AsyncWebServerRequest *request, JsonVariant &json) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        bool active = true;
        if (json.is<JsonObject>()) {
            JsonObject obj = json.as<JsonObject>();
            if (obj["active"].is<bool>()) {
                active = obj["active"].as<bool>();
            }
        }
        if (!active) {
            manualActive = false;
            manualExpiryTime = 0;
        } else {
            manualActive = true;
            manualStartTime = millis();
            manualExpiryTime = millis() + MANUAL_MAX_RUN_MS;
        }
        JsonDocument resDoc;
        resDoc["ok"] = true;
        resDoc["manualPumpActive"] = manualActive;
        resDoc["relayState"] = manualActive;
        String resJson;
        serializeJson(resDoc, resJson);
        request->send(200, "application/json", resJson);
    });
    relayControlHandler->setMethod(HTTP_POST);
    server.addHandler(relayControlHandler);

    AsyncCallbackJsonWebHandler *relayTestHandler = new AsyncCallbackJsonWebHandler("/api/relay/test", [](AsyncWebServerRequest *request, JsonVariant &json) {
        if (!isAuthorized(request)) {
            sendUnauthorized(request);
            return;
        }
        unsigned long dur = 3000;
        if (json.is<JsonObject>()) {
            JsonObject obj = json.as<JsonObject>();
            if (obj["duration_ms"].is<unsigned long>()) {
                dur = obj["duration_ms"].as<unsigned long>();
            }
        }
        if (dur > MANUAL_MAX_RUN_MS) dur = MANUAL_MAX_RUN_MS;
        manualActive = true;
        manualStartTime = millis();
        manualExpiryTime = millis() + dur;

        JsonDocument resDoc;
        resDoc["ok"] = true;
        resDoc["message"] = "Pump test active";
        JsonObject lpt = resDoc["lastPumpTest"].to<JsonObject>();
        lpt["ts"] = rtcOk ? (uint64_t)rtc.now().unixtime() * 1000ULL : (uint64_t)millis();
        lpt["duration_ms"] = dur;
        lpt["status"] = "Testing";

        String resJson;
        serializeJson(resDoc, resJson);
        request->send(200, "application/json", resJson);
    });
    relayTestHandler->setMethod(HTTP_POST);
    server.addHandler(relayTestHandler);

    // Global CORS headers for cross-origin and preflight requests
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token, Authorization");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");

    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_OPTIONS) {
            request->send(204);
        } else {
            request->send(404, "application/json", "{\"error\":\"Not found\"}");
        }
    });

    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
    server.begin();
    Serial.println("HTTP server started.");
}

// ============================================================
// READ HC-SR04
// ============================================================

float readDistance()
{
    // Clean LOW state before trigger pulse
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(4);

    // 10us trigger pulse to start ranging
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    // Timeout: 30000us (~5.1 meters max range)
    unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);

    // If initial pulse returned 0, do a single quick retry after 1ms
    if (duration == 0)
    {
        delayMicroseconds(1000);
        digitalWrite(TRIG_PIN, LOW);
        delayMicroseconds(4);
        digitalWrite(TRIG_PIN, HIGH);
        delayMicroseconds(10);
        digitalWrite(TRIG_PIN, LOW);
        duration = pulseIn(ECHO_PIN, HIGH, 30000);
    }

    if (duration == 0)
    {
        return -1.0;
    }

    // Speed of sound = 343 m/s = 0.0343 cm/us (divided by 2 for round-trip)
    float distance = (float)duration * 0.0343f / 2.0f;
    return distance;
}

// ============================================================
// CONVERT DISTANCE TO WATER LEVEL
// ============================================================

float calculateWaterLevel(float distance)
{
    if (distance < 0.0f)
    {
        return -1.0f;
    }

    // Empty or sensor placed higher than empty mark
    if (distance >= TANK_EMPTY_CM)
    {
        return 0.0f;
    }

    // Full or closer than full mark
    if (distance <= TANK_FULL_CM)
    {
        return 100.0f;
    }

    float level = ((TANK_EMPTY_CM - distance) / (TANK_EMPTY_CM - TANK_FULL_CM)) * 100.0f;

    // Strict clamping to 0.0% - 100.0%
    if (level < 0.0f) level = 0.0f;
    if (level > 100.0f) level = 100.0f;

    return level;
}

// ============================================================
// CALCULATE YF-S201 FLOW
// ============================================================

void calculateWaterFlow()
{
    unsigned long currentTime = millis();

    // Calculate every 1 second
    if (currentTime - lastFlowCalculation < 1000)
    {
        return;
    }

    unsigned long elapsedTime =
        currentTime - lastFlowCalculation;

    // Safely copy pulse count
    noInterrupts();
    unsigned long currentPulseCount = flowPulseCount;
    interrupts();

    // Number of pulses since previous calculation
    unsigned long pulsesSinceLast =
        currentPulseCount - lastFlowPulseCount;

    // Calculate liters during this period
    float litersUsed =
        pulsesSinceLast / FLOW_PULSES_PER_LITER;

    // Calculate flow rate in liters per minute
    flowRateLPM =
        litersUsed * (60000.0 / elapsedTime);

    // Add water usage to total
    totalWaterUsedL += litersUsed;

    // Save current values
    lastFlowPulseCount = currentPulseCount;
    lastFlowCalculation = currentTime;
}

// ============================================================
// SERIAL PRINT HELPER
// ============================================================

void printStatusToSerial()
{
    if (millis() - lastSerialPrint < SERIAL_PRINT_INTERVAL)
    {
        return;
    }
    lastSerialPrint = millis();

    Serial.print("Temperature: ");
    if (isnan(lastTemp)) {
        Serial.println("SENSOR ERROR");
    } else {
        Serial.print(lastTemp, 1);
        Serial.println(" C");
    }

    Serial.print("Humidity: ");
    if (isnan(lastHum)) {
        Serial.println("SENSOR ERROR");
    } else {
        Serial.print(lastHum, 1);
        Serial.println(" %");
    }

    Serial.print("THI: ");
    if (isnan(lastThi)) {
        Serial.println("SENSOR ERROR");
    } else {
        Serial.println(lastThi, 1);
    }

    if (lastWaterLevel >= 0)
    {
        Serial.print("Water Level: ");
        Serial.print(lastWaterLevel, 1);
        Serial.print(" % (Gate: ");
        Serial.print(lastWaterLevel >= minWaterLevelPct ? "OK" : "LOW");
        Serial.println(")");
    }
    else
    {
        Serial.println("Water Level: SENSOR ERROR");
    }

    Serial.print("Flow Rate: ");
    Serial.print(flowRateLPM, 2);
    Serial.println(" L/min");

    Serial.print("Total Water Used: ");
    Serial.print(totalWaterUsedL, 3);
    Serial.println(" L");

    // Display RTC: Hardware runs in UTC; convert to local timezone (UTC+8) for display
    if (rtcOk) {
        DateTime nowUtc = rtc.now();
        DateTime nowLocal = nowUtc + TimeSpan(LOCAL_TIMEZONE_OFFSET_SEC);

        Serial.print("RTC (Local UTC+8): ");
        if (nowLocal.year() < 10) Serial.print("0");
        Serial.print(nowLocal.year());
        Serial.print("-");
        if (nowLocal.month() < 10) Serial.print("0");
        Serial.print(nowLocal.month());
        Serial.print("-");
        if (nowLocal.day() < 10) Serial.print("0");
        Serial.print(nowLocal.day());
        Serial.print(" ");

        if (nowLocal.hour() < 10) Serial.print("0");
        Serial.print(nowLocal.hour());
        Serial.print(":");

        if (nowLocal.minute() < 10) Serial.print("0");
        Serial.print(nowLocal.minute());
        Serial.print(":");

        if (nowLocal.second() < 10) Serial.print("0");
        Serial.print(nowLocal.second());
        Serial.print(" | UTC Epoch: ");
        Serial.println(nowUtc.unixtime());
    } else {
        Serial.println("RTC: NOT FOUND / ERROR");
    }

    Serial.print("MISTING PUMP: ");
    Serial.print(pumpIsOn ? "ON" : "OFF");
    Serial.print(" (Reason: ");
    Serial.print(currentPumpReason);
    Serial.println(")");

    Serial.print("MICROSD: ");
    Serial.print(getSdStatusString());
    Serial.print(" | PENDING SYNC: ");
    Serial.println(sdPendingCount);
    Serial.print("BACKEND: ");
    Serial.println(backendOnline ? "ONLINE" : "OFFLINE");

    Serial.println("------------------------------");
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
    Serial.begin(115200);
    delay(1000);

    // --------------------------------------------------------
    // PREFERENCES (NVS) SETTINGS
    // --------------------------------------------------------

    loadSettings();

    // --------------------------------------------------------
    // DHT22
    // --------------------------------------------------------

    dht.begin();

    // --------------------------------------------------------
    // RTC DS3231
    // --------------------------------------------------------

    Wire.begin(SDA_PIN, SCL_PIN);

    if (!rtc.begin())
    {
        Serial.println("ERROR: RTC DS3231 NOT FOUND! Continuing without RTC.");
        rtcOk = false;
    }
    else
    {
        Serial.println("RTC DS3231 detected.");
        rtcOk = true;
        rtcTimeValid = !rtc.lostPower();
        if (!rtcTimeValid)
        {
            Serial.println("WARNING: RTC DS3231 lost power! Time is invalid until synchronized.");
        }
    }

    // --------------------------------------------------------
    // HC-SR04
    // --------------------------------------------------------

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);

    // --------------------------------------------------------
    // MISTING RELAY
    // --------------------------------------------------------

    digitalWrite(RELAY_PIN, RELAY_OFF);
    pinMode(RELAY_PIN, OUTPUT);

    // --------------------------------------------------------
    // BATHING RELAY
    // --------------------------------------------------------

    // Initialized OFF only and not used by any logic yet
    digitalWrite(BATH_RELAY_PIN, HIGH);
    pinMode(BATH_RELAY_PIN, OUTPUT);

    // --------------------------------------------------------
    // YF-S201
    // --------------------------------------------------------

    pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);

    attachInterrupt(
        digitalPinToInterrupt(FLOW_SENSOR_PIN),
        flowPulseISR,
        RISING
    );

    lastFlowCalculation = millis();

    // --------------------------------------------------------
    // LITTLEFS
    // --------------------------------------------------------

    if (!LittleFS.begin())
    {
        Serial.println("ERROR: LittleFS mount failed");
    }
    else
    {
        Serial.println("LittleFS mounted.");
        loadSchedules(); // Load persisted schedules; missing file → empty list
        loadHistory();   // Load persisted history readings; missing file → empty history
    }

    // --------------------------------------------------------
    // MICROSD STORAGE (6-pin SPI: CS=10, MOSI=11, SCK=12, MISO=13)
    // --------------------------------------------------------

    initMicroSD();

    // --------------------------------------------------------
    // WIFI
    // --------------------------------------------------------

    setupWiFi();

    if (WiFi.status() == WL_CONNECTED)
    {
        checkBackendHealth();
    }

    // --------------------------------------------------------
    // HTTP SERVER
    // --------------------------------------------------------

    setupWebServer();

    Serial.println("System started.");
    Serial.println("YF-S201 flow sensor initialized.");
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
    // --------------------------------------------------------
    // WIFI RECONNECT
    // --------------------------------------------------------

    reconnectWiFi();

    // --------------------------------------------------------
    // BACKEND SERVER HEALTH CHECK (non-blocking 20s interval)
    // --------------------------------------------------------

    if (WiFi.status() == WL_CONNECTED && (millis() - lastBackendHealthCheck >= BACKEND_HEALTH_CHECK_INTERVAL_MS))
    {
        lastBackendHealthCheck = millis();
        checkBackendHealth();
    }

    // --------------------------------------------------------
    // AUTOMATIC MICROSD BATCH SYNCHRONIZATION
    // Drains pending offline readings to backend in small batches
    // --------------------------------------------------------

    if (backendOnline && sdMounted && sdPendingCount > 0 && !syncInProgress)
    {
        if (millis() - lastSyncBatchAttempt >= SYNC_BATCH_INTERVAL_MS)
        {
            lastSyncBatchAttempt = millis();
            syncBatch();
        }
    }

    // --------------------------------------------------------
    // CALCULATE WATER FLOW (YF-S201)
    // --------------------------------------------------------

    calculateWaterFlow();

    // --------------------------------------------------------
    // READ DHT22 (non-blocking millis timer)
    // --------------------------------------------------------

    if (millis() - lastDHTRead >= DHT_INTERVAL)
    {
        lastDHTRead = millis();

        float temperature = dht.readTemperature();
        float humidity = dht.readHumidity();

        if (!isnan(temperature) && !isnan(humidity))
        {
            lastTemp = temperature;
            lastHum = humidity;
            lastThi = (0.8 * temperature) +
                      ((humidity / 100.0) * (temperature - 14.4)) +
                      46.4;
        }
        else
        {
            lastTemp = NAN;
            lastHum = NAN;
            lastThi = NAN;
        }
    }

    // --------------------------------------------------------
    // READ HC-SR04 (non-blocking millis timer)
    // --------------------------------------------------------

    if (millis() - lastDistanceRead >= DISTANCE_INTERVAL)
    {
        lastDistanceRead = millis();

        float distance = readDistance();
        lastWaterLevel = calculateWaterLevel(distance);
    }

    // --------------------------------------------------------
    // READINGS HISTORY BUFFER, TELEMETRY PUSH & MICROSD OFFLINE LOG
    // --------------------------------------------------------

    // Sample into RAM ring buffer every 5 minutes (or immediately on first valid reading)
    if (!isnan(lastTemp) && !isnan(lastHum) && !isnan(lastThi))
    {
        if (historyCount == 0 || millis() - lastHistorySample >= HISTORY_SAMPLE_INTERVAL_MS)
        {
            lastHistorySample = millis();
            addHistorySample(lastTemp, lastHum, lastThi);
            handleTelemetrySample(lastTemp, lastHum, lastThi, lastWaterLevel, flowRateLPM, totalWaterUsedL, pumpIsOn, currentPumpReason);
        }
    }

    // Write history to LittleFS every 5-10 minutes (constant), minimal flash writes
    if (millis() - lastHistorySave >= HISTORY_SAVE_INTERVAL_MS)
    {
        lastHistorySave = millis();
        if (historyDirty)
        {
            saveHistory();
            historyDirty = false;
        }
    }

    // --------------------------------------------------------
    // PUMP CONTROL (Single engine function)
    // pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
    // --------------------------------------------------------

    updatePump();

    // --------------------------------------------------------
    // PERIODIC SERIAL OUTPUT
    // --------------------------------------------------------

    printStatusToSerial();
}