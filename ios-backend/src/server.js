/* ============================================================
   server.js — IoS backend
   Receives pushes from the ESP32, stores them in SQLite,
   and serves the web dashboard.
   ============================================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../dashboard')));

const PORT = process.env.PORT || 3000;


/* ============================================================
   THI CLASSIFICATION & CALCULATION
   ============================================================ */

function calcTHI(temp, humidity) {
  if (temp == null || humidity == null) return null;

  // Swine THI formula
  const thi =
    0.8 * temp +
    (humidity / 100.0) * (temp - 14.4) +
    46.4;

  return parseFloat(thi.toFixed(1));
}


function thiLevel(thi, thresholds = db.getTHIThresholds()) {

  if (thi == null) {
    return {
      label: '—',
      cls: 'badge-muted',
      color: '#8B949E'
    };
  }

  const {
    normalMax,
    stressMax,
    extremeMax
  } = thresholds;

  if (thi < normalMax) {
    return {
      label: 'Normal',
      cls: 'badge-blue',
      color: '#3B82F6'
    };
  }

  if (thi <= stressMax) {
    return {
      label: 'Stressful',
      cls: 'badge-warn',
      color: '#F59E0B'
    };
  }

  if (thi <= extremeMax) {
    return {
      label: 'Extreme Heat',
      cls: 'badge-orange',
      color: '#F97316'
    };
  }

  return {
    label: 'Danger Zone',
    cls: 'badge-danger',
    color: '#EF4444'
  };
}


/* ============================================================
   SCHEDULE VALIDATION / NORMALIZATION
   ============================================================ */

const DAY_NAMES = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat'
];

// Accepts "Mon", "monday", "Monday", "MON", etc. and maps them
// all to the canonical 3-letter form used by DAY_NAMES/isScheduleActiveNow.
const DAY_ALIASES = {
  sun: 'Sun', sunday: 'Sun',
  mon: 'Mon', monday: 'Mon',
  tue: 'Tue', tues: 'Tue', tuesday: 'Tue',
  wed: 'Wed', weds: 'Wed', wednesday: 'Wed',
  thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu',
  fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat'
};

const TIME_RE = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;

function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  return days
    .map(d => DAY_ALIASES[String(d).trim().toLowerCase()])
    .filter(Boolean);
}

// Validates + normalizes a schedule payload from the dashboard.
// Returns { ok: true, value } or { ok: false, error }.
function parseScheduleInput(body, { partial = false } = {}) {
  const out = {};

  if (body.label !== undefined) {
    out.label = String(body.label).trim() || 'Untitled Schedule';
  } else if (!partial) {
    out.label = 'Untitled Schedule';
  }

  if (body.time !== undefined) {
    const time = String(body.time).trim();
    if (!TIME_RE.test(time)) {
      return { ok: false, error: `time must be in HH:MM 24-hour format, got "${body.time}"` };
    }
    // normalize to zero-padded HH:MM
    const [h, m] = time.split(':').map(Number);
    out.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } else if (!partial) {
    return { ok: false, error: 'time is required (HH:MM)' };
  }

  if (body.duration !== undefined) {
    const duration = parseInt(body.duration, 10);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: `duration must be a positive number of minutes, got "${body.duration}"` };
    }
    out.duration = duration;
  } else if (!partial) {
    return { ok: false, error: 'duration is required (minutes)' };
  }

  if (body.days !== undefined) {
    const days = normalizeDays(body.days);
    if (days.length === 0) {
      return { ok: false, error: `days must include at least one valid day (Sun..Sat), got ${JSON.stringify(body.days)}` };
    }
    out.days = days;
  } else if (!partial) {
    return { ok: false, error: 'days is required (array of day names)' };
  }

  if (body.active !== undefined) {
    out.active = !!body.active;
  }

  return { ok: true, value: out };
}


/* ============================================================
   DATABASE SCHEDULE CHECK
   ============================================================ */

