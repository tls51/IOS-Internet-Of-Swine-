/* ============================================================
   db.js — SQLite schema & data-access layer
   Storage: local file ios.db (created automatically on first run)
   ============================================================ */

const path = require('path');
const crypto = require('crypto');
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
  token_hash   TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,          -- unix ms
  expires_at   INTEGER NOT NULL,          -- unix ms
  account_id   INTEGER,
  role         TEXT,
  display_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

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

/* ── Schema migration: Multi-Account (Phase 2) ─────────── */
(function migrateMultiAccount() {
  const tables = ['readings', 'water_readings', 'schedules', 'activity_log', 'sensor_diagnostics', 'offline_readings'];
  for (const t of tables) {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!tableInfo) continue;
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === 'account_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN account_id INTEGER DEFAULT 1;`);
      console.log(`[db] ${t} table migrated: added account_id column`);
    }
    db.prepare(`UPDATE ${t} SET account_id = 1 WHERE account_id IS NULL`).run();
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_readings_account ON readings(account_id);
    CREATE INDEX IF NOT EXISTS idx_water_account ON water_readings(account_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_account ON schedules(account_id);
    CREATE INDEX IF NOT EXISTS idx_activity_account ON activity_log(account_id);
    CREATE INDEX IF NOT EXISTS idx_offline_account ON offline_readings(account_id);
  `);

  // Settings table migration: compound (account_id, key) primary key
  const settingsCols = db.prepare("PRAGMA table_info(settings)").all();
  if (!settingsCols.some(c => c.name === 'account_id')) {
    db.exec(`
      BEGIN;
      ALTER TABLE settings RENAME TO _settings_old;
      CREATE TABLE settings (
        account_id INTEGER NOT NULL DEFAULT 1,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (account_id, key)
      );
      INSERT INTO settings (account_id, key, value)
        SELECT 1, key, value FROM _settings_old;
      DROP TABLE _settings_old;
      COMMIT;
    `);
    console.log('[db] settings table migrated: compound (account_id, key) primary key enabled');
  }

  // Device registry table
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_registry (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id    INTEGER NOT NULL,
      device_id     TEXT    NOT NULL,
      device_type   TEXT    NOT NULL DEFAULT 'sensor',
      pen_name      TEXT,
      device_token  TEXT    UNIQUE,
      registered_at INTEGER NOT NULL,
      UNIQUE (account_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_token ON device_registry(device_token);
    CREATE INDEX IF NOT EXISTS idx_device_account ON device_registry(account_id);
  `);

  // Phase 5: Sessions table migration (account_id, role, display_name)
  try {
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!sessionCols.includes('account_id')) {
      db.prepare('ALTER TABLE sessions ADD COLUMN account_id INTEGER').run();
    }
    if (!sessionCols.includes('role')) {
      db.prepare('ALTER TABLE sessions ADD COLUMN role TEXT').run();
    }
    if (!sessionCols.includes('display_name')) {
      db.prepare('ALTER TABLE sessions ADD COLUMN display_name TEXT').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id)').run();
  } catch (err) {
    console.warn('[db] Session column migration notice:', err.message);
  }
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

const seedUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (seedUsers.n === 0) {
  const adminUser = process.env.IOS_ADMIN_USER || 'admin';
  const adminPass = process.env.IOS_ADMIN_PASS || 'ios2024';
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(adminPass, salt, 32).toString('hex');
  db.prepare(`
    INSERT INTO users (username, password_hash, salt, role, display_name, created_at)
    VALUES (?, ?, ?, 'admin', 'Administrator', ?)
  `).run(adminUser, passwordHash, salt, Date.now());
  console.log(`[db] Initial admin user '${adminUser}' seeded.`);
}



