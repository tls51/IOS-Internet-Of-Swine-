/* ============================================================
   db.js — SQLite schema & data-access layer
   Storage: local file ios.db (created automatically on first run)
   ============================================================ */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.IOS_DB_PATH
  ? path.resolve(process.env.IOS_DB_PATH)
  : path.join(__dirname, '..', 'ios.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
console.log(`[db] Using database: ${DB_PATH}`);

/* ── Schema ─────────────────────────────────────────────── */
db.exec(`
CREATE TABLE IF NOT EXISTS readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,          -- unix ms
  temp      REAL NOT NULL,
  humidity  REAL NOT NULL,
  thi       REAL NOT NULL,
  device_id TEXT DEFAULT 'esp32-dht',
  src_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS water_readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  level_pct REAL NOT NULL,             -- tank level %
  used_l    REAL NOT NULL,             -- cumulative liters used today
  flow_lpm  REAL NOT NULL,             -- instantaneous flow rate L/min
  device_id TEXT DEFAULT 'esp32-tank',
  mist_on   INTEGER,
  bath_on   INTEGER,
  clean_on  INTEGER,
  src_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_water_ts ON water_readings(ts);

CREATE TABLE IF NOT EXISTS schedules (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT NOT NULL CHECK(type IN ('bath','clean','mist')),
  label    TEXT NOT NULL,
  time     TEXT NOT NULL,              -- 'HH:MM'
  duration INTEGER NOT NULL,           -- minutes
  days     TEXT NOT NULL,              -- JSON array e.g. ["Mon","Wed"]
  active   INTEGER NOT NULL DEFAULT 1  -- 0/1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- Mist | Bath | Clean | Alert | Info
  msg  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sensor_diagnostics (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  dht_ok   INTEGER,
  rtc_ok   INTEGER,
  tank_ok  INTEGER,
  flow_ok  INTEGER,
  relay_ok INTEGER,
  sd_ok    INTEGER,
  details  TEXT
);
CREATE TABLE IF NOT EXISTS offline_readings (
  id          TEXT PRIMARY KEY,        -- stable esp32-XXXXXXXX id from firmware
  ts          INTEGER NOT NULL,         -- original unix ms from RTC
  temp        REAL,
  humidity    REAL,
  thi         REAL,
  thi_label   TEXT,
  water_level REAL,
  flow_lpm    REAL,
  water_used  REAL,
  pump_on     INTEGER,
  pump_reason TEXT,
  mist_on     INTEGER,
  bath_on     INTEGER,
  clean_on    INTEGER,
  synced_at   INTEGER NOT NULL          -- unix ms when backend received it
);
CREATE INDEX IF NOT EXISTS idx_offline_ts ON offline_readings(ts);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,          -- unix ms
  expires_at INTEGER NOT NULL           -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

/* ── Schema migration: extend schedules.type to allow 'mist' ──────────────
   SQLite does not support ALTER COLUMN for CHECK constraints, so we detect
   the old table definition and recreate it if needed, preserving all rows.  */
(function migrateSchedulesType() {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'`
  ).get();
  if (!row) return; // table doesn't exist yet — nothing to migrate
  // Old constraint only listed 'bath','clean' — if 'mist' is absent, migrate.
  if (row.sql && row.sql.includes("'mist'")) return; // already up-to-date

  db.exec(`
    BEGIN;
    ALTER TABLE schedules RENAME TO _schedules_old;
    CREATE TABLE schedules (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      type     TEXT NOT NULL CHECK(type IN ('bath','clean','mist')),
      label    TEXT NOT NULL,
      time     TEXT NOT NULL,
      duration INTEGER NOT NULL,
      days     TEXT NOT NULL,
      active   INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO schedules SELECT * FROM _schedules_old;
    DROP TABLE _schedules_old;
    COMMIT;
  `);
  console.log('[db] schedules table migrated: type CHECK extended to include mist');
})();

/* ── Schema migration: remove legacy mist schedules ────────────────────── */
function migrateRemoveMistSchedules() {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'`
  ).get();
  if (!table) return 0;
  const deleted = db.prepare(`DELETE FROM schedules WHERE type = 'mist'`).run();
  if (deleted.changes > 0) {
    console.log(`[db] schedules table migrated: deleted ${deleted.changes} legacy mist schedule(s)`);
  }
  return deleted.changes;
}
migrateRemoveMistSchedules();

