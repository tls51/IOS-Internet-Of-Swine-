/* ============================================================
   config.js — points the dashboard at the host that served it.
   apiBase is empty so all fetch() calls use relative paths
   (e.g. /api/status). This works when the dashboard is served
   by the Node backend OR by the ESP32 LittleFS server.

   Do not hardcode hosts or IPs. Opening index.html as file://
   will reject relative fetches; serve it from the device or
   the Node backend instead.
   ============================================================ */

const IOS_CONFIG = {
  apiBase: '',             // relative URLs — /api/status etc.

  pollMs: 3000,        // how often the dashboard polls /api/status
  historyPollMs: 30000, // how often chart history/weekly data refreshes
  mode: 'device'       // 'device' | 'cloud' — from GET /api/info
};

/* ── Access Token Storage & Prompt ────────────────────────── */
const AUTH_STORAGE_KEY = 'ios_auth_token';

function getAuthToken() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || '';
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(AUTH_STORAGE_KEY, token.trim());
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

function promptForToken(message) {
  const msg = message || 'Control operations require authorization.\nPlease enter the device access token:';
  const entered = window.prompt(msg, getAuthToken());
  if (entered !== null && entered.trim() !== '') {
    const trimmed = entered.trim();
    setAuthToken(trimmed);
    return trimmed;
  }
  return null;
}

/* ── Auth Fetch Wrapper for Control Routes ─────────────────── */
async function authFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const isControl = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);

  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };

  if (isControl) {
    let token = getAuthToken();
    if (!token) {
      token = promptForToken('Enter device access token to perform this control action:');
    }
    if (token) {
      opts.headers['X-Auth-Token'] = token;
      opts.headers['Authorization'] = `Bearer ${token}`;
    }
  }

  let res = await fetch(url, opts);

  // If 401 Unauthorized, prompt the user with server message and retry once
  if (res.status === 401 && isControl) {
    let errMsg = 'Unauthorized: Invalid or missing access token.';
    try {
      const cloned = res.clone();
      const data = await cloned.json();
      if (data && (data.error || data.msg)) {
        errMsg = data.error || data.msg;
      }
    } catch (_) {}

    const newToken = promptForToken(`${errMsg}\n\nPlease enter the correct access token:`);
    if (newToken) {
      opts.headers['X-Auth-Token'] = newToken;
      opts.headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(url, opts);
    }
  }

  return res;
}

window.authFetch = authFetch;
window.getAuthToken = getAuthToken;
window.setAuthToken = setAuthToken;
window.promptForToken = promptForToken;

IOS_CONFIG.authFetch = authFetch;
IOS_CONFIG.getAuthToken = getAuthToken;
IOS_CONFIG.setAuthToken = setAuthToken;

function applyDataMode(mode) {
  const resolved = (mode === 'cloud') ? 'cloud' : 'device';
  IOS_CONFIG.mode = resolved;
  document.querySelectorAll('[data-mode]').forEach((el) => {
    const tokens = (el.getAttribute('data-mode') || '').trim().split(/\s+/).filter(Boolean);
    el.hidden = tokens.length > 0 && tokens.indexOf(resolved) === -1;
  });
}

async function fetchHostMode() {
  try {
    const res = await fetch((IOS_CONFIG.apiBase || '') + '/api/info');
    if (!res.ok) throw new Error('GET /api/info failed');
    const data = await res.json();
    applyDataMode(data && data.mode);
  } catch (err) {
    applyDataMode('device');
  }
}

fetchHostMode();