function isScheduleActiveNow(sched) {

  // Schedule must be enabled
  if (!sched.active) {
    return false;
  }

  const now = new Date();

  // Current day
  const today = DAY_NAMES[now.getDay()];

  // Current time in minutes
  const nowMin =
    now.getHours() * 60 +
    now.getMinutes();

  // Convert schedule start time to minutes
  const [h, m] = sched.time
    .split(':')
    .map(Number);

  const start = h * 60 + m;

  // Schedule end time (may exceed 1439 if it crosses midnight)
  const end = start + sched.duration;

  if (end <= 1440) {
    // Normal case: whole window is on the same calendar day
    if (!sched.days.includes(today)) {
      return false;
    }
    return nowMin >= start && nowMin < end;
  }

  // Window crosses midnight (e.g. 23:50 for 20 min -> ends 00:10 next day)
  const wrappedEnd = end - 1440;
  const yesterday = DAY_NAMES[(now.getDay() + 6) % 7];

  // Either: today is a scheduled day and we're after start (pre-midnight part)
  if (sched.days.includes(today) && nowMin >= start) {
    return true;
  }

  // Or: yesterday was a scheduled day and we're still in the wrapped part (post-midnight)
  if (sched.days.includes(yesterday) && nowMin < wrappedEnd) {
    return true;
  }

  return false;
}


/* ============================================================
   ESP32 → BACKEND
   DHT22 + THI
   ============================================================ */

app.post('/api/readings', (req, res) => {

  const {
    temp,
    humidity,
    device_id
  } = req.body;

  if (
    typeof temp !== 'number' ||
    typeof humidity !== 'number'
  ) {
    return res.status(400).json({
      error: 'temp and humidity (numbers) are required'
    });
  }

  const thi = calcTHI(temp, humidity);

  db.insertReading({
    temp,
    humidity,
    thi,
    device_id
  });


  // Activity log
  const thiThresholds =
    db.getTHIThresholds();

  const status =
    thiLevel(thi, thiThresholds);

  db.logActivity(
    'Mist',
    `DHT22 reading — Temp ${temp}°C, Humidity ${humidity}%, THI ${thi} (${status.label})`
  );


  // Temperature threshold
  const threshold =
    parseFloat(
      db.getSetting('threshold', '32')
    );

  if (temp > threshold) {

    db.logActivity(
      'Mist',
      `Misting condition met — Temp ${temp}°C exceeded threshold ${threshold}°C`
    );
  }


  // THI alerts
  if (thi > thiThresholds.extremeMax) {

    db.logActivity(
      'Alert',
      `DANGER: THI ${thi} — immediate cooling required`
    );

  } else if (thi > thiThresholds.stressMax) {

    db.logActivity(
      'Alert',
      `WARNING: Extreme heat stress detected (THI ${thi})`
    );
  }


  res.status(201).json({
    ok: true,
    thi
  });
});


/* ============================================================
   ESP32 → BACKEND
   WATER TANK + FLOW
   ============================================================ */

app.post('/api/water', (req, res) => {

  const {
    level_pct,
    used_l,
    flow_lpm,
    device_id
  } = req.body;

  const prev = db.latestWater();


  const hasLevel =
    typeof level_pct === 'number' &&
    !isNaN(level_pct);

  const finalLevel =
    hasLevel
      ? level_pct
      : (prev ? prev.level_pct : null);


  const hasUsed =
    typeof used_l === 'number' &&
    !isNaN(used_l);

  const finalUsed =
    hasUsed
      ? used_l
      : (prev ? prev.used_l : 0);


  const hasFlow =
    typeof flow_lpm === 'number' &&
    !isNaN(flow_lpm);

  const finalFlow =
    hasFlow
      ? flow_lpm
      : (prev ? prev.flow_lpm : 0);


  if (
    finalLevel == null &&
    !hasUsed &&
    !hasFlow
  ) {
    return res.status(400).json({
      error:
        'Valid level_pct, used_l, or flow_lpm is required'
    });
  }


  db.insertWater({

    level_pct:
      finalLevel != null
        ? finalLevel
        : 0,

    used_l: finalUsed,

    flow_lpm: finalFlow,

    device_id:
      device_id || 'esp32'
  });


  // Low water alert
  if (
    finalLevel != null &&
    finalLevel < 20 &&
    (!prev || prev.level_pct >= 20)
  ) {

    db.logActivity(
      'Alert',
      `LOW WATER: Tank level critical (${Math.round(finalLevel)}%)`
    );
  }


  res.status(201).json({

    ok: true,

    level_pct: finalLevel,

    used_l: finalUsed,

    flow_lpm: finalFlow
  });
});