/* ── Schema migration: ensure sensor_diagnostics has sd_ok column ───────── */
(function migrateSensorDiagnostics() {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='sensor_diagnostics'`
  ).get();
  if (!table) return;
  const cols = db.prepare(`PRAGMA table_info(sensor_diagnostics)`).all();
  const hasSdOk = cols.some(c => c.name === 'sd_ok');
  if (!hasSdOk) {
    db.exec(`ALTER TABLE sensor_diagnostics ADD COLUMN sd_ok INTEGER;`);
    console.log('[db] sensor_diagnostics table migrated: added sd_ok column');
  }
})();

/* ── Schema migration: water_readings columns ──────────────────────────── */
(function migrateWaterReadings() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='water_readings'`).get();
  if (!table) return;
  const cols = db.prepare(`PRAGMA table_info(water_readings)`).all();
  for (const [name, type] of [
    ['mist_on', 'INTEGER'], ['bath_on', 'INTEGER'], ['clean_on', 'INTEGER'], ['src_id', 'TEXT'],
    ['mist_l', 'REAL DEFAULT 0'], ['bath_l', 'REAL DEFAULT 0'], ['clean_l', 'REAL DEFAULT 0'], ['other_l', 'REAL DEFAULT 0']
  ]) {
    if (!cols.some(c => c.name === name)) {
      db.exec(`ALTER TABLE water_readings ADD COLUMN ${name} ${type}`);
      console.log(`[db] water_readings table migrated: added ${name} column`);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_water_src_id ON water_readings(src_id) WHERE src_id IS NOT NULL;`);
})();

/* ── Schema migration: offline_readings relay columns ──────────────────── */
(function migrateOfflineReadings() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='offline_readings'`).get();
  if (!table) return;
  const cols = db.prepare(`PRAGMA table_info(offline_readings)`).all();
  for (const [name, type] of [
    ['mist_on', 'INTEGER'], ['bath_on', 'INTEGER'], ['clean_on', 'INTEGER'],
    ['mist_l', 'REAL DEFAULT 0'], ['bath_l', 'REAL DEFAULT 0'], ['clean_l', 'REAL DEFAULT 0'], ['other_l', 'REAL DEFAULT 0']
  ]) {
    if (!cols.some(c => c.name === name)) {
      db.exec(`ALTER TABLE offline_readings ADD COLUMN ${name} ${type}`);
      console.log(`[db] offline_readings table migrated: added ${name} column`);
    }
  }
})();

/* ── Schema migration: readings src_id column ─────────────────────────── */
(function migrateReadings() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='readings'`).get();
  if (!table) return;
  const cols = db.prepare(`PRAGMA table_info(readings)`).all();
  if (!cols.some(c => c.name === 'src_id')) {
    db.exec(`ALTER TABLE readings ADD COLUMN src_id TEXT`);
    console.log(`[db] readings table migrated: added src_id column`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_src_id ON readings(src_id) WHERE src_id IS NOT NULL;`);
})();

/* ── Schema migration: offline_readings ts index ───────────────────────── */
(function migrateOfflineIndex() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='offline_readings'`).get();
  if (!table) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_offline_ts ON offline_readings(ts);`);
})();

/* ── Seed defaults (only if empty) ─────────────────────────── */
// Preserve the original device time when an invalid RTC needs receipt-time dating.
const offlineCols = db.prepare('PRAGMA table_info(offline_readings)').all();
for (const [name, type] of [['source_ts_ms', 'INTEGER'], ['rtc_valid', 'INTEGER'], ['time_source', 'TEXT']]) {
  if (!offlineCols.some(c => c.name === name)) db.exec(`ALTER TABLE offline_readings ADD COLUMN ${name} ${type}`);
}

