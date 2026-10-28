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
  mode: 'device',      // 'device' | 'cloud' — from GET /api/info
  authRequired: true,
  reportApiBase: '',   // Node archive when discovered from the ESP32
  reportSource: 'device',
};

/* ── Access Token Storage & Compatibility ────────────────────── */
const AUTH_STORAGE_KEY = 'ios_auth_token';
const SESSION_STORAGE_KEY = 'ios_session_token';

function getAuthToken() {
  // localStorage survives page refresh and tab close; sessionStorage is a live-session cache
  return localStorage.getItem(SESSION_STORAGE_KEY)
    || sessionStorage.getItem(SESSION_STORAGE_KEY)
    || localStorage.getItem(AUTH_STORAGE_KEY)
    || '';
}

function setAuthToken(token) {
  if (token) {
    const t = token.trim();
    localStorage.setItem(SESSION_STORAGE_KEY, t);   // durable across refreshes
    sessionStorage.setItem(SESSION_STORAGE_KEY, t); // fast live-session access
    localStorage.setItem(AUTH_STORAGE_KEY, t);      // backward compat key
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

function promptForToken(message) {
  const msg = message || 'Control operations require authorization.\nPlease enter the device access token:';
  const currentToken = (typeof getAuthToken === 'function') ? getAuthToken() : '';
  const entered = window.prompt(msg, currentToken);
  if (entered !== null) {
    const trimmed = entered.trim();
    setAuthToken(trimmed);
    return trimmed;
  }
  return null;
}

/* ── Auth Fetch Wrapper for Control Routes ─────────────────── */
async function authFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };
  opts.credentials = opts.credentials || 'include';

  // Automatically attach active session token if present
  const token = getAuthToken();
  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, opts);

  // If 401 Unauthorized, notify dashboard to show login screen with error, without prompt() popup
  if (res.status === 401) {
    let errMsg = 'Unauthorized: Invalid or expired session.';
    try {
      const cloned = res.clone();
      const data = await cloned.json();
      if (data && (data.error || data.msg)) {
        errMsg = data.error || data.msg;
      }
    } catch (_) {}

    if (typeof window.handleSessionExpired === 'function') {
      window.handleSessionExpired(errMsg);
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
IOS_CONFIG.promptForToken = promptForToken;

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
    IOS_CONFIG.authRequired = !!data.authRequired;
    IOS_CONFIG.reportSource = IOS_CONFIG.mode;
    if (data.backendUrl) {
      try {
        const health = await fetch(data.backendUrl + '/api/health', { signal: AbortSignal.timeout(3000) });
        if (health.ok && (await health.json()).ok) {
          IOS_CONFIG.reportApiBase = data.backendUrl;
          IOS_CONFIG.reportSource = 'cloud';
        }
      } catch (_) { /* Standalone device history is still available. */ }
    }
  } catch (err) {
    applyDataMode('device');
  }
}

IOS_CONFIG.ready = fetchHostMode();
