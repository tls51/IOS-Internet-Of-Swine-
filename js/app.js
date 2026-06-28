/* ============================================================
   app.js — Application bootstrap, login, navigation, ticker
   ============================================================ */

(function () {

  /* ── State ───────────────────────────────────────────────── */
  let activePage = 'dashboard';
  let threshold  = 32;

  /* ── Clock ───────────────────────────────────────────────── */
  function startClock() {
    const el = document.getElementById('live-time');
    function tick() { el.textContent = new Date().toLocaleTimeString(); }
    tick();
    setInterval(tick, 1000);
  }

  /* ── Navigation ──────────────────────────────────────────── */
  const PAGE_TITLES = {
    dashboard: 'Dashboard',
    env:       'Environmental Data',
    water:     'Water Management',
    bath:      'Bathing Schedule',
    clean:     'Cleaning Schedule',
    auto:      'Automatic Systems',
    reports:   'Reports',
  };

  function showPage(key) {
    activePage = key;

    /* toggle sections */
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${key}`);
    if (target) target.classList.add('active');

    /* nav highlight */
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.page === key);
    });

    /* update title */
    document.getElementById('page-title').textContent = PAGE_TITLES[key] || key;

    /* render page immediately on switch */
    PAGES.update(DATA.state, activePage, threshold);
  }

  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    });
  }

  /* ── Threshold slider ────────────────────────────────────── */
  function initThresholdSlider() {
    const slider = document.getElementById('threshold-slider');
    const valEl  = document.getElementById('threshold-val');
    if (!slider) return;
    slider.addEventListener('input', () => {
      threshold = parseInt(slider.value);
      DATA.state.threshold = threshold;
      valEl.textContent = threshold + '°C';
      PAGES.updateAuto(DATA.state, threshold);
    });
  }

  /* ── Range tabs (reports) ────────────────────────────────── */
  function initRangeTabs() {
    document.querySelectorAll('.range-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        PAGES.updateReports(DATA.state);
      });
    });
  }

  /* ── Login ───────────────────────────────────────────────── */
  function initLogin() {
    const loginScreen = document.getElementById('login-screen');
    const appShell    = document.getElementById('app-shell');
    const errEl       = document.getElementById('login-err');

    function tryLogin() {
      const user = document.getElementById('inp-user').value.trim();
      const pass = document.getElementById('inp-pass').value;
      if (user === 'admin' && pass === 'ios2024') {
        loginScreen.classList.add('hidden');
        appShell.classList.remove('hidden');
        boot();
      } else {
        errEl.textContent = 'Invalid credentials. Try admin / ios2024';
        errEl.classList.remove('hidden');
      }
    }

    document.getElementById('btn-login').addEventListener('click', tryLogin);
    ['inp-user','inp-pass'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') tryLogin();
      });
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
      DATA.stop();
      appShell.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      document.getElementById('inp-user').value = '';
      document.getElementById('inp-pass').value = '';
      errEl.classList.add('hidden');
    });
  }

  /* ── Live data ticker ────────────────────────────────────── */
  function initTicker() {
    DATA.onTick(state => {
      PAGES.update(state, activePage, threshold);
    });
    DATA.start();
  }

  /* ── Boot (called after login) ───────────────────────────── */
  function boot() {
    startClock();
    initNav();
    SCHEDULE.init();
    initThresholdSlider();
    initRangeTabs();

    /* initial render */
    showPage('dashboard');
    initTicker();
  }

  /* ── Entry point ─────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    initLogin();
  });

})();