const seedSchedules = db.prepare(`SELECT COUNT(*) AS n FROM schedules`).get();
if (seedSchedules.n === 0) {
  const insert = db.prepare(`INSERT INTO schedules (type,label,time,duration,days,active) VALUES (?,?,?,?,?,?)`);
  const all7 = JSON.stringify(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
  insert.run('bath', 'Morning Bath',   '06:00', 15, all7, 1);
  insert.run('bath', 'Afternoon Bath', '14:00', 15, all7, 1);
  insert.run('clean','Daily Flush',    '07:00', 10, all7, 1);
  insert.run('clean','Evening Clean',  '18:00', 10, JSON.stringify(['Mon','Wed','Fri']), 0);
}

const seedSettings = db.prepare(`SELECT COUNT(*) AS n FROM settings`).get();
if (seedSettings.n === 0) {
  db.prepare(`INSERT INTO settings (key,value) VALUES ('threshold','32')`).run();
}

/* ── Readings ───────────────────────────────────────────── */
function insertReading({ temp, humidity, thi, device_id, ts, src_id }) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO readings (ts,temp,humidity,thi,device_id,src_id) VALUES (?,?,?,?,?,?)`);
  return stmt.run(ts || Date.now(), temp, humidity, thi, device_id || 'esp32-dht', src_id || null);
}

function latestReading() {
  return db.prepare(`SELECT * FROM readings ORDER BY ts DESC LIMIT 1`).get();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MANILA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatManilaBucketTime(tsMs) {
  const d = new Date(tsMs + MANILA_TZ_OFFSET_MS);
  const month = MONTH_NAMES[d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    time: `${hh}:${mm}`,
    label: `${month} ${day} ${hh}:${mm}`
  };
}

function readingsSince(sinceMs, untilMs = Date.now()) {
  return db.prepare(`SELECT * FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`).all(sinceMs, untilMs);
}

function rawReadingsIterator(sinceMs, untilMs = Date.now()) {
  return db.prepare(`SELECT ts, temp, humidity, thi FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`).iterate(sinceMs, untilMs);
}

function getAggregatedReadings({ range = '24h', sinceMs, untilMs = Date.now(), bucketMs: explicitBucketMs } = {}) {
  let bucketMs = explicitBucketMs;
  let since = sinceMs;

  if (range === 'all') {
    if (since == null) since = 0;
    if (!bucketMs) {
      const bounds = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM readings WHERE ts >= ? AND ts <= ?').get(since, untilMs);
      if (!bounds || bounds.minTs == null) return [];
      const spanMs = (bounds.maxTs || untilMs) - bounds.minTs;
      const rawBucket = Math.max(5 * 60 * 1000, Math.ceil(spanMs / 400));
      bucketMs = rawBucket > 3600000
        ? Math.ceil(rawBucket / 3600000) * 3600000
        : Math.ceil(rawBucket / 300000) * 300000;
    }
  } else {
    if (!bucketMs) {
      if (range === '7d') {
        bucketMs = 60 * 60 * 1000; // 1 hour
      } else if (range === '30d') {
        bucketMs = 6 * 60 * 60 * 1000; // 6 hours
      } else {
        bucketMs = 5 * 60 * 1000; // 5 min (24h default)
      }
    }
    if (since == null) {
      const rangeSpan = range === '7d' ? 7 * 24 * 3600e3 : (range === '30d' ? 30 * 24 * 3600e3 : 24 * 3600e3);
      since = untilMs - rangeSpan;
    }
  }

  const query = `
    SELECT
      CAST((ts + ${MANILA_TZ_OFFSET_MS}) / ? AS INTEGER) AS b_idx,
      CAST(CAST((ts + ${MANILA_TZ_OFFSET_MS}) / ? AS INTEGER) * ? - ${MANILA_TZ_OFFSET_MS} AS INTEGER) AS bucket_ts,
      AVG(temp) AS avg_temp,
      MIN(temp) AS min_temp,
      MAX(temp) AS max_temp,
      AVG(humidity) AS avg_hum,
      AVG(thi) AS avg_thi,
      MAX(thi) AS max_thi,
      COUNT(*) AS n
    FROM readings
    WHERE ts >= ? AND ts <= ?
    GROUP BY b_idx
    ORDER BY b_idx ASC
  `;

  const rows = db.prepare(query).all(bucketMs, bucketMs, bucketMs, since, untilMs);

  return rows.map(r => {
    const ts = r.bucket_ts;
    const { time, label } = formatManilaBucketTime(ts);
    return {
      ts,
      time,
      label,
      temp: r.avg_temp != null ? parseFloat(r.avg_temp.toFixed(1)) : null,
      humidity: r.avg_hum != null ? parseFloat(r.avg_hum.toFixed(1)) : null,
      thi: r.avg_thi != null ? parseFloat(r.avg_thi.toFixed(1)) : null,
      tempMin: r.min_temp != null ? parseFloat(r.min_temp.toFixed(1)) : null,
      tempMax: r.max_temp != null ? parseFloat(r.max_temp.toFixed(1)) : null,
      thiMax: r.max_thi != null ? parseFloat(r.max_thi.toFixed(1)) : null,
      n: r.n
    };
  });
}

function reportSummary() {
  const readingsRow = db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM readings').get();
  const offlineRow = db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM offline_readings').get();

  const count = readingsRow ? readingsRow.count : 0;
  const offlineCount = offlineRow ? offlineRow.count : 0;

  let firstTs = null;
  if (readingsRow && readingsRow.firstTs != null) {
    firstTs = readingsRow.firstTs;
    if (offlineRow && offlineRow.firstTs != null && offlineRow.firstTs < firstTs) {
      firstTs = offlineRow.firstTs;
    }
  } else if (offlineRow && offlineRow.firstTs != null) {
    firstTs = offlineRow.firstTs;
  }

  let lastTs = null;
  if (readingsRow && readingsRow.lastTs != null) {
    lastTs = readingsRow.lastTs;
    if (offlineRow && offlineRow.lastTs != null && offlineRow.lastTs > lastTs) {
      lastTs = offlineRow.lastTs;
    }
  } else if (offlineRow && offlineRow.lastTs != null) {
    lastTs = offlineRow.lastTs;
  }

  const spanMs = (firstTs != null && lastTs != null && lastTs > firstTs) ? (lastTs - firstTs) : 0;
  let allBucketMs = 5 * 60 * 1000;
  if (spanMs > 0) {
    const rawBucket = Math.max(5 * 60 * 1000, Math.ceil(spanMs / 400));
    allBucketMs = rawBucket > 3600000
      ? Math.ceil(rawBucket / 3600000) * 3600000
      : Math.ceil(rawBucket / 300000) * 300000;
  }

  const bucketMs = {
    '24h': 5 * 60 * 1000,
    '7d': 60 * 60 * 1000,
    '30d': 6 * 60 * 60 * 1000,
    'all': allBucketMs
  };

  return {
    count,
    counts: {
      readings: count,
      offline: offlineCount,
      total: count + offlineCount
    },
    readingsCount: count,
    offlineCount,
    firstTs,
    lastTs,
    bucketMs
  };
}

/* ── Water ──────────────────────────────────────────────── */
function insertWater({ level_pct, used_l, flow_lpm, device_id, ts, mist_on, bath_on, clean_on, src_id, mist_l, bath_l, clean_l, other_l }) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id,mist_on,bath_on,clean_on,src_id,mist_l,bath_l,clean_l,other_l) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    ts || Date.now(),
    level_pct != null ? level_pct : 0,
    used_l != null ? used_l : 0,
    flow_lpm != null ? flow_lpm : 0,
    device_id || 'esp32-tank',
    mist_on != null ? (mist_on ? 1 : 0) : null,
    bath_on != null ? (bath_on ? 1 : 0) : null,
    clean_on != null ? (clean_on ? 1 : 0) : null,
    src_id || null,
    mist_l != null ? mist_l : 0,
    bath_l != null ? bath_l : 0,
    clean_l != null ? clean_l : 0,
    other_l != null ? other_l : 0
  );
}

function latestWater() {
  return db.prepare(`SELECT * FROM water_readings ORDER BY ts DESC LIMIT 1`).get();
}

function latestTelemetry() {
  const off = db.prepare(`SELECT ts, pump_on, pump_reason, mist_on, bath_on, clean_on FROM offline_readings ORDER BY ts DESC LIMIT 1`).get();
  const wat = db.prepare(`SELECT ts, mist_on, bath_on, clean_on FROM water_readings ORDER BY ts DESC LIMIT 1`).get();
  if (!off && !wat) return null;
  if (off && (!wat || off.ts >= wat.ts)) return off;
  return wat;
}

function calculateWaterUsageForRows(rows) {
  if (!rows || rows.length === 0) return 0;
  let totalUsage = 0;
  let segMin = rows[0].used_l;
  let segMax = rows[0].used_l;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].used_l;
    const curr = rows[i].used_l;
    if (curr < prev) {
      // Counter reset on reboot: finalize previous segment and count curr as usage
      totalUsage += Math.max(0, segMax - segMin) + curr;
      segMin = curr;
      segMax = curr;
    } else {
      if (curr > segMax) segMax = curr;
      if (curr < segMin) segMin = curr;
    }
  }
  totalUsage += Math.max(0, segMax - segMin);
  return totalUsage;
}

function usageByOperation(rows) {
  if (!rows || rows.length === 0) return [];
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayMap = new Map();

  function getDayEntry(ts) {
    const d = new Date(ts + MANILA_OFFSET_MS);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const day = dayNames[d.getUTCDay()];
    let entry = dayMap.get(date);
    if (!entry) {
      entry = { date, day, mist: 0, bathe: 0, clean: 0, other: 0, total: 0 };
      dayMap.set(date, entry);
    }
    return entry;
  }

  sorted.forEach(r => getDayEntry(r.ts));

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].used_l != null ? sorted[i - 1].used_l : (sorted[i - 1].water_used != null ? sorted[i - 1].water_used : 0);
    const curr = sorted[i].used_l != null ? sorted[i].used_l : (sorted[i].water_used != null ? sorted[i].water_used : 0);

    let delta = 0;
    if (curr < prev) {
      delta = curr;
    } else {
      delta = curr - prev;
    }
    if (delta <= 0) continue;

    const row = sorted[i];
    const isManualOrTest = row.pump_reason === 'manual' || row.pump_reason === 'test';
    const isMist = !!(row.mist_on || (isManualOrTest && row.pump_on !== 0));
    const isBathe = !!row.bath_on;
    const isClean = !!row.clean_on;

    // Attribution priority rule: scheduled operations override auto-misting
    // clean > bath > mist > other
    let op = 'other';
    if (isClean) {
      op = 'clean';
    } else if (isBathe) {
      op = 'bathe';
    } else if (isMist) {
      op = 'mist';
    }

    const dayEntry = getDayEntry(row.ts);
    dayEntry[op] += delta;
    dayEntry.total += delta;
  }

  const result = [];
  for (const entry of dayMap.values()) {
    result.push({
      date: entry.date,
      day: entry.day,
      mist: parseFloat(entry.mist.toFixed(2)),
      bathe: parseFloat(entry.bathe.toFixed(2)),
      clean: parseFloat(entry.clean.toFixed(2)),
      other: parseFloat(entry.other.toFixed(2)),
      total: parseFloat(entry.total.toFixed(2)),
    });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}

function getTodayWaterUsage() {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dNow = new Date(Date.now() + MANILA_OFFSET_MS);
  const todayMidnightUtc = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), dNow.getUTCDate()) - MANILA_OFFSET_MS;
  const todayDateStr = `${dNow.getUTCFullYear()}-${String(dNow.getUTCMonth() + 1).padStart(2, '0')}-${String(dNow.getUTCDate()).padStart(2, '0')}`;

  const prevRow = db.prepare(`SELECT * FROM water_readings WHERE ts < ? ORDER BY ts DESC LIMIT 1`).get(todayMidnightUtc);
  const rows = db.prepare(`SELECT * FROM water_readings WHERE ts >= ? ORDER BY ts ASC`).all(todayMidnightUtc);
  if (rows.length === 0) return 0;

  const allRows = prevRow ? [prevRow, ...rows] : rows;
  const days = usageByOperation(allRows);
  const todayEntry = days.find(d => d.date === todayDateStr);
  return todayEntry ? todayEntry.total : 0;
}

function weeklyWaterUsage(sinceMs) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let refTs = Date.now();
  if (sinceMs !== undefined && typeof sinceMs === 'number') {
    const maxRow = db.prepare(`SELECT MAX(ts) AS max_ts FROM water_readings`).get();
    if (maxRow && maxRow.max_ts) {
      refTs = maxRow.max_ts;
    } else {
      refTs = sinceMs;
    }
  }

  const refD = new Date(refTs + MANILA_OFFSET_MS);
  const endMidnightUtc = Date.UTC(refD.getUTCFullYear(), refD.getUTCMonth(), refD.getUTCDate()) - MANILA_OFFSET_MS;
  const startMidnightUtc = endMidnightUtc - 6 * 24 * 60 * 60 * 1000;
  const querySince = (sinceMs !== undefined && typeof sinceMs === 'number')
    ? Math.min(sinceMs, startMidnightUtc)
    : startMidnightUtc;

  const prevRow = db.prepare(`SELECT * FROM water_readings WHERE ts < ? ORDER BY ts DESC LIMIT 1`).get(querySince);
  const rows = db.prepare(`SELECT * FROM water_readings WHERE ts >= ? ORDER BY ts ASC`).all(querySince);
  const allRows = prevRow ? [prevRow, ...rows] : rows;
  const computedDays = usageByOperation(allRows);
  const dayByDate = new Map(computedDays.map(d => [d.date, d]));

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const dayMidnight = endMidnightUtc - i * 24 * 60 * 60 * 1000;
    const d = new Date(dayMidnight + MANILA_OFFSET_MS);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const dayName = dayNames[d.getUTCDay()];

    const existing = dayByDate.get(dateStr);
    if (existing) {
      last7Days.push(existing);
    } else {
      last7Days.push({
        date: dateStr,
        day: dayName,
        mist: 0,
        bathe: 0,
        clean: 0,
        other: 0,
        total: 0
      });
    }
  }

  return last7Days;
}

function getWaterUsage(range = '7d') {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const now = Date.now();
  const dNow = new Date(now + MANILA_OFFSET_MS);
  const todayMidnightUtc = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), dNow.getUTCDate()) - MANILA_OFFSET_MS;
  const todayDateStr = `${dNow.getUTCFullYear()}-${String(dNow.getUTCMonth() + 1).padStart(2, '0')}-${String(dNow.getUTCDate()).padStart(2, '0')}`;

  let sinceMs = 0;
  let numDays = 0;

  if (range === '24h') {
    sinceMs = now - 24 * 60 * 60 * 1000;
  } else if (range === '7d') {
    numDays = 7;
    sinceMs = todayMidnightUtc - 6 * 24 * 60 * 60 * 1000;
  } else if (range === '30d') {
    numDays = 30;
    sinceMs = todayMidnightUtc - 29 * 24 * 60 * 60 * 1000;
  } else {
    // 'all'
    sinceMs = 0;
  }

  const prevRow = sinceMs > 0
    ? db.prepare(`SELECT * FROM water_readings WHERE ts < ? ORDER BY ts DESC LIMIT 1`).get(sinceMs)
    : null;
  const rows = db.prepare(`SELECT * FROM water_readings WHERE ts >= ? ORDER BY ts ASC`).all(sinceMs);
  const allRows = prevRow ? [prevRow, ...rows] : rows;
  const computedDays = usageByOperation(allRows);
  const dayByDate = new Map(computedDays.map(d => [d.date, d]));

  let days = [];
  if (numDays > 0) {
    for (let i = numDays - 1; i >= 0; i--) {
      const dayMidnight = todayMidnightUtc - i * 24 * 60 * 60 * 1000;
      const d = new Date(dayMidnight + MANILA_OFFSET_MS);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const dayName = dayNames[d.getUTCDay()];
      const existing = dayByDate.get(dateStr);
      if (existing) {
        days.push(existing);
      } else {
        days.push({
          date: dateStr,
          day: dayName,
          mist: 0,
          bathe: 0,
          clean: 0,
          other: 0,
          total: 0
        });
      }
    }
  } else {
    days = computedDays;
    if (days.length === 0) {
      days = [{
        date: todayDateStr,
        day: dayNames[dNow.getUTCDay()],
        mist: 0,
        bathe: 0,
        clean: 0,
        other: 0,
        total: 0
      }];
    }
  }

  const totals = {
    mist: parseFloat(days.reduce((s, d) => s + d.mist, 0).toFixed(2)),
    bathe: parseFloat(days.reduce((s, d) => s + d.bathe, 0).toFixed(2)),
    clean: parseFloat(days.reduce((s, d) => s + d.clean, 0).toFixed(2)),
    other: parseFloat(days.reduce((s, d) => s + d.other, 0).toFixed(2)),
    total: parseFloat(days.reduce((s, d) => s + d.total, 0).toFixed(2)),
  };

  const todayEntry = dayByDate.get(todayDateStr) || days.find(d => d.date === todayDateStr);
  const todayVal = todayEntry ? todayEntry.total : getTodayWaterUsage();
  const todayBreakdown = todayEntry || {
    date: todayDateStr,
    day: dayNames[dNow.getUTCDay()],
    mist: 0,
    bathe: 0,
    clean: 0,
    other: 0,
    total: 0
  };

  return {
    days,
    totals,
    today: parseFloat((todayVal || 0).toFixed(2)),
    todayBreakdown,
    source: 'sqlite'
  };
}

/* ── Schedules ──────────────────────────────────────────── */
function listSchedules(type) {
  const rows = db.prepare(`SELECT * FROM schedules WHERE type = ? ORDER BY time ASC`).all(type);
  return rows.map(r => ({ ...r, days: JSON.parse(r.days), active: !!r.active }));
}

function createSchedule({ type, label, time, duration, days }) {
  const stmt = db.prepare(`INSERT INTO schedules (type,label,time,duration,days,active) VALUES (?,?,?,?,?,1)`);
  const info = stmt.run(type, label, time, duration, JSON.stringify(days));
  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(info.lastInsertRowid);
}

// Full update — supports editing label/time/duration/days/active,
// not just toggling active like the old toggleSchedule-only flow did.
function updateSchedule(id, { label, time, duration, days, active }) {
  const existing = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
  if (!existing) return null;

  db.prepare(`
    UPDATE schedules
    SET label = ?, time = ?, duration = ?, days = ?, active = ?
    WHERE id = ?
  `).run(
    label !== undefined ? label : existing.label,
    time !== undefined ? time : existing.time,
    duration !== undefined ? duration : existing.duration,
    days !== undefined ? JSON.stringify(days) : existing.days,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    id
  );

  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
}

function toggleSchedule(id, active) {
  db.prepare(`UPDATE schedules SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
}