/* ============================================================
   GET LIVE SYSTEM STATUS
   ============================================================ */

app.get('/api/status', (req, res) => {

  const reading =
    db.latestReading();

  const water =
    db.latestWater();

  const threshold =
    parseFloat(
      db.getSetting('threshold', '32')
    );

  const thiThresholds =
    db.getTHIThresholds();

  const operationDurations =
    db.getOperationDurations();


  /* ----------------------------------------------------------
     GET SCHEDULES FROM SQLITE DATABASE
     ---------------------------------------------------------- */

  const bathSchedules =
    db.listSchedules('bath');

  const cleanSchedules =
    db.listSchedules('clean');


  /* ----------------------------------------------------------
     SENSOR VALUES
     ---------------------------------------------------------- */

  const temp =
    reading
      ? reading.temp
      : null;

  const humidity =
    reading
      ? reading.humidity
      : null;

  const thi =
    reading
      ? reading.thi
      : null;


  /* ----------------------------------------------------------
     MALFUNCTION CHECKS
     ---------------------------------------------------------- */

  const malfunctions = [];

  const now =
    Date.now();


  if (
    reading &&
    reading.ts &&
    (now - reading.ts > 60000)
  ) {

    malfunctions.push({
      code: 'DHT_TIMEOUT',
      msg:
        'DHT22 Sensor communication timeout (>60s no data received)'
    });
  }


  if (
    temp != null &&
    (temp < 0 || temp > 60)
  ) {

    malfunctions.push({
      code: 'TEMP_OUT_OF_RANGE',
      msg:
        `DHT22 Temperature reading abnormal (${temp}°C)`
    });
  }


  if (
    humidity != null &&
    (humidity < 1 || humidity > 100)
  ) {

    malfunctions.push({
      code: 'HUM_OUT_OF_RANGE',
      msg:
        `DHT22 Humidity reading abnormal (${humidity}%)`
    });
  }


  if (
    water &&
    water.ts &&
    (now - water.ts > 120000)
  ) {

    malfunctions.push({
      code: 'WATER_TIMEOUT',
      msg:
        'Ultrasonic Tank Sensor communication timeout (>120s)'
    });
  }


  if (
    water &&
    (
      water.level_pct < 0 ||
      water.level_pct > 100
    )
  ) {

    malfunctions.push({
      code: 'WATER_OUT_OF_RANGE',
      msg:
        `Water tank sensor returned invalid level (${water.level_pct}%)`
    });
  }


  /* ----------------------------------------------------------
     CURRENT SYSTEM STATES
     ---------------------------------------------------------- */

  const diagnostics =
    db.latestDiagnostics();


  // Existing temperature-based misting
  const mistActive =
    temp != null
      ? temp > threshold
      : false;


  // DATABASE SCHEDULE STATUS
  const bathActive =
    bathSchedules.some(
      isScheduleActiveNow
    );


  const cleanActive =
    cleanSchedules.some(
      isScheduleActiveNow
    );


  // Overall pump state
  const pumpActive =
    relayState ||
    manualPumpActive ||
    mistActive ||
    bathActive ||
    cleanActive;


  /* ----------------------------------------------------------
     RETURN STATUS
     ---------------------------------------------------------- */

  res.json({

    temp,

    humidity,

    thi,

    thiStatus:
      thi != null
        ? thiLevel(
            thi,
            thiThresholds
          )
        : null,

    thiThresholds,

    operationDurations,

    malfunctions,

    diagnostics,

    waterLevel:
      water
        ? water.level_pct
        : null,

    waterUsed:
      water
        ? water.used_l
        : 0,

    flowRate:
      water
        ? water.flow_lpm
        : 0,


    /* IMPORTANT FOR ESP32 */

    mistActive,

    bathActive,

    cleanActive,

    pumpActive,


    relayState,

    manualPumpActive,

    lastPumpTest,

    threshold,

    lastReadingTs:
      reading
        ? reading.ts
        : null,

    lastWaterTs:
      water
        ? water.ts
        : null
  });
});


/* ============================================================
   READINGS HISTORY
   ============================================================ */

