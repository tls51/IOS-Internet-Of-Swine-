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

// CORS: allow credentials for the dashboard (same-origin via cookie, cross-origin via Bearer).
// When deployed on fly.io, the dashboard is served from the same origin, so credentials work.
// For local development (different ports), reflect the request origin so the cookie is sent.
const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$|\.fly\.dev$/;
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, Postman, ESP32 firmware)
    if (!origin) return callback(null, true);
    if (allowedOriginPattern.test(origin)) return callback(null, origin);
    // For fly.io production: allow any *.fly.dev subdomain
    return callback(null, origin); // permissive — ESP32 & local dev need this
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-Auth-Token', 'X-Device-Token', 'X-Security-PIN'],
}));
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

function verifyAdminCredentials(user, pass) {
  return db.verifyUserPassword(user, pass);
}
const AUTH_TOKEN = process.env.IOS_AUTH_TOKEN || 'ios-control-secret-token';
const SESSION_TTL_MS = 24 * 3600 * 1000; // 24 hours

let relayState = false;
let manualPumpActive = false;

/* Short-TTL status cache (PERF-01, Per-Account Cache) */
const statusCache = new Map();
const STATUS_CACHE_TTL_MS = 2000;

function invalidateStatusCache(accountId) {
  if (accountId != null) {
    statusCache.delete(accountId);
  } else {
    statusCache.clear();
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Rate limiting for failed login attempts
// Map: ip -> { count: number, firstAttemptAt: number, lockedUntil: number }
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes lockout
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minute tracking window

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return null;

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remainingSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return 'Too many failed login attempts. Temporarily locked out. Please try again in ' + remainingSec + ' seconds.';
  }

  if (entry.lockedUntil && now >= entry.lockedUntil) {
    loginAttempts.delete(ip);
    return null;
  }
  if (now - entry.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return null;
  }

  return null;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAttemptAt: now, lockedUntil: 0 };
  if (now - entry.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    entry.count = 1;
    entry.firstAttemptAt = now;
    entry.lockedUntil = 0;
  } else {
    entry.count += 1;
  }

  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  loginAttempts.set(ip, entry);
}

function recordSuccessfulLogin(ip) {
  loginAttempts.delete(ip);
}
function createSession(username = 'admin', accountId = 1, role = 'admin', displayName = '') {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const tokenHash = hashToken(token);
  db.saveSession(tokenHash, username, now, expiresAt, accountId, role, displayName);
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
  // Explicit request headers MUST take precedence over ambient browser cookies
  // to prevent cross-account contamination when multiple tabs or accounts are open.
  if (req.headers.authorization) {
    const auth = req.headers.authorization;
    if (auth.startsWith('Bearer ')) {
      const val = auth.slice(7).trim();
      if (val) return val;
    }
  }
  if (req.headers['x-session-token']) {
    const val = String(req.headers['x-session-token']).trim();
    if (val) return val;
  }
  if (req.headers['x-auth-token']) {
    const val = String(req.headers['x-auth-token']).trim();
    if (val) return val;
  }
  if (req.headers['x-device-token']) {
    const val = String(req.headers['x-device-token']).trim();
    if (val) return val;
  }
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)ios_session=([^;]+)/);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function getUserFromReq(req) {
  const token = getSessionTokenFromReq(req);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.getSession(tokenHash);
  if (session && session.username) {
    if (session.account_id && session.role) {
      return {
        id: session.account_id,
        username: session.username,
        role: session.role,
        display_name: session.display_name || session.username
      };
    }
    const user = db.getUserByUsername(session.username);
    if (user) {
      return { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
    }
  }
  if (AUTH_TOKEN) {
    const tokenBuf = Buffer.from(String(token));
    const authBuf = Buffer.from(String(AUTH_TOKEN));
    if (tokenBuf.length === authBuf.length && crypto.timingSafeEqual(tokenBuf, authBuf)) {
      return { id: 1, username: 'admin', role: 'admin', display_name: 'Administrator' };
    }
  }
  return null;
}

function isAuthorized(req) {
  return !!getUserFromReq(req);
}

function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (user) {
    req.user = user;
    return next();
  }
  return res.status(401).json({
    ok: false,
    error: 'Unauthorized: Invalid or expired session'
  });
}


