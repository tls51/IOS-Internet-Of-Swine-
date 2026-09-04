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
     Relay (mister) -> GPIO18
     HC-SR04 TRIG   -> GPIO16  (tank level)
     HC-SR04 ECHO   -> GPIO17  (tank level via voltage divider)
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
const char* SERVER_HOST = "192.168.1.46";
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
   (trigger on LOW signal: LOW = ON, HIGH = OFF).
   =========================== */
#define RELAY_PIN 18          // Relay control pin (Active-LOW: LOW=ON, HIGH=OFF)
#define RELAY_ACTIVE_LOW true // Set true if LOW turns relay ON (standard for relay modules)

/* Set TEST_MODE to true to test the misting cycle immediately regardless of THI/heat stress.
   Set to false for normal operation (relays trigger in Danger Zone THI > thiExtremeMax). */
#define TEST_MODE false

/* Configured THI thresholds (matching backend default / dynamic sync) */
float thiNormalMax  = 74.0;
float thiStressMax  = 79.0;
float thiExtremeMax = 84.0; // Danger Zone threshold: THI > thiExtremeMax

/* Misting Cycle Timings (15s ON, 5s OFF interval in a continuous loop) */
unsigned long mistOnDurationMs  = 15000; // 15 seconds ON
unsigned long mistPauseDurationMs = 5000; // 5 seconds OFF (interval)

bool mistingActive = false;      // True if misting condition is active (Danger Zone or TEST_MODE)
bool mistingCycleState = false;  // True = pump ON phase, False = pump OFF phase
unsigned long mistCycleTimer = 0;// Timestamp of last state switch

/* Optional Piezo Buzzer settings */
#define HAS_BUZZER false      // Set to true if a dedicated Piezo Buzzer is wired up
#define BUZZER_PIN 19         // Moved to GPIO 19 to prevent conflict with RELAY_PIN 18

/* ===========================
   HC-SR04 ULTRASONIC WATER TANK SENSOR
   Wiring & Voltage Divider:
     VCC  -> 5V (VIN or 5V pin on ESP32 — NOT 3.3V)
     GND  -> GND
     TRIG -> GPIO 16
     ECHO -> Voltage Divider -> GPIO 17
             (ECHO -> 1kΩ resistor -> GPIO 17 -> 2kΩ resistor -> GND)
   =========================== */
#define HAS_WATER_SENSOR true
#define TRIG_PIN 16
#define ECHO_PIN 17
const float TANK_EMPTY_CM = 14.0;   // Sensor reading distance when tank is empty (cm)
const float TANK_FULL_CM  = 3.0;    // Sensor reading distance when tank is full (cm)

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
void updateMistingLoop();
void readAndPushFlow();
void setMistingRelay(bool on);
bool testRelayAndPump(int durationMs = 30000);
void checkPendingCommands();
void beepBuzzer(int count = 1, int delayMs = 150);
#if HAS_WATER_SENSOR
void readAndPushWater();
#endif
void postJSON(const char* path, const String& body);
void checkAllSensors(bool pushToBackend);

/* ===========================
   SENSOR SELF-TEST & HEALTH DIAGNOSTICS
   =========================== */
bool rtcOnline = false;

bool checkDHT(float &temp, float &hum, String &msg) {
  hum  = dht.readHumidity();
  temp = dht.readTemperature();

  if (isnan(hum) || isnan(temp)) {
    msg = "FAILED to read DHT22 on GPIO " + String(DHTPIN) + ". Check 3.3V/5V power, GND, and 10kΩ pull-up.";
    return false;
  }
  if (temp < -10.0 || temp > 70.0 || hum < 1.0 || hum > 100.0) {
    msg = "WARNING: DHT22 values out of range (T=" + String(temp, 1) + "C, H=" + String(hum, 1) + "%).";
    return false;
  }
  msg = "Temp: " + String(temp, 1) + "°C | Humidity: " + String(hum, 1) + "% RH (DHT22 on GPIO " + String(DHTPIN) + ")";
  return true;
}