function deleteSchedule(id) {
  return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}

function scheduleCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM schedules`).get().n;
}

/* ── Settings ───────────────────────────────────────────── */
function getSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function getOperationDurations() {
  const mistOnSec    = parseFloat(getSetting('mist_on_sec', '10'));
  const mistPauseSec = parseFloat(getSetting('mist_pause_sec', '5'));
  return { mistOnSec, mistPauseSec };
}

function setOperationDurations({ mistOnSec, mistPauseSec }) {
  if (mistOnSec != null)    setSetting('mist_on_sec', mistOnSec);
  if (mistPauseSec != null) setSetting('mist_pause_sec', mistPauseSec);
  return getOperationDurations();
}

function getTHIThresholds() {
  const normalMax  = parseFloat(getSetting('thi_normal_max',  '74'));
  const stressMax  = parseFloat(getSetting('thi_stress_max',  '78'));
  const extremeMax = parseFloat(getSetting('thi_extreme_max', '83'));
  return { normalMax, stressMax, extremeMax };
}

function setTHIThresholds({ normalMax, stressMax, extremeMax }) {
  if (normalMax != null)  setSetting('thi_normal_max',  normalMax);
  if (stressMax != null)  setSetting('thi_stress_max',  stressMax);
  if (extremeMax != null) setSetting('thi_extreme_max', extremeMax);
  return getTHIThresholds();
}

/* ── Diagnostics ────────────────────────────────────────── */
function saveDiagnostics({ dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, sd_ok, details, ts }) {
  const stmt = db.prepare(`INSERT INTO sensor_diagnostics (ts, dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, sd_ok, details) VALUES (?,?,?,?,?,?,?,?)`);
  return stmt.run(
    ts || Date.now(),
    dht_ok ? 1 : 0,
    rtc_ok ? 1 : 0,
    tank_ok ? 1 : 0,
    flow_ok ? 1 : 0,
    relay_ok ? 1 : 0,
    sd_ok === null || sd_ok === undefined ? null : (sd_ok ? 1 : 0),
    typeof details === 'object' ? JSON.stringify(details) : String(details || '')
  );
}

function latestDiagnostics() {
  const row = db.prepare(`SELECT * FROM sensor_diagnostics ORDER BY ts DESC LIMIT 1`).get();
  if (!row) return null;
  let parsedDetails = {};
  try { parsedDetails = JSON.parse(row.details); } catch (e) { parsedDetails = { raw: row.details }; }
  return {
    ...row,
    dht_ok: !!row.dht_ok,
    rtc_ok: !!row.rtc_ok,
    tank_ok: !!row.tank_ok,
    flow_ok: !!row.flow_ok,
    relay_ok: !!row.relay_ok,
    sd_ok: row.sd_ok === null || row.sd_ok === undefined ? null : !!row.sd_ok,
    details: parsedDetails
  };
}

function logActivity(type, msg, ts) {
  const stmt = db.prepare(`
    INSERT INTO activity_log (ts, type, msg)
    VALUES (?, ?, ?)
  `);

  return stmt.run(
    ts || Date.now(),
    type,
    msg
  );
}

function recentActivity(limit = 50, sinceMs = 0) {
  return db.prepare(`
    SELECT * FROM activity_log
    WHERE ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(sinceMs, limit);
}

