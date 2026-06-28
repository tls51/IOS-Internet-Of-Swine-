/* ============================================================
   schedule.js — Schedule management (CRUD) & modal logic
   ============================================================ */

const SCHEDULE = (() => {

  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  /* ── Default schedules ───────────────────────────────────── */
  let bathSchedules = [
    { id: 1, label: 'Morning Bath',   time: '06:00', duration: 15, days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true  },
    { id: 2, label: 'Afternoon Bath', time: '14:00', duration: 15, days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true  },
  ];
  let cleanSchedules = [
    { id: 1, label: 'Daily Flush',    time: '07:00', duration: 10, days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true  },
    { id: 2, label: 'Evening Clean',  time: '18:00', duration: 10, days: ['Mon','Wed','Fri'],                         active: false },
  ];

  let _modalType = 'bath';
  let _selectedDays = ['Mon','Wed','Fri'];

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
      tog.addEventListener('click', () => {
        s.active = !s.active;
        renderList(listId, countId, schedules, type);
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
      del.addEventListener('click', () => {
        if (type === 'bath')  bathSchedules  = bathSchedules.filter(x => x.id !== s.id);
        else                  cleanSchedules = cleanSchedules.filter(x => x.id !== s.id);
        renderList(listId, countId, type === 'bath' ? bathSchedules : cleanSchedules, type);
      });

      row.appendChild(tog);
      row.appendChild(info);
      row.appendChild(badge);
      row.appendChild(del);
      listEl.appendChild(row);
    });
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
  function saveModal() {
    const time  = document.getElementById('modal-time').value;
    const dur   = parseInt(document.getElementById('modal-dur').value) || 15;
    const label = `${_modalType === 'bath' ? 'Bath' : 'Clean'} ${time}`;
    const entry = { id: Date.now(), label, time, duration: dur, days: [..._selectedDays], active: true };

    if (_modalType === 'bath') {
      bathSchedules.push(entry);
      renderList('bath-list', 'bath-count', bathSchedules, 'bath');
    } else {
      cleanSchedules.push(entry);
      renderList('clean-list', 'clean-count', cleanSchedules, 'clean');
    }
    closeModal();
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    renderList('bath-list',  'bath-count',  bathSchedules,  'bath');
    renderList('clean-list', 'clean-count', cleanSchedules, 'clean');

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
