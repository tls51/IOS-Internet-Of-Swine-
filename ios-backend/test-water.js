const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Use an isolated temporary database for water testing
const TEST_DB = path.join(__dirname, 'test-water.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const WAL_FILE = `${TEST_DB}-wal`;
const SHM_FILE = `${TEST_DB}-shm`;
if (fs.existsSync(WAL_FILE)) fs.unlinkSync(WAL_FILE);
if (fs.existsSync(SHM_FILE)) fs.unlinkSync(SHM_FILE);

process.env.IOS_DB_PATH = TEST_DB;

const {
  db,
  insertWater,
  weeklyWaterUsage,
  calculateWaterUsageForRows,
  usageByOperation,
  insertOfflineBatch,
  getWaterUsage,
  getTodayWaterUsage
} = require('./src/db');

console.log('=== Running Water Usage Unit Tests ===\n');

try {
  // Test 1: 500 rows monotonic cumulative data (0 to 10 L)
  console.log('Test 1: 500 rows cumulative data (0 to 10 L)');
  db.exec('DELETE FROM water_readings');

  // Base timestamp: Wednesday 12:00:00 Manila time (UTC+8)
  // 2026-10-21 12:00:00 Manila = 2026-10-21 04:00:00 UTC
  const manilaWedNoonUtcMs = Date.UTC(2026, 9, 21, 4, 0, 0);

  const rows500 = [];
  for (let i = 0; i < 500; i++) {
    const ts = manilaWedNoonUtcMs + i * 1000; // 1 second intervals
    const used_l = (i / 499) * 10;           // 0.0 to 10.0 L
    rows500.push({ ts, used_l });
    insertWater({ level_pct: 80, used_l, flow_lpm: 1.5, ts });
  }

  // Pure function verification
  const calc1 = calculateWaterUsageForRows(rows500);
  assert(Math.abs(calc1 - 10) < 0.001, `Expected 10 L, got ${calc1}`);

  // DB weeklyWaterUsage verification
  const weekly1 = weeklyWaterUsage(manilaWedNoonUtcMs - 3600 * 1000);
  const wedEntry1 = weekly1.find(d => d.day === 'Wed');
  assert(wedEntry1, 'Expected Wed entry');
  assert.strictEqual(wedEntry1.total, 10, `Expected Wed total to be 10 L, got ${wedEntry1.total}`);

  const totalSum1 = weekly1.reduce((sum, d) => sum + d.total, 0);
  assert.strictEqual(totalSum1, 10, `Expected total across week to be 10 L, got ${totalSum1} (not inflated)`);
  console.log('PASS: 500 rows yielded 10 L (not inflated ~2,500 L)\n');


  // Test 2: 500 rows with a mid-day reboot reset (0 -> 5 L, reset to 0 -> 5 L)
  console.log('Test 2: 500 rows with a mid-day reset');
  db.exec('DELETE FROM water_readings');

  const rowsReset = [];
  for (let i = 0; i < 500; i++) {
    const ts = manilaWedNoonUtcMs + i * 1000;
    let used_l;
    if (i < 250) {
      used_l = (i / 249) * 5; // 0 to 5 L
    } else {
      used_l = ((i - 250) / 249) * 5; // reboot reset back to 0, rises to 5 L
    }
    rowsReset.push({ ts, used_l });
    insertWater({ level_pct: 75, used_l, flow_lpm: 1.2, ts });
  }

  const calc2 = calculateWaterUsageForRows(rowsReset);
  assert(Math.abs(calc2 - 10) < 0.001, `Expected 10 L after reset, got ${calc2}`);

  const weekly2 = weeklyWaterUsage(manilaWedNoonUtcMs - 3600 * 1000);
  const wedEntry2 = weekly2.find(d => d.day === 'Wed');
  assert.strictEqual(wedEntry2.total, 10, `Expected Wed total to be 10 L, got ${wedEntry2.total}`);

  const totalSum2 = weekly2.reduce((sum, d) => sum + d.total, 0);
  assert.strictEqual(totalSum2, 10, `Expected weekly sum to be 10 L, got ${totalSum2}`);
  console.log('PASS: 500 rows with mid-day reset yielded 10 L\n');


  // Test 3: 500 rows spanning midnight in Asia/Manila (UTC+8)
  console.log('Test 3: 500 rows spanning midnight in Asia/Manila (UTC+8)');
  db.exec('DELETE FROM water_readings');

  // Manila midnight between Tuesday Oct 20 and Wednesday Oct 21:
  // 2026-10-21 00:00:00 UTC+8 = 2026-10-20 16:00:00 UTC
  const manilaMidnightUtcMs = Date.UTC(2026, 9, 20, 16, 0, 0);

  // 250 rows before midnight (Tuesday): 0 to 6 L
  // 250 rows after midnight (Wednesday): 6 to 10 L (continuous counter)
  for (let i = 0; i < 250; i++) {
    // 250 seconds before midnight
    const ts = manilaMidnightUtcMs - (250 - i) * 1000;
    const used_l = (i / 249) * 6; // 0 to 6 L
    insertWater({ level_pct: 70, used_l, flow_lpm: 1.0, ts });
  }

  for (let i = 0; i < 250; i++) {
    // At and after midnight
    const ts = manilaMidnightUtcMs + i * 1000;
    const used_l = 6 + (i / 249) * 4; // 6 to 10 L
    insertWater({ level_pct: 65, used_l, flow_lpm: 1.0, ts });
  }

  // Query weekly usage starting before the midnight window
  const weekly3 = weeklyWaterUsage(manilaMidnightUtcMs - 3600 * 1000);
  const tueEntry = weekly3.find(d => d.day === 'Tue');
  const wedEntry = weekly3.find(d => d.day === 'Wed');

  assert(tueEntry, 'Expected Tue entry');
  assert(wedEntry, 'Expected Wed entry');
  assert.strictEqual(tueEntry.total, 6, `Expected Tue total to be 6 L, got ${tueEntry.total}`);
  assert.strictEqual(wedEntry.total, 4, `Expected Wed total to be 4 L, got ${wedEntry.total}`);

  const totalSum3 = weekly3.reduce((sum, d) => sum + d.total, 0);
  assert.strictEqual(totalSum3, 10, `Expected total across midnight to be 10 L, got ${totalSum3}`);
  console.log('PASS: 500 rows spanning Manila midnight yielded 6 L on Tue, 4 L on Wed (Total: 10 L)\n');


  // Test 4: usageByOperation per-operation attribution with scheduled overriding auto-mist
  console.log('Test 4: usageByOperation per-operation attribution (priority: clean > bath > mist > other)');
  const baseTs = manilaWedNoonUtcMs;
  const testRowsAttr = [
    { ts: baseTs,        used_l: 0 },
    { ts: baseTs + 1000, used_l: 2, mist_on: 1 },                      // delta 2 -> mist 2.0
    { ts: baseTs + 2000, used_l: 5, bath_on: 1 },                      // delta 3 -> bathe 3.0
    { ts: baseTs + 3000, used_l: 9, clean_on: 1 },                     // delta 4 -> clean 4.0
    { ts: baseTs + 4000, used_l: 11, mist_on: 1, bath_on: 1 },         // delta 2 -> scheduled bath overrides auto mist: bathe 2.0
    { ts: baseTs + 5000, used_l: 13, pump_reason: 'manual' },          // delta 2 -> mist 2.0 (manual override)
    { ts: baseTs + 6000, used_l: 14 }                                  // delta 1 -> other 1.0
  ];
  const usageRes4 = usageByOperation(testRowsAttr);
  assert(usageRes4.length === 1, 'Expected 1 day result');
  const day4 = usageRes4[0];
  assert.strictEqual(day4.mist, 4.0, `Expected mist 4.0, got ${day4.mist}`);
  assert.strictEqual(day4.bathe, 5.0, `Expected bathe 5.0, got ${day4.bathe}`);
  assert.strictEqual(day4.clean, 4.0, `Expected clean 4.0, got ${day4.clean}`);
  assert.strictEqual(day4.other, 1.0, `Expected other 1.0, got ${day4.other}`);
  assert.strictEqual(day4.total, 14.0, `Expected total 14.0, got ${day4.total}`);
  console.log('PASS: usageByOperation correctly attributes mist, bathe, clean, override priority, manual, and other\n');


  // Test 5: usageByOperation counter reset (reboot: curr < prev)
  console.log('Test 5: usageByOperation counter reset');
  const testRowsReset = [
    { ts: baseTs,        used_l: 10 },
    { ts: baseTs + 1000, used_l: 14, mist_on: 1 },                     // delta 4 -> mist 4.0
    { ts: baseTs + 2000, used_l: 3, bath_on: 1 },                      // reset! delta 3 -> bathe 3.0
    { ts: baseTs + 3000, used_l: 5, bath_on: 1 }                       // delta 2 -> bathe 2.0
  ];
  const usageRes5 = usageByOperation(testRowsReset);
  const day5 = usageRes5[0];
  assert.strictEqual(day5.mist, 4.0, `Expected mist 4.0, got ${day5.mist}`);
  assert.strictEqual(day5.bathe, 5.0, `Expected bathe 5.0, got ${day5.bathe}`);
  assert.strictEqual(day5.total, 9.0, `Expected total 9.0, got ${day5.total}`);
  console.log('PASS: usageByOperation handles counter reset on reboot correctly\n');


  // Test 6: usageByOperation midnight crossing
  console.log('Test 6: usageByOperation midnight crossing in Asia/Manila');
  const testRowsMidnight = [
    { ts: manilaMidnightUtcMs - 2000, used_l: 10 },
    { ts: manilaMidnightUtcMs - 1000, used_l: 15, mist_on: 1 },         // Tue: delta 5 -> mist 5.0
    { ts: manilaMidnightUtcMs + 1000, used_l: 18, clean_on: 1 },        // Wed: delta 3 -> clean 3.0
    { ts: manilaMidnightUtcMs + 2000, used_l: 20, clean_on: 1 }         // Wed: delta 2 -> clean 2.0
  ];
  const usageRes6 = usageByOperation(testRowsMidnight);
  assert.strictEqual(usageRes6.length, 2, 'Expected 2 days for midnight crossing');
  const tueDay6 = usageRes6.find(d => d.day === 'Tue');
  const wedDay6 = usageRes6.find(d => d.day === 'Wed');
  assert(tueDay6, 'Expected Tue entry');
  assert(wedDay6, 'Expected Wed entry');
  assert.strictEqual(tueDay6.mist, 5.0, `Expected Tue mist 5.0, got ${tueDay6.mist}`);
  assert.strictEqual(tueDay6.total, 5.0, `Expected Tue total 5.0, got ${tueDay6.total}`);
  assert.strictEqual(wedDay6.clean, 5.0, `Expected Wed clean 5.0, got ${wedDay6.clean}`);
  assert.strictEqual(wedDay6.total, 5.0, `Expected Wed total 5.0, got ${wedDay6.total}`);
  console.log('PASS: usageByOperation correctly separates days across Manila midnight\n');


  // Test 7: Batch replay deduplication via src_id
  console.log('Test 7: Offline batch replay does not duplicate rows (src_id UNIQUE)');
  db.exec('DELETE FROM offline_readings');
  db.exec('DELETE FROM water_readings');
  db.exec('DELETE FROM readings');

  const batch = [
    {
      id: 'esp32-batch-test-01',
      ts: baseTs + 1000,
      temp: 28.5,
      humidity: 70,
      thi: 76.2,
      water_level: 85,
      flow_lpm: 1.2,
      water_used: 1.5,
      mist_on: 1,
      bath_on: 0,
      clean_on: 0,
      pump_on: 1,
      pump_reason: 'auto'
    },
    {
      id: 'esp32-batch-test-02',
      ts: baseTs + 2000,
      temp: 28.6,
      humidity: 71,
      thi: 76.5,
      water_level: 84,
      flow_lpm: 1.1,
      water_used: 2.5,
      mist_on: 0,
      bath_on: 1,
      clean_on: 0,
      pump_on: 1,
      pump_reason: 'bath'
    }
  ];

  const firstSync = insertOfflineBatch(batch);
  assert.strictEqual(firstSync.inserted, 2, `Expected 2 inserted, got ${firstSync.inserted}`);
  assert.strictEqual(firstSync.skipped, 0, `Expected 0 skipped, got ${firstSync.skipped}`);

  const offCount1 = db.prepare('SELECT COUNT(*) AS c FROM offline_readings').get().c;
  const watCount1 = db.prepare('SELECT COUNT(*) AS c FROM water_readings').get().c;
  const redCount1 = db.prepare('SELECT COUNT(*) AS c FROM readings').get().c;
  assert.strictEqual(offCount1, 2, 'Expected 2 offline_readings rows');
  assert.strictEqual(watCount1, 2, 'Expected 2 water_readings rows');
  assert.strictEqual(redCount1, 2, 'Expected 2 readings rows');

  // Replay identical batch
  const replaySync = insertOfflineBatch(batch);
  assert.strictEqual(replaySync.inserted, 0, `Expected 0 inserted on replay, got ${replaySync.inserted}`);
  assert.strictEqual(replaySync.skipped, 2, `Expected 2 skipped on replay, got ${replaySync.skipped}`);

  const offCount2 = db.prepare('SELECT COUNT(*) AS c FROM offline_readings').get().c;
  const watCount2 = db.prepare('SELECT COUNT(*) AS c FROM water_readings').get().c;
  const redCount2 = db.prepare('SELECT COUNT(*) AS c FROM readings').get().c;
  assert.strictEqual(offCount2, 2, 'offline_readings must still have exactly 2 rows after replay');
  assert.strictEqual(watCount2, 2, 'water_readings must still have exactly 2 rows after replay');
  assert.strictEqual(redCount2, 2, 'readings must still have exactly 2 rows after replay');
  console.log('PASS: Replay does not duplicate records in offline_readings, water_readings, or readings\n');

  // Test 8: Realistic combined dataset (reboot mid-day, midnight crossing, duplicate batch replay, DHT-failure records)
  console.log('Test 8: Realistic dataset: DHT failure, mid-day reboot, midnight crossing & replay');
  db.exec('DELETE FROM offline_readings');
  db.exec('DELETE FROM water_readings');
  db.exec('DELETE FROM readings');

  // Manila Thursday Oct 22, 2026 10:00:00 UTC+8 = 2026-10-22 02:00:00 UTC
  const manilaThu10amUtcMs = Date.UTC(2026, 9, 22, 2, 0, 0);

  // 1. Normal telemetry with valid DHT on Thursday (0 to 5 L, misting)
  const batch1 = [
    {
      id: 'real-01',
      ts: manilaThu10amUtcMs,
      temp: 29.0, humidity: 75.0, thi: 78.5,
      water_level: 90, flow_lpm: 1.0, water_used: 0.0,
      mist_on: 1, pump_on: 1, pump_reason: 'auto'
    },
    {
      id: 'real-02',
      ts: manilaThu10amUtcMs + 60000,
      temp: 29.2, humidity: 74.0, thi: 78.7,
      water_level: 88, flow_lpm: 2.5, water_used: 5.0,
      mist_on: 1, pump_on: 1, pump_reason: 'auto'
    }
  ];
  const res1 = insertOfflineBatch(batch1);
  assert.strictEqual(res1.inserted, 2);

  // 2. DHT failure records (temp/hum/thi are null, but water metrics continue!)
  // Counter rises from 5.0 L to 8.0 L during bathing (+3.0 L)
  const batchDhtFail = [
    {
      id: 'real-03-dhtfail',
      ts: manilaThu10amUtcMs + 120000,
      temp: null, humidity: null, thi: null,
      water_level: 85, flow_lpm: 3.0, water_used: 8.0,
      bath_on: 1, pump_on: 1, pump_reason: 'sched'
    }
  ];
  const resDht = insertOfflineBatch(batchDhtFail);
  assert.strictEqual(resDht.inserted, 1);
  // Verify readings table DID NOT get the DHT-failure row, but water_readings DID
  const rDhtCount = db.prepare('SELECT COUNT(*) AS c FROM readings WHERE src_id = ?').get('real-03-dhtfail').c;
  const wDhtCount = db.prepare('SELECT COUNT(*) AS c FROM water_readings WHERE src_id = ?').get('real-03-dhtfail').c;
  assert.strictEqual(rDhtCount, 0, 'readings must ignore rows with null DHT');
  assert.strictEqual(wDhtCount, 1, 'water_readings must ingest rows even when DHT is null');

  // 3. Mid-day reboot: counter resets to 0.0, rises to 4.0 L during cleaning (+4.0 L)
  const batchReboot = [
    {
      id: 'real-04-reboot',
      ts: manilaThu10amUtcMs + 180000,
      temp: 28.5, humidity: 70.0, thi: 77.0,
      water_level: 80, flow_lpm: 2.0, water_used: 4.0,
      clean_on: 1, pump_on: 1, pump_reason: 'sched'
    }
  ];
  const resReboot = insertOfflineBatch(batchReboot);
  assert.strictEqual(resReboot.inserted, 1);

  // 4. Midnight crossing: crosses into Friday Oct 23 (2026-10-22 16:00:00 UTC = 2026-10-23 00:00:00 UTC+8)
  const manilaFriMidnightUtcMs = Date.UTC(2026, 9, 22, 16, 0, 0);
  const batchFriday = [
    {
      id: 'real-05-fri',
      ts: manilaFriMidnightUtcMs + 3600000, // 01:00 Manila Friday
      temp: 26.0, humidity: 80.0, thi: 74.0,
      water_level: 75, flow_lpm: 1.5, water_used: 7.0, // counter rose from 4.0 to 7.0 (+3.0 L mist)
      mist_on: 1, pump_on: 1, pump_reason: 'auto'
    }
  ];
  const resFri = insertOfflineBatch(batchFriday);
  assert.strictEqual(resFri.inserted, 1);

  // 5. Replay all batches (SD replay / network retransmission)
  const allBatches = [...batch1, ...batchDhtFail, ...batchReboot, ...batchFriday];
  const resReplay = insertOfflineBatch(allBatches);
  assert.strictEqual(resReplay.inserted, 0, 'Replayed records must have 0 inserted');
  assert.strictEqual(resReplay.skipped, allBatches.length, 'All replayed records must be skipped');

  // Verify weekly usage calculation with realistic dataset
  const weeklyUsage = weeklyWaterUsage(manilaThu10amUtcMs);
  const thuEntry = weeklyUsage.find(d => d.date === '2026-10-22');
  const friEntry = weeklyUsage.find(d => d.date === '2026-10-23');

  assert(thuEntry, 'Expected Thursday (2026-10-22) entry');
  assert(friEntry, 'Expected Friday (2026-10-23) entry');

  // Thursday expected: 5.0 (mist) + 3.0 (bathe) + 4.0 (clean) = 12.0 L
  assert.strictEqual(thuEntry.mist, 5.0, `Thu mist expected 5.0, got ${thuEntry.mist}`);
  assert.strictEqual(thuEntry.bathe, 3.0, `Thu bathe expected 3.0, got ${thuEntry.bathe}`);
  assert.strictEqual(thuEntry.clean, 4.0, `Thu clean expected 4.0, got ${thuEntry.clean}`);
  assert.strictEqual(thuEntry.total, 12.0, `Thu total expected 12.0, got ${thuEntry.total}`);

  // Friday expected: 3.0 (mist) = 3.0 L
  assert.strictEqual(friEntry.mist, 3.0, `Fri mist expected 3.0, got ${friEntry.mist}`);
  assert.strictEqual(friEntry.total, 3.0, `Fri total expected 3.0, got ${friEntry.total}`);

  // Verify 7 days returned and missing days filled with 0
  assert.strictEqual(weeklyUsage.length, 7, 'weeklyWaterUsage must return exactly 7 days');
  weeklyUsage.forEach(d => {
    assert(d.date && typeof d.date === 'string', 'Day must have date string');
    assert(d.day && typeof d.day === 'string', 'Day must have day string');
    assert(typeof d.total === 'number', 'Day must have total number');
    if (d.date !== '2026-10-22' && d.date !== '2026-10-23') {
      assert.strictEqual(d.total, 0, `Day ${d.date} should have 0 usage`);
    }
  });

  // Verify getWaterUsage('7d') structure
  const wuReport = getWaterUsage('7d');
  assert(wuReport.days && wuReport.days.length === 7, 'getWaterUsage should return 7 days');
  assert(wuReport.totals && typeof wuReport.totals.total === 'number', 'getWaterUsage should return totals');
  assert(wuReport.today != null && typeof wuReport.today === 'number', 'getWaterUsage should return today numeric total');

  // Test 9: Scheduled operations override auto-misting attribution in realistic scenario
  console.log('Test 9: Scheduled operations override auto-misting attribution');
  db.exec('DELETE FROM water_readings');
  const t0 = manilaWedNoonUtcMs;
  insertWater({ level_pct: 80, used_l: 10, ts: t0, mist_on: 0, bath_on: 0, clean_on: 0 });
  // Mist active alone: 10 -> 12 (+2L mist)
  insertWater({ level_pct: 80, used_l: 12, ts: t0 + 1000, mist_on: 1, bath_on: 0, clean_on: 0 });
  // Both mist and bath active: 12 -> 15 (+3L, scheduled bath overrides mist!)
  insertWater({ level_pct: 80, used_l: 15, ts: t0 + 2000, mist_on: 1, bath_on: 1, clean_on: 0 });
  // Both clean and mist active: 15 -> 20 (+5L, scheduled clean overrides mist!)
  insertWater({ level_pct: 80, used_l: 20, ts: t0 + 3000, mist_on: 1, bath_on: 0, clean_on: 1 });
  // Clean, bath, and mist all active: 20 -> 24 (+4L, clean has highest priority!)
  insertWater({ level_pct: 80, used_l: 24, ts: t0 + 4000, mist_on: 1, bath_on: 1, clean_on: 1 });

  const rowsOverride = db.prepare('SELECT * FROM water_readings ORDER BY ts ASC').all();
  const overrideDays = usageByOperation(rowsOverride);
  assert(overrideDays.length === 1, 'Expected 1 day for override test');
  const dOverride = overrideDays[0];
  assert.strictEqual(dOverride.mist, 2.0, `Expected mist 2.0, got ${dOverride.mist}`);
  assert.strictEqual(dOverride.bathe, 3.0, `Expected bathe 3.0, got ${dOverride.bathe}`);
  assert.strictEqual(dOverride.clean, 9.0, `Expected clean 9.0 (5+4), got ${dOverride.clean}`);
  assert.strictEqual(dOverride.total, 14.0, `Expected total 14.0, got ${dOverride.total}`);
  console.log('PASS: Priority override (clean > bath > mist) verified!\n');

  console.log('PASS: Realistic dataset verified (DHT fail, reboot, midnight crossing, replay)\n');
  console.log('========================================');
  console.log('ALL WATER USAGE UNIT TESTS PASSED!');
  console.log('========================================');

} finally {
  db.close();
  try {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(WAL_FILE)) fs.unlinkSync(WAL_FILE);
    if (fs.existsSync(SHM_FILE)) fs.unlinkSync(SHM_FILE);
  } catch (_) {}
}