function getReqAccountId(req) {
  if (req && req.user && req.user.id) return req.user.id;
  if (req && req.device && req.device.account_id) return req.device.account_id;
  const device = getDeviceFromReq(req);
  if (device) {
    req.device = device;
    req.user = { id: device.account_id, username: null, role: 'device' };
    return device.account_id;
  }
  const user = getUserFromReq(req);
  if (user && user.id) {
    req.user = user;
    return user.id;
  }
  return 1;
}


function getDeviceFromReq(req) {
  const token = getSessionTokenFromReq(req);
  if (!token) return null;
  const device = db.getDeviceByToken(token);
  if (device) return device;
  return null;
}

function requireDeviceAuth(req, res, next) {
  const token = getSessionTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Device token required' });
  }

  // 1. Registered device token
  const device = db.getDeviceByToken(token);
  if (device) {
    req.device = device;
    req.user = { id: device.account_id, username: null, role: 'device' };
    return next();
  }

  // 2. Legacy global AUTH_TOKEN fallback
  if (AUTH_TOKEN) {
    const tokenBuf = Buffer.from(String(token));
    const authBuf = Buffer.from(String(AUTH_TOKEN));
    if (tokenBuf.length === authBuf.length && crypto.timingSafeEqual(tokenBuf, authBuf)) {
      req.device = { id: null, account_id: 1, device_id: 'legacy-esp32', pen_name: 'Main' };
      req.user = { id: 1, username: 'admin', role: 'device' };
      return next();
    }
  }

  // 3. Authenticated user session fallback
  const user = getUserFromReq(req);
  if (user) {
    req.user = user;
    return next();
  }

  return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid device token' });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Admin access required'
    });
  }
  next();
}


// ── Mock Wi-Fi Routes for Cloud / Development ────────────────
app.get('/api/wifi/status', (req, res) => {
  return res.json({
    ok: true,
    connected: true,
    status: 'connected',
    ssid: 'Simulated-Cloud-Network',
    ip: '192.168.1.50',
    rssi: -55,
    ap_ssid: 'ESP32-Misting-System',
    ap_ip: '192.168.4.1',
    mac: 'A4CF12F8B3E2'
  });
});

app.get('/api/wifi/scan', (req, res) => {
  return res.json({
    ok: true,
    count: 3,
    networks: [
      { ssid: 'FarmOffice_5G', rssi: -48, secure: true, auth: 'WPA2' },
      { ssid: 'SwinePen_Barn1', rssi: -62, secure: true, auth: 'WPA2' },
      { ssid: 'Guest_WiFi', rssi: -80, secure: false, auth: 'Open' }
    ]
  });
});

app.post('/api/wifi/connect', (req, res) => {
  if (!isDevicePinAuthorized(req)) return res.status(403).json({ ok: false, error: 'Security PIN required or incorrect' });
  const { ssid } = req.body || {};
  return res.json({
    ok: true,
    status: 'connected',
    ssid: ssid || 'FarmOffice_5G',
    ip: '192.168.1.77',
    rssi: -50
  });
});

app.post('/api/wifi/disconnect', (req, res) => {
  if (!isDevicePinAuthorized(req)) return res.status(403).json({ ok: false, error: 'Security PIN required or incorrect' });
  return res.json({ ok: true, status: 'disconnected' });
});



// ── Mock Device Security PIN State (Node / Cloud / Dev) ──────
let mockPinEnabled = false;
let mockPinHash = '';

function isDevicePinAuthorized(req) {
  if (!mockPinEnabled || !mockPinHash) return true;
  const headerPin = req.headers['x-security-pin'];
  const bodyPin = req.body && req.body.pin;
  const pin = headerPin || bodyPin;
  if (!pin) return false;
  const hash = crypto.createHash('sha256').update(String(pin)).digest('hex');
  return hash === mockPinHash;
}

app.get('/api/device/pin/status', (req, res) => {
  return res.json({ ok: true, enabled: mockPinEnabled });
});

app.post('/api/device/pin/verify', (req, res) => {
  const { pin } = req.body || {};
  if (!mockPinEnabled || !mockPinHash) {
    return res.json({ ok: true, valid: true, message: 'No PIN is currently configured.' });
  }
  const hash = crypto.createHash('sha256').update(String(pin || '')).digest('hex');
  if (hash === mockPinHash) {
    return res.json({ ok: true, valid: true });
  }
  return res.status(403).json({ ok: false, valid: false, error: 'Incorrect Security PIN.' });
});

