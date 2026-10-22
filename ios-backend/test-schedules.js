const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Database = require('better-sqlite3');

const TEST_PORT = 3128;
const TEST_DB = path.join(__dirname, 'test-schedules.db');

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
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/info`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch (_) {}
    await sleep(200);
  }
  assert(ready, 'Server failed to start');
}

async function runTests() {
  console.log('=== Running Schedule Unit & Integration Tests ===\n');

  // Test 1: Mist-row migration works
  console.log('Test 1: mist-row migration works');
  {
    // Initialize schema via db module
    const { db, migrateRemoveMistSchedules } = require('./src/db');

    // Insert a legacy mist schedule directly into database
    db.prepare(`
      INSERT INTO schedules (type, label, time, duration, days, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('mist', 'Legacy Mist Schedule', '11:00', 10, JSON.stringify(['Mon', 'Wed']));

    // Confirm it exists
    const beforeCount = db.prepare(`SELECT COUNT(*) AS c FROM schedules WHERE type = 'mist'`).get().c;
    assert.strictEqual(beforeCount, 1, 'Expected 1 mist schedule before migration');

    // Run migration
    const deletedCount = migrateRemoveMistSchedules();
    assert.strictEqual(deletedCount, 1, 'Expected migration to report 1 deleted mist schedule');

    // Confirm mist rows are 0
    const afterCount = db.prepare(`SELECT COUNT(*) AS c FROM schedules WHERE type = 'mist'`).get().c;
    assert.strictEqual(afterCount, 0, 'Expected 0 mist schedules after migration');

    // Confirm other schedules (bath/clean) are preserved
    const totalRemaining = db.prepare(`SELECT COUNT(*) AS c FROM schedules`).get().c;
    assert(totalRemaining > 0, 'Expected seeded bath/clean schedules to remain intact');

    // Verify idempotency
    const idempotentRun = migrateRemoveMistSchedules();
    assert.strictEqual(idempotentRun, 0, 'Second run of migration should delete 0 rows');

    db.close();
    console.log('PASS: mist-row migration successfully removed legacy mist schedules without affecting others.\n');
  }

  // Start HTTP server for route testing
  console.log('--- Starting server on port', TEST_PORT, '---');
  startServerProcess();
  await waitForServerReady();
  console.log('Server is running on port', TEST_PORT);

  // Authenticate as admin
  const loginRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'ios2024' })
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login failed');
  const loginData = await loginRes.json();
  const token = loginData.token;
  assert(token, 'Expected token from login');
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Test 2: GET and POST with type=mist rejected with HTTP 400
  console.log('\nTest 2: type=mist rejected with HTTP 400 on GET and POST');
  {
    const getRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=mist`);
    assert.strictEqual(getRes.status, 400, `Expected GET /api/schedules?type=mist to return 400, got ${getRes.status}`);
    const getBody = await getRes.json();
    assert(getBody.error, 'Expected error in 400 response');

    const postRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        type: 'mist',
        label: 'Should Fail',
        time: '12:00',
        duration: 5,
        days: ['Mon', 'Fri']
      })
    });
    assert.strictEqual(postRes.status, 400, `Expected POST /api/schedules with type=mist to return 400, got ${postRes.status}`);
    const postBody = await postRes.json();
    assert(postBody.error, 'Expected error in 400 response');

    console.log('PASS: GET and POST with type=mist rejected with HTTP 400');
  }

  // Test 3: bath CRUD operations
  console.log('\nTest 3: Bath schedule CRUD OK');
  let bathId;
  {
    // Create
    const createRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        type: 'bath',
        label: 'Test Bath Schedule',
        time: '06:30',
        duration: 15,
        days: ['Mon', 'Wed', 'Fri']
      })
    });
    assert.strictEqual(createRes.status, 201, `Expected 201 Created for bath schedule, got ${createRes.status}`);
    const created = await createRes.json();
    assert.strictEqual(created.type, 'bath');
    assert.strictEqual(created.label, 'Test Bath Schedule');
    bathId = created.id;

    // List
    const listRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=bath`);
    assert.strictEqual(listRes.status, 200);
    const list = await listRes.json();
    const found = list.find(s => s.id === bathId);
    assert(found, 'Created bath schedule not found in list');
    assert.strictEqual(found.active, true);

    // Update / Pause
    const patchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${bathId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ active: false, duration: 20 })
    });
    assert.strictEqual(patchRes.status, 200);
    const updated = await patchRes.json();
    assert.strictEqual(updated.active, false);
    assert.strictEqual(updated.duration, 20);

    // Delete
    const delRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${bathId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.strictEqual(delRes.status, 204);

    // Verify deletion
    const listAfterDel = await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=bath`)).json();
    assert(!listAfterDel.some(s => s.id === bathId), 'Deleted bath schedule still exists');

    console.log('PASS: Bath schedule CRUD completed successfully');
  }

  // Test 4: clean CRUD operations
  console.log('\nTest 4: Clean schedule CRUD OK');
  let cleanId;
  {
    // Create
    const createRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        type: 'clean',
        label: 'Test Clean Schedule',
        time: '08:00',
        duration: 10,
        days: ['Tue', 'Thu']
      })
    });
    assert.strictEqual(createRes.status, 201, `Expected 201 Created for clean schedule, got ${createRes.status}`);
    const created = await createRes.json();
    assert.strictEqual(created.type, 'clean');
    assert.strictEqual(created.label, 'Test Clean Schedule');
    cleanId = created.id;

    // List
    const listRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=clean`);
    assert.strictEqual(listRes.status, 200);
    const list = await listRes.json();
    const found = list.find(s => s.id === cleanId);
    assert(found, 'Created clean schedule not found in list');

    // Update
    const patchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${cleanId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ duration: 25 })
    });
    assert.strictEqual(patchRes.status, 200);
    const updated = await patchRes.json();
    assert.strictEqual(updated.duration, 25);

    // Delete
    const delRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${cleanId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.strictEqual(delRes.status, 204);

    console.log('PASS: Clean schedule CRUD completed successfully');
  }

  // Test 5: type=all has no mist and debug has no mist
  console.log('\nTest 5: type=all and /api/schedules/debug have no mist');
  {
    const allRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=all`);
    assert.strictEqual(allRes.status, 200);
    const allSchedules = await allRes.json();
    assert(Array.isArray(allSchedules), 'Expected array from type=all');
    for (const s of allSchedules) {
      assert.notStrictEqual(s.type, 'mist', `Found mist schedule in type=all: ${JSON.stringify(s)}`);
      assert(['bath', 'clean'].includes(s.type), `Unexpected schedule type: ${s.type}`);
    }

    const debugRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/debug`);
    assert.strictEqual(debugRes.status, 200);
    const debugData = await debugRes.json();
    assert(Array.isArray(debugData.bath), 'Expected bath array in debug');
    assert(Array.isArray(debugData.clean), 'Expected clean array in debug');
    assert.strictEqual(debugData.mist, undefined, 'debugData.mist should not exist');

    console.log('PASS: type=all and /api/schedules/debug have no mist');
  }

  // Test 6: Verify /api/status mistActive is false (with TODO)
  console.log('\nTest 6: /api/status mistActive is false');
  {
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const status = await statusRes.json();
    assert.strictEqual(status.mistActive, false, 'Expected mistActive to be false');
    console.log('PASS: /api/status mistActive is false');
  }

  console.log('\n========================================');
  console.log('ALL SCHEDULE TESTS PASSED!');
  console.log('========================================\n');
}

(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('\nTEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    await stopServerProcess();
    cleanupDbFiles();
  }
})();
