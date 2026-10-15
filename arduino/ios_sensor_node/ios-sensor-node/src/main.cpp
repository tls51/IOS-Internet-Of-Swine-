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
#include <esp_system.h>
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
bool bathPumpIsOn = false;

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
unsigned long lastEchoDurationUs = 0;
float lastDistanceCm = -1.0f;

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
const unsigned long TELEMETRY_INTERVAL_MS = 15000;
unsigned long lastTelemetrySample = 0;
bool telemetrySampled = false;
bool historySampledThisBoot = false;

// Keep the prior file until a complete replacement has been written.
static void restoreJsonFile(const char* path) {
    String backup = String(path) + ".bak";
    if (!LittleFS.exists(path) && LittleFS.exists(backup)) LittleFS.rename(backup, path);
}

static bool writeJsonFileSafely(const char* path, const JsonDocument& doc) {
    String temp = String(path) + ".tmp";
    String backup = String(path) + ".bak";
    restoreJsonFile(path);
    File file = LittleFS.open(temp, "w");
    if (!file) return false;
    size_t expected = measureJson(doc);
    size_t written = serializeJson(doc, file);
    file.flush();
    bool complete = written == expected && file.getWriteError() == 0;
    file.close();
    if (!complete) { LittleFS.remove(temp); return false; }
    LittleFS.remove(backup);
    if (LittleFS.exists(path) && !LittleFS.rename(path, backup)) return false;
    if (!LittleFS.rename(temp, path)) {
        restoreJsonFile(path);
        return false;
    }
    LittleFS.remove(backup);
    return true;
}

// Small persistent log for the standalone ESP32 dashboard.
#define ACTIVITY_CAPACITY 60
#define ACTIVITY_FILE "/activity.json"
struct ActivityRecord { uint64_t ts; char type[12]; char msg[160]; };
ActivityRecord activityRing[ACTIVITY_CAPACITY];
size_t activityCount = 0, activityHead = 0;

static void loadActivity() {
    restoreJsonFile(ACTIVITY_FILE);
    File file = LittleFS.open(ACTIVITY_FILE, "r");
    if (!file) return;
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, file);
    file.close();
    if (error || !doc.is<JsonArray>()) return;
    for (JsonObject obj : doc.as<JsonArray>()) {
        ActivityRecord& rec = activityRing[activityHead];
        rec.ts = obj["ts"] | 0ULL;
        strlcpy(rec.type, obj["type"] | "Info", sizeof(rec.type));
        strlcpy(rec.msg, obj["msg"] | "", sizeof(rec.msg));
        activityHead = (activityHead + 1) % ACTIVITY_CAPACITY;
        if (activityCount < ACTIVITY_CAPACITY) activityCount++;
    }
}

