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

  /* ── THI classification & calculation ───────────────────────── */
  function thiLevel(thi, thresholds = state.thiThresholds) {
    if (thi == null) return { label: '—', cls: 'badge-muted', color: '#8B949E' };
    const normalMax  = (thresholds && thresholds.normalMax != null)  ? thresholds.normalMax  : 74;
    const stressMax  = (thresholds && thresholds.stressMax != null)  ? thresholds.stressMax  : 78;
    const extremeMax = (thresholds && thresholds.extremeMax != null) ? thresholds.extremeMax : 83;

    if (thi < normalMax)   return { label: 'Normal',       cls: 'badge-blue',   color: '#3B82F6' };
    if (thi <= stressMax)  return { label: 'Stressful',    cls: 'badge-warn',   color: '#F59E0B' };
    if (thi <= extremeMax) return { label: 'Extreme Heat', cls: 'badge-orange', color: '#F97316' };
    return                        { label: 'Danger Zone',  cls: 'badge-danger', color: '#EF4444' };
  }

  function calcTHI(temp, humidity) {
    if (temp == null || humidity == null) return null;
    // Swine THI formula: THI = 0.8*T + (RH/100)*(T - 14.4) + 46.4
    const thi = 0.8 * temp + (humidity / 100.0) * (temp - 14.4) + 46.4;
    return parseFloat(thi.toFixed(1));
  }

  /* ── Live state (same shape pages.js already expects) ─────── */
  const state = {
    temp: null, humidity: null, thi: null,
    waterLevel: null, waterUsed: 0, flowRate: 0,
    mistActive: false, bathActive: false, cleanActive: false,
    history: [],
    weeklyWater: [],
    threshold: 32,
    thiThresholds: { normalMax: 74, stressMax: 78, extremeMax: 83 },
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
      state.temp          = s.temp;
      state.humidity       = s.humidity;
      state.thi             = s.thi;
      state.waterLevel     = s.waterLevel;
      state.waterUsed       = s.waterUsed || 0;
      state.flowRate        = s.flowRate || 0;
      state.mistActive     = !!s.mistActive;
      state.bathActive      = !!s.bathActive;
      state.cleanActive     = !!s.cleanActive;
      state.threshold       = s.threshold;
      if (s.thiThresholds) {
        state.thiThresholds = s.thiThresholds;
      }
      state.connected       = true;
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
