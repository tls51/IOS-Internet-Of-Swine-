const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TEST_PORT = 3125;
const AUTH_TOKEN = 'ios-control-secret-token';
process.env.PORT = String(TEST_PORT);
process.env.IOS_ADMIN_USER = 'admin';
process.env.IOS_ADMIN_PASS = 'ios2024';
process.env.IOS_AUTH_TOKEN = AUTH_TOKEN;

const serverProc = spawn('node', ['src/server.js'], {
  cwd: path.join(__dirname),
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

serverProc.stdout.on('data', (d) => process.stdout.write(`[Server] ${d}`));
serverProc.stderr.on('data', (d) => process.stderr.write(`[Server ERR] ${d}`));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n=== Starting Relay Queue -> Poll -> ACK Tests ===');
  console.log('--- Waiting for server to start ---');
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
  console.log('Server is running on port', TEST_PORT);

  // 1. Login as admin to get auth session
  console.log('\nTest 1: Admin login to obtain session');
  const loginRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'ios2024' })
  });
  assert.strictEqual(loginRes.status, 200, 'Login failed');
  const cookie = loginRes.headers.get('set-cookie');
  const loginData = await loginRes.json();
  const sessionToken = loginData.token;
  assert(sessionToken, 'Expected session token');
  console.log('PASS: Authenticated as admin');

  // 2. Queue relay command from dashboard (manual pump ON)
  console.log('\nTest 2: Dashboard queues relay command (POST /api/relay/control)');
  const queueRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ active: true })
  });
  assert.strictEqual(queueRes.status, 200, 'Queue request failed');
  const queueData = await queueRes.json();
  assert.strictEqual(queueData.ok, true, 'queueData.ok should be true');
  assert.strictEqual(queueData.status, 'queued', 'UI response status should be "queued"');
  assert(queueData.pendingRelayCommand, 'Expected pendingRelayCommand in response');
  assert.strictEqual(queueData.pendingRelayCommand.command, 'pump_on', 'Expected pump_on command');
  console.log('PASS: Relay command queued with status "queued"');

  // Verify /api/status also reflects the queued state
  const statusRes1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
  const statusData1 = await statusRes1.json();
  assert.strictEqual(statusData1.relayCommandStatus, 'queued', '/api/status should show queued status');
  assert(statusData1.pendingRelayCommand, '/api/status should include pending command');
  console.log('PASS: /api/status reflects reality ("queued")');

  // 3. ESP32 polls for command (GET /api/relay/command)
  console.log('\nTest 3: ESP32 polls for pending command (GET /api/relay/command)');
  const pollRes1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`, {
    headers: { 'X-Auth-Token': AUTH_TOKEN }
  });
  assert.strictEqual(pollRes1.status, 200, 'Poll request failed');
  const pollData1 = await pollRes1.json();
  assert(pollData1.command, 'Expected command in poll response');
  assert.strictEqual(pollData1.command.command, 'pump_on', 'Expected pump_on');

  // Crucial check: Command must NOT be deleted just because it was polled
  const pollRes2 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`, {
    headers: { 'X-Auth-Token': AUTH_TOKEN }
  });
  const pollData2 = await pollRes2.json();
  assert(pollData2.command, 'Command should persist until acknowledged');
  assert.strictEqual(pollData2.command.command, 'pump_on', 'Command should still be pump_on');
  console.log('PASS: Polled command successfully and verified it is retained until ACK');

  // 4. ESP32 acknowledges command applied (POST /api/relay/ack)
  console.log('\nTest 4: ESP32 sends ACK confirming command was applied (POST /api/relay/ack)');
  const ackRes1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN
    },
    body: JSON.stringify({
      command: 'pump_on',
      status: 'applied',
      relay_on: true,
      pump_reason: 'manual'
    })
  });
  assert.strictEqual(ackRes1.status, 200, 'ACK request failed');
  const ackData1 = await ackRes1.json();
  assert.strictEqual(ackData1.ok, true, 'ackData.ok should be true');
  assert.strictEqual(ackData1.status, 'applied', 'Status should be "applied"');
  assert.strictEqual(ackData1.relayState, true, 'relayState should be true');

  // Verify pendingRelayCommand is now CLEARED on Node
  const pollRes3 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`, {
    headers: { 'X-Auth-Token': AUTH_TOKEN }
  });
  const pollData3 = await pollRes3.json();
  assert.strictEqual(pollData3.command, null, 'pendingRelayCommand should be cleared after ACK');
  console.log('PASS: ACK applied and cleared pending command');

  // 5. Test Dry-Run Protection: Blocked due to low water (<10%)
  console.log('\nTest 5: Queue pump on, but ESP32 dry-run protection blocks it (low water)');
  await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ active: true })
  });

  const pollResBlock = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`, {
    headers: { 'X-Auth-Token': AUTH_TOKEN }
  });
  const pollDataBlock = await pollResBlock.json();
  assert.strictEqual(pollDataBlock.command.command, 'pump_on');

  // ESP32 detects low water and sends "blocked: low water" ACK
  const ackResBlock = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN
    },
    body: JSON.stringify({
      command: 'pump_on',
      status: 'blocked: low water',
      relay_on: false,
      pump_reason: 'low_water'
    })
  });
  assert.strictEqual(ackResBlock.status, 200);
  const ackDataBlock = await ackResBlock.json();
  assert.strictEqual(ackDataBlock.status, 'blocked: low water', 'Status should be "blocked: low water"');
  assert.strictEqual(ackDataBlock.relayState, false, 'relayState should remain false when blocked');

  // Node clears command and reflects blocked status
  const statusResBlock = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
  const statusDataBlock = await statusResBlock.json();
  assert.strictEqual(statusDataBlock.relayCommandStatus, 'blocked: low water');
  assert.strictEqual(statusDataBlock.pendingRelayCommand, null);
  console.log('PASS: Dry-run protection block reported and acknowledged correctly');

  // 6. Test Pump Test queue -> poll -> ack flow
  console.log('\nTest 6: Pump test pulse queue -> poll -> ack');
  const testRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ duration_ms: 3000 })
  });
  assert.strictEqual(testRes.status, 200);
  const testData = await testRes.json();
  assert.strictEqual(testData.status, 'queued');

  const pollResTest = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`);
  const pollDataTest = await pollResTest.json();
  assert.strictEqual(pollDataTest.command.command, 'test_pump');
  assert.strictEqual(pollDataTest.command.duration_ms, 3000);

  const ackResTest = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN
    },
    body: JSON.stringify({
      command: 'test_pump',
      status: 'applied',
      relay_on: true
    })
  });
  assert.strictEqual(ackResTest.status, 200);
  const ackDataTest = await ackResTest.json();
  assert.strictEqual(ackDataTest.status, 'applied');

  const pollFinal = await fetch(`http://127.0.0.1:${TEST_PORT}/api/relay/command`);
  const pollFinalData = await pollFinal.json();
  assert.strictEqual(pollFinalData.command, null);
  console.log('PASS: Pump test queue -> poll -> ack completed');

  console.log('\n========================================');
  console.log('ALL RELAY QUEUE-POLL-ACK TESTS PASSED!');
  console.log('========================================\n');
}

runTests()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    serverProc.kill();
  });
