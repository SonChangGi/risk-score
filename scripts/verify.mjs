import { readFileSync, statSync } from 'node:fs';

const files = {
  html: readFileSync('index.html', 'utf8'),
  css: readFileSync('assets/styles.css', 'utf8'),
  app: readFileSync('assets/app.js', 'utf8'),
  model: readFileSync('risk_score/model.py', 'utf8'),
  updater: readFileSync('scripts/update_risk_score_data.py', 'utf8'),
  sync: readFileSync('scripts/sync_to_quant_dashboard.py', 'utf8'),
  tests: readFileSync('tests/test_risk_score.py', 'utf8'),
};
const checks = [];
const assert = (condition, label) => checks.push({ ok: Boolean(condition), label });
const contains = (haystack, needle) => haystack.includes(needle);

for (const path of [
  'index.html', 'assets/app.js', 'assets/styles.css', 'risk_score/model.py', 'scripts/update_risk_score_data.py', 'scripts/sync_to_quant_dashboard.py', 'tests/test_risk_score.py', 'package.json',
]) assert(statSync(path).isFile(), `${path} exists`);

for (const id of ['summary', 'factors', 'charts', 'backtest', 'signals', 'methodology']) {
  assert(contains(files.html, `id="${id}"`), `section exists: ${id}`);
}
assert(contains(files.html, 'Back to Quant Dashboard'), 'back link exists');
assert(contains(files.html, 'SOX Top Risk Score'), 'title exists');
assert(contains(files.html, '뉴스가 아니라'), 'no-news positioning exists');
assert(contains(files.app, "DATA_BASE = 'data/risk-score/'"), 'relative data base used');
assert(!contains(files.app, 'fred.stlouisfed.org') && !contains(files.app, 'query1.finance.yahoo'), 'browser app has no live finance endpoints');
assert(contains(files.app, 'renderLineChart') && contains(files.app, 'markerRows'), 'chart renderer and markers exist');
assert(contains(files.app, 'thresholdSensitivity'), 'threshold sensitivity panel rendered');
assert(contains(files.css, '--danger') && contains(files.css, '--warning') && contains(files.css, '--success'), 'risk color tokens exist');
assert(contains(files.css, '@media (max-width: 760px)'), 'mobile responsive CSS exists');

for (const fn of ['fetch_fred_series', 'compute_indicators', 'compute_oh_score', 'compute_rf_score', 'compute_confirmation', 'compute_forward_labels', 'decluster_signals', 'compute_backtest_stats', 'export_json_outputs']) {
  assert(contains(files.model, `def ${fn}`), `python function exists: ${fn}`);
}
for (const threshold of ["'z20_overheat': 1.5", "'rsi5_overheat': 70", "'roc20_overheat': 0.10", "'gap20_overheat': 0.04"]) {
  assert(contains(files.model, threshold), `fixed threshold exists: ${threshold}`);
}
assert(contains(files.model, "'projectId': 'risk-score'") && contains(files.model, "'contract': 'quant-research-summary'"), 'summary contract export exists');
assert(contains(files.model, "'full'") && contains(files.model, "'recent_3y'") && contains(files.model, "'recent_1y'") && contains(files.model, "'ytd'") && contains(files.model, "'ex_2026'"), 'period splits exist');
assert(contains(files.model, "'primaryMode': 'event'"), 'event-level primary mode exists');
assert(contains(files.tests, 'test_json_export_contract') && contains(files.tests, 'test_threshold_constants_match_prompt_defaults'), 'unit tests lock contract and thresholds');
assert(contains(files.sync, 'quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score'), 'sync target is concrete quant-dashboard worktree');

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label}`);
if (failed.length) {
  console.error(`\n${failed.length} verification check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length} verification checks passed.`);
