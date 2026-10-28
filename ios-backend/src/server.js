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
app.use(express.json({ limit: '256kb' }));
app.use(express.static(process.env.IOS_DASHBOARD_PATH || path.join(__dirname, '../../dashboard')));

const PORT = process.env.PORT || 3000;
// The barn and the firmware both use UTC+8, regardless of the laptop's timezone.
const BARN_TIMEZONE = 'Asia/Manila';
function barnTime(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BARN_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { day: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const REPORT_RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3, all: Infinity };
function reportSince(range = '24h') {
  return range === 'all' ? 0 : Date.now() - (REPORT_RANGES[range] || REPORT_RANGES['24h']);
}
const crypto = require('crypto');

const ADMIN_USER = process.env.IOS_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.IOS_ADMIN_PASS || 'ios2024';
const ADMIN_SALT = crypto.randomBytes(16);
const ADMIN_PASSWORD_HASH = crypto.scryptSync(ADMIN_PASSWORD, ADMIN_SALT, 32);

function verifyAdminCredentials(user, pass) {
  const userBuf = Buffer.from(String(user || ''));
  const adminUserBuf = Buffer.from(String(ADMIN_USER));
  const userMatch = userBuf.length === adminUserBuf.length && crypto.timingSafeEqual(userBuf, adminUserBuf);

  let passMatch = false;
  try {
    const passHash = crypto.scryptSync(String(pass || ''), ADMIN_SALT, 32);
    passMatch = crypto.timingSafeEqual(ADMIN_PASSWORD_HASH, passHash);
  } catch (_) {
    passMatch = false;
  }

  return userMatch && passMatch;
}
const AUTH_TOKEN = process.env.IOS_AUTH_TOKEN || 'ios-control-secret-token';
const SESSION_TTL_MS = 24 * 3600 * 1000; // 24 hours

let relayState = false;
let manualPumpActive = false;

/* Short-TTL status cache (PERF-01) */
let statusCache = {
  ts: 0,
  data: null
};
const STATUS_CACHE_TTL_MS = 2000;

function invalidateStatusCache() {
  statusCache.ts = 0;
  statusCache.data = null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(username = 'admin') {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const tokenHash = hashToken(token);
  db.saveSession(tokenHash, username, now, expiresAt);
  return { token, expiresIn: Math.floor(SESSION_TTL_MS / 1000) };
}

function isValidSession(token) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  const session = db.getSession(tokenHash);
  return !!session;
}

function destroySession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  db.deleteSession(tokenHash);
}

// Clean up expired sessions periodically
const sessionCleanupInterval = setInterval(() => {
  try { db.cleanupExpiredSessions(); } catch (_) {}
}, 3600 * 1000);
if (sessionCleanupInterval.unref) sessionCleanupInterval.unref();

function getSessionTokenFromReq(req) {
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)ios_session=([^;]+)/);
    if (match) return match[1];
  }
  if (req.headers['x-session-token']) {
    return req.headers['x-session-token'];
  }
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }
  if (req.headers.authorization) {
    const auth = req.headers.authorization;
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  }
  return null;
}

function isAuthorized(req) {
  const token = getSessionTokenFromReq(req);
  if (!token) return false;
  if (isValidSession(token)) return true;
  if (AUTH_TOKEN) {
    const tokenBuf = Buffer.from(String(token));
    const authBuf = Buffer.from(String(AUTH_TOKEN));
    if (tokenBuf.length === authBuf.length && crypto.timingSafeEqual(tokenBuf, authBuf)) {
      return true;
    }
  }
  return false;
}

function requireAuth(req, res, next) {
  if (isAuthorized(req)) {
    return next();
  }
  return res.status(401).json({
    ok: false,
    error: 'Unauthorized: Invalid or expired session'
  });
}

app.get('/api/info', (req, res) => res.json({ mode: 'cloud', authRequired: true, reports: 'sqlite' }));

app.post('/api/login', (req, res) => {
  const { username, password, user, pass } = req.body || {};
  const u = (username !== undefined ? username : user || '').trim();
  const p = (password !== undefined ? password : pass || '');

  if (verifyAdminCredentials(u, p)) {
    const { token, expiresIn } = createSession(u);
    res.setHeader('Set-Cookie', `ios_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}`);
    return res.json({ ok: true, token, expiresIn });
  }

  return res.status(401).json({
    ok: false,
    error: 'Invalid credentials'
  });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionTokenFromReq(req);
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', 'ios_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  if (isAuthorized(req)) {
    return res.json({ ok: true, authenticated: true });
  }
  return res.status(401).json({ ok: false, authenticated: false, error: 'Unauthorized: Invalid or expired session' });
});

