/* ============================================================
   pages.js — Page render & live-update handlers
   ============================================================ */

const PAGES = (() => {

  /* ── Water tank SVG ──────────────────────────────────────── */
  function renderTank(containerId, level) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    const color = level > 60 ? '#22C55E' : level > 30 ? '#F59E0B' : '#EF4444';
    wrap.innerHTML = `
      <div class="tank-svg-wrap">
        <div class="tank-fill" style="height:${level}%;background:${color}44;border-top:2px solid ${color}"></div>
        <div class="tank-label-inside" style="color:${color}">${level}%</div>
      </div>
      <span class="tank-sublabel">Water Level</span>`;
  }

  /* ── Alert banner ────────────────────────────────────────── */
  function updateAlerts(state) {
    const el  = document.getElementById('alert-banner');
    const msgs = [];
    const { stressMax = 78, extremeMax = 83 } = state.thiThresholds || {};

    if (state.thi != null) {
      if (state.thi > extremeMax) {
        msgs.push(`DANGER: THI exceeds ${extremeMax} — immediate cooling required!`);
      } else if (state.thi > stressMax) {
        msgs.push(`WARNING: Extreme heat stress detected (THI ${state.thi})`);
      }
    }
    if (state.waterLevel != null && state.waterLevel < 20) {
      msgs.push(`LOW WATER: Tank level critical (${state.waterLevel}%) — refill immediately`);
    }
    if (state.mistActive) {
      msgs.push('ℹ Misting system is currently active (auto-triggered)');
    }

    /* Malfunction diagnostics */
    if (state.malfunctions && state.malfunctions.length) {
      state.malfunctions.forEach(m => {
        msgs.push(`SYSTEM MALFUNCTION: ${m.msg}`);
      });
    }

    if (msgs.length) {
      el.innerHTML = msgs.map(m => `<div class="alert-item"><span>⚠</span><span>${m}</span></div>`).join('');
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  /* ── Topbar live ─────────────────────────────────────────── */
  function updateTopbar(state) {
    const tl = DATA.thiLevel(state.thi, state.thiThresholds);
    const chip = document.getElementById('thi-chip');
    const thiTxt = state.thi != null ? `THI ${state.thi} · ${tl.label}` : 'THI — · —';
    chip.textContent = thiTxt;
    chip.className   = `badge ${tl.cls}`;

    const envTxt = (state.temp != null && state.humidity != null)
      ? `🌡 ${state.temp}°C · 💧 ${state.humidity}%`
      : '🌡 —°C · 💧 —%';
    document.getElementById('live-env').textContent = envTxt;

    if (state.rtcOk === false) {
      document.getElementById('live-time').textContent = 'RTC Error';
    } else if (state.epoch != null && state.epochReceivedAt != null) {
      const elapsedSec = Math.floor((Date.now() - state.epochReceivedAt) / 1000);
      const currentDeviceDate = new Date((state.epoch + elapsedSec) * 1000);
      document.getElementById('live-time').textContent = currentDeviceDate.toLocaleTimeString();
    } else {
      document.getElementById('live-time').textContent = new Date().toLocaleTimeString();
    }

    /* connection indicator */
    const dot   = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (dot && label) {
      if (state.connected) {
        if (state.backendOnline) {
          dot.style.background   = 'var(--primary)';
          dot.style.boxShadow    = '0 0 6px var(--primary)';
          label.textContent      = 'Online · Backend Connected';
        } else {
          dot.style.background   = '#F59E0B';
          dot.style.boxShadow    = '0 0 6px #F59E0B';
          label.textContent      = 'Offline Mode · Backend Unreachable';
        }
      } else {
        dot.style.background   = 'var(--danger)';
        dot.style.boxShadow    = '0 0 6px var(--danger)';
        label.textContent      = 'Disconnected · Device Unreachable';
      }
    }
  }

  /* ── Dashboard page ──────────────────────────────────────── */
  function updateDashboard(state) {
    const tl = DATA.thiLevel(state.thi, state.thiThresholds);

    /* stat cards */
    const tempEl = document.getElementById('dash-temp');
    tempEl.textContent = state.temp != null ? state.temp + '°C' : '—';
    tempEl.style.color = state.temp > 32 ? '#EF4444' : state.temp > 29 ? '#F59E0B' : 'var(--text)';

    document.getElementById('dash-hum').textContent = state.humidity != null ? state.humidity + '%' : '—';

    const thiEl = document.getElementById('dash-thi');
    thiEl.textContent = state.thi != null ? state.thi : '—';
    thiEl.style.color = tl.color;

    const thiBadge = document.getElementById('dash-thi-badge');
    thiBadge.textContent = tl.label;
    thiBadge.className   = `badge ${tl.cls} mt-6`;

    /* system rows */
    function setSysRow(id, active) {
      const row = document.getElementById(id);
      if (!row) return;
      const badge = row.querySelector('.sys-status');
      badge.textContent = active ? 'Active' : 'Standby';
      badge.className   = `badge ${active ? 'badge-green' : 'badge-muted'} sys-status`;
    }
    setSysRow('sys-mist',  state.mistActive);
    setSysRow('sys-bath',  state.bathActive);
    setSysRow('sys-clean', state.cleanActive);

    /* tank */
    renderTank('dash-tank-visual', state.waterLevel);
    const pctEl    = document.getElementById('dash-tank-pct');
    const noteEl   = document.getElementById('dash-tank-status');
    pctEl.textContent  = state.waterLevel != null ? state.waterLevel + '%' : '—%';
    pctEl.style.color  = (state.waterLevel != null && state.waterLevel > 30) ? '#22C55E' : '#EF4444';
    noteEl.textContent = state.waterLevel == null ? '—'
                       : state.waterLevel > 60 ? 'Sufficient supply'
                       : state.waterLevel > 30 ? 'Refill soon'
                       : '⚠ Critical — refill now';
    document.getElementById('dash-usage').innerHTML = `${(state.waterUsed || 0).toFixed(0)} <span class="muted small">L</span>`;

    /* alerts */
    updateAlerts(state);

    /* chart */
    const { stressMax = 78, extremeMax = 83 } = state.thiThresholds || {};
    CHARTS.drawLineChart('chart-dash', state.history, [
      { key: 'thi',  label: 'THI',      color: '#F59E0B', area: true, unit: '' },
      { key: 'temp', label: 'Temp °C',  color: '#EF4444', area: true, unit: '°C' },
    ], {
      refLines: [
        { value: stressMax, cls: 'ref-warn',   label: 'Stress' },
        { value: extremeMax, cls: 'ref-danger', label: 'Danger' },
      ]
    });
  }

  /* ── Environmental page ──────────────────────────────────── */
  function updateEnv(state) {
    const tl = DATA.thiLevel(state.thi, state.thiThresholds);

    const tempEl = document.getElementById('env-temp');
    tempEl.innerHTML = `${state.temp != null ? state.temp : '—'}<span class="big-unit">°C</span>`;
    tempEl.style.color = state.temp > 32 ? '#EF4444' : state.temp > 29 ? '#F59E0B' : '#22C55E';

    document.getElementById('env-hum').innerHTML = `${state.humidity != null ? state.humidity : '—'}<span class="big-unit">%</span>`;

    const thiEl = document.getElementById('env-thi');
    thiEl.textContent = state.thi != null ? state.thi : '—';
    thiEl.style.color = tl.color;

    const badge = document.getElementById('env-thi-badge');
    badge.textContent = tl.label;
    badge.className   = `badge ${tl.cls} mt-10`;

    /* THI classification boxes */
    const { normalMax = 74, stressMax = 78, extremeMax = 83 } = state.thiThresholds || {};
    const boxes = document.querySelectorAll('.thi-box');
    if (boxes.length === 4) {
      boxes[0].dataset.min = 0;                boxes[0].dataset.max = normalMax;
      boxes[0].querySelector('.thi-box-range').textContent = `< ${normalMax}`;

      boxes[1].dataset.min = normalMax;        boxes[1].dataset.max = stressMax + 0.001;
      boxes[1].querySelector('.thi-box-range').textContent = `${normalMax}–${stressMax}`;

      boxes[2].dataset.min = stressMax + 0.001; boxes[2].dataset.max = extremeMax + 0.001;
      boxes[2].querySelector('.thi-box-range').textContent = `${stressMax}–${extremeMax}`;

      boxes[3].dataset.min = extremeMax + 0.001; boxes[3].dataset.max = 999;
      boxes[3].querySelector('.thi-box-range').textContent = `> ${extremeMax}`;
    }

    boxes.forEach(box => {
      const min   = parseFloat(box.dataset.min);
      const max   = parseFloat(box.dataset.max);
      const color = box.dataset.color;
      const active = state.thi != null && state.thi >= min && state.thi < max;
      box.style.background   = active ? `${color}22` : '';
      box.style.borderColor  = active ? color : 'var(--border)';
      box.querySelector('.thi-box-range').style.color = active ? color : 'var(--text)';
    });

    /* update THI bar labels */
    const lblNorm = document.getElementById('thi-lbl-norm');
    const lblStress = document.getElementById('thi-lbl-stress');
    const lblExtreme = document.getElementById('thi-lbl-extreme');
    if (lblNorm) lblNorm.textContent = normalMax;
    if (lblStress) lblStress.textContent = stressMax;
    if (lblExtreme) lblExtreme.textContent = extremeMax;

    /* update input values if not currently focused by user */
    const inpNorm = document.getElementById('inp-thi-normal');
    const inpStress = document.getElementById('inp-thi-stress');
    const inpExtreme = document.getElementById('inp-thi-extreme');
    if (inpNorm && document.activeElement !== inpNorm) inpNorm.value = normalMax;
    if (inpStress && document.activeElement !== inpStress) inpStress.value = stressMax;
    if (inpExtreme && document.activeElement !== inpExtreme) inpExtreme.value = extremeMax;

    /* needle */
    const needle = document.getElementById('thi-needle');
    if (needle) {
      const pct = Math.min(100, Math.max(0, (state.thi - 60) / 40 * 100));
      needle.style.left = pct + '%';
    }

    /* chart */
    CHARTS.drawLineChart('chart-env', state.history, [
      { key: 'temp',     label: 'Temp °C',   color: '#EF4444', unit: '°C' },
      { key: 'humidity', label: 'Humidity %', color: '#3B82F6', unit: '%'  },
      { key: 'thi',      label: 'THI',        color: '#F59E0B', unit: ''   },
    ]);
  }

  /* ── Water page ──────────────────────────────────────────── */
  function updateWater(state) {
    const levelEl = document.getElementById('water-level-val');
    levelEl.textContent = state.waterLevel + '%';
    levelEl.style.color = state.waterLevel > 30 ? '#22C55E' : '#EF4444';
    document.getElementById('water-used-val').textContent = state.waterUsed.toFixed(0) + ' L';
    document.getElementById('water-flow-val').textContent = state.flowRate + ' L/min';

    /* tank */
    renderTank('water-tank-visual', state.waterLevel);
    document.getElementById('water-tank-note').textContent =
      state.waterLevel > 60 ? 'Level OK'
    : state.waterLevel > 30 ? 'Refill recommended'
    : '⚠ Refill immediately';

    /* breakdown bars */
    const bd = document.getElementById('water-breakdown');
    const total = state.waterUsed || 1;
    const parts = [
      { label: 'Misting',  pct: 0.45, color: '#22C55E' },
      { label: 'Bathing',  pct: 0.35, color: '#3B82F6' },
      { label: 'Cleaning', pct: 0.20, color: '#F59E0B' },
    ];
    bd.innerHTML = parts.map(p => {
      const val = Math.round(total * p.pct);
      const w   = Math.round(p.pct * 100);
      return `
        <div class="breakdown-item">
          <div class="breakdown-row">
            <span class="muted">${p.label}</span>
            <span style="font-weight:600">${val} L</span>
          </div>
          <div class="breakdown-bar-bg">
            <div class="breakdown-bar-fill" style="width:${w}%;background:${p.color}"></div>
          </div>
        </div>`;
    }).join('');

    /* bar chart */
    CHARTS.drawBarChart('chart-water', state.weeklyWater, [
      { key: 'mist',  label: 'Misting',  color: '#22C55E' },
      { key: 'bathe', label: 'Bathing',  color: '#3B82F6' },
      { key: 'clean', label: 'Cleaning', color: '#F59E0B' },
    ]);
  }

  /* ── Auto systems page ───────────────────────────────────── */
  function updateAuto(state) {
    const threshold = state.threshold;
    const { mistDurationMin = 5, mistPauseSec = 30 } = state.operationDurations || {};

    const slider = document.getElementById('threshold-slider');
    const valEl  = document.getElementById('threshold-val');
    if (slider && document.activeElement !== slider) slider.value = threshold;
    if (valEl) valEl.textContent = threshold + '°C';

    /* Update operation duration input fields if not currently focused */
    const inpDur = document.getElementById('inp-mist-dur');
    const inpPause = document.getElementById('inp-mist-pause');
    if (inpDur && document.activeElement !== inpDur) inpDur.value = mistDurationMin;
    if (inpPause && document.activeElement !== inpPause) inpPause.value = mistPauseSec;

    const systems = [
      { label: 'Shower / Bathing System',  icon: '🚿',  active: state.bathActive,  trigger: 'Schedule-based',       desc: 'Executes pre-set bathing schedules via relay-controlled pump.' },
      { label: 'Misting / Cooling System', icon: '🌫️', active: state.mistActive,  trigger: `Temp > ${threshold}°C`, desc: `Activates when temperature exceeds ${threshold}°C. Cycles: ${mistDurationMin} min ON → ${mistPauseSec} s pause.` },
      { label: 'Waste Cleaning System',    icon: '🧹',  active: state.cleanActive, trigger: 'Schedule-based',       desc: 'Water-based flushing mechanism on admin-defined schedule.' },
    ];

    const list = document.getElementById('auto-sys-list');
    if (list) {
      list.innerHTML = systems.map(s => `
        <div class="card auto-card">
          <div class="auto-icon-box${s.active ? ' on' : ''}">${s.icon}</div>
          <div class="auto-body">
            <div class="auto-name">${s.label}</div>
            <div class="auto-desc">${s.desc}</div>
            <div class="auto-trigger">Trigger: <span>${s.trigger}</span></div>
          </div>
          <span class="badge ${s.active ? 'badge-green' : 'badge-muted'}">
            <span class="status-dot" style="background:${s.active ? '#22C55E' : '#8B949E'};${s.active ? 'box-shadow:0 0 6px #22C55E' : ''}"></span>
            ${s.active ? 'Active' : 'Standby'}
          </span>
        </div>`).join('');
    }

    /* Update Relay Module & Water Pump Test Box */
    const isPumpOn = state.pumpState === 'ON' || state.pumpActive || state.relayState || state.manualPumpActive || state.mistActive || state.bathActive || state.cleanActive;
    const pumpIcon = document.getElementById('pump-indicator-icon');
    const pumpText = document.getElementById('pump-relay-text');
    const pumpBadge = document.getElementById('pump-live-badge');
    const toggleBtnTxt = document.getElementById('btn-toggle-pump-text');
    const resultBox = document.getElementById('pump-test-result');
    const resultMsg = document.getElementById('pump-test-msg');

    const reasonLabels = {
      manual: 'Manual Override',
      scheduled: 'Scheduled Run',
      thi_cooling: 'Heat Stress Cooling (THI)',
      low_water: 'Halted: Low Water (<10%)',
      mist_pause: 'Cycle Pause',
      idle: 'Standby'
    };
    const reasonTxt = reasonLabels[state.pumpReason] || state.pumpReason || (isPumpOn ? 'Active' : 'Standby');

    if (pumpIcon) {
      pumpIcon.classList.toggle('active', isPumpOn);
      pumpIcon.textContent = isPumpOn ? '💧' : '⚡';
    }
    if (pumpText) {
      pumpText.textContent = `${isPumpOn ? 'Active (ON)' : 'Standby (OFF)'} · Reason: ${reasonTxt}`;
      pumpText.style.color = isPumpOn ? 'var(--primary)' : 'var(--blue)';
    }
    if (pumpBadge) {
      if (isPumpOn) {
        pumpBadge.className = 'badge badge-green';
        pumpBadge.textContent = `✓ Pump ON (${reasonTxt})`;
      } else if (state.pumpReason === 'low_water') {
        pumpBadge.className = 'badge badge-danger';
        pumpBadge.textContent = '⚠ Low Water (<10%)';
      } else if (state.pumpReason === 'mist_pause') {
        pumpBadge.className = 'badge badge-warn';
        pumpBadge.textContent = '⏸ Mist Pause';
      } else {
        pumpBadge.className = 'badge badge-muted';
        pumpBadge.textContent = 'Relay Standby';
      }
    }
    if (toggleBtnTxt) {
      toggleBtnTxt.textContent = state.manualPumpActive ? 'Manual Pump OFF' : 'Manual Pump ON';
    }
    if (resultBox && resultMsg && state.lastPumpTest) {
      const pt = state.lastPumpTest;
      const statusCls = pt.status === 'Passed' ? 'color-green' : (pt.status === 'Testing' ? 'color-blue' : '');
      const timeStr = pt.ts ? new Date(pt.ts).toLocaleTimeString() : '';
      resultMsg.innerHTML = `<strong>Status:</strong> <span class="${statusCls}">${pt.status}</span> · <em>${timeStr}</em>` +
        (pt.flow_lpm != null ? ` · Flow: <strong>${pt.flow_lpm} L/min</strong> (${pt.flow_pulses || 0} pulses)` : ` (Pulse: ${(pt.duration_ms || 3000)/1000}s)`);
      resultBox.classList.remove('hidden');
    }

    /* Update RTC Synchronization Status (Device Mode Card) */
    const rtcStatus = document.getElementById('rtc-status-text');
    if (rtcStatus) {
      if (state.rtcOk === false) {
        rtcStatus.textContent = 'Hardware Error / Not Detected';
        rtcStatus.className = 'color-red';
      } else if (state.epoch != null) {
        rtcStatus.textContent = 'OK (Synchronized)';
        rtcStatus.className = 'color-green';
      } else {
        rtcStatus.textContent = 'OK';
        rtcStatus.className = 'color-green';
      }
    }

    /* Update MicroSD Storage & Backend Sync Card */
    const sd = state.sdDetails || (d && d.details && d.details.sd_info) || null;
    const hasReport = !!(sd || (d && (d.sd_ok !== undefined || (d.details && d.details.sd))) || (state.sdStatus && state.sdStatus !== 'Unknown'));
    const isConnected = state.connected !== false;
    const lastUpdateTs = (sd && sd.statusTs && sd.statusTs > 1000000000000)
      ? sd.statusTs
      : (state.sdLastReportAt && state.sdLastReportAt > 1000000000000 ? state.sdLastReportAt : (d && d.ts && d.ts > 1000000000000 ? d.ts : null));
    const isFresh = isConnected && (lastUpdateTs ? (Date.now() - lastUpdateTs <= 120000) : isConnected);

    let effectiveStatus = (sd && sd.status) || state.sdStatus;
    if ((!effectiveStatus || effectiveStatus === 'Unknown') && d && d.sd_ok !== undefined && d.sd_ok !== null) {
      effectiveStatus = d.sd_ok ? 'Ready' : 'Error';
    }

    const sdBadge = document.getElementById('sd-status-badge');
    const sdMeta = document.getElementById('sd-meta');
    if (sdBadge) {
      if (!hasReport) {
        sdBadge.className = 'badge badge-muted';
        sdBadge.textContent = 'Awaiting ESP32…';
      } else if (!isFresh) {
        sdBadge.className = 'badge badge-muted';
        sdBadge.textContent = 'Device Offline / Stale';
      } else if (effectiveStatus === 'Ready') {
        sdBadge.className = 'badge badge-green';
        sdBadge.textContent = '✓ Ready (Mounted)';
      } else if (effectiveStatus === 'Missing') {
        sdBadge.className = 'badge badge-warn';
        sdBadge.textContent = '⚠ Missing / No Card';
      } else if (effectiveStatus === 'Error') {
        sdBadge.className = 'badge badge-danger';
        sdBadge.textContent = '✗ Card Error';
      } else {
        sdBadge.className = 'badge badge-muted';
        sdBadge.textContent = effectiveStatus || 'Unknown';
      }
    }
    if (sdMeta && sd && sd.cardType && sd.cardType !== 'Unavailable') {
      sdMeta.textContent = `SPI (CS: 10, MOSI: 11, SCK: 12, MISO: 13) · ${sd.cardType}`;
    }

    const backendBadge = document.getElementById('backend-status-badge');
    const backendDesc = document.getElementById('backend-status-desc');
    if (backendBadge) {
      if (state.backendOnline) {
        backendBadge.className = 'badge badge-green';
        backendBadge.textContent = '✓ Online (Connected)';
        if (backendDesc) backendDesc.textContent = 'Windows Laptop SQLite (Reachable)';
      } else {
        backendBadge.className = 'badge badge-danger';
        backendBadge.textContent = '✗ Offline (Unreachable)';
        if (backendDesc) backendDesc.textContent = 'Windows Laptop SQLite (Offline)';
      }
    }

    const pendingEl = document.getElementById('pending-records-count');
    if (pendingEl) {
      const pCount = state.pendingOfflineCount || 0;
      if (pCount === 0) {
        pendingEl.className = 'badge badge-muted';
        pendingEl.textContent = '0 pending';
      } else {
        pendingEl.className = 'badge badge-warn';
        pendingEl.textContent = `${pCount} pending`;
      }
    }

    const syncBadge = document.getElementById('sync-state-badge');
    const syncTimeDesc = document.getElementById('last-sync-time-desc');
    if (syncBadge) {
      if (state.syncInProgress) {
        syncBadge.className = 'badge badge-blue';
        syncBadge.textContent = '🔄 Synchronizing…';
      } else {
        syncBadge.className = 'badge badge-muted';
        syncBadge.textContent = 'Idle';
      }
    }
    if (syncTimeDesc) {
      if (state.lastSyncTs && state.lastSyncTs > 1000000000000) {
        syncTimeDesc.textContent = `Last sync: ${new Date(state.lastSyncTs).toLocaleTimeString()}`;
      } else {
        syncTimeDesc.textContent = 'Last sync: None yet';
      }
    }

    updateDiagnostics(state);
  }

  /* ── Helper: Format byte counts cleanly ───────────────────── */
  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes <= 0) return 'Unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = Number(bytes);
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(i === 0 ? 0 : (val < 10 ? 2 : 1))} ${units[i]}`;
  }

  /* ── Expandable MicroSD details panel updater ─────────────── */
  function updateSdDetailsPanel(state) {
    const sd = state.sdDetails || {};
    const d = state.diagnostics;

    // 1. Card Type
    const typeEl = document.getElementById('sd-detail-type');
    if (typeEl) {
      typeEl.textContent = (sd.cardType && sd.cardType !== 'Unavailable') ? sd.cardType : 'Unavailable';
    }

    // 2. Mount Status
    const mountEl = document.getElementById('sd-detail-mount');
    if (mountEl) {
      if (sd.mounted === true) {
        mountEl.textContent = 'Mounted (Ready)';
        mountEl.className = 'sd-detail-value color-green';
      } else if (sd.mounted === false) {
        mountEl.textContent = 'Not Mounted';
        mountEl.className = 'sd-detail-value color-warn';
      } else {
        mountEl.textContent = 'Unavailable';
        mountEl.className = 'sd-detail-value';
      }
    }

    // 3. Physical Card Capacity
    const capEl = document.getElementById('sd-detail-capacity');
    if (capEl) {
      capEl.textContent = formatBytes(sd.cardSizeBytes);
    }

    // 4. Filesystem Space & Usage Bar
    const fsSumEl = document.getElementById('sd-detail-fs-summary');
    const fsBarEl = document.getElementById('sd-fs-bar');
    const fsBreakEl = document.getElementById('sd-detail-fs-breakdown');
    if (sd.totalBytes && sd.totalBytes > 0) {
      const total = sd.totalBytes;
      const used = sd.usedBytes || 0;
      const avail = sd.availableBytes != null ? sd.availableBytes : (sd.freeBytes != null ? sd.freeBytes : Math.max(0, total - used));
      const pct = Math.min(100, Math.max(0, (used / total) * 100)).toFixed(1);
      if (fsSumEl) fsSumEl.textContent = `${formatBytes(used)} used of ${formatBytes(total)} (${pct}%)`;
      if (fsBarEl) {
        fsBarEl.style.width = `${pct}%`;
        fsBarEl.className = 'sd-usage-bar-fill' + (pct > 90 ? ' danger' : (pct > 75 ? ' warn' : ''));
      }
      if (fsBreakEl) {
        fsBreakEl.textContent = `Total: ${formatBytes(total)} · Used: ${formatBytes(used)} · Available: ${formatBytes(avail)}`;
      }
    } else {
      if (fsSumEl) fsSumEl.textContent = 'Unavailable';
      if (fsBarEl) {
        fsBarEl.style.width = '0%';
        fsBarEl.className = 'sd-usage-bar-fill';
      }
      if (fsBreakEl) fsBreakEl.textContent = 'Total: Unavailable · Used: Unavailable · Available: Unavailable';
    }

    // 5. SPI Pins & Frequency
    const spiEl = document.getElementById('sd-detail-spi');
    if (spiEl) {
      const cs = sd.csPin || 10;
      const mosi = sd.mosiPin || 11;
      const sck = sd.sckPin || 12;
      const miso = sd.misoPin || 13;
      const freq = sd.spiFrequencyHz || sd.sdSpiFrequencyHz || state.sdSpiFrequencyHz;
      let freqStr = 'Unavailable';
      if (freq && freq > 0) {
        freqStr = freq >= 1000000 ? `${(freq / 1000000).toFixed(1)} MHz` : `${Math.round(freq / 1000)} kHz`;
      }
      spiEl.textContent = `CS: ${cs}, MOSI: ${mosi}, SCK: ${sck}, MISO: ${miso} · ${freqStr}`;
    }

    // 6. Offline Log Path
    const pathEl = document.getElementById('sd-detail-log-path');
    if (pathEl) {
      pathEl.textContent = sd.logPath || '/ios/offline_readings.jsonl';
    }

    // 7. Offline Records & Sync State
    const syncStateEl = document.getElementById('sd-detail-sync-state');
    const syncSubEl = document.getElementById('sd-detail-sync-sub');
    if (syncStateEl) {
      const pending = (sd.pendingCount != null) ? sd.pendingCount : (sd.pendingOfflineCount != null ? sd.pendingOfflineCount : state.pendingOfflineCount);
      const synced = (sd.syncedCount != null) ? sd.syncedCount : (state.syncedCount != null ? state.syncedCount : null);
      const pStr = typeof pending === 'number' ? `${pending} pending` : 'Unavailable';
      const sStr = typeof synced === 'number' ? `${synced} synced` : 'Unavailable';
      syncStateEl.textContent = `Pending: ${pStr} · Synced: ${sStr}`;
    }
    if (syncSubEl) {
      const inProgress = sd.syncInProgress || state.syncInProgress;
      const syncState = inProgress ? 'Synchronizing…' : (sd.syncState || 'Idle');
      const syncTs = (sd.lastSyncTs && sd.lastSyncTs > 1000000000000)
        ? sd.lastSyncTs
        : (state.lastSyncTs && state.lastSyncTs > 1000000000000 ? state.lastSyncTs : null);
      let syncTimeStr = 'None yet';
      if (syncTs) {
        syncTimeStr = new Date(syncTs).toLocaleString();
      } else if (sd.lastSyncTs === null && state.lastSyncTs === null) {
        syncTimeStr = 'Unavailable';
      }
      syncSubEl.textContent = `Sync State: ${syncState} · Last sync: ${syncTimeStr}`;
    }

    // 8. Latest SD Error & Status Time
    const errEl = document.getElementById('sd-detail-error');
    const timeEl = document.getElementById('sd-detail-update-time');
    if (errEl) {
      const err = sd.lastError || sd.sdError || state.sdError;
      errEl.textContent = err ? err : 'None';
      if (err && err !== 'None') {
        errEl.className = 'sd-detail-value color-danger';
      } else {
        errEl.className = 'sd-detail-value';
      }
    }
    if (timeEl) {
      const reportTs = (sd.statusTs && sd.statusTs > 1000000000000)
        ? sd.statusTs
        : (state.sdLastReportAt && state.sdLastReportAt > 1000000000000 ? state.sdLastReportAt : (d && d.ts && d.ts > 1000000000000 ? d.ts : null));
      if (reportTs) {
        timeEl.textContent = `Last update: ${new Date(reportTs).toLocaleTimeString()} (${_timeAgo(reportTs)})`;
      } else {
        timeEl.textContent = 'Last update: Unavailable';
      }
    }

    // Bind toggle click once
    const toggleBtn = document.getElementById('sd-details-toggle');
    if (toggleBtn && !toggleBtn._bound) {
      toggleBtn._bound = true;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = document.getElementById('sd-details-panel');
        const item = document.getElementById('diag-sd');
        if (!panel || !item) return;
        const isHidden = panel.classList.contains('hidden');
        if (isHidden) {
          panel.classList.remove('hidden');
          item.classList.add('expanded');
          toggleBtn.setAttribute('aria-expanded', 'true');
          const arrow = toggleBtn.querySelector('.sd-toggle-arrow');
          if (arrow) arrow.textContent = '▴';
        } else {
          panel.classList.add('hidden');
          item.classList.remove('expanded');
          toggleBtn.setAttribute('aria-expanded', 'false');
          const arrow = toggleBtn.querySelector('.sd-toggle-arrow');
          if (arrow) arrow.textContent = '▾';
        }
      });
    }
  }

  /* ── Sensor hardware diagnostics badges ──────────────────── */
  function updateDiagnostics(state) {
    const d = state.diagnostics;
    const sensors = [
      { id: 'diag-dht',   key: 'dht_ok',   detailKey: 'dht',     label: 'DHT22 Sensor (GPIO 4)'       },
      { id: 'diag-rtc',   key: 'rtc_ok',   detailKey: 'rtc',     label: 'DS3231 RTC (I2C 8,9)'        },
      { id: 'diag-tank',  key: 'tank_ok',  detailKey: 'tank',    label: 'HC-SR04 Tank (T:5, E:6)'     },
      { id: 'diag-flow',  key: 'flow_ok',  detailKey: 'flow',    label: 'YF-S201B Flow (GPIO 15)'     },
      { id: 'diag-relay', key: 'relay_ok', detailKey: 'relay',   label: 'Relay Driver (GPIO 18)'      },
    ];

    sensors.forEach(({ id, key, detailKey }) => {
      const row = document.getElementById(id);
      if (!row) return;
      const badge = row.querySelector('.diag-badge');
      const descEl = row.querySelector('.sensor-diag-desc');
      if (!badge) return;

      if (!d) {
        if (id === 'diag-rtc' && state.rtcOk === false) {
          badge.className = 'badge badge-danger diag-badge';
          badge.textContent = '✗ Offline';
          row.style.borderColor = 'rgba(239,68,68,0.4)';
          return;
        }
        // No diagnostics yet — show waiting state
        badge.className = 'badge badge-muted diag-badge';
        badge.textContent = 'Awaiting ESP32…';
        row.style.borderColor = '';
        return;
      }

      const ok = d[key];
      const detail = (d.details && d.details[detailKey]) ? d.details[detailKey] : '';
      const ago = d.ts ? _timeAgo(d.ts) : '';

      badge.className = `badge ${ok ? 'badge-green' : 'badge-danger'} diag-badge`;
      badge.textContent = ok ? '✓ Online' : '✗ Offline';
      row.style.borderColor = ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)';
      if (descEl && detail) {
        descEl.textContent = detail.length > 60 ? detail.slice(0, 57) + '…' : detail;
        descEl.title = detail + (ago ? ` [Tested ${ago}]` : '');
      }
    });

    // ── Dedicated MicroSD Storage Diagnostics Row & Badge ───────
    const sdRow = document.getElementById('diag-sd');
    if (sdRow) {
      const badge = sdRow.querySelector('.diag-badge');
      const descEl = sdRow.querySelector('.sensor-diag-desc');
      const sd = state.sdDetails || (d && d.details && d.details.sd_info) || null;
      const hasReport = !!(sd || (d && (d.sd_ok !== undefined || (d.details && d.details.sd))) || (state.sdStatus && state.sdStatus !== 'Unknown'));
      const isConnected = state.connected !== false;
      const lastUpdateTs = (sd && sd.statusTs && sd.statusTs > 1000000000000)
        ? sd.statusTs
        : (state.sdLastReportAt && state.sdLastReportAt > 1000000000000 ? state.sdLastReportAt : (d && d.ts && d.ts > 1000000000000 ? d.ts : null));
      const isFresh = isConnected && (lastUpdateTs ? (Date.now() - lastUpdateTs <= 120000) : isConnected);

      let status = (sd && sd.status) || state.sdStatus;
      if ((!status || status === 'Unknown') && d && d.sd_ok !== undefined && d.sd_ok !== null) {
        status = d.sd_ok ? 'Ready' : 'Error';
      }

      if (badge) {
        if (!hasReport) {
          badge.className = 'badge badge-muted diag-badge';
          badge.textContent = 'Awaiting ESP32…';
          sdRow.style.borderColor = '';
        } else if (!isFresh) {
          badge.className = 'badge badge-muted diag-badge';
          badge.textContent = 'Device Offline / Stale';
          sdRow.style.borderColor = 'rgba(139,148,158,0.4)';
        } else if (status === 'Ready') {
          badge.className = 'badge badge-green diag-badge';
          badge.textContent = '✓ Ready';
          sdRow.style.borderColor = 'rgba(34,197,94,0.4)';
        } else if (status === 'Missing') {
          badge.className = 'badge badge-warn diag-badge';
          badge.textContent = '⚠ Missing';
          sdRow.style.borderColor = 'rgba(245,158,11,0.4)';
        } else if (status === 'Error') {
          badge.className = 'badge badge-danger diag-badge';
          badge.textContent = '✗ Error';
          sdRow.style.borderColor = 'rgba(239,68,68,0.4)';
        } else {
          badge.className = 'badge badge-muted diag-badge';
          badge.textContent = status || 'Unknown';
          sdRow.style.borderColor = '';
        }
      }

      if (descEl) {
        if (sd && sd.cardType && sd.cardType !== 'Unavailable') {
          descEl.textContent = `${sd.cardType} · ${sd.mounted ? 'Mounted' : 'Unmounted'} (GPIO 10,11,12,13)`;
        } else if (sd && sd.lastError) {
          descEl.textContent = sd.lastError.length > 55 ? sd.lastError.slice(0, 52) + '…' : sd.lastError;
        } else {
          descEl.textContent = 'Offline JSONL Log (GPIO 10,11,12,13)';
        }
      }

      // Update details panel contents
      updateSdDetailsPanel(state);
    }

    // Show last tested timestamp below the grid
    const grid = document.getElementById('sensor-diag-grid');
    if (grid && d && d.ts) {
      let tsEl = document.getElementById('diag-last-tested');
      if (!tsEl) {
        tsEl = document.createElement('p');
        tsEl.id = 'diag-last-tested';
        tsEl.className = 'muted smaller mt-8';
        grid.parentNode.appendChild(tsEl);
      }
      tsEl.textContent = `Last self-test: ${_timeAgo(d.ts)} · Type "test" in Serial Monitor to re-run`;
    }
  }

  function _timeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }



  /* ── Reports page ────────────────────────────────────────── */
  function updateReports(state) {
    CHARTS.drawLineChart('chart-rep-temp', state.reportHistory || [], [
      { key: 'temp', label: 'Temp °C', color: '#EF4444', unit: '°C' },
    ]);
    CHARTS.drawLineChart('chart-rep-hum', state.reportHistory || [], [
      { key: 'humidity', label: 'Humidity %', color: '#3B82F6', unit: '%' },
    ]);

    const message = document.getElementById('report-status');
    if (message) {
      const summary = state.reportSummary;
      document.querySelectorAll('.range-tab').forEach(btn => {
        btn.disabled = !!(summary && summary.supportedRanges && !summary.supportedRanges.includes(btn.dataset.range));
      });
      const rows = state.reportHistory || [];
      if (state.reportError) {
        message.textContent = `Could not refresh reports: ${state.reportError}. Last loaded readings remain visible.`;
      } else if (!rows.length) {
        message.textContent = summary && summary.lastTs
          ? `No readings in this range. Latest saved reading: ${new Date(summary.lastTs).toLocaleString()}. Select All saved to view earlier readings.`
          : 'No saved readings yet. Keep the ESP32 powered and check its backend connection.';
      } else {
        message.textContent = `${rows.length.toLocaleString()} readings shown · ${summary && summary.source === 'sqlite' ? 'Saved in SQLite' : 'Saved on ESP32 (limited history)'}.`;
      }
    }

    const log = document.getElementById('activity-log');
    if (!log) return;

    const TYPE_CLS = { Sensor: 'badge-blue', Mist: 'badge-warn', Bath: 'badge-green', Clean: 'badge-green', Alert: 'badge-danger', Info: 'badge-blue' };
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.reportApiBase || IOS_CONFIG.apiBase : '';

    fetch(`${API}/api/activity?limit=30&range=${state.reportRange || '24h'}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(entries => {
        if (!entries.length) {
          log.innerHTML = `<div class="activity-item"><span class="activity-msg muted">No activity logged yet.</span></div>`;
          return;
        }
        log.innerHTML = entries.map(e => {
          const time = e.ts > 1000000000000 ? new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
          const cls  = TYPE_CLS[e.type] || 'badge-muted';
          return `
            <div class="activity-item">
              <span class="activity-time">${time}</span>
              <span class="badge ${cls}">${e.type}</span>
              <span class="activity-msg">${e.msg}</span>
            </div>`;
        }).join('');
      })
      .catch(() => {
        log.innerHTML = `<div class="activity-item"><span class="activity-msg muted">Could not reach backend for activity log.</span></div>`;
      });
  }

  /* ── Master update ───────────────────────────────────────── */
  function update(state, activePage) {
    updateTopbar(state);
    if (activePage === 'dashboard') updateDashboard(state);
    if (activePage === 'env')       updateEnv(state);
    if (activePage === 'water')     updateWater(state);
    if (activePage === 'auto')      updateAuto(state);
    if (activePage === 'reports')   updateReports(state);
  }

  return { update, updateDashboard, updateEnv, updateWater, updateAuto, updateReports };
})();
