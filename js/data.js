/* ============================================================
   data.js — Sensor simulation & shared application state
   ============================================================ */

const DATA = (() => {

  /* ── Config ─────────────────────────────────────────────── */
  const TICK_MS = 3000;   // live update interval

  /* ── THI formula ─────────────────────────────────────────── */
  function calcTHI(temp, humidity) {
    return parseFloat((0.8 * temp + (humidity * temp - 14.4) / 100 + 46.4).toFixed(1));
  }

  /* ── THI classification ──────────────────────────────────── */
  function thiLevel(thi) {
    if (thi < 75) return { label: 'Normal',       cls: 'badge-blue',   color: '#3B82F6' };
    if (thi < 78) return { label: 'Stressful',    cls: 'badge-warn',   color: '#F59E0B' };
    if (thi < 83) return { label: 'Extreme Heat', cls: 'badge-orange', color: '#F97316' };
    return               { label: 'Danger Zone',  cls: 'badge-danger', color: '#EF4444' };
  }

  /* ── Generate 24-h history ───────────────────────────────── */
  function genHistory(n = 24) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => {
      const t = new Date(now - (n - 1 - i) * 60 * 60 * 1000);
      const h = t.getHours();
      const temp     = parseFloat((28 + 6 * Math.sin((h - 6) * Math.PI / 12) + (Math.random() - .5) * 2).toFixed(1));
      const humidity = parseFloat((68 + 10 * Math.sin((h - 10) * Math.PI / 12) + (Math.random() - .5) * 3).toFixed(1));
      const thi      = calcTHI(temp, humidity);
      return { time: String(t.getHours()).padStart(2, '0') + ':00', temp, humidity, thi };
    });
  }

  /* ── Generate weekly water history ──────────────────────── */
  function genWeeklyWater() {
    return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => ({
      day,
      mist:  Math.round(50 + Math.random() * 80),
      bathe: Math.round(30 + Math.random() * 40),
      clean: Math.round(20 + Math.random() * 30),
    }));
  }

  /* ── Live state ──────────────────────────────────────────── */
  const history = genHistory();
  const last    = history[history.length - 1];

  const state = {
    temp:       last.temp,
    humidity:   last.humidity,
    thi:        last.thi,
    waterLevel: 54,
    waterUsed:  187,
    flowRate:   2.4,
    mistActive: false,
    bathActive: false,
    cleanActive:false,
    history,
    weeklyWater: genWeeklyWater(),
    threshold:   32,
  };

  /* ── Tick ────────────────────────────────────────────────── */
  let _listeners = [];

  function onTick(cb) { _listeners.push(cb); }

  function tick() {
    const prev = state.history[state.history.length - 1];
    const now  = new Date();
    const temp     = parseFloat(Math.max(20, Math.min(42, prev.temp + (Math.random() - .5) * .5)).toFixed(1));
    const humidity = parseFloat(Math.max(40, Math.min(99, prev.humidity + (Math.random() - .5) * .6)).toFixed(1));
    const thi      = calcTHI(temp, humidity);
    const point    = { time: String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0'), temp, humidity, thi };

    state.history = [...state.history.slice(1), point];
    state.temp       = temp;
    state.humidity   = humidity;
    state.thi        = thi;
    state.mistActive = temp > state.threshold;
    if (state.mistActive) state.waterUsed = parseFloat((state.waterUsed + .05).toFixed(2));

    _listeners.forEach(fn => fn(state));
  }

  let _interval = null;
  function start() { _interval = setInterval(tick, TICK_MS); }
  function stop()  { clearInterval(_interval); }

  return { state, thiLevel, onTick, start, stop, calcTHI };
})();