static void appendActivity(const char* type, const char* message) {
    ActivityRecord& rec = activityRing[activityHead];
    rec.ts = rtcOk && rtcTimeValid ? (uint64_t)rtc.now().unixtime() * 1000ULL : 0;
    strlcpy(rec.type, type, sizeof(rec.type));
    strlcpy(rec.msg, message, sizeof(rec.msg));
    activityHead = (activityHead + 1) % ACTIVITY_CAPACITY;
    if (activityCount < ACTIVITY_CAPACITY) activityCount++;
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (size_t i = 0; i < activityCount; i++) {
        size_t idx = activityCount < ACTIVITY_CAPACITY ? i : (activityHead + i) % ACTIVITY_CAPACITY;
        JsonObject obj = arr.add<JsonObject>();
        obj["ts"] = activityRing[idx].ts;
        obj["type"] = activityRing[idx].type;
        obj["msg"] = activityRing[idx].msg;
    }
    if (!writeJsonFileSafely(ACTIVITY_FILE, doc)) Serial.println("WARNING: Activity log could not be persisted.");
}

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

    if (rtcOk && rtcTimeValid) {
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
    restoreJsonFile(HISTORY_FILE);
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

bool saveHistory() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (size_t i = 0; i < historyCount; i++) {
        size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
        JsonObject obj = arr.add<JsonObject>();
        obj["time"] = historyRing[idx].time;
        obj["ts"] = historyRing[idx].ts;
        obj["temp"] = historyRing[idx].temp;
        obj["humidity"] = historyRing[idx].humidity;
        obj["thi"] = historyRing[idx].thi;
    }
    if (!writeJsonFileSafely(HISTORY_FILE, doc)) {
        Serial.println("ERROR: Could not persist history.json; will retry.");
        return false;
    }
    Serial.println("History saved to LittleFS.");
    return true;
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
const char* sdLastError = "Not initialized";
uint32_t sdSpiFrequencyHz = 0;
unsigned long lastSdMountAttempt = 0;
const unsigned long SD_RETRY_INTERVAL_MS = 30000;

// MicroSD Card & Filesystem Metrics (cached to minimize SPI traffic on polls)
String sdCardTypeStr = "Unavailable";
uint64_t sdCardSizeBytes = 0;
uint64_t sdTotalBytes = 0;
uint64_t sdUsedBytes = 0;
unsigned long lastFsMetricsUpdate = 0;
const unsigned long FS_METRICS_REFRESH_INTERVAL_MS = 60000;

// Periodic backend diagnostics push
unsigned long lastDiagnosticsPush = 0;
const unsigned long DIAGNOSTICS_PUSH_INTERVAL_MS = 60000;

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

// Device MAC, random boot ID and sequence avoid record collisions after reboot
static uint32_t recordSeq = 0;
static uint32_t recordBootId = 0;
static void makeRecordId(char* out, size_t length) {
    if (recordBootId == 0) recordBootId = esp_random();
    snprintf(out, length, "%012llx-%08lx-%08lx",
        (unsigned long long)ESP.getEfuseMac(), (unsigned long)recordBootId, (unsigned long)++recordSeq);
}

const char* getSdStatusString() {
    switch (sdCardStatus) {
        case SD_STATUS_READY:   return "Ready";
        case SD_STATUS_MISSING: return "Missing";
        case SD_STATUS_ERROR:   return "Error";
        default:                return "Unknown";
    }
}

const char* getSdCardTypeString() {
    if (!sdMounted) return "Unavailable";
    switch (SD.cardType()) {
        case CARD_MMC:     return "MMC";
        case CARD_SD:      return "SD";
        case CARD_SDHC:    return "SDHC";
        case CARD_UNKNOWN: return "UNKNOWN";
        case CARD_NONE:
        default:           return "Unavailable";
    }
}

void updateSdMetrics(bool force = false) {
    if (!sdMounted) {
        sdCardTypeStr = "Unavailable";
        sdCardSizeBytes = 0;
        sdTotalBytes = 0;
        sdUsedBytes = 0;
        return;
    }

    if (force || lastFsMetricsUpdate == 0 || millis() - lastFsMetricsUpdate >= FS_METRICS_REFRESH_INTERVAL_MS) {
        lastFsMetricsUpdate = millis();
        sdCardTypeStr = getSdCardTypeString();
        sdCardSizeBytes = SD.cardSize();
        sdTotalBytes = SD.totalBytes();
        sdUsedBytes = SD.usedBytes();
    }
}

void populateSdInfo(JsonObject sd) {
    updateSdMetrics(false);
    bool ok = sdMounted && (sdCardStatus == SD_STATUS_READY);
    sd["ok"] = ok;
    sd["status"] = getSdStatusString();
    sd["sdStatus"] = getSdStatusString();
    sd["mounted"] = sdMounted;
    sd["cardType"] = sdMounted ? sdCardTypeStr : "Unavailable";
    if (sdMounted && sdCardSizeBytes > 0) {
        sd["cardSizeBytes"] = sdCardSizeBytes;
    } else {
        sd["cardSizeBytes"] = nullptr;
    }
    if (sdMounted && sdTotalBytes > 0) {
        sd["totalBytes"] = sdTotalBytes;
        sd["usedBytes"] = sdUsedBytes;
        uint64_t avail = (sdTotalBytes > sdUsedBytes) ? (sdTotalBytes - sdUsedBytes) : 0;
        sd["availableBytes"] = avail;
        sd["freeBytes"] = avail;
    } else {
        sd["totalBytes"] = nullptr;
        sd["usedBytes"] = nullptr;
        sd["availableBytes"] = nullptr;
        sd["freeBytes"] = nullptr;
    }
    sd["csPin"] = SD_CS_PIN;
    sd["mosiPin"] = SD_MOSI_PIN;
    sd["sckPin"] = SD_SCK_PIN;
    sd["misoPin"] = SD_MISO_PIN;
    sd["spiFrequencyHz"] = sdSpiFrequencyHz;
    sd["sdSpiFrequencyHz"] = sdSpiFrequencyHz;
    sd["logPath"] = SD_LOG_FILE;
    sd["pendingCount"] = sdPendingCount;
    sd["pendingOfflineCount"] = sdPendingCount;
    sd["syncedCount"] = sdSyncedCount;
    sd["syncInProgress"] = syncInProgress;
    sd["syncState"] = syncInProgress ? "Synchronizing" : "Idle";
    if (lastSyncTs > 0 && rtcOk && rtcTimeValid) {
        sd["lastSyncTs"] = (unsigned long long)lastSyncTs;
    } else {
        sd["lastSyncTs"] = nullptr;
    }
    sd["lastError"] = sdLastError;
    sd["sdError"] = sdLastError;
    if (rtcOk && rtcTimeValid) {
        DateTime nowUtc = rtc.now();
        sd["statusTs"] = (uint64_t)nowUtc.unixtime() * 1000ULL;
    } else {
        sd["statusTs"] = nullptr;
    }
}

bool sendDiagnosticsToBackend() {
    if (WiFi.status() != WL_CONNECTED || !backendOnline) {
        return false;
    }

    JsonDocument doc;
    doc["dht_ok"]   = !isnan(lastTemp) && !isnan(lastHum);
    doc["rtc_ok"]   = rtcOk;
    doc["tank_ok"]  = (lastWaterLevel >= 0);
    doc["flow_ok"]  = true;
    doc["relay_ok"] = true;
    doc["sd_ok"]    = sdMounted && (sdCardStatus == SD_STATUS_READY);
    doc["sdStatus"] = getSdStatusString();
    doc["sdError"]  = sdLastError;

    if (rtcOk && rtcTimeValid) {
        doc["ts"] = (uint64_t)rtc.now().unixtime() * 1000ULL;
    } else {
        doc["ts"] = nullptr;
    }

    JsonObject details = doc["details"].to<JsonObject>();
    details["dht"]   = "DHT22 on GPIO 4";
    details["rtc"]   = rtcOk ? "DS3231 on GPIO 8/9" : "DS3231 Not Detected";
    details["tank"]  = "HC-SR04 on GPIO 16/17";
    details["flow"]  = "YF-S201 on GPIO 5";
    details["relay"] = "Relay on GPIO 18";
    details["sd"]    = sdMounted ? "MicroSD SPI (CS:10, MOSI:11, SCK:12, MISO:13)" : sdLastError;
    JsonObject sdInfo = details["sd_info"].to<JsonObject>();
    populateSdInfo(sdInfo);

    String payload;
    serializeJson(doc, payload);

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(2500);
    String url = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/diagnostics";
    if (!http.begin(client, url)) {
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    int code = http.POST(payload);
    bool ok = (code == 200 || code == 201);
    http.end();
    if (ok) {
        Serial.println("Diagnostics: Sent hardware status & MicroSD report to Node backend.");
    }
    return ok;
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

void setSdMissing(const char* reason) {
    sdMounted = false;
    sdCardStatus = SD_STATUS_MISSING;
    sdLastError = reason;
    sdSpiFrequencyHz = 0;
    sdCardTypeStr = "Unavailable";
    sdCardSizeBytes = 0;
    sdTotalBytes = 0;
    sdUsedBytes = 0;
    lastSdMountAttempt = millis();
    Serial.printf("MicroSD MISSING: %s\n", reason);
}

void setSdError(const char* reason) {
    sdMounted = false;
    sdCardStatus = SD_STATUS_ERROR;
    sdLastError = reason;
    sdSpiFrequencyHz = 0;
    sdCardTypeStr = "Unavailable";
    sdCardSizeBytes = 0;
    sdTotalBytes = 0;
    sdUsedBytes = 0;
    lastSdMountAttempt = millis();
    Serial.printf("MicroSD ERROR: %s\n", reason);
}

bool tryMountMicroSD(uint32_t frequencyHz) {
    lastSdMountAttempt = millis();
    sdMounted = false;
    sdCardStatus = SD_STATUS_UNKNOWN;
    sdLastError = "Initializing";
    sdSpiFrequencyHz = 0;

    // Reset a previous failed mount and explicitly reuse the configured pins.
    SD.end();
    SPI.end();
    digitalWrite(SD_CS_PIN, HIGH);
    pinMode(SD_CS_PIN, OUTPUT);
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
    delay(100);

    Serial.printf("MicroSD: CS=%d, MOSI=%d, SCK=%d, MISO=%d; SPI=%lu Hz\n",
                  SD_CS_PIN, SD_MOSI_PIN, SD_SCK_PIN, SD_MISO_PIN,
                  (unsigned long)frequencyHz);

    // Never automatically format: existing readings must be preserved.
    if (!SD.begin(SD_CS_PIN, SPI, frequencyHz, "/sd", 5, false)) {
        if (SD.cardType() == CARD_NONE) {
            setSdMissing("No card detected in slot; check card insertion and contacts");
        } else {
            setSdError("Card mount failed; check SPI wiring, power and filesystem");
        }
        return false;
    }
    if (SD.cardType() == CARD_NONE) {
        SD.end();
        setSdMissing("No responsive card detected after mount");
        return false;
    }
    if (!SD.exists("/ios") && !SD.mkdir("/ios")) {
        SD.end();
        setSdError("Cannot create /ios directory");
        return false;
    }

    // Opening the log in append mode preserves existing records and checks
    // that the logging path is accessible.
    File log = SD.open(SD_LOG_FILE, FILE_APPEND);
    if (!log) {
        SD.end();
        setSdError("Cannot open offline log for appending");
        return false;
    }
    log.close();

    sdMounted = true;
    sdCardStatus = SD_STATUS_READY;
    sdLastError = "";
    sdSpiFrequencyHz = frequencyHz;
    updateSdMetrics(true);
    Serial.printf("MicroSD READY: %s, %llu MB; SPI=%lu Hz\n",
                  sdCardTypeStr.c_str(),
                  (unsigned long long)(sdCardSizeBytes / (1024ULL * 1024ULL)),
                  (unsigned long)frequencyHz);
    loadSyncProgress();
    calculatePendingRecords();
    return true;
}

void initMicroSD() {
    // Lower speeds improve the chances of reliable breadboard operation.
    if (!tryMountMicroSD(1000000)) {
        delay(200);
        tryMountMicroSD(400000);
    }
}

void serviceMicroSD() {
    // One attempt per interval; avoid repeated startup retries in each loop.
    if (!sdMounted && !syncInProgress &&
        millis() - lastSdMountAttempt >= SD_RETRY_INTERVAL_MS) {
        Serial.println("MicroSD: retrying mount at 400 kHz...");
        tryMountMicroSD(400000);
    }
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
        JsonDocument response;
        if (!deserializeJson(response, payload) && response["ok"].as<bool>()) {
            ok = true;
            uint64_t serverMs = response["time"] | 0ULL;
            if (rtcOk && !rtcTimeValid && serverMs >= 1704067200000ULL && serverMs <= 4102444799000ULL) {
                rtc.adjust(DateTime((uint32_t)(serverMs / 1000ULL)));
                rtcTimeValid = true;
                Serial.println("RTC recovered from backend UTC time.");
            }
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
        setSdError("Offline log could not be opened; retry scheduled");
        return false;
    }

    char recordId[48];
    makeRecordId(recordId, sizeof(recordId));
    uint64_t tsMs = 0;
    bool hasValidRtc = (rtcOk && rtcTimeValid);

    if (hasValidRtc) {
        DateTime nowUtc = rtc.now();
        tsMs = (uint64_t)nowUtc.unixtime() * 1000ULL;
    } else {
        // RTC unavailable: use uptime as a monotone proxy timestamp so the
        // backend can still import the record (ts=null is skipped by the DB).
        // Marked rtc_valid:false so the server knows the time is approximate.
        tsMs = (uint64_t)millis();
    }

    const char* thiLabel = "Normal";
    if (!isnan(thi)) {
        if (thi < thiNormalMax)        thiLabel = "Normal";
        else if (thi <= thiStressMax)  thiLabel = "Stressful";
        else if (thi <= thiExtremeMax) thiLabel = "Extreme Heat";
        else                            thiLabel = "Danger Zone";
    }

    JsonDocument doc;
    doc["id"]        = recordId;
    doc["ts"]        = tsMs;   // always non-null: RTC epoch ms or uptime ms
    doc["ts_ms"]     = tsMs;
    doc["rtc_valid"] = hasValidRtc;
    if (!hasValidRtc) {
        doc["uptime_ms"] = tsMs; // alias so recipient can distinguish
    }

    if (!isnan(temp)) doc["temp"] = temp; else doc["temp"] = nullptr;
    if (!isnan(hum))  doc["humidity"] = hum; else doc["humidity"] = nullptr;
    if (!isnan(thi))  doc["thi"] = thi; else doc["thi"] = nullptr;
    doc["thi_label"] = thiLabel;

    if (waterLevel >= 0) {
        doc["water_level"]     = waterLevel;
        doc["water_level_pct"] = waterLevel;
    } else {
        doc["water_level"]     = nullptr;
        doc["water_level_pct"] = nullptr;
    }

    doc["flow_lpm"]    = flowRate;
    doc["water_used"]  = waterUsed;
    doc["water_used_l"] = waterUsed;
    doc["pump_on"]     = pumpOn;
    doc["pump_reason"] = pumpReason ? pumpReason : "idle";

    const size_t expectedBytes = measureJson(doc);
    const size_t writtenBytes = serializeJson(doc, f);
    const size_t newlineBytes = f.print('\n');
    f.flush();
    const int writeError = f.getWriteError();
    f.close();

    if (writtenBytes != expectedBytes || newlineBytes != 1 || writeError != 0) {
        setSdError("Offline log write failed; check card space, power and contacts");
        return false;
    }

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

    char recordId[48];
    makeRecordId(recordId, sizeof(recordId));
    uint64_t tsMs = 0;
    bool hasValidRtc = (rtcOk && rtcTimeValid);

    if (hasValidRtc) {
        DateTime nowUtc = rtc.now();
        tsMs = (uint64_t)nowUtc.unixtime() * 1000ULL;
    } else {
        // RTC unavailable: use uptime as a proxy so the backend doesn't drop
        // the record due to a null ts. Marked rtc_valid:false for transparency.
        tsMs = (uint64_t)millis();
    }

    const char* thiLabel = "Normal";
    if (!isnan(thi)) {
        if (thi < thiNormalMax)        thiLabel = "Normal";
        else if (thi <= thiStressMax)  thiLabel = "Stressful";
        else if (thi <= thiExtremeMax) thiLabel = "Extreme Heat";
        else                            thiLabel = "Danger Zone";
    }

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    JsonObject obj = arr.add<JsonObject>();
    obj["id"]        = recordId;
    obj["ts"]        = tsMs;   // always non-null: RTC epoch ms or uptime ms
    obj["ts_ms"]     = tsMs;
    obj["rtc_valid"] = hasValidRtc;
    if (!hasValidRtc) {
        obj["uptime_ms"] = tsMs; // alias so recipient can distinguish
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
        JsonDocument acknowledgement;
        bool parsed = !deserializeJson(acknowledgement, http.getString());
        success = parsed && acknowledgement["ok"].as<bool>()
            && (acknowledgement["failed"] | 0) == 0;
        bool found = false;
        if (success) {
            for (const char* id : acknowledgement["accepted_ids"].as<JsonArray>()) {
                if (id && strcmp(id, recordId) == 0) found = true;
            }
        }
        success = success && found;
        if (success) lastSyncTs = hasValidRtc ? tsMs : (uint64_t)millis();
        if (!success) Serial.println("ERROR: Backend did not acknowledge this reading.");
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
    // Persist every sample before upload, including while the backend is online.
    // A sudden ESP32 shutdown cannot undo a completed SD write or DB commit.
    if (logOfflineReading(temp, hum, thi, waterLevel, flowRate, waterUsed, pumpOn, pumpReason)) return;
    if (backendOnline && sendTelemetryDirect(temp, hum, thi, waterLevel, flowRate, waterUsed, pumpOn, pumpReason)) return;
    Serial.println("ERROR: Telemetry was not saved: neither SD nor backend accepted it.");
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
            accepted = (resDoc["failed"] | 0) == 0;
            for (JsonObject reading : arr) {
                bool found = false;
                const char* sentId = reading["id"] | "";
                for (const char* id : acceptedArr) {
                    if (id && strcmp(id, sentId) == 0) found = true;
                }
                if (!found) accepted = false;
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

extern Schedule backendSchedules[MAX_SCHEDULES];
extern uint8_t backendScheduleCount;

// ── Check all schedules; returns true if any is currently active ──────────
bool anyScheduleActive() {
    for (uint8_t group = 0; group < 2; group++) {
        Schedule* entries = group == 0 ? schedules : backendSchedules;
        uint8_t count = group == 0 ? scheduleCount : backendScheduleCount;
        for (uint8_t i = 0; i < count; i++) {
            if (isScheduleActiveNow(entries[i])) {
                strlcpy(activeScheduleType, entries[i].type, sizeof(activeScheduleType));
                return true;
            }
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
    restoreJsonFile(SCHEDULES_FILE);
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
bool saveSchedules() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (uint8_t i = 0; i < scheduleCount; i++) scheduleToJson(arr.add<JsonObject>(), schedules[i]);
    if (!writeJsonFileSafely(SCHEDULES_FILE, doc)) {
        Serial.println("ERROR: Schedule file could not be persisted.");
        return false;
    }
    Serial.println("schedules.json saved safely.");
    return true;
}

// Validate before mutating RAM; malformed data must not become a running schedule.
static bool validateScheduleJson(JsonObject obj, bool partial = false) {
    if (!partial || !obj["type"].isNull()) {
        const char* type = obj["type"] | "";
        if (strcmp(type, "mist") && strcmp(type, "bath") && strcmp(type, "clean")) return false;
    }
    if (!partial || !obj["time"].isNull()) {
        const char* time = obj["time"] | "";
        if (strlen(time) != 5 || time[2] != ':' || !isdigit(time[0]) || !isdigit(time[1]) || !isdigit(time[3]) || !isdigit(time[4])) return false;
        int h = (time[0] - '0') * 10 + time[1] - '0';
        int m = (time[3] - '0') * 10 + time[4] - '0';
        if (h > 23 || m > 59) return false;
    }
    if (!partial || !obj["duration"].isNull()) {
        if (!obj["duration"].is<int>() || obj["duration"].as<int>() < 1 || obj["duration"].as<int>() > 1440) return false;
    }
    if (!partial || !obj["days"].isNull()) {
        if (!obj["days"].is<JsonArray>() || obj["days"].size() == 0 || obj["days"].size() > 7) return false;
        for (JsonVariant day : obj["days"].as<JsonArray>()) {
            if (!day.is<const char*>() || dayStringToRtcDow(day.as<const char*>()) < 0) return false;
        }
    }
    return obj["active"].isNull() || obj["active"].is<bool>();
}

// Backend schedules have a separate cache. Pulling Node changes never deletes
// standalone schedules created on the ESP32 itself.
#define BACKEND_SCHEDULES_FILE "/backend_schedules.json"
Schedule backendSchedules[MAX_SCHEDULES];
uint8_t backendScheduleCount = 0;
unsigned long lastSchedulePull = 0;
const unsigned long SCHEDULE_PULL_INTERVAL_MS = 10000;
String backendScheduleSnapshot;

static bool importBackendSchedules(JsonArray arr) {
    if (arr.size() > MAX_SCHEDULES) return false;
    Schedule staged[MAX_SCHEDULES] = {};
    uint8_t count = 0;
    for (JsonObject obj : arr) {
        if (!validateScheduleJson(obj)) return false;
        Schedule& s = staged[count++];
        String id = obj["id"].as<String>();
        strlcpy(s.id, id.c_str(), sizeof(s.id));
        strlcpy(s.type, obj["type"] | "", sizeof(s.type));
        strlcpy(s.label, obj["label"] | "", sizeof(s.label));
        strlcpy(s.time, obj["time"] | "", sizeof(s.time));
        s.duration = obj["duration"].as<uint16_t>();
        s.active = obj["active"] | true;
        for (const char* day : obj["days"].as<JsonArray>()) strlcpy(s.days[s.dayCount++], day, sizeof(s.days[0]));
    }
    memcpy(backendSchedules, staged, sizeof(staged));
    backendScheduleCount = count;
    return true;
}

static void loadBackendSchedules() {
    restoreJsonFile(BACKEND_SCHEDULES_FILE);
    File file = LittleFS.open(BACKEND_SCHEDULES_FILE, "r");
    if (!file) return;
    JsonDocument doc;
    bool parsed = !deserializeJson(doc, file);
    file.close();
    if (parsed && doc.is<JsonArray>() && importBackendSchedules(doc.as<JsonArray>())) serializeJson(doc, backendScheduleSnapshot);
}

static void fetchBackendSchedules() {
    if (!backendOnline || WiFi.status() != WL_CONNECTED) return;
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(1500);
    String url = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/schedules?type=all";
    if (!http.begin(client, url)) return;
    int code = http.GET();
    String payload = code == 200 ? http.getString() : "";
    http.end();
    if (code != 200 || payload == backendScheduleSnapshot) return;
    JsonDocument doc;
    if (deserializeJson(doc, payload) || !doc.is<JsonArray>()) return;
    JsonArray arr = doc.as<JsonArray>();
    if (arr.size() > MAX_SCHEDULES) { Serial.println("ERROR: Backend schedule snapshot exceeds 20 schedules."); return; }
    for (JsonObject obj : arr) if (!validateScheduleJson(obj)) return;
    if (!writeJsonFileSafely(BACKEND_SCHEDULES_FILE, doc)) { Serial.println("ERROR: Backend schedule cache could not be saved."); return; }
    if (importBackendSchedules(arr)) {
        backendScheduleSnapshot = payload;
        Serial.printf("Schedules: Cached %u backend schedule(s).\n", backendScheduleCount);
    }
}

// ============================================================
// ACCESS CONTROL & SESSION AUTHENTICATION
// ============================================================

#ifndef ADMIN_USER
#define ADMIN_USER "admin"
#endif

#ifndef ADMIN_PASSWORD
#define ADMIN_PASSWORD "ios2024"
#endif

struct AdminSession {
    char token[33];
    uint32_t createdAt; // uptime in seconds
    bool active;
};

#define MAX_ADMIN_SESSIONS 8
const uint32_t ADMIN_SESSION_TTL_SEC = 24 * 3600; // 24 hours
static AdminSession adminSessions[MAX_ADMIN_SESSIONS];
static bool adminSessionsInitialized = false;

static uint32_t getUptimeSeconds() {
    return (uint32_t)(millis() / 1000UL);
}

static void initAdminSessions() {
    if (adminSessionsInitialized) return;
    for (int i = 0; i < MAX_ADMIN_SESSIONS; i++) {
        adminSessions[i].active = false;
        adminSessions[i].token[0] = '\0';
        adminSessions[i].createdAt = 0;
    }
    adminSessionsInitialized = true;
}

static void cleanExpiredSessions() {
    initAdminSessions();
    uint32_t now = getUptimeSeconds();
    for (int i = 0; i < MAX_ADMIN_SESSIONS; i++) {
        if (adminSessions[i].active) {
            if (now < adminSessions[i].createdAt || (now - adminSessions[i].createdAt) > ADMIN_SESSION_TTL_SEC) {
                adminSessions[i].active = false;
                adminSessions[i].token[0] = '\0';
            }
        }
    }
}

static String createAdminSession() {
    cleanExpiredSessions();
    int slot = -1;
    uint32_t oldestTime = UINT32_MAX;
    int oldestSlot = 0;
    for (int i = 0; i < MAX_ADMIN_SESSIONS; i++) {
        if (!adminSessions[i].active) {
            slot = i;
            break;
        }
        if (adminSessions[i].createdAt < oldestTime) {
            oldestTime = adminSessions[i].createdAt;
            oldestSlot = i;
        }
    }
    if (slot == -1) {
        slot = oldestSlot;
    }

    const char hexChars[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        adminSessions[slot].token[i] = hexChars[esp_random() % 16];
    }
    adminSessions[slot].token[32] = '\0';
    adminSessions[slot].createdAt = getUptimeSeconds();
    adminSessions[slot].active = true;

    return String(adminSessions[slot].token);
}

static bool isValidAdminSession(const String &token) {
    if (token.length() != 32) return false;
    cleanExpiredSessions();
    for (int i = 0; i < MAX_ADMIN_SESSIONS; i++) {
        if (adminSessions[i].active && token.equals(adminSessions[i].token)) {
            return true;
        }
    }
    return false;
}

static void destroyAdminSession(const String &token) {
    cleanExpiredSessions();
    for (int i = 0; i < MAX_ADMIN_SESSIONS; i++) {
        if (adminSessions[i].active && token.equals(adminSessions[i].token)) {
            adminSessions[i].active = false;
            adminSessions[i].token[0] = '\0';
            break;
        }
    }
}

static String extractCookieValue(AsyncWebServerRequest *request, const char* name) {
    if (!request->hasHeader("Cookie")) return "";
    const AsyncWebHeader *h = request->getHeader("Cookie");
    if (!h) return "";
    String cookieStr = h->value();
    String prefix = String(name) + "=";
    int idx = cookieStr.indexOf(prefix);
    if (idx < 0) return "";
    idx += prefix.length();
    int end = cookieStr.indexOf(';', idx);
    if (end < 0) end = cookieStr.length();
    String val = cookieStr.substring(idx, end);
    val.trim();
    return val;
}

static String extractAuthToken(AsyncWebServerRequest *request) {
    // 1. Session Cookie
    String token = extractCookieValue(request, "ios_session");
    if (token.length() > 0) return token;

    // 2. Custom header X-Session-Token
    if (request->hasHeader("X-Session-Token")) {
        const AsyncWebHeader *h = request->getHeader("X-Session-Token");
        if (h && h->value().length() > 0) {
            String val = h->value();
            val.trim();
            if (val.length() > 0) return val;
        }
    }

    // 3. Custom header X-Auth-Token
    if (request->hasHeader("X-Auth-Token")) {
        const AsyncWebHeader *h = request->getHeader("X-Auth-Token");
        if (h && h->value().length() > 0) {
            String val = h->value();
            val.trim();
            if (val.length() > 0) return val;
        }
    }

    // 4. Authorization: Bearer <token>
    if (request->hasHeader("Authorization")) {
        const AsyncWebHeader *h = request->getHeader("Authorization");
        if (h) {
            String val = h->value();
            if (val.startsWith("Bearer ")) {
                val = val.substring(7);
            }
            val.trim();
            if (val.length() > 0) return val;
        }
    }

    return "";
}

bool isAuthorized(AsyncWebServerRequest *request) {
    String token = extractAuthToken(request);
    if (token.length() == 0) {
        return false;
    }

    if (isValidAdminSession(token)) {
        return true;
    }

    if (AUTH_TOKEN && strlen(AUTH_TOKEN) > 0 && token.equals(AUTH_TOKEN)) {
        return true;
    }

    return false;
}

void sendUnauthorized(AsyncWebServerRequest *request) {
    request->send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized: Invalid or expired session\"}");
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
                if (!validateScheduleJson(obj)) {
                    request->send(400, "application/json", "{\"ok\":false,\"error\":\"Use type bath/clean/mist, HH:MM, 1-1440 minutes, and valid selected days\"}");
                    return;
                }
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
                if (!saveSchedules()) {
                    scheduleCount--;
                    request->send(507, "application/json", "{\"ok\":false,\"error\":\"Schedule was not saved. Check LittleFS mount and available space\"}");
                    return;
                }
                appendActivity(strcmp(s.type, "bath") == 0 ? "Bath" : strcmp(s.type, "clean") == 0 ? "Clean" : "Mist", "Local schedule added.");

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

        if (!json.is<JsonObject>() || !validateScheduleJson(json.as<JsonObject>(), true)) {
            request->send(400, "application/json", "{\"ok\":false,\"error\":\"Invalid schedule update\"}");
            return;
        }
        Schedule &s = schedules[idx];
        Schedule previous = s;

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

        if (!saveSchedules()) {
            s = previous;
            request->send(507, "application/json", "{\"ok\":false,\"error\":\"Schedule update could not be persisted\"}");
            return;
        }
        appendActivity("Info", "Local schedule updated.");

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
        Schedule removed = schedules[idx];
        for (uint8_t i = (uint8_t)idx; i < scheduleCount - 1; i++) {
            schedules[i] = schedules[i + 1];
        }
        scheduleCount--;
        if (!saveSchedules()) {
            for (int i = scheduleCount; i > idx; i--) schedules[i] = schedules[i - 1];
            schedules[idx] = removed;
            scheduleCount++;
            request->send(507, "application/json", "{\"ok\":false,\"error\":\"Schedule deletion could not be persisted\"}");
            return;
        }
        appendActivity("Info", "Local schedule deleted.");

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
    bathPumpIsOn = true;
}

void bathOff()
{
    digitalWrite(BATH_RELAY_PIN, RELAY_OFF);
    bathPumpIsOn = false;
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
    JsonObject diagnostics = doc["diagnostics"].to<JsonObject>();
    diagnostics["dht_ok"] = !isnan(lastTemp) && !isnan(lastHum);
    diagnostics["rtc_ok"] = rtcOk;
    diagnostics["tank_ok"] = (lastWaterLevel >= 0);
    diagnostics["flow_ok"] = true;   // Existing behavior: no flow self-test.
    diagnostics["relay_ok"] = true;  // Existing behavior: no relay feedback.
    diagnostics["sd_ok"] = sdMounted && sdCardStatus == SD_STATUS_READY;
    doc["waterSensorOk"] = (lastWaterLevel >= 0);
    doc["distanceCm"] = lastDistanceCm >= 0 ? lastDistanceCm : -1.0f;
    doc["echoDurationUs"] = lastEchoDurationUs;

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
    doc["pumpOn"] = pumpIsOn || bathPumpIsOn;
    doc["pumpActive"] = pumpIsOn || bathPumpIsOn;
    doc["pumpState"] = (pumpIsOn || bathPumpIsOn) ? "ON" : "OFF";
    doc["pumpReason"] = currentPumpReason;
    doc["reason"] = currentPumpReason;
    doc["relayState"] = pumpIsOn || bathPumpIsOn;
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
    doc["sdError"] = sdLastError;
    doc["sdSpiFrequencyHz"] = sdSpiFrequencyHz;
    doc["backendOnline"] = backendOnline;
    doc["pendingOfflineCount"] = sdPendingCount;
    doc["syncedCount"] = sdSyncedCount;
    if (lastSyncTs > 0 && rtcOk && rtcTimeValid) {
        doc["lastSyncTs"] = (unsigned long long)lastSyncTs;
    } else {
        doc["lastSyncTs"] = nullptr;
    }
    doc["syncInProgress"] = syncInProgress;
    JsonObject sdObj = doc["sd"].to<JsonObject>();
    populateSdInfo(sdObj);

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
    srv.on("/api/reports/summary", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["source"] = "esp32";
        doc["count"] = historyCount;
        JsonArray ranges = doc["supportedRanges"].to<JsonArray>();
        ranges.add("24h"); ranges.add("all");
        uint64_t first = 0, last = 0;
        for (size_t i = 0; i < historyCount; i++) {
            uint64_t ts = historyRing[i].ts;
            if (ts < 1704067200000ULL) continue;
            if (!first || ts < first) first = ts;
            if (ts > last) last = ts;
        }
        if (first) doc["firstTs"] = first; else doc["firstTs"] = nullptr;
        if (last) doc["lastTs"] = last; else doc["lastTs"] = nullptr;
        String payload;
        serializeJson(doc, payload);
        request->send(200, "application/json", payload);
    });
    auto handleReadings = [](AsyncWebServerRequest *request) {
        String range = request->hasParam("range") ? request->getParam("range")->value() : "24h";
        if (range != "24h" && range != "all") {
            request->send(400, "application/json", "{\"error\":\"Use the Node dashboard for 7-day and 30-day reports\"}");
            return;
        }
        uint64_t since = range == "24h" && rtcOk && rtcTimeValid
            ? (uint64_t)rtc.now().unixtime() * 1000ULL - 24ULL * 3600ULL * 1000ULL : 0;
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        response->addHeader("Access-Control-Allow-Origin", "*");
        response->print('[');
        bool first = true;
        for (size_t i = 0; i < historyCount; i++) {
            size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
            if (historyRing[idx].ts >= 1704067200000ULL && historyRing[idx].ts < since) continue;
            if (!first) response->print(',');
            first = false;
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

    // The Node archive supplies long-term CSVs. Local export has limited history.
    srv.on("/api/reports/export", HTTP_GET, [](AsyncWebServerRequest *request) {
        String range = request->hasParam("range") ? request->getParam("range")->value() : "24h";
        if (range != "24h" && range != "all") {
            request->send(400, "application/json", "{\"error\":\"Use the Node dashboard for 7-day and 30-day exports\"}");
            return;
        }
        uint64_t since = range == "24h" && rtcOk && rtcTimeValid
            ? (uint64_t)rtc.now().unixtime() * 1000ULL - 24ULL * 3600ULL * 1000ULL : 0;
        AsyncResponseStream *response = request->beginResponseStream("text/csv");
        response->addHeader("Content-Disposition", "attachment; filename=\"readings.csv\"");
        response->addHeader("Access-Control-Allow-Origin", "*");
        response->print("time,ts,temp,humidity,thi\n");
        for (size_t i = 0; i < historyCount; i++) {
            size_t idx = (historyCount < HISTORY_CAPACITY) ? i : ((historyHead + i) % HISTORY_CAPACITY);
            if (historyRing[idx].ts >= 1704067200000ULL && historyRing[idx].ts < since) continue;
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
        doc["sd_ok"]    = sdMounted && (sdCardStatus == SD_STATUS_READY);
        doc["sdStatus"] = getSdStatusString();
        doc["echoDurationUs"] = lastEchoDurationUs;
        doc["distanceCm"] = lastDistanceCm;
        doc["sdError"] = sdLastError;
        JsonObject details = doc["details"].to<JsonObject>();
        details["dht"]   = "DHT22 on GPIO 4";
        details["rtc"]   = rtcOk ? "DS3231 on GPIO 8/9" : "DS3231 Not Detected";
        details["tank"]  = "HC-SR04 on GPIO 16/17";
        details["flow"]  = "YF-S201 on GPIO 5";
        details["relay"] = "Relay on GPIO 18";
        details["sd"] = sdMounted ? "MicroSD SPI (CS:10, MOSI:11, SCK:12, MISO:13)" : sdLastError;
        JsonObject sdInfo = details["sd_info"].to<JsonObject>();
        populateSdInfo(sdInfo);
        doc["sd"].set(sdInfo);

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // GET /api/sd/status
    srv.on("/api/sd/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["ok"] = true;
        doc["sdStatus"] = getSdStatusString();
        doc["mounted"] = sdMounted;
        doc["sdError"] = sdLastError;
        doc["sdSpiFrequencyHz"] = sdSpiFrequencyHz;
        doc["backendOnline"] = backendOnline;
        doc["pendingOfflineCount"] = sdPendingCount;
        doc["syncedCount"] = sdSyncedCount;
        doc["lastSyncTs"] = (lastSyncTs > 0 && rtcOk && rtcTimeValid) ? (unsigned long long)lastSyncTs : 0;
        doc["syncInProgress"] = syncInProgress;
        doc["cardType"] = sdMounted ? sdCardTypeStr : "Unavailable";
        doc["cardSizeBytes"] = (sdMounted && sdCardSizeBytes > 0) ? sdCardSizeBytes : 0;
        doc["totalBytes"] = (sdMounted && sdTotalBytes > 0) ? sdTotalBytes : 0;
        doc["usedBytes"] = (sdMounted && sdTotalBytes > 0) ? sdUsedBytes : 0;
        doc["availableBytes"] = (sdMounted && sdTotalBytes > sdUsedBytes) ? (sdTotalBytes - sdUsedBytes) : 0;
        doc["csPin"] = SD_CS_PIN;
        doc["mosiPin"] = SD_MOSI_PIN;
        doc["sckPin"] = SD_SCK_PIN;
        doc["misoPin"] = SD_MISO_PIN;
        doc["logPath"] = SD_LOG_FILE;
        JsonObject sdObj = doc["sd"].to<JsonObject>();
        populateSdInfo(sdObj);
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
        doc["syncedCount"] = sdSyncedCount;
        doc["lastSyncTs"] = (lastSyncTs > 0 && rtcOk && rtcTimeValid) ? (unsigned long long)lastSyncTs : 0;
        doc["syncInProgress"] = syncInProgress;
        JsonObject sdObj = doc["sd"].to<JsonObject>();
        populateSdInfo(sdObj);
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // Return the persistent local log while the backend is unavailable.
    srv.on("/api/activity", HTTP_GET, [](AsyncWebServerRequest *request) {
        size_t limit = 30;
        if (request->hasParam("limit")) limit = constrain(request->getParam("limit")->value().toInt(), 1, ACTIVITY_CAPACITY);
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        String range = request->hasParam("range") ? request->getParam("range")->value() : "all";
        uint64_t since = range == "24h" && rtcOk && rtcTimeValid
            ? (uint64_t)rtc.now().unixtime() * 1000ULL - 24ULL * 3600ULL * 1000ULL : 0;
        for (size_t i = 0; i < activityCount && i < limit; i++) {
            size_t idx = (activityHead + ACTIVITY_CAPACITY - 1 - i) % ACTIVITY_CAPACITY;
            if (activityRing[idx].ts && activityRing[idx].ts < since) continue;
            JsonObject obj = arr.add<JsonObject>();
            obj["ts"] = activityRing[idx].ts;
            obj["type"] = activityRing[idx].type;
            obj["msg"] = activityRing[idx].msg;
        }
        String payload;
        serializeJson(doc, payload);
        request->send(200, "application/json", payload);
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
        JsonDocument doc;
        doc["mode"] = "device";
        doc["authRequired"] = true;
        doc["backendUrl"] = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT;
        String payload;
        serializeJson(doc, payload);
        request->send(200, "application/json", payload);
    });

    // POST /api/login {"username": "admin", "password": "..."}
    AsyncCallbackJsonWebHandler *loginHandler = new AsyncCallbackJsonWebHandler("/api/login",
        [](AsyncWebServerRequest *request, JsonVariant &json) {
            if (!json.is<JsonObject>()) {
                request->send(400, "application/json", "{\"ok\":false,\"error\":\"Expected JSON object\"}");
                return;
            }
            JsonObject obj = json.as<JsonObject>();
            const char* u = "";
            const char* p = "";
            if (obj["username"].is<const char*>()) u = obj["username"].as<const char*>();
            else if (obj["user"].is<const char*>()) u = obj["user"].as<const char*>();

            if (obj["password"].is<const char*>()) p = obj["password"].as<const char*>();
            else if (obj["pass"].is<const char*>()) p = obj["pass"].as<const char*>();

            if (strcmp(u, ADMIN_USER) == 0 && strcmp(p, ADMIN_PASSWORD) == 0) {
                String token = createAdminSession();
                AsyncWebServerResponse *response = request->beginResponse(200, "application/json",
                    "{\"ok\":true,\"token\":\"" + token + "\",\"expiresIn\":" + String(ADMIN_SESSION_TTL_SEC) + "}");
                response->addHeader("Set-Cookie", "ios_session=" + token + "; Path=/; SameSite=Lax; Max-Age=" + String(ADMIN_SESSION_TTL_SEC));
                request->send(response);
                return;
            }

            request->send(401, "application/json", "{\"ok\":false,\"error\":\"Invalid credentials. Try admin / ios2024\"}");
        });
    loginHandler->setMethod(HTTP_POST);
    server.addHandler(loginHandler);

    // POST /api/logout
    server.on("/api/logout", HTTP_POST, [](AsyncWebServerRequest *request) {
        String token = extractAuthToken(request);
        if (token.length() > 0) {
            destroyAdminSession(token);
        }
        AsyncWebServerResponse *response = request->beginResponse(200, "application/json", "{\"ok\":true}");
        response->addHeader("Set-Cookie", "ios_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
        request->send(response);
    });

    // GET /api/session
    server.on("/api/session", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (isAuthorized(request)) {
            request->send(200, "application/json", "{\"ok\":true,\"authenticated\":true}");
        } else {
            request->send(401, "application/json", "{\"ok\":false,\"authenticated\":false,\"error\":\"Unauthorized: Invalid or expired session\"}");
        }
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
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token, Authorization, X-Session-Token");
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
    lastEchoDurationUs = 0;
    lastDistanceCm = -1.0f;
    for (uint8_t attempt = 0; attempt < 2; attempt++) {
        // Give the module time to finish the preceding measurement.
        if (attempt > 0) delay(65);
        digitalWrite(TRIG_PIN, LOW);
        delayMicroseconds(4);
        digitalWrite(TRIG_PIN, HIGH);
        delayMicroseconds(10);
        digitalWrite(TRIG_PIN, LOW);
        lastEchoDurationUs = pulseIn(ECHO_PIN, HIGH, 30000UL);
        if (lastEchoDurationUs == 0) continue;

        const float distance = (float)lastEchoDurationUs * 0.0343f / 2.0f;
        // Reject the sensor's blind zone and readings outside its rated range.
        // Invalid readings stay invalid so the pump water-protection remains.
        if (distance >= 2.0f && distance <= 400.0f) {
            lastDistanceCm = distance;
            return distance;
        }
    }
    return -1.0f;
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
        Serial.printf("Water Level: SENSOR ERROR (TRIG=%d, ECHO=%d, echo=%lu us)\n",
                      TRIG_PIN, ECHO_PIN, lastEchoDurationUs);
    }
    if (lastDistanceCm >= 0) {
        Serial.printf("HC-SR04 Distance: %.2f cm | Echo: %lu us\n",
                      lastDistanceCm, lastEchoDurationUs);
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
    if (!sdMounted) Serial.printf("MicroSD detail: %s\n", sdLastError);
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
        uint32_t rtcEpoch = rtc.now().unixtime();
        rtcTimeValid = !rtc.lostPower() && rtcEpoch >= 1704067200UL && rtcEpoch <= 4102444799UL;
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
    digitalWrite(TRIG_PIN, LOW);

    // --------------------------------------------------------
    // MISTING RELAY
    // --------------------------------------------------------

    digitalWrite(RELAY_PIN, RELAY_OFF);
    pinMode(RELAY_PIN, OUTPUT);

    // --------------------------------------------------------
    // BATHING RELAY
    // --------------------------------------------------------

    // The bathing schedule engine controls this output after initialization.
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
        loadActivity();
        loadBackendSchedules();
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
        fetchBackendSchedules();
        lastSchedulePull = millis();
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

    // Retry a failed SD mount or write after wiring/card issues are corrected.
    serviceMicroSD();

    if (backendOnline && millis() - lastSchedulePull >= SCHEDULE_PULL_INTERVAL_MS) {
        lastSchedulePull = millis();
        fetchBackendSchedules();
    }

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
    // PERIODIC HARDWARE DIAGNOSTICS & SD REPORT PUSH TO NODE
    // --------------------------------------------------------

    if (backendOnline && (lastDiagnosticsPush == 0 || millis() - lastDiagnosticsPush >= DIAGNOSTICS_PUSH_INTERVAL_MS))
    {
        lastDiagnosticsPush = millis();
        sendDiagnosticsToBackend();
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

    // Update pump state before recording telemetry, so reports describe this sample.
    updatePump();

    // Keep local chart history at five-minute resolution, saved immediately.
    if (!isnan(lastTemp) && !isnan(lastHum) && !isnan(lastThi))
    {
        if (!historySampledThisBoot || millis() - lastHistorySample >= HISTORY_SAMPLE_INTERVAL_MS)
        {
            historySampledThisBoot = true;
            lastHistorySample = millis();
            addHistorySample(lastTemp, lastHum, lastThi);
            historyDirty = !saveHistory();
            char message[150];
            snprintf(message, sizeof(message), "Temp %.1f C, humidity %.1f%%, THI %.1f; pump %s (%s)", lastTemp, lastHum, lastThi, pumpIsOn || bathPumpIsOn ? "ON" : "OFF", currentPumpReason);
            appendActivity("Sensor", message);
        }
        if (!telemetrySampled || millis() - lastTelemetrySample >= TELEMETRY_INTERVAL_MS) {
            telemetrySampled = true;
            lastTelemetrySample = millis();
            handleTelemetrySample(lastTemp, lastHum, lastThi, lastWaterLevel, flowRateLPM, totalWaterUsedL, pumpIsOn || bathPumpIsOn, currentPumpReason);
        }
    }

    // Retry a failed local-history save without losing its dirty flag
    if (millis() - lastHistorySave >= HISTORY_SAVE_INTERVAL_MS)
    {
        lastHistorySave = millis();
        if (historyDirty)
        {
            historyDirty = !saveHistory();
        }
    }

    // --------------------------------------------------------
    // PUMP CONTROL (Single engine function)
    // pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
    // --------------------------------------------------------

    // --------------------------------------------------------
    // PERIODIC SERIAL OUTPUT
    // --------------------------------------------------------

    printStatusToSerial();
}
