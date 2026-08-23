/* ============================================================
   ios_sensor_node.ino
   Internet of Swine (IoS) — ESP32 sensor node

   Merges:
     - main.cpp            (WiFi STA + push-to-backend architecture)
     - dht_copy_20260708141330_v3.ino
         (DHT22 + RTC + THI/status, scheduled bathing,
          YF-S201B water flow sensor)
     - RelayModule.ino
         (single-channel relay driver — now wired to the
          THI status instead of just blinking on a timer)

   The v3 logic is kept as close to original as possible — same
   variable names, same THI formula, same bathing-schedule check,
   same flow-sensor interrupt handling. It's just been split into
   functions and wired to push data to the backend instead of only
   printing to Serial.

   The relay from RelayModule.ino used to just toggle HIGH/LOW on
   a 3s timer as a demo. It's now driven by the misting decision:
   ON while THI says the pigs need misting, OFF when THI is back
   to NORMAL.

   Wiring:
     DHT22 data     -> GPIO4
     RTC DS3231     -> SDA GPIO8, SCL GPIO9 (I2C)
     Flow sensor    -> GPIO15 (YF-S201B, interrupt on FALLING)
     Relay (mister) -> GPIO7
     HC-SR04 TRIG   -> GPIO5   (optional, tank level — off by default)
     HC-SR04 ECHO   -> GPIO6   (optional, tank level — off by default)
   ============================================================ */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <RTClib.h>
#include "DHT.h"

/* ===========================
   WIFI + BACKEND SETTINGS  — EDIT THESE
   =========================== */
const char* WIFI_SSID     = "Converge_2.4GHz_51BD";
const char* WIFI_PASSWORD = "Khe5ME92";

// IP/hostname of the machine running `npm start` inside ios-backend/
// Find it with `ipconfig` (Windows) or `ifconfig`/`ip a` (Mac/Linux).
const char* SERVER_HOST = "192.168.1.61";
const int   SERVER_PORT = 3000;

/* ===========================
   DHT22 SETTINGS
   =========================== */
#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

/* ===========================
   RTC SETTINGS
   =========================== */
RTC_DS3231 rtc;

/* ===========================
   WATER FLOW SENSOR (from dht_copy v3)
   =========================== */
#define FLOW_SENSOR_PIN 15

volatile int pulseCount = 0;

unsigned long previousMillis = 0;

float flowRate    = 0.0;
float totalLiters = 0.0;

/* ===========================
   BATHING SCHEDULE (from dht_copy v3)
   =========================== */
int bathHour   = 13;   // 1:00 PM
int bathMinute = 32;   // 1:32 PM

bool bathingDone = false;

/* ===========================
   RELAY & BUZZER SETTINGS
   ===========================
   Note: Most single-channel relay modules use ACTIVE-LOW logic
   (trigger on LOW signal). Set RELAY_ACTIVE_LOW to true for Active-LOW,
   or false for Active-HIGH relays.
   =========================== */
#define RELAY_PIN 7           // Relay control pin (use GPIO 18/19/27 if standard ESP32)
#define RELAY_ACTIVE_LOW true // Set true if LOW turns relay ON (standard for relay modules)

/* Set TEST_MODE to true to force relay/buzzer to pulse on every 10s sensor check.
   Set to false for normal operation (relays trigger on heat stress or bath schedule). */
#define TEST_MODE true 

/* Optional Piezo Buzzer settings */
#define HAS_BUZZER false      // Set to true if a dedicated Piezo Buzzer is wired up
#define BUZZER_PIN 18         // GPIO pin for Piezo Buzzer

/* ===========================
   OPTIONAL: HC-SR04 water tank sensor
   Set to false if you haven't wired one up yet — the
   dashboard's water page will just show no data.
   (Separate from the flow sensor above; both can run at once.)
   =========================== */
#define HAS_WATER_SENSOR false
#define TRIG_PIN 5
#define ECHO_PIN 6
const float TANK_EMPTY_CM = 38.0;   // sensor reading when tank is empty
const float TANK_FULL_CM  = 4.0;    // sensor reading when tank is full

/* ===========================
   Timing
   =========================== */
const unsigned long READING_INTERVAL_MS    = 10000;  // push DHT reading every 10s
const unsigned long FLOW_CHECK_INTERVAL_MS = 1000;    // flow calc, same cadence as v3
unsigned long lastReadingAt   = 0;
unsigned long lastFlowCheckAt = 0;

