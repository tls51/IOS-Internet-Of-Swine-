/* ============================================================
   data.js — Live application state, backed by the IoS backend
   (Node.js + SQLite) which the ESP32 pushes sensor readings to.
   Public interface is unchanged from the old simulator version,
   so pages.js / app.js / schedule.js don't need to know the data
   is now real: state, thiLevel, onTick, start, stop, calcTHI.
   ============================================================ */

const DATA = (() => {

  const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';
  const POLL_MS         = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.pollMs        : 3000;
  const HISTORY_POLL_MS = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.historyPollMs : 30000;

  /* ── THI classification (kept local so charts/needles/boxes
     that color themselves off state.thi keep working exactly
     as before) ────────────────────────────────────────────── */
  function thiLevel(thi) {
    if (thi == null)   return { label: '—',           cls: 'badge-muted',  color: '#8B949E' };
    if (thi < 75) return { label: 'Normal',       cls: 'badge-blue',   color: '#3B82F6' };
    if (thi < 78) return { label: 'Stressful',    cls: 'badge-warn',   color: '#F59E0B' };
    if (thi < 83) return { label: 'Extreme Heat', cls: 'badge-orange', color: '#F97316' };
    return               { label: 'Danger Zone',  cls: 'badge-danger', color: '#EF4444' };
  }

  function calcTHI(temp, humidity) {
    return parseFloat((0.8 * temp + (humidity * temp - 14.4) / 100 + 46.4).toFixed(1));
  }

  /* ── Live state (same shape pages.js already expects) ─────── */
  const state = {
    temp: null, humidity: null, thi: null,
    waterLevel: null, waterUsed: 0, flowRate: 0,
    mistActive: false, bathActive: false, cleanActive: false,
    history: [],
    weeklyWater: [],
    threshold: 32,
    connected: false,
  };

  let _listeners = [];
  function onTick(cb) { _listeners.push(cb); }
  function notify() { _listeners.forEach(fn => fn(state)); }

  /* ── Fetch helpers ──────────────────────────────────────── */
  async function getJSON(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  /* ── Poll /api/status: temp, humidity, thi, water, systems ── */
  async function refreshStatus() {
    try {
      const s = await getJSON('/api/status');
      state.temp        = s.temp;
      state.humidity     = s.humidity;
      state.thi           = s.thi;
      state.waterLevel   = s.waterLevel;
      state.waterUsed     = s.waterUsed || 0;
      state.flowRate      = s.flowRate || 0;
      state.mistActive   = !!s.mistActive;
      state.bathActive    = !!s.bathActive;
      state.cleanActive   = !!s.cleanActive;
      state.threshold     = s.threshold;
      state.connected     = true;
    } catch (err) {
      state.connected = false;
      console.warn('IoS backend unreachable — is `npm start` running in ios-backend/?', err.message);
    }
    notify();
  }

  /* ── Poll /api/readings/history: chart line data ──────────── */
  async function refreshHistory() {
    try {
      const rows = await getJSON('/api/readings/history?range=24h');
      if (rows.length) state.history = rows;
    } catch (err) { /* keep last-known history on failure */ }

    try {
      const weekly = await getJSON('/api/water/weekly');
      state.weeklyWater = weekly;
    } catch (err) { /* keep last-known weekly data on failure */ }

    notify();
  }

  /* ── Intervals ──────────────────────────────────────────── */
  let _statusTimer = null;
  let _historyTimer = null;

  function start() {
    refreshStatus();
    refreshHistory();
    _statusTimer  = setInterval(refreshStatus, POLL_MS);
    _historyTimer = setInterval(refreshHistory, HISTORY_POLL_MS);
  }

  function stop() {
    clearInterval(_statusTimer);
    clearInterval(_historyTimer);
  }

  return { state, thiLevel, onTick, start, stop, calcTHI, refreshStatus, refreshHistory };
})();
