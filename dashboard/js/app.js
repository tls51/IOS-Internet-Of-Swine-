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
    settings:  'Device Settings',
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
    if (key === 'settings') {
      loadWifiStatus();
      loadDeviceConfig();
      loadCloudStatus();
      loadPinStatus();
    }
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
      const isDeviceMode = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.mode === 'device');
      if (isDeviceMode) {
        if (regErrEl) {
          regErrEl.textContent = 'Account creation requires the online cloud backend.';
          regErrEl.classList.remove('hidden');
        }
        return;
      }
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
    initPinControls();
    initMultiPenControls();
    initAccountingSyncControls();
    initCloudBindingControls();
    initUserManagementControls();
    initWifiControls();
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

  
  
  /* ── Multi-Pen Card View System (Phase 13) ─────────────────── */
  let selectedPenId = null;

  async function loadPensOverview() {
    const grid = document.getElementById('pens-grid');
    if (!grid) return;
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    try {
      const res = await authFetch(API + '/api/devices');
      if (!res.ok) return;
      const data = await res.json();
      const devices = data.devices || [];

      if (devices.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; background:var(--bg, #0d1117); border:1px dashed var(--border, #30363d); border-radius:8px; padding:30px; text-align:center;">
            <span style="font-size:32px; display:block; margin-bottom:10px;">🐖</span>
            <strong style="font-size:15px; display:block; margin-bottom:6px;">No Swine Pens Connected Yet</strong>
            <p class="muted small" style="max-width:440px; margin:0 auto 16px auto;">
              Link your first ESP32 sensor or water controller to this account to begin live swine welfare monitoring.
            </p>
            <button class="btn btn-primary btn-sm btn-trigger-add-pen">+ Connect First Pen</button>
          </div>`;

        const btnTrigger = grid.querySelector('.btn-trigger-add-pen');
        if (btnTrigger) {
          btnTrigger.addEventListener('click', () => {
            const modal = document.getElementById('add-pen-modal');
            if (modal) modal.classList.remove('hidden');
          });
        }
        return;
      }

      let html = '';
      devices.forEach(dev => {
        const penName = dev.pen_name ? escapeHtml(dev.pen_name) : 'Unnamed Pen';
        const did = escapeHtml(dev.device_id);
        const isOnline = !!dev.online;
        const onlineText = isOnline ? 'Online' : 'Offline';
        const dotClass = isOnline ? 'online' : 'offline';
        const thiStatus = dev.thi_status || { label: '—', cls: 'badge-muted' };

        const r = dev.latest_reading || {};
        const tempStr = (typeof r.temp === 'number') ? r.temp.toFixed(1) + '°C' : '—';
        const humStr = (typeof r.humidity === 'number') ? r.humidity.toFixed(0) + '%' : '—';
        const thiStr = (typeof r.thi === 'number') ? r.thi.toFixed(1) : '—';

        const w = dev.latest_water || {};
        const tankStr = (typeof w.water_level === 'number') ? (w.water_level > 0 ? w.water_level.toFixed(0) + '%' : '—') : '—';

        const lastSeenStr = dev.last_seen ? formatTimeAgo(dev.last_seen) : 'Never';
        const isFocused = (selectedPenId === dev.device_id);

        html += `
          <div class="pen-card ${isFocused ? 'active-focus' : ''}" data-device-id="${did}">
            <div class="pen-card-header">
              <div>
                <h3 class="pen-card-title">🐖 ${penName}</h3>
                <div class="pen-card-subtitle">${did}</div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                <span class="badge ${thiStatus.cls}" style="font-size:11px;">${escapeHtml(thiStatus.label)}</span>
                <span style="font-size:11px; color:var(--muted); display:flex; align-items:center;">
                  <span class="pen-online-dot ${dotClass}"></span> ${onlineText}
                </span>
              </div>
            </div>

            <div class="pen-metrics-grid">
              <div class="pen-metric-item">
                <span class="pen-metric-label">Temp</span>
                <span class="pen-metric-val">${tempStr}</span>
              </div>
              <div class="pen-metric-item">
                <span class="pen-metric-label">Hum</span>
                <span class="pen-metric-val" style="color:#60a5fa;">${humStr}</span>
              </div>
              <div class="pen-metric-item">
                <span class="pen-metric-label">THI</span>
                <span class="pen-metric-val" style="color:${thiStatus.color || '#e6edf3'};">${thiStr}</span>
              </div>
              <div class="pen-metric-item">
                <span class="pen-metric-label">Tank</span>
                <span class="pen-metric-val" style="color:#34d399;">${tankStr}</span>
              </div>
            </div>

            <div class="pen-card-drawer hidden" id="drawer-${did}">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
                <div><span class="muted">Type:</span> <strong>${escapeHtml(dev.device_type || 'Sensor Node')}</strong></div>
                <div><span class="muted">Last Seen:</span> <strong>${lastSeenStr}</strong></div>
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                <button class="btn btn-sm btn-outline btn-pen-focus" data-did="${did}">${isFocused ? '✓ Active Pen' : 'Focus Live Gauges'}</button>
                <button class="btn btn-sm btn-outline btn-pen-rotate" data-id="${dev.id}">Rotate Token</button>
                <button class="btn-danger-sm btn-pen-unlink" data-id="${dev.id}" data-did="${did}">Unlink</button>
              </div>
            </div>

            <div class="pen-card-footer">
              <span class="muted smaller">Last active: ${lastSeenStr}</span>
              <button class="btn btn-sm btn-outline btn-toggle-drawer" data-did="${did}">
                <span>Details ▾</span>
              </button>
            </div>
          </div>`;
      });

      grid.innerHTML = html;

      // Event Listeners for pen cards
      grid.querySelectorAll('.btn-toggle-drawer').forEach(btn => {
        btn.addEventListener('click', () => {
          const did = btn.dataset.did;
          const drawer = document.getElementById('drawer-' + did);
          if (drawer) {
            const isHidden = drawer.classList.toggle('hidden');
            btn.querySelector('span').textContent = isHidden ? 'Details ▾' : 'Collapse ▴';
          }
        });
      });

      grid.querySelectorAll('.btn-pen-focus').forEach(btn => {
        btn.addEventListener('click', () => {
          const did = btn.dataset.did;
          selectedPenId = (selectedPenId === did) ? null : did;
          loadPensOverview();
          NOTIFY.show(selectedPenId ? 'Focused live telemetry for pen: ' + did : 'Showing farm overview', 'info');
        });
      });

      grid.querySelectorAll('.btn-pen-rotate').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!confirm('Rotate device token for this pen node?')) return;
          try {
            const rotRes = await authFetch(API + '/api/devices/' + id + '/rotate-token', { method: 'POST' });
            const rotData = await rotRes.json();
            if (rotRes.ok && rotData.ok) {
              alert('New device token: ' + rotData.device_token + '\nSave this token to configure your hardware node.');
              loadPensOverview();
            } else {
              alert(rotData.error || 'Failed to rotate token.');
            }
          } catch (e) {
            alert('Error: ' + e.message);
          }
        });
      });

      grid.querySelectorAll('.btn-pen-unlink').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const did = btn.dataset.did;
          if (!confirm('Unlink pen node "' + did + '" from this account?')) return;
          try {
            const delRes = await authFetch(API + '/api/devices/' + id, { method: 'DELETE' });
            if (delRes.ok) {
              NOTIFY.show('Pen node unlinked successfully.', 'info');
              loadPensOverview();
              loadDevicesList();
            } else {
              const delData = await delRes.json();
              alert(delData.error || 'Failed to unlink device.');
            }
          } catch (e) {
            alert('Error: ' + e.message);
          }
        });
      });

    } catch (_) {}
  }

  function formatTimeAgo(ts) {
    if (!ts) return 'Never';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 10) return 'Just now';
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  
  /* ── Bidirectional Additive Accounting Sync ──────────────── */
  function initAccountingSyncControls() {
    const btnSync = document.getElementById('btn-trigger-accounting-sync');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        btnSync.disabled = true;
        btnSync.textContent = 'Syncing Accounting…';
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

        try {
          // Fetch local schedules
          const locRes = await authFetch(API + '/api/schedules?type=all');
          const localSchedules = locRes.ok ? await locRes.json() : [];

          // Push to sync accounting
          const syncRes = await authFetch(API + '/api/sync/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(localSchedules)
          });
          const syncData = await syncRes.json();

          if (syncRes.ok && syncData.ok) {
            NOTIFY.show(`Accounting sync complete! ${syncData.added_to_cloud || 0} missing items added to cloud.`, 'success');
            if (typeof loadSchedules === 'function') loadSchedules();
          } else {
            NOTIFY.show('Accounting sync: ' + (syncData.error || 'Server error'), 'warn');
          }
        } catch (err) {
          NOTIFY.show('Accounting sync error: ' + err.message, 'danger');
        } finally {
          btnSync.disabled = false;
          btnSync.textContent = 'Sync Accounting Now';
        }
      });
    }
  }

  function initMultiPenControls() {
    const btnRefresh = document.getElementById('btn-refresh-pens');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        loadPensOverview();
      });
    }

    const btnAddPenGuide = document.getElementById('btn-add-pen-guide');
    const modal = document.getElementById('add-pen-modal');
    const btnClose = document.getElementById('add-pen-modal-close');
    const btnDone = document.getElementById('btn-add-pen-done');

    if (btnAddPenGuide && modal) {
      btnAddPenGuide.addEventListener('click', () => {
        modal.classList.remove('hidden');
      });
    }
    if (btnClose && modal) {
      btnClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }
    if (btnDone && modal) {
      btnDone.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }
  }

  /* ── Device Security PIN Controls ───────────────────────── */
  let devicePinEnabled = false;

  async function loadPinStatus() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    try {
      const res = await authFetch(API + '/api/device/pin/status');
      if (!res.ok) return;
      const data = await res.json();
      devicePinEnabled = !!data.enabled;

      const badge = document.getElementById('pin-status-badge');
      const activeInfo = document.getElementById('pin-active-info');
      const setupBox = document.getElementById('pin-setup-box');
      const changeBox = document.getElementById('pin-change-box');

      if (devicePinEnabled) {
        if (badge) {
          badge.className = 'badge badge-green';
          badge.textContent = 'Protected (PIN On)';
        }
        if (activeInfo) activeInfo.classList.remove('hidden');
        if (changeBox) changeBox.classList.remove('hidden');
        if (setupBox) setupBox.classList.add('hidden');
      } else {
        if (badge) {
          badge.className = 'badge badge-muted';
          badge.textContent = 'Disabled (No PIN)';
        }
        if (activeInfo) activeInfo.classList.add('hidden');
        if (changeBox) changeBox.classList.add('hidden');
        if (setupBox) setupBox.classList.remove('hidden');
      }
    } catch (_) {}
  }

  function promptPinUnlockModal() {
    return new Promise((resolve) => {
      const modal = document.getElementById('pin-unlock-modal');
      const inp = document.getElementById('modal-inp-unlock-pin');
      const err = document.getElementById('modal-unlock-pin-err');
      const btnSubmit = document.getElementById('modal-btn-unlock-submit');
      const btnCancel = document.getElementById('modal-btn-unlock-cancel');

      if (!modal || !inp) {
        const direct = window.prompt('Enter Security PIN:');
        if (direct) {
          setSecurityPin(direct);
          resolve(true);
        } else {
          resolve(false);
        }
        return;
      }

      inp.value = '';
      if (err) err.classList.add('hidden');
      modal.classList.remove('hidden');
      inp.focus();

      const cleanup = () => {
        modal.classList.add('hidden');
        btnSubmit.removeEventListener('click', onSubmit);
        btnCancel.removeEventListener('click', onCancel);
        inp.removeEventListener('keydown', onKey);
      };

      const onSubmit = async () => {
        const pinVal = inp.value.trim();
        if (!pinVal) {
          if (err) {
            err.textContent = 'Please enter your Security PIN.';
            err.classList.remove('hidden');
          }
          return;
        }

        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Verifying…';

        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          const res = await fetch(API + '/api/device/pin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: pinVal })
          });
          const data = await res.json();

          if (res.ok && data.ok) {
            setSecurityPin(pinVal);
            NOTIFY.show('Settings unlocked for this session.', 'success');
            cleanup();
            resolve(true);
          } else {
            if (err) {
              err.textContent = data.error || 'Incorrect Security PIN.';
              err.classList.remove('hidden');
            }
          }
        } catch (e) {
          if (err) {
            err.textContent = 'Verification error: ' + e.message;
            err.classList.remove('hidden');
          }
        } finally {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Unlock';
        }
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onKey = (e) => {
        if (e.key === 'Enter') onSubmit();
        if (e.key === 'Escape') onCancel();
      };

      btnSubmit.addEventListener('click', onSubmit);
      btnCancel.addEventListener('click', onCancel);
      inp.addEventListener('keydown', onKey);
    });
  }
  window.promptPinUnlockModal = promptPinUnlockModal;

  function initPinControls() {
    // 1. Set PIN button
    const btnEnable = document.getElementById('btn-pin-enable');
    const inpNew = document.getElementById('inp-pin-new');
    const inpConfirm = document.getElementById('inp-pin-confirm');
    const setupErr = document.getElementById('pin-setup-err');

    if (btnEnable) {
      btnEnable.addEventListener('click', async () => {
        const p1 = (inpNew.value || '').trim();
        const p2 = (inpConfirm.value || '').trim();

        if (p1.length < 4 || p1.length > 8) {
          if (setupErr) {
            setupErr.textContent = 'PIN must be between 4 and 8 characters.';
            setupErr.classList.remove('hidden');
          }
          return;
        }

        if (p1 !== p2) {
          if (setupErr) {
            setupErr.textContent = 'PIN confirmation does not match.';
            setupErr.classList.remove('hidden');
          }
          return;
        }

        btnEnable.disabled = true;
        btnEnable.textContent = 'Setting PIN…';
        if (setupErr) setupErr.classList.add('hidden');

        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          const res = await authFetch(API + '/api/device/pin/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_pin: p1 })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            setSecurityPin(p1);
            inpNew.value = '';
            inpConfirm.value = '';
            NOTIFY.show('Security PIN successfully enabled!', 'success');
            await loadPinStatus();
          } else {
            if (setupErr) {
              setupErr.textContent = data.error || 'Failed to set PIN.';
              setupErr.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (setupErr) {
            setupErr.textContent = 'Error: ' + err.message;
            setupErr.classList.remove('hidden');
          }
        } finally {
          btnEnable.disabled = false;
          btnEnable.textContent = 'Set & Enable PIN';
        }
      });
    }

    // 2. Change PIN button
    const btnUpdate = document.getElementById('btn-pin-update');
    const inpCurrent = document.getElementById('inp-pin-current');
    const inpChangeNew = document.getElementById('inp-pin-change-new');
    const inpChangeConfirm = document.getElementById('inp-pin-change-confirm');
    const changeErr = document.getElementById('pin-change-err');

    if (btnUpdate) {
      btnUpdate.addEventListener('click', async () => {
        const cur = (inpCurrent.value || '').trim();
        const nw = (inpChangeNew.value || '').trim();
        const conf = (inpChangeConfirm.value || '').trim();

        if (!cur) {
          if (changeErr) {
            changeErr.textContent = 'Please enter your current PIN.';
            changeErr.classList.remove('hidden');
          }
          return;
        }

        if (nw.length < 4 || nw.length > 8) {
          if (changeErr) {
            changeErr.textContent = 'New PIN must be between 4 and 8 characters.';
            changeErr.classList.remove('hidden');
          }
          return;
        }

        if (nw !== conf) {
          if (changeErr) {
            changeErr.textContent = 'New PIN confirmation does not match.';
            changeErr.classList.remove('hidden');
          }
          return;
        }

        btnUpdate.disabled = true;
        btnUpdate.textContent = 'Updating…';
        if (changeErr) changeErr.classList.add('hidden');

        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          const res = await authFetch(API + '/api/device/pin/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_pin: cur, new_pin: nw })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            setSecurityPin(nw);
            inpCurrent.value = '';
            inpChangeNew.value = '';
            inpChangeConfirm.value = '';
            NOTIFY.show('Security PIN updated successfully!', 'success');
            await loadPinStatus();
          } else {
            if (changeErr) {
              changeErr.textContent = data.error || 'Failed to update PIN.';
              changeErr.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (changeErr) {
            changeErr.textContent = 'Error: ' + err.message;
            changeErr.classList.remove('hidden');
          }
        } finally {
          btnUpdate.disabled = false;
          btnUpdate.textContent = 'Change PIN';
        }
      });
    }

    // 3. Disable PIN button
    const btnDisable = document.getElementById('btn-pin-disable');
    if (btnDisable) {
      btnDisable.addEventListener('click', async () => {
        const cur = (inpCurrent.value || '').trim();
        if (!cur) {
          if (changeErr) {
            changeErr.textContent = 'Enter current PIN to disable protection.';
            changeErr.classList.remove('hidden');
          }
          return;
        }

        if (!confirm('Are you sure you want to disable PIN protection on this device?')) return;

        btnDisable.disabled = true;
        btnDisable.textContent = 'Disabling…';
        if (changeErr) changeErr.classList.add('hidden');

        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          const res = await authFetch(API + '/api/device/pin/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_pin: cur })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            setSecurityPin('');
            inpCurrent.value = '';
            inpChangeNew.value = '';
            inpChangeConfirm.value = '';
            NOTIFY.show('Security PIN disabled.', 'info');
            await loadPinStatus();
          } else {
            if (changeErr) {
              changeErr.textContent = data.error || 'Failed to disable PIN.';
              changeErr.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (changeErr) {
            changeErr.textContent = 'Error: ' + err.message;
            changeErr.classList.remove('hidden');
          }
        } finally {
          btnDisable.disabled = false;
          btnDisable.textContent = 'Disable PIN Protection';
        }
      });
    }

    // 4. Lock session button
    const btnLock = document.getElementById('btn-pin-lock-toggle');
    if (btnLock) {
      btnLock.addEventListener('click', () => {
        setSecurityPin('');
        NOTIFY.show('Settings locked. PIN required for next change.', 'info');
      });
    }
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


  /* ── Wi-Fi Manager (Phone-Style Scan & Connect) ────────── */
  async function loadWifiStatus() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    try {
      const res = await authFetch(API + '/api/wifi/status');
      if (!res.ok) return;
      const data = await res.json();

      const badge = document.getElementById('wifi-badge');
      const ssidEl = document.getElementById('wifi-stat-ssid');
      const ipEl = document.getElementById('wifi-stat-ip');
      const rssiEl = document.getElementById('wifi-stat-rssi');
      const macEl = document.getElementById('wifi-stat-mac');
      const btnDisconnect = document.getElementById('btn-wifi-disconnect');
      const apEl = document.getElementById('wifi-stat-hotspot');

      if (macEl && data.mac) macEl.textContent = data.mac;
      if (apEl && data.ap_ssid) {
        apEl.innerHTML = `Access Point: <strong>${escapeHtml(data.ap_ssid)}</strong> (${escapeHtml(data.ap_ip || '192.168.4.1')})`;
      }

      if (data.connected && data.ssid) {
        if (badge) {
          badge.className = 'badge badge-green';
          badge.textContent = 'Connected';
        }
        if (ssidEl) ssidEl.textContent = data.ssid;
        if (ipEl) ipEl.textContent = data.ip || '—';
        if (rssiEl) rssiEl.textContent = (data.rssi ? data.rssi + ' dBm' : 'Good');
        if (btnDisconnect) btnDisconnect.classList.remove('hidden');
      } else {
        if (badge) {
          badge.className = 'badge badge-warn';
          badge.textContent = 'Disconnected';
        }
        if (ssidEl) ssidEl.textContent = 'Not connected';
        if (ipEl) ipEl.textContent = '—';
        if (rssiEl) rssiEl.textContent = '—';
        if (btnDisconnect) btnDisconnect.classList.add('hidden');
      }
    } catch (_) {}
  }

  async function scanWifiNetworks() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    const btnScan = document.getElementById('btn-wifi-scan');
    const loading = document.getElementById('wifi-scan-loading');
    const list = document.getElementById('wifi-networks-list');

    if (btnScan) btnScan.disabled = true;
    if (loading) loading.classList.remove('hidden');
    if (list) list.innerHTML = '';

    try {
      // Trigger async scan on the ESP32
      const startRes = await authFetch(API + '/api/wifi/scan');
      if (!startRes.ok) throw new Error('Failed to start Wi-Fi scan');

      // Poll /api/wifi/scan/results until ready (max 15 s)
      let networks = [];
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1200));
        const pollRes = await authFetch(API + '/api/wifi/scan/results');
        if (!pollRes.ok) throw new Error('Scan results error');
        const pollData = await pollRes.json();
        if (pollData.ready) {
          networks = pollData.networks || [];
          break;
        }
      }

      if (networks.length === 0) {
        list.innerHTML = '<p class="muted small" style="text-align:center; padding:20px 0;">No wireless networks detected. Try scanning again.</p>';
        return;
      }

      let html = '';
      networks.forEach(net => {
        const signalPct = Math.max(0, Math.min(100, 2 * (net.rssi + 100)));
        const bars = signalPct >= 70 ? '▂▄▆█' : (signalPct >= 45 ? '▂▄▆' : (signalPct >= 20 ? '▂▄' : '▂'));
        const lockIcon = net.secure ? '🔒' : '🔓';
        html += `
          <div class="wifi-net-item" data-ssid="${escapeHtml(net.ssid)}" data-secure="${net.secure}">
            <div class="wifi-net-info">
              <span class="wifi-signal-bars" title="${net.rssi} dBm">${bars}</span>
              <div>
                <span class="wifi-net-name">${escapeHtml(net.ssid)}</span>
                <span class="wifi-net-sec">${lockIcon} ${escapeHtml(net.auth || (net.secure ? 'Secure' : 'Open'))}</span>
              </div>
            </div>
            <button class="btn btn-sm btn-outline">Connect</button>
          </div>
        `;
      });
      list.innerHTML = html;

      // Add click listeners to scanned items
      list.querySelectorAll('.wifi-net-item').forEach(item => {
        item.addEventListener('click', () => {
          const ssid = item.dataset.ssid;
          openWifiConnectModal(ssid);
        });
      });

    } catch (err) {
      if (list) list.innerHTML = `<p class="login-err" style="text-align:center; padding:16px;">Scan error: ${escapeHtml(err.message)}</p>`;
    } finally {
      if (btnScan) btnScan.disabled = false;
      if (loading) loading.classList.add('hidden');
    }
  }

  function openWifiConnectModal(ssid) {
    const modal = document.getElementById('modal-wifi-connect');
    const ssidInp = document.getElementById('inp-wifi-ssid');
    const passInp = document.getElementById('inp-wifi-pass');
    const errEl = document.getElementById('wifi-connect-err');

    if (!modal) return;
    if (ssidInp) {
      ssidInp.value = ssid || '';
      ssidInp.removeAttribute('readonly');
    }
    if (passInp) passInp.value = '';
    if (errEl) errEl.classList.add('hidden');
    modal.classList.remove('hidden');
    if (ssid) {
      if (passInp) passInp.focus();
    } else {
      if (ssidInp) ssidInp.focus();
    }
  }

  function closeWifiConnectModal() {
    const modal = document.getElementById('modal-wifi-connect');
    if (modal) modal.classList.add('hidden');
  }

  async function submitWifiConnect() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    const ssid = (document.getElementById('inp-wifi-ssid').value || '').trim();
    const password = document.getElementById('inp-wifi-pass').value || '';
    const btnSubmit = document.getElementById('btn-wifi-modal-submit');
    const errEl = document.getElementById('wifi-connect-err');

    if (!ssid) {
      if (errEl) { errEl.textContent = 'SSID is required.'; errEl.classList.remove('hidden'); }
      return;
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Connecting…';
    }
    if (errEl) errEl.classList.add('hidden');

    try {
      // POST to initiate — ESP32 returns 202 immediately, task runs in background
      const res = await authFetch(API + '/api/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid, password })
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (errEl) {
          errEl.textContent = data.error || 'Failed to initiate connection.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      // Poll /api/wifi/connect/status until connected or failed (max 20 s)
      if (btnSubmit) btnSubmit.textContent = 'Connecting… (0s)';
      const deadline = Date.now() + 20000;
      let elapsed = 0;
      let connected = false;
      let resultData = null;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        elapsed += 1500;
        if (btnSubmit) btnSubmit.textContent = `Connecting… (${Math.round(elapsed / 1000)}s)`;

        try {
          const statusRes = await authFetch(API + '/api/wifi/connect/status');
          if (!statusRes.ok) continue;
          const statusData = await statusRes.json();

          if (statusData.status === 'connected') {
            connected = true;
            resultData = statusData;
            break;
          } else if (statusData.status === 'failed') {
            if (errEl) {
              errEl.textContent = statusData.error || 'Failed to connect. Check password and try again.';
              errEl.classList.remove('hidden');
            }
            return;
          }
          // status === 'connecting' or 'idle' — keep polling
        } catch (_) { /* network hiccup during transition — keep trying */ }
      }

      if (connected && resultData) {
        closeWifiConnectModal();
        NOTIFY.show(`Connected to ${ssid}! IP: ${resultData.ip || ''}`, 'success');
        await loadWifiStatus();
      } else {
        if (errEl) {
          errEl.textContent = 'Connection timed out. Check password and try again.';
          errEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = 'Connection error: ' + err.message;
        errEl.classList.remove('hidden');
      }
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Connect Now';
      }
    }
  }

  function initWifiControls() {
    const btnScan = document.getElementById('btn-wifi-scan');
    if (btnScan) btnScan.addEventListener('click', scanWifiNetworks);

    const btnManual = document.getElementById('btn-wifi-manual');
    if (btnManual) {
      btnManual.addEventListener('click', () => {
        openWifiConnectModal('');
      });
    }

    const btnDisconnect = document.getElementById('btn-wifi-disconnect');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', async () => {
        if (!confirm('Disconnect from current Wi-Fi network?')) return;
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          await authFetch(API + '/api/wifi/disconnect', { method: 'POST' });
          NOTIFY.show('Disconnected from Wi-Fi.', 'info');
          loadWifiStatus();
        } catch (_) {}
      });
    }

    const btnClose = document.getElementById('btn-wifi-modal-close');
    if (btnClose) btnClose.addEventListener('click', closeWifiConnectModal);

    const btnCancel = document.getElementById('btn-wifi-modal-cancel');
    if (btnCancel) btnCancel.addEventListener('click', closeWifiConnectModal);

    const btnSubmit = document.getElementById('btn-wifi-modal-submit');
    if (btnSubmit) btnSubmit.addEventListener('click', submitWifiConnect);

    const passInp = document.getElementById('inp-wifi-pass');
    if (passInp) {
      passInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitWifiConnect();
      });
    }

    const btnTogglePass = document.getElementById('btn-toggle-wifi-pass');
    if (btnTogglePass && passInp) {
      btnTogglePass.addEventListener('click', () => {
        passInp.type = passInp.type === 'password' ? 'text' : 'password';
      });
    }
  }


  /* ── Device Configuration, Reboot & Factory Reset ──────── */
  async function loadDeviceConfig() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    try {
      const res = await authFetch(API + '/api/device/config');
      if (!res.ok) return;
      const data = await res.json();

      const inpName = document.getElementById('inp-dev-name');
      const inpPen = document.getElementById('inp-dev-pen');
      const inpModel = document.getElementById('inp-dev-model');
      const inpApSsid = document.getElementById('inp-dev-ap-ssid');
      const selTz = document.getElementById('sel-dev-tz');
      const lblMac = document.getElementById('lbl-dev-mac');
      const lblFw = document.getElementById('lbl-dev-fw');
      const lblHeap = document.getElementById('lbl-dev-heap');

      if (inpName) inpName.value = data.name || '';
      if (inpPen) inpPen.value = data.pen_name || '';
      if (inpModel) inpModel.value = data.model || '';
      if (inpApSsid) inpApSsid.value = data.ap_ssid || '';
      if (selTz && data.timezone_sec !== undefined) selTz.value = String(data.timezone_sec);
      if (lblMac && data.mac) lblMac.textContent = data.mac;
      if (lblFw && data.firmware) lblFw.textContent = data.firmware;
      if (lblHeap && data.heap_free) {
        lblHeap.textContent = Math.round(data.heap_free / 1024) + ' KB';
      }
    } catch (_) {}
  }

  function showUncancellableRebootModal(msg) {
    const modal = document.getElementById('modal-device-reboot');
    const msgEl = document.getElementById('reboot-modal-msg');
    const btnReboot = document.getElementById('btn-device-reboot-now');
    const countWrap = document.getElementById('reboot-countdown-wrap');
    const countText = document.getElementById('reboot-countdown-text');

    if (!modal) return;
    if (msgEl && msg) msgEl.textContent = msg;
    if (countWrap) countWrap.classList.add('hidden');
    if (btnReboot) {
      btnReboot.classList.remove('hidden');
      btnReboot.disabled = false;
      btnReboot.textContent = 'Reboot Now';
    }
    modal.classList.remove('hidden');

    btnReboot.onclick = async () => {
      btnReboot.classList.add('hidden');
      if (countWrap) countWrap.classList.remove('hidden');

      const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
      try {
        await authFetch(API + '/api/device/reboot', { method: 'POST' });
      } catch (_) {}

      let remaining = 10;
      const timer = setInterval(() => {
        remaining--;
        if (countText) countText.textContent = `Reconnecting in ${remaining}s…`;
        if (remaining <= 0) {
          clearInterval(timer);
          window.location.reload();
        }
      }, 1000);
    };
  }

  function initDeviceControls() {
    const btnSave = document.getElementById('btn-save-device-config');
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        const name = (document.getElementById('inp-dev-name').value || '').trim();
        const pen_name = (document.getElementById('inp-dev-pen').value || '').trim();
        const model = (document.getElementById('inp-dev-model').value || '').trim();
        const ap_ssid = (document.getElementById('inp-dev-ap-ssid').value || '').trim();
        const ap_password = document.getElementById('inp-dev-ap-pass').value || '';
        const tzVal = parseInt(document.getElementById('sel-dev-tz').value, 10);

        if (ap_password && ap_password.length < 8) {
          alert('Access Point password must be at least 8 characters.');
          return;
        }

        btnSave.disabled = true;
        btnSave.textContent = 'Saving…';

        try {
          const payload = { name, pen_name, model, ap_ssid, timezone_sec: tzVal };
          if (ap_password) payload.ap_password = ap_password;

          const res = await authFetch(API + '/api/device/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();

          if (res.ok && data.ok) {
            if (data.reboot_required) {
              showUncancellableRebootModal(data.message);
            } else {
              NOTIFY.show('Device settings updated successfully.', 'success');
              document.getElementById('inp-dev-ap-pass').value = '';
            }
          } else {
            alert(data.error || 'Failed to save device settings.');
          }
        } catch (err) {
          alert('Error saving settings: ' + err.message);
        } finally {
          btnSave.disabled = false;
          btnSave.textContent = 'Save Device Settings';
        }
      });
    }

    const btnToggleApPass = document.getElementById('btn-toggle-ap-pass');
    const apPassInp = document.getElementById('inp-dev-ap-pass');
    if (btnToggleApPass && apPassInp) {
      btnToggleApPass.addEventListener('click', () => {
        apPassInp.type = apPassInp.type === 'password' ? 'text' : 'password';
      });
    }

    const btnCopyMac = document.getElementById('btn-copy-mac');
    if (btnCopyMac) {
      btnCopyMac.addEventListener('click', () => {
        const mac = document.getElementById('lbl-dev-mac').textContent;
        if (mac && mac !== '—') {
          navigator.clipboard.writeText(mac).then(() => {
            NOTIFY.show('MAC address copied to clipboard: ' + mac, 'info');
          });
        }
      });
    }

    // Factory Reset phrase validation and action
    const resetPhraseInp = document.getElementById('inp-factory-reset-phrase');
    const btnReset = document.getElementById('btn-factory-reset-submit');
    const REQUIRED_PHRASE = 'Yes, I would like to factory reset this device';

    if (resetPhraseInp && btnReset) {
      resetPhraseInp.addEventListener('input', () => {
        const matches = (resetPhraseInp.value.trim() === REQUIRED_PHRASE);
        btnReset.disabled = !matches;
        btnReset.style.opacity = matches ? '1.0' : '0.4';
        btnReset.style.cursor = matches ? 'pointer' : 'not-allowed';
      });

      btnReset.addEventListener('click', async () => {
        if (resetPhraseInp.value.trim() !== REQUIRED_PHRASE) return;
        btnReset.disabled = true;
        btnReset.textContent = 'Resetting…';

        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          const res = await authFetch(API + '/api/device/factory-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation_phrase: REQUIRED_PHRASE })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            showUncancellableRebootModal('Factory reset successful. Hardware is restarting into default configuration.');
          } else {
            alert(data.error || 'Factory reset failed.');
            btnReset.disabled = false;
            btnReset.textContent = 'Factory Reset Device';
          }
        } catch (err) {
          alert('Reset error: ' + err.message);
          btnReset.disabled = false;
          btnReset.textContent = 'Factory Reset Device';
        }
      });
    }
  }


  /* ── Cloud Account Pairing & Synchronization ───────────── */
  async function loadCloudStatus() {
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
    try {
      const res = await authFetch(API + '/api/info');
      if (!res.ok) return;
      const data = await res.json();

      const badge = document.getElementById('cloud-pair-badge');
      const statText = document.getElementById('cloud-status-text');
      const btnUnbind = document.getElementById('btn-cloud-unbind');
      const urlInp = document.getElementById('inp-cloud-url');
      const penInp = document.getElementById('inp-cloud-pen');

      if (urlInp && data.backendUrl && !urlInp.value) {
        urlInp.value = data.backendUrl;
      }
      if (penInp && data.pen_name && !penInp.value) {
        penInp.value = data.pen_name;
      }

      if (data.paired) {
        if (badge) {
          badge.className = 'badge badge-green';
          badge.textContent = 'Linked to Account';
        }
        if (statText) {
          statText.innerHTML = '✅ <strong>Linked to Cloud:</strong> Sensor data is actively syncing to your swine farm account.';
          statText.style.color = '#22C55E';
        }
        if (btnUnbind) btnUnbind.classList.remove('hidden');

        const unpairedBanner = document.getElementById('unpaired-banner');
        if (unpairedBanner) unpairedBanner.classList.add('hidden');
      } else {
        if (badge) {
          badge.className = 'badge badge-warn';
          badge.textContent = 'Not Paired';
        }
        if (statText) {
          statText.innerHTML = '⚠️ <strong>Unlinked:</strong> Sensor data is recorded locally on SD card but not syncing to the cloud.';
          statText.style.color = '#f59e0b';
        }
        if (btnUnbind) btnUnbind.classList.add('hidden');
      }
    } catch (_) {}
  }

  function initCloudBindingControls() {
    const btnBind = document.getElementById('btn-cloud-bind');
    const errEl = document.getElementById('cloud-bind-err');

    if (btnBind) {
      btnBind.addEventListener('click', async () => {
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        const backend_url = (document.getElementById('inp-cloud-url').value || '').trim();
        const username = (document.getElementById('inp-cloud-user').value || '').trim();
        const password = document.getElementById('inp-cloud-pass').value || '';
        const pen_name = (document.getElementById('inp-cloud-pen').value || '').trim();

        if (!username || !password) {
          if (errEl) {
            errEl.textContent = 'Cloud account username and password are required.';
            errEl.classList.remove('hidden');
          }
          return;
        }

        btnBind.disabled = true;
        btnBind.textContent = 'Connecting…';
        if (errEl) errEl.classList.add('hidden');

        try {
          const res = await authFetch(API + '/api/device/bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend_url, username, password, pen_name })
          });
          const data = await res.json();

          if (res.ok && data.ok) {
            NOTIFY.show('ESP32 successfully linked to account: ' + (data.username || username), 'success');
            document.getElementById('inp-cloud-pass').value = '';
            await loadCloudStatus();
          } else {
            if (errEl) {
              errEl.textContent = data.error || 'Failed to bind device to account.';
              errEl.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (errEl) {
            errEl.textContent = 'Binding error: ' + err.message;
            errEl.classList.remove('hidden');
          }
        } finally {
          btnBind.disabled = false;
          btnBind.textContent = 'Connect to Account';
        }
      });
    }

    const btnUnbind = document.getElementById('btn-cloud-unbind');
    if (btnUnbind) {
      btnUnbind.addEventListener('click', async () => {
        if (!confirm('Unlink this ESP32 from your cloud account? Sensor readings will stop uploading.')) return;
        const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';
        try {
          await authFetch(API + '/api/device/unbind', { method: 'POST' });
          NOTIFY.show('Device unlinked from cloud account.', 'info');
          await loadCloudStatus();
        } catch (_) {}
      });
    }

    const btnToggleCloudPass = document.getElementById('btn-toggle-cloud-pass');
    const cloudPassInp = document.getElementById('inp-cloud-pass');
    if (btnToggleCloudPass && cloudPassInp) {
      btnToggleCloudPass.addEventListener('click', () => {
        cloudPassInp.type = cloudPassInp.type === 'password' ? 'text' : 'password';
      });
    }

    const btnTest = document.getElementById('btn-cloud-test');
    if (btnTest) {
      btnTest.addEventListener('click', async () => {
        const rawUrl = (document.getElementById('inp-cloud-url').value || '').trim();
        if (!rawUrl) {
          alert('Please enter a Cloud Server URL first.');
          return;
        }
        btnTest.disabled = true;
        btnTest.textContent = 'Testing…';
        try {
          const testRes = await fetch(rawUrl + '/api/health', { signal: AbortSignal.timeout(3500) });
          const testData = await testRes.json();
          if (testRes.ok && testData.ok) {
            NOTIFY.show('Cloud server reachable! Health status OK.', 'success');
          } else {
            alert('Cloud server responded but returned invalid health status.');
          }
        } catch (err) {
          alert('Could not reach cloud server: ' + err.message);
        } finally {
          btnTest.disabled = false;
          btnTest.textContent = 'Test Server Health';
        }
      });
    }
  }

  /* ── Entry point ─────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', async () => {
    initLogin();

    if (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.ready) {
      try { await IOS_CONFIG.ready; } catch (_) {}
    }

    const isDeviceMode = (typeof IOS_CONFIG !== 'undefined' && (IOS_CONFIG.mode === 'device' || !IOS_CONFIG.authRequired));

    if (isDeviceMode) {
      // In offline/device mode, AP Wi-Fi password is the gate - bypass login screen
      const loginScreen = document.getElementById('login-screen');
      const appShell    = document.getElementById('app-shell');
      if (loginScreen) loginScreen.classList.add('hidden');
      if (appShell) appShell.classList.remove('hidden');
      saveSession();

      // Show Configure Me banner if device is not paired
      if (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.paired === false) {
        const unpairedBanner = document.getElementById('unpaired-banner');
        if (unpairedBanner) {
          unpairedBanner.classList.remove('hidden');
          const btnCloud = document.getElementById('btn-banner-cloud-setup');
          if (btnCloud) {
            btnCloud.addEventListener('click', () => showPage('settings'));
          }
        }
      }

      await boot();
      return;
    }

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