bool checkRTC(DateTime &now, float &rtcTemp, String &msg) {
  if (!rtcOnline) {
    rtcOnline = rtc.begin();
  }
  if (!rtcOnline) {
    msg = "RTC DS3231 NOT detected on I2C (SDA=GPIO8, SCL=GPIO9). Node running in fallback millis() mode.";
    return false;
  }
  now = rtc.now();
  rtcTemp = rtc.getTemperature();
  char timeBuf[32];
  snprintf(timeBuf, sizeof(timeBuf), "%04d-%02d-%02d %02d:%02d:%02d",
           now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
  msg = "RTC Time: " + String(timeBuf) + " | Internal Temp: " + String(rtcTemp, 1) + "°C";
  return true;
}

bool checkHCSR04(float &distanceCm, float &levelPct, String &msg) {
#if HAS_WATER_SENSOR

  // Give the HC-SR04 time to settle
  delay(100);

  // Make sure TRIG starts LOW
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(5);

  // Send 10us trigger pulse
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // Read ECHO
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 60000);

  // Print raw result so we know exactly what is happening
  Serial.print("[HC-SR04 DEBUG] ECHO duration = ");
  Serial.print(duration);
  Serial.println(" us");

  if (duration == 0) {
    msg = "No echo detected on GPIO " + String(ECHO_PIN) +
          ". Check HC-SR04 power, GND, TRIG, ECHO and voltage divider.";
    return false;
  }

  // Reject extremely short/noisy signals
  if (duration < 150) {
    msg = "Echo too short: " + String(duration) +
          " us. Sensor may be too close or signal is noise.";
    return false;
  }

  // Convert echo time to distance
  distanceCm = duration * 0.0343 / 2.0;

  // Calculate tank percentage
  levelPct = (TANK_EMPTY_CM - distanceCm) /
             (TANK_EMPTY_CM - TANK_FULL_CM) * 100.0;

  levelPct = constrain(levelPct, 0.0, 100.0);

  msg = "Echo: " + String(duration) +
        " us | Distance: " + String(distanceCm, 1) +
        " cm | Water Level: " + String(levelPct, 0) + "%";

  return true;

#else

  msg = "HC-SR04 disabled in firmware configuration";
  return false;

#endif
}

bool checkFlowSensor(String &msg) {
  int pinState = digitalRead(FLOW_SENSOR_PIN);
  msg = "Pin GPIO " + String(FLOW_SENSOR_PIN) + " (State: " + (pinState == HIGH ? "HIGH" : "LOW") + ") | Pulses registered: " + String(pulseCount) + " | Usage: " + String(totalLiters, 2) + "L";
  return true;
}

bool checkRelay(String &msg) {
  int pinVal = digitalRead(RELAY_PIN);
  msg = "GPIO " + String(RELAY_PIN) + " connected to Water Pump Relay (Active-LOW: " + String(RELAY_ACTIVE_LOW ? "YES" : "NO") + ", State: " + (pinVal == HIGH ? "HIGH" : "LOW") + ") | Type 'test pump' to trigger";
  return true;
}

bool checkBackendConnection(String &msg) {
  if (WiFi.status() != WL_CONNECTED) {
    msg = "WiFi disconnected. Connect failed to SSID: " + String(WIFI_SSID);
    return false;
  }

  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/health";
  http.begin(url);
  http.setTimeout(2500);

  int code = http.GET();
  http.end();

  if (code == 200) {
    msg = "Backend server reachable at " + String(SERVER_HOST) + ":" + String(SERVER_PORT) + " (HTTP 200 OK)";
    return true;
  } else {
    msg = "Backend ping failed at " + String(SERVER_HOST) + ":" + String(SERVER_PORT) + " (HTTP " + String(code) + "). Verify `npm start` is running.";
    return false;
  }
}

