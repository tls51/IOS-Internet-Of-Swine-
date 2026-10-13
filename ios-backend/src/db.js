/* ============================================================
   db.js — SQLite schema & data-access layer
   Storage: local file ios.db (created automatically on first run)
   ============================================================ */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'ios.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ── Schema ─────────────────────────────────────────────── */
db.exec(`
CREATE TABLE IF NOT EXISTS readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,          -- unix ms
  temp      REAL NOT NULL,
  humidity  REAL NOT NULL,
  thi       REAL NOT NULL,
  device_id TEXT DEFAULT 'esp32-dht'
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS water_readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  level_pct REAL NOT NULL,             -- tank level %
  used_l    REAL NOT NULL,             -- cumulative liters used today
  flow_lpm  REAL NOT NULL,             -- instantaneous flow rate L/min
  device_id TEXT DEFAULT 'esp32-tank'
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
  synced_at   INTEGER NOT NULL          -- unix ms when backend received it
);
CREATE INDEX IF NOT EXISTS idx_offline_ts ON offline_readings(ts);
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

/* ── Seed defaults (only if empty) ─────────────────────────── */
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
function insertReading({ temp, humidity, thi, device_id, ts }) {
  const stmt = db.prepare(`INSERT INTO readings (ts,temp,humidity,thi,device_id) VALUES (?,?,?,?,?)`);
  return stmt.run(ts || Date.now(), temp, humidity, thi, device_id || 'esp32-dht');
}

function latestReading() {
  return db.prepare(`SELECT * FROM readings ORDER BY ts DESC LIMIT 1`).get();
}

function readingsSince(sinceMs) {
  return db.prepare(`SELECT * FROM readings WHERE ts >= ? ORDER BY ts ASC`).all(sinceMs);
}

/* ── Water ──────────────────────────────────────────────── */
function insertWater({ level_pct, used_l, flow_lpm, device_id, ts }) {
  const stmt = db.prepare(`INSERT INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id) VALUES (?,?,?,?,?)`);
  return stmt.run(ts || Date.now(), level_pct, used_l, flow_lpm, device_id || 'esp32-tank');
}

function latestWater() {
  return db.prepare(`SELECT * FROM water_readings ORDER BY ts DESC LIMIT 1`).get();
}

function weeklyWaterUsage() {
  // sum of used_l per day-of-week over the last 7 days
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`SELECT ts, used_l FROM water_readings WHERE ts >= ? ORDER BY ts ASC`).all(since);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const byDay = {};
  rows.forEach(r => {
    const d = days[new Date(r.ts).getDay()];
    byDay[d] = (byDay[d] || 0) + r.used_l;
  });
  const order = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return order.map(day => ({ day, mist: 0, bathe: 0, clean: 0, total: Math.round(byDay[day] || 0) }));
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
  const mistDurationMin = parseFloat(getSetting('mist_duration_min', '5'));
  const mistPauseSec    = parseFloat(getSetting('mist_pause_sec', '30'));
  return { mistDurationMin, mistPauseSec };
}

function setOperationDurations({ mistDurationMin, mistPauseSec }) {
  if (mistDurationMin != null) setSetting('mist_duration_min', mistDurationMin);
  if (mistPauseSec != null)    setSetting('mist_pause_sec', mistPauseSec);
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
function saveDiagnostics({ dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, details, ts }) {
  const stmt = db.prepare(`INSERT INTO sensor_diagnostics (ts, dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, details) VALUES (?,?,?,?,?,?,?)`);
  return stmt.run(ts || Date.now(), dht_ok ? 1 : 0, rtc_ok ? 1 : 0, tank_ok ? 1 : 0, flow_ok ? 1 : 0, relay_ok ? 1 : 0, typeof details === 'object' ? JSON.stringify(details) : String(details || ''));
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

function recentActivity(limit = 50) {
  return db.prepare(`
    SELECT * FROM activity_log
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit);
}

/* ── Offline Batch Readings ─────────────────────────────── */

// Insert a batch of offline readings, skipping duplicates by id.
// Returns { inserted, skipped, failed, accepted_ids }.
function insertOfflineBatch(records) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO offline_readings
      (id, ts, temp, humidity, thi, thi_label, water_level, flow_lpm, water_used, pump_on, pump_reason, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    let inserted = 0;
    let skipped  = 0;
    const accepted_ids = [];

    for (const r of rows) {
      if (!r.id || typeof r.id !== 'string') {
        skipped++;
        continue;
      }

      const ts = typeof r.ts_ms === 'number' ? r.ts_ms
               : typeof r.ts    === 'number' ? r.ts
               : null;

      if (ts === null) {
        skipped++;
        continue;
      }

      const temp        = typeof r.temp_c    === 'number' ? r.temp_c    : (typeof r.temp     === 'number' ? r.temp     : null);
      const humidity    = typeof r.humidity  === 'number' ? r.humidity  : null;
      const thi         = typeof r.thi       === 'number' ? r.thi       : null;
      const thi_label   = typeof r.thi_label === 'string' ? r.thi_label : null;
      const water_level = typeof r.water_level_pct === 'number' ? r.water_level_pct : (typeof r.water_level === 'number' ? r.water_level : null);
      const flow_lpm    = typeof r.flow_lpm  === 'number' ? r.flow_lpm  : null;
      const water_used  = typeof r.water_used_l === 'number' ? r.water_used_l : (typeof r.water_used === 'number' ? r.water_used : null);
      const pump_on     = r.pump_on != null ? (r.pump_on ? 1 : 0) : null;
      const pump_reason = typeof r.pump_reason === 'string' ? r.pump_reason : null;

      const info = stmt.run(
        r.id, ts, temp, humidity, thi, thi_label,
        water_level, flow_lpm, water_used, pump_on, pump_reason,
        Date.now()
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
          db.prepare(`INSERT OR IGNORE INTO readings (ts,temp,humidity,thi,device_id) VALUES (?,?,?,?,?)`)
            .run(ts, temp, humidity, thiVal, 'esp32-offline');
        }

        // Mirror water data if available
        if (water_level !== null || flow_lpm !== null || water_used !== null) {
          db.prepare(`INSERT OR IGNORE INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id) VALUES (?,?,?,?,?)`)
            .run(ts,
              water_level !== null ? water_level : 0,
              water_used  !== null ? water_used  : 0,
              flow_lpm    !== null ? flow_lpm    : 0,
              'esp32-offline');
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

module.exports = {
  db,
  insertReading, latestReading, readingsSince,
  insertWater, latestWater, weeklyWaterUsage,
  listSchedules, createSchedule, updateSchedule, toggleSchedule, deleteSchedule,
  getSetting, setSetting, getTHIThresholds, setTHIThresholds,
  getOperationDurations, setOperationDurations,
  logActivity, recentActivity,
  saveDiagnostics, latestDiagnostics,
  insertOfflineBatch, pendingOfflineCount, latestSyncTs,
};