#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <RTClib.h>
#include "DHT.h"

// ============================================================
// WIFI
// ============================================================

// STA Wi-Fi

const char* WIFI_SSID =
    "Converge_2.4GHz_51BD";

const char* WIFI_PASSWORD =
    "Khe5ME92";


// Backend computer IP
const char* SERVER_HOST = "192.168.1.33";
const int SERVER_PORT = 3000;

// AP Wi-Fi
const char* AP_SSID = "ESP32-Misting-System";
const char* AP_PASSWORD = "12345678";

// ============================================================
// DEVICE
// ============================================================

const char* DEVICE_ID = "esp32-s3-01";

// ============================================================
// DHT22
// ============================================================

#define DHT_PIN 4
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

// ============================================================
// RTC DS3231
// ============================================================

RTC_DS3231 rtc;

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

// Minimum water level before pump can run
const float MIN_WATER_LEVEL = 0;

// ============================================================
// MISTING RELAY
// ============================================================

#define RELAY_PIN 18

// Active LOW relay
#define RELAY_ON LOW
#define RELAY_OFF HIGH

// ============================================================
// BATHING RELAY (separate relay/channel from misting)
// ============================================================
// Relay IN2 -> GPIO7
#define BATH_RELAY_PIN 7
// Reuses the same RELAY_ON / RELAY_OFF levels defined above

// ============================================================
// SERVER-DRIVEN BATH / CLEAN SCHEDULE STATE
// ============================================================
// The backend decides whether a bath or clean schedule is
// active right now (based on day + time + duration stored in
// SQLite).  The ESP32 polls /api/status periodically and reads
// the bathActive / cleanActive flags.

bool serverBathActive  = false;
bool serverCleanActive = false;

// How often to poll the backend for schedule status (ms)
const unsigned long SCHEDULE_POLL_INTERVAL = 5000;
unsigned long lastSchedulePoll = 0;

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
// THI
// ============================================================

const float THI_DANGER = 85.0;

// ============================================================
// TIMING
// ============================================================

unsigned long lastSensorRead = 0;

const unsigned long SENSOR_INTERVAL = 3000;

// ============================================================
// YF-S201 INTERRUPT
// ============================================================

void IRAM_ATTR flowPulseISR()
{
    flowPulseCount++;
}

// ============================================================
// MISTING PUMP FUNCTIONS
// ============================================================

void pumpOn()
{
    digitalWrite(RELAY_PIN, RELAY_ON);
}

void pumpOff()
{
    digitalWrite(RELAY_PIN, RELAY_OFF);
}

// (Bath relay functions removed — bath/clean schedules now
// drive the misting pump relay via server-polled state.)

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
    if (WiFi.status() == WL_CONNECTED)
    {
        return;
    }

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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
// POLL BACKEND FOR BATH / CLEAN SCHEDULE STATUS
// ============================================================
// Every SCHEDULE_POLL_INTERVAL ms, the ESP32 asks the backend
// whether a bathing or cleaning schedule window is currently
// active.  The backend already evaluates day + time + duration,
// so the ESP32 just reads the boolean flags.

