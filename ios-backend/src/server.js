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

// ESP32 / ultrasonic node pushes a water tank reading
app.post('/api/water', (req, res) => {
  const { level_pct, used_l, flow_lpm, device_id } = req.body;
  if (typeof level_pct !== 'number') {
    return res.status(400).json({ error: 'level_pct (number) is required' });
  }
  db.insertWater({ level_pct, used_l: used_l || 0, flow_lpm: flow_lpm || 0, device_id });

  if (level_pct < 20) {
    db.logActivity('Alert', `LOW WATER: Tank level critical (${level_pct}%)`);
  }
  res.status(201).json({ ok: true });
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
  const bathSchedules = db.listSchedules('bath');
  const cleanSchedules = db.listSchedules('clean');

  const temp = reading ? reading.temp : null;
  const humidity = reading ? reading.humidity : null;
  const thi = reading ? reading.thi : null;

  res.json({
    temp, humidity, thi,
    thiStatus: thi != null ? thiLevel(thi, thiThresholds) : null,
    thiThresholds,
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

// Activity log for the Reports page
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  res.json(db.recentActivity(limit));
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.listen(PORT, () => {
  console.log(`IoS backend listening on http://0.0.0.0:${PORT}`);
  console.log(`ESP32 should POST readings to http://<this-machine-ip>:${PORT}/api/readings`);
});