app.post('/api/device/pin/set', (req, res) => {
  const { current_pin, new_pin } = req.body || {};
  if (mockPinEnabled && mockPinHash) {
    const curHash = crypto.createHash('sha256').update(String(current_pin || '')).digest('hex');
    if (curHash !== mockPinHash) {
      return res.status(403).json({ ok: false, error: 'Current PIN is incorrect.' });
    }
  }
  if (!new_pin || String(new_pin).length < 4 || String(new_pin).length > 8) {
    return res.status(400).json({ ok: false, error: 'PIN must be between 4 and 8 characters.' });
  }
  mockPinHash = crypto.createHash('sha256').update(String(new_pin)).digest('hex');
  mockPinEnabled = true;
  return res.json({ ok: true, enabled: true, message: 'Security PIN set successfully.' });
});

app.post('/api/device/pin/disable', (req, res) => {
  const { current_pin } = req.body || {};
  if (mockPinEnabled && mockPinHash) {
    const curHash = crypto.createHash('sha256').update(String(current_pin || '')).digest('hex');
    if (curHash !== mockPinHash) {
      return res.status(403).json({ ok: false, error: 'Current PIN is incorrect.' });
    }
  }
  mockPinEnabled = false;
  mockPinHash = '';
  return res.json({ ok: true, enabled: false, message: 'Security PIN has been disabled.' });
});

// ── Mock Device Configuration Routes for Cloud / Development ─
app.get('/api/device/config', (req, res) => {
  return res.json({
    ok: true,
    name: 'Pen 1 Controller',
    pen_name: 'Pen 1',
    model: 'ESP32-S3-DevKitC-1',
    ap_ssid: 'IOS-Setup-B3E2',
    timezone_sec: 28800,
    mac: 'A4CF12F8B3E2',
    firmware: '2.1.0-cloud-sim',
    heap_free: 184320,
    flash_size: 8388608
  });
});

app.post('/api/device/config', (req, res) => {
  if (!isDevicePinAuthorized(req)) return res.status(403).json({ ok: false, error: 'Security PIN required or incorrect' });
  const { ap_ssid, ap_password } = req.body || {};
  const rebootRequired = !!(ap_ssid || ap_password);
  return res.json({
    ok: true,
    reboot_required: rebootRequired,
    message: rebootRequired
      ? 'Settings saved. Hardware restart required to apply Access Point changes.'
      : 'Device settings saved successfully.'
  });
});

app.post('/api/device/reboot', (req, res) => {
  if (!isDevicePinAuthorized(req)) return res.status(403).json({ ok: false, error: 'Security PIN required or incorrect' });
  return res.json({ ok: true, message: 'Device reboot initiated.' });
});

app.post('/api/device/factory-reset', (req, res) => {
  if (!isDevicePinAuthorized(req)) return res.status(403).json({ ok: false, error: 'Security PIN required or incorrect' });
  const { confirmation_phrase } = req.body || {};
  if (confirmation_phrase !== 'Yes, I would like to factory reset this device') {
    return res.status(400).json({ ok: false, error: 'Confirmation phrase did not match.' });
  }
  mockPinEnabled = false;
  mockPinHash = '';
  return res.json({ ok: true, message: 'Factory reset successful.' });
});

app.get('/api/info', (req, res) => res.json({ mode: 'cloud', authRequired: true, reports: 'sqlite' }));

app.post('/api/login', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
  const rateLimitMsg = checkLoginRateLimit(clientIp);
  if (rateLimitMsg) {
    return res.status(429).json({ ok: false, error: rateLimitMsg });
  }

  const { username, password, user, pass } = req.body || {};
  const u = (username !== undefined ? username : user || '').trim();
  const p = (password !== undefined ? password : pass || '');

  const verifiedUser = verifyAdminCredentials(u, p);
  if (verifiedUser) {
    recordSuccessfulLogin(clientIp);
    const { token, expiresIn } = createSession(verifiedUser.username, verifiedUser.id, verifiedUser.role, verifiedUser.display_name);
    res.setHeader('Set-Cookie', `ios_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}`);
    return res.json({
      ok: true,
      token,
      expiresIn,
      user: {
        id: verifiedUser.id,
        username: verifiedUser.username,
        role: verifiedUser.role,
        display_name: verifiedUser.display_name
      }
    });
  }

  recordFailedLogin(clientIp);
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
  const user = getUserFromReq(req);
  if (user) {
    return res.json({ ok: true, authenticated: true, user });
  }
  return res.status(401).json({ ok: false, authenticated: false, error: 'Unauthorized: Invalid or expired session' });
});