void checkAllSensors(bool pushToBackend) {
  Serial.println("\n================================================================================");
  Serial.println("                  IoS SENSOR HARDWARE SELF-TEST & DIAGNOSTICS                  ");
  Serial.println("================================================================================");

  float dhtT = 0, dhtH = 0;
  String dhtMsg;
  bool dhtOk = checkDHT(dhtT, dhtH, dhtMsg);
  Serial.printf("[1/6] DHT22 Temp/Humidity (GPIO %d)     : %s\n      -> %s\n",
                DHTPIN, dhtOk ? "[PASS]" : "[FAIL]", dhtMsg.c_str());

  DateTime now;
  float rtcTemp = 0;
  String rtcMsg;
  bool rtcOk = checkRTC(now, rtcTemp, rtcMsg);
  Serial.printf("[2/6] DS3231 RTC Module (I2C SDA:8 SCL:9) : %s\n      -> %s\n",
                rtcOk ? "[PASS]" : "[WARN]", rtcMsg.c_str());

  float distCm = 0, levelPct = 0;
  String tankMsg;
  bool tankOk = checkHCSR04(distCm, levelPct, tankMsg);
  Serial.printf("[3/6] HC-SR04 Tank Sensor (T:%d E:%d)      : %s\n      -> %s\n",
                TRIG_PIN, ECHO_PIN, tankOk ? "[PASS]" : "[FAIL]", tankMsg.c_str());

  String flowMsg;
  bool flowOk = checkFlowSensor(flowMsg);
  Serial.printf("[4/6] YF-S201B Flow Sensor (GPIO %d)      : %s\n      -> %s\n",
                FLOW_SENSOR_PIN, flowOk ? "[PASS]" : "[FAIL]", flowMsg.c_str());

  String relayMsg;
  bool relayOk = checkRelay(relayMsg);
  Serial.printf("[5/6] Relay Controller (GPIO %d)          : %s\n      -> %s\n",
                RELAY_PIN, relayOk ? "[PASS]" : "[FAIL]", relayMsg.c_str());

  String netMsg;
  bool netOk = checkBackendConnection(netMsg);
  Serial.printf("[6/6] WiFi & Backend Server Link         : %s\n      -> %s\n",
                netOk ? "[PASS]" : "[WARN]", netMsg.c_str());

  int passed = (dhtOk?1:0) + (rtcOk?1:0) + (tankOk?1:0) + (flowOk?1:0) + (relayOk?1:0);
  Serial.println("--------------------------------------------------------------------------------");
  Serial.printf ("DIAGNOSTIC SUMMARY: %d of 5 Primary Hardware Subsystems Functioning Normally\n", passed);
  if (passed == 5 && netOk) {
    Serial.println("STATUS: ALL SYSTEMS HEALTHY AND OPERATIONAL (Ready for Swine Barn Deployment)");
  } else {
    Serial.println("STATUS: ATTENTION NEEDED - Review warnings/failures above for wiring hints.");
  }
  Serial.println("Tip: Type 'test' in the Serial Monitor at any time to re-run this self-test.");
  Serial.println("================================================================================\n");

  if (pushToBackend && WiFi.status() == WL_CONNECTED) {
    String diagJson = "{\"dht_ok\":" + String(dhtOk ? "true" : "false") +
                      ",\"rtc_ok\":" + String(rtcOk ? "true" : "false") +
                      ",\"tank_ok\":" + String(tankOk ? "true" : "false") +
                      ",\"flow_ok\":" + String(flowOk ? "true" : "false") +
                      ",\"relay_ok\":" + String(relayOk ? "true" : "false") +
                      ",\"details\":{" +
                      "\"dht\":\"" + dhtMsg + "\"" +
                      ",\"rtc\":\"" + rtcMsg + "\"" +
                      ",\"tank\":\"" + tankMsg + "\"" +
                      ",\"flow\":\"" + flowMsg + "\"" +
                      ",\"relay\":\"" + relayMsg + "\"" +
                      ",\"network\":\"" + netMsg + "\"" +
                      "}}";
    postJSON("/api/diagnostics", diagJson);
  }
}

/* ===========================
   INTERRUPT (from dht_copy v3, unchanged)
   =========================== */
