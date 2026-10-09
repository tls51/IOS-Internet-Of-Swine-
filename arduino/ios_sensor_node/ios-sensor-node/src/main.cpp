#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <AsyncJson.h>
#include <ArduinoJson.h>
#include <RTClib.h>
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

// Water level gate threshold (replaces MIN_WATER_LEVEL = 0)
const float MIN_WATER_LEVEL_PCT = 10.0;

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
// PUMP CONTROL & THI CONSTANTS
// ============================================================

// Single THI threshold constant: kept 85.0 from original firmware THI_DANGER setpoint
// (vs old 85.0 firmware trigger / 78.0 stress tier / 83.0 extreme heat tier)
const float THI_THRESHOLD = 85.0;

// Misting operation cycle durations
const unsigned long MIST_DURATION_MIN = 5;      // 5 minutes active mist run
const unsigned long MIST_PAUSE_SEC = 30;        // 30 seconds pause interval

// Manual override runtime limits
const unsigned long MANUAL_DEFAULT_RUN_MS = 60000;  // 1 minute default runtime
const unsigned long MANUAL_MAX_RUN_MS = 180000;     // 3 minutes maximum runtime safety cutoff

// Manual override state
bool manualActive = false;
unsigned long manualStartTime = 0;
unsigned long manualExpiryTime = 0;

// Current pump reason string for /api/status and logging
const char* currentPumpReason = "idle";

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
    if (!s.active)   return false;
    if (!rtcOk)      return false;
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
        if (isScheduleActiveNow(schedules[i])) return true;
    }
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
    File f = LittleFS.open(SCHEDULES_FILE, "w");
    if (!f) {
        Serial.println("ERROR: Could not open schedules.json for writing.");
        return;
    }

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (uint8_t i = 0; i < scheduleCount; i++) {
        scheduleToJson(arr.add<JsonObject>(), schedules[i]);
    }

    serializeJson(doc, f);
    f.close();
    Serial.println("schedules.json saved.");
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

// ============================================================
// PUMP LOGIC ENGINE (called every loop)
// pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
// ============================================================

void updatePump()
{
    // 1. Check manual override expiry (turns off automatically)
    if (manualActive)
    {
        if (millis() >= manualExpiryTime)
        {
            manualActive = false;
            manualExpiryTime = 0;
        }
    }
    bool manual = manualActive;

    // 2. Scheduled: evaluate all stored schedules against current RTC local time
    bool scheduled = anyScheduleActive();

    // 3. THI trigger with mist on/off cycle
    bool thiCondition = (!isnan(lastThi) && lastThi >= THI_THRESHOLD);

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
                if (elapsed >= (MIST_DURATION_MIN * 60000UL))
                {
                    mistInOnPhase = false;
                    mistPhaseStartTime = millis();
                }
            }
            else
            {
                if (elapsed >= (MIST_PAUSE_SEC * 1000UL))
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

    // 4. Water level gate: waterOk = water level >= 10%
    bool waterOk = (lastWaterLevel >= MIN_WATER_LEVEL_PCT);

    // 5. Single decision formula:
    // pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
    bool shouldPump = waterOk && (thiTrigger || scheduled || manual);

    // 6. Track state reason
    if (shouldPump)
    {
        if (manual)
        {
            currentPumpReason = "manual";
        }
        else if (scheduled)
        {
            currentPumpReason = "scheduled";
        }
        else if (thiTrigger)
        {
            currentPumpReason = "thi_cooling";
        }
        else
        {
            currentPumpReason = "active";
        }
    }
    else
    {
        if (!waterOk && (manual || scheduled || thiTrigger || thiCondition))
        {
            currentPumpReason = "low_water";
        }
        else if (!waterOk)
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
    }

    // 7. Apply relay state
    if (shouldPump)
    {
        pumpOn();
    }
    else
    {
        pumpOff();
    }
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
        if (lastThi < 74.0) {
            thiStatus["label"] = "Normal";
            thiStatus["cls"] = "badge-blue";
            thiStatus["color"] = "#3B82F6";
        } else if (lastThi <= 78.0) {
            thiStatus["label"] = "Stressful";
            thiStatus["cls"] = "badge-warn";
            thiStatus["color"] = "#F59E0B";
        } else if (lastThi <= 83.0) {
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
    thiThresholds["normalMax"] = 74;
    thiThresholds["stressMax"] = 78;
    thiThresholds["extremeMax"] = 83;

    JsonObject opDurations = doc["operationDurations"].to<JsonObject>();
    opDurations["mistDurationMin"] = MIST_DURATION_MIN;
    opDurations["mistPauseSec"] = MIST_PAUSE_SEC;

    doc["malfunctions"].to<JsonArray>();
    doc["diagnostics"] = nullptr;

    // RTC status and current UTC epoch
    doc["rtcOk"] = rtcOk;
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
    doc["mistActive"] = (strcmp(currentPumpReason, "thi_cooling") == 0);
    doc["bathActive"] = (strcmp(currentPumpReason, "scheduled") == 0);
    doc["cleanActive"] = false;
    doc["manualPumpActive"] = manualActive;
    doc["lastPumpTest"] = nullptr;
    doc["threshold"] = THI_THRESHOLD;

    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

void setupWebServer()
{
    // Schedule CRUD: GET/POST /api/schedules, PATCH/PUT/DELETE /api/schedules/{id}
    setupScheduleRoutes(server);

    // Mode discovery for dashboard
    server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"mode\":\"device\"}");
    });

    server.on("/api/status", HTTP_GET, handleStatus);

    // POST /api/time {"epoch": <UTC seconds>}
    AsyncCallbackJsonWebHandler *timeHandler = new AsyncCallbackJsonWebHandler("/api/time", [](AsyncWebServerRequest *request, JsonVariant &json) {
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

    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
    server.begin();
    Serial.println("HTTP server started.");
}

// ============================================================
// READ HC-SR04
// ============================================================

float readDistance()
{
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);

    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);

    digitalWrite(TRIG_PIN, LOW);

    unsigned long duration =
        pulseIn(ECHO_PIN, HIGH, 30000);

    if (duration == 0)
    {
        return -1.0;
    }

    float distance =
        duration * 0.0343 / 2.0;

    return distance;
}

// ============================================================
// CONVERT DISTANCE TO WATER LEVEL
// ============================================================

float calculateWaterLevel(float distance)
{
    if (distance < 0)
    {
        return -1.0;
    }

    // Empty
    if (distance >= TANK_EMPTY_CM)
    {
        return 0.0;
    }

    // Full
    if (distance <= TANK_FULL_CM)
    {
        return 100.0;
    }

    float level =
        ((TANK_EMPTY_CM - distance) /
         (TANK_EMPTY_CM - TANK_FULL_CM)) * 100.0;

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
        Serial.print(lastWaterLevel >= MIN_WATER_LEVEL_PCT ? "OK" : "LOW");
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
    }

    // --------------------------------------------------------
    // HC-SR04
    // --------------------------------------------------------

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);

    // --------------------------------------------------------
    // MISTING RELAY
    // --------------------------------------------------------

    pinMode(RELAY_PIN, OUTPUT);

    // Pump OFF at startup
    pumpOff();

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
    }

    // --------------------------------------------------------
    // WIFI
    // --------------------------------------------------------

    setupWiFi();

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
    // PUMP CONTROL (Single engine function)
    // pumpOn = waterOk AND (thiTrigger OR scheduled OR manual)
    // --------------------------------------------------------

    updatePump();

    // --------------------------------------------------------
    // PERIODIC SERIAL OUTPUT
    // --------------------------------------------------------

    printStatusToSerial();
}