/* ============================================================
   schedule.js — Schedule management (CRUD) & modal logic
   Now persisted server-side (Node/SQLite) instead of an
   in-memory array, so schedules survive a page refresh and are
   shared across anyone viewing the dashboard.
   ============================================================ */

const SCHEDULE = (() => {

  const API = (typeof IOS_CONFIG !== 'undefined') ? IOS_CONFIG.apiBase : 'http://localhost:3000';
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  let _modalType = 'bath';
  let _selectedDays = ['Mon','Wed','Fri'];

  /* ── API helpers ─────────────────────────────────────────── */
  async function fetchSchedules(type) {
    const res = await fetch(`${API}/api/schedules?type=${type}`);
    if (!res.ok) throw new Error(`Failed to load ${type} schedules`);
    return res.json();
  }

  async function createSchedule(entry) {
    const res = await fetch(`${API}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error('Failed to create schedule');
    return res.json();
  }

  async function toggleScheduleActive(id, active) {
    const res = await fetch(`${API}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) throw new Error('Failed to update schedule');
    return res.json();
  }

  async function deleteScheduleById(id) {
    const res = await fetch(`${API}/api/schedules/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete schedule');
  }

  /* ── Toggle button ───────────────────────────────────────── */
  function renderToggle(active) {
    const btn = document.createElement('button');
    btn.className = 'toggle-btn';
    btn.style.background = active ? 'var(--primary)' : 'var(--border)';
    const knob = document.createElement('div');
    knob.className = 'toggle-knob';
    knob.style.left = active ? '22px' : '3px';
    btn.appendChild(knob);
    return btn;
  }

  /* ── Render a schedule list ──────────────────────────────── */
  function renderList(listId, countId, schedules, type) {
    const listEl  = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    if (!listEl) return;

    listEl.innerHTML = '';
    const active = schedules.filter(s => s.active).length;
    countEl.textContent = `${active} of ${schedules.length} schedule${schedules.length !== 1 ? 's' : ''} active`;

    schedules.forEach(s => {
      const row = document.createElement('div');
      row.className = 'sched-row';

      /* toggle */
      const tog = renderToggle(s.active);
      tog.addEventListener('click', async () => {
        try {
          const nextActive = !s.active;
          await toggleScheduleActive(s.id, nextActive);
          await reloadList(type);
          if (typeof NOTIFY !== 'undefined') {
            NOTIFY.show({
              title: nextActive ? 'Schedule Activated' : 'Schedule Paused',
              message: `${s.label} (${s.days.join(', ')}) is now ${nextActive ? 'active' : 'paused'}.`,
              type: nextActive ? 'success' : 'warning',
              icon: nextActive ? '▶️' : '⏸️',
              duration: 3500
            });
          }
        } catch (err) {
          console.error(err);
          if (typeof NOTIFY !== 'undefined') {
            NOTIFY.show({
              title: 'Update Failed',
              message: err.message || 'Could not update schedule status',
              type: 'error'
            });
          }
        }
      });

      /* info */
      const info = document.createElement('div');
      info.className = 'sched-info';
      info.innerHTML = `<div class="sched-name">${s.label}</div>
        <div class="sched-meta">${s.days.join(', ')} · ${s.time} · ${s.duration} min</div>`;

      /* badge */
      const badge = document.createElement('span');
      badge.className = `badge ${s.active ? 'badge-green' : 'badge-muted'}`;
      badge.textContent = s.active ? 'Active' : 'Paused';

      /* delete */
      const del = document.createElement('button');
      del.className = 'sched-del';
      del.textContent = '×';
      del.title = 'Delete';
      del.addEventListener('click', async () => {
        try {
          await deleteScheduleById(s.id);
          await reloadList(type);
          if (typeof NOTIFY !== 'undefined') {
            NOTIFY.show({
              title: 'Schedule Deleted',
              message: `${s.label} was removed.`,
              type: 'info',
              icon: '🗑️',
              duration: 3500
            });
          }
        } catch (err) {
          console.error(err);
          if (typeof NOTIFY !== 'undefined') {
            NOTIFY.show({
              title: 'Deletion Failed',
              message: err.message || 'Could not delete schedule',
              type: 'error'
            });
          }
        }
      });

      row.appendChild(tog);
      row.appendChild(info);
      row.appendChild(badge);
      row.appendChild(del);
      listEl.appendChild(row);
    });
  }

  async function reloadList(type) {
    const [listId, countId] = type === 'bath' ? ['bath-list', 'bath-count'] : ['clean-list', 'clean-count'];
    try {
      const schedules = await fetchSchedules(type);
      renderList(listId, countId, schedules, type);
    } catch (err) {
      console.warn(`Could not load ${type} schedules — is the backend running?`, err.message);
    }
  }

  /* ── Day picker ──────────────────────────────────────────── */
  function buildDayPicker() {
    const picker = document.getElementById('day-picker');
    picker.innerHTML = '';
    DAYS.forEach(d => {
      const btn = document.createElement('button');
      btn.className = `day-btn${_selectedDays.includes(d) ? ' selected' : ''}`;
      btn.textContent = d;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (_selectedDays.includes(d)) {
          _selectedDays = _selectedDays.filter(x => x !== d);
        } else {
          _selectedDays = [..._selectedDays, d];
        }
        btn.classList.toggle('selected', _selectedDays.includes(d));
      });
      picker.appendChild(btn);
    });
  }

  /* ── Open modal ──────────────────────────────────────────── */
  function openModal(type) {
    _modalType     = type;
    _selectedDays  = ['Mon','Wed','Fri'];
    document.getElementById('modal-title').textContent = `Add ${type === 'bath' ? 'Bathing' : 'Cleaning'} Schedule`;
    document.getElementById('modal-time').value = '06:00';
    document.getElementById('modal-dur').value  = '15';
    buildDayPicker();
    document.getElementById('sched-modal').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('sched-modal').classList.add('hidden');
  }

  /* ── Save ────────────────────────────────────────────────── */
  async function saveModal() {
    const time  = document.getElementById('modal-time').value;
    const dur   = parseInt(document.getElementById('modal-dur').value) || 15;

    if (!_selectedDays.length) {
      if (typeof NOTIFY !== 'undefined') {
        NOTIFY.show({
          title: 'Select Days',
          message: 'Please pick at least one day of the week.',
          type: 'warning',
          icon: '📅'
        });
      } else {
        alert('Please pick at least one day of the week.');
      }
      return;
    }

    if (!time) {
      if (typeof NOTIFY !== 'undefined') {
        NOTIFY.show({
          title: 'Select Time',
          message: 'Please provide a valid time for the schedule.',
          type: 'warning',
          icon: '⏰'
        });
      } else {
        alert('Please provide a valid time.');
      }
      return;
    }

    const typeLabel = _modalType === 'bath' ? 'Bathing' : 'Cleaning';
    const label = `${_modalType === 'bath' ? 'Bath' : 'Clean'} ${time}`;
    const entry = { type: _modalType, label, time, duration: dur, days: [..._selectedDays] };

    try {
      await createSchedule(entry);
      await reloadList(_modalType);

      if (typeof NOTIFY !== 'undefined') {
        const icon = _modalType === 'bath' ? '🚿' : '🧹';
        NOTIFY.show({
          title: `${typeLabel} Schedule Scheduled!`,
          message: `${label} (${entry.days.join(', ')}) set for ${dur} minutes.`,
          type: 'success',
          icon: icon,
          duration: 5000
        });
      }
    } catch (err) {
      console.error(err);
      if (typeof NOTIFY !== 'undefined') {
        NOTIFY.show({
          title: 'Scheduling Failed',
          message: err.message || 'Could not save schedule. Is backend active?',
          type: 'error',
          icon: '❌'
        });
      }
    }
    closeModal();
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    reloadList('bath');
    reloadList('clean');

    document.getElementById('btn-add-bath') .addEventListener('click', () => openModal('bath'));
    document.getElementById('btn-add-clean').addEventListener('click', () => openModal('clean'));
    document.getElementById('modal-close')  .addEventListener('click', closeModal);
    document.getElementById('modal-cancel') .addEventListener('click', closeModal);
    document.getElementById('modal-save')   .addEventListener('click', saveModal);

    document.getElementById('sched-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
  }

  return { init };
})();
