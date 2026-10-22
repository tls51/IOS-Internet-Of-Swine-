const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TEST_PORT = 3123;
process.env.PORT = String(TEST_PORT);
process.env.IOS_ADMIN_USER = 'admin';
process.env.IOS_ADMIN_PASS = 'ios2024';

let serverProc = null;

function startServerProcess() {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname),
    env: { ...process.env, PORT: String(TEST_PORT) },
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
  console.log('\n--- Waiting for server to start ---');
  startServerProcess();
  await waitForServerReady();
  console.log('Server is running on port', TEST_PORT);

  // 1. GET /api/info
  console.log('\nTest 1: GET /api/info indicates authRequired: true');
  const infoRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/info`);
  const infoData = await infoRes.json();
  assert.strictEqual(infoData.authRequired, true, 'info.authRequired should be true');
  console.log('PASS: GET /api/info -> authRequired is true');

  // 2. Reject incorrect login
  console.log('\nTest 2: Reject incorrect login');
  const badLoginRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrongpassword' })
  });
  assert.strictEqual(badLoginRes.status, 401, 'Bad credentials must return HTTP 401');
  const badLoginData = await badLoginRes.json();
  assert.strictEqual(badLoginData.ok, false, 'badLoginData.ok should be false');
  console.log('PASS: Bad credentials rejected with HTTP 401');

  // 3. Unauthenticated writes blocked
  console.log('\nTest 3: Unauthenticated writes return HTTP 401');
  const unauthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'bath',
      label: 'Unauthorized Bath',
      time: '08:00',
      duration: 15,
      days: ['Mon', 'Wed']
    })
  });
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated POST /api/schedules must return 401');
  console.log('PASS: Schedule write without session blocked with HTTP 401');

  // 4. Correct login establishes session
  console.log('\nTest 4: Correct login establishes session cookie and token');
  const loginRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'ios2024' })
  });
  assert.strictEqual(loginRes.status, 200, 'Login with correct credentials must return 200');
  const loginData = await loginRes.json();
  assert.strictEqual(loginData.ok, true, 'loginData.ok should be true');
  assert(loginData.token, 'loginData should return token');
  const cookieHeader = loginRes.headers.get('set-cookie');
  assert(cookieHeader && cookieHeader.includes('ios_session='), 'Response must set ios_session cookie');
  assert(cookieHeader.includes('HttpOnly'), 'Cookie must be HttpOnly');
  const cookieValue = cookieHeader.split(';')[0];
  console.log('PASS: Login succeeded, token received, HttpOnly cookie set');

  // 5. Verify session endpoint
  console.log('\nTest 5: GET /api/session with cookie');
  const sessionRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
    headers: { Cookie: cookieValue }
  });
  assert.strictEqual(sessionRes.status, 200, 'Valid session returns 200');
  const sessionData = await sessionRes.json();
  assert.strictEqual(sessionData.authenticated, true);
  console.log('PASS: GET /api/session verified as authenticated');

  // 5b. Verify SQLite session persistence and token hash (not raw token)
  console.log('\nTest 5b: Verify SQLite session persistence and token hash');
  const db = require('./src/db');
  const crypto = require('crypto');
  const expectedHash = crypto.createHash('sha256').update(loginData.token).digest('hex');
  const sessionRow = db.getSession(expectedHash);
  assert(sessionRow, 'Session must exist in SQLite sessions table');
  assert.strictEqual(sessionRow.username, 'admin', 'Session username must be admin');
  assert.strictEqual(sessionRow.token_hash, expectedHash, 'token_hash must match sha256 of raw token');
  assert(sessionRow.expires_at > Date.now(), 'Session must have valid future expires_at');
  // Confirm raw token is NOT in the database table
  const rawLeak = db.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(loginData.token);
  assert(!rawLeak, 'Raw token must NEVER be stored as the token_hash');
  console.log('PASS: Session persisted in SQLite with SHA-256 hash (raw token not stored)');

  // 5c. Server restart: restart server process and confirm session survives
  console.log('\nTest 5c: Server restart preserves session');
  await stopServerProcess();
  console.log('Server stopped. Restarting...');
  startServerProcess();
  await waitForServerReady();
  console.log('Server restarted on port', TEST_PORT);

  const postRestartSession = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
    headers: { Cookie: cookieValue }
  });
  assert.strictEqual(postRestartSession.status, 200, 'Session must remain valid across server restart');
  const postRestartData = await postRestartSession.json();
  assert.strictEqual(postRestartData.authenticated, true, 'authenticated should be true after restart');

  const postRestartBearer = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
    headers: { Authorization: `Bearer ${loginData.token}` }
  });
  assert.strictEqual(postRestartBearer.status, 200, 'Bearer session token must remain valid across restart');
  console.log('PASS: Session survives server restart via cookie and bearer token');

  // 5d. Expired session rejection and cleanup
  console.log('\nTest 5d: Expired sessions are rejected and cleaned up');
  const expiredHash = crypto.createHash('sha256').update('expired-token-sample').digest('hex');
  db.saveSession(expiredHash, 'admin', Date.now() - 10000, Date.now() - 1000);
  assert.strictEqual(db.getSession(expiredHash), null, 'Expired session should return null');
  db.cleanupExpiredSessions();
  const rowAfterClean = db.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(expiredHash);
  assert(!rowAfterClean, 'Expired session should be removed from database');
  console.log('PASS: Expired sessions are rejected and cleaned up');

  // 6. Authorized schedule creation (Bathing and Cleaning)
  console.log('\nTest 6: Authorized creation of Bathing and Cleaning schedules');
  const bathRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue
    },
    body: JSON.stringify({
      type: 'bath',
      label: 'Morning Bath',
      time: '07:30',
      duration: 20,
      days: ['Mon', 'Wed', 'Fri']
    })
  });
  assert.strictEqual(bathRes.status, 201, 'Bath schedule creation should return 201');
  const bathSched = await bathRes.json();
  assert.strictEqual(bathSched.type, 'bath');
  assert.strictEqual(bathSched.label, 'Morning Bath');
  assert.strictEqual(bathSched.time, '07:30');
  assert.strictEqual(bathSched.duration, 20);
  assert.deepStrictEqual(bathSched.days, ['Mon', 'Wed', 'Fri']);
  assert.strictEqual(bathSched.active, true);
  console.log('PASS: Bath schedule created (id=' + bathSched.id + ')');

  const cleanRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginData.token}`
    },
    body: JSON.stringify({
      type: 'clean',
      label: 'Deep Clean',
      time: '14:00',
      duration: 30,
      days: ['Tue', 'Thu']
    })
  });
  assert.strictEqual(cleanRes.status, 201, 'Clean schedule creation should return 201');
  const cleanSched = await cleanRes.json();
  assert.strictEqual(cleanSched.type, 'clean');
  assert.strictEqual(cleanSched.label, 'Deep Clean');
  console.log('PASS: Cleaning schedule created via Bearer token (id=' + cleanSched.id + ')');

  // 7. Verify schedules persist and can be fetched
  console.log('\nTest 7: Verify schedules are returned in list');
  const listBathRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules?type=bath`);
  const bathList = await listBathRes.json();
  const foundBath = bathList.find(s => s.id === bathSched.id);
  assert(foundBath, 'Created bath schedule must exist in list');
  assert.strictEqual(foundBath.label, 'Morning Bath');
  console.log('PASS: Schedules persist and are queryable');

  // 8. Schedule pausing / editing (PATCH)
  console.log('\nTest 8: Edit / pause schedule');
  const patchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${bathSched.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue
    },
    body: JSON.stringify({ active: false })
  });
  assert.strictEqual(patchRes.status, 200, 'PATCH schedule active=false should return 200');
  const patchedSched = await patchRes.json();
  assert.strictEqual(patchedSched.active, false);
  console.log('PASS: Schedule paused successfully');

  // 9. Time synchronization (POST /api/time)
  console.log('\nTest 9: Clock synchronization');
  const timeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/time`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue
    },
    body: JSON.stringify({ epoch: 1700000000 })
  });
  assert.strictEqual(timeRes.status, 200, 'POST /api/time should return 200');
  console.log('PASS: Time sync authorized with session');

  // 10. Schedule deletion (DELETE)
  console.log('\nTest 10: Delete schedule');
  const delRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${bathSched.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookieValue }
  });
  assert.strictEqual(delRes.status, 204, 'DELETE schedule should return 204');
  console.log('PASS: Schedule deleted');

  // Clean up clean schedule too
  await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules/${cleanSched.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookieValue }
  });

  // 11. Logout invalidates session
  console.log('\nTest 11: Logout invalidates session');
  const logoutRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookieValue }
  });
  assert.strictEqual(logoutRes.status, 200);

  // Subsequent check with old cookie should fail
  const postLogoutSession = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
    headers: { Cookie: cookieValue }
  });
  assert.strictEqual(postLogoutSession.status, 401, 'Post-logout session check must return 401');

  // Subsequent write with old cookie must fail
  const postLogoutWrite = await fetch(`http://127.0.0.1:${TEST_PORT}/api/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue
    },
    body: JSON.stringify({
      type: 'bath',
      label: 'Post-Logout Bath',
      time: '09:00',
      duration: 10,
      days: ['Mon']
    })
  });
  assert.strictEqual(postLogoutWrite.status, 401, 'Post-logout write must return 401');
  console.log('PASS: Logout properly invalidates session and blocks subsequent writes');

  console.log('\n========================================');
  console.log('ALL AUTHENTICATION TESTS PASSED!');
  console.log('========================================\n');
}

runTests()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServerProcess();
  });