/* ── Offline Batch Readings ─────────────────────────────── */

// Insert a batch of offline readings, skipping duplicates by id.
// Returns { inserted, skipped, failed, accepted_ids }.
function insertOfflineBatch(records) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO offline_readings
      (id, ts, temp, humidity, thi, thi_label, water_level, flow_lpm, water_used, pump_on, pump_reason, synced_at, source_ts_ms, rtc_valid, time_source, mist_on, bath_on, clean_on, mist_l, bath_l, clean_l, other_l)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    let inserted = 0;
    let skipped  = 0;
    const accepted_ids = [];

    for (const r of rows) {
      if (!r || typeof r !== 'object' || !r.id || typeof r.id !== 'string') {
        skipped++;
        continue;
      }

      // Preserve the raw device timestamp separately. Unix dates are accepted
      // only with a plausible, valid RTC; uptime is dated by server receipt.
      const sourceTs = typeof r.ts_ms    === 'number' ? r.ts_ms
               : typeof r.ts       === 'number' ? r.ts
               : typeof r.uptime_ms === 'number' ? r.uptime_ms
               : null;
      const receivedAt = Date.now();
      const clockValid = r.rtc_valid !== false && Number.isFinite(sourceTs)
        && sourceTs >= Date.UTC(2024, 0, 1) && sourceTs <= receivedAt + 5 * 60e3;
      // millis() is uptime, never a Unix date. Keep it for diagnosis and date
      // unclocked readings by receipt time; exact offline capture time is unknown.
      const ts = clockValid ? sourceTs : receivedAt;

      const temp        = typeof r.temp_c    === 'number' ? r.temp_c    : (typeof r.temp     === 'number' ? r.temp     : null);
      const humidity    = typeof r.humidity  === 'number' ? r.humidity  : null;
      const thi         = typeof r.thi       === 'number' ? r.thi       : null;
      const thi_label   = typeof r.thi_label === 'string' ? r.thi_label : null;
      const water_level = typeof r.water_level_pct === 'number' ? r.water_level_pct : (typeof r.water_level === 'number' ? r.water_level : null);
      const flow_lpm    = typeof r.flow_lpm  === 'number' ? r.flow_lpm  : null;
      const water_used  = typeof r.water_used_l === 'number' ? r.water_used_l : (typeof r.water_used === 'number' ? r.water_used : null);
      const pump_on     = r.pump_on != null ? (r.pump_on ? 1 : 0) : null;
      const pump_reason = typeof r.pump_reason === 'string' ? r.pump_reason : null;
      const mist_on     = r.mist_on != null ? (r.mist_on ? 1 : 0) : null;
      const bath_on     = r.bath_on != null ? (r.bath_on ? 1 : 0) : null;
      const clean_on    = r.clean_on != null ? (r.clean_on ? 1 : 0) : null;
      const mist_l      = typeof r.mist_l === 'number' ? r.mist_l : (typeof r.mist_liters === 'number' ? r.mist_liters : 0);
      const bath_l      = typeof r.bath_l === 'number' ? r.bath_l : (typeof r.bath_liters === 'number' ? r.bath_liters : 0);
      const clean_l     = typeof r.clean_l === 'number' ? r.clean_l : (typeof r.clean_liters === 'number' ? r.clean_liters : 0);
      const other_l     = typeof r.other_l === 'number' ? r.other_l : (typeof r.other_liters === 'number' ? r.other_liters : 0);

      if (clockValid) {
        const existing = db.prepare(`SELECT id FROM offline_readings WHERE ts = ?`).get(ts);
        if (existing) {
          skipped++;
          accepted_ids.push(r.id);
          continue;
        }
      }

      const info = stmt.run(
        r.id, ts, temp, humidity, thi, thi_label,
        water_level, flow_lpm, water_used, pump_on, pump_reason,
        receivedAt, Number.isFinite(sourceTs) ? sourceTs : null,
        clockValid ? 1 : 0, clockValid ? 'device' : 'server_receipt',
        mist_on, bath_on, clean_on,
        mist_l, bath_l, clean_l, other_l
      );

      if (info.changes > 0) {
        inserted++;
        accepted_ids.push(r.id);

        // Also mirror into the main readings table if we have temp+humidity
        if (temp !== null && humidity !== null) {
          const calcTHI = (t, h) => parseFloat(
            (0.8 * t + (h / 100.0) * (t - 14.4) + 46.4).toFixed(1)
          );
          const thiVal = (thi !== null) ? thi : calcTHI(temp, humidity);
          db.prepare(`INSERT OR IGNORE INTO readings (ts,temp,humidity,thi,device_id,src_id) VALUES (?,?,?,?,?,?)`)
            .run(ts, temp, humidity, thiVal, 'esp32-offline', r.id);
        }

        // Mirror water data if available
        if (water_level !== null || flow_lpm !== null || water_used !== null) {
          db.prepare(`INSERT OR IGNORE INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id,mist_on,bath_on,clean_on,src_id,mist_l,bath_l,clean_l,other_l) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(ts,
              water_level !== null ? water_level : 0,
              water_used  !== null ? water_used  : 0,
              flow_lpm    !== null ? flow_lpm    : 0,
              'esp32-offline',
              mist_on, bath_on, clean_on, r.id,
              mist_l, bath_l, clean_l, other_l);
        }

      } else {
        // Record already exists in offline_readings (idempotent retransmission).
        // Still include in accepted_ids so client knows server has it and can advance progress.
        skipped++;
        accepted_ids.push(r.id);
      }
    }

    return { inserted, skipped, accepted_ids };
  });

  try {
    const result = insertMany(records);
    if (result.inserted > 0) {
      logActivity('Sensor', `Batch sync: ${result.inserted} reading(s) saved (${result.skipped} skipped)`);
    }
    return { ...result, failed: 0 };
  } catch (err) {
    return { inserted: 0, skipped: 0, failed: records.length, accepted_ids: [], error: err.message };
  }
}

function pendingOfflineCount() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM offline_readings`).get();
  return row ? row.n : 0;
}

function latestSyncTs() {
  const row = db.prepare(`SELECT MAX(synced_at) AS ts FROM offline_readings`).get();
  return row ? row.ts : null;
}

/* ── Sessions (Persistent Auth) ────────────────────────────── */
function cleanupExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
}

function saveSession(tokenHash, username, createdAt, expiresAt) {
  cleanupExpiredSessions();
  db.prepare(`
    INSERT OR REPLACE INTO sessions (token_hash, username, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, username, createdAt, expiresAt);
}

function getSession(tokenHash) {
  const row = db.prepare(`
    SELECT token_hash, username, created_at, expires_at
    FROM sessions
    WHERE token_hash = ?
  `).get(tokenHash);

  if (!row) return null;
  if (Date.now() > row.expires_at) {
    deleteSession(tokenHash);
    return null;
  }
  return row;
}

function deleteSession(tokenHash) {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

module.exports = {
  db,
  insertReading, latestReading, readingsSince, reportSummary,
  getAggregatedReadings, rawReadingsIterator,
  insertWater, latestWater, weeklyWaterUsage, calculateWaterUsageForRows,
  usageByOperation, getWaterUsage, getTodayWaterUsage, latestTelemetry,
  listSchedules, createSchedule, updateSchedule, toggleSchedule, deleteSchedule, scheduleCount,
  getSetting, setSetting, getTHIThresholds, setTHIThresholds,
  getOperationDurations, setOperationDurations,
  logActivity, recentActivity,
  saveDiagnostics, latestDiagnostics,
  insertOfflineBatch, pendingOfflineCount, latestSyncTs,
  saveSession, getSession, deleteSession, cleanupExpiredSessions,
  migrateRemoveMistSchedules,
};