app.get('/api/readings/history', (req, res) => {

  const range =
    req.query.range || '24h';

  const ms = {

    '24h':
      24 * 3600e3,

    '7d':
      7 * 24 * 3600e3,

    '30d':
      30 * 24 * 3600e3

  }[range] || 24 * 3600e3;


  const rows =
    db.readingsSince(
      Date.now() - ms
    );


  res.json(
    rows.map(r => ({

      time:
        new Date(r.ts)
          .toTimeString()
          .slice(0, 5),

      ts: r.ts,

      temp: r.temp,

      humidity: r.humidity,

      thi: r.thi
    }))
  );
});


/* ============================================================
   WEEKLY WATER USAGE
   ============================================================ */

app.get('/api/water/weekly', (req, res) => {

  res.json(
    db.weeklyWaterUsage()
  );
});


/* ============================================================
   SCHEDULES
   ============================================================ */

/*
   GET BATHING / CLEANING SCHEDULES

   Example:

   /api/schedules?type=bath

   /api/schedules?type=clean
*/

app.get('/api/schedules', (req, res) => {

  const type =
    req.query.type;


  if (
    !['bath', 'clean']
      .includes(type)
  ) {

    return res.status(400).json({
      error:
        'type must be bath or clean'
    });
  }


  res.json(
    db.listSchedules(type)
  );
});


/*
   CREATE SCHEDULE

   Validates + normalizes time ("HH:MM"), duration (positive
   integer minutes), and days (accepts "Mon"/"monday"/"MON" etc,
   normalized to the canonical 3-letter form) before saving.
*/

app.post('/api/schedules', (req, res) => {

  const {
    type
  } = req.body;


  if (
    !['bath', 'clean']
      .includes(type)
  ) {

    return res.status(400).json({
      error:
        'type must be bath or clean'
    });
  }


  const parsed = parseScheduleInput(req.body);

  if (!parsed.ok) {
    return res.status(400).json({
      error: parsed.error
    });
  }


  const row =
    db.createSchedule({

      type,

      label: parsed.value.label,

      time: parsed.value.time,

      duration: parsed.value.duration,

      days: parsed.value.days
    });


  db.logActivity(
    type === 'bath' ? 'Bath' : 'Clean',
    `New ${type} schedule created: "${row.label}" at ${row.time} for ${row.duration} min on ${JSON.parse(row.days).join(', ')}`
  );


  res.status(201).json({

    ...row,

    days:
      JSON.parse(row.days),

    active:
      !!row.active
  });
});


/*
   UPDATE SCHEDULE (full edit)

   Accepts any subset of { label, time, duration, days, active }.
   Previously this route only toggled "active" and silently
   dropped time/duration/days edits — that's fixed here.
*/

app.patch('/api/schedules/:id', (req, res) => {

  const parsed = parseScheduleInput(req.body, { partial: true });

  if (!parsed.ok) {
    return res.status(400).json({
      error: parsed.error
    });
  }

  const row = db.updateSchedule(req.params.id, parsed.value);

  if (!row) {
    return res.status(404).json({
      error: 'Schedule not found'
    });
  }

  db.logActivity(
    row.type === 'bath' ? 'Bath' : 'Clean',
    `Schedule "${row.label}" updated: ${row.time}, ${row.duration} min, ${JSON.parse(row.days).join(', ')}, ${row.active ? 'enabled' : 'disabled'}`
  );

  res.json({

    ...row,

    days:
      JSON.parse(row.days),

    active:
      !!row.active
  });
});


/*
   DELETE SCHEDULE
*/

app.delete('/api/schedules/:id', (req, res) => {

  db.deleteSchedule(
    req.params.id
  );

  res.status(204).end();
});


/*
   DEBUG: see exactly why a schedule is/isn't matching right now.
   Hit this while a schedule's window should be active to check
   the server's current day/time and each schedule's evaluation.
*/

app.get('/api/schedules/debug', (req, res) => {

  const now = new Date();

  const today = DAY_NAMES[now.getDay()];

  const nowMin = now.getHours() * 60 + now.getMinutes();

  const annotate = (s) => ({
    id: s.id,
    label: s.label,
    time: s.time,
    duration: s.duration,
    days: s.days,
    active: s.active,
    isActiveNow: isScheduleActiveNow(s)
  });

  res.json({
    serverTime: now.toString(),
    serverTimezoneOffsetMinutes: now.getTimezoneOffset(),
    today,
    nowMin,
    bath: db.listSchedules('bath').map(annotate),
    clean: db.listSchedules('clean').map(annotate)
  });
});