app.get('/api/me', requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// Public self-service registration (farmers creating their own account)
app.post('/api/register/public', (req, res) => {
  const { username, password, display_name } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const r = 'user'; // Public signup is always standard 'user'
  const d = display_name ? String(display_name).trim() : u;

  if (!u || u.length < 3 || u.length > 32) {
    return res.status(400).json({ ok: false, error: 'Username must be between 3 and 32 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(u)) {
    return res.status(400).json({ ok: false, error: 'Username may only contain letters, numbers, underscores, and dashes' });
  }
  if (!p || p.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  const existing = db.getUserByUsername(u);
  if (existing) {
    return res.status(409).json({ ok: false, error: 'Username already exists' });
  }

  try {
    const newUser = db.createUser({ username: u, password: p, role: r, display_name: d });
    db.logActivity('Info', 'New account registered: ' + newUser.username, null, newUser.id);
    return res.status(201).json({
      ok: true,
      user: newUser
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to create user' });
  }
});

app.post('/api/register', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role, display_name } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const r = (role === 'admin' ? 'admin' : 'user');
  const d = display_name ? String(display_name).trim() : u;

  if (!u || u.length < 3 || u.length > 32) {
    return res.status(400).json({ ok: false, error: 'Username must be between 3 and 32 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(u)) {
    return res.status(400).json({ ok: false, error: 'Username may only contain letters, numbers, underscores, and dashes' });
  }
  if (!p || p.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  const existing = db.getUserByUsername(u);
  if (existing) {
    return res.status(409).json({ ok: false, error: 'Username already exists' });
  }

  try {
    const newUser = db.createUser({ username: u, password: p, role: r, display_name: d });
    db.logActivity('Info', `New account created: ${newUser.username} (${newUser.role})`);
    return res.status(201).json({
      ok: true,
      user: newUser
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to create user' });
  }
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.listUsers();
  return res.json({ ok: true, users });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    return res.status(400).json({ ok: false, error: 'Invalid user ID' });
  }
  if (req.user && req.user.id === targetId) {
    return res.status(400).json({ ok: false, error: 'Cannot delete your own account' });
  }
  const deleted = db.deleteUser(targetId);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }
  db.logActivity('Info', `Account deleted (id: ${targetId})`);
  return res.json({ ok: true, message: 'User deleted' });
});

app.post('/api/users/:id/password', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    return res.status(400).json({ ok: false, error: 'Invalid user ID' });
  }
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ ok: false, error: "Forbidden: Cannot change another user's password" });
  }
  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }
  try {
    const updated = db.updateUserPassword(targetId, String(password));
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    db.deleteSessionsByAccount(targetId);
    db.logActivity('Info', `Password updated for user id: ${targetId}`);
    return res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to update password' });
  }
});


// ── Account-Credential Device Binding (Phase 10) ─────────────
app.post('/api/devices/bind', (req, res) => {
  const { username, password, mac, pen_name } = req.body || {};
  try {
    const result = db.bindDeviceByCredentials({
      username,
      password,
      mac,
      penName: pen_name
    });
    db.logActivity('Info', `Device ${result.device_id} bound to account ${result.username} (${result.pen_name})`, null, result.account_id);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ ok: false, error: err.message || 'Binding failed' });
  }
});

// ── Account-Credential Device Unbinding ────────────────────────
app.post(['/api/devices/unbind', '/api/device/unbind'], (req, res) => {
  const token = getSessionTokenFromReq(req) || (req.body && req.body.token);
  const rawMac = (req.body && req.body.mac) ? String(req.body.mac) : null;
  const mac = rawMac ? rawMac.trim().replace(/[:-]/g, '').toUpperCase() : null;

  let device = null;
  if (token) {
    device = db.getDeviceByToken(token);
  }
  if (!device && mac) {
    device = db.db.prepare('SELECT id, account_id, device_id, pen_name FROM device_registry WHERE device_id = ?').get(mac);
  }

  if (!device) {
    return res.status(200).json({ ok: true, message: 'Device was not bound or already unlinked.' });
  }

  db.deleteDevice(device.id, device.account_id);
  db.logActivity('Info', `Device ${device.device_id} (${device.pen_name || 'Pen'}) unlinked by device request`, null, device.account_id);
  return res.status(200).json({ ok: true, message: 'Device successfully unlinked from cloud account.' });
});