function seedAccountDefaults(accountId) {
  if (!accountId) return;
  const defaults = [
    ['threshold', '32'],
    ['thi_normal_max', '74'],
    ['thi_stress_max', '78'],
    ['thi_extreme_max', '83'],
    ['mist_on_sec', '10'],
    ['mist_pause_sec', '5']
  ];
  const setStmt = db.prepare(`
    INSERT OR IGNORE INTO settings (account_id, key, value)
    VALUES (?, ?, ?)
  `);
  for (const [k, v] of defaults) {
    setStmt.run(accountId, k, v);
  }

  const schedCount = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE account_id = ?').get(accountId);
  if (schedCount.n === 0) {
    const insert = db.prepare('INSERT INTO schedules (account_id,type,label,time,duration,days,active) VALUES (?,?,?,?,?,?,?)');
    const all7 = JSON.stringify(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
    insert.run(accountId, 'bath', 'Morning Bath',   '06:00', 15, all7, 1);
    insert.run(accountId, 'bath', 'Afternoon Bath', '14:00', 15, all7, 1);
    insert.run(accountId, 'clean','Daily Flush',    '07:00', 10, all7, 1);
    insert.run(accountId, 'clean','Evening Clean',  '18:00', 10, JSON.stringify(['Mon','Wed','Fri']), 0);
  }
}

/* ── Readings ───────────────────────────────────────────── */
function insertReading({ temp, humidity, thi, device_id, ts, src_id, accountId = 1 }) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO readings (ts,temp,humidity,thi,device_id,src_id,account_id) VALUES (?,?,?,?,?,?,?)`);
  return stmt.run(ts || Date.now(), temp, humidity, thi, device_id || 'esp32-dht', src_id || null, accountId);
}

function latestReading(accountId = 1) {
  return db.prepare(`SELECT * FROM readings WHERE account_id = ? ORDER BY ts DESC LIMIT 1`).get(accountId);
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

function readingsSince(sinceMs, untilMs = Date.now(), accountId = 1) {
  return db.prepare(`SELECT * FROM readings WHERE account_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`).all(accountId, sinceMs, untilMs);
}

function rawReadingsIterator(sinceMs, untilMs = Date.now(), accountId = 1) {
  return db.prepare(`SELECT ts, temp, humidity, thi FROM readings WHERE account_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`).iterate(accountId, sinceMs, untilMs);
}

function getAggregatedReadings({ range = '24h', sinceMs, untilMs = Date.now(), bucketMs: explicitBucketMs, accountId = 1 } = {}) {
  let bucketMs = explicitBucketMs;
  let since = sinceMs;

  if (range === 'all') {
    if (since == null) since = 0;
    if (!bucketMs) {
      const bounds = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM readings WHERE account_id = ? AND ts >= ? AND ts <= ?').get(accountId, since, untilMs);
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
    WHERE account_id = ? AND ts >= ? AND ts <= ?
    GROUP BY b_idx
    ORDER BY b_idx ASC
  `;

  const rows = db.prepare(query).all(bucketMs, bucketMs, bucketMs, accountId, since, untilMs);

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

function reportSummary(accountId = 1) {
  const readingsRow = db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM readings WHERE account_id = ?').get(accountId);
  const offlineRow = db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM offline_readings WHERE account_id = ?').get(accountId);

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
function insertWater({ level_pct, used_l, flow_lpm, device_id, ts, mist_on, bath_on, clean_on, src_id, mist_l, bath_l, clean_l, other_l, accountId = 1 }) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id,mist_on,bath_on,clean_on,src_id,mist_l,bath_l,clean_l,other_l,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
    other_l != null ? other_l : 0,
    accountId
  );
}

function latestWater(accountId = 1) {
  return db.prepare(`SELECT * FROM water_readings WHERE account_id = ? ORDER BY ts DESC LIMIT 1`).get(accountId);
}

