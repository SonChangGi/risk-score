(() => {
  'use strict';

  const DATA_BASE = 'data/risk-score/';
  const FILES = {
    summary: `${DATA_BASE}risk_score_summary.json`,
    daily: `${DATA_BASE}risk_score_daily.json`,
    backtest: `${DATA_BASE}risk_score_backtest.json`,
    assetUniverse: `${DATA_BASE}asset_universe.json`,
    assetSummary: `${DATA_BASE}asset_risk_summary.json`,
    assetDaily: `${DATA_BASE}asset_risk_daily.json`,
    assetBacktest: `${DATA_BASE}asset_risk_backtest.json`,
    dataStatus: `${DATA_BASE}data_status.json`,
  };
  const state = {
    summary: null,
    daily: null,
    backtest: null,
    assetUniverse: null,
    assetSummary: null,
    assetDaily: null,
    assetBacktest: null,
    dataStatus: null,
    selectedSymbol: 'SOX',
    mode: 'event',
    period: 'full',
    labelMode: 'volAdjusted',
  };
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
        $$('.toggle[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
        renderBacktest();
      });
    });
    $$('.label-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        state.labelMode = button.dataset.labelMode || 'volAdjusted';
        $$('.label-toggle').forEach((item) => item.classList.toggle('active', item === button));
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
    const assetSelect = $('#asset-select');
    if (assetSelect) {
      assetSelect.addEventListener('change', () => selectAsset(assetSelect.value));
    }
  }

  async function loadData() {
    setStatus('loading', '정적 JSON을 불러오는 중...');
    try {
      const [summary, backtest, assetUniverse, assetSummary, assetDaily, assetBacktest, dataStatus] = await Promise.all([
        fetchJson(FILES.summary),
        fetchJson(FILES.backtest),
        fetchJson(FILES.assetUniverse),
        fetchJson(FILES.assetSummary),
        fetchJson(FILES.assetDaily),
        fetchJson(FILES.assetBacktest),
        fetchJson(FILES.dataStatus),
      ]);
      Object.assign(state, { summary, backtest, assetUniverse, assetSummary, assetDaily, assetBacktest, dataStatus });
      state.selectedSymbol = assetSummary.defaultSymbol || 'SOX';
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

  function selectAsset(symbol) {
    if (!symbol || symbol === state.selectedSymbol) return;
    state.selectedSymbol = symbol;
    state.period = 'full';
    renderAll();
    const section = $('#summary');
    if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderAll() {
    const current = selectedCurrent();
    const contextPart = current.sectorContextStatus ? ` · sector context ${current.sectorContextStatus}${current.sectorContextAsOf ? ` as of ${formatDate(current.sectorContextAsOf)}` : ''}` : '';
    setStatus(current.actionLevel || 'ok', `Selected ${state.selectedSymbol} · score date ${formatDate(current.latestScoredDate || current.date || state.summary?.dataAsOf)}${contextPart} · generated ${formatDateTime(state.summary?.generatedAt)}`);
    renderAssetSelector();
    renderRiskMatrix();
    renderSummary(current);
    renderFactors(selectedFactors());
    renderCharts(selectedRows());
    setupBacktestPeriods();
    renderBacktest();
    renderHistory(selectedHistory());
    renderSources(state.summary);
    updateSelectedCopy(current);
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

  function renderAssetSelector() {
    const select = $('#asset-select');
    if (select && state.assetUniverse?.assets) {
      const groups = groupAssets(state.assetUniverse.assets);
      select.innerHTML = Object.entries(groups).map(([group, assets]) => `<optgroup label="${escapeAttribute(group)}">${assets.map((asset) => `<option value="${escapeAttribute(asset.symbol)}">${escapeHtml(asset.symbol)} · ${escapeHtml(asset.name || '')}</option>`).join('')}</optgroup>`).join('');
      select.value = state.selectedSymbol;
    }
    const chips = $('#asset-group-chips');
    if (chips && state.assetUniverse?.assets) {
      const groups = groupAssets(state.assetUniverse.assets);
      chips.innerHTML = Object.entries(groups).map(([group, assets]) => `<span class="status-chip neutral">${escapeHtml(group)} ${assets.length}</span>`).join('');
    }
  }

  function renderRiskMatrix() {
    const target = $('#asset-matrix-body');
    if (!target) return;
    const rows = state.assetSummary?.matrix || [];
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="13">Asset matrix unavailable.</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => `
      <tr class="asset-row ${row.symbol === state.selectedSymbol ? 'selected' : ''}" data-symbol="${escapeAttribute(row.symbol)}" tabindex="0">
        <td class="text-cell"><strong>${escapeHtml(row.symbol)}</strong><small>${escapeHtml(row.name || '')}</small></td>
        <td>${escapeHtml(row.type || '-')}</td>
        <td>${formatPrice(row.latest)} ${escapeHtml(row.scoreCurrency || '')}</td>
        <td>${formatPercent(row.oneDayReturn, 2)}</td>
        <td>${scoreText(row.ohScore)}</td>
        <td>${scoreText(row.rfScore)}</td>
        <td>${badge(scoreText(row.topRiskScore), scoreTone(row.topRiskScore))}</td>
        <td>${escapeHtml(row.regime || '-')}</td>
        <td>${yesNo(row.confirmed)}</td>
        <td>${yesNo(row.sectorContext)} ${badge(row.sectorContextStatus || '-', row.sectorContextStatus === 'fresh' ? 'normal' : 'warning')}</td>
        <td>${yesNo(row.actionable)}</td>
        <td class="text-cell">${escapeHtml(row.relativeStrength || '-')}<small>analysis: ${escapeHtml(row.analysisBenchmark?.symbol || '-')}</small></td>
        <td>${badge(row.dataQuality || row.dataStatus || '-', (row.dataQuality || row.dataStatus) === 'ok' ? 'normal' : 'warning')} ${badge(row.confidence || '-', row.confidence === 'high' ? 'normal' : row.confidence === 'medium' ? 'watch' : 'warning')} ${row.economicValidationStatus ? badge(`${row.economicValidationStatus}${finite(row.validationScore) ? ` ${Math.round(row.validationScore)}` : ''}`, validationTone(row.economicValidationStatus)) : ''}<small>${escapeHtml(row.dataProvider || '')}</small></td>
      </tr>
    `).join('');
    $$('#asset-matrix-body .asset-row').forEach((row) => {
      row.addEventListener('click', () => selectAsset(row.dataset.symbol));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') selectAsset(row.dataset.symbol);
      });
    });
  }

  function renderSummary(current) {
    const isSox = state.selectedSymbol === 'SOX';
    const asset = selectedAssetSummary() || {};
    const validation = asset.economicValidation || {};
    const quality = asset.dataQuality || {};
    const bestRule = validation.bestRule || {};
    const official = current.officialBenchmark || asset.officialBenchmark || {};
    const modelDetail = isSox ? 'SOX canonical sector risk model' : 'Experimental asset vol/relative risk ladder';
    const topRiskDetail = isSox
      ? `Canonical sector regime: ${current.regime || '-'}`
      : `Regime ladder only; not calibrated to SOX probability (${current.regime || '-'})`;
    const officialTone = official?.name ? 'neutral' : current.type === 'ETF' ? 'warning' : 'neutral';
    const cards = [
      [`${state.selectedSymbol} latest`, formatPrice(current.close), `${formatDate(current.date)} · ${current.scoreCurrency || 'USD'}`, 'neutral'],
      ['Score model', isSox ? 'SOX canonical' : 'Asset experimental', current.scoreModelLabel || modelDetail, isSox ? 'normal' : 'warning'],
      ['1D return', formatPercent(current.oneDayReturn, 2), 'Daily adjusted close 기준', toneForReturn(current.oneDayReturn)],
      ['OH Score', scoreText(current.ohScore), isSox ? '기존 SOX 과열형 top model' : '자산 변동성 조정 OH model', scoreTone(current.ohScore)],
      ['RF Score', scoreText(current.rfScore), isSox ? '기존 SOX 반등 실패형 top model' : '자산 변동성/상대강도 RF model', scoreTone(current.rfScore)],
      ['Top Risk Score', scoreText(current.topRiskScore), topRiskDetail, scoreTone(current.topRiskScore)],
      ['Confirmation', current.confirmation ? 'ON' : 'OFF', isSox ? 'SOX confirmed_top_risk' : 'asset_confirmed_risk', current.confirmation ? 'confirmed-red' : 'normal'],
      ['Sector context', current.sectorContextActive ? 'ON' : 'OFF', `${current.sectorContextStatus || '-'} · as of ${formatDate(current.sectorContextAsOf)} · lag ${formatLag(current.sectorContextLagDays)}`, current.sectorContextActive ? 'high-risk' : current.sectorContextStatus === 'fresh' ? 'normal' : 'warning'],
      ['Actionable signal', current.assetActionableSignal ? 'ON' : 'OFF', 'asset confirmation + sector context', current.assetActionableSignal ? 'confirmed-red' : 'neutral'],
      ['Relative strength', current.relativeStrengthStatus || (isSox ? 'sector baseline' : '-'), current.benchmarkSymbol ? `Analysis reference: ${current.benchmarkSymbol} · benchmark as of ${formatDate(current.benchmarkAsOf)}` : 'SOX baseline', toneForRelative(current.relativeStrengthStatus)],
      ['Official benchmark', official?.name || (isSox ? 'PHLX Semiconductor Sector Index' : current.type === 'ETF' ? 'issuer exposure, not configured' : 'N/A for single stock'), official?.source ? `${official.source}; analysis reference may differ` : 'Not used as an asset-model input', officialTone],
      ['Model validation', validation.status ? `${validation.status}${finite(validation.validationScore) ? ` · ${Math.round(validation.validationScore)}/100` : ''}` : (isSox ? 'canonical' : '-'), validation.summary || selectedAssetSummary()?.confidence?.level || 'available', validationTone(validation.status)],
      ['Best validation rule', bestRule.label || (isSox ? 'Canonical SOX backtest' : '-'), finite(bestRule.downsideHitRateLift) ? `event lift ${formatLift(bestRule.downsideHitRateLift)} · events ${formatInteger(bestRule.eventCount)}` : 'Event-level evidence unavailable', validationTone(validation.status)],
      ['Data quality', quality.level || selectedAssetSummary()?.dataStatus?.status || 'ok', `${quality.source || selectedAssetSummary()?.dataStatus?.source || '-'} · lag ${formatLag(quality.latestLagDays)} · ${quality.fallbackUsed ? 'fallback used' : 'primary path'}`, (quality.level || selectedAssetSummary()?.dataStatus?.status) === 'ok' ? 'normal' : 'warning'],
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
      const warning = selectedWarnings().length ? `<p class="warning-text">${escapeHtml(selectedWarnings()[0])}</p>` : '';
      const caveat = !isSox ? `<p class="muted-text">자산 점수는 SOX canonical score와 같은 확률 척도가 아니며, 변동성/상대강도 기반 risk overlay입니다.</p>` : '';
      action.innerHTML = `<span>${escapeHtml(current.actionLabel || 'Unknown')}</span><strong>${escapeHtml(current.regime || '-')}</strong><p>${escapeHtml(current.actionText || '데이터를 확인할 수 없습니다.')}</p>${caveat}${warning}`;
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
    const symbol = state.selectedSymbol;
    renderLineChart('#price-chart', scored, [
      { key: 'close', label: `${symbol} Close`, color: '#7dd3fc' },
      { key: 'ma20', label: 'MA20', color: '#c4b5fd' },
      { key: 'ma50', label: 'MA50', color: '#86efac' },
    ], markerRows(scored), { valueFormatter: formatPrice, yLabel: symbol });
    renderLineChart('#score-chart', scored, [
      { key: 'oh_score', label: 'OH', color: '#fbbf24' },
      { key: 'rf_score', label: 'RF', color: '#fb7185' },
      { key: 'top_risk_score', label: 'Top', color: '#f4f4f5' },
    ], markerRows(scored), { minY: 0, maxY: 5, valueFormatter: (v) => `${v}/5`, yLabel: 'Score' });
    renderLineChart('#relative-chart', scored, [
      { key: 'relative_strength', label: 'Relative strength', color: '#7dd3fc' },
      { key: 'rs_ma20', label: 'RS MA20', color: '#c4b5fd' },
      { key: 'rel_z20', label: 'RelZ20', color: '#fbbf24', axisHint: 'z' },
    ], scored.filter((row) => row.rel_z20 >= 1 || row.rel_z20 <= -1).map((row) => ({ row, tone: row.rel_z20 >= 1 ? 'watch' : 'high-risk', label: `RelZ20 ${formatNumber(row.rel_z20)}` })), { valueFormatter: formatNumber, yLabel: 'RS' });
    const volSeries = [
      { key: 'vix_close', label: 'VIX', color: '#fb7185' },
      { key: 'vix_ma5', label: 'VIX MA5', color: '#fbbf24' },
      { key: 'vix_ma20', label: 'VIX MA20', color: '#7dd3fc' },
    ];
    if (scored.some((row) => finite(row.vxn_close))) {
      volSeries.push({ key: 'vxn_close', label: 'VXN', color: '#c4b5fd' });
      volSeries.push({ key: 'vxn_ma5', label: 'VXN MA5', color: '#86efac' });
    }
    renderLineChart('#vix-chart', scored, volSeries, scored.filter((row) => row.vix_rising || row.vxn_rising).map((row) => ({ row, tone: row.vxn_rising ? 'high-risk' : 'confirmed-red', label: row.vxn_rising ? 'VXN rising' : 'VIX rising' })), { valueFormatter: formatNumber, yLabel: 'Vol' });
  }

  function markerRows(rows) {
    return rows.flatMap((row) => {
      const markers = [];
      if (row.oh_score >= 4) markers.push({ row, tone: 'watch', label: `OH ${row.oh_score}/5` });
      if (row.rf_score >= 4) markers.push({ row, tone: 'high-risk', label: `RF ${row.rf_score}/5` });
      if (row.top_risk_score === 5) markers.push({ row, tone: 'red-zone', label: 'Red Zone' });
      if (row.asset_confirmed_risk || row.confirmed_top_risk) markers.push({ row, tone: 'confirmed-red', label: 'Confirmed' });
      if (row.asset_actionable_signal) markers.push({ row, tone: 'confirmed-red', label: 'Actionable' });
      return markers;
    });
  }

  function renderLineChart(selector, rows, series, markers, options = {}) {
    const target = $(selector);
    if (!target) return;
    const width = 920;
    const height = 330;
    const margin = { top: 24, right: 28, bottom: 40, left: 66 };
    const availableSeries = series.filter((item) => rows.some((row) => finite(row[item.key])));
    const allValues = availableSeries.flatMap((item) => rows.map((row) => finite(row[item.key]) ? Number(row[item.key]) : null).filter((value) => value !== null));
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
    const lines = availableSeries.map((item) => {
      const points = rows.map((row, index) => finite(row[item.key]) ? `${x(index).toFixed(1)},${y(row[item.key]).toFixed(1)}` : null).filter(Boolean).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(item.label)}</title></polyline>`;
    }).join('');
    const markerSvg = markers.map((marker) => {
      const index = rows.indexOf(marker.row);
      if (index < 0) return '';
      let value = marker.row.close;
      if (selector === '#score-chart') value = marker.row.top_risk_score;
      if (selector === '#vix-chart') value = marker.row.vix_close ?? marker.row.vxn_close;
      if (selector === '#relative-chart') value = marker.row.relative_strength ?? marker.row.rel_z20;
      if (!finite(value)) return '';
      return `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="4.8" class="marker ${classForLevel(marker.tone)}"><title>${escapeHtml(`${marker.row.date}: ${marker.label}`)}</title></circle>`;
    }).join('');
    const legend = availableSeries.map((item, index) => `<g transform="translate(${margin.left + (index % 4) * 170},${height - 14 - Math.floor(index / 4) * 18})"><line x1="0" x2="22" y1="0" y2="0" stroke="${item.color}" stroke-width="3"/><text x="30" y="4">${escapeHtml(item.label)}</text></g>`).join('');
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
    if (!select) return;
    const periods = selectedBacktestPeriods();
    select.innerHTML = Object.entries(periods).map(([id, period]) => `<option value="${escapeAttribute(id)}">${escapeHtml(period.label || id)}</option>`).join('');
    if (!periods[state.period]) state.period = 'full';
    select.value = state.period;
  }

  function renderBacktest() {
    const target = $('#backtest-table-body');
    if (!target) return;
    const selected = selectedBacktest();
    const period = selected?.periods?.[state.period] || selected?.periods?.full;
    const mode = state.mode;
    const isSox = state.selectedSymbol === 'SOX';
    const labelMode = isSox ? null : state.labelMode;
    const statsRoot = isSox ? period : period?.[labelMode];
    const base = statsRoot?.baseRates || {};
    const rules = isSox ? state.backtest?.rules || [] : state.assetBacktest?.rules || [];
    const caption = $('#backtest-caption');
    if (caption) caption.textContent = `${state.selectedSymbol} · ${period?.label || state.period} · ${mode === 'event' ? 'de-clustered event-level' : 'daily signal'} · ${isSox ? 'absolute -5% label' : labelMode} · base downside ${formatPercent(base.downsideHitRate, 1)}`;
    $$('.label-toggle').forEach((button) => { button.disabled = isSox; button.classList.toggle('disabled', isSox); });
    if (!statsRoot?.ruleStats) {
      target.innerHTML = '<tr><td colspan="9">Backtest data unavailable.</td></tr>';
      renderSensitivity(isSox);
      return;
    }
    const rows = rules.map((rule) => ({ rule, stats: statsRoot.ruleStats?.[rule.id]?.[mode] || {} }));
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
    renderSensitivity(isSox);
  }

  function renderSensitivity(isSox) {
    const target = $('#sensitivity-panel');
    if (!target) return;
    if (!isSox) {
      const asset = selectedAssetSummary();
      const validation = asset?.economicValidation || {};
      const buckets = validation.scoreBucketDiagnostics || {};
      const bestRule = validation.bestRule || {};
      const cross = state.assetBacktest?.crossAssetValidation || state.assetSummary?.crossAssetValidation || {};
      target.innerHTML = `<article class="notice"><h3>Vol-adjusted label 우선</h3><p>개별 종목/ETF는 고정 -5%와 변동성 조정 label을 함께 제공하지만, 주 평가는 변동성 조정 event-level입니다. SOX는 섹터 분석 기준이지 모든 ETF의 공식 벤치마크가 아닙니다.</p></article>
      <article class="mini-card"><span>Economic validation</span><strong>${escapeHtml(validation.status || '-')} ${finite(validation.validationScore) ? `${Math.round(validation.validationScore)}/100` : ''}</strong><small>${escapeHtml(validation.summary || 'validation unavailable')}</small></article>
      <article class="mini-card"><span>Best primary rule</span><strong>${escapeHtml(bestRule.label || '-')}</strong><small>event lift ${formatLift(bestRule.downsideHitRateLift)} · events ${formatInteger(bestRule.eventCount)}</small></article>
      <article class="mini-card"><span>Score-bucket lift</span><strong>${formatLift(buckets.highVsNormalDownsideLift)}</strong><small>Top risk ≥4 downside frequency vs score ≤2; diagnostic only</small></article>
      <article class="mini-card"><span>Cross-asset validation</span><strong>${formatInteger(cross.statusCounts?.strong || 0)} strong · ${formatInteger(cross.statusCounts?.validated || 0)} validated</strong><small>${escapeHtml(cross.summary || 'cross-asset diagnostics unavailable')}</small></article>
      ${(asset?.warnings || []).slice(0, 4).map((item) => `<article class="mini-card"><span>Data warning</span><strong>주의</strong><small>${escapeHtml(item)}</small></article>`).join('')}`;
      return;
    }
    const items = (state.backtest?.thresholdSensitivity || []).filter((_, index) => index < 8);
    target.innerHTML = `<article class="notice"><h3>Threshold sensitivity는 보고용입니다</h3><p>아래 값은 default threshold를 자동 변경하지 않습니다. YTD 결과에 맞춘 threshold tuning은 금지됩니다.</p></article>` + items.map((item) => `
      <article class="mini-card"><span>${escapeHtml(item.field)} ${escapeHtml(String(item.threshold))}</span><strong>${formatPercent(item.downsideHitRate, 1)}</strong><small>signals ${formatInteger(item.signalCount)} · lift ${formatLift(item.downsideLiftRatio)}</small></article>
    `).join('');
  }

  function renderHistory(rows) {
    const target = $('#history-table-body');
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="13">No recent setup signals.</td></tr>';
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
        <td>${row.actionable === undefined ? '-' : yesNo(row.actionable)}</td>
        <td>${formatPercent(row.fwdMin5, 2)}</td>
        <td>${formatPercent(row.fwdMax5, 2)}</td>
        <td>${formatPercent(row.fwdRet5, 2)}</td>
        <td>${yesNo(row.downsideHit)}</td>
        <td>${yesNo(row.volAdjDownsideHit)}</td>
        <td>${escapeHtml(row.regime || '-')}</td>
      </tr>
    `).join('');
  }

  function renderSources(summary) {
    const target = $('#source-notes');
    if (!target || !summary) return;
    const optional = summary.riskScore?.optionalSources || [];
    const providerPolicy = state.assetSummary?.methodology?.dataProviderPolicy || state.dataStatus?.providerPolicy || {};
    const limitations = [
      ...(summary.limitations || []),
      '개별 종목/ETF score는 volatility-adjusted momentum/label과 relative strength를 사용하며, SOX 원본 threshold를 그대로 최적화하지 않습니다.',
      'Economic validation은 event-level lift, score-bucket diagnostics, cross-asset evidence를 보고하지만 티커별 threshold를 조정하지 않습니다.',
      '개별 가격 데이터는 update script에서 manual CSV override, Yahoo chart primary, FMP API-key fallback 순서로 처리하며 browser runtime에서는 live finance fetch를 하지 않습니다.',
      'SOX는 개별 자산의 sector context/analysis reference이며, ETF의 official benchmark와 다를 수 있습니다.',
      'Top Risk Score는 0~5 regime ladder이며 SOX와 개별 종목/ETF 사이에 직접 비교 가능한 확률 점수가 아닙니다.',
      'Sector context date가 asset date보다 오래되면 stale로 표시하고 actionable 해석을 낮춰 봅니다.',
      '한국 종목은 USDKRW가 가능하면 USD 환산 후 SOX 대비 relative strength를 계산하고, FX가 없으면 KOSPI local fallback을 표시합니다.',
      'SNDK와 DRAM은 standalone history가 짧아 backtest confidence가 낮게 표시될 수 있습니다.',
    ];
    const benchmarks = (state.assetUniverse?.assets || [])
      .filter((asset) => asset.officialBenchmark || asset.analysisBenchmark)
      .slice(0, 8)
      .map((asset) => `<article class="source-item"><strong>${escapeHtml(asset.symbol)} benchmark semantics</strong><span>${escapeHtml(asset.officialBenchmark?.name || 'no official benchmark in config')}</span><p>Analysis reference: ${escapeHtml(asset.analysisBenchmark?.symbol || asset.benchmark || '-')} · ${escapeHtml(asset.analysisBenchmark?.note || 'relative-strength context only')}</p>${asset.officialBenchmark?.url ? `<a href="${escapeAttribute(asset.officialBenchmark.url)}">official/source</a>` : ''}</article>`)
      .join('');
    target.innerHTML = `
      <article class="notice"><h3>Limitations</h3><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article>
      ${benchmarks}
      <article class="source-item"><strong>Price provider policy</strong><span>${escapeHtml((providerPolicy.priceProviderPriority || []).join(' → ') || 'generated JSON only')}</span><p>${escapeHtml((providerPolicy.notes || []).join(' '))}</p></article>
      ${optional.map((source) => `<article class="source-item"><strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(source.status)}</span><p>${escapeHtml(source.note || '')}</p>${source.url ? `<a href="${escapeAttribute(source.url)}">source</a>` : ''}</article>`).join('')}
    `;
  }

  function updateSelectedCopy(current) {
    const summaryTitle = $('#summary-title');
    if (summaryTitle) summaryTitle.textContent = `${state.selectedSymbol} 현재 고점 리스크`;
    const chartTitle = $('#charts-title');
    if (chartTitle) chartTitle.textContent = `${state.selectedSymbol} 가격·점수·상대강도·VIX/VXN`;
    const assetName = $('#selected-asset-name');
    if (assetName) assetName.textContent = `${state.selectedSymbol} · ${current.name || selectedAssetSummary()?.name || ''}`;
  }

  function selectedCurrent() {
    const asset = selectedAssetSummary();
    if (asset?.current) return asset.current;
    return state.summary?.riskScore?.current || {};
  }

  function selectedAssetSummary() {
    return state.assetSummary?.bySymbol?.[state.selectedSymbol];
  }

  function selectedFactors() {
    if (state.selectedSymbol === 'SOX') return state.summary?.riskScore?.factorBreakdown || [];
    return selectedAssetSummary()?.factorBreakdown || [];
  }

  function selectedRows() {
    if (state.selectedSymbol === 'SOX') return state.assetDaily?.rowsBySymbol?.SOX || [];
    return state.assetDaily?.rowsBySymbol?.[state.selectedSymbol] || [];
  }

  function selectedHistory() {
    if (state.selectedSymbol === 'SOX') return state.summary?.riskScore?.recentSignals || [];
    return selectedAssetSummary()?.recentSignals || [];
  }

  function selectedWarnings() {
    return selectedAssetSummary()?.warnings || [];
  }

  function selectedBacktest() {
    if (state.selectedSymbol === 'SOX') return state.backtest;
    return state.assetBacktest?.assets?.[state.selectedSymbol];
  }

  function selectedBacktestPeriods() {
    if (state.selectedSymbol === 'SOX') return state.backtest?.periods || {};
    return state.assetBacktest?.periods || selectedBacktest()?.periods || {};
  }

  function groupAssets(assets) {
    return assets.reduce((acc, asset) => {
      const group = asset.group || asset.type || 'Assets';
      acc[group] ||= [];
      acc[group].push(asset);
      return acc;
    }, {});
  }

  function buildTicks(min, max, count) {
    const step = (max - min) / Math.max(count - 1, 1);
    return Array.from({ length: count }, (_, index) => min + step * index);
  }

  function classForLevel(level) {
    const value = String(level || '').toLowerCase();
    if (['confirmed-red', 'red-zone', 'bad', 'error', 'low'].includes(value)) return 'bad';
    if (['high-risk', 'degraded'].includes(value)) return 'high-risk';
    if (['watch', 'warning', 'medium'].includes(value)) return 'watch';
    if (['normal', 'ok', 'high'].includes(value)) return 'good';
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

  function toneForRelative(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('strong')) return 'watch';
    if (text.includes('weak')) return 'high-risk';
    if (text.includes('unavailable')) return 'warning';
    return 'neutral';
  }

  function validationTone(value) {
    const text = String(value || '').toLowerCase();
    if (text === 'strong' || text === 'validated' || text === 'canonical') return 'normal';
    if (text === 'mixed' || text === 'insufficient') return 'watch';
    if (text === 'weak') return 'warning';
    return 'neutral';
  }

  function modelTone(model) {
    if (model === 'OH') return 'watch';
    if (model === 'RF') return 'bad';
    if (model === 'Confirmation') return 'high-risk';
    if (model === 'Sector') return 'neutral';
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
    if (/rsi|score|z20|z$/i.test(factor)) return formatNumber(value);
    if (/gap|roc|drawdown|rebound|ret|slope|rv|dd/i.test(factor)) return formatPercent(value, 2);
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

  function formatLag(value) {
    return finite(value) ? `${formatInteger(value)}d` : '-';
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
    window.__riskScoreApp = { renderSummary, renderFactors, renderBacktest, FILES, selectAsset };
  }
})();
