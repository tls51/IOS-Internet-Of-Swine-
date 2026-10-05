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
