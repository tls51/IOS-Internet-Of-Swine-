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
    if (!container || !data.length) return;

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
    const allVals = data.flatMap(d => series.map(s => d[s.key])).filter(v => v != null);
    let minV = Math.floor(Math.min(...allVals) - 2);
    let maxV = Math.ceil(Math.max(...allVals) + 4);

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
      lbl.textContent = d.time;
      svg.appendChild(lbl);
    });

    /* series */
    series.forEach(s => {
      const pts = data.map((d, i) => [
        scaleX(i, data.length, W, padL),
        scaleY(d[s.key], minV, maxV, H, padT, padB),
      ]);

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

      let html = `<div class="tt-row" style="font-weight:600;color:var(--text);margin-bottom:4px">${d.time}</div>`;
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

  /* ── Bar chart ───────────────────────────────────────────── */
  function drawBarChart(containerId, data, series) {
    const container = document.getElementById(containerId);
    if (!container || !data.length) return;

    const W = container.clientWidth || 600;
    const H = container.clientHeight || 200;
    const padL = 40, padR = 12, padT = 16, padB = 30;

    const { svg, tt } = scaffold(container, W, H);

    const allVals = data.map(d => series.reduce((s, sr) => s + d[sr.key], 0));
    const maxV    = Math.ceil(Math.max(...allVals) * 1.15);

    /* grid */
    for (let i = 0; i <= 4; i++) {
      const v = (maxV / 4) * i;
      const y = scaleY(v, 0, maxV, H, padT, padB);
      svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
      const lbl = el('text', { x: padL - 4, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      lbl.textContent = Math.round(v);
      svg.appendChild(lbl);
    }

    const groupW = (W - padL - padR) / data.length;
    const gap    = groupW * 0.15;
    const barW   = (groupW - gap * 2) / series.length;

    data.forEach((d, gi) => {
      const gx = padL + gi * groupW + gap;
      series.forEach((s, si) => {
        const bx = gx + si * barW;
        const bh = (d[s.key] / maxV) * (H - padT - padB);
        const by = H - padB - bh;
        const rect = el('rect', {
          x: bx, y: by, width: barW - 2, height: bh,
          fill: s.color, rx: '3',
        });
        svg.appendChild(rect);
      });
      /* x label */
      const lbl = el('text', { x: gx + (groupW - gap * 2) / 2, y: H - 6, class: 'axis-label', 'text-anchor': 'middle' });
      lbl.textContent = d.day || d.label || '';
      svg.appendChild(lbl);
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
