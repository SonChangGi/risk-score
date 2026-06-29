(() => {
  'use strict';

  const DATA_BASE = 'data/risk-score/';
  const FILES = {
    summary: `${DATA_BASE}risk_score_summary.json`,
    daily: `${DATA_BASE}risk_score_daily.json`,
    backtest: `${DATA_BASE}risk_score_backtest.json`,
  };
  const state = { summary: null, daily: null, backtest: null, mode: 'event', period: 'full' };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  document.addEventListener('DOMContentLoaded', () => {
    bindControls();
    loadData();
  });

  function bindControls() {
    $$('.toggle').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode || 'event';
        $$('.toggle').forEach((item) => item.classList.toggle('active', item === button));
        renderBacktest();
      });
    });
    const period = $('#period-select');
    if (period) {
      period.addEventListener('change', () => {
        state.period = period.value || 'full';
        renderBacktest();
      });
    }
  }

  async function loadData() {
    setStatus('loading', '정적 JSON을 불러오는 중...');
    try {
      const [summary, daily, backtest] = await Promise.all([
        fetchJson(FILES.summary),
        fetchJson(FILES.daily),
        fetchJson(FILES.backtest),
      ]);
      state.summary = summary;
      state.daily = daily;
      state.backtest = backtest;
      renderAll();
    } catch (error) {
      setStatus('error', `데이터 로드 실패: ${error.message}`);
      renderError(error);
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.json();
  }

  function renderAll() {
    const current = state.summary?.riskScore?.current || {};
    setStatus(current.actionLevel || 'ok', `Data as of ${formatDate(state.summary.dataAsOf)} · generated ${formatDateTime(state.summary.generatedAt)}`);
    renderSummary(current);
    renderFactors(state.summary?.riskScore?.factorBreakdown || []);
    renderCharts(state.daily?.rows || []);
    setupBacktestPeriods();
    renderBacktest();
    renderHistory(state.summary?.riskScore?.recentSignals || []);
    renderSources(state.summary);
  }

  function setStatus(level, text) {
    const target = $('#app-status');
    if (!target) return;
    target.innerHTML = `<span class="status-chip ${classForLevel(level)}">${escapeHtml(text)}</span>`;
  }

  function renderError(error) {
    const summaryCards = $('#summary-cards');
    if (summaryCards) {
      summaryCards.innerHTML = `<article class="metric-card"><span class="label">Error</span><strong class="value">데이터 없음</strong><p class="detail">${escapeHtml(error.message)}. 먼저 <code>python scripts/update_risk_score_data.py</code>를 실행하세요.</p></article>`;
    }
  }

  function renderSummary(current) {
    const cards = [
      ['SOX latest close', formatPrice(current.close), formatDate(current.date), 'neutral'],
      ['1D return', formatPercent(current.oneDayReturn, 2), 'Daily close 기준', toneForReturn(current.oneDayReturn)],
      ['OH Score', scoreText(current.ohScore), '과열형 top model', scoreTone(current.ohScore)],
      ['RF Score', scoreText(current.rfScore), '반등 실패형 top model', scoreTone(current.rfScore)],
      ['Top Risk Score', scoreText(current.topRiskScore), `Regime: ${current.regime || '-'}`, scoreTone(current.topRiskScore)],
      ['Confirmation', current.confirmation ? 'ON' : 'OFF', current.confirmation ? 'confirmed_top_risk = true' : 'leading setup only or inactive', current.confirmation ? 'confirmed-red' : 'normal'],
    ];
    const target = $('#summary-cards');
    if (target) {
      target.innerHTML = cards.map(([label, value, detail, tone]) => `
        <article class="metric-card ${classForLevel(tone)}">
          <span class="label">${escapeHtml(label)}</span>
          <strong class="value">${escapeHtml(value)}</strong>
          <p class="detail">${escapeHtml(detail)}</p>
        </article>
      `).join('');
    }
    const action = $('#current-action');
    if (action) {
      action.className = `action-card ${classForLevel(current.actionLevel)}`;
      action.innerHTML = `<span>${escapeHtml(current.actionLabel || 'Unknown')}</span><strong>${escapeHtml(current.regime || '-')}</strong><p>${escapeHtml(current.actionText || '데이터를 확인할 수 없습니다.')}</p>`;
    }
  }

  function renderFactors(factors) {
    const target = $('#factor-table-body');
    if (!target) return;
    if (!factors.length) {
      target.innerHTML = '<tr><td colspan="6">Factor data unavailable.</td></tr>';
      return;
    }
    target.innerHTML = factors.map((row) => `
      <tr>
        <td>${escapeHtml(row.factor)}</td>
        <td>${formatFactorValue(row.currentValue, row.factor)}</td>
        <td>${escapeHtml(String(row.threshold ?? '-'))}</td>
        <td>${badge(row.signal ? 'ON' : 'off', row.signal ? 'bad' : 'neutral')}</td>
        <td>${badge(row.model, modelTone(row.model))}</td>
        <td class="text-cell">${escapeHtml(row.interpretation || '')}</td>
      </tr>
    `).join('');
  }

  function renderCharts(rows) {
    const scored = rows.filter((row) => finite(row.close)).slice(-520);
    renderLineChart('#price-chart', scored, [
      { key: 'close', label: 'SOX Close', color: '#7dd3fc' },
      { key: 'ma20', label: 'MA20', color: '#c4b5fd' },
      { key: 'ma50', label: 'MA50', color: '#86efac' },
    ], markerRows(scored), { valueFormatter: formatPrice, yLabel: 'SOX' });
    renderLineChart('#score-chart', scored, [
      { key: 'oh_score', label: 'OH', color: '#fbbf24' },
      { key: 'rf_score', label: 'RF', color: '#fb7185' },
      { key: 'top_risk_score', label: 'Top', color: '#f4f4f5' },
    ], markerRows(scored), { minY: 0, maxY: 5, valueFormatter: (v) => `${v}/5`, yLabel: 'Score' });
    renderLineChart('#vix-chart', scored, [
      { key: 'vix_close', label: 'VIX', color: '#fb7185' },
      { key: 'vix_ma5', label: 'VIX MA5', color: '#fbbf24' },
      { key: 'vix_ma20', label: 'VIX MA20', color: '#7dd3fc' },
    ], scored.filter((row) => row.vix_confirmation || row.strong_vix_confirmation).map((row) => ({ row, tone: 'confirmed-red', label: row.strong_vix_confirmation ? 'Strong VIX confirmation' : 'VIX confirmation' })), { valueFormatter: formatNumber, yLabel: 'VIX' });
  }

  function markerRows(rows) {
    return rows.flatMap((row) => {
      const markers = [];
      if (row.oh_score >= 4) markers.push({ row, tone: 'watch', label: `OH ${row.oh_score}/5` });
      if (row.rf_score >= 4) markers.push({ row, tone: 'high-risk', label: `RF ${row.rf_score}/5` });
      if (row.top_risk_score === 5) markers.push({ row, tone: 'red-zone', label: 'Red Zone' });
      if (row.confirmed_top_risk) markers.push({ row, tone: 'confirmed-red', label: 'Confirmed' });
      return markers;
    });
  }

  function renderLineChart(selector, rows, series, markers, options = {}) {
    const target = $(selector);
    if (!target) return;
    const width = 920;
    const height = 330;
    const margin = { top: 24, right: 28, bottom: 40, left: 66 };
    const allValues = series.flatMap((item) => rows.map((row) => finite(row[item.key]) ? Number(row[item.key]) : null).filter((value) => value !== null));
    if (!rows.length || !allValues.length) {
      target.innerHTML = '<div class="empty-state">Chart data unavailable.</div>';
      return;
    }
    const minY = options.minY ?? Math.min(...allValues);
    const maxY = options.maxY ?? Math.max(...allValues);
    const pad = Math.max((maxY - minY) * 0.08, maxY === minY ? 1 : 0);
    const domainMin = options.minY ?? (minY - pad);
    const domainMax = options.maxY ?? (maxY + pad);
    const x = (index) => margin.left + (index / Math.max(rows.length - 1, 1)) * (width - margin.left - margin.right);
    const y = (value) => margin.top + (1 - ((value - domainMin) / Math.max(domainMax - domainMin, 0.000001))) * (height - margin.top - margin.bottom);
    const yTicks = buildTicks(domainMin, domainMax, 5);
    const grid = yTicks.map((tick) => `<g><line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"/><text x="${margin.left - 10}" y="${(y(tick) + 4).toFixed(1)}">${escapeHtml((options.valueFormatter || formatNumber)(tick))}</text></g>`).join('');
    const lines = series.map((item) => {
      const points = rows.map((row, index) => finite(row[item.key]) ? `${x(index).toFixed(1)},${y(row[item.key]).toFixed(1)}` : null).filter(Boolean).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(item.label)}</title></polyline>`;
    }).join('');
    const markerSvg = markers.map((marker) => {
      const index = rows.indexOf(marker.row);
      if (index < 0) return '';
      const value = finite(marker.row.top_risk_score) && selector === '#score-chart' ? marker.row.top_risk_score : marker.row.close ?? marker.row.vix_close;
      if (!finite(value)) return '';
      return `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="4.8" class="marker ${classForLevel(marker.tone)}"><title>${escapeHtml(`${marker.row.date}: ${marker.label}`)}</title></circle>`;
    }).join('');
    const legend = series.map((item, index) => `<g transform="translate(${margin.left + index * 150},${height - 14})"><line x1="0" x2="22" y1="0" y2="0" stroke="${item.color}" stroke-width="3"/><text x="30" y="4">${escapeHtml(item.label)}</text></g>`).join('');
    const firstDate = rows[0]?.date || '';
    const lastDate = rows[rows.length - 1]?.date || '';
    target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.yLabel || 'chart')} chart from ${escapeHtml(firstDate)} to ${escapeHtml(lastDate)}">
      <g class="grid">${grid}</g>
      <line class="axis" x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}"/>
      <text class="axis-label" x="${margin.left}" y="${height - 16}">${escapeHtml(firstDate)}</text>
      <text class="axis-label" x="${width - margin.right}" y="${height - 16}" text-anchor="end">${escapeHtml(lastDate)}</text>
      ${lines}${markerSvg}<g class="legend">${legend}</g>
    </svg>`;
  }

  function setupBacktestPeriods() {
    const select = $('#period-select');
    if (!select || !state.backtest?.periods) return;
    select.innerHTML = Object.entries(state.backtest.periods).map(([id, period]) => `<option value="${escapeAttribute(id)}">${escapeHtml(period.label || id)}</option>`).join('');
    select.value = state.period;
  }

  function renderBacktest() {
    const target = $('#backtest-table-body');
    if (!target || !state.backtest?.periods) return;
    const period = state.backtest.periods[state.period] || state.backtest.periods.full;
    const mode = state.mode;
    const base = period.baseRates || {};
    $('#backtest-caption').textContent = `${period.label || state.period} · ${mode === 'event' ? 'de-clustered event-level' : 'daily signal'} statistics · base downside ${formatPercent(base.downsideHitRate, 1)}`;
    const rows = state.backtest.rules.map((rule) => ({ rule, stats: period.ruleStats?.[rule.id]?.[mode] || {} }));
    target.innerHTML = rows.map(({ rule, stats }) => `
      <tr>
        <td class="text-cell"><strong>${escapeHtml(rule.label)}</strong><small>${escapeHtml(rule.description)}</small></td>
        <td>${formatInteger(stats.signalCount)}</td>
        <td>${formatInteger(stats.eventCount)}</td>
        <td>${formatPercent(stats.downsideHitRate, 1)}</td>
        <td>${formatPercent(stats.strictTopHitRate, 1)}</td>
        <td>${formatLift(stats.downsideHitRateLift)}</td>
        <td>${formatPercent(stats.avgFwdRet5, 2)}</td>
        <td>${formatPercent(stats.avgFwdMin5, 2)}</td>
        <td>${formatPercent(stats.maxAdverseContinuation, 2)}</td>
      </tr>
    `).join('');
    renderSensitivity();
  }

  function renderSensitivity() {
    const target = $('#sensitivity-panel');
    if (!target) return;
    const items = (state.backtest?.thresholdSensitivity || []).filter((_, index) => index < 8);
    target.innerHTML = `<article class="notice"><h3>Threshold sensitivity는 보고용입니다</h3><p>아래 값은 default threshold를 자동 변경하지 않습니다. YTD 결과에 맞춘 threshold tuning은 금지됩니다.</p></article>` + items.map((item) => `
      <article class="mini-card"><span>${escapeHtml(item.field)} ${escapeHtml(String(item.threshold))}</span><strong>${formatPercent(item.downsideHitRate, 1)}</strong><small>signals ${formatInteger(item.signalCount)} · lift ${formatLift(item.downsideLiftRatio)}</small></article>
    `).join('');
  }

  function renderHistory(rows) {
    const target = $('#history-table-body');
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="12">No recent setup signals.</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => `
      <tr>
        <td>${escapeHtml(formatDate(row.date))}</td>
        <td>${formatPrice(row.close)}</td>
        <td>${scoreText(row.ohScore)}</td>
        <td>${scoreText(row.rfScore)}</td>
        <td>${scoreText(row.topRiskScore)}</td>
        <td>${badge(row.confirmation ? 'confirmed' : 'setup', row.confirmation ? 'bad' : 'watch')}</td>
        <td>${formatPercent(row.fwdMin5, 2)}</td>
        <td>${formatPercent(row.fwdMax5, 2)}</td>
        <td>${formatPercent(row.fwdRet5, 2)}</td>
        <td>${yesNo(row.downsideHit)}</td>
        <td>${yesNo(row.strictTopHit)}</td>
        <td>${escapeHtml(row.regime || '-')}</td>
      </tr>
    `).join('');
  }

  function renderSources(summary) {
    const target = $('#source-notes');
    if (!target || !summary) return;
    const optional = summary.riskScore?.optionalSources || [];
    const limitations = summary.limitations || [];
    target.innerHTML = `
      <article class="notice"><h3>Limitations</h3><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article>
      ${optional.map((source) => `<article class="source-item"><strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(source.status)}</span><p>${escapeHtml(source.note || '')}</p>${source.url ? `<a href="${escapeAttribute(source.url)}">source</a>` : ''}</article>`).join('')}
    `;
  }

  function buildTicks(min, max, count) {
    const step = (max - min) / Math.max(count - 1, 1);
    return Array.from({ length: count }, (_, index) => min + step * index);
  }

  function classForLevel(level) {
    const value = String(level || '').toLowerCase();
    if (['confirmed-red', 'red-zone', 'bad', 'error'].includes(value)) return 'bad';
    if (['high-risk'].includes(value)) return 'high-risk';
    if (['watch', 'warning'].includes(value)) return 'watch';
    if (['normal', 'ok'].includes(value)) return 'good';
    return 'neutral';
  }

  function scoreTone(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 'neutral';
    if (num >= 5) return 'red-zone';
    if (num >= 4) return 'high-risk';
    if (num >= 3) return 'watch';
    return 'normal';
  }

  function toneForReturn(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 'neutral';
    if (num <= -0.02) return 'bad';
    if (num < 0) return 'watch';
    return 'good';
  }

  function modelTone(model) {
    if (model === 'OH') return 'watch';
    if (model === 'RF') return 'bad';
    return 'neutral';
  }

  function badge(text, tone = 'neutral') {
    return `<span class="signal-pill ${classForLevel(tone)}">${escapeHtml(text)}</span>`;
  }

  function scoreText(value) {
    return finite(value) ? `${Number(value).toFixed(0)}/5` : '-';
  }

  function yesNo(value) {
    if (value === null || value === undefined) return '-';
    return value ? 'Y' : 'N';
  }

  function formatFactorValue(value, factor) {
    if (!finite(value)) return '-';
    if (/rsi|score/i.test(factor)) return formatNumber(value);
    if (/gap|roc|drawdown|rebound|ret|slope/i.test(factor)) return formatPercent(value, 2);
    return formatNumber(value);
  }

  function formatDate(value) {
    if (!value) return '-';
    return String(value).slice(0, 10);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} KST`;
  }

  function formatPrice(value) {
    return finite(value) ? Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
  }

  function formatNumber(value) {
    return finite(value) ? Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '-';
  }

  function formatInteger(value) {
    return finite(value) ? Math.round(Number(value)).toLocaleString('ko-KR') : '-';
  }

  function formatPercent(value, digits = 1) {
    return finite(value) ? `${(Number(value) * 100).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%` : '-';
  }

  function formatLift(value) {
    return finite(value) ? `${Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x` : '-';
  }

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  if (typeof window !== 'undefined') {
    window.__riskScoreApp = { renderSummary, renderFactors, renderBacktest, FILES };
  }
})();