/* ===========================
   Forward declarations
   =========================== */
void connectWiFi();
void readAndPushDHT();
void checkBathingSchedule(const DateTime& now);
void readAndPushFlow();
void setMistingRelay(bool on);
void beepBuzzer(int count = 1, int delayMs = 150);
#if HAS_WATER_SENSOR
void readAndPushWater();
#endif
void postJSON(const char* path, const String& body);

/* ===========================
   INTERRUPT (from dht_copy v3, unchanged)
   =========================== */
void IRAM_ATTR pulseCounter() {
  pulseCount++;
  Serial.println(pulseCount);
}

void setup() {
  Serial.begin(115200);
  dht.begin();

  Wire.begin(8, 9);   // SDA = GPIO8, SCL = GPIO9
  if (!rtc.begin()) {
    Serial.println("RTC NOT FOUND!");
    while (1);
  }

  // FIRST UPLOAD ONLY: uncomment once to set the RTC clock from
  // your computer's time, upload, then comment out and upload again.
  // rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));

  // Water flow sensor (from dht_copy v3)
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(
    digitalPinToInterrupt(FLOW_SENSOR_PIN),
    pulseCounter,
    FALLING
  );

  // Relay & Buzzer initialization
  pinMode(RELAY_PIN, OUTPUT);
  setMistingRelay(false); // start OFF

#if HAS_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif

  // Startup audio/relay test pulse (3 quick clicks/beeps on boot)
  Serial.println("Performing boot-up Relay & Buzzer test pulse...");
  beepBuzzer(3, 200);

#if HAS_WATER_SENSOR
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
#endif

  connectWiFi();

  Serial.println("==========================================");
  Serial.println(" Internet of Swine (IoS) — Sensor Node");
  Serial.println(" Environmental Monitoring + Backend Push");
  Serial.println("==========================================");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  DateTime now = rtc.now();
  checkBathingSchedule(now);

  if (millis() - lastReadingAt >= READING_INTERVAL_MS) {
    lastReadingAt = millis();
    readAndPushDHT();
#if HAS_WATER_SENSOR
    readAndPushWater();
#endif
  }

  // Flow rate needs to be sampled roughly every second (same as v3)
  // to keep the pulse-count math accurate, independent of the
  // 10s DHT push interval above.
  if (millis() - lastFlowCheckAt >= FLOW_CHECK_INTERVAL_MS) {
    lastFlowCheckAt = millis();
    readAndPushFlow();
  }
}

/* ── WiFi ─────────────────────────────────────────────────── */
void connectWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("IosSensor", "swine2026"); // WiFi Credentials SSID-Password
  Serial.println(WiFi.softAPIP());
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("WiFi connect failed — will retry next loop.");
  }
}

/* ── Relay & Audio Feedback ───────────────────────────────── */
void setMistingRelay(bool on) {
  // Handles Active-LOW vs Active-HIGH relay module logic
  bool pinState = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(RELAY_PIN, pinState ? HIGH : LOW);
  Serial.printf("Relay (GPIO %d) -> %s (Misting/Bathing %s)\n",
                RELAY_PIN, pinState ? "HIGH" : "LOW", on ? "ON" : "OFF");
}

void beepBuzzer(int count, int delayMs) {
  for (int i = 0; i < count; i++) {
    setMistingRelay(true);
#if HAS_BUZZER
    digitalWrite(BUZZER_PIN, HIGH);
#endif
    delay(delayMs);

    setMistingRelay(false);
#if HAS_BUZZER
    digitalWrite(BUZZER_PIN, LOW);
#endif
    if (i < count - 1) {
      delay(delayMs);
    }
  }
}