app.post('/api/devices', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { device_id, device_type, pen_name } = req.body || {};
  const dId = String(device_id || '').trim();
  if (!dId || dId.length < 2 || dId.length > 64) {
    return res.status(400).json({ ok: false, error: 'device_id is required (2-64 characters)' });
  }

  try {
    const registered = db.registerDevice({
      accountId,
      deviceId: dId,
      deviceType: device_type || 'sensor',
      penName: pen_name || ''
    });
    db.logActivity('Info', `New hardware device registered: ${dId} (${pen_name || 'Unassigned'})`, null, accountId);
    return res.status(201).json({
      ok: true,
      device: {
        id: registered.id,
        account_id: registered.account_id,
        device_id: registered.device_id,
        device_type: registered.device_type,
        pen_name: registered.pen_name,
        registered_at: registered.registered_at
      },
      token: registered.device_token
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to register device' });
  }
});

app.get('/api/devices', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  if (req.user && req.user.role === 'admin' && req.query.all === 'true') {
    const allDevices = db.db.prepare('SELECT id, account_id, device_id, device_type, pen_name, registered_at FROM device_registry ORDER BY id ASC').all();
    return res.json({ ok: true, devices: allDevices });
  }
  const devices = (typeof db.getDevicesWithStatus === "function") ? db.getDevicesWithStatus(accountId) : db.getDevicesByAccount(accountId);
  return res.json({ ok: true, devices });
});

app.delete('/api/devices/:id', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid device ID' });
  const accountId = (req.user && req.user.role === 'admin') ? null : getReqAccountId(req);
  const deleted = db.deleteDevice(targetId, accountId);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }
  db.logActivity('Info', `Device unregistered (id: ${targetId})`, null, getReqAccountId(req));
  return res.json({ ok: true, message: 'Device deleted' });
});

app.post('/api/devices/:id/rotate-token', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid device ID' });
  const accountId = (req.user && req.user.role === 'admin') ? null : getReqAccountId(req);
  const rotated = db.rotateDeviceToken(targetId, accountId);
  if (!rotated) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }
  db.logActivity('Info', `Device token rotated for ${rotated.device_id}`, null, getReqAccountId(req));
  return res.json({
    ok: true,
    token: rotated.device_token
  });
});

app.get('/api/devices/verify', requireDeviceAuth, (req, res) => {
  return res.json({
    ok: true,
    registered: true,
    device: req.device,
    account_id: req.user.id
  });
});

app.post('/api/time', requireAuth, (req, res) => {
  const epoch = (req.body && req.body.epoch) || Math.floor(Date.now() / 1000);
  return res.json({ ok: true, epoch, rtcOk: true });
});

app.get('/api/reports/summary', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  res.json({ ...db.reportSummary(accountId), source: 'sqlite', supportedRanges: Object.keys(REPORT_RANGES) });
});


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