void IRAM_ATTR pulseCounter() {
  pulseCount++;
  Serial.println(pulseCount);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n\n==========================================");
  Serial.println(" Internet of Swine (IoS) — Sensor Node");
  Serial.println(" Initializing Hardware Subsystems...");
  Serial.println("==========================================");

  dht.begin();
  Wire.begin(8, 9);   // SDA = GPIO8, SCL = GPIO9
  rtcOnline = rtc.begin();
  if (!rtcOnline) {
    Serial.println("[WARNING] RTC DS3231 not found on I2C. Continuing startup...");
  }

  // Water flow sensor
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

#if HAS_WATER_SENSOR
  pinMode(TRIG_PIN, OUTPUT);
  digitalWrite(TRIG_PIN, LOW);
  pinMode(ECHO_PIN, INPUT);
#endif

  // Run hardware self-test immediately on boot
  checkAllSensors(false);

  // Connect to WiFi
  connectWiFi();

  // Re-run diagnostics and post full results to backend
  checkAllSensors(true);
}

unsigned long lastDiagCheckAt = 0;
const unsigned long DIAG_INTERVAL_MS = 300000; // Auto-diagnostics every 5 mins

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  // Allow user to trigger self-test or test pump by typing in Serial Monitor
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.toLowerCase();
    if (cmd == "test pump" || cmd == "pump test" || cmd == "test relay" || cmd == "relay test" || cmd == "pump") {
      testRelayAndPump(30000);
    } else if (cmd == "pump on" || cmd == "relay on") {
      Serial.println(">>> MANUAL OVERRIDE: Water Pump Relay turned ON <<<");
      setMistingRelay(true);
    } else if (cmd == "pump off" || cmd == "relay off") {
      Serial.println(">>> MANUAL OVERRIDE: Water Pump Relay turned OFF <<<");
      setMistingRelay(false);
    } else if (cmd == "test" || cmd == "check" || cmd == "diag" || cmd == "status" || cmd == "help") {
      checkAllSensors(true);
    }
  }

  // Check for remote commands from the web dashboard (e.g. Test Pump or Manual Toggle)
  checkPendingCommands();

  // Periodic background hardware self-test (every 5 min)
  if (millis() - lastDiagCheckAt >= DIAG_INTERVAL_MS) {
    lastDiagCheckAt = millis();
    checkAllSensors(true);
  }

  DateTime now;
  if (rtcOnline) {
    now = rtc.now();
    checkBathingSchedule(now);
  }

  // Periodic DHT environmental sensor sampling
  if (millis() - lastReadingAt >= READING_INTERVAL_MS) {
    lastReadingAt = millis();
    readAndPushDHT();
#if HAS_WATER_SENSOR
    readAndPushWater();
#endif
  }

  // Active misting duty-cycle state machine (15s ON, 5s OFF interval in a loop)
  updateMistingLoop();

  if (millis() - lastFlowCheckAt >= FLOW_CHECK_INTERVAL_MS) {
    lastFlowCheckAt = millis();
    readAndPushFlow();
  }
}

