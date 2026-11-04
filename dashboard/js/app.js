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

  function clearSession(keepPage = false) {
    sessionStorage.removeItem(SESSION_KEY);
    if (!keepPage) {
      sessionStorage.removeItem(PAGE_KEY);
    }
  }

  function handleSessionExpired(message) {
    DATA.stop();
    // Wipe token from every storage location
    if (typeof setAuthToken === 'function') setAuthToken(null);
    sessionStorage.removeItem('ios_session_token');
    clearSession(true);
    const loginScreen = document.getElementById('login-screen');
    const appShell    = document.getElementById('app-shell');
    const errEl       = document.getElementById('login-err');

    if (appShell) appShell.classList.add('hidden');
    if (loginScreen) loginScreen.classList.remove('hidden');
    if (errEl) {
      errEl.textContent = message || 'Session expired. Please sign in again.';
      errEl.classList.remove('hidden');
    }
  }
  window.handleSessionExpired = handleSessionExpired;

  function isSessionActive() {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  }

  function savedPage() {
    const page = sessionStorage.getItem(PAGE_KEY);
    if (!page || page === 'mist') return 'dashboard';
    return page;
  }

  /* ── State ───────────────────────────────────────────────── */
  let activePage = 'dashboard';

  /* ── Notification System ─────────────────────────────────── */
  const NOTIFY = (() => {
    function getContainer() {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }
      return container;
    }

    const DEFAULT_ICONS = {
      success: '✅',
      info:    'ℹ️',
      warning: '⚠️',
      error:   '❌'
    };

    function show({ title, message, type = 'success', duration = 4500, icon }) {
      const container = getContainer();
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;

      const iconEmoji = icon || DEFAULT_ICONS[type] || '🔔';

      toast.innerHTML = `
        <span class="toast-icon">${iconEmoji}</span>
        <div class="toast-content">
          ${title ? `<div class="toast-title">${title}</div>` : ''}
          ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" aria-label="Close notification">×</button>
        <div class="toast-progress" style="animation-duration: ${duration}ms"></div>
      `;

      let dismissTimeout = null;

      function dismiss() {
        if (dismissTimeout) clearTimeout(dismissTimeout);
        toast.classList.add('toast-leave');
        toast.addEventListener('animationend', () => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, { once: true });
      }

      toast.querySelector('.toast-close').addEventListener('click', dismiss);
      dismissTimeout = setTimeout(dismiss, duration);

      container.appendChild(toast);

      /* Native browser notification fallback/enhancement if supported and permitted */
      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          try {
            new Notification(title || 'IoS System', {
              body: message || '',
              icon: 'pig-icon.png'
            });
          } catch (e) { /* ignore */ }
        } else if (Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      }

      return toast;
    }

    return { show };
  })();

  /* Expose globally for schedule.js and other components */
  window.NOTIFY = NOTIFY;

  /* ── Clock & Date Display ────────────────────────────────── */
  function formatCurrentDateTime(state) {
    if (state && state.rtcOk === false) {
      return {
        dateStr: 'RTC Error',
        timeStr: 'Clock Fault',
        fullStr: 'RTC Error (Clock Fault)',
        sourceStr: 'Hardware RTC Fault'
      };
    }

    let d;
    let isRtc = false;
    if (state && state.epoch != null && state.epochReceivedAt != null) {
      const elapsedSec = Math.floor((Date.now() - state.epochReceivedAt) / 1000);
      d = new Date((state.epoch + elapsedSec) * 1000);
      isRtc = true;
    } else {
      d = new Date();
    }

    const dateStr = d.toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timeStr = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });

    return {
      dateStr,
      timeStr,
      fullStr: `${dateStr} · ${timeStr}`,
      sourceStr: isRtc ? 'Hardware RTC (Synced)' : 'System Local Time'
    };
  }
  window.formatCurrentDateTime = formatCurrentDateTime;

  function updateClockDisplays(dt) {
    if (!dt) dt = formatCurrentDateTime(DATA.state);

    const elLive = document.getElementById('live-time');
    if (elLive) elLive.textContent = dt.fullStr;

    const elSideDate = document.getElementById('sidebar-clock-date');
    if (elSideDate) elSideDate.textContent = dt.dateStr;

    const elSideTime = document.getElementById('sidebar-clock-time');
    if (elSideTime) elSideTime.textContent = dt.timeStr;

    const elDashClock = document.getElementById('dash-live-datetime');
    if (elDashClock) elDashClock.textContent = dt.fullStr;

    const elDashSource = document.getElementById('dash-clock-source');
    if (elDashSource) elDashSource.textContent = dt.sourceStr;

    const elRtcLive = document.getElementById('rtc-live-datetime');
    if (elRtcLive) elRtcLive.textContent = dt.fullStr;
  }
  window.updateClockDisplays = updateClockDisplays;

  function startClock() {
    function tick() {
      updateClockDisplays();
    }
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
    users:     'User Accounts',
  };

  function showPage(key) {
    if (key === 'mist') key = 'dashboard';
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

    /* close mobile drawer */
    const sidebar  = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar)  sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');

    /* update title */
    document.getElementById('page-title').textContent = PAGE_TITLES[key] || key;

    /* render page immediately on switch */
    PAGES.update(DATA.state, activePage);
    if (key === 'reports') DATA.refreshReports();
    if (key === 'water') DATA.refreshWaterUsage();
    if (key === 'auto') loadDevicesList();
    if (key === 'users') loadUsersList();
  }

  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    });

    /* Mobile drawer toggle */
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    const sidebar   = document.getElementById('sidebar');
    const backdrop  = document.getElementById('sidebar-backdrop');

    if (toggleBtn && sidebar && backdrop) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('open');
        backdrop.classList.toggle('active');
      });

      backdrop.addEventListener('click', () => {
        sidebar.classList.remove('open');
        backdrop.classList.remove('active');
      });
    }

    /* Window resize listener to dynamically adapt charts */
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        PAGES.update(DATA.state, activePage);
      }, 150);
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
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    slider.addEventListener('change', () => {
      const newVal = parseFloat(slider.value);
      if (valEl) valEl.textContent = newVal + '°C';

      const fetchFn = (typeof authFetch === 'function') ? authFetch : (window.authFetch || fetch);
      fetchFn(`${API}/api/settings/threshold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newVal }),
      }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

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

      const fetchFn = (typeof authFetch === 'function') ? authFetch : (window.authFetch || fetch);
      fetchFn(`${API}/api/settings/thi`, {
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

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    btnSave.addEventListener('click', () => {
      const mistOnSec       = parseFloat(inpDur.value);
      const mistPauseSec    = parseFloat(inpPause.value);

      if (isNaN(mistOnSec) || isNaN(mistPauseSec) || mistOnSec < 1 || mistPauseSec < 1) {
        alert('Please enter valid positive numbers for misting duration and pause interval.');
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';

      const fetchFn = (typeof authFetch === 'function') ? authFetch : (window.authFetch || fetch);
      fetchFn(`${API}/api/settings/durations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mistOnSec, mistPauseSec }),
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
    document.querySelectorAll('#page-reports .range-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        document.querySelectorAll('#page-reports .range-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await DATA.refreshReports(btn.dataset.range);
        PAGES.updateReports(DATA.state);
      });
    });
  }

  function initCSVExport() {
    const btnExport = document.getElementById('btn-export-csv');
    if (!btnExport) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    btnExport.addEventListener('click', async () => {
      const activeTab = document.querySelector('#page-reports .range-tab.active');
      const range = activeTab ? activeTab.dataset.range : '24h';
      const base = IOS_CONFIG.reportApiBase || API;
      btnExport.disabled = true;
      try {
        const doFetch = (typeof authFetch === 'function') ? authFetch : fetch;
        const res = await doFetch(`${base}/api/reports/export?range=${range}`);
        if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `ios_system_report_${range}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      } catch (err) {
        NOTIFY.show({ title: 'Report export failed', message: err.message, type: 'error' });
      } finally { btnExport.disabled = false; }
    });
  }

  /* ── Water Range Tabs & CSV Export ──────────────────────── */
  function initWaterControls() {
    const tabs = document.querySelectorAll('#water-range-tabs .range-tab');
    tabs.forEach(btn => {
      btn.addEventListener('click', async () => {
        tabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await DATA.refreshWaterUsage(btn.dataset.range);
        PAGES.updateWater(DATA.state);
      });
    });

    const bdTabs = document.querySelectorAll('#breakdown-range-tabs .range-tab');
    bdTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        bdTabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        DATA.state.breakdownRange = btn.dataset.range;
        PAGES.updateWater(DATA.state);
      });
    });

    const btnExportWater = document.getElementById('btn-export-water-csv');
    if (!btnExportWater) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    btnExportWater.addEventListener('click', async () => {
      const activeTab = document.querySelector('#water-range-tabs .range-tab.active');
      const range = activeTab ? activeTab.dataset.range : (DATA.state.waterRange || '7d');
      const base = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.reportApiBase) ? IOS_CONFIG.reportApiBase : API;
      btnExportWater.disabled = true;
      try {
        const doFetch = (typeof authFetch === 'function') ? authFetch : fetch;
        const res = await doFetch(`${base}/api/reports/export?type=water&range=${range}`);
        if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `ios_water_report_${range}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        NOTIFY.show({
          title: 'Export Complete',
          message: `Water usage CSV (${range}) downloaded successfully.`,
          type: 'success',
          icon: '📥'
        });
      } catch (err) {
        NOTIFY.show({ title: 'Water report export failed', message: err.message, type: 'error' });
      } finally {
        btnExportWater.disabled = false;
      }
    });
  }

  /* ── Login ───────────────────────────────────────────────── */
  function initLogin() {
    const loginScreen = document.getElementById('login-screen');
    const appShell    = document.getElementById('app-shell');
    const errEl       = document.getElementById('login-err');
    const btnLogin    = document.getElementById('btn-login');
    const signinCard      = document.getElementById('signin-card');
    const registerCard    = document.getElementById('register-card');
    const btnShowRegister = document.getElementById('btn-show-register');
    const btnShowSignin   = document.getElementById('btn-show-signin');
    const btnRegister     = document.getElementById('btn-register');
    const regErrEl        = document.getElementById('register-err');

    if (btnShowRegister && signinCard && registerCard) {
      btnShowRegister.addEventListener('click', () => {
        signinCard.classList.add('hidden');
        registerCard.classList.remove('hidden');
        if (regErrEl) regErrEl.classList.add('hidden');
        const regUser = document.getElementById('reg-user');
        if (regUser) regUser.focus();
      });
    }

    if (btnShowSignin && signinCard && registerCard) {
      btnShowSignin.addEventListener('click', () => {
        registerCard.classList.add('hidden');
        signinCard.classList.remove('hidden');
        if (errEl) errEl.classList.add('hidden');
        const inpUser = document.getElementById('inp-user');
        if (inpUser) inpUser.focus();
      });
    }

    async function tryRegister() {
      const u = (document.getElementById('reg-user').value || '').trim();
      const d = (document.getElementById('reg-name').value || '').trim();
      const p = document.getElementById('reg-pass').value || '';

      if (!u || !p) {
        if (regErrEl) {
          regErrEl.textContent = 'Please provide both username and password.';
          regErrEl.classList.remove('hidden');
        }
        return;
      }
      if (u.length < 3) {
        if (regErrEl) {
          regErrEl.textContent = 'Username must be at least 3 characters.';
          regErrEl.classList.remove('hidden');
        }
        return;
      }
      if (p.length < 6) {
        if (regErrEl) {
          regErrEl.textContent = 'Password must be at least 6 characters.';
          regErrEl.classList.remove('hidden');
        }
        return;
      }

      btnRegister.disabled = true;
      btnRegister.textContent = 'Creating Account…';
      if (regErrEl) regErrEl.classList.add('hidden');

      try {
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        const regRes = await fetch(API + '/api/register/public', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, display_name: d, password: p })
        });
        const regData = await regRes.json();
        if (!regRes.ok || !regData.ok) {
          throw new Error(regData.error || 'Failed to register account');
        }

        // Auto login on successful registration
        const loginRes = await fetch(API + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: u, password: p })
        });
        const loginData = await loginRes.json();
        if (loginRes.ok && loginData.ok) {
          if (loginData.token) {
            if (typeof setAuthToken === 'function') {
              setAuthToken(loginData.token);
            } else {
              sessionStorage.setItem('ios_session_token', loginData.token);
              localStorage.setItem('ios_session_token', loginData.token);
            }
          }
          saveSession();
          registerCard.classList.add('hidden');
          signinCard.classList.remove('hidden');
          loginScreen.classList.add('hidden');
          appShell.classList.remove('hidden');
          if (regErrEl) regErrEl.classList.add('hidden');
          await boot();
        } else {
          registerCard.classList.add('hidden');
          signinCard.classList.remove('hidden');
          if (errEl) {
            errEl.textContent = 'Account created! Please sign in with your credentials.';
            errEl.classList.remove('hidden');
          }
          document.getElementById('inp-user').value = u;
          document.getElementById('inp-pass').value = '';
        }
      } catch (err) {
        if (regErrEl) {
          regErrEl.textContent = err.message || 'Registration failed';
          regErrEl.classList.remove('hidden');
        }
      } finally {
        btnRegister.disabled = false;
        btnRegister.textContent = 'Create Account';
      }
    }

    if (btnRegister) {
      btnRegister.addEventListener('click', tryRegister);
    }
    ['reg-user', 'reg-name', 'reg-pass'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter') tryRegister();
        });
      }
    });

    async function tryLogin() {
      const user = document.getElementById('inp-user').value.trim();
      const pass = document.getElementById('inp-pass').value;

      if (!user || !pass) {
        errEl.textContent = 'Please enter both username and password.';
        errEl.classList.remove('hidden');
        return;
      }

      btnLogin.disabled = true;
      btnLogin.textContent = 'Signing in…';
      errEl.classList.add('hidden');

      try {
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        const res = await fetch(`${API}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: user, password: pass })
        });

        let data = {};
        try { data = await res.json(); } catch (_) {}

        if (res.ok && data.ok) {
          if (data.token) {
            // persist token durably so it survives page refresh
            if (typeof setAuthToken === 'function') {
              setAuthToken(data.token);
            } else {
              sessionStorage.setItem('ios_session_token', data.token);
              localStorage.setItem('ios_session_token', data.token);
            }
          }
          saveSession();
          loginScreen.classList.add('hidden');
          appShell.classList.remove('hidden');
          errEl.classList.add('hidden');
          await boot();
        } else {
          errEl.textContent = (data && (data.error || data.msg)) || 'Invalid credentials. Try admin / ios2024';
          errEl.classList.remove('hidden');
        }
      } catch (err) {
        errEl.textContent = 'Login failed: ' + (err.message || 'Cannot reach server');
        errEl.classList.remove('hidden');
      } finally {
        btnLogin.disabled = false;
        btnLogin.textContent = 'Sign In';
      }
    }

    document.getElementById('btn-login').addEventListener('click', tryLogin);
    ['inp-user','inp-pass'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') tryLogin();
      });
    });

    document.getElementById('btn-logout').addEventListener('click', async () => {
      DATA.stop();
      try {
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        await fetch(`${API}/api/logout`, {
          method: 'POST',
          credentials: 'include'
        });
      } catch (_) {}
      sessionStorage.removeItem('ios_session_token');
      clearSession();
      const sidebarUsername = document.getElementById('sidebar-username');
      if (sidebarUsername) sidebarUsername.textContent = 'Internet of Swine';
      document.querySelectorAll('[data-admin-only]').forEach(el => {
        el.classList.add('hidden');
        el.style.display = 'none';
      });
      DATA.state.currentUser = null;
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

  /* ── Relay & Water Pump Controls ────────────────────────── */
  function initPumpControls() {
    const btnTest = document.getElementById('btn-test-pump');
    const btnToggle = document.getElementById('btn-toggle-pump');
    const resultBox = document.getElementById('pump-test-result');
    const resultMsg = document.getElementById('pump-test-msg');

    if (btnTest) {
      btnTest.addEventListener('click', async () => {
        btnTest.disabled = true;
        btnTest.innerHTML = `<span>⏳</span> Testing Pump (3s)...`;
        if (resultBox && resultMsg) {
          resultMsg.innerHTML = `<strong>Status:</strong> <span class="color-blue">Testing in progress...</span> Relay switched ON (Water Pump running)`;
          resultBox.classList.remove('hidden');
        }

        try {
          await DATA.testPump(3000);
          NOTIFY.show({
            title: 'Water Pump Test Triggered',
            message: 'Relay module activated for 3 seconds to test water pump flow.',
            type: 'info',
            icon: '🧪'
          });
        } catch (err) {
          console.error('Error triggering pump test:', err);
          NOTIFY.show({
            title: 'Pump Test Error',
            message: 'Failed to contact backend: ' + err.message,
            type: 'error'
          });
        } finally {
          setTimeout(() => {
            btnTest.disabled = false;
            btnTest.innerHTML = `<span>🧪</span> Test Water Pump (3s Pulse)`;
          }, 3500);
        }
      });
    }

    if (btnToggle) {
      btnToggle.addEventListener('click', async () => {
        const nextState = !DATA.state.manualPumpActive;
        btnToggle.disabled = true;

        try {
          await DATA.controlPump(nextState);
          NOTIFY.show({
            title: nextState ? 'Water Pump Activated' : 'Water Pump Stopped',
            message: nextState ? 'Relay switched ON manually.' : 'Relay switched OFF.',
            type: nextState ? 'success' : 'info',
            icon: nextState ? '💧' : '⏹️'
          });
        } catch (err) {
          console.error('Error toggling water pump:', err);
          NOTIFY.show({
            title: 'Pump Override Error',
            message: 'Failed to update pump state: ' + err.message,
            type: 'error'
          });
        } finally {
          btnToggle.disabled = false;
        }
      });
    }
  }

  /* ── Time Synchronization (Device Mode) ──────────────────── */
  function initTimeSyncControls() {
    async function handleSync() {
      const btnTop = document.getElementById('btn-sync-time-top');
      const btnPage = document.getElementById('btn-set-time');
      const btnBanner = document.getElementById('btn-banner-set-time');
      const statusMsg = document.getElementById('time-sync-status');

      const buttons = [btnTop, btnPage, btnBanner].filter(Boolean);
      buttons.forEach(b => { b.disabled = true; });

      try {
        const phoneEpoch = Math.floor(Date.now() / 1000);
        await DATA.setTime(phoneEpoch);

        if (statusMsg) {
          statusMsg.textContent = 'RTC clock synchronized with phone time!';
          statusMsg.classList.remove('hidden');
          setTimeout(() => { statusMsg.classList.add('hidden'); }, 4000);
        }

        if (typeof NOTIFY !== 'undefined') {
          NOTIFY.show({
            title: 'Time Synchronized',
            message: `ESP32 RTC set to ${new Date().toLocaleTimeString()} (UTC epoch ${phoneEpoch})`,
            type: 'success',
            icon: '🕒'
          });
        }
      } catch (err) {
        console.error('Time sync error:', err);
        if (statusMsg) {
          statusMsg.textContent = 'Failed to sync time: ' + err.message;
          statusMsg.classList.remove('hidden');
        }
        if (typeof NOTIFY !== 'undefined') {
          NOTIFY.show({
            title: 'Time Sync Failed',
            message: err.message,
            type: 'danger',
            icon: '⚠️'
          });
        }
      } finally {
        buttons.forEach(b => { b.disabled = false; });
      }
    }

    const btnTop = document.getElementById('btn-sync-time-top');
    if (btnTop) btnTop.addEventListener('click', handleSync);

    const btnPage = document.getElementById('btn-set-time');
    if (btnPage) btnPage.addEventListener('click', handleSync);

    const btnBanner = document.getElementById('btn-banner-set-time');
    if (btnBanner) btnBanner.addEventListener('click', handleSync);
  }

  /* ── Access Token button control ────────────────────────── */
  function initTokenControls() {
    const btnToken = document.getElementById('btn-token-top');
    if (!btnToken) return;
    btnToken.addEventListener('click', () => {
      const isDeviceMode = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.mode === 'device');
      if (isDeviceMode) {
        const promptFn = (typeof promptForToken === 'function')
          ? promptForToken
          : (window.promptForToken || (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.promptForToken));
        if (typeof promptFn === 'function') {
          const res = promptFn();
          if (res !== null && typeof NOTIFY !== 'undefined') {
            if (res) {
              NOTIFY.show({
                title: 'Token Saved',
                message: 'Device access token updated successfully.',
                type: 'success',
                icon: '🔑'
              });
            } else {
              NOTIFY.show({
                title: 'Token Cleared',
                message: 'Device access token was removed.',
                type: 'info',
                icon: 'ℹ️'
              });
            }
          }
        }
      } else {
        if (typeof NOTIFY !== 'undefined') {
          NOTIFY.show({
            title: 'Session Active',
            message: 'Authenticated as admin. All control and schedule actions are authorized.',
            type: 'info',
            icon: '🔑'
          });
        }
      }
    });
  }

  /* ── Boot (called after login) ───────────────────────────── */
  async function boot() {
    await IOS_CONFIG.ready;

    // Fetch and bind user identity
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    try {
      const meRes = await authFetch(API + '/api/me');
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.ok && meData.user) {
          DATA.state.currentUser = meData.user;
          const user = meData.user;
          const sidebarUsername = document.getElementById('sidebar-username');
          if (sidebarUsername) {
            sidebarUsername.textContent = user.display_name || user.username;
          }
          const isAdmin = user.role === 'admin';
          document.querySelectorAll('[data-admin-only]').forEach(el => {
            if (isAdmin) {
              el.classList.remove('hidden');
              el.style.display = '';
            } else {
              el.classList.add('hidden');
              el.style.display = 'none';
            }
          });
        }
      }
    } catch (e) {
      console.warn('Could not load /api/me:', e);
    }

    if (boot.initialized) {
      DATA.start();
      showPage(savedPage());
      return;
    }
    boot.initialized = true;
    startClock();
    initNav();
    initDeviceControls();
    initUserManagementControls();
    SCHEDULE.init();
    initThresholdSlider();
    initTHIThresholdControls();
    initOperationDurationControls();
    initPumpControls();
    initTimeSyncControls();
    initTokenControls();
    initRangeTabs();
    initCSVExport();
    initWaterControls();

    /* fetch real data once before first paint, then start polling */
    await DATA.refreshStatus();
    await DATA.refreshHistory();
    await DATA.refreshReports();
    showPage(savedPage());
    initTicker();
  }

  /* ── ESP32 Devices Management ────────────────────────────── */
  async function loadDevicesList() {
    const listWrap = document.getElementById('devices-list-wrap');
    if (!listWrap) return;
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    try {
      const res = await authFetch(API + '/api/devices');
      if (!res.ok) {
        listWrap.innerHTML = '<p class="login-err">Unable to load devices.</p>';
        return;
      }
      const data = await res.json();
      const devices = data.devices || [];

      if (devices.length === 0) {
        listWrap.innerHTML = `
          <div style="padding:16px 0; color:var(--muted); font-size:13px;">
            No ESP32 devices registered yet. Click <strong>+ Register Device</strong> to link your sensor or water monitoring node.
          </div>`;
        return;
      }

      let html = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Device ID</th>
                <th>Type</th>
                <th>Pen / Barn</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>`;

      devices.forEach(dev => {
        const typeBadge = dev.device_type === 'water'
          ? '<span class="badge badge-blue">Water Node</span>'
          : '<span class="badge badge-green">Sensor Node</span>';
        const dateStr = dev.created_at ? new Date(dev.created_at * 1000).toLocaleDateString() : '—';
        const pen = dev.pen_name ? escapeHtml(dev.pen_name) : '—';
        const did = escapeHtml(dev.device_id);

        html += `
          <tr>
            <td><strong>${did}</strong></td>
            <td>${typeBadge}</td>
            <td>${pen}</td>
            <td class="muted">${dateStr}</td>
            <td>
              <button class="btn btn-outline btn-sm btn-rotate-token" data-id="${dev.id}" data-did="${did}" title="Rotate Token">🔑 Rotate Token</button>
              <button class="btn-danger-sm btn-delete-device" data-id="${dev.id}" data-did="${did}" title="Delete Device" style="margin-left:6px;">✕ Delete</button>
            </td>
          </tr>`;
      });

      html += `
            </tbody>
          </table>
        </div>`;

      listWrap.innerHTML = html;

      listWrap.querySelectorAll('.btn-rotate-token').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const did = btn.dataset.did;
          if (!confirm('Rotate token for device "' + did + '"?\n\nThe previous token will stop working immediately. You will need to update secrets.h on the ESP32.')) return;

          try {
            const rotRes = await authFetch(API + '/api/devices/' + id + '/rotate-token', { method: 'POST' });
            const rotData = await rotRes.json();
            if (rotRes.ok && rotData.ok && rotData.token) {
              showDeviceTokenModal(rotData.token);
            } else {
              alert(rotData.error || 'Failed to rotate token');
            }
          } catch (err) {
            alert('Error rotating token: ' + err.message);
          }
        });
      });

      listWrap.querySelectorAll('.btn-delete-device').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const did = btn.dataset.did;
          if (!confirm('Are you sure you want to delete device "' + did + '"?\nIt will no longer be authorized to post readings.')) return;

          try {
            const delRes = await authFetch(API + '/api/devices/' + id, { method: 'DELETE' });
            const delData = await delRes.json();
            if (delRes.ok && delData.ok) {
              loadDevicesList();
            } else {
              alert(delData.error || 'Failed to delete device');
            }
          } catch (err) {
            alert('Error deleting device: ' + err.message);
          }
        });
      });

    } catch (err) {
      listWrap.innerHTML = '<p class="login-err">Error loading devices: ' + escapeHtml(err.message) + '</p>';
    }
  }

  function showDeviceTokenModal(token) {
    const modal = document.getElementById('device-token-modal');
    const tokenInp = document.getElementById('modal-token-display');
    const copyBtn = document.getElementById('btn-copy-device-token');
    if (!modal || !tokenInp) return;

    tokenInp.value = token;
    if (copyBtn) copyBtn.textContent = '📋 Copy';
    modal.classList.remove('hidden');
  }

  function initDeviceControls() {
    const openBtn = document.getElementById('btn-open-register-device');
    const modal = document.getElementById('device-modal');
    const closeBtn = document.getElementById('device-modal-close');
    const cancelBtn = document.getElementById('device-modal-cancel');
    const saveBtn = document.getElementById('device-modal-save');
    const errEl = document.getElementById('device-modal-err');

    const tokenModal = document.getElementById('device-token-modal');
    const tokenClose = document.getElementById('device-token-close');
    const tokenDone = document.getElementById('btn-device-token-done');
    const copyBtn = document.getElementById('btn-copy-device-token');

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        document.getElementById('modal-device-id').value = '';
        document.getElementById('modal-device-pen').value = '';
        document.getElementById('modal-device-type').value = 'sensor';
        if (errEl) errEl.classList.add('hidden');
        modal.classList.remove('hidden');
      });
    }

    [closeBtn, cancelBtn].forEach(b => {
      if (b && modal) {
        b.addEventListener('click', () => modal.classList.add('hidden'));
      }
    });

    [tokenClose, tokenDone].forEach(b => {
      if (b && tokenModal) {
        b.addEventListener('click', () => tokenModal.classList.add('hidden'));
      }
    });

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const tokenInp = document.getElementById('modal-token-display');
        if (tokenInp && tokenInp.value) {
          navigator.clipboard.writeText(tokenInp.value).then(() => {
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
          }).catch(() => {
            tokenInp.select();
            document.execCommand('copy');
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
          });
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const did = (document.getElementById('modal-device-id').value || '').trim();
        const type = document.getElementById('modal-device-type').value;
        const pen = (document.getElementById('modal-device-pen').value || '').trim();

        if (!did) {
          if (errEl) {
            errEl.textContent = 'Device Identifier is required.';
            errEl.classList.remove('hidden');
          }
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Registering…';
        if (errEl) errEl.classList.add('hidden');

        try {
          const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
          const res = await authFetch(API + '/api/devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: did, device_type: type, pen_name: pen })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            modal.classList.add('hidden');
            loadDevicesList();
            if (data.token) {
              showDeviceTokenModal(data.token);
            }
          } else {
            if (errEl) {
              errEl.textContent = data.error || 'Failed to register device.';
              errEl.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message || 'Error registering device.';
            errEl.classList.remove('hidden');
          }
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Register Device';
        }
      });
    }
  }

  /* ── User Accounts Management (Admin) ────────────────────── */
  async function loadUsersList() {
    const listWrap = document.getElementById('users-table-container');
    if (!listWrap) return;
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    try {
      const res = await authFetch(API + '/api/users');
      if (!res.ok) {
        listWrap.innerHTML = '<p class="login-err">Unable to load users. Administrator privileges required.</p>';
        return;
      }
      const data = await res.json();
      const users = data.users || [];
      const currentUserId = DATA.state.currentUser ? DATA.state.currentUser.id : null;

      if (users.length === 0) {
        listWrap.innerHTML = '<p class="muted small">No accounts found.</p>';
        return;
      }

      let html = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Display Name</th>
                <th>Role</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>`;

      users.forEach(u => {
        const roleBadge = u.role === 'admin'
          ? '<span class="badge badge-orange">Administrator</span>'
          : '<span class="badge badge-green">Standard User</span>';
        const dateStr = u.created_at ? new Date(u.created_at * 1000).toLocaleDateString() : '—';
        const dname = u.display_name ? escapeHtml(u.display_name) : '—';
        const uname = escapeHtml(u.username);
        const isSelf = currentUserId === u.id;

        html += `
          <tr>
            <td><strong>${uname}</strong></td>
            <td>${dname}</td>
            <td>${roleBadge}</td>
            <td class="muted">${dateStr}</td>
            <td>
              ${isSelf
                ? '<span class="muted small">(Current User)</span>'
                : '<button class="btn-danger-sm btn-delete-user" data-id="' + u.id + '" data-uname="' + uname + '">✕ Delete</button>'
              }
            </td>
          </tr>`;
      });

      html += `
            </tbody>
          </table>
        </div>`;

      listWrap.innerHTML = html;

      listWrap.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const uname = btn.dataset.uname;
          if (!confirm('Are you sure you want to delete user "' + uname + '"?\nAll associated farm telemetry, schedules, and device linkages will be permanently deleted.')) return;

          try {
            const delRes = await authFetch(API + '/api/users/' + id, { method: 'DELETE' });
            const delData = await delRes.json();
            if (delRes.ok && delData.ok) {
              loadUsersList();
            } else {
              alert(delData.error || 'Failed to delete user');
            }
          } catch (err) {
            alert('Error deleting user: ' + err.message);
          }
        });
      });

    } catch (err) {
      listWrap.innerHTML = '<p class="login-err">Error loading users: ' + escapeHtml(err.message) + '</p>';
    }
  }

  function initUserManagementControls() {
    const openBtn = document.getElementById('btn-admin-add-user');
    const modal = document.getElementById('user-modal');
    const closeBtn = document.getElementById('user-modal-close');
    const cancelBtn = document.getElementById('user-modal-cancel');
    const saveBtn = document.getElementById('user-modal-save');
    const errEl = document.getElementById('user-modal-err');

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        document.getElementById('modal-user-username').value = '';
        document.getElementById('modal-user-display').value = '';
        document.getElementById('modal-user-password').value = '';
        document.getElementById('modal-user-role').value = 'user';
        if (errEl) errEl.classList.add('hidden');
        modal.classList.remove('hidden');
      });
    }

    [closeBtn, cancelBtn].forEach(b => {
      if (b && modal) {
        b.addEventListener('click', () => modal.classList.add('hidden'));
      }
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const u = (document.getElementById('modal-user-username').value || '').trim();
        const d = (document.getElementById('modal-user-display').value || '').trim();
        const p = document.getElementById('modal-user-password').value || '';
        const r = document.getElementById('modal-user-role').value || 'user';

        if (!u || !p) {
          if (errEl) {
            errEl.textContent = 'Username and password are required.';
            errEl.classList.remove('hidden');
          }
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Creating…';
        if (errEl) errEl.classList.add('hidden');

        try {
          const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
          const res = await authFetch(API + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, display_name: d, password: p, role: r })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            modal.classList.add('hidden');
            loadUsersList();
          } else {
            if (errEl) {
              errEl.textContent = data.error || 'Failed to create user.';
              errEl.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message || 'Error creating user.';
            errEl.classList.remove('hidden');
          }
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Create Account';
        }
      });
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Entry point ─────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', async () => {
    initLogin();

    /* Auto-resume session after a page refresh if session is valid */
    if (isSessionActive()) {
      const loginScreen = document.getElementById('login-screen');
      const appShell    = document.getElementById('app-shell');
      const errEl       = document.getElementById('login-err');
      const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

      try {
        const res = await authFetch(`${API}/api/session`);
        if (res.ok) {
          loginScreen.classList.add('hidden');
          appShell.classList.remove('hidden');
          boot();
        } else {
          DATA.stop();
          if (typeof setAuthToken === 'function') setAuthToken(null);
          sessionStorage.removeItem('ios_session_token');
          clearSession(true);
          loginScreen.classList.remove('hidden');
          appShell.classList.add('hidden');
          if (errEl) {
            errEl.textContent = 'Your session has expired. Please sign in again.';
            errEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        const isDeviceMode = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.mode === 'device');
        if (isDeviceMode) {
          // Standalone or offline fallback on ESP32
          loginScreen.classList.add('hidden');
          appShell.classList.remove('hidden');
          boot();
        } else {
          // In cloud mode, network outage must not bypass authentication
          DATA.stop();
          loginScreen.classList.remove('hidden');
          appShell.classList.add('hidden');
          if (errEl) {
            errEl.textContent = 'Unable to reach server. Please check your network connection.';
            errEl.classList.remove('hidden');
          }
        }
      }
    }
  });

})();