app.post('/api/readings', requireDeviceAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { temp, humidity, device_id } = req.body;

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
    device_id,
    accountId
  });
  invalidateStatusCache(accountId);


  // Activity log
  const thiThresholds = db.getTHIThresholds(accountId);

  const status =
    thiLevel(thi, thiThresholds);

  db.logActivity('Mist', `DHT22 reading — Temp ${temp}°C, Humidity ${humidity}%, THI ${thi} (${status.label})`, null, accountId);


  // Temperature threshold
  const threshold = parseFloat(db.getSetting('threshold', '32', accountId));

  if (temp > threshold) {

    db.logActivity('Mist', `Misting condition met — Temp ${temp}°C exceeded threshold ${threshold}°C`, null, accountId);
  }


  // THI alerts
  if (thi >= thiThresholds.extremeMax) {

    db.logActivity('Alert', `DANGER: THI ${thi} — immediate cooling required`, null, accountId);

  } else if (thi >= thiThresholds.stressMax) {

    db.logActivity('Alert', `WARNING: Extreme heat stress detected (THI ${thi})`, null, accountId);
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

app.post('/api/water', requireDeviceAuth, (req, res) => {
  const accountId = getReqAccountId(req);
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

  const prev = db.latestWater(accountId);


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
    other_l: typeof other_l === 'number' ? other_l : null,
    accountId
  });


  // Low water alert
  if (
    finalLevel != null &&
    finalLevel < 20 &&
    (!prev || prev.level_pct >= 20)
  ) {

    db.logActivity('Alert', `LOW WATER: Tank level critical (${Math.round(finalLevel)}%)`, null, accountId);
  }


  invalidateStatusCache(accountId);
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
  const accountId = getReqAccountId(req);
  const now = Date.now();
  const cached = statusCache.get(accountId);
  if (cached && (now - cached.ts < STATUS_CACHE_TTL_MS)) {
    return res.json(cached.data);
  }

  const reading = db.latestReading(accountId);
  const water = db.latestWater(accountId);
  const threshold = parseFloat(db.getSetting('threshold', '32', accountId));
  const thiThresholds = db.getTHIThresholds(accountId);
  const operationDurations = db.getOperationDurations(accountId);


  /* ----------------------------------------------------------
     GET SCHEDULES FROM SQLITE DATABASE
     ---------------------------------------------------------- */

  const bathSchedules = db.listSchedules('bath', accountId);
  const cleanSchedules = db.listSchedules('clean', accountId);


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

  const diagnostics = db.latestDiagnostics(accountId);

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
  const telem = db.latestTelemetry ? db.latestTelemetry(accountId) : null;
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

  const waterUsedToday = db.getTodayWaterUsage ? db.getTodayWaterUsage(accountId) : 0;
  const waterUsed = waterUsedToday;
  const waterUsedSinceBoot = water ? (water.used_l || 0) : 0;
  const waterUsage = db.getWaterUsage ? db.getWaterUsage('7d', accountId) : null;


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
    syncedCount: db.pendingOfflineCount ? db.pendingOfflineCount(accountId) : (sdDetails ? (sdDetails.syncedCount || 0) : 0),
    lastSyncTs: db.latestSyncTs ? db.latestSyncTs(accountId) : (sdDetails ? (sdDetails.lastSyncTs || null) : null),
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

  statusCache.set(accountId, { ts: Date.now(), data: statusPayload });
  res.json(statusPayload);
});


/* ============================================================
   READINGS HISTORY
   ============================================================ */

app.get('/api/readings/history', (req, res) => {
  const accountId = getReqAccountId(req);

  const range =
    req.query.range || '24h';

  const until =
    req.query.until ? Number(req.query.until) : Date.now();

  const since =
    req.query.since ? Number(req.query.since) : (range === 'all' ? 0 : until - (REPORT_RANGES[range] || REPORT_RANGES['24h']));

  const points = db.getAggregatedReadings({
      range,
      sinceMs: since,
      untilMs: until,
      accountId
    });

  res.json(points);
});


/* ============================================================
   WATER USAGE & WEEKLY SUMMARY
   ============================================================ */

app.get('/api/water/usage', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const range = req.query.range || '7d';
  res.json(db.getWaterUsage(range, accountId));
});

app.get('/api/water/weekly', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  res.json(db.weeklyWaterUsage(undefined, accountId));
});