/* ── Misting Duty Cycle Loop (15s ON / 5s OFF) ────────────── */
void updateMistingLoop() {
  // If scheduled bathing is currently active, don't interrupt it with misting cycling
  if (bathingDone) return;

  if (mistingActive) {
    unsigned long currentMillis = millis();

    // If starting a fresh misting cycle
    if (mistCycleTimer == 0) {
      mistCycleTimer = currentMillis;
      mistingCycleState = true;
      Serial.println("\n[MISTING CYCLE] >>> Phase: PUMP ON (15s run) <<<");
      setMistingRelay(true);
      beepBuzzer(1, 150);
      return;
    }

    if (mistingCycleState) {
      // Currently ON: check if 15 seconds have elapsed
      if (currentMillis - mistCycleTimer >= MIST_ON_DURATION_MS) {
        mistingCycleState = false;
        mistCycleTimer = currentMillis;
        Serial.println("\n[MISTING CYCLE] >>> Phase: PUMP OFF (5s interval pause) <<<");
        setMistingRelay(false);
      }
    } else {
      // Currently OFF: check if 5 seconds interval has elapsed
      if (currentMillis - mistCycleTimer >= MIST_OFF_DURATION_MS) {
        mistingCycleState = true;
        mistCycleTimer = currentMillis;
        Serial.println("\n[MISTING CYCLE] >>> Phase: PUMP ON (15s run) <<<");
        setMistingRelay(true);
      }
    }
  } else {
    // Misting condition is inactive: ensure pump is OFF and timer reset
    if (mistCycleTimer != 0 || mistingCycleState) {
      mistCycleTimer = 0;
      mistingCycleState = false;
      Serial.println("[MISTING CYCLE] Misting condition cleared -> Pump OFF");
      setMistingRelay(false);
    }
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

/* ── Relay & Water Pump Control & Testing ─────────────────── */
bool currentRelayState = false;

void setMistingRelay(bool on) {
  currentRelayState = on;
  // Handles Active-LOW vs Active-HIGH relay module logic
  bool pinState = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(RELAY_PIN, pinState ? HIGH : LOW);
  Serial.printf("Relay (GPIO %d) -> %s (Water Pump / Misting: %s)\n",
                RELAY_PIN, pinState ? "HIGH" : "LOW", on ? "ON" : "OFF");
}

bool testRelayAndPump(int durationMs) {
  Serial.println("\n==================================================");
  Serial.println("      RELAY MODULE & WATER PUMP HARDWARE TEST     ");
  Serial.println("==================================================");
  Serial.printf ("Target Pin: GPIO %d (Active-%s)\n", RELAY_PIN, RELAY_ACTIVE_LOW ? "LOW" : "HIGH");
  Serial.printf ("Duration  : %d ms\n", durationMs);
  Serial.println("Action    : Turning ON Water Pump Relay & Monitoring Flow...");

  int startPulses = pulseCount;
  unsigned long testStart = millis();

  // Activate Relay Module & Water Pump
  setMistingRelay(true);
#if HAS_BUZZER
  digitalWrite(BUZZER_PIN, HIGH);
  delay(120);
  digitalWrite(BUZZER_PIN, LOW);
#endif

  // Service yields during the test duration
  while (millis() - testStart < (unsigned long)durationMs) {
    delay(50);
  }

  // Deactivate Relay Module & Water Pump
  setMistingRelay(false);

  int testPulses = pulseCount - startPulses;
  if (testPulses < 0) testPulses = pulseCount;
  float testFlowRate = (testPulses / 7.5);

  Serial.println("--------------------------------------------------");
  Serial.printf ("[TEST COMPLETED] Water Pump ran for %d ms\n", durationMs);
  Serial.printf ("                 Flow Pulses Registered: %d\n", testPulses);
  Serial.printf ("                 Estimated Flow Rate   : %.2f L/min\n", testFlowRate);
  Serial.println("Status  : [PASS] Relay triggered and released safely.");
  Serial.println("==================================================\n");

  if (WiFi.status() == WL_CONNECTED) {
    String statusBody = "{\"relay_on\":false,\"test_completed\":true,\"flow_pulses\":" + String(testPulses) +
                        ",\"flow_lpm\":" + String(testFlowRate, 2) + "}";
    postJSON("/api/relay/status", statusBody);
  }

  return true;
}

unsigned long lastCommandCheckAt = 0;
const unsigned long COMMAND_CHECK_INTERVAL_MS = 2500;

void checkPendingCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastCommandCheckAt < COMMAND_CHECK_INTERVAL_MS) return;
  lastCommandCheckAt = millis();

  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/relay/command";
  http.begin(url);
  http.setTimeout(1500);

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    if (payload.indexOf("\"command\":\"test_pump\"") >= 0) {
      int dur = 30000;
      int durIdx = payload.indexOf("\"duration_ms\":");
      if (durIdx >= 0) {
        dur = payload.substring(durIdx + 14).toInt();
        if (dur <= 0 || dur > 60000) dur = 30000;
      }
      Serial.println("\n>>> [REMOTE COMMAND] Received: test_pump from Web Dashboard <<<");
      testRelayAndPump(dur);
    } else if (payload.indexOf("\"command\":\"pump_on\"") >= 0) {
      Serial.println("\n>>> [REMOTE COMMAND] Received: pump_on (Manual Override) <<<");
      setMistingRelay(true);
    } else if (payload.indexOf("\"command\":\"pump_off\"") >= 0) {
      Serial.println("\n>>> [REMOTE COMMAND] Received: pump_off (Manual Override) <<<");
      setMistingRelay(false);
    }
  }
  http.end();
}

