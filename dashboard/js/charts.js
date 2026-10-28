/* ============================================================
   charts.js — Lightweight SVG chart renderer
   No external dependencies.
   ============================================================ */

const CHARTS = (() => {

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ── helpers ─────────────────────────────────────────────── */
  function el(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function poly(pts) {
    return pts.map(([x, y]) => `${x},${y}`).join(' ');
  }

  function polyPath(pts) {
    if (!pts.length) return '';
    return 'M' + pts.map(([x, y]) => `${x} ${y}`).join(' L');
  }

  /* ── scale helpers ───────────────────────────────────────── */
  function scaleX(i, total, W, pad) {
    if (total <= 1) return W / 2;
    return pad + (i / (total - 1)) * (W - pad * 2);
  }
  function scaleY(v, min, max, H, padT, padB) {
    return padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  }

  /* ── build SVG scaffold ──────────────────────────────────── */
  function scaffold(container, W, H) {
    container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ios-chart' });
    container.appendChild(svg);
    const tt = document.createElement('div');
    tt.className = 'chart-tooltip';
    container.appendChild(tt);
    return { svg, tt, W, H };
  }

  /* ── Line / Area chart ───────────────────────────────────── */
  function drawLineChart(containerId, data, series, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    data = (Array.isArray(data) ? data : []).filter(d => series.some(s => Number.isFinite(d[s.key])));
    if (!data.length) {
      container.innerHTML = '';
      const empty = document.createElement('p');
      empty.className = 'muted'; empty.textContent = 'No readings in this range.';
      container.appendChild(empty);
      return;
    }

    // Cap points to prevent SVG rendering bottlenecks (max 400 points)
    const MAX_CHART_POINTS = 400;
    if (data.length > MAX_CHART_POINTS) {
      const step = Math.ceil(data.length / MAX_CHART_POINTS);
      data = data.filter((_, i) => i % step === 0 || i === data.length - 1);
    }

    const W = container.clientWidth || 600;
    const H = container.clientHeight || 220;
    const padL = 40, padR = 12, padT = 20, padB = 30;

    const { svg, tt } = scaffold(container, W, H);

    /* defs for gradients */
    const defs = el('defs');
    series.forEach(s => {
      if (!s.area) return;
      const grad = el('linearGradient', { id: `grad-${containerId}-${s.key}`, x1: '0', y1: '0', x2: '0', y2: '1' });
      const s1 = el('stop', { offset: '0%',   'stop-color': s.color, 'stop-opacity': '.3' });
      const s2 = el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': '0'  });
      grad.appendChild(s1); grad.appendChild(s2);
      defs.appendChild(grad);
    });
    svg.appendChild(defs);

    /* y-range across all series */
    const allVals = data.flatMap(d => series.map(s => d[s.key])).filter(Number.isFinite);
    let minV = Math.floor(allVals.reduce((a, b) => Math.min(a, b), Infinity) - 2);
    let maxV = Math.ceil(allVals.reduce((a, b) => Math.max(a, b), -Infinity) + 4);

    /* reference lines */
    (opts.refLines || []).forEach(r => {
      const y = scaleY(r.value, minV, maxV, H, padT, padB);
      const l = el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: r.cls || 'ref-warn' });
      svg.appendChild(l);
      const lbl = el('text', { x: W - padR - 2, y: y - 3, class: 'ref-label', 'text-anchor': 'end' });
      lbl.textContent = r.label;
      svg.appendChild(lbl);
    });

    /* grid lines */
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = minV + (maxV - minV) * (i / steps);
      const y = scaleY(v, minV, maxV, H, padT, padB);
      svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
      const lbl = el('text', { x: padL - 4, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      lbl.textContent = Math.round(v);
      svg.appendChild(lbl);
    }

    /* x-axis labels */
    const labelEvery = Math.max(1, Math.floor(data.length / 8));
    data.forEach((d, i) => {
      if (i % labelEvery !== 0) return;
      const x = scaleX(i, data.length, W, padL);
      const lbl = el('text', { x, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' });
      lbl.textContent = d.label || d.time || '';
      svg.appendChild(lbl);
    });

    /* series */
    series.forEach(s => {
      const pts = data.flatMap((d, i) => Number.isFinite(d[s.key]) ? [[
        scaleX(i, data.length, W, padL),
        scaleY(d[s.key], minV, maxV, H, padT, padB),
      ]] : []);
      if (!pts.length) return;
      if (pts.length === 1) svg.appendChild(el('circle', { cx: pts[0][0], cy: pts[0][1], r: 4, fill: s.color }));

      if (s.area) {
        const areaBottom = scaleY(minV, minV, maxV, H, padT, padB);
        const areaPath = polyPath(pts) + ` L${pts[pts.length-1][0]} ${areaBottom} L${pts[0][0]} ${areaBottom} Z`;
        svg.appendChild(el('path', { d: areaPath, fill: `url(#grad-${containerId}-${s.key})` }));
      }

      const path = el('path', { d: polyPath(pts), fill: 'none', stroke: s.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      svg.appendChild(path);
    });

    /* hover overlay */
    const overlay = el('rect', { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: 'transparent' });
    const vLine   = el('line', { x1: 0, y1: padT, x2: 0, y2: H - padB, stroke: '#fff', 'stroke-width': '1', 'stroke-dasharray': '3 3', opacity: '0' });
    svg.appendChild(overlay);
    svg.appendChild(vLine);

    overlay.addEventListener('mousemove', e => {
      const rect = container.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const pct  = (mx - padL) / (W - padL - padR);
      const idx  = Math.round(pct * (data.length - 1));
      if (idx < 0 || idx >= data.length) return;

      const d = data[idx];
      const x = scaleX(idx, data.length, W, padL);
      vLine.setAttribute('x1', x);
      vLine.setAttribute('x2', x);
      vLine.setAttribute('opacity', '0.4');

      let html = `<div class="tt-row" style="font-weight:600;color:var(--text);margin-bottom:4px">${d.label || d.time || ''}</div>`;
      series.forEach(s => {
        html += `<div class="tt-row"><span><span class="tt-dot" style="background:${s.color}"></span>${s.label}</span><span style="color:${s.color};font-weight:600">${d[s.key]}${s.unit||''}</span></div>`;
      });
      tt.innerHTML = html;
      tt.classList.add('visible');
      const tl = Math.min(mx + 12, W - 150);
      tt.style.left = tl + 'px';
      tt.style.top  = '10px';
    });
    overlay.addEventListener('mouseleave', () => {
      tt.classList.remove('visible');
      vLine.setAttribute('opacity', '0');
    });

    /* legend */
    const leg = document.createElement('div');
    leg.className = 'chart-legend';
    series.forEach(s => {
      leg.innerHTML += `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`;
    });
    container.appendChild(leg);
  }

  /* ── Bar chart (Stacked) ──────────────────────────────────── */
  function drawBarChart(containerId, data, series) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!Array.isArray(data) || data.length === 0) {
      container.innerHTML = '';
      const empty = document.createElement('p');
      empty.className = 'muted chart-empty-state';
      empty.textContent = 'No water usage recorded';
      empty.style.cssText = 'text-align:center;padding:48px 16px;color:var(--text-muted,#8b949e);font-size:14px;';
      container.appendChild(empty);
      return;
    }

    const W = container.clientWidth || 600;
    const H = container.clientHeight || 200;
    const padL = 40, padR = 12, padT = 16, padB = 30;

    const { svg, tt } = scaffold(container, W, H);

    const allVals = data.map(d => {
      if (d.total != null && Number.isFinite(Number(d.total))) return Number(d.total);
      return series.reduce((s, sr) => s + (Number(d[sr.key]) || 0), 0);
    });
    const maxV    = Math.max(1, Math.ceil(allVals.reduce((a, b) => Math.max(a, b), 0) * 1.15));

    /* grid */
    for (let i = 0; i <= 4; i++) {
      const v = (maxV / 4) * i;
      const y = scaleY(v, 0, maxV, H, padT, padB);
      svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
      const lbl = el('text', { x: padL - 4, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      lbl.textContent = (v % 1 === 0) ? `${v} L` : `${v.toFixed(1)} L`;
      svg.appendChild(lbl);
    }

    const availW = W - padL - padR;
    const groupW = availW / data.length;
    const barW   = Math.max(2, Math.min(groupW * 0.7, 32));
    const labelInterval = data.length > 14 ? Math.ceil(data.length / 7) : 1;

    data.forEach((d, gi) => {
      const cx = padL + gi * groupW + groupW / 2;
      const bx = cx - barW / 2;
      let currentY = H - padB;

      const seriesSum = series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0);
      const totalNum = Number(d.total) || 0;

      series.forEach((s) => {
        let val = Number(d[s.key]) || 0;
        if (s.key === 'other' && val <= 0 && seriesSum <= 0 && totalNum > 0) {
          val = totalNum;
        }
        if (val <= 0) return;
        const bh = (val / maxV) * (H - padT - padB);
        const by = currentY - bh;
        const rect = el('rect', {
          x: bx, y: by, width: barW, height: bh,
          fill: s.color, rx: '2',
        });
        svg.appendChild(rect);
        currentY = by;
      });

      /* x label */
      if (gi % labelInterval === 0 || gi === data.length - 1) {
        const lbl = el('text', { x: cx, y: H - 8, class: 'axis-label', 'text-anchor': 'middle' });
        let dateText = d.day || d.label || '';
        if (d.date) {
          const parts = String(d.date).split('-');
          const md = parts.length >= 3 ? `${Number(parts[1])}/${Number(parts[2])}` : d.date;
          dateText = (data.length <= 7 && d.day) ? `${md} ${d.day}` : md;
        }
        lbl.textContent = dateText;
        svg.appendChild(lbl);
      }
    });

    /* hover overlay */
    const overlay = el('rect', {
      x: padL, y: padT, width: availW, height: H - padT - padB,
      fill: 'transparent', style: 'cursor:crosshair;'
    });
    svg.appendChild(overlay);

    overlay.addEventListener('mousemove', (e) => {
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const idx = Math.floor((mx - padL) / groupW);
      if (idx < 0 || idx >= data.length) return;

      const d = data[idx];
      let header = d.date || d.day || '';
      if (d.date && d.day && d.date !== '—') header = `${d.date} (${d.day})`;
      let html = `<div class="tt-row" style="font-weight:600;color:var(--text);margin-bottom:4px">${header}</div>`;
      let totalL = 0;
      const seriesSum = series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0);
      const totalNum = Number(d.total) || 0;

      series.forEach(s => {
        let val = Number(d[s.key]) || 0;
        if (s.key === 'other' && val <= 0 && seriesSum <= 0 && totalNum > 0) {
          val = totalNum;
        }
        totalL += val;
        html += `<div class="tt-row"><span><span class="tt-dot" style="background:${s.color}"></span>${s.label}</span><span style="color:${s.color};font-weight:600">${val.toFixed(2)} L</span></div>`;
      });
      const displayedTotal = (d.total != null && Number.isFinite(Number(d.total))) ? Number(d.total) : totalL;
      html += `<div class="tt-row" style="border-top:1px solid rgba(255,255,255,.1);margin-top:4px;padding-top:4px;font-weight:600"><span>Total</span><span>${displayedTotal.toFixed(2)} L</span></div>`;
      tt.innerHTML = html;
      tt.classList.add('visible');
      const tl = Math.min(Math.max(mx + 12, padL), W - 160);
      tt.style.left = tl + 'px';
      tt.style.top  = '10px';
    });
    overlay.addEventListener('mouseleave', () => {
      tt.classList.remove('visible');
    });

    /* legend */
    const leg = document.createElement('div');
    leg.className = 'chart-legend';
    series.forEach(s => {
      leg.innerHTML += `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`;
    });
    container.appendChild(leg);
  }

  /* ── Public ──────────────────────────────────────────────── */
  return { drawLineChart, drawBarChart };
})();