app.get('/api/water/breakdown', requireAuth, (req, res) => {
  const range = req.query.range || 'today';
  const validRanges = ['today', '7d', '30d'];
  if (!validRanges.includes(range)) {
    return res.status(400).json({ ok: false, error: `range must be one of: ${validRanges.join(', ')}` });
  }
  const dbRange = range === 'today' ? '24h' : range;
  const accountId = getReqAccountId(req);
  const usage = db.getWaterUsage(dbRange, accountId);
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


/* ============================================================
   BIDIRECTIONAL ADDITIVE-ONLY ACCOUNTING SYNC (PHASE 14)
   ============================================================ */

app.post('/api/sync/schedules', requireDeviceAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const deviceSchedules = Array.isArray(req.body) ? req.body : (req.body && req.body.schedules ? req.body.schedules : []);
  const result = db.syncSchedulesAccounting(deviceSchedules, accountId);
  return res.json({
    ok: true,
    added_to_cloud: result.added,
    schedules: result.schedules
  });
});

app.post('/api/sync/settings', requireDeviceAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { temp_threshold, mist_on_sec, mist_pause_sec, thi_normal, thi_stress, thi_extreme } = req.body || {};

  if (typeof temp_threshold === 'number' && temp_threshold >= 20 && temp_threshold <= 50) {
    db.setSetting('threshold', temp_threshold, accountId);
  }
  if (typeof mist_on_sec === 'number' || typeof mist_pause_sec === 'number') {
    db.setOperationDurations({ mistOnSec: mist_on_sec, mistPauseSec: mist_pause_sec }, accountId);
  }
  if (typeof thi_normal === 'number' || typeof thi_stress === 'number' || typeof thi_extreme === 'number') {
    db.setTHIThresholds({ normalMax: thi_normal, stressMax: thi_stress, extremeMax: thi_extreme }, accountId);
  }

  const curThreshold = parseFloat(db.getSetting('threshold', '32', accountId));
  const curDurations = db.getOperationDurations(accountId);
  const curThi = db.getTHIThresholds(accountId);

  return res.json({
    ok: true,
    settings: {
      threshold: curThreshold,
      durations: curDurations,
      thi: curThi
    }
  });
});

app.get('/api/schedules', (req, res) => {
  const accountId = getReqAccountId(req);
  const type = req.query.type;
  if (type === 'all') return res.json(['bath', 'clean'].flatMap(t => db.listSchedules(t, accountId)));


  if (
    !['bath', 'clean']
      .includes(type)
  ) {

    return res.status(400).json({
      error:
        'type must be bath or clean'
    });
  }


  res.json(db.listSchedules(type, accountId));
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

  const accountId = getReqAccountId(req);
  if (db.scheduleCount(accountId) >= 20) {
    return res.status(409).json({ error: 'Maximum of 20 backend schedules reached. Delete an unused schedule first.' });
  }


  const row = db.createSchedule({
      type,
      label: parsed.value.label,
      time: parsed.value.time,
      duration: parsed.value.duration,
      days: parsed.value.days,
      accountId
    });


  const typeLabel = type === 'bath' ? 'Bath' : type === 'clean' ? 'Clean' : 'Mist';
  db.logActivity(
    typeLabel,
    `New ${type} schedule created: "${row.label}" at ${row.time} for ${row.duration} min on ${JSON.parse(row.days).join(', ')}`,
    null,
    accountId
  );

  invalidateStatusCache(accountId);

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
  const accountId = getReqAccountId(req);
  const parsed = parseScheduleInput(req.body, { partial: true });

  if (!parsed.ok) {
    return res.status(400).json({
      error: parsed.error
    });
  }

  const targetAccountId = req.user && req.user.role === 'admin' ? null : accountId;
  const row = db.updateSchedule(req.params.id, parsed.value, targetAccountId);

  if (!row) {
    return res.status(404).json({
      error: 'Schedule not found'
    });
  }

  db.logActivity(
    row.type === 'bath' ? 'Bath' : 'Clean',
    `Schedule "${row.label}" updated: ${row.time}, ${row.duration} min, ${JSON.parse(row.days).join(', ')}, ${row.active ? 'enabled' : 'disabled'}`,
    null,
    row.account_id || accountId
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
  const accountId = getReqAccountId(req);
  const targetAccountId = req.user && req.user.role === 'admin' ? null : accountId;
  const result = db.deleteSchedule(req.params.id, targetAccountId);
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
  const accountId = getReqAccountId(req);

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
    bath: db.listSchedules('bath', accountId).map(annotate),
    clean: db.listSchedules('clean', accountId).map(annotate)
  });
});


/* ============================================================
   TEMPERATURE THRESHOLD
   ============================================================ */

app.get('/api/settings/threshold', (req, res) => {
  const accountId = getReqAccountId(req);
  res.json({ value: parseFloat(db.getSetting('threshold', '32', accountId)) });
});


app.post('/api/settings/threshold', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { value } = req.body;


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


  db.setSetting('threshold', value, accountId);
  db.logActivity('Info', `Mist cooling threshold updated to ${value}°C`, null, accountId);

  invalidateStatusCache();

  res.json({
    value
  });
});


/* ============================================================
   OPERATION DURATIONS
   ============================================================ */

app.get('/api/settings/durations', (req, res) => {
  const accountId = getReqAccountId(req);
  res.json(db.getOperationDurations(accountId));
});