/* ============================================================
   TEMPERATURE THRESHOLD
   ============================================================ */

app.get('/api/settings/threshold', (req, res) => {

  res.json({

    value:
      parseFloat(
        db.getSetting(
          'threshold',
          '32'
        )
      )
  });
});


app.post('/api/settings/threshold', (req, res) => {

  const {
    value
  } = req.body;


  if (
    typeof value !== 'number' ||
    value < 20 ||
    value > 50
  ) {

    return res.status(400).json({
      error:
        'value must be a number between 20 and 50'
    });
  }


  db.setSetting(
    'threshold',
    value
  );


  db.logActivity(
    'Info',
    `Mist cooling threshold updated to ${value}°C`
  );


  res.json({
    value
  });
});


/* ============================================================
   OPERATION DURATIONS
   ============================================================ */

app.get('/api/settings/durations', (req, res) => {

  res.json(
    db.getOperationDurations()
  );
});


app.post('/api/settings/durations', (req, res) => {

  const {
    mistDurationMin,
    mistPauseSec
  } = req.body;


  const updated =
    db.setOperationDurations({

      mistDurationMin:
        typeof mistDurationMin === 'number'
          ? mistDurationMin
          : undefined,

      mistPauseSec:
        typeof mistPauseSec === 'number'
          ? mistPauseSec
          : undefined
    });


  db.logActivity(
    'Info',
    `Operation durations updated: Misting ${updated.mistDurationMin} min ON / ${updated.mistPauseSec} s pause`
  );


  res.json(updated);
});


/* ============================================================
   THI THRESHOLDS
   ============================================================ */

app.get('/api/settings/thi', (req, res) => {

  res.json(
    db.getTHIThresholds()
  );
});


app.post('/api/settings/thi', (req, res) => {

  const {
    normalMax,
    stressMax,
    extremeMax
  } = req.body;


  const updated =
    db.setTHIThresholds({

      normalMax:
        typeof normalMax === 'number'
          ? normalMax
          : undefined,

      stressMax:
        typeof stressMax === 'number'
          ? stressMax
          : undefined,

      extremeMax:
        typeof extremeMax === 'number'
          ? extremeMax
          : undefined
    });


  db.logActivity(
    'Alert',
    `THI thresholds updated: Normal<${updated.normalMax}, Stress<=${updated.stressMax}, Extreme<=${updated.extremeMax}`
  );


  res.json(updated);
});


/* ============================================================
   SYSTEM REPORT CSV
   ============================================================ */

app.get('/api/reports/export', (req, res) => {

  const range =
    req.query.range || '24h';


  const ms = {

    '24h':
      24 * 3600e3,

    '7d':
      7 * 24 * 3600e3,

    '30d':
      30 * 24 * 3600e3

  }[range] || 24 * 3600e3;


  const rows =
    db.readingsSince(
      Date.now() - ms
    );


  const thiThresholds =
    db.getTHIThresholds();


  let csv =
    'Timestamp,DateTime,Temperature_C,Humidity_Pct,THI,THI_Status\r\n';


  rows.forEach(r => {

    const dt =
      new Date(r.ts)
        .toISOString();


    const status =
      thiLevel(
        r.thi,
        thiThresholds
      ).label;


    csv +=
      `${r.ts},"${dt}",${r.temp},${r.humidity},${r.thi},"${status}"\r\n`;
  });


  res.setHeader(
    'Content-Type',
    'text/csv'
  );


  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ios_system_report_${range}_${Date.now()}.csv"`
  );


  res.send(csv);
});


/* ============================================================
   ACTIVITY LOG
   ============================================================ */

app.get('/api/activity', (req, res) => {

  const limit =
    parseInt(
      req.query.limit
    ) || 30;


  res.json(
    db.recentActivity(limit)
  );
});


/* ============================================================
   RELAY & WATER PUMP CONTROL
   ============================================================ */

let relayState = false;

let manualPumpActive = false;

let lastPumpTest = null;

let pendingRelayCommand = null;


/* ------------------------------------------------------------
   RELAY TEST
   ------------------------------------------------------------ */