function latestTelemetry(accountId = 1) {
  const off = db.prepare(`SELECT ts, pump_on, pump_reason, mist_on, bath_on, clean_on FROM offline_readings WHERE account_id = ? ORDER BY ts DESC LIMIT 1`).get(accountId);
  const wat = db.prepare(`SELECT ts, mist_on, bath_on, clean_on FROM water_readings WHERE account_id = ? ORDER BY ts DESC LIMIT 1`).get(accountId);
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

function getTodayWaterUsage(accountId = 1) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dNow = new Date(Date.now() + MANILA_OFFSET_MS);
  const todayMidnightUtc = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), dNow.getUTCDate()) - MANILA_OFFSET_MS;
  const todayDateStr = `${dNow.getUTCFullYear()}-${String(dNow.getUTCMonth() + 1).padStart(2, '0')}-${String(dNow.getUTCDate()).padStart(2, '0')}`;

  const prevRow = db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(accountId, todayMidnightUtc);
  const rows = db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts >= ? ORDER BY ts ASC`).all(accountId, todayMidnightUtc);
  if (rows.length === 0) return 0;

  const allRows = prevRow ? [prevRow, ...rows] : rows;
  const days = usageByOperation(allRows);
  const todayEntry = days.find(d => d.date === todayDateStr);
  return todayEntry ? todayEntry.total : 0;
}

function weeklyWaterUsage(sinceMs, accountId = 1) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let refTs = Date.now();
  if (sinceMs !== undefined && typeof sinceMs === 'number') {
    const maxRow = db.prepare(`SELECT MAX(ts) AS max_ts FROM water_readings WHERE account_id = ?`).get(accountId);
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

  const prevRow = db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(accountId, querySince);
  const rows = db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts >= ? ORDER BY ts ASC`).all(accountId, querySince);
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

function getWaterUsage(range = '7d', accountId = 1) {
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
    sinceMs = 0;
  }

  const prevRow = sinceMs > 0
    ? db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(accountId, sinceMs)
    : null;
  const rows = db.prepare(`SELECT * FROM water_readings WHERE account_id = ? AND ts >= ? ORDER BY ts ASC`).all(accountId, sinceMs);
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
  const todayVal = todayEntry ? todayEntry.total : getTodayWaterUsage(accountId);
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
function listSchedules(type, accountId = 1) {
  if (type === 'all') {
    const rows = db.prepare(`SELECT * FROM schedules WHERE account_id = ? ORDER BY time ASC`).all(accountId);
    return rows.map(r => ({ ...r, days: JSON.parse(r.days), active: !!r.active }));
  }
  const rows = db.prepare(`SELECT * FROM schedules WHERE account_id = ? AND type = ? ORDER BY time ASC`).all(accountId, type);
  return rows.map(r => ({ ...r, days: JSON.parse(r.days), active: !!r.active }));
}

function createSchedule({ type, label, time, duration, days, accountId = 1 }) {
  const stmt = db.prepare(`INSERT INTO schedules (account_id,type,label,time,duration,days,active) VALUES (?,?,?,?,?,?,1)`);
  const info = stmt.run(accountId, type, label, time, duration, JSON.stringify(days));
  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(info.lastInsertRowid);
}

