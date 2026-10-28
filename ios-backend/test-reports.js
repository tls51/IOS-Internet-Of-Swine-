const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const TEST_PORT = 3130;
const TEST_DB = path.join(__dirname, 'test-reports.db');

// Ensure clean test db state
function cleanupDbFiles() {
  for (const ext of ['', '-wal', '-shm']) {
    const f = `${TEST_DB}${ext}`;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

cleanupDbFiles();
process.env.IOS_DB_PATH = TEST_DB;
process.env.PORT = String(TEST_PORT);
process.env.IOS_ADMIN_USER = 'admin';
process.env.IOS_ADMIN_PASS = 'ios2024';

const { db, getAggregatedReadings, rawReadingsIterator, reportSummary } = require('./src/db');

let serverProc = null;

function startServerProcess() {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname),
    env: { ...process.env, PORT: String(TEST_PORT), IOS_DB_PATH: TEST_DB },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProc.stdout.on('data', (d) => process.stdout.write(`[Server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[Server ERR] ${d}`));
  return serverProc;
}

async function stopServerProcess() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  return new Promise((resolve) => {
    p.on('exit', () => setTimeout(resolve, 300));
    try { p.kill(); } catch (_) {}
    setTimeout(resolve, 1500);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/info`);
      if (res.ok) return true;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('Server did not become ready in time');
}

async function runTests() {
  console.log('=== Running Reports & Aggregation Tests ===\n');

  const now = Date.now();
  const stepMs = 15 * 1000; // 15 seconds
  const totalDays = 30;
  const startTs = now - (totalDays * 24 * 60 * 60 * 1000);

  console.log(`1. Seeding 30 days of 15s data (${Math.floor((now - startTs) / stepMs) + 1} rows)...`);
  const tSeed0 = Date.now();
  const insertStmt = db.prepare(`
    INSERT INTO readings (ts, temp, humidity, thi, device_id)
    VALUES (?, ?, ?, ?, 'esp32-dht')
  `);

  const seedTx = db.transaction(() => {
    for (let t = startTs; t <= now; t += stepMs) {
      const hour = new Date(t + 8 * 3600000).getUTCHours();
      const temp = 26 + 6 * Math.sin((hour - 8) * Math.PI / 12);
      const hum = 80 - 20 * Math.sin((hour - 8) * Math.PI / 12);
      const thi = 0.8 * temp + (hum / 100) * (temp - 14.4) + 46.4;
      insertStmt.run(t, Math.round(temp * 10) / 10, Math.round(hum * 10) / 10, Math.round(thi * 10) / 10);
    }
  });
  seedTx();
  console.log(`   Seeded in ${Date.now() - tSeed0} ms.\n`);

  // 2. Direct DB Aggregation Assertions
  console.log('2. Testing 7d aggregation in DB...');
  const pts7d = getAggregatedReadings({ range: '7d', untilMs: now });
  console.log(`   7d returned ${pts7d.length} points (bucket = 1h)`);
  assert(pts7d.length > 0, '7d points should not be empty');
  assert(pts7d.length <= 400, `7d points (${pts7d.length}) exceeded 400 point cap`);

  const sixPointNineDaysAgo = now - 6.9 * 24 * 3600 * 1000;
  assert(pts7d[0].ts <= sixPointNineDaysAgo, `7d earliest point (${pts7d[0].ts}) must include data from 6.9 days ago (${sixPointNineDaysAgo})`);

  // Buckets align to Asia/Manila (UTC+8) hour boundary
  for (const p of pts7d) {
    const manilaMs = p.ts + 8 * 3600 * 1000;
    assert.strictEqual(manilaMs % 3600000, 0, `7d bucket ts ${p.ts} (${p.label}) not aligned to UTC+8 hour`);
  }
  console.log('   PASS: 7d capped <= 400, covers 6.9d ago, aligned to Asia/Manila.\n');

  console.log('3. Testing 30d aggregation in DB...');
  const pts30d = getAggregatedReadings({ range: '30d', untilMs: now });
  console.log(`   30d returned ${pts30d.length} points (bucket = 6h)`);
  assert(pts30d.length > 0, '30d points should not be empty');
  assert(pts30d.length <= 400, `30d points (${pts30d.length}) exceeded 400 point cap`);

  const twentyNinePointNineDaysAgo = now - 29.9 * 24 * 3600 * 1000;
  assert(pts30d[0].ts <= twentyNinePointNineDaysAgo, `30d earliest point (${pts30d[0].ts}) must include data from 29.9 days ago (${twentyNinePointNineDaysAgo})`);

  // Buckets align to Asia/Manila (UTC+8) 6-hour boundary
  for (const p of pts30d) {
    const manilaMs = p.ts + 8 * 3600 * 1000;
    assert.strictEqual(manilaMs % (6 * 3600000), 0, `30d bucket ts ${p.ts} (${p.label}) not aligned to UTC+8 6h boundary`);
  }
  console.log('   PASS: 30d capped <= 400, covers 29.9d ago, aligned to Asia/Manila.\n');

  console.log('4. Testing "all" aggregation performance in DB...');
  const tAll0 = Date.now();
  const ptsAll = getAggregatedReadings({ range: 'all', untilMs: now });
  const allElapsedMs = Date.now() - tAll0;
  console.log(`   "all" returned ${ptsAll.length} points in ${allElapsedMs} ms`);
  assert(allElapsedMs < 500, `"all" aggregation took ${allElapsedMs} ms, expected < 500 ms`);
  assert(ptsAll.length <= 400, `"all" points (${ptsAll.length}) exceeded 400 point cap`);
  console.log('   PASS: "all" returned <= 400 points in under 500 ms.\n');

  // 3. Start server and test HTTP API and CSV export
  console.log('5. Starting HTTP server process for API tests...');
  startServerProcess();
  await waitForServerReady();
  console.log('   Server is ready.\n');

  // Test /api/readings/history
  console.log('6. Testing GET /api/readings/history endpoints...');
  const res7d = await fetch(`http://127.0.0.1:${TEST_PORT}/api/readings/history?range=7d`);
  assert.strictEqual(res7d.status, 200);
  const data7d = await res7d.json();
  assert.strictEqual(data7d.length, pts7d.length, 'HTTP 7d count matches DB 7d count');

  const res30d = await fetch(`http://127.0.0.1:${TEST_PORT}/api/readings/history?range=30d`);
  assert.strictEqual(res30d.status, 200);
  const data30d = await res30d.json();
  assert.strictEqual(data30d.length, pts30d.length, 'HTTP 30d count matches DB 30d count');

  const tHttpAll0 = Date.now();
  const resAll = await fetch(`http://127.0.0.1:${TEST_PORT}/api/readings/history?range=all`);
  const httpAllElapsed = Date.now() - tHttpAll0;
  assert.strictEqual(resAll.status, 200);
  const dataAll = await resAll.json();
  assert(dataAll.length <= 400, 'HTTP "all" points <= 400');
  console.log(`   HTTP "all" returned ${dataAll.length} points in ${httpAllElapsed} ms`);
  console.log('   PASS: HTTP history endpoints return valid aggregated points.\n');

  const authHeaders = { 'X-Auth-Token': 'ios-control-secret-token' };

  // Test /api/reports/summary
  console.log('7. Testing GET /api/reports/summary...');
  const resSummary = await fetch(`http://127.0.0.1:${TEST_PORT}/api/reports/summary?range=7d`, { headers: authHeaders });
  assert.strictEqual(resSummary.status, 200);
  const summary = await resSummary.json();
  assert.strictEqual(summary.bucketMs['7d'], 3600000, '7d summary bucketMs should be 1 hour');
  assert(summary.counts.total > 0, 'Total count in summary should be positive');
  console.log('   PASS: /api/reports/summary returns bucketMs and count.\n');

  // Test /api/reports/export CSV streaming
  console.log('8. Testing GET /api/reports/export CSV streaming and row count match...');
  // 7d bucket export
  const resCsv7d = await fetch(`http://127.0.0.1:${TEST_PORT}/api/reports/export?range=7d&resolution=bucket`, { headers: authHeaders });
  assert.strictEqual(resCsv7d.status, 200);
  assert.strictEqual(resCsv7d.headers.get('content-type'), 'text/csv');
  const csv7d = await resCsv7d.text();
  const lines7d = csv7d.trim().split(/\r?\n/);
  // Header is 1 line, rest are data rows
  const dataRowCount7d = lines7d.length - 1;
  assert.strictEqual(dataRowCount7d, pts7d.length, `CSV 7d row count (${dataRowCount7d}) matches points count (${pts7d.length})`);
  assert(lines7d[0].startsWith('Timestamp,DateTime,Time,Label'), 'CSV header matches bucket schema');

  // 30d bucket export
  const resCsv30d = await fetch(`http://127.0.0.1:${TEST_PORT}/api/reports/export?range=30d&resolution=bucket`, { headers: authHeaders });
  assert.strictEqual(resCsv30d.status, 200);
  const csv30d = await resCsv30d.text();
  const lines30d = csv30d.trim().split(/\r?\n/);
  const dataRowCount30d = lines30d.length - 1;
  assert.strictEqual(dataRowCount30d, pts30d.length, `CSV 30d row count (${dataRowCount30d}) matches points count (${pts30d.length})`);

  // Default resolution for 7d (should default to bucket)
  const resCsv7dDefault = await fetch(`http://127.0.0.1:${TEST_PORT}/api/reports/export?range=7d`, { headers: authHeaders });
  assert.strictEqual(resCsv7dDefault.status, 200);
  const csv7dDefault = await resCsv7dDefault.text();
  const lines7dDefault = csv7dDefault.trim().split(/\r?\n/);
  assert.strictEqual(lines7dDefault.length - 1, pts7d.length, 'Default 7d export uses bucket resolution and row count matches');

  console.log('   PASS: CSV export streams correctly and row counts match aggregated data.\n');

  console.log('ALL TESTS PASSED!\n');
}

runTests()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServerProcess();
    cleanupDbFiles();
  });