void pollScheduleStatus()
{
    if (millis() - lastSchedulePoll < SCHEDULE_POLL_INTERVAL)
    {
        return;
    }

    lastSchedulePoll = millis();

    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;

    String url =
        String("http://") +
        SERVER_HOST +
        ":" +
        String(SERVER_PORT) +
        "/api/status";

    http.begin(url);
    http.setTimeout(3000);

    int code = http.GET();

    if (code == 200)
    {
        String payload = http.getString();

        // ------------------------------------------------
        // Lightweight JSON parsing for bathActive flag
        // ------------------------------------------------
        int bathIdx = payload.indexOf("\"bathActive\"");
        if (bathIdx >= 0)
        {
            int commaIdx = payload.indexOf(",", bathIdx);
            if (commaIdx == -1) commaIdx = payload.indexOf("}", bathIdx);

            String valStr = payload.substring(bathIdx, commaIdx);
            bool isActive = valStr.indexOf("true") >= 0;

            bool prev = serverBathActive;
            serverBathActive = isActive;

            if (serverBathActive && !prev)
            {
                Serial.println();
                Serial.println("====================================");
                Serial.println(" BATH SCHEDULE ACTIVE (server)");
                Serial.println(" Misting pump -> ON");
                Serial.println("====================================");
            }
            else if (!serverBathActive && prev)
            {
                Serial.println();
                Serial.println("====================================");
                Serial.println(" BATH SCHEDULE ENDED (server)");
                Serial.println("====================================");
            }
        }

        // ------------------------------------------------
        // Lightweight JSON parsing for cleanActive flag
        // ------------------------------------------------
        int cleanIdx = payload.indexOf("\"cleanActive\"");
        if (cleanIdx >= 0)
        {
            int commaIdx = payload.indexOf(",", cleanIdx);
            if (commaIdx == -1) commaIdx = payload.indexOf("}", cleanIdx);

            String valStr = payload.substring(cleanIdx, commaIdx);
            bool isActive = valStr.indexOf("true") >= 0;

            bool prev = serverCleanActive;
            serverCleanActive = isActive;

            if (serverCleanActive && !prev)
            {
                Serial.println();
                Serial.println("====================================");
                Serial.println(" CLEAN SCHEDULE ACTIVE (server)");
                Serial.println(" Misting pump -> ON");
                Serial.println("====================================");
            }
            else if (!serverCleanActive && prev)
            {
                Serial.println();
                Serial.println("====================================");
                Serial.println(" CLEAN SCHEDULE ENDED (server)");
                Serial.println("====================================");
            }
        }
    }

    http.end();
}

// ============================================================
// SEND DHT DATA TO BACKEND
// ============================================================

void sendDHTToBackend(float temperature, float humidity)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;

    String url =
        String("http://") +
        SERVER_HOST +
        ":" +
        String(SERVER_PORT) +
        "/api/readings";

    http.begin(url);

    http.addHeader(
        "Content-Type",
        "application/json"
    );

    String json = "{";
    json += "\"temp\":" + String(temperature, 1) + ",";
    json += "\"humidity\":" + String(humidity, 1) + ",";
    json += "\"device_id\":\"" + String(DEVICE_ID) + "\"";
    json += "}";

    http.POST(json);

    http.end();
}

// ============================================================
// SEND WATER DATA TO BACKEND
// ============================================================

