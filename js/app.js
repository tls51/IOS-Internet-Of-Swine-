/* ============================================================
   app.js — Application bootstrap, login, navigation, ticker
   ============================================================ */

(function () {

  /* ── Session helpers (survive refresh) ───────────────────── */
  const SESSION_KEY  = 'ios_logged_in';
  const PAGE_KEY     = 'ios_active_page';

  function saveSession() {
    sessionStorage.setItem(SESSION_KEY, '1');
    sessionStorage.setItem(PAGE_KEY, activePage);
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PAGE_KEY);
  }

  function isSessionActive() {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  }

  function savedPage() {
    return sessionStorage.getItem(PAGE_KEY) || 'dashboard';
  }

  /* ── State ───────────────────────────────────────────────── */
  let activePage = 'dashboard';

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

    /* persist current page so refresh returns here */
    saveSession();

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
    PAGES.update(DATA.state, activePage);
  }

  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    });
  }

  /* ── Threshold slider (editable — saves to backend) ─────── */
  function initThresholdSlider() {
    const slider = document.getElementById('threshold-slider');
    const valEl  = document.getElementById('threshold-val');
    if (!slider) return;

    /* Make it editable */
    slider.disabled = false;
    slider.title    = 'Drag to change the mist cooling threshold';

    /* Live preview while dragging */
    slider.addEventListener('input', () => {
      if (valEl) valEl.textContent = slider.value + '°C';
    });

    /* Save to backend when the user releases */
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';
    slider.addEventListener('change', () => {
      const newVal = parseFloat(slider.value);
      if (valEl) valEl.textContent = newVal + '°C';

      fetch(`${API}/api/settings/threshold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newVal }),
      }).then(() => {
        DATA.state.threshold = newVal;
        PAGES.update(DATA.state, activePage);
      }).catch(err => console.warn('Could not save threshold:', err));
    });
  }

  /* ── THI Thresholds controls (editable — saves to backend) ── */
  function initTHIThresholdControls() {
    const btnSave = document.getElementById('btn-save-thi');
    const inpNorm = document.getElementById('inp-thi-normal');
    const inpStress = document.getElementById('inp-thi-stress');
    const inpExtreme = document.getElementById('inp-thi-extreme');
    const statusEl = document.getElementById('thi-save-status');
    if (!btnSave || !inpNorm || !inpStress || !inpExtreme) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';

    btnSave.addEventListener('click', () => {
      const normalMax = parseFloat(inpNorm.value);
      const stressMax = parseFloat(inpStress.value);
      const extremeMax = parseFloat(inpExtreme.value);

      if (isNaN(normalMax) || isNaN(stressMax) || isNaN(extremeMax)) {
        alert('Please enter valid numeric values for all thresholds.');
        return;
      }
      if (normalMax >= stressMax || stressMax >= extremeMax) {
        alert('Thresholds must be strictly increasing: Normal Max < Stress Max < Extreme Max.');
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';

      fetch(`${API}/api/settings/thi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalMax, stressMax, extremeMax }),
      })
      .then(res => {
        if (!res.ok) throw new Error('Failed to save THI thresholds');
        return res.json();
      })
      .then(data => {
        DATA.state.thiThresholds = data;
        PAGES.update(DATA.state, activePage);
        if (statusEl) {
          statusEl.classList.remove('hidden');
          setTimeout(() => statusEl.classList.add('hidden'), 3500);
        }
      })
      .catch(err => {
        console.error('Error saving THI thresholds:', err);
        alert('Failed to save THI thresholds: ' + err.message);
      })
      .finally(() => {
        btnSave.disabled = false;
        btnSave.textContent = 'Save Thresholds';
      });
    });
  }

  /* ── Operation Durations controls (editable — saves to backend) ── */
  function initOperationDurationControls() {
    const btnSave  = document.getElementById('btn-save-durations');
    const inpDur   = document.getElementById('inp-mist-dur');
    const inpPause = document.getElementById('inp-mist-pause');
    const statusEl = document.getElementById('dur-save-status');
    if (!btnSave || !inpDur || !inpPause) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';

    btnSave.addEventListener('click', () => {
      const mistDurationMin = parseFloat(inpDur.value);
      const mistPauseSec    = parseFloat(inpPause.value);

      if (isNaN(mistDurationMin) || isNaN(mistPauseSec) || mistDurationMin < 1 || mistPauseSec < 1) {
        alert('Please enter valid positive numbers for misting duration and pause interval.');
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';

      fetch(`${API}/api/settings/durations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mistDurationMin, mistPauseSec }),
      })
      .then(res => {
        if (!res.ok) throw new Error('Failed to save operation durations');
        return res.json();
      })
      .then(data => {
        DATA.state.operationDurations = data;
        PAGES.update(DATA.state, activePage);
        if (statusEl) {
          statusEl.classList.remove('hidden');
          setTimeout(() => statusEl.classList.add('hidden'), 3500);
        }
      })
      .catch(err => {
        console.error('Error saving operation durations:', err);
        alert('Failed to save operation durations: ' + err.message);
      })
      .finally(() => {
        btnSave.disabled = false;
        btnSave.textContent = 'Save Durations';
      });
    });
  }

  /* ── Range tabs (reports) & CSV Export ───────────────────── */
  function initRangeTabs() {
    document.querySelectorAll('.range-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        PAGES.updateReports(DATA.state);
      });
    });
  }

  function initCSVExport() {
    const btnExport = document.getElementById('btn-export-csv');
    if (!btnExport) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';

    btnExport.addEventListener('click', () => {
      const activeTab = document.querySelector('.range-tab.active');
      const range = activeTab ? activeTab.dataset.range : '24h';
      window.location.href = `${API}/api/reports/export?range=${range}`;
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
        saveSession();
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
      clearSession();
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
      PAGES.update(state, activePage);
    });
    DATA.start();
  }

  /* ── Boot (called after login) ───────────────────────────── */
  async function boot() {
    startClock();
    initNav();
    SCHEDULE.init();
    initThresholdSlider();
    initTHIThresholdControls();
    initOperationDurationControls();
    initRangeTabs();
    initCSVExport();

    /* fetch real data once before first paint, then start polling */
    await DATA.refreshStatus();
    await DATA.refreshHistory();
    showPage(savedPage());
    initTicker();
  }

  /* ── Entry point ─────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    initLogin();

    /* Auto-resume session after a page refresh */
    if (isSessionActive()) {
      const loginScreen = document.getElementById('login-screen');
      const appShell    = document.getElementById('app-shell');
      loginScreen.classList.add('hidden');
      appShell.classList.remove('hidden');
      boot();
    }
  });

})();
