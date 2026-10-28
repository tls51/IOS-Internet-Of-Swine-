/* ============================================================
   pages.js — Page render & live-update handlers
   ============================================================ */

const PAGES = (() => {

  /* ── Water tank SVG ──────────────────────────────────────── */
  function renderTank(containerId, level) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    const hasLevel = level != null && Number.isFinite(Number(level)) && Number(level) >= 0;
    const numLevel = hasLevel ? Math.min(100, Math.max(0, Number(level))) : null;
    const color = numLevel != null ? (numLevel > 60 ? '#22C55E' : numLevel > 30 ? '#F59E0B' : '#EF4444') : 'var(--text-muted, #8B949E)';
    const heightStyle = numLevel != null ? `${numLevel}%` : '0%';
    const labelText = numLevel != null ? `${Math.round(numLevel)}%` : '—';
    wrap.innerHTML = `
      <div class="tank-svg-wrap">
        <div class="tank-fill" style="height:${heightStyle};background:${color}44;border-top:2px solid ${color}"></div>
        <div class="tank-label-inside" style="color:${color}">${labelText}</div>
      </div>
      <span class="tank-sublabel">Water Level</span>`;
  }

  /* ── Alert banner ────────────────────────────────────────── */
  function updateAlerts(state) {
    const el  = document.getElementById('alert-banner');
    const msgs = [];
    const { stressMax = 78, extremeMax = 83 } = state.thiThresholds || {};

    if (state.thi != null) {
      if (state.thi >= extremeMax) {
        msgs.push(`DANGER: THI exceeds ${extremeMax} — immediate cooling required!`);
      } else if (state.thi >= stressMax) {
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

    if (window.updateClockDisplays) {
      window.updateClockDisplays();
    } else if (state.rtcOk === false) {
      const el = document.getElementById('live-time');
      if (el) el.textContent = 'RTC Error';
    } else {
      const el = document.getElementById('live-time');
      if (el) el.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + new Date().toLocaleTimeString();
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
    const todayUsage = state.waterUsedToday != null ? state.waterUsedToday : (state.waterUsed || 0);
    const todayUsageNum = Number(todayUsage);
    document.getElementById('dash-usage').innerHTML = `${Number.isFinite(todayUsageNum) ? todayUsageNum.toFixed(0) : '0'} <span class="muted small">L</span>`;

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
    levelEl.textContent = state.waterLevel != null ? state.waterLevel + '%' : '—';
    levelEl.style.color = (state.waterLevel != null && state.waterLevel > 30) ? '#22C55E' : '#EF4444';
    const todayVal = state.waterUsedToday != null ? state.waterUsedToday : state.waterUsed;
    const usedNum = (typeof todayVal === 'number') ? todayVal : Number(todayVal || 0);
    document.getElementById('water-used-val').textContent = (Number.isFinite(usedNum) ? usedNum.toFixed(2) : '0.00') + ' L';
    document.getElementById('water-flow-val').textContent = (state.flowRate != null ? state.flowRate : 0) + ' L/min';

    /* tank */
    renderTank('water-tank-visual', state.waterLevel);
    document.getElementById('water-tank-note').textContent =
      state.waterLevel == null ? 'No sensor reading'
      : state.waterLevel > 60 ? 'Level OK'
      : state.waterLevel > 30 ? 'Refill recommended'
      : '⚠️ Refill immediately';

    /* breakdown bars: use real breakdown data based on selected range */
    const bd = document.getElementById('water-breakdown');
    const range = state.breakdownRange || 'today';
    const breakdownTitle = document.getElementById('breakdown-title');
    if (breakdownTitle) {
      breakdownTitle.textContent = range === '7d' ? 'Consumption Breakdown (Past 7 Days)' : 'Consumption Breakdown (Today)';
    }

    let mistVal = 0, batheVal = 0, cleanVal = 0, otherVal = 0, totalVal = 0;

    if (range === '7d') {
      const totals = state.waterUsage && state.waterUsage.totals;
      if (totals) {
        mistVal  = Number(totals.mist)  || 0;
        batheVal = Number(totals.bathe) || 0;
        cleanVal = Number(totals.clean) || 0;
        otherVal = Number(totals.other) || 0;
        totalVal = (totals.total != null && Number(totals.total) > 0)
          ? Number(totals.total)
          : (mistVal + batheVal + cleanVal + otherVal);
      }
    } else {
      const now = new Date();
      const localDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const today = (state.waterUsage && state.waterUsage.todayBreakdown && typeof state.waterUsage.todayBreakdown === 'object')
        ? state.waterUsage.todayBreakdown
        : ((state.waterUsage && state.waterUsage.today && typeof state.waterUsage.today === 'object')
            ? state.waterUsage.today
            : ((state.waterUsage && Array.isArray(state.waterUsage.days))
                ? state.waterUsage.days.find(d => d.date === localDateStr)
                : null));

      if (today) {
        mistVal  = Number(today.mist)  || 0;
        batheVal = Number(today.bathe) || 0;
        cleanVal = Number(today.clean) || 0;
        otherVal = Number(today.other) || 0;
        totalVal = (today.total != null && Number(today.total) > 0)
          ? Number(today.total)
          : (mistVal + batheVal + cleanVal + otherVal);
      } else {
        mistVal  = 0;
        batheVal = 0;
        cleanVal = 0;
        otherVal = 0;
        totalVal = 0;
      }
    }

    if (totalVal <= 0 && mistVal <= 0 && batheVal <= 0 && cleanVal <= 0 && otherVal <= 0) {
      bd.innerHTML = `
        <div class="empty-state text-center" style="padding: 24px 0; color: var(--text-muted, #8B949E);">
          <div style="font-size: 24px; margin-bottom: 6px;">💧</div>
          <div style="font-size: 13px;">No water consumption recorded for this period.</div>
        </div>`;
    } else {
      const denom = totalVal > 0 ? totalVal : 1;
      const parts = [
        { label: 'Misting',  val: mistVal,  color: '#22C55E' },
        { label: 'Bathing',  val: batheVal, color: '#3B82F6' },
        { label: 'Cleaning', val: cleanVal, color: '#F59E0B' },
        { label: 'Other',    val: otherVal, color: '#8B949E' },
      ];
      bd.innerHTML = parts.map(p => {
        const valNum = Number.isFinite(p.val) ? p.val : 0;
        const pct = totalVal > 0 ? Math.round((valNum / denom) * 100) : 0;
        return `
          <div class="breakdown-item">
            <div class="breakdown-row">
              <span class="muted">${p.label}</span>
              <span style="font-weight:600">${valNum.toFixed(2)} L (${pct}%)</span>
            </div>
            <div class="breakdown-bar-bg">
              <div class="breakdown-bar-fill" style="width:${pct}%;background:${p.color}"></div>
            </div>
          </div>`;
      }).join('');
    }

    /* bar chart */
    const chartData = (state.waterUsage && Array.isArray(state.waterUsage.days))
      ? state.waterUsage.days
      : (Array.isArray(state.weeklyWater) ? state.weeklyWater : []);

    CHARTS.drawBarChart('chart-water', chartData, [
      { key: 'mist',  label: 'Misting',  color: '#22C55E' },
      { key: 'bathe', label: 'Bathing',  color: '#3B82F6' },
      { key: 'clean', label: 'Cleaning', color: '#F59E0B' },
      { key: 'other', label: 'Other',    color: '#8B949E' },
    ]);
  }

  /* ── Auto systems page ───────────────────────────────────── */
  function updateAuto(state) {
    const threshold = state.threshold;
    const { mistOnSec = 10, mistPauseSec = 5 } = state.operationDurations || {};

    const slider = document.getElementById('threshold-slider');
    const valEl  = document.getElementById('threshold-val');
    if (slider && document.activeElement !== slider) slider.value = threshold;
    if (valEl) valEl.textContent = threshold + '°C';

    /* Update operation duration input fields if not currently focused */
    const inpDur = document.getElementById('inp-mist-dur');
    const inpPause = document.getElementById('inp-mist-pause');
    if (inpDur && document.activeElement !== inpDur) inpDur.value = mistOnSec;
    if (inpPause && document.activeElement !== inpPause) inpPause.value = mistPauseSec;

    /* Update RTC Invalid Alert Banner */
    const rtcBanner = document.getElementById('rtc-invalid-banner');
    if (rtcBanner) {
      if (state.rtcTimeValid === false) {
        rtcBanner.classList.remove('hidden');
      } else {
        rtcBanner.classList.add('hidden');
      }
    }

    /* Update Schedule Cache & Synchronization Card */
    const schedCacheDesc = document.getElementById('sched-cache-desc');
    const schedCacheBadge = document.getElementById('sched-cache-badge');
    const schedPullDesc = document.getElementById('sched-pull-desc');
    const schedPullBadge = document.getElementById('sched-pull-badge');

    const diag = state.scheduleDiag;
    if (schedCacheDesc && schedCacheBadge) {
      if (diag) {
        const local = diag.localCount != null ? diag.localCount : 0;
        const backend = diag.backendCount != null ? diag.backendCount : 0;
        schedCacheDesc.textContent = `Cached in LittleFS: ${local} · Backend active: ${backend}`;
        schedCacheBadge.textContent = `${local} cached`;
        schedCacheBadge.className = local > 0 ? 'badge badge-green' : 'badge badge-muted';
      } else {
        schedCacheDesc.textContent = 'Cached schedules in LittleFS: —';
        schedCacheBadge.textContent = '— cached';
        schedCacheBadge.className = 'badge badge-muted';
      }
    }

    if (schedPullDesc && schedPullBadge) {
      if (diag && diag.lastPullMs > 0) {
        const agoSec = Math.max(0, Math.round((Date.now() - diag.lastPullMs) / 1000));
        const agoStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
        if (diag.lastPullOk) {
          schedPullDesc.textContent = `Last pull: ${agoStr} · Success`;
          schedPullBadge.textContent = '✓ Sync OK';
          schedPullBadge.className = 'badge badge-green';
        } else {
          schedPullDesc.textContent = `Last pull failed: ${diag.lastError || 'Error'} (${agoStr})`;
          schedPullBadge.textContent = '⚠ Sync Error';
          schedPullBadge.className = 'badge badge-danger';
        }
      } else {
        schedPullDesc.textContent = 'Last pull: Never';
        schedPullBadge.textContent = 'Checking…';
        schedPullBadge.className = 'badge badge-muted';
      }
    }

    /* Auto Systems List: Per-relay state, blockedReason, Scheduled now vs Relay ON */
    const relays = state.relays || {
      mist:  { on: !!state.mistActive,  scheduledNow: false, blockedReason: 'none' },
      bath:  { on: !!state.bathActive,  scheduledNow: !!state.bathScheduled, blockedReason: 'none' },
      clean: { on: !!state.cleanActive, scheduledNow: !!state.cleanScheduled, blockedReason: 'none' },
    };

    function blockedReasonLabel(code) {
      if (!code || code === 'none') return null;
      if (code === 'low_water') return 'Blocked: Low Water (<10%)';
      if (code === 'tank_sensor_error') return 'Blocked: Tank Sensor Error';
      if (code === 'rtc_invalid') return 'Blocked: RTC Invalid';
      return `Blocked: ${code}`;
    }

    const systems = [
      {
        key: 'bath',
        label: 'Shower / Bathing System',
        pin: 'GPIO 7',
        icon: '🚿',
        relayOn: relays.bath ? !!relays.bath.on : !!state.bathActive,
        scheduledNow: relays.bath ? !!relays.bath.scheduledNow : !!state.bathScheduled,
        blockedReason: relays.bath ? relays.bath.blockedReason : 'none',
        trigger: 'Schedule-based',
        desc: 'Executes pre-set bathing schedules via relay-controlled pump.'
      },
      {
        key: 'mist',
        label: 'Misting / Cooling System',
        pin: 'GPIO 18',
        icon: '🌫️',
        relayOn: relays.mist ? !!relays.mist.on : !!state.mistActive,
        scheduledNow: false,
        blockedReason: relays.mist ? relays.mist.blockedReason : 'none',
        trigger: `Temp > ${threshold}°C`,
        desc: `Activates when temperature exceeds ${threshold}°C. Cycles: ${mistOnSec} s ON → ${mistPauseSec} s pause.`
      },
      {
        key: 'clean',
        label: 'Waste Cleaning System',
        pin: 'GPIO 15',
        icon: '🧹',
        relayOn: relays.clean ? !!relays.clean.on : !!state.cleanActive,
        scheduledNow: relays.clean ? !!relays.clean.scheduledNow : !!state.cleanScheduled,
        blockedReason: relays.clean ? relays.clean.blockedReason : 'none',
        trigger: 'Schedule-based',
        desc: 'Water-based flushing mechanism on admin-defined schedule.'
      },
    ];

    const list = document.getElementById('auto-sys-list');
    if (list) {
      list.innerHTML = systems.map(s => {
        const badges = [];
        // Scheduled now badge for Bath & Clean
        if (s.key === 'bath' || s.key === 'clean') {
          if (s.scheduledNow) {
            badges.push('<span class="badge badge-blue">Scheduled now</span>');
          } else {
            badges.push('<span class="badge badge-muted">Not scheduled</span>');
          }
        }
        // Relay ON/OFF badge
        if (s.relayOn) {
          badges.push('<span class="badge badge-green"><span class="status-dot" style="background:#22C55E;box-shadow:0 0 6px #22C55E"></span>Relay ON</span>');
        } else {
          badges.push('<span class="badge badge-muted"><span class="status-dot" style="background:#8B949E"></span>Relay OFF</span>');
        }
        // Blocked reason badge
        const blockedText = blockedReasonLabel(s.blockedReason);
        if (blockedText) {
          badges.push(`<span class="badge badge-danger">${blockedText}</span>`);
        }

        return `
        <div class="card auto-card">
          <div class="auto-icon-box${s.relayOn ? ' on' : ''}">${s.icon}</div>
          <div class="auto-body">
            <div class="auto-name">${s.label} <span class="muted small">(${s.pin})</span></div>
            <div class="auto-desc">${s.desc}</div>
            <div class="auto-trigger">Trigger: <span>${s.trigger}</span></div>
            ${blockedText ? `<div class="mt-6" style="color:var(--danger);font-size:12px;font-weight:600;">⚠ ${blockedText}</div>` : ''}
          </div>
          <div class="auto-badges" style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
            ${badges.join('')}
          </div>
        </div>`;
      }).join('');
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
      } else if (state.rtcTimeValid === false) {
        rtcStatus.textContent = 'Invalid / Lost (Needs Sync)';
        rtcStatus.className = 'color-warn';
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
      { id: 'diag-tank',  key: 'tank_ok',  detailKey: 'tank',    label: 'HC-SR04 Tank (GPIO 16/17)'   },
      { id: 'diag-flow',  key: 'flow_ok',  detailKey: 'flow',    label: 'YF-S201B Flow (GPIO 5)'       },
      { id: 'diag-relay', key: 'relay_ok', detailKey: 'relay',   label: 'Relays (GPIO 18, 7, 15)'      },
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
  let _lastRenderedReportHistory = null;
  let _lastRenderedReportRange = null;
  let _lastRenderedSummary = null;
  let _lastRenderedError = null;

  function updateReports(state, force = false) {
    const historyChanged = state.reportHistory !== _lastRenderedReportHistory;
    const rangeChanged   = state.reportRange !== _lastRenderedReportRange;
    const summaryChanged = state.reportSummary !== _lastRenderedSummary;
    const errorChanged   = state.reportError !== _lastRenderedError;

    if (!force && !historyChanged && !rangeChanged && !summaryChanged && !errorChanged) {
      return;
    }

    _lastRenderedReportHistory = state.reportHistory;
    _lastRenderedReportRange   = state.reportRange;
    _lastRenderedSummary       = state.reportSummary;
    _lastRenderedError         = state.reportError;

    CHARTS.drawLineChart('chart-rep-temp', state.reportHistory || [], [
      { key: 'temp', label: 'Temp °C', color: '#EF4444', unit: '°C' },
    ]);
    CHARTS.drawLineChart('chart-rep-hum', state.reportHistory || [], [
      { key: 'humidity', label: 'Humidity %', color: '#3B82F6', unit: '%' },
    ]);

    const message = document.getElementById('report-status');
    if (message) {
      const summary = state.reportSummary;
      const isDevice = (typeof IOS_CONFIG !== 'undefined' && IOS_CONFIG.mode === 'device');
      document.querySelectorAll('#page-reports .range-tab').forEach(btn => {
        const r = btn.dataset.range;
        if (isDevice && (r === '7d' || r === '30d')) {
          btn.disabled = true;
          btn.title = '7d/30d reports require Node backend connection';
        } else {
          btn.disabled = !!(summary && summary.supportedRanges && !summary.supportedRanges.includes(r));
        }
      });
      const rows = state.reportHistory || [];
      if (state.reportError) {
        message.textContent = `Could not refresh reports: ${state.reportError}. Last loaded readings remain visible.`;
      } else if (!rows.length) {
        message.textContent = summary && summary.lastTs
          ? `No readings in this range. Latest saved reading: ${new Date(summary.lastTs).toLocaleString()}. Select All saved to view earlier readings.`
          : 'No saved readings yet. Keep the ESP32 powered and check its backend connection.';
      } else {
        message.textContent = `${rows.length.toLocaleString()} points shown · ${summary && summary.source === 'sqlite' ? 'Saved in SQLite' : 'Saved on ESP32 (limited history)'}.`;
      }
    }

    const log = document.getElementById('activity-log');
    if (!log) return;

    const TYPE_CLS = { Sensor: 'badge-blue', Mist: 'badge-warn', Bath: 'badge-green', Clean: 'badge-green', Alert: 'badge-danger', Info: 'badge-blue' };
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.reportApiBase || IOS_CONFIG.apiBase : '';
    const doFetch = (typeof authFetch === 'function') ? authFetch : fetch;

    doFetch(`${API}/api/activity?limit=30&range=${state.reportRange || '24h'}`)
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