function updateSchedule(id, { label, time, duration, days, active }, accountId = null) {
  const existing = accountId != null
    ? db.prepare(`SELECT * FROM schedules WHERE id = ? AND account_id = ?`).get(id, accountId)
    : db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
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

function toggleSchedule(id, active, accountId = null) {
  if (accountId != null) {
    db.prepare(`UPDATE schedules SET active = ? WHERE id = ? AND account_id = ?`).run(active ? 1 : 0, id, accountId);
  } else {
    db.prepare(`UPDATE schedules SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  }
  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
}

function deleteSchedule(id, accountId = null) {
  if (accountId != null) {
    return db.prepare(`DELETE FROM schedules WHERE id = ? AND account_id = ?`).run(id, accountId);
  }
  return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}

function scheduleCount(accountId = 1) {
  return db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE account_id = ?`).get(accountId).n;
}

/* ── Settings ───────────────────────────────────────────── */
function getSetting(key, fallback, accountId = 1) {
  const row = db.prepare(`SELECT value FROM settings WHERE account_id = ? AND key = ?`).get(accountId, key);
  return row ? row.value : fallback;
}

function setSetting(key, value, accountId = 1) {
  db.prepare(`INSERT INTO settings (account_id,key,value) VALUES (?,?,?)
              ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`).run(accountId, key, String(value));
}

function getOperationDurations(accountId = 1) {
  const mistOnSec    = parseFloat(getSetting('mist_on_sec', '10', accountId));
  const mistPauseSec = parseFloat(getSetting('mist_pause_sec', '5', accountId));
  return { mistOnSec, mistPauseSec };
}

function setOperationDurations({ mistOnSec, mistPauseSec }, accountId = 1) {
  if (mistOnSec != null)    setSetting('mist_on_sec', mistOnSec, accountId);
  if (mistPauseSec != null) setSetting('mist_pause_sec', mistPauseSec, accountId);
  return getOperationDurations(accountId);
}

function getTHIThresholds(accountId = 1) {
  const normalMax  = parseFloat(getSetting('thi_normal_max',  '74', accountId));
  const stressMax  = parseFloat(getSetting('thi_stress_max',  '78', accountId));
  const extremeMax = parseFloat(getSetting('thi_extreme_max', '83', accountId));
  return { normalMax, stressMax, extremeMax };
}

function setTHIThresholds({ normalMax, stressMax, extremeMax }, accountId = 1) {
  if (normalMax != null)  setSetting('thi_normal_max',  normalMax, accountId);
  if (stressMax != null)  setSetting('thi_stress_max',  stressMax, accountId);
  if (extremeMax != null) setSetting('thi_extreme_max', extremeMax, accountId);
  return getTHIThresholds(accountId);
}

/* ── Diagnostics ────────────────────────────────────────── */
function saveDiagnostics({ dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, sd_ok, details, ts, accountId = 1 }) {
  const stmt = db.prepare(`INSERT INTO sensor_diagnostics (ts, dht_ok, rtc_ok, tank_ok, flow_ok, relay_ok, sd_ok, details, account_id) VALUES (?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    ts || Date.now(),
    dht_ok ? 1 : 0,
    rtc_ok ? 1 : 0,
    tank_ok ? 1 : 0,
    flow_ok ? 1 : 0,
    relay_ok ? 1 : 0,
    sd_ok === null || sd_ok === undefined ? null : (sd_ok ? 1 : 0),
    typeof details === 'object' ? JSON.stringify(details) : String(details || ''),
    accountId
  );
}

function latestDiagnostics(accountId = 1) {
  const row = db.prepare(`SELECT * FROM sensor_diagnostics WHERE account_id = ? ORDER BY ts DESC LIMIT 1`).get(accountId);
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

function logActivity(type, msg, ts, accountId = 1) {
  const stmt = db.prepare(`
    INSERT INTO activity_log (ts, type, msg, account_id)
    VALUES (?, ?, ?, ?)
  `);

  return stmt.run(
    ts || Date.now(),
    type,
    msg,
    accountId
  );
}

function recentActivity(limit = 50, sinceMs = 0, accountId = 1) {
  return db.prepare(`
    SELECT * FROM activity_log
    WHERE account_id = ? AND ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(accountId, sinceMs, limit);
}

/* ── Offline Batch Readings ─────────────────────────────── */

function insertOfflineBatch(records, accountId = 1) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO offline_readings
      (id, ts, temp, humidity, thi, thi_label, water_level, flow_lpm, water_used, pump_on, pump_reason, synced_at, source_ts_ms, rtc_valid, time_source, mist_on, bath_on, clean_on, mist_l, bath_l, clean_l, other_l, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

      const sourceTs = typeof r.ts_ms    === 'number' ? r.ts_ms
               : typeof r.ts       === 'number' ? r.ts
               : typeof r.uptime_ms === 'number' ? r.uptime_ms
               : null;
      const receivedAt = Date.now();
      const clockValid = r.rtc_valid !== false && Number.isFinite(sourceTs)
        && sourceTs >= Date.UTC(2024, 0, 1) && sourceTs <= receivedAt + 5 * 60e3;
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
        const existing = db.prepare(`SELECT id FROM offline_readings WHERE ts = ? AND account_id = ?`).get(ts, accountId);
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
        mist_l, bath_l, clean_l, other_l,
        accountId
      );

      if (info.changes > 0) {
        inserted++;
        accepted_ids.push(r.id);

        if (temp !== null && humidity !== null) {
          const calcTHI = (t, h) => parseFloat(
            (0.8 * t + (h / 100.0) * (t - 14.4) + 46.4).toFixed(1)
          );
          const thiVal = (thi !== null) ? thi : calcTHI(temp, humidity);
          db.prepare(`INSERT OR IGNORE INTO readings (ts,temp,humidity,thi,device_id,src_id,account_id) VALUES (?,?,?,?,?,?,?)`)
            .run(ts, temp, humidity, thiVal, 'esp32-offline', r.id, accountId);
        }

        if (water_level !== null || flow_lpm !== null || water_used !== null) {
          db.prepare(`INSERT OR IGNORE INTO water_readings (ts,level_pct,used_l,flow_lpm,device_id,mist_on,bath_on,clean_on,src_id,mist_l,bath_l,clean_l,other_l,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(ts,
              water_level !== null ? water_level : 0,
              water_used  !== null ? water_used  : 0,
              flow_lpm    !== null ? flow_lpm    : 0,
              'esp32-offline',
              mist_on, bath_on, clean_on, r.id,
              mist_l, bath_l, clean_l, other_l, accountId);
        }

      } else {
        skipped++;
        accepted_ids.push(r.id);
      }
    }

    return { inserted, skipped, accepted_ids };
  });

  try {
    const result = insertMany(records);
    if (result.inserted > 0) {
      logActivity('Sensor', `Batch sync: ${result.inserted} reading(s) saved (${result.skipped} skipped)`, null, accountId);
    }
    return { ...result, failed: 0 };
  } catch (err) {
    return { inserted: 0, skipped: 0, failed: records.length, accepted_ids: [], error: err.message };
  }
}

function pendingOfflineCount(accountId = 1) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM offline_readings WHERE account_id = ?`).get(accountId);
  return row ? row.n : 0;
}

function latestSyncTs(accountId = 1) {
  const row = db.prepare(`SELECT MAX(synced_at) AS ts FROM offline_readings WHERE account_id = ?`).get(accountId);
  return row ? row.ts : null;
}

/* ── Sessions (Persistent Auth) ────────────────────────────── */
function cleanupExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
}

function saveSession(tokenHash, username, createdAt, expiresAt, accountId = 1, role = 'admin', displayName = '') {
  cleanupExpiredSessions();
  db.prepare(`
    INSERT OR REPLACE INTO sessions (token_hash, username, created_at, expires_at, account_id, role, display_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tokenHash, username, createdAt, expiresAt, accountId, role, displayName);
}

function getSession(tokenHash) {
  const row = db.prepare(`
    SELECT token_hash, username, created_at, expires_at, account_id, role, display_name
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

function deleteSessionsByAccount(accountId) {
  if (!accountId) return;
  db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(accountId);
}


/* ── Users & Multi-Account (Phase 1) ─────────────────────── */
function createUser({ username, password, role = 'user', display_name = '' }) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) throw new Error('Username is required');
  if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const userRole = role === 'admin' ? 'admin' : 'user';
  const now = Date.now();
  const displayName = display_name ? String(display_name).trim() : cleanUsername;

  const stmt = db.prepare(`
    INSERT INTO users (username, password_hash, salt, role, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(cleanUsername, passwordHash, salt, userRole, displayName, now);
  seedAccountDefaults(info.lastInsertRowid);
  return {
    id: info.lastInsertRowid,
    username: cleanUsername,
    role: userRole,
    display_name: displayName,
    created_at: now
  };
}

function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(String(username).trim());
}

function getUserById(id) {
  if (!id) return null;
  return db.prepare(`SELECT id, username, role, display_name, created_at FROM users WHERE id = ?`).get(id);
}

function verifyUserPassword(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;

  try {
    const testHash = crypto.scryptSync(String(password || ''), user.salt, 32);
    const storedHash = Buffer.from(user.password_hash, 'hex');
    if (testHash.length === storedHash.length && crypto.timingSafeEqual(testHash, storedHash)) {
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: user.display_name
      };
    }
  } catch (_) {
    return null;
  }
  return null;
}

function updateUserPassword(id, newPassword) {
  if (!newPassword || String(newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(newPassword), salt, 32).toString('hex');
  const res = db.prepare(`
    UPDATE users SET password_hash = ?, salt = ? WHERE id = ?
  `).run(passwordHash, salt, id);
  return res.changes > 0;
}

function listUsers() {
  return db.prepare(`SELECT id, username, role, display_name, created_at FROM users ORDER BY id ASC`).all();
}

function deleteUser(id) {
  const res = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  return res.changes > 0;
}


/* ── Device Registry (Phase 3) ───────────────────────────── */
function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function registerDevice({ accountId = 1, deviceId, deviceType = 'sensor', penName = '' }) {
  const cleanDeviceId = String(deviceId || '').trim();
  if (!cleanDeviceId) throw new Error('deviceId is required');

  const rawToken = 'ios_dev_' + crypto.randomBytes(24).toString('hex');
  const tokenHash = hashDeviceToken(rawToken);
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO device_registry (account_id, device_id, device_type, pen_name, device_token, registered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, device_id) DO UPDATE SET
      device_type = excluded.device_type,
      pen_name = excluded.pen_name,
      device_token = excluded.device_token,
      registered_at = excluded.registered_at
  `);
  stmt.run(accountId, cleanDeviceId, String(deviceType || 'sensor').trim(), String(penName || '').trim(), tokenHash, now);

  const row = db.prepare(`SELECT id, account_id, device_id, device_type, pen_name, registered_at FROM device_registry WHERE account_id = ? AND device_id = ?`).get(accountId, cleanDeviceId);

  return {
    ...row,
    device_token: rawToken
  };
}

function getDeviceByToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashDeviceToken(rawToken);
  return db.prepare(`
    SELECT id, account_id, device_id, device_type, pen_name, registered_at
    FROM device_registry
    WHERE device_token = ?
  `).get(tokenHash);
}

function getDevicesByAccount(accountId = 1) {
  return db.prepare(`
    SELECT id, account_id, device_id, device_type, pen_name, registered_at
    FROM device_registry
    WHERE account_id = ?
    ORDER BY id ASC
  `).all(accountId);
}

function getDeviceById(id, accountId = null) {
  if (accountId != null) {
    return db.prepare(`
      SELECT id, account_id, device_id, device_type, pen_name, registered_at
      FROM device_registry
      WHERE id = ? AND account_id = ?
    `).get(id, accountId);
  }
  return db.prepare(`
    SELECT id, account_id, device_id, device_type, pen_name, registered_at
    FROM device_registry
    WHERE id = ?
  `).get(id);
}

function rotateDeviceToken(id, accountId = null) {
  const device = getDeviceById(id, accountId);
  if (!device) return null;

  const newRawToken = 'ios_dev_' + crypto.randomBytes(24).toString('hex');
  const tokenHash = hashDeviceToken(newRawToken);

  db.prepare(`UPDATE device_registry SET device_token = ? WHERE id = ?`).run(tokenHash, id);
  return {
    ...device,
    device_token: newRawToken
  };
}

function deleteDevice(id, accountId = null) {
  if (accountId != null) {
    const res = db.prepare(`DELETE FROM device_registry WHERE id = ? AND account_id = ?`).run(id, accountId);
    return res.changes > 0;
  }
  const res = db.prepare(`DELETE FROM device_registry WHERE id = ?`).run(id);
  return res.changes > 0;
}

module.exports = {
  createUser, getUserByUsername, getUserById, verifyUserPassword, updateUserPassword, listUsers, deleteUser,
  registerDevice, getDeviceByToken, getDevicesByAccount, getDeviceById, rotateDeviceToken, deleteDevice, seedAccountDefaults,
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
  saveSession, getSession, deleteSession, deleteSessionsByAccount, cleanupExpiredSessions,
  migrateRemoveMistSchedules,
};