app.post('/api/settings/durations', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { mistOnSec, mistPauseSec } = req.body;


  const updated = db.setOperationDurations({
      mistOnSec: typeof mistOnSec === 'number' ? mistOnSec : undefined,
      mistPauseSec: typeof mistPauseSec === 'number' ? mistPauseSec : undefined
    }, accountId);


  db.logActivity('Info', `Operation durations updated: Misting ${updated.mistOnSec} s ON / ${updated.mistPauseSec} s pause`, null, accountId);

  invalidateStatusCache();

  res.json(updated);
});


/* ============================================================
   THI THRESHOLDS
   ============================================================ */

app.get('/api/settings/thi', (req, res) => {
  const accountId = getReqAccountId(req);
  res.json(db.getTHIThresholds(accountId));
});


app.post('/api/settings/thi', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);
  const { normalMax, stressMax, extremeMax } = req.body;


  const updated = db.setTHIThresholds({
      normalMax: typeof normalMax === 'number' ? normalMax : undefined,
      stressMax: typeof stressMax === 'number' ? stressMax : undefined,
      extremeMax: typeof extremeMax === 'number' ? extremeMax : undefined
    }, accountId);


  db.logActivity('Alert', `THI thresholds updated: Normal<${updated.normalMax}, Stress<=${updated.stressMax}, Extreme<=${updated.extremeMax}`, null, accountId);

  invalidateStatusCache();

  res.json(updated);
});


/* ============================================================
   SYSTEM REPORT CSV
   ============================================================ */

app.get('/api/reports/export', requireAuth, (req, res) => {
  const accountId = getReqAccountId(req);

  const type =
    req.query.type;

  const range =
    req.query.range || '24h';

  const until =
    req.query.until ? Number(req.query.until) : Date.now();

  const since =
    req.query.since ? Number(req.query.since) : (range === 'all' ? 0 : until - (REPORT_RANGES[range] || REPORT_RANGES['24h']));

  if (type === 'water') {
    const report = db.getWaterUsage(range, accountId);
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
    const points = db.getAggregatedReadings({ range, sinceMs: since, untilMs: until, accountId });
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
  for (const r of db.rawReadingsIterator(since, until, accountId)) {
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
  const accountId = getReqAccountId(req);

  const limit =
    Math.min(500, Math.max(1, parseInt(
      req.query.limit
    ) || 30));


  res.json(
    db.recentActivity(limit, reportSince(req.query.range || 'all'), accountId)
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
  const accountId = getReqAccountId(req);
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
    ts,
    accountId
  });

  const sdStr = sd_ok === true ? 'PASS' : (sd_ok === false ? 'FAIL' : 'UNKNOWN');

  db.logActivity(
    'Info',
    `ESP32 hardware status update: DHT:${dht_ok ? 'PASS' : 'FAIL'}, RTC:${rtc_ok ? 'PASS' : 'FAIL'}, Tank:${tank_ok ? 'PASS' : 'FAIL'}, Flow:${flow_ok ? 'PASS' : 'FAIL'}, Relay:${relay_ok ? 'PASS' : 'FAIL'}, SD:${sdStr}`,
    null,
    accountId
  );


  res.status(201).json({

    ok: true,

    diagnostics:
      db.latestDiagnostics(accountId)
  });
});


app.get('/api/diagnostics', (req, res) => {
  const accountId = getReqAccountId(req);
  const latest = db.latestDiagnostics(accountId);
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
  const accountId = getReqAccountId(req);
  const diagnostics = db.latestDiagnostics(accountId);
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
    syncedCount: db.pendingOfflineCount ? db.pendingOfflineCount(accountId) : (sdDetails ? (sdDetails.syncedCount || 0) : 0),
    lastSyncTs: db.latestSyncTs ? db.latestSyncTs(accountId) : (sdDetails ? (sdDetails.lastSyncTs || 0) : 0),
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

app.post('/api/readings/batch', requireDeviceAuth, (req, res) => {
  const accountId = getReqAccountId(req);

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

  const result = db.insertOfflineBatch(records, accountId);

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
  const accountId = getReqAccountId(req);
  res.json({
    ok: true,
    totalSynced: db.pendingOfflineCount(accountId),
    lastSyncTs: db.latestSyncTs(accountId)
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