void beepBuzzer(int count, int delayMs) {
#if HAS_BUZZER
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(delayMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < count - 1) {
      delay(delayMs);
    }
  }
#else
  (void)count;
  (void)delayMs;
#endif
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
    Serial.println(">>> TEST_MODE ACTIVE: Continuous 15s ON / 5s OFF misting cycle triggered <<<");
    mistingActive = true;
  } else if (status != "NORMAL") {
    Serial.println(">>> HEAT STRESS DETECTED: Activating Misting Cycle (15s ON / 5s OFF) <<<");
    mistingActive = true;
  } else {
    Serial.println(">>> Climate Normal: Misting System Idle <<<");
    mistingActive = false;
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
  Serial.printf("Flow Rate : %.2f L/min\n", flowRate);
  Serial.printf("Total Water Used : %.3f L\n", totalLiters);

  pulseCount = 0;

  attachInterrupt(
    digitalPinToInterrupt(FLOW_SENSOR_PIN),
    pulseCounter,
    FALLING
  );

  previousMillis = millis();

  // Send flow telemetry (backend seamlessly merges tank level & flow)
  String body = "{\"used_l\":" + String(totalLiters, 3) +
                ",\"flow_lpm\":" + String(flowRate, 2) +
                ",\"device_id\":\"esp32-flow\"}";

  postJSON("/api/water", body);
}

/* ── HC-SR04 water tank level, pushed to /api/water ────────── */
#if HAS_WATER_SENSOR
void readAndPushWater() {
  const int SAMPLES = 3;
  long durations[SAMPLES];
  int validCount = 0;
  long durationSum = 0;

  for (int i = 0; i < SAMPLES; i++) {
    delay(60); // Minimum 60ms between consecutive ultrasonic pings

    // Send clean 10us pulse exactly matching reference code
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    // Wait for ECHO pulse (35000 µs timeout covers up to ~6m)
    long d = pulseIn(ECHO_PIN, HIGH, 35000);
    durations[i] = d;

    Serial.printf("[HC-SR04 DEBUG] Sample %d = %ld us\n", i + 1, d);

    if (d >= 120) {
      durationSum += d;
      validCount++;
    }
  }

  if (validCount == 0) {
    Serial.println("\n[HC-SR04 ERROR] No valid echo pulse received!");
    Serial.println(" -> Troubleshooting checks:");
    Serial.printf ("    1. VCC must be 5V (VIN pin), NOT 3.3V (standard HC-SR04 requires 5V)\n");
    Serial.printf ("    2. Common GND connected to ESP32 GND\n");
    Serial.printf ("    3. TRIG connected to GPIO %d\n", TRIG_PIN);
    Serial.printf ("    4. ECHO connected to GPIO %d via Voltage Divider (e.g. 1kΩ / 2kΩ)\n", ECHO_PIN);
    Serial.println("    5. Sensor face is pointing towards water and unobstructed\n");
    return;
  }

  long avgDuration = durationSum / validCount;
  float distanceCm = avgDuration * 0.0343 / 2.0;

  // Calculate percentage based on empty vs full tank calibration
  float levelPct = (TANK_EMPTY_CM - distanceCm) / (TANK_EMPTY_CM - TANK_FULL_CM) * 100.0;
  levelPct = constrain(levelPct, 0.0, 100.0);

  Serial.println("\n----- WATER TANK LEVEL -----");
  Serial.printf("[HC-SR04] Duration: %ld us | Distance: %.1f cm | Tank Level: %.0f%%\n",
                avgDuration, distanceCm, levelPct);

  // Send tank level reading to backend (including raw distance_cm)
  String body = "{\"level_pct\":" + String(levelPct, 0) +
                ",\"distance_cm\":" + String(distanceCm, 1) +
                ",\"device_id\":\"esp32-tank\"}";

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