import { readFileSync, statSync } from 'node:fs';

const files = {
  html: readFileSync('index.html', 'utf8'),
  css: readFileSync('assets/styles.css', 'utf8'),
  app: readFileSync('assets/app.js', 'utf8'),
  model: readFileSync('risk_score/model.py', 'utf8'),
  assetModel: readFileSync('risk_score/asset_model.py', 'utf8'),
  updater: readFileSync('scripts/update_risk_score_data.py', 'utf8'),
  sync: readFileSync('scripts/sync_to_quant_dashboard.py', 'utf8'),
  tests: readFileSync('tests/test_risk_score.py', 'utf8') + readFileSync('tests/test_asset_model.py', 'utf8'),
  universe: readFileSync('config/asset_universe.json', 'utf8'),
};
const checks = [];
const assert = (condition, label) => checks.push({ ok: Boolean(condition), label });
const contains = (haystack, needle) => haystack.includes(needle);

for (const path of [
  'index.html', 'assets/app.js', 'assets/styles.css', 'risk_score/model.py', 'risk_score/asset_model.py', 'config/asset_universe.json', 'scripts/update_risk_score_data.py', 'scripts/sync_to_quant_dashboard.py', 'tests/test_risk_score.py', 'tests/test_asset_model.py', 'package.json',
]) assert(statSync(path).isFile(), `${path} exists`);

for (const id of ['selector', 'summary', 'matrix', 'factors', 'charts', 'backtest', 'signals', 'methodology']) {
  assert(contains(files.html, `id="${id}"`), `section exists: ${id}`);
}
assert(contains(files.html, 'Back to Quant Dashboard'), 'back link exists');
assert(contains(files.html, 'SOX & Asset Top Risk Score'), 'multi-asset title exists');
assert(contains(files.html, '뉴스가 아니라'), 'no-news positioning exists');
assert(contains(files.html, 'asset-select') && contains(files.html, 'asset-matrix-body'), 'asset selector and matrix exist');
assert(contains(files.html, 'relative-chart') && contains(files.html, 'Vol-adjusted'), 'relative chart and label toggle exist');
assert(contains(files.app, "DATA_BASE = 'data/risk-score/'"), 'relative data base used');
assert(!contains(files.app, 'fred.stlouisfed.org') && !contains(files.app, 'query1.finance.yahoo'), 'browser app has no live finance endpoints');
assert(contains(files.app, 'asset_risk_summary.json') && contains(files.app, 'asset_risk_backtest.json'), 'asset JSON files loaded by UI');
assert(contains(files.app, 'renderRiskMatrix') && contains(files.app, 'selectAsset'), 'asset matrix and selector renderer exist');
assert(contains(files.app, 'assetActionableSignal') && contains(files.app, 'sectorContextActive'), 'confirmed risk and actionable signal separated');
assert(contains(files.app, 'sectorContextAsOf') && contains(files.app, 'sectorContextStatus') && contains(files.app, 'sectorContextLagDays'), 'UI surfaces sector context date/status/lag');
assert(contains(files.app, 'Official benchmark') && contains(files.app, 'Analysis reference') && contains(files.app, 'not calibrated to SOX probability'), 'UI separates official benchmark, analysis reference, and score semantics');
assert(contains(files.app, 'Economic validation') && contains(files.app, 'validationTone'), 'UI surfaces economic validation');
assert(contains(files.app, 'Best validation rule') && contains(files.app, 'Score-bucket lift') && contains(files.app, 'Cross-asset validation'), 'UI surfaces economic validation diagnostics');
assert(contains(files.app, 'Data quality') && contains(files.app, 'Price provider policy'), 'UI surfaces data quality/provider policy');
assert(contains(files.css, '--danger') && contains(files.css, '--warning') && contains(files.css, '--success'), 'risk color tokens exist');
assert(contains(files.css, '@media (max-width: 760px)'), 'mobile responsive CSS exists');
assert(contains(files.css, '.asset-picker') && contains(files.css, '.asset-row.selected'), 'asset selector/matrix styles exist');

for (const fn of ['fetch_fred_series', 'compute_indicators', 'compute_oh_score', 'compute_rf_score', 'compute_confirmation', 'compute_forward_labels', 'decluster_signals', 'compute_backtest_stats', 'export_json_outputs']) {
  assert(contains(files.model, `def ${fn}`), `python function exists: ${fn}`);
}
for (const threshold of ["'z20_overheat': 1.5", "'rsi5_overheat': 70", "'roc20_overheat': 0.10", "'gap20_overheat': 0.04"]) {
  assert(contains(files.model, threshold), `fixed SOX threshold exists: ${threshold}`);
}
for (const fn of ['load_universe_config', 'fetch_yahoo_daily_prices', 'fetch_fmp_daily_prices', 'fetch_or_load_prices', 'provider_policy', 'run_asset_pipeline', 'compute_asset_oh_score', 'compute_asset_rf_score', 'compute_asset_confirmation', 'economic_validation_from_periods', 'export_asset_json_outputs']) {
  assert(contains(files.assetModel, `def ${fn}`), `asset python function exists: ${fn}`);
}
for (const marker of ['ROC20Z > 1.25', 'RelZ20 > 1.0', 'SOX_USD_IF_FX_ELSE_KOSPI', 'vol_adj_downside_5d', 'asset_actionable_signal', 'sector_context_active', 'sector_context_as_of', 'relative_weakness_sector_context', 'scoreBuckets', 'crossAssetValidation', 'dataQuality', 'providerAttempts', 'fmp_historical_eod', 'officialBenchmark', 'analysisBenchmark', 'economicValidation']) {
  assert(contains(files.assetModel + files.universe, marker), `asset methodology marker exists: ${marker}`);
}
for (const symbol of ['MU', 'INTC', 'MRVL', 'WDC', 'SNDK', 'STX', '005930.KS', '000660.KS', 'SOXX', 'SMH', 'XSD', 'PSI', 'DRAM']) {
  assert(contains(files.universe, `"symbol": "${symbol}"`), `universe includes ${symbol}`);
}
assert(contains(files.model, "'projectId': 'risk-score'") && contains(files.model, "'contract': 'quant-research-summary'"), 'summary contract export exists');
assert(contains(files.model, "'primaryMode': 'event'"), 'SOX event-level primary mode exists');
assert(contains(files.tests, 'test_json_export_contract') && contains(files.tests, 'test_config_universe_contains_required_assets_and_warnings'), 'unit tests lock contracts, thresholds, and universe');
assert(contains(files.tests, 'test_context_lag_warns_and_degrades_asset_status') && contains(files.tests, 'test_weak_economic_validation_downgrades_confidence'), 'unit tests lock context lag and validation downgrade');
assert(contains(files.tests, 'test_price_loader_falls_back_to_fmp_when_yahoo_fails') && contains(files.tests, 'test_provider_symbol_policy_supports_fmp_only_for_usd_assets'), 'unit tests lock provider fallback policy');
assert(contains(files.sync, 'quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score'), 'sync target is concrete quant-dashboard worktree');

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label}`);
if (failed.length) {
  console.error(`\n${failed.length} verification check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length} verification checks passed.`);
