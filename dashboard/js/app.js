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

  /* ── Clock ───────────────────────────────────────────────── */
  function startClock() {
    const el = document.getElementById('live-time');
    function tick() {
      if (!el) return;
      if (DATA.state && DATA.state.rtcOk === false) {
        el.textContent = 'RTC Error';
        return;
      }
      if (DATA.state && DATA.state.epoch != null && DATA.state.epochReceivedAt != null) {
        const elapsedSec = Math.floor((Date.now() - DATA.state.epochReceivedAt) / 1000);
        const deviceTime = new Date((DATA.state.epoch + elapsedSec) * 1000);
        el.textContent = deviceTime.toLocaleTimeString();
      } else {
        el.textContent = new Date().toLocaleTimeString();
      }
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
        const res = await fetch(`${base}/api/reports/export?range=${range}`);
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

    const btnExportWater = document.getElementById('btn-export-water-csv');
    if (!btnExportWater) return;

    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : '';

    btnExportWater.addEventListener('click', async () => {
      const activeTab = document.querySelector('#water-range-tabs .range-tab.active');
      const range = activeTab ? activeTab.dataset.range : (DATA.state.waterRange || '7d');
      const base = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.reportApiBase) ? IOS_CONFIG.reportApiBase : API;
      btnExportWater.disabled = true;
      try {
        const res = await fetch(`${base}/api/reports/export?type=water&range=${range}`);
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
    if (boot.initialized) {
      DATA.start();
      showPage(savedPage());
      return;
    }
    boot.initialized = true;
    startClock();
    initNav();
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
      } catch (_) {
        // Standalone or offline fallback
        loginScreen.classList.add('hidden');
        appShell.classList.remove('hidden');
        boot();
      }
    }
  });

})();
