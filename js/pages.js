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
    document.getElementById('live-time').textContent = new Date().toLocaleTimeString();

    /* connection indicator */
    const dot   = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (dot && label) {
      dot.style.background   = state.connected ? 'var(--primary)' : 'var(--danger)';
      dot.style.boxShadow    = state.connected ? '0 0 6px var(--primary)' : '0 0 6px var(--danger)';
      label.textContent      = state.connected ? 'Online · ESP32 Active' : 'Offline · Backend unreachable';
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
    const isPumpOn = state.relayState || state.manualPumpActive || state.mistActive || state.bathActive || state.cleanActive;
    const pumpIcon = document.getElementById('pump-indicator-icon');
    const pumpText = document.getElementById('pump-relay-text');
    const pumpBadge = document.getElementById('pump-live-badge');
    const toggleBtnTxt = document.getElementById('btn-toggle-pump-text');
    const resultBox = document.getElementById('pump-test-result');
    const resultMsg = document.getElementById('pump-test-msg');

    if (pumpIcon) {
      pumpIcon.classList.toggle('active', isPumpOn);
      pumpIcon.textContent = isPumpOn ? '💧' : '⚡';
    }
    if (pumpText) {
      pumpText.textContent = isPumpOn ? 'Active (Water Pump Running)' : 'Standby (OFF)';
      pumpText.style.color = isPumpOn ? 'var(--primary)' : 'var(--blue)';
    }
    if (pumpBadge) {
      pumpBadge.className = `badge ${isPumpOn ? 'badge-green' : 'badge-muted'}`;
      pumpBadge.textContent = isPumpOn ? '✓ Pump ON' : 'Relay Standby';
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

    updateDiagnostics(state);
  }

  /* ── Sensor hardware diagnostics badges ──────────────────── */
  function updateDiagnostics(state) {
    const d = state.diagnostics;
    const sensors = [
      { id: 'diag-dht',   key: 'dht_ok',   detailKey: 'dht',     label: 'DHT22 Sensor (GPIO 4)'       },
      { id: 'diag-rtc',   key: 'rtc_ok',   detailKey: 'rtc',     label: 'DS3231 RTC (I2C 8,9)'        },
      { id: 'diag-tank',  key: 'tank_ok',  detailKey: 'tank',    label: 'HC-SR04 Tank (T:5, E:6)'     },
      { id: 'diag-flow',  key: 'flow_ok',  detailKey: 'flow',    label: 'YF-S201B Flow (GPIO 15)'     },
      { id: 'diag-relay', key: 'relay_ok', detailKey: 'relay',   label: 'Relay Driver (GPIO 7)'       },
    ];

    sensors.forEach(({ id, key, detailKey }) => {
      const row = document.getElementById(id);
      if (!row) return;
      const badge = row.querySelector('.diag-badge');
      const descEl = row.querySelector('.sensor-diag-desc');
      if (!badge) return;

      if (!d) {
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
    CHARTS.drawLineChart('chart-rep-temp', state.history, [
      { key: 'temp', label: 'Temp °C', color: '#EF4444', unit: '°C' },
    ]);
    CHARTS.drawLineChart('chart-rep-hum', state.history, [
      { key: 'humidity', label: 'Humidity %', color: '#3B82F6', unit: '%' },
    ]);

    const log = document.getElementById('activity-log');
    if (!log) return;

    const TYPE_CLS = { Sensor: 'badge-blue', Mist: 'badge-warn', Bath: 'badge-green', Clean: 'badge-green', Alert: 'badge-danger', Info: 'badge-blue' };
    const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';

    fetch(`${API}/api/activity?limit=30`)
      .then(r => r.json())
      .then(entries => {
        if (!entries.length) {
          log.innerHTML = `<div class="activity-item"><span class="activity-msg muted">No activity logged yet.</span></div>`;
          return;
        }
        log.innerHTML = entries.map(e => {
          const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