app.post('/api/time', requireAuth, (req, res) => {
  const epoch = (req.body && req.body.epoch) || Math.floor(Date.now() / 1000);
  return res.json({ ok: true, epoch, rtcOk: true });
});

app.get('/api/reports/summary', requireAuth, (req, res) => res.json({ ...db.reportSummary(), source: 'sqlite', supportedRanges: Object.keys(REPORT_RANGES) }));


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

  if (thi < stressMax) {
    return {
      label: 'Stressful',
      cls: 'badge-warn',
      color: '#F59E0B'
    };
  }

  if (thi < extremeMax) {
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a schedule object' };
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
    if (!Number.isFinite(duration) || duration <= 0 || duration > 1440) {
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
  const local = barnTime(now);
  const today = local.day;

  // Current time in minutes
  const nowMin =
    local.minutes;

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
  const yesterday = DAY_NAMES[(DAY_NAMES.indexOf(today) + 6) % 7];

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
  if (thi >= thiThresholds.extremeMax) {

    db.logActivity(
      'Alert',
      `DANGER: THI ${thi} — immediate cooling required`
    );

  } else if (thi >= thiThresholds.stressMax) {

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
    device_id,
    mist_on,
    bath_on,
    clean_on,
    src_id,
    mist_l,
    bath_l,
    clean_l,
    other_l
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
      device_id || 'esp32',

    mist_on: mist_on != null ? (mist_on ? 1 : 0) : null,
    bath_on: bath_on != null ? (bath_on ? 1 : 0) : null,
    clean_on: clean_on != null ? (clean_on ? 1 : 0) : null,
    src_id: src_id || null,
    mist_l: typeof mist_l === 'number' ? mist_l : null,
    bath_l: typeof bath_l === 'number' ? bath_l : null,
    clean_l: typeof clean_l === 'number' ? clean_l : null,
    other_l: typeof other_l === 'number' ? other_l : null
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
  const now = Date.now();
  if (statusCache.data && (now - statusCache.ts < STATUS_CACHE_TTL_MS)) {
    return res.json(statusCache.data);
  }

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

  const sdDetails = (diagnostics && diagnostics.details && diagnostics.details.sd_info)
    ? diagnostics.details.sd_info
    : null;
  const sdStatus = (sdDetails && sdDetails.status)
    ? sdDetails.status
    : (diagnostics && diagnostics.sd_ok != null ? (diagnostics.sd_ok ? 'Ready' : 'Error') : 'Unknown');



  // DATABASE SCHEDULE STATUS
  const bathScheduled =
    bathSchedules.some(
      isScheduleActiveNow
    );

  const cleanScheduled =
    cleanSchedules.some(
      isScheduleActiveNow
    );

  // Latest telemetry flags if under 60 s old, otherwise unknown/false
  const telem = db.latestTelemetry ? db.latestTelemetry() : null;
  const isTelemFresh = !!(telem && telem.ts && (now - telem.ts <= 60000));

  const mistActive = isTelemFresh ? (telem.mist_on != null ? !!telem.mist_on : false) : false;
  const bathActive = isTelemFresh ? (telem.bath_on != null ? !!telem.bath_on : false) : false;
  const cleanActive = isTelemFresh ? (telem.clean_on != null ? !!telem.clean_on : false) : false;

  const waterOk = water && water.level_pct >= 20;

  const relays = {
    mist: {
      on: mistActive,
      scheduledNow: false,
      blockedReason: 'none'
    },
    bath: {
      on: bathActive,
      scheduledNow: bathScheduled,
      blockedReason: (!bathActive && bathScheduled) ? (!waterOk ? 'low_water' : (cleanActive ? 'preempted' : 'none')) : 'none'
    },
    clean: {
      on: cleanActive,
      scheduledNow: cleanScheduled,
      blockedReason: (!cleanActive && cleanScheduled) ? (!waterOk ? 'low_water' : (manualPumpActive ? 'preempted' : 'none')) : 'none'
    }
  };

  // Overall pump state
  const pumpActive =
    relayState ||
    manualPumpActive ||
    mistActive ||
    bathActive ||
    cleanActive ||
    (isTelemFresh && telem.pump_on != null ? !!telem.pump_on : false);

  const waterUsedToday = db.getTodayWaterUsage ? db.getTodayWaterUsage() : 0;
  const waterUsed = waterUsedToday;
  const waterUsedSinceBoot = water ? (water.used_l || 0) : 0;
  const waterUsage = db.getWaterUsage ? db.getWaterUsage('7d') : null;


  /* ----------------------------------------------------------
     RETURN STATUS
     ---------------------------------------------------------- */

  const statusPayload = {

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

    // MicroSD storage & sync fields consistent with ESP32 firmware
    sdStatus,
    sdError: sdDetails ? (sdDetails.lastError || '') : '',
    sdSpiFrequencyHz: sdDetails ? (sdDetails.spiFrequencyHz || 0) : 0,
    backendOnline: true,
    pendingOfflineCount: sdDetails ? (sdDetails.pendingCount ?? sdDetails.pendingOfflineCount ?? 0) : 0,
    syncedCount: db.pendingOfflineCount ? db.pendingOfflineCount() : (sdDetails ? (sdDetails.syncedCount || 0) : 0),
    lastSyncTs: db.latestSyncTs ? db.latestSyncTs() : (sdDetails ? (sdDetails.lastSyncTs || null) : null),
    syncInProgress: sdDetails ? !!sdDetails.syncInProgress : false,
    sd: sdDetails || {
      ok: diagnostics ? diagnostics.sd_ok : null,
      status: sdStatus,
      mounted: diagnostics && diagnostics.sd_ok != null ? !!diagnostics.sd_ok : null,
      lastError: sdDetails ? (sdDetails.lastError || '') : ''
    },

    waterLevel:
      water
        ? water.level_pct
        : null,

    waterUsedToday,

    waterUsed,

    waterUsedSinceBoot,

    waterUsage,

    flowRate:
      water
        ? water.flow_lpm
        : 0,


    /* IMPORTANT FOR ESP32 */

    mistActive,

    bathActive,

    cleanActive,

    bathScheduled,

    cleanScheduled,

    rtcTimeValid: true,

    relays,

    scheduleDiag: {
      lastPullOk: true,
      lastPullMs: Date.now(),
      lastError: 'none',
      backendCount: bathSchedules.length + cleanSchedules.length,
      localCount: 0
    },

    pumpActive,


    relayState,

    manualPumpActive,

    relayCommandStatus: lastRelayStatus,

    pendingRelayCommand,

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
  };

  statusCache.ts = Date.now();
  statusCache.data = statusPayload;
  res.json(statusPayload);
});


/* ============================================================
   READINGS HISTORY
   ============================================================ */

app.get('/api/readings/history', (req, res) => {

  const range =
    req.query.range || '24h';

  const until =
    req.query.until ? Number(req.query.until) : Date.now();

  const since =
    req.query.since ? Number(req.query.since) : (range === 'all' ? 0 : until - (REPORT_RANGES[range] || REPORT_RANGES['24h']));

  const points =
    db.getAggregatedReadings({
      range,
      sinceMs: since,
      untilMs: until
    });

  res.json(points);
});


/* ============================================================
   WATER USAGE & WEEKLY SUMMARY
   ============================================================ */

app.get('/api/water/usage', requireAuth, (req, res) => {
  const range = req.query.range || '7d';
  res.json(db.getWaterUsage(range));
});

app.get('/api/water/weekly', requireAuth, (req, res) => {

  res.json(
    db.weeklyWaterUsage()
  );
});

app.get('/api/water/breakdown', requireAuth, (req, res) => {
  const range = req.query.range || 'today';
  const validRanges = ['today', '7d', '30d'];
  if (!validRanges.includes(range)) {
    return res.status(400).json({ ok: false, error: `range must be one of: ${validRanges.join(', ')}` });
  }
  const dbRange = range === 'today' ? '24h' : range;
  const usage = db.getWaterUsage(dbRange);
  const totals = usage.totals || { mist: 0, bathe: 0, clean: 0, other: 0, total: 0 };
  if (range === 'today') {
    const todayEntry = usage.days && usage.days.length > 0
      ? usage.days[usage.days.length - 1]
      : { mist: 0, bathe: 0, clean: 0, other: 0, total: 0 };
    return res.json({
      ok: true,
      range,
      mist: todayEntry.mist,
      bathe: todayEntry.bathe,
      clean: todayEntry.clean,
      other: todayEntry.other,
      total: todayEntry.total
    });
  }
  res.json({
    ok: true,
    range,
    mist: totals.mist,
    bathe: totals.bathe,
    clean: totals.clean,
    other: totals.other,
    total: totals.total
  });
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

  // The ESP32 polls this snapshot and caches it for operation without Node.
  if (type === 'all') return res.json(['bath', 'clean'].flatMap(t => db.listSchedules(t)));


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

app.post('/api/schedules', requireAuth, (req, res) => {

  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Expected a schedule object' });

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

  if (db.scheduleCount() >= 20) {
    return res.status(409).json({ error: 'Maximum of 20 backend schedules reached. Delete an unused schedule first.' });
  }


  const row =
    db.createSchedule({

      type,

      label: parsed.value.label,

      time: parsed.value.time,

      duration: parsed.value.duration,

      days: parsed.value.days
    });


  const typeLabel = type === 'bath' ? 'Bath' : type === 'clean' ? 'Clean' : 'Mist';
  db.logActivity(
    typeLabel,
    `New ${type} schedule created: "${row.label}" at ${row.time} for ${row.duration} min on ${JSON.parse(row.days).join(', ')}`
  );

  invalidateStatusCache();

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

const handleUpdateSchedule = (req, res) => {
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

  invalidateStatusCache();
  res.json({
    ...row,
    days: JSON.parse(row.days),
    active: !!row.active
  });
};

app.patch('/api/schedules/:id', requireAuth, handleUpdateSchedule);
app.put('/api/schedules/:id', requireAuth, handleUpdateSchedule);


/*
   DELETE SCHEDULE
*/

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const result = db.deleteSchedule(req.params.id);
  if (!result || result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Schedule not found' });
  }
  invalidateStatusCache();
  res.status(204).end();
});


/*
   DEBUG: see exactly why a schedule is/isn't matching right now.
   Hit this while a schedule's window should be active to check
   the server's current day/time and each schedule's evaluation.
*/

app.get('/api/schedules/debug', (req, res) => {

  const now = new Date();

  const local = barnTime(now);
  const today = local.day;

  const nowMin = local.minutes;

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
    scheduleTimezone: BARN_TIMEZONE,
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


app.post('/api/settings/threshold', requireAuth, (req, res) => {

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

  invalidateStatusCache();

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


app.post('/api/settings/durations', requireAuth, (req, res) => {

  const {
    mistOnSec,
    mistPauseSec
  } = req.body;


  const updated =
    db.setOperationDurations({

      mistOnSec:
        typeof mistOnSec === 'number'
          ? mistOnSec
          : undefined,

      mistPauseSec:
        typeof mistPauseSec === 'number'
          ? mistPauseSec
          : undefined
    });


  db.logActivity(
    'Info',
    `Operation durations updated: Misting ${updated.mistOnSec} s ON / ${updated.mistPauseSec} s pause`
  );

  invalidateStatusCache();

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


app.post('/api/settings/thi', requireAuth, (req, res) => {

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

  invalidateStatusCache();

  res.json(updated);
});


/* ============================================================
   SYSTEM REPORT CSV
   ============================================================ */

app.get('/api/reports/export', requireAuth, (req, res) => {

  const type =
    req.query.type;

  const range =
    req.query.range || '24h';

  const until =
    req.query.until ? Number(req.query.until) : Date.now();

  const since =
    req.query.since ? Number(req.query.since) : (range === 'all' ? 0 : until - (REPORT_RANGES[range] || REPORT_RANGES['24h']));

  if (type === 'water') {
    const report = db.getWaterUsage(range);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ios_water_report_${range}_${Date.now()}.csv"`
    );
    res.write('Date,Day,Mist_L,Bathe_L,Clean_L,Other_L,Total_L\r\n');
    (report.days || []).forEach(d => {
      res.write(`"${d.date}","${d.day}",${d.mist},${d.bathe},${d.clean},${d.other},${d.total}\r\n`);
    });
    return res.end();
  }

  const resolution =
    req.query.resolution || (range === '24h' ? 'raw' : 'bucket');

  const thiThresholds =
    db.getTHIThresholds();

  res.setHeader(
    'Content-Type',
    'text/csv'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ios_system_report_${range}_${resolution}_${Date.now()}.csv"`
  );

  if (resolution === 'bucket') {
    const points = db.getAggregatedReadings({ range, sinceMs: since, untilMs: until });
    res.write('Timestamp,DateTime,Time,Label,Temperature_C,Temp_Min,Temp_Max,Humidity_Pct,THI,THI_Max,THI_Status,Readings_Count\r\n');
    for (const p of points) {
      const dt = new Date(p.ts).toISOString();
      const status = p.thi != null ? thiLevel(p.thi, thiThresholds).label : '—';
      res.write(`${p.ts},"${dt}","${p.time}","${p.label}",${p.temp},${p.tempMin},${p.tempMax},${p.humidity},${p.thi},${p.thiMax},"${status}",${p.n}\r\n`);
    }
    return res.end();
  }

  // resolution === 'raw'
  res.write('Timestamp,DateTime,Temperature_C,Humidity_Pct,THI,THI_Status\r\n');
  for (const r of db.rawReadingsIterator(since, until)) {
    const dt = new Date(r.ts).toISOString();
    const status = thiLevel(r.thi, thiThresholds).label;
    res.write(`${r.ts},"${dt}",${r.temp},${r.humidity},${r.thi},"${status}"\r\n`);
  }
  return res.end();
});


/* ============================================================
   ACTIVITY LOG
   ============================================================ */

app.get('/api/activity', (req, res) => {

  const limit =
    Math.min(500, Math.max(1, parseInt(
      req.query.limit
    ) || 30));


  res.json(
    db.recentActivity(limit, reportSince(req.query.range || 'all'))
  );
});


/* ============================================================
   RELAY & WATER PUMP CONTROL
   ============================================================ */

let lastPumpTest = null;

let pendingRelayCommand = null;
let lastRelayStatus = 'idle';


/* ------------------------------------------------------------
   RELAY TEST
   ------------------------------------------------------------ */

app.post('/api/relay/test', requireAuth, (req, res) => {

  const duration_ms =
    parseInt(
      req.body.duration_ms
    ) || 3000;


  pendingRelayCommand = {

    command: 'test_pump',

    duration_ms,

    ts: Date.now()
  };
  lastRelayStatus = 'queued';


  lastPumpTest = {

    ts: Date.now(),

    duration_ms,

    status: 'queued'
  };


  db.logActivity(
    'Mist',
    `Relay module & water pump test command queued (${(duration_ms / 1000).toFixed(0)}s pulse)`
  );


  res.json({

    ok: true,

    status: 'queued',

    message:
      `Pump test command queued for ${duration_ms}ms`,

    lastPumpTest,

    pendingRelayCommand
  });
});


/* ------------------------------------------------------------
   MANUAL PUMP CONTROL
   ------------------------------------------------------------ */

app.post('/api/relay/control', requireAuth, (req, res) => {

  const active =
    !!req.body.active;


  pendingRelayCommand = {

    command:
      active
        ? 'pump_on'
        : 'pump_off',

    ts: Date.now()
  };
  lastRelayStatus = 'queued';


  db.logActivity(
    'Mist',
    `Water pump manual override command queued: ${active ? 'ON' : 'OFF'}`
  );

  invalidateStatusCache();

  res.json({

    ok: true,

    status: 'queued',

    manualPumpActive,

    relayState,

    pendingRelayCommand
  });
});

app.post('/api/manual', requireAuth, (req, res) => {
  const active = req.body && req.body.active !== undefined ? !!req.body.active : true;
  pendingRelayCommand = {
    command: active ? 'pump_on' : 'pump_off',
    ts: Date.now()
  };
  lastRelayStatus = 'queued';
  db.logActivity(
    'Mist',
    `Water pump manual override command queued: ${active ? 'ON' : 'OFF'}`
  );
  res.json({
    ok: true,
    status: 'queued',
    manual: manualPumpActive,
    duration_ms: active ? 60000 : 0,
    max_run_ms: 300000,
    pendingRelayCommand
  });
});


/* ------------------------------------------------------------
   ESP32 CHECKS FOR RELAY COMMANDS
   ------------------------------------------------------------ */

app.get('/api/relay/command', (req, res) => {
  res.json({
    command: pendingRelayCommand || null,
    status: lastRelayStatus,
    manualPumpActive
  });
});


/* ------------------------------------------------------------
   ESP32 ACKNOWLEDGES RELAY COMMAND
   ------------------------------------------------------------ */

app.post('/api/relay/ack', requireAuth, (req, res) => {
  const { command, status, relay_on, pump_reason } = req.body || {};

  lastRelayStatus = status || (relay_on ? 'applied' : (pump_reason === 'low_water' ? 'blocked: low water' : 'applied'));

  if (typeof relay_on === 'boolean') {
    relayState = relay_on;
    manualPumpActive = relay_on;
  }

  if (lastRelayStatus === 'blocked: low water') {
    relayState = false;
    manualPumpActive = false;
    if (lastPumpTest && (lastPumpTest.status === 'Testing' || lastPumpTest.status === 'queued')) {
      lastPumpTest.status = 'Blocked: Low Water';
    }
  } else if (lastRelayStatus === 'applied') {
    if (lastPumpTest && lastPumpTest.status === 'queued') {
      lastPumpTest.status = 'Testing';
    }
  }

  pendingRelayCommand = null;

  db.logActivity(
    'Mist',
    `Relay command '${command || 'unknown'}' acknowledged: ${lastRelayStatus}`
  );

  res.json({
    ok: true,
    status: lastRelayStatus,
    relayState,
    manualPumpActive
  });
});


/* ------------------------------------------------------------
   RELAY STATUS (GET & POST)
   ------------------------------------------------------------ */

app.get('/api/relay/status', (req, res) => {
  res.json({
    ok: true,
    status: lastRelayStatus,
    relayState,
    manualPumpActive,
    lastPumpTest,
    pendingRelayCommand
  });
});

app.post('/api/relay/status', (req, res) => {

  const {
    relay_on,
    test_completed,
    flow_pulses,
    flow_lpm,
    status
  } = req.body;


  if (
    typeof relay_on === 'boolean'
  ) {

    relayState =
      relay_on;
    manualPumpActive =
      relay_on;
  }

  if (status) {
    lastRelayStatus = status;
    pendingRelayCommand = null;
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

    status: lastRelayStatus,

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
    sd_ok,
    details,
    ts
  } = req.body;


  db.saveDiagnostics({

    dht_ok,

    rtc_ok,

    tank_ok,

    flow_ok,

    relay_ok,

    sd_ok,

    details,

    ts
  });

  const sdStr = sd_ok === true ? 'PASS' : (sd_ok === false ? 'FAIL' : 'UNKNOWN');

  db.logActivity(
    'Info',
    `ESP32 hardware status update: DHT:${dht_ok ? 'PASS' : 'FAIL'}, RTC:${rtc_ok ? 'PASS' : 'FAIL'}, Tank:${tank_ok ? 'PASS' : 'FAIL'}, Flow:${flow_ok ? 'PASS' : 'FAIL'}, Relay:${relay_ok ? 'PASS' : 'FAIL'}, SD:${sdStr}`
  );


  res.status(201).json({

    ok: true,

    diagnostics:
      db.latestDiagnostics()
  });
});


app.get('/api/diagnostics', (req, res) => {
  const latest = db.latestDiagnostics();
  if (!latest) {
    return res.json({
      ok: false,
      msg: 'No diagnostics recorded yet'
    });
  }
  const sdDetails = (latest.details && latest.details.sd_info) ? latest.details.sd_info : null;
  res.json({
    ...latest,
    ok: true,
    sdStatus: (sdDetails && sdDetails.status) || (latest.sd_ok != null ? (latest.sd_ok ? 'Ready' : 'Error') : 'Unknown'),
    sdError: (sdDetails && sdDetails.lastError) || '',
    sd: sdDetails
  });
});


/* ============================================================
   MICROSD STATUS
   GET /api/sd/status
   Returns live/cached MicroSD status and details from diagnostics.
   ============================================================ */
app.get('/api/sd/status', (req, res) => {
  const diagnostics = db.latestDiagnostics();
  const sdDetails = (diagnostics && diagnostics.details && diagnostics.details.sd_info)
    ? diagnostics.details.sd_info
    : null;
  const sdStatus = (sdDetails && sdDetails.status)
    ? sdDetails.status
    : (diagnostics && diagnostics.sd_ok != null ? (diagnostics.sd_ok ? 'Ready' : 'Error') : 'Unknown');

  res.json({
    ok: true,
    sdStatus,
    mounted: sdDetails ? !!sdDetails.mounted : (diagnostics && diagnostics.sd_ok != null ? !!diagnostics.sd_ok : false),
    sdError: sdDetails ? (sdDetails.lastError || '') : '',
    sdSpiFrequencyHz: sdDetails ? (sdDetails.spiFrequencyHz || 0) : 0,
    backendOnline: true,
    pendingOfflineCount: sdDetails ? (sdDetails.pendingCount ?? sdDetails.pendingOfflineCount ?? 0) : 0,
    syncedCount: db.pendingOfflineCount ? db.pendingOfflineCount() : (sdDetails ? (sdDetails.syncedCount || 0) : 0),
    lastSyncTs: db.latestSyncTs ? db.latestSyncTs() : (sdDetails ? (sdDetails.lastSyncTs || 0) : 0),
    syncInProgress: sdDetails ? !!sdDetails.syncInProgress : false,
    cardType: sdDetails ? (sdDetails.cardType || 'Unavailable') : 'Unavailable',
    cardSizeBytes: sdDetails ? sdDetails.cardSizeBytes : null,
    totalBytes: sdDetails ? sdDetails.totalBytes : null,
    usedBytes: sdDetails ? sdDetails.usedBytes : null,
    availableBytes: sdDetails ? (sdDetails.availableBytes != null ? sdDetails.availableBytes : sdDetails.freeBytes) : null,
    freeBytes: sdDetails ? (sdDetails.freeBytes != null ? sdDetails.freeBytes : sdDetails.availableBytes) : null,
    csPin: sdDetails ? sdDetails.csPin : 10,
    mosiPin: sdDetails ? sdDetails.mosiPin : 11,
    sckPin: sdDetails ? sdDetails.sckPin : 12,
    misoPin: sdDetails ? sdDetails.misoPin : 13,
    logPath: sdDetails ? (sdDetails.logPath || '/ios/offline_readings.jsonl') : '/ios/offline_readings.jsonl',
    statusTs: (diagnostics && diagnostics.ts) || null,
    sd: sdDetails
  });
});


/* ============================================================
   OFFLINE READINGS BATCH SYNC
   POST /api/readings/batch
   Accepts an array of offline JSONL records from the ESP32 SD card.
   Uses INSERT OR IGNORE on stable ESP32-assigned IDs to prevent duplicates.
   Also mirrors accepted records into readings + water_readings tables
   so they appear in history charts.
   ============================================================ */

app.post('/api/readings/batch', (req, res) => {

  const records = req.body;

  if (!Array.isArray(records)) {
    return res.status(400).json({
      ok: false,
      error: 'Expected a JSON array of readings'
    });
  }

  if (records.length === 0) {
    return res.status(200).json({
      ok: true,
      inserted: 0,
      skipped: 0,
      failed: 0,
      accepted_ids: []
    });
  }

  if (records.length > 100) {
    return res.status(400).json({
      ok: false,
      error: 'Batch size exceeds maximum of 100 records'
    });
  }

  const result = db.insertOfflineBatch(records);

  if (result.failed > 0) return res.status(500).json({ ok: false, ...result });

  res.status(result.inserted > 0 ? 201 : 200).json({
    ok: true,
    inserted: result.inserted,
    skipped:  result.skipped,
    failed:   result.failed || 0,
    accepted_ids: result.accepted_ids
  });
});


/* ============================================================
   OFFLINE SYNC STATUS
   GET /api/offline/status
   Returns current pending count and last sync timestamp.
   ============================================================ */

app.get('/api/offline/status', (req, res) => {

  res.json({
    ok:           true,
    totalSynced:  db.pendingOfflineCount(),
    lastSyncTs:   db.latestSyncTs()
  });
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

// Return JSON errors so the dashboard can show the actual save failure.
app.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Database operation failed' });
});


/* ============================================================
   START SERVER
   ============================================================ */

app.listen(PORT, () => {
  if (!process.env.IOS_ADMIN_PASS) {
    console.warn('[SECURITY WARNING] IOS_ADMIN_PASS environment variable is not set! Using fallback credentials. Set IOS_ADMIN_PASS in production.');
  }

  console.log(
    `IoS backend listening on http://0.0.0.0:${PORT}`
  );

  console.log(
    `ESP32 should POST readings to http://<this-machine-ip>:${PORT}/api/readings`
  );
});
