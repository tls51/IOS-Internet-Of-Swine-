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
const char* WIFI_SSID = "TECNO POVA 2";
const char* WIFI_PASSWORD = "redrum123";

// Backend computer IP
const char* SERVER_HOST = "10.19.188.162";
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
// RELAY
// ============================================================

#define RELAY_PIN 18

// Active LOW relay
#define RELAY_ON LOW
#define RELAY_OFF HIGH

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
// PUMP FUNCTIONS
// ============================================================

void pumpOn()
{
    digitalWrite(RELAY_PIN, RELAY_ON);
}

void pumpOff()
{
    digitalWrite(RELAY_PIN, RELAY_OFF);
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

    // --------------------------------------------------------
    // DHT22
    // --------------------------------------------------------

    dht.begin();

    // --------------------------------------------------------
    // RTC
    // --------------------------------------------------------

    Wire.begin(8, 9);

    rtc.begin();

    // --------------------------------------------------------
    // HC-SR04
    // --------------------------------------------------------

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);

    // --------------------------------------------------------
    // RELAY
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

    // DHT error = pump OFF
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
    // PUMP LOGIC
    // ========================================================
    //
    // Pump ON only when:
    //
    // THI >= 85
    // AND
    // water level >= MIN_WATER_LEVEL
    //
    // Otherwise pump OFF.
    //

    if (thi >= THI_DANGER)
    {
        if (waterLevel >= MIN_WATER_LEVEL)
        {
            pumpOn();
        }
        else
        {
            pumpOff();
        }
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

    Serial.print(now.hour());
    Serial.print(":");
    Serial.print(now.minute());
    Serial.print(":");
    Serial.println(now.second());

    // --------------------------------------------------------
    // PUMP OUTPUT
    // --------------------------------------------------------

    if (thi >= THI_DANGER &&
        waterLevel >= MIN_WATER_LEVEL)
    {
        Serial.println("PUMP: ON");
    }
    else
    {
        Serial.println("PUMP: OFF");
    }

    Serial.println("------------------------------");
}