void sendWaterToBackend(float waterLevel)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;

    String url =
        String("http://") +
        SERVER_HOST +
        ":" +
        String(SERVER_PORT) +
        "/api/water";

    http.begin(url);

    http.addHeader(
        "Content-Type",
        "application/json"
    );

    String json = "{";
    json += "\"level_pct\":" + String(waterLevel, 1) + ",";
    json += "\"used_l\":" + String(totalWaterUsedL, 3) + ",";
    json += "\"flow_lpm\":" + String(flowRateLPM, 2) + ",";
    json += "\"device_id\":\"" + String(DEVICE_ID) + "\"";
    json += "}";

    http.POST(json);

    http.end();
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
    // RTC
    // --------------------------------------------------------

    Wire.begin(SDA_PIN, SCL_PIN);

    if (!rtc.begin())
    {
        Serial.println("RTC NOT FOUND!");
        // Halt here since bathing schedule and timestamps
        // depend entirely on the RTC.
        while (1)
        {
            delay(1000);
        }
    }

    Serial.println("RTC detected.");

    // =====================================================
    // FIRST UPLOAD ONLY
    // =====================================================
    // Uncomment this line ONLY when you need to set the
    // RTC using the computer's compile time.
    //
    // Upload once with it uncommented.
    // Then COMMENT it again and upload a second time,
    // otherwise the RTC will reset to compile time on
    // every reboot/power loss.
    //
    // rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    // =====================================================

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
    // WIFI
    // --------------------------------------------------------

    setupWiFi();

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
    // CALCULATE WATER FLOW
    // --------------------------------------------------------

    calculateWaterFlow();

    // --------------------------------------------------------
    // POLL BATH / CLEAN SCHEDULE FROM BACKEND
    // (self-throttled to every SCHEDULE_POLL_INTERVAL ms)
    // --------------------------------------------------------

    pollScheduleStatus();

    // --------------------------------------------------------
    // WAIT FOR NEXT SENSOR READING
    // --------------------------------------------------------

    if (millis() - lastSensorRead < SENSOR_INTERVAL)
    {
        return;
    }

    lastSensorRead = millis();

    // ========================================================
    // READ DHT22
    // ========================================================

    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();

    // DHT error = misting pump OFF
    if (isnan(temperature) || isnan(humidity))
    {
        pumpOff();
        return;
    }

    // ========================================================
    // CALCULATE THI
    // ========================================================

    float thi =
        (0.8 * temperature) +
        ((humidity / 100.0) *
         (temperature - 14.4)) +
        46.4;

    // ========================================================
    // READ WATER LEVEL
    // ========================================================

    float distance = readDistance();

    float waterLevel =
        calculateWaterLevel(distance);

    // ========================================================
    // RTC
    // ========================================================

    DateTime now = rtc.now();

    // ========================================================
    // MISTING PUMP LOGIC
    // ========================================================
    //
    // Pump ON when ANY of these conditions are true:
    //
    //   1. THI >= 85   (heat stress cooling)
    //   2. Bath schedule active   (from server)
    //   3. Clean schedule active  (from server)
    //
    // AND water level >= MIN_WATER_LEVEL
    //
    // Otherwise pump OFF.
    //

    bool shouldMist =
        (thi >= THI_DANGER) ||
        serverBathActive ||
        serverCleanActive;

    if (shouldMist && waterLevel >= MIN_WATER_LEVEL)
    {
        pumpOn();
    }
    else
    {
        pumpOff();
    }

    // ========================================================
    // SEND DATA TO BACKEND
    // ========================================================

    sendDHTToBackend(
        temperature,
        humidity
    );

    // Only send valid water level
    if (waterLevel >= 0)
    {
        sendWaterToBackend(waterLevel);
    }

    // ========================================================
    // SIMPLE SERIAL OUTPUT
    // ========================================================

    Serial.print("Temperature: ");
    Serial.print(temperature, 1);
    Serial.println(" C");

    Serial.print("Humidity: ");
    Serial.print(humidity, 1);
    Serial.println(" %");

    Serial.print("THI: ");
    Serial.println(thi, 1);

    if (waterLevel >= 0)
    {
        Serial.print("Water Level: ");
        Serial.print(waterLevel, 1);
        Serial.println(" %");
    }
    else
    {
        Serial.println("Water Level: SENSOR ERROR");
    }

    // --------------------------------------------------------
    // YF-S201 OUTPUT
    // --------------------------------------------------------

    Serial.print("Flow Rate: ");
    Serial.print(flowRateLPM, 2);
    Serial.println(" L/min");

    Serial.print("Total Water Used: ");
    Serial.print(totalWaterUsedL, 3);
    Serial.println(" L");

    // --------------------------------------------------------
    // RTC OUTPUT
    // --------------------------------------------------------

    Serial.print("RTC: ");
    Serial.print(now.year());
    Serial.print("-");
    Serial.print(now.month());
    Serial.print("-");
    Serial.print(now.day());
    Serial.print(" ");

    if (now.hour() < 10) Serial.print("0");
    Serial.print(now.hour());
    Serial.print(":");

    if (now.minute() < 10) Serial.print("0");
    Serial.print(now.minute());
    Serial.print(":");

    if (now.second() < 10) Serial.print("0");
    Serial.println(now.second());

    // --------------------------------------------------------
    // MISTING PUMP OUTPUT
    // --------------------------------------------------------

    Serial.print("MISTING PUMP: ");
    Serial.println(
        (shouldMist && waterLevel >= MIN_WATER_LEVEL)
            ? "ON" : "OFF");

    // --------------------------------------------------------
    // SCHEDULE STATUS OUTPUT
    // --------------------------------------------------------

    Serial.print("BATH SCHED:  ");
    Serial.println(serverBathActive ? "ACTIVE" : "—");

    Serial.print("CLEAN SCHED: ");
    Serial.println(serverCleanActive ? "ACTIVE" : "—");

    Serial.println("------------------------------");
}