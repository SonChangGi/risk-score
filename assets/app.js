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
    requestedDate: null,
    resolvedDate: null,
    datePinned: false,
    dateResolution: null,
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
    const analysisDate = $('#analysis-date-input');
    if (analysisDate) {
      analysisDate.addEventListener('change', () => selectAnalysisDate(analysisDate.value));
    }
    const latestButton = $('#latest-date-button');
    if (latestButton) {
      latestButton.addEventListener('click', () => selectLatestAnalysisDate());
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
      initializeSelectionFromUrl();
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

  function selectAsset(symbol, options = {}) {
    if (!symbol || !hasAsset(symbol)) return;
    const changed = symbol !== state.selectedSymbol;
    state.selectedSymbol = symbol;
    state.period = 'full';
    if (!state.datePinned) state.requestedDate = latestScoredDate(symbol);
    renderAll();
    syncUrlState();
    if (changed && options.scroll !== false) {
      const section = $('#summary');
      if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function selectAnalysisDate(value) {
    const sanitized = sanitizeDate(value);
    if (!sanitized) return;
    state.requestedDate = sanitized;
    state.datePinned = true;
    renderAll();
    syncUrlState();
  }

  function selectLatestAnalysisDate() {
    state.datePinned = false;
    state.requestedDate = latestScoredDate(state.selectedSymbol);
    renderAll();
    syncUrlState();
  }

  function renderAll() {
    updateDateResolution();
    const current = selectedCurrent();
    const resolution = state.dateResolution || {};
    const contextPart = current.sectorContextStatus ? ` · sector context ${current.sectorContextStatus}${current.sectorContextAsOf ? ` as of ${formatDate(current.sectorContextAsOf)}` : ''}` : '';
    const datePart = `requested ${formatDate(resolution.requestedDate)} → as-of ${formatDate(resolution.resolvedDate)}`;
    setStatus(current.actionLevel || 'ok', `Selected ${state.selectedSymbol} · ${datePart} · ${resolution.label || 'latest scored day'}${contextPart} · generated ${formatDateTime(state.summary?.generatedAt)}`);
    renderAssetSelector();
    renderRiskMatrix();
    renderSummary(current);
    renderFactors(selectedFactors());
    renderCharts(selectedChartRows());
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
    const input = $('#analysis-date-input');
    const resolution = state.dateResolution || updateDateResolution();
    if (input) {
      const dates = scoredRowsForSymbol(state.selectedSymbol).map((row) => row.date);
      input.min = dates[0] || '';
      input.max = dates[dates.length - 1] || '';
      input.value = resolution.requestedDate || resolution.resolvedDate || dates[dates.length - 1] || '';
    }
    const note = $('#analysis-date-note');
    if (note) {
      note.textContent = resolution.message || '최신 scored trading day를 기준으로 표시합니다.';
    }
  }

  function renderRiskMatrix() {
    const target = $('#asset-matrix-body');
    if (!target) return;
    const rows = matrixRowsForDate();
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="13">Asset matrix unavailable.</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => `
      <tr class="asset-row ${row.symbol === state.selectedSymbol ? 'selected' : ''}" data-symbol="${escapeAttribute(row.symbol)}" tabindex="0">
        <td class="text-cell"><strong>${escapeHtml(row.symbol)}</strong><small>${escapeHtml(row.name || '')}</small></td>
        <td>${escapeHtml(row.type || '-')}</td>
        <td class="text-cell">${formatPrice(row.latest)} ${escapeHtml(row.scoreCurrency || '')}<small>${escapeHtml(row.dateLabel || formatDate(row.date))}</small></td>
        <td>${formatPercent(row.oneDayReturn, 2)}</td>
        <td>${scoreText(row.ohScore)}</td>
        <td>${scoreText(row.rfScore)}</td>
        <td>${badge(scoreText(row.topRiskScore), scoreTone(row.topRiskScore))}</td>
        <td>${escapeHtml(row.regime || '-')}</td>
        <td>${yesNo(row.confirmed)}</td>
        <td>${yesNo(row.sectorContext)} ${badge(row.sectorContextStatus || '-', row.sectorContextStatus === 'fresh' ? 'normal' : row.sectorContextStatus === 'proxy' ? 'watch' : 'warning')}<small>${escapeHtml(row.effectiveSectorContextSource || 'SOX')}</small></td>
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
    const proxy = current.sectorProxy || {};
    const benchmarkProxy = current.benchmarkProxyRisk || {};
    const ytd = validation.ytdDiagnostics || {};
    const ytdBest = ytd.bestRule || {};
    const resolution = state.dateResolution || {};
    const modelDetail = isSox ? 'SOX canonical sector risk model' : 'Experimental asset vol/relative risk ladder';
    const topRiskDetail = isSox
      ? `Canonical sector regime: ${current.regime || '-'}`
      : `Regime ladder only; not calibrated to SOX probability (${current.regime || '-'})`;
    const officialTone = official?.name ? 'neutral' : current.type === 'ETF' ? 'warning' : 'neutral';
    const cards = [
      ['Analysis date', formatDate(current.date || resolution.resolvedDate), resolution.message || 'Latest scored trading day', resolution.status === 'exact' || resolution.status === 'latest' ? 'normal' : 'watch'],
      [`${state.selectedSymbol} close`, formatPrice(current.close), `${formatDate(current.date)} · ${current.scoreCurrency || 'USD'}`, 'neutral'],
      ['Score model', isSox ? 'SOX canonical' : 'Asset experimental', current.scoreModelLabel || modelDetail, isSox ? 'normal' : 'warning'],
      ['1D return', formatPercent(current.oneDayReturn, 2), 'Daily adjusted close 기준', toneForReturn(current.oneDayReturn)],
      ['OH Score', scoreText(current.ohScore), isSox ? '기존 SOX 과열형 top model' : '자산 변동성 조정 OH model', scoreTone(current.ohScore)],
      ['RF Score', scoreText(current.rfScore), isSox ? '기존 SOX 반등 실패형 top model' : '자산 변동성/상대강도 RF model', scoreTone(current.rfScore)],
      ['Top Risk Score', scoreText(current.topRiskScore), topRiskDetail, scoreTone(current.topRiskScore)],
      ['Confirmation', current.confirmation ? 'ON' : 'OFF', isSox ? 'SOX confirmed_top_risk' : 'asset_confirmed_risk', current.confirmation ? 'confirmed-red' : 'normal'],
      ['Sector context', current.sectorContextActive ? 'ON' : 'OFF', `${current.sectorContextStatus || '-'} · source ${current.effectiveSectorContextSource || 'SOX'} · as of ${formatDate(current.sectorContextAsOf)} · lag ${formatLag(current.sectorContextLagDays)}`, current.sectorContextActive ? 'high-risk' : current.sectorContextStatus === 'fresh' ? 'normal' : current.sectorContextStatus === 'proxy' ? 'watch' : 'warning'],
      ['SOXQ proxy', proxy.available ? scoreText(proxy.topRiskScore) : 'N/A', proxy.available ? `proxy ${proxy.symbol || 'SOXQ'} · ${formatDate(proxy.asOf)} · ${proxy.contextActive ? 'context ON' : 'context off'}` : 'Used only when canonical SOX is stale', proxy.contextActive ? 'high-risk' : proxy.available ? 'neutral' : 'warning'],
      ['Benchmark overlay', benchmarkProxy.enabled ? scoreText(benchmarkProxy.combinedBenchmarkOverlayScore) : 'N/A', benchmarkProxy.enabled ? `local ${scoreText(benchmarkProxy.localAssetTopRiskScore)} · proxy ${scoreText(benchmarkProxy.soxqProxyTopRiskScore)} · driver ${benchmarkProxy.primaryDriver || '-'}` : 'No SOX-tracking benchmark proxy needed', benchmarkProxy.enabled ? scoreTone(benchmarkProxy.combinedBenchmarkOverlayScore) : 'neutral'],
      ['Actionable signal', current.assetActionableSignal ? 'ON' : 'OFF', 'asset confirmation + sector context', current.assetActionableSignal ? 'confirmed-red' : 'neutral'],
      ['Relative strength', current.relativeStrengthStatus || (isSox ? 'sector baseline' : '-'), current.benchmarkSymbol ? `Analysis reference: ${current.benchmarkSymbol} · benchmark as of ${formatDate(current.benchmarkAsOf)}` : 'SOX baseline', toneForRelative(current.relativeStrengthStatus)],
      ['Official benchmark', official?.name || (isSox ? 'PHLX Semiconductor Sector Index' : current.type === 'ETF' ? 'issuer exposure, not configured' : 'N/A for single stock'), official?.source ? `${official.source}; analysis reference may differ` : 'Not used as an asset-model input', officialTone],
      ['Model validation', validation.status ? `${validation.status}${finite(validation.validationScore) ? ` · ${Math.round(validation.validationScore)}/100` : ''}` : (isSox ? 'canonical' : '-'), validation.summary || selectedAssetSummary()?.confidence?.level || 'available', validationTone(validation.status)],
      ['Best validation rule', bestRule.label || (isSox ? 'Canonical SOX backtest' : '-'), finite(bestRule.downsideHitRateLift) ? `event lift ${formatLift(bestRule.downsideHitRateLift)} · events ${formatInteger(bestRule.eventCount)}` : 'Event-level evidence unavailable', validationTone(validation.status)],
      ['YTD validation', ytd.status ? `${ytd.status}` : (isSox ? 'canonical' : '-'), ytdBest.label ? `${ytdBest.label}: lift ${formatLift(ytdBest.downsideHitRateLift)} · events ${formatInteger(ytdBest.eventCount)}` : 'YTD diagnostic unavailable', validationTone(ytd.status)],
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
      const proxyNote = benchmarkProxy.enabled ? `<p class="muted-text">Benchmark overlay: local ${scoreText(benchmarkProxy.localAssetTopRiskScore)} vs SOXQ proxy ${scoreText(benchmarkProxy.soxqProxyTopRiskScore)}. SOX index가 지연되면 SOXQ proxy를 우선 확인합니다.</p>` : '';
      const asOfNote = `<p class="muted-text">As-of ${escapeHtml(formatDate(current.date || state.resolvedDate))}: ${escapeHtml(state.dateResolution?.message || '선택 기준일 분석')}</p>`;
      action.innerHTML = `<span>${escapeHtml(current.actionLabel || 'Unknown')}</span><strong>${escapeHtml(current.regime || '-')}</strong><p>${escapeHtml(current.actionText || '데이터를 확인할 수 없습니다.')}</p>${asOfNote}${caveat}${proxyNote}${warning}`;
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
    ], markerRows(scored, 'price'), { valueFormatter: formatPrice, yLabel: symbol });
    renderLineChart('#score-chart', scored, [
      { key: 'oh_score', label: 'OH', color: '#fbbf24' },
      { key: 'rf_score', label: 'RF', color: '#fb7185' },
      { key: 'top_risk_score', label: 'Top', color: '#f4f4f5' },
      { key: 'sector_proxy_top_risk_score', label: 'SOXQ proxy', color: '#38bdf8' },
    ], markerRows(scored, 'score'), { minY: 0, maxY: 5, valueFormatter: (v) => `${v}/5`, yLabel: 'Score' });
    renderLineChart('#relative-chart', scored, [
      { key: 'relative_strength', label: 'Relative strength', color: '#7dd3fc' },
      { key: 'rs_ma20', label: 'RS MA20', color: '#c4b5fd' },
      { key: 'rel_z20', label: 'RelZ20', color: '#fbbf24', axisHint: 'z' },
    ], relativeMarkerRows(scored), { valueFormatter: formatNumber, yLabel: 'RS' });
    const volSeries = [
      { key: 'vix_close', label: 'VIX', color: '#fb7185' },
      { key: 'vix_ma5', label: 'VIX MA5', color: '#fbbf24' },
      { key: 'vix_ma20', label: 'VIX MA20', color: '#7dd3fc' },
    ];
    if (scored.some((row) => finite(row.vxn_close))) {
      volSeries.push({ key: 'vxn_close', label: 'VXN', color: '#c4b5fd' });
      volSeries.push({ key: 'vxn_ma5', label: 'VXN MA5', color: '#86efac' });
    }
    renderLineChart('#vix-chart', scored, volSeries, volMarkerRows(scored), { valueFormatter: formatNumber, yLabel: 'Vol' });
  }

  function markerRows(rows, chartType = 'price') {
    return rows.flatMap((row) => {
      const markers = [];
      const valueKey = chartType === 'score' ? 'top_risk_score' : 'close';
      if (row.oh_score >= 4) markers.push({ row, tone: 'watch', label: `OH ${row.oh_score}/5`, valueKey });
      if (row.rf_score >= 4) markers.push({ row, tone: 'high-risk', label: `RF ${row.rf_score}/5`, valueKey });
      if (row.top_risk_score === 5) markers.push({ row, tone: 'red-zone', label: 'Red Zone', valueKey });
      if (row.sector_proxy_context_active) markers.push({ row, tone: 'watch', label: `SOXQ proxy ${row.sector_proxy_top_risk_score}/5`, valueKey });
      if (row.asset_confirmed_risk || row.confirmed_top_risk) markers.push({ row, tone: 'confirmed-red', label: 'Confirmed', valueKey });
      if (row.asset_actionable_signal) markers.push({ row, tone: 'confirmed-red', label: 'Actionable', valueKey });
      if (row.date === state.resolvedDate) markers.push({ row, tone: 'selected-date', label: `Selected date ${formatDate(row.date)}`, valueKey });
      return markers;
    });
  }

  function relativeMarkerRows(rows) {
    const markers = rows
      .filter((row) => row.rel_z20 >= 1 || row.rel_z20 <= -1)
      .map((row) => ({ row, tone: row.rel_z20 >= 1 ? 'watch' : 'high-risk', label: `RelZ20 ${formatNumber(row.rel_z20)}`, valueKey: 'relative_strength' }));
    const selected = rows.find((row) => row.date === state.resolvedDate);
    if (selected) markers.push({ row: selected, tone: 'selected-date', label: `Selected date ${formatDate(selected.date)}`, valueKey: finite(selected.relative_strength) ? 'relative_strength' : 'rel_z20' });
    return markers;
  }

  function volMarkerRows(rows) {
    const markers = rows
      .filter((row) => row.vix_rising || row.vxn_rising)
      .map((row) => ({ row, tone: row.vxn_rising ? 'high-risk' : 'confirmed-red', label: row.vxn_rising ? 'VXN rising' : 'VIX rising', valueKey: finite(row.vix_close) ? 'vix_close' : 'vxn_close' }));
    const selected = rows.find((row) => row.date === state.resolvedDate);
    if (selected) markers.push({ row: selected, tone: 'selected-date', label: `Selected date ${formatDate(selected.date)}`, valueKey: finite(selected.vix_close) ? 'vix_close' : 'vxn_close' });
    return markers;
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
      let value = marker.value ?? (marker.valueKey ? marker.row[marker.valueKey] : undefined);
      if (!finite(value)) value = marker.row[availableSeries[0]?.key] ?? marker.row.close;
      if (!finite(value)) return '';
      const markerClass = marker.tone === 'selected-date' ? 'selected-date' : classForLevel(marker.tone);
      return `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="${marker.tone === 'selected-date' ? '6.2' : '4.8'}" class="marker ${markerClass}"><title>${escapeHtml(`${marker.row.date}: ${marker.label}`)}</title></circle>`;
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
    if (caption) caption.textContent = `${state.selectedSymbol} · selected ${formatDate(state.resolvedDate)} · ${period?.label || state.period} · ${mode === 'event' ? 'de-clustered event-level' : 'daily signal'} · ${isSox ? 'absolute -5% label' : labelMode} · base downside ${formatPercent(base.downsideHitRate, 1)}`;
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
    const outcomeCard = selectedOutcomeCard(isSox);
    if (!isSox) {
      const asset = selectedAssetSummary();
      const validation = asset?.economicValidation || {};
      const buckets = validation.scoreBucketDiagnostics || {};
      const bestRule = validation.bestRule || {};
      const ytd = validation.ytdDiagnostics || {};
      const ytdBest = ytd.bestRule || {};
      const cross = state.assetBacktest?.crossAssetValidation || state.assetSummary?.crossAssetValidation || {};
      target.innerHTML = `${outcomeCard}<article class="notice"><h3>Vol-adjusted label 우선</h3><p>개별 종목/ETF는 고정 -5%와 변동성 조정 label을 함께 제공하지만, 주 평가는 변동성 조정 event-level입니다. SOX가 지연되면 SOXQ same-day proxy context rule을 함께 봅니다.</p></article>
      <article class="mini-card"><span>Economic validation</span><strong>${escapeHtml(validation.status || '-')} ${finite(validation.validationScore) ? `${Math.round(validation.validationScore)}/100` : ''}</strong><small>${escapeHtml(validation.summary || 'validation unavailable')}</small></article>
      <article class="mini-card"><span>Best primary rule</span><strong>${escapeHtml(bestRule.label || '-')}</strong><small>event lift ${formatLift(bestRule.downsideHitRateLift)} · events ${formatInteger(bestRule.eventCount)}</small></article>
      <article class="mini-card"><span>YTD best rule</span><strong>${escapeHtml(ytdBest.label || '-')}</strong><small>YTD lift ${formatLift(ytdBest.downsideHitRateLift)} · events ${formatInteger(ytdBest.eventCount)} · ${escapeHtml(ytd.status || '-')}</small></article>
      ${(ytd.warnings || []).slice(0, 2).map((item) => `<article class="mini-card"><span>YTD warning</span><strong>주의</strong><small>${escapeHtml(item)}</small></article>`).join('')}
      <article class="mini-card"><span>Score-bucket lift</span><strong>${formatLift(buckets.highVsNormalDownsideLift)}</strong><small>Top risk ≥4 downside frequency vs score ≤2; diagnostic only</small></article>
      <article class="mini-card"><span>Cross-asset validation</span><strong>${formatInteger(cross.statusCounts?.strong || 0)} strong · ${formatInteger(cross.statusCounts?.validated || 0)} validated</strong><small>${escapeHtml(cross.summary || 'cross-asset diagnostics unavailable')}</small></article>
      ${(asset?.warnings || []).slice(0, 4).map((item) => `<article class="mini-card"><span>Data warning</span><strong>주의</strong><small>${escapeHtml(item)}</small></article>`).join('')}`;
      return;
    }
    const items = (state.backtest?.thresholdSensitivity || []).filter((_, index) => index < 8);
    target.innerHTML = `${outcomeCard}<article class="notice"><h3>Threshold sensitivity는 보고용입니다</h3><p>아래 값은 default threshold를 자동 변경하지 않습니다. YTD 결과에 맞춘 threshold tuning은 금지됩니다.</p></article>` + items.map((item) => `
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
      'FRED/NASDAQSOX가 최신 거래일을 아직 제공하지 않으면 SOXQ를 same-day SOX-tracking ETF proxy로 사용해 effective sector context와 YTD proxy-context rule을 계산합니다.',
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
    if (summaryTitle) summaryTitle.textContent = `${state.selectedSymbol} ${formatDate(state.resolvedDate || current.date)} 기준 고점 리스크`;
    const chartTitle = $('#charts-title');
    if (chartTitle) chartTitle.textContent = `${state.selectedSymbol} as-of ${formatDate(state.resolvedDate || current.date)} 가격·점수·상대강도·VIX/VXN`;
    const assetName = $('#selected-asset-name');
    if (assetName) assetName.textContent = `${state.selectedSymbol} · ${current.name || selectedAssetSummary()?.name || ''}`;
  }

  function selectedCurrent() {
    const asset = selectedAssetSummary();
    const row = selectedResolvedRow();
    if (row) return currentFromRow(row, asset);
    if (asset?.current) return asset.current;
    return state.summary?.riskScore?.current || {};
  }

  function selectedAssetSummary() {
    return state.assetSummary?.bySymbol?.[state.selectedSymbol];
  }

  function selectedFactors() {
    const row = selectedResolvedRow();
    if (row) return buildFactorsForRow(row, selectedRows());
    if (state.selectedSymbol === 'SOX') return state.summary?.riskScore?.factorBreakdown || [];
    return selectedAssetSummary()?.factorBreakdown || [];
  }

  function selectedRows() {
    return state.assetDaily?.rowsBySymbol?.[state.selectedSymbol] || [];
  }

  function selectedChartRows() {
    const resolved = state.resolvedDate || latestScoredDate(state.selectedSymbol);
    return selectedRows()
      .filter((row) => finite(row.close) && (!resolved || row.date <= resolved))
      .slice(-520);
  }

  function selectedHistory() {
    const resolved = state.resolvedDate || latestScoredDate(state.selectedSymbol);
    const rows = selectedRows().filter((row) => !resolved || row.date <= resolved);
    const signalRows = rows.filter((row, index) => {
      if (!finite(row.top_risk_score)) return false;
      return row.top_risk_score >= 4 || row.asset_confirmed_risk || row.confirmed_top_risk || row.asset_actionable_signal || row.signal_asset_top_ge_4 || row.signal_asset_confirmed_risk || row.signal_asset_actionable_signal || (index === rows.length - 1);
    });
    return signalRows.slice(-80).reverse().map((row) => historyFromRow(row, rows));
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

  function initializeSelectionFromUrl() {
    if (typeof window === 'undefined') {
      state.requestedDate = latestScoredDate(state.selectedSymbol);
      updateDateResolution();
      return;
    }
    const params = new URL(window.location.href).searchParams;
    const symbol = params.get('symbol') || params.get('asset');
    if (symbol && hasAsset(symbol)) state.selectedSymbol = symbol;
    const date = sanitizeDate(params.get('date') || params.get('asOf') || params.get('analysisDate'));
    state.datePinned = Boolean(date);
    state.requestedDate = date || latestScoredDate(state.selectedSymbol);
    updateDateResolution();
  }

  function syncUrlState() {
    if (typeof window === 'undefined' || !window.history) return;
    const url = new URL(window.location.href);
    url.searchParams.set('symbol', state.selectedSymbol);
    if (state.datePinned && state.requestedDate) url.searchParams.set('date', state.requestedDate);
    else url.searchParams.delete('date');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function updateDateResolution() {
    const resolution = resolveAnalysisDate(state.selectedSymbol, state.requestedDate);
    state.dateResolution = resolution;
    state.resolvedDate = resolution.resolvedDate;
    state.requestedDate = resolution.requestedDate || state.requestedDate || resolution.resolvedDate;
    return resolution;
  }

  function resolveAnalysisDate(symbol, requestedDate) {
    const rows = scoredRowsForSymbol(symbol);
    const fallbackRequest = sanitizeDate(requestedDate) || rows[rows.length - 1]?.date || null;
    if (!rows.length) {
      return {
        requestedDate: fallbackRequest,
        resolvedDate: null,
        row: null,
        status: 'no-data',
        label: 'No scored data',
        message: `${symbol}에 대해 계산 가능한 scored trading day가 없습니다.`,
      };
    }
    const requested = fallbackRequest || rows[rows.length - 1].date;
    let row = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].date <= requested) {
        row = rows[index];
        break;
      }
    }
    let status = 'exact';
    if (!row) {
      row = rows[0];
      status = 'earliest';
    } else if (row.date !== requested) {
      status = requested > rows[rows.length - 1].date ? 'future-or-unscored' : 'previous-trading-day';
    } else if (!state.datePinned && row.date === rows[rows.length - 1].date) {
      status = 'latest';
    }
    const label = status === 'latest' ? 'Latest scored day'
      : status === 'exact' ? 'Exact scored day'
        : status === 'earliest' ? 'Earliest available scored day'
          : 'Nearest previous scored day';
    const message = status === 'latest' ? `${symbol} 최신 scored trading day ${formatDate(row.date)} 기준입니다.`
      : status === 'exact' ? `${symbol} ${formatDate(row.date)} 기준으로 분석합니다.`
        : status === 'earliest' ? `${formatDate(requested)} 이전 scored day가 없어 가장 이른 ${formatDate(row.date)}로 표시합니다.`
          : `${formatDate(requested)}는 휴장일·미채점일·미래일일 수 있어 직전 scored trading day ${formatDate(row.date)}로 해석했습니다.`;
    return { requestedDate: requested, resolvedDate: row.date, row, status, label, message };
  }

  function sanitizeDate(value) {
    const text = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  function hasAsset(symbol) {
    return Boolean(state.assetDaily?.rowsBySymbol?.[symbol] || state.assetSummary?.bySymbol?.[symbol] || state.assetUniverse?.assets?.some((asset) => asset.symbol === symbol));
  }

  function scoredRowsForSymbol(symbol) {
    const rows = state.assetDaily?.rowsBySymbol?.[symbol] || [];
    const scored = rows.filter((row) => finite(row.close) && finite(row.top_risk_score));
    return scored.length ? scored : rows.filter((row) => finite(row.close));
  }

  function latestScoredDate(symbol) {
    const rows = scoredRowsForSymbol(symbol);
    return rows[rows.length - 1]?.date || null;
  }

  function selectedResolvedRow() {
    return state.dateResolution?.row || resolveAnalysisDate(state.selectedSymbol, state.requestedDate).row;
  }

  function matrixRowsForDate() {
    const assets = state.assetSummary?.assets || state.assetUniverse?.assets || [];
    if (!assets.length) return state.assetSummary?.matrix || [];
    const latestMatrix = new Map((state.assetSummary?.matrix || []).map((row) => [row.symbol, row]));
    return assets.map((assetMeta) => {
      const asset = state.assetSummary?.bySymbol?.[assetMeta.symbol] || assetMeta;
      const resolution = resolveAnalysisDate(assetMeta.symbol, state.resolvedDate || state.requestedDate);
      if (!resolution.row) return latestMatrix.get(assetMeta.symbol) || { symbol: assetMeta.symbol, name: assetMeta.name, type: assetMeta.type };
      const current = currentFromRow(resolution.row, asset);
      const validation = asset?.economicValidation || {};
      const quality = asset?.dataQuality || {};
      return {
        symbol: assetMeta.symbol,
        name: current.name || assetMeta.name,
        type: current.type || assetMeta.type,
        group: current.group || assetMeta.group,
        latest: current.close,
        rawLatest: current.rawClose,
        scoreCurrency: current.scoreCurrency,
        currency: current.currency,
        date: current.date,
        dateLabel: `${formatDate(current.date)} · ${resolution.status === 'exact' || resolution.status === 'latest' ? resolution.label : 'resolved'}`,
        oneDayReturn: current.oneDayReturn,
        ohScore: current.ohScore,
        rfScore: current.rfScore,
        topRiskScore: current.topRiskScore,
        regime: current.regime,
        confirmed: current.confirmation,
        sectorContext: current.sectorContextActive,
        sectorContextStatus: current.sectorContextStatus,
        sectorContextAsOf: current.sectorContextAsOf,
        sectorContextLagDays: current.sectorContextLagDays,
        effectiveSectorContextSource: current.effectiveSectorContextSource,
        canonicalSectorContextStatus: current.canonicalSectorContextStatus,
        sectorProxy: current.sectorProxy,
        benchmarkProxyRisk: current.benchmarkProxyRisk,
        actionable: current.assetActionableSignal,
        relativeStrength: current.relativeStrengthStatus || '-',
        analysisBenchmark: current.analysisBenchmark,
        officialBenchmark: current.officialBenchmark,
        dataStatus: asset?.dataStatus?.status || quality.level || latestMatrix.get(assetMeta.symbol)?.dataStatus,
        dataQuality: quality.level || latestMatrix.get(assetMeta.symbol)?.dataQuality,
        dataProvider: quality.source || asset?.dataStatus?.source || latestMatrix.get(assetMeta.symbol)?.dataProvider,
        confidence: asset?.confidence?.level || latestMatrix.get(assetMeta.symbol)?.confidence,
        economicValidationStatus: validation.status || latestMatrix.get(assetMeta.symbol)?.economicValidationStatus,
        validationScore: validation.validationScore,
        warnings: asset?.warnings || [],
      };
    });
  }

  function currentFromRow(row, asset = {}) {
    const symbol = row.symbol || state.selectedSymbol;
    const isSox = symbol === 'SOX';
    const action = actionFromScores(row);
    const current = asset?.current || {};
    const sectorProxy = sectorProxyFromRow(row, current.sectorProxy);
    const benchmarkProxyRisk = benchmarkProxyFromRow(row, asset, sectorProxy);
    const effectiveStatus = row.effective_sector_context_source === 'SOXQ' ? 'proxy' : (row.canonical_sector_context_status || row.sector_context_status);
    return {
      symbol,
      name: asset?.name || current.name || symbol,
      type: asset?.type || current.type || (isSox ? 'Sector' : 'Asset'),
      group: asset?.group || current.group,
      date: row.date,
      displayDate: row.date,
      latestScoredDate: row.date,
      scoreModel: isSox ? 'sox_canonical' : 'asset_vol_relative',
      scoreModelLabel: isSox ? 'SOX canonical sector risk model' : 'Asset-specific volatility-adjusted relative-strength model',
      close: row.close,
      rawClose: row.raw_close ?? row.rawClose ?? row.close,
      currency: current.currency || asset?.currency || row.score_currency || 'USD',
      scoreCurrency: row.score_currency || current.scoreCurrency || 'USD',
      oneDayReturn: row.ret_1,
      ohScore: row.oh_score,
      rfScore: row.rf_score,
      topRiskScore: row.top_risk_score,
      regime: row.regime || action.regime,
      confirmation: isSox ? Boolean(row.confirmed_top_risk) : Boolean(row.asset_confirmed_risk),
      assetConfirmedRisk: isSox ? Boolean(row.confirmed_top_risk) : Boolean(row.asset_confirmed_risk),
      assetActionableSignal: isSox ? Boolean(row.confirmed_top_risk) : Boolean(row.asset_actionable_signal),
      sectorContextActive: Boolean(row.effective_sector_context_active ?? row.sector_context_active ?? row.canonical_sector_context_active),
      canonicalSectorContextActive: Boolean(row.canonical_sector_context_active),
      canonicalSectorContextAsOf: row.canonical_sector_context_as_of,
      canonicalSectorContextStatus: row.canonical_sector_context_status,
      canonicalSectorContextLagDays: row.canonical_sector_context_lag_days ?? current.canonicalSectorContextLagDays,
      effectiveSectorContextActive: Boolean(row.effective_sector_context_active ?? row.sector_context_active),
      effectiveSectorContextSource: row.effective_sector_context_source || 'SOX',
      effectiveSectorContextAsOf: row.effective_sector_context_as_of || row.sector_context_as_of,
      effectiveSectorContextStatus: effectiveStatus,
      effectiveSectorContextLagDays: row.sector_context_lag_days,
      sectorProxy,
      benchmarkProxyRisk,
      actionLevel: action.level,
      actionLabel: action.label,
      actionText: action.text,
      relativeStrength: row.relative_strength,
      relativeStrengthStatus: row.relative_strength_status || (isSox ? 'sector baseline' : '-'),
      relativeStrengthBasis: current.relativeStrengthBasis || asset?.relativeStrengthBasis,
      relZ20: row.rel_z20,
      benchmarkSymbol: row.benchmark_symbol || current.benchmarkSymbol || asset?.benchmark,
      benchmarkClose: current.benchmarkClose,
      benchmarkAsOf: row.benchmark_as_of || current.benchmarkAsOf,
      analysisBenchmark: asset?.analysisBenchmark || current.analysisBenchmark,
      officialBenchmark: asset?.officialBenchmark || current.officialBenchmark,
      fxUsdKrw: current.fxUsdKrw,
      currencyWarning: current.currencyWarning,
      sectorContextAsOf: row.sector_context_as_of || row.effective_sector_context_as_of,
      sectorContextLagDays: row.sector_context_lag_days,
      sectorContextStatus: effectiveStatus || row.sector_context_status,
      sectorContextWarning: current.sectorContextWarning,
      rawSectorContextDate: current.rawSectorContextDate,
      rawSectorContextScored: current.rawSectorContextScored,
      vixClose: row.vix_close,
      vixRising: Boolean(row.vix_rising),
      vxnClose: row.vxn_close,
      vxnRising: Boolean(row.vxn_rising),
      soxOhScore: current.soxOhScore,
      soxRfScore: current.soxRfScore,
      soxTopRiskScore: current.soxTopRiskScore,
      soxConfirmedTopRisk: Boolean(row.signal_sox_confirmed_top_risk),
    };
  }

  function actionFromScores(row) {
    if (row.confirmed_top_risk || row.asset_confirmed_risk) {
      return {
        level: 'confirmed-red',
        label: 'Confirmed Red',
        regime: row.regime || 'Confirmed Risk',
        text: '선택 기준일의 leading setup이 rollover/volatility/relative confirmation과 결합된 risk overlay 상태입니다.',
      };
    }
    const top = Number(row.top_risk_score);
    if (top >= 5) return { level: 'red-zone', label: 'Red Zone', regime: row.regime || 'Red Zone', text: '고점권 과열 또는 반등 실패 setup이 강하게 누적된 상태입니다.' };
    if (top >= 4) return { level: 'high-risk', label: 'High Risk', regime: row.regime || 'High Risk', text: 'overweight 일부 축소 또는 hedge 준비를 검토할 수 있는 risk overlay 상태입니다.' };
    if (top >= 3) return { level: 'watch', label: 'Watch', regime: row.regime || 'Watch', text: '신규 추격매수 억제와 trailing stop 점검이 필요한 관찰 구간입니다.' };
    return { level: 'normal', label: 'Normal', regime: row.regime || 'Normal', text: '일반 포지션 유지 관점의 risk overlay 상태입니다.' };
  }

  function sectorProxyFromRow(row, fallback = {}) {
    const hasProxy = row.sector_proxy_symbol && finite(row.sector_proxy_top_risk_score);
    if (!hasProxy) return fallback?.available !== undefined ? fallback : {
      symbol: row.sector_proxy_symbol || 'SOXQ',
      available: false,
      status: row.symbol === 'SOX' ? 'not_applicable_for_canonical_sox' : 'unavailable',
      asOf: null,
      isSelf: false,
      ohScore: null,
      rfScore: null,
      topRiskScore: null,
      confirmedRisk: false,
      actionableSignal: false,
      contextActive: false,
    };
    return {
      symbol: row.sector_proxy_symbol,
      available: true,
      status: row.sector_proxy_as_of === row.date ? 'same_day' : 'available',
      asOf: row.sector_proxy_as_of,
      isSelf: row.symbol === row.sector_proxy_symbol,
      ohScore: null,
      rfScore: null,
      topRiskScore: row.sector_proxy_top_risk_score,
      confirmedRisk: Boolean(row.signal_sox_confirmed_top_risk),
      actionableSignal: Boolean(row.asset_actionable_signal),
      contextActive: Boolean(row.sector_proxy_context_active),
    };
  }

  function benchmarkProxyFromRow(row, asset = {}, sectorProxy = {}) {
    const currentProxy = asset?.current?.benchmarkProxyRisk || {};
    const official = asset?.officialBenchmark || asset?.current?.officialBenchmark || {};
    const analysis = asset?.analysisBenchmark || asset?.current?.analysisBenchmark || {};
    const symbol = row.symbol || state.selectedSymbol;
    const enabled = currentProxy.enabled || (symbol !== 'SOX' && (official.symbol === 'SOX' || analysis.symbol === 'SOX' || row.benchmark_symbol === 'SOX'));
    if (!enabled) return { enabled: false };
    const local = finite(row.top_risk_score) ? Number(row.top_risk_score) : null;
    const proxy = finite(row.sector_proxy_top_risk_score) ? Number(row.sector_proxy_top_risk_score) : null;
    const combined = Math.max(...[local, proxy].filter((value) => Number.isFinite(value)));
    return {
      enabled: true,
      sourceSymbol: symbol,
      officialBenchmarkSymbol: official.symbol,
      officialBenchmarkName: official.name,
      analysisReferenceSymbol: analysis.symbol || row.benchmark_symbol,
      analysisReferenceRole: analysis.role,
      overlayBasis: currentProxy.overlayBasis || (official.symbol === 'SOX' ? 'official_sox_tracking' : 'analysis_reference'),
      localAssetTopRiskScore: local,
      canonicalSoxTopRiskScore: null,
      staleCanonicalSoxTopRiskScore: currentProxy.staleCanonicalSoxTopRiskScore,
      soxqProxyTopRiskScore: proxy,
      combinedBenchmarkOverlayScore: Number.isFinite(combined) ? combined : null,
      primaryDriver: Number.isFinite(proxy) && proxy > (local ?? -Infinity) ? 'soxqProxyTopRiskScore' : 'localAssetTopRiskScore',
      localVsProxyScoreGap: Number.isFinite(local) && Number.isFinite(proxy) ? local - proxy : null,
      canonicalSoxIncludedInOverlay: false,
      interpretation: currentProxy.interpretation || 'Selected-date benchmark overlay combines the local asset score with same-day SOXQ proxy context when canonical SOX is stale.',
      sectorProxyStatus: sectorProxy.status,
    };
  }

  function buildFactorsForRow(row, rows) {
    const isSox = (row.symbol || state.selectedSymbol) === 'SOX';
    const metrics = rollingMetrics(row, rows);
    if (isSox) {
      return [
        factorRow('z20_gt_1_5', row.z20, 'z20 > 1.5', row.z20 > 1.5, 'OH', '20D 평균 대비 통계적 과열'),
        factorRow('rsi5_gt_70', row.rsi5, 'RSI5 > 70', row.rsi5 > 70, 'OH', '단기 과매수'),
        factorRow('roc20_gt_10', metrics.roc20, 'ROC20 > 10%', metrics.roc20 > 0.10, 'OH', '1개월 강한 momentum'),
        factorRow('gap20_gt_4', metrics.gap20, 'gap20 > 4%', metrics.gap20 > 0.04, 'OH', '20D 추세선 대비 유의미한 이격'),
        factorRow('near_high20', row.close, 'C >= 99.5% of High20', finite(metrics.high20) && row.close >= 0.995 * metrics.high20, 'OH', '최근 고점권에서 rally 진행'),
        factorRow('prior_damage', metrics.drawdown50, 'C < MA50 OR C <= 95% High50', row.close < row.ma50 || (finite(metrics.high50) && row.close <= 0.95 * metrics.high50), 'RF', '중기 추세 훼손 또는 50D 고점 대비 유의미한 하락'),
        factorRow('rebound_from_low', metrics.rebound20, 'C >= 105% Low20', finite(metrics.low20) && row.close >= 1.05 * metrics.low20, 'RF', '20D 저점 대비 반등'),
        factorRow('ma_resistance', metrics.maDistance, 'within 3% of MA20/MA50 and not > 102% above', metrics.maResistance, 'RF', 'MA20/MA50 저항권까지 반등했으나 명확한 안착 전'),
        factorRow('weak_momentum', metrics.roc20, 'ROC20 <= 3% OR MA20 slope5 < 0', (finite(metrics.roc20) && metrics.roc20 <= 0.03) || (finite(metrics.ma20Slope5) && metrics.ma20Slope5 < 0), 'RF', '20D momentum 약화 또는 MA20 하락'),
        factorRow('vix_not_low', row.vix_close, 'VIX >= 16 OR VIX > VIX MA20', finite(row.vix_close) && (row.vix_close >= 16 || (finite(row.vix_ma20) && row.vix_close > row.vix_ma20)), 'RF', '변동성 regime이 아직 안정되지 않음'),
        factorRow('confirmed_top_risk', row.confirmed_top_risk ? 1 : 0, 'recent setup + rollover/down day/VIX confirmation', Boolean(row.confirmed_top_risk), 'Confirmation', 'Leading setup이 가격 또는 변동성 확인 신호와 결합'),
      ];
    }
    return [
      factorRow('z20_gt_1_5', row.z20, 'z20 > 1.5', row.z20 > 1.5, 'OH', '자산 자체 20D 평균 대비 통계적 과열'),
      factorRow('rsi5_gt_70', row.rsi5, 'RSI5 > 70', row.rsi5 > 70, 'OH', '단기 과매수'),
      factorRow('roc20z_gt_1_25', row.roc20z, 'ROC20Z > 1.25', row.roc20z > 1.25, 'OH', '20D 상승률을 해당 자산 변동성으로 표준화한 momentum 과열'),
      factorRow('near_high20', row.close, 'P >= 99.5% of High20', finite(metrics.high20) && row.close >= 0.995 * metrics.high20, 'OH', '최근 고점권에서 rally 진행'),
      factorRow('relz20_gt_1', row.rel_z20, 'RelZ20 > 1.0', row.rel_z20 > 1.0, 'OH', '섹터/벤치마크 대비 crowded outperformance'),
      factorRow('prior_damage', metrics.dd50z, 'P < MA50 OR DD50Z < -1.0', row.close < row.ma50 || metrics.dd50z < -1.0, 'RF', '추세 훼손 또는 변동성 대비 의미 있는 고점 대비 하락'),
      factorRow('rebound_from_low', metrics.rebound20z, 'Rebound20Z > 0.75', metrics.rebound20z > 0.75, 'RF', '하락 후 변동성 대비 충분한 반등'),
      factorRow('ma_resistance', metrics.maDistance, 'near MA20/MA50 and not clearly above', metrics.maResistance, 'RF', 'MA20/MA50 저항권 근처의 lower-high 위험'),
      factorRow('weak_momentum', row.roc20z, 'ROC20Z < 0.5 OR MA20 slope5 < 0', (finite(row.roc20z) && row.roc20z < 0.5) || (finite(metrics.ma20Slope5) && metrics.ma20Slope5 < 0), 'RF', '변동성 대비 momentum 약화 또는 MA20 하락'),
      factorRow('relative_weakness', metrics.rsSlope5, 'RS < RS MA20 OR RS slope5 < 0', (finite(row.relative_strength) && finite(row.rs_ma20) && row.relative_strength < row.rs_ma20) || (finite(metrics.rsSlope5) && metrics.rsSlope5 < 0), 'RF', '섹터 대비 상대강도 회복 실패'),
      factorRow('asset_confirmed_risk', row.asset_confirmed_risk ? 1 : 0, 'recent setup + MA5/large down/RS rollover', Boolean(row.asset_confirmed_risk), 'Confirmation', '자산 자체 차트가 꺾인 확인 신호'),
      factorRow('sector_context_active', row.effective_sector_context_active ? 1 : 0, 'SOX/OH/RF/VIX/VXN or SOXQ proxy context active', Boolean(row.effective_sector_context_active), 'Sector', '섹터 context가 동시에 악화되는지 확인'),
      factorRow('asset_actionable_signal', row.asset_actionable_signal ? 1 : 0, 'confirmed risk AND sector context', Boolean(row.asset_actionable_signal), 'Confirmation', '자산 risk와 섹터 context가 동시에 악화된 risk overlay'),
    ];
  }

  function factorRow(factor, currentValue, threshold, signal, model, interpretation) {
    return { factor, currentValue, threshold, signal: Boolean(signal), model, interpretation };
  }

  function rollingMetrics(row, rows) {
    const index = rows.findIndex((item) => item.date === row.date);
    const end = index >= 0 ? index : rows.length - 1;
    const slice = (days) => rows.slice(Math.max(0, end - days + 1), end + 1).filter((item) => finite(item.close));
    const closes20 = slice(20).map((item) => Number(item.close));
    const closes50 = slice(50).map((item) => Number(item.close));
    const high20 = closes20.length ? Math.max(...closes20) : null;
    const low20 = closes20.length ? Math.min(...closes20) : null;
    const high50 = closes50.length ? Math.max(...closes50) : null;
    const lag20 = rows[end - 20];
    const lag5 = rows[end - 5];
    const roc20 = lag20 && finite(lag20.close) ? row.close / lag20.close - 1 : null;
    const gap20 = finite(row.ma20) ? row.close / row.ma20 - 1 : null;
    const rebound20 = finite(low20) ? row.close / low20 - 1 : null;
    const drawdown50 = finite(high50) ? row.close / high50 - 1 : null;
    const ma20Slope5 = lag5 && finite(lag5.ma20) && finite(row.ma20) ? row.ma20 / lag5.ma20 - 1 : null;
    const rsSlope5 = lag5 && finite(lag5.rs_ma20) && finite(row.rs_ma20) ? row.rs_ma20 / lag5.rs_ma20 - 1 : null;
    const ma20Distance = finite(row.ma20) ? Math.abs(row.close / row.ma20 - 1) : null;
    const ma50Distance = finite(row.ma50) ? Math.abs(row.close / row.ma50 - 1) : null;
    const maDistance = Math.min(...[ma20Distance, ma50Distance].filter((value) => Number.isFinite(value)));
    const maResistance = Number.isFinite(maDistance) && maDistance <= 0.03 && finite(row.ma20) && finite(row.ma50) && row.close <= 1.02 * Math.max(row.ma20, row.ma50);
    const vol20 = finite(row.rv20) ? Number(row.rv20) : null;
    const dd50z = finite(high50) && finite(vol20) && vol20 > 0 ? Math.log(row.close / high50) / (vol20 * Math.sqrt(50)) : null;
    const rebound20z = finite(low20) && finite(vol20) && vol20 > 0 ? Math.log(row.close / low20) / (vol20 * Math.sqrt(20)) : null;
    return { high20, low20, high50, roc20, gap20, rebound20, drawdown50, ma20Slope5, rsSlope5, maDistance, maResistance, dd50z, rebound20z };
  }

  function historyFromRow(row, rows) {
    const outcome = forwardOutcome(row, selectedRows());
    return {
      date: row.date,
      close: row.close,
      ohScore: row.oh_score,
      rfScore: row.rf_score,
      topRiskScore: row.top_risk_score,
      confirmation: Boolean(row.asset_confirmed_risk || row.confirmed_top_risk),
      actionable: row.symbol === 'SOX' ? Boolean(row.confirmed_top_risk) : Boolean(row.asset_actionable_signal),
      fwdMin5: outcome.fwdMin5,
      fwdMax5: outcome.fwdMax5,
      fwdRet5: outcome.fwdRet5,
      downsideHit: outcome.downsideHit,
      strictTopHit: outcome.strictTopHit,
      volAdjDownsideHit: outcome.volAdjDownsideHit,
      volAdjStrictTopHit: outcome.volAdjStrictTopHit,
      regime: row.regime,
    };
  }

  function forwardOutcome(row, rows) {
    const index = rows.findIndex((item) => item.date === row.date);
    const future = index >= 0 ? rows.slice(index + 1, index + 6).filter((item) => finite(item.close)) : [];
    if (future.length < 5 || !finite(row.close)) {
      return { pending: true, fwdMin5: null, fwdMax5: null, fwdRet5: null, downsideHit: null, strictTopHit: null, volAdjDownsideHit: null, volAdjStrictTopHit: null };
    }
    const returns = future.map((item) => item.close / row.close - 1);
    const fwdMin5 = Math.min(...returns);
    const fwdMax5 = Math.max(...returns);
    const fwdRet5 = returns[4];
    const downsideHit = fwdMin5 <= -0.05;
    const strictTopHit = fwdMax5 <= 0 && downsideHit;
    const volThreshold = finite(row.rv20) ? Number(row.rv20) * Math.sqrt(5) : null;
    const volAdjDownsideHit = finite(volThreshold) ? fwdMin5 <= -1.5 * volThreshold : null;
    const volAdjStrictTopHit = finite(volThreshold) ? fwdMax5 <= 0.5 * volThreshold && fwdMin5 <= -1.5 * volThreshold : null;
    return { pending: false, fwdMin5, fwdMax5, fwdRet5, downsideHit, strictTopHit, volAdjDownsideHit, volAdjStrictTopHit };
  }

  function selectedOutcomeCard(isSox) {
    const row = selectedResolvedRow();
    if (!row) return '';
    const outcome = forwardOutcome(row, selectedRows());
    const ruleState = row.top_risk_score >= 4 || row.asset_confirmed_risk || row.confirmed_top_risk ? 'signal on' : 'no high-risk signal';
    if (outcome.pending) {
      return `<article class="mini-card"><span>Selected-date outcome</span><strong>${escapeHtml(formatDate(row.date))}</strong><small>${escapeHtml(ruleState)} · forward 5D label pending because fewer than 5 later trading days are available.</small></article>`;
    }
    return `<article class="mini-card"><span>Selected-date outcome</span><strong>${formatPercent(outcome.fwdMin5, 2)} min</strong><small>${escapeHtml(formatDate(row.date))} · ${escapeHtml(ruleState)} · fwd ret ${formatPercent(outcome.fwdRet5, 2)} · ${isSox ? `abs downside ${yesNo(outcome.downsideHit)}` : `vol-adj downside ${yesNo(outcome.volAdjDownsideHit)}`}</small></article>`;
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
    if (/rsi|score|roc20z|dd50z|rebound20z|relz20|z20|z$/i.test(factor)) return formatNumber(value);
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
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  if (typeof window !== 'undefined') {
    window.__riskScoreApp = { renderSummary, renderFactors, renderBacktest, FILES, selectAsset, selectAnalysisDate, resolveAnalysisDate, syncUrlState };
  }
})();