/* ── DHT22 + THI ──────────────────────────────────────────── */
void readAndPushDHT() {
  float humidity    = dht.readHumidity();
  float temperature = dht.readTemperature();

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("Failed to read DHT22!");
    return;
  }

  DateTime now = rtc.now();
  Serial.printf("[%02d:%02d:%02d] Temp=%.1fC Hum=%.1f%%\n",
                now.hour(), now.minute(), now.second(), temperature, humidity);

  // Swine THI formula: THI = 0.8*T + (RH/100)*(T - 14.4) + 46.4
  float THI = 0.8 * temperature + (humidity / 100.0) * (temperature - 14.4) + 46.4;

  String status;
  if (THI < 74)      status = "NORMAL";
  else if (THI < 79) status = "STRESSFUL";
  else if (THI < 84) status = "EXTREME HEAT STRESS";
  else                status = "DANGER ZONE";

  Serial.print("THI         : ");
  Serial.println(THI);
  Serial.print("Status      : ");
  Serial.println(status);

  if (TEST_MODE) {
    Serial.println(">>> TEST_MODE ACTIVE: Pulsing relay/buzzer for demonstration <<<");
    beepBuzzer(2, 100);
    setMistingRelay(true);
  } else if (status != "NORMAL") {
    Serial.println(">>> MISTING SYSTEM SHOULD TURN ON <<<");
    setMistingRelay(true);
    beepBuzzer(1, 300);
  } else {
    Serial.println("Misting System OFF");
    setMistingRelay(false);
  }

  String body = "{\"temp\":" + String(temperature, 1) +
                ",\"humidity\":" + String(humidity, 1) +
                ",\"device_id\":\"esp32-dht\"}";

  postJSON("/api/readings", body);
}

/* ── Scheduled bathing ────────────────────────────────────── */
void checkBathingSchedule(const DateTime& now) {
  if (now.hour() == bathHour &&
      now.minute() == bathMinute &&
      !bathingDone) {

    Serial.println();
    Serial.println("==========================================");
    Serial.println(" SCHEDULED BATHING ACTIVATED ");
    Serial.println(" Water Pump Relay TURNING ON ");
    Serial.println("==========================================");

    bathingDone = true;
    setMistingRelay(true);
    beepBuzzer(3, 150);
  }

  if (now.minute() != bathMinute) {
    bathingDone = false;
  }
}

/* ── Water flow sensor, pushed to /api/water (from dht_copy v3,
   same YF-S201B calibration/interrupt handling — now also sent
   to the backend instead of just Serial) ────────────────────── */
void readAndPushFlow() {
  detachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN));

  // Calibration for YF-S201B
  flowRate = pulseCount / 7.5;
  totalLiters += flowRate / 60.0;

  Serial.println();
  Serial.println("----- WATER USAGE -----");
  Serial.print("Flow Rate : ");
  Serial.print(flowRate);
  Serial.println(" L/min");
  Serial.print("Total Water Used : ");
  Serial.print(totalLiters, 3);
  Serial.println(" L");

  pulseCount = 0;

  attachInterrupt(
    digitalPinToInterrupt(FLOW_SENSOR_PIN),
    pulseCounter,
    FALLING
  );

  previousMillis = millis();

  String body = "{\"level_pct\":null" +
                String(",\"used_l\":") + String(totalLiters, 3) +
                ",\"flow_lpm\":" + String(flowRate, 2) +
                ",\"device_id\":\"esp32-flow\"}";

  postJSON("/api/water", body);
}

/* ── HC-SR04 water tank level, pushed to /api/water (optional,
   from main.cpp prototype — disabled unless HAS_WATER_SENSOR
   is set true) ───────────────────────────────────────────────── */
#if HAS_WATER_SENSOR
void readAndPushWater() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout
  if (duration == 0) {
    Serial.println("HC-SR04: no echo received");
    return;
  }

  float distanceCm = duration * 0.0343 / 2.0;
  float levelPct = (TANK_EMPTY_CM - distanceCm) / (TANK_EMPTY_CM - TANK_FULL_CM) * 100.0;
  levelPct = constrain(levelPct, 0, 100);

  Serial.printf("Water tank: %.0f%% (distance %.1fcm)\n", levelPct, distanceCm);

  String body = "{\"level_pct\":" + String(levelPct, 0) +
                ",\"used_l\":0,\"flow_lpm\":0,\"device_id\":\"esp32-tank\"}";

  postJSON("/api/water", body);
}
#endif

/* ── HTTP POST helper ─────────────────────────────────────── */
void postJSON(const char* path, const String& body) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + path;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  if (code > 0) {
    Serial.printf("POST %s -> %d\n", path, code);
  } else {
    Serial.printf("POST %s failed: %s\n", path, http.errorToString(code).c_str());
  }
  http.end();
}