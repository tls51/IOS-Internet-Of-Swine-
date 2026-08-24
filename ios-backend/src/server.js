/* ============================================================
   server.js — IoS backend
   Receives pushes from the ESP32, stores them in SQLite,
   and serves the web dashboard (index.html/js) read-only data.
   ============================================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');  
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../..'))); // add this — serves index.html, css/, js/

const PORT = process.env.PORT || 3000;

/* ── THI classification & calculation ───────────────────────── */
function calcTHI(temp, humidity) {
  if (temp == null || humidity == null) return null;
  // Swine THI formula: THI = 0.8*T + (RH/100)*(T - 14.4) + 46.4
  const thi = 0.8 * temp + (humidity / 100.0) * (temp - 14.4) + 46.4;
  return parseFloat(thi.toFixed(1));
}

function thiLevel(thi, thresholds = db.getTHIThresholds()) {
  if (thi == null) return { label: '—', cls: 'badge-muted', color: '#8B949E' };
  const { normalMax, stressMax, extremeMax } = thresholds;
  if (thi < normalMax)   return { label: 'Normal',       cls: 'badge-blue',   color: '#3B82F6' };
  if (thi <= stressMax)  return { label: 'Stressful',    cls: 'badge-warn',   color: '#F59E0B' };
  if (thi <= extremeMax) return { label: 'Extreme Heat', cls: 'badge-orange', color: '#F97316' };
  return                        { label: 'Danger Zone',  cls: 'badge-danger', color: '#EF4444' };
}

/* ── Is a schedule active right now? ─────────────────────── */
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function isScheduleActiveNow(sched) {
  if (!sched.active) return false;
  const now = new Date();
  const today = DAY_NAMES[now.getDay()];
  if (!sched.days.includes(today)) return false;

  const [h, m] = sched.time.split(':').map(Number);
  const start = h * 60 + m;
  const end = start + sched.duration;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= start && nowMin < end;
}

/* ============================================================
   INGEST endpoints — called BY the ESP32 (push model)
   ============================================================ */

// ESP32 pushes a DHT22 + THI reading
app.post('/api/readings', (req, res) => {
  const { temp, humidity, device_id } = req.body;
  if (typeof temp !== 'number' || typeof humidity !== 'number') {
    return res.status(400).json({ error: 'temp and humidity (numbers) are required' });
  }
  const thi = calcTHI(temp, humidity);
  db.insertReading({ temp, humidity, thi, device_id });

  // auto-log threshold crossings for the Reports activity feed
  const threshold = parseFloat(db.getSetting('threshold', '32'));
  const thiThresholds = db.getTHIThresholds();
  if (temp > threshold) {
    db.logActivity('Mist', `Misting condition met — Temp ${temp}°C exceeded threshold ${threshold}°C`);
  }
  if (thi > thiThresholds.extremeMax) {
    db.logActivity('Alert', `DANGER: THI ${thi} — immediate cooling required`);
  } else if (thi > thiThresholds.stressMax) {
    db.logActivity('Alert', `WARNING: Extreme heat stress detected (THI ${thi})`);
  }

  res.status(201).json({ ok: true, thi });
});

// ESP32 / ultrasonic node pushes a water tank reading or flow rate
app.post('/api/water', (req, res) => {
  const { level_pct, used_l, flow_lpm, device_id } = req.body;
  const prev = db.latestWater();

  // Merge with previous known reading so flow and tank sensor don't overwrite each other with null/0
  const hasLevel = typeof level_pct === 'number' && !isNaN(level_pct);
  const finalLevel = hasLevel ? level_pct : (prev ? prev.level_pct : null);

  const hasUsed = typeof used_l === 'number' && !isNaN(used_l);
  const finalUsed = hasUsed ? used_l : (prev ? prev.used_l : 0);

  const hasFlow = typeof flow_lpm === 'number' && !isNaN(flow_lpm);
  const finalFlow = hasFlow ? flow_lpm : (prev ? prev.flow_lpm : 0);

  if (finalLevel == null && !hasUsed && !hasFlow) {
    return res.status(400).json({ error: 'Valid level_pct, used_l, or flow_lpm is required' });
  }

  db.insertWater({
    level_pct: finalLevel != null ? finalLevel : 0,
    used_l: finalUsed,
    flow_lpm: finalFlow,
    device_id: device_id || 'esp32'
  });

  if (finalLevel != null && finalLevel < 20 && (!prev || prev.level_pct >= 20)) {
    db.logActivity('Alert', `LOW WATER: Tank level critical (${Math.round(finalLevel)}%)`);
  }

  res.status(201).json({ ok: true, level_pct: finalLevel, used_l: finalUsed, flow_lpm: finalFlow });
});

/* ============================================================
   READ endpoints — called BY the web dashboard
   ============================================================ */

// Aggregate live status — mirrors the old DATA.state shape used by pages.js
app.get('/api/status', (req, res) => {
  const reading = db.latestReading();
  const water = db.latestWater();
  const threshold = parseFloat(db.getSetting('threshold', '32'));
  const thiThresholds = db.getTHIThresholds();
  const operationDurations = db.getOperationDurations();
  const bathSchedules = db.listSchedules('bath');
  const cleanSchedules = db.listSchedules('clean');

  const temp = reading ? reading.temp : null;
  const humidity = reading ? reading.humidity : null;
  const thi = reading ? reading.thi : null;

  // Real-time system malfunction diagnostics
  const malfunctions = [];
  const now = Date.now();
  if (reading && reading.ts && (now - reading.ts > 60000)) {
    malfunctions.push({ code: 'DHT_TIMEOUT', msg: 'DHT22 Sensor communication timeout (>60s no data received)' });
  }
  if (temp != null && (temp < 0 || temp > 60)) {
    malfunctions.push({ code: 'TEMP_OUT_OF_RANGE', msg: `DHT22 Temperature reading abnormal (${temp}°C)` });
  }
  if (humidity != null && (humidity < 1 || humidity > 100)) {
    malfunctions.push({ code: 'HUM_OUT_OF_RANGE', msg: `DHT22 Humidity reading abnormal (${humidity}%)` });
  }
  if (water && water.ts && (now - water.ts > 120000)) {
    malfunctions.push({ code: 'WATER_TIMEOUT', msg: 'Ultrasonic Tank Sensor communication timeout (>120s)' });
  }
  if (water && (water.level_pct < 0 || water.level_pct > 100)) {
    malfunctions.push({ code: 'WATER_OUT_OF_RANGE', msg: `Water tank sensor returned invalid level (${water.level_pct}%)` });
  }

  const diagnostics = db.latestDiagnostics();

  res.json({
    temp, humidity, thi,
    thiStatus: thi != null ? thiLevel(thi, thiThresholds) : null,
    thiThresholds,
    operationDurations,
    malfunctions,
    diagnostics,
    waterLevel: water ? water.level_pct : null,
    waterUsed: water ? water.used_l : 0,
    flowRate: water ? water.flow_lpm : 0,
    mistActive: temp != null ? temp > threshold : false,
    bathActive: bathSchedules.some(isScheduleActiveNow),
    cleanActive: cleanSchedules.some(isScheduleActiveNow),
    threshold,
    lastReadingTs: reading ? reading.ts : null,
    lastWaterTs: water ? water.ts : null,
  });
});

// Historical readings for line charts. ?range=24h|7d|30d
app.get('/api/readings/history', (req, res) => {
  const range = req.query.range || '24h';
  const ms = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 }[range] || 24 * 3600e3;
  const rows = db.readingsSince(Date.now() - ms);
  res.json(rows.map(r => ({
    time: new Date(r.ts).toTimeString().slice(0, 5),
    ts: r.ts,
    temp: r.temp,
    humidity: r.humidity,
    thi: r.thi,
  })));
});

// Weekly water usage for the bar chart
app.get('/api/water/weekly', (req, res) => {
  res.json(db.weeklyWaterUsage());
});

// Schedules
app.get('/api/schedules', (req, res) => {
  const type = req.query.type;
  if (!['bath', 'clean'].includes(type)) return res.status(400).json({ error: 'type must be bath or clean' });
  res.json(db.listSchedules(type));
});

app.post('/api/schedules', (req, res) => {
  const { type, label, time, duration, days } = req.body;
  if (!['bath', 'clean'].includes(type)) return res.status(400).json({ error: 'type must be bath or clean' });
  const row = db.createSchedule({ type, label, time, duration, days });
  res.status(201).json({ ...row, days: JSON.parse(row.days), active: !!row.active });
});

app.patch('/api/schedules/:id', (req, res) => {
  const row = db.toggleSchedule(req.params.id, !!req.body.active);
  res.json({ ...row, days: JSON.parse(row.days), active: !!row.active });
});

app.delete('/api/schedules/:id', (req, res) => {
  db.deleteSchedule(req.params.id);
  res.status(204).end();
});

// Threshold setting
app.get('/api/settings/threshold', (req, res) => {
  res.json({ value: parseFloat(db.getSetting('threshold', '32')) });
});

app.post('/api/settings/threshold', (req, res) => {
  const { value } = req.body;
  if (typeof value !== 'number' || value < 20 || value > 50) {
    return res.status(400).json({ error: 'value must be a number between 20 and 50' });
  }
  db.setSetting('threshold', value);
  db.logActivity('Info', `Mist cooling threshold updated to ${value}°C`);
  res.json({ value });
});

// Operation Durations settings (get and customize misting run/pause duration)
app.get('/api/settings/durations', (req, res) => {
  res.json(db.getOperationDurations());
});

app.post('/api/settings/durations', (req, res) => {
  const { mistDurationMin, mistPauseSec } = req.body;
  const updated = db.setOperationDurations({
    mistDurationMin: typeof mistDurationMin === 'number' ? mistDurationMin : undefined,
    mistPauseSec: typeof mistPauseSec === 'number' ? mistPauseSec : undefined,
  });
  db.logActivity('Info', `Operation durations updated: Misting ${updated.mistDurationMin} min ON / ${updated.mistPauseSec} s pause`);
  res.json(updated);
});

// THI Level Thresholds settings (get and customize limits)
app.get('/api/settings/thi', (req, res) => {
  res.json(db.getTHIThresholds());
});

app.post('/api/settings/thi', (req, res) => {
  const { normalMax, stressMax, extremeMax } = req.body;
  const updated = db.setTHIThresholds({
    normalMax: typeof normalMax === 'number' ? normalMax : undefined,
    stressMax: typeof stressMax === 'number' ? stressMax : undefined,
    extremeMax: typeof extremeMax === 'number' ? extremeMax : undefined,
  });
  db.logActivity('Alert', `THI thresholds updated: Normal<${updated.normalMax}, Stress<=${updated.stressMax}, Extreme<=${updated.extremeMax}`);
  res.json(updated);
});

// System Report CSV Export
app.get('/api/reports/export', (req, res) => {
  const range = req.query.range || '24h';
  const ms = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 }[range] || 24 * 3600e3;
  const rows = db.readingsSince(Date.now() - ms);
  const thiThresholds = db.getTHIThresholds();

  let csv = 'Timestamp,DateTime,Temperature_C,Humidity_Pct,THI,THI_Status\r\n';
  rows.forEach(r => {
    const dt = new Date(r.ts).toISOString();
    const status = thiLevel(r.thi, thiThresholds).label;
    csv += `${r.ts},"${dt}",${r.temp},${r.humidity},${r.thi},"${status}"\r\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ios_system_report_${range}_${Date.now()}.csv"`);
  res.send(csv);
});

// Activity log for the Reports page
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  res.json(db.recentActivity(limit));
});

// Sensor Hardware Diagnostics (pushed by ESP32 self-test or queried by web dashboard)
app.post('/api/diagnostics', (req, res) => {
  const { dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, details } = req.body;
  db.saveDiagnostics({ dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, details });
  db.logActivity('Info', `ESP32 completed hardware self-test: DHT:${dht_ok ? 'PASS' : 'FAIL'}, RTC:${rtc_ok ? 'PASS' : 'FAIL'}, Tank:${tank_ok ? 'PASS' : 'FAIL'}, Flow:${flow_ok ? 'PASS' : 'FAIL'}, Relay:${relay_ok ? 'PASS' : 'FAIL'}`);
  res.status(201).json({ ok: true, diagnostics: db.latestDiagnostics() });
});

app.get('/api/diagnostics', (req, res) => {
  res.json(db.latestDiagnostics() || { ok: false, msg: 'No diagnostics recorded yet' });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.listen(PORT, () => {
  console.log(`IoS backend listening on http://0.0.0.0:${PORT}`);
  console.log(`ESP32 should POST readings to http://<this-machine-ip>:${PORT}/api/readings`);
});