app.post('/api/relay/test', (req, res) => {

  const duration_ms =
    parseInt(
      req.body.duration_ms
    ) || 3000;


  pendingRelayCommand = {

    command: 'test_pump',

    duration_ms,

    ts: Date.now()
  };


  lastPumpTest = {

    ts: Date.now(),

    duration_ms,

    status: 'Testing'
  };


  relayState = true;


  db.logActivity(
    'Mist',
    `Relay module & water pump test triggered (${(duration_ms / 1000).toFixed(0)}s pulse)`
  );


  setTimeout(() => {

    relayState = false;

    if (
      lastPumpTest &&
      lastPumpTest.status === 'Testing'
    ) {

      lastPumpTest.status =
        'Completed';
    }

  }, duration_ms + 1000);


  res.json({

    ok: true,

    message:
      `Pump test command queued for ${duration_ms}ms`,

    lastPumpTest
  });
});


/* ------------------------------------------------------------
   MANUAL PUMP CONTROL
   ------------------------------------------------------------ */

app.post('/api/relay/control', (req, res) => {

  const active =
    !!req.body.active;


  manualPumpActive =
    active;


  relayState =
    active;


  pendingRelayCommand = {

    command:
      active
        ? 'pump_on'
        : 'pump_off',

    ts: Date.now()
  };


  db.logActivity(
    'Mist',
    `Water pump manual override switched ${active ? 'ON' : 'OFF'}`
  );


  res.json({

    ok: true,

    manualPumpActive,

    relayState
  });
});


/* ------------------------------------------------------------
   ESP32 CHECKS FOR RELAY COMMANDS
   ------------------------------------------------------------ */

app.get('/api/relay/command', (req, res) => {

  const cmd =
    pendingRelayCommand;


  // Command is consumed once
  pendingRelayCommand =
    null;


  res.json({

    command:
      cmd || null,

    manualPumpActive
  });
});


/* ------------------------------------------------------------
   ESP32 REPORTS RELAY STATUS
   ------------------------------------------------------------ */

app.post('/api/relay/status', (req, res) => {

  const {
    relay_on,
    test_completed,
    flow_pulses,
    flow_lpm
  } = req.body;


  if (
    typeof relay_on === 'boolean'
  ) {

    relayState =
      relay_on;
  }


  if (test_completed) {

    lastPumpTest = {

      ts: Date.now(),

      status: 'Passed',

      flow_pulses:
        flow_pulses || 0,

      flow_lpm:
        flow_lpm || 0
    };


    db.logActivity(
      'Info',
      `Pump test completed successfully. Flow: ${flow_lpm || 0} L/min (${flow_pulses || 0} pulses)`
    );
  }


  res.json({

    ok: true,

    relayState,

    lastPumpTest
  });
});


/* ============================================================
   ESP32 DIAGNOSTICS
   ============================================================ */

app.post('/api/diagnostics', (req, res) => {

  const {
    dht_ok,
    rtc_ok,
    tank_ok,
    flow_ok,
    relay_ok,
    details
  } = req.body;


  db.saveDiagnostics({

    dht_ok,

    rtc_ok,

    tank_ok,

    flow_ok,

    relay_ok,

    details
  });


  db.logActivity(
    'Info',
    `ESP32 completed hardware self-test: DHT:${dht_ok ? 'PASS' : 'FAIL'}, RTC:${rtc_ok ? 'PASS' : 'FAIL'}, Tank:${tank_ok ? 'PASS' : 'FAIL'}, Flow:${flow_ok ? 'PASS' : 'FAIL'}, Relay:${relay_ok ? 'PASS' : 'FAIL'}`
  );


  res.status(201).json({

    ok: true,

    diagnostics:
      db.latestDiagnostics()
  });
});


app.get('/api/diagnostics', (req, res) => {

  res.json(
    db.latestDiagnostics() || {
      ok: false,
      msg:
        'No diagnostics recorded yet'
    }
  );
});


/* ============================================================
   HEALTH CHECK
   ============================================================ */

app.get('/api/health', (req, res) => {

  res.json({

    ok: true,

    time: Date.now()
  });
});


/* ============================================================
   START SERVER
   ============================================================ */

app.listen(PORT, () => {

  console.log(
    `IoS backend listening on http://0.0.0.0:${PORT}`
  );

  console.log(
    `ESP32 should POST readings to http://<this-machine-ip>:${PORT}/api/readings`
  );
});