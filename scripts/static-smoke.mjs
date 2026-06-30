import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const prefix = '/quant-dashboard/risk-score/';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    let relative;
    if (pathname === '/' || pathname === prefix) relative = 'index.html';
    else if (pathname.startsWith(prefix)) relative = pathname.slice(prefix.length);
    else relative = pathname.slice(1);
    const safe = normalize(relative || 'index.html').replace(/^(\.\.(\/|\\|$))+/, '');
    const body = await readFile(join(root, safe));
    response.writeHead(200, { 'content-type': types.get(extname(safe)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const base = `http://127.0.0.1:${port}`;
  const [rootHtml, nestedHtml, app, css, summary, assetUniverse, assetSummary, assetDaily, assetBacktest, dataStatus] = await Promise.all([
    fetch(`${base}/`).then((r) => r.text()),
    fetch(`${base}${prefix}`).then((r) => r.text()),
    fetch(`${base}${prefix}assets/app.js`).then((r) => r.text()),
    fetch(`${base}${prefix}assets/styles.css`).then((r) => r.text()),
    fetch(`${base}${prefix}data/risk-score/risk_score_summary.json`).then((r) => r.json()),
    fetch(`${base}${prefix}data/risk-score/asset_universe.json`).then((r) => r.json()),
    fetch(`${base}${prefix}data/risk-score/asset_risk_summary.json`).then((r) => r.json()),
    fetch(`${base}${prefix}data/risk-score/asset_risk_daily.json`).then((r) => r.json()),
    fetch(`${base}${prefix}data/risk-score/asset_risk_backtest.json`).then((r) => r.json()),
    fetch(`${base}${prefix}data/risk-score/data_status.json`).then((r) => r.json()),
  ]);
  if (!rootHtml.includes('SOX & Asset Top Risk Score')) throw new Error('root index missing multi-asset title');
  if (!nestedHtml.includes('Back to Quant Dashboard')) throw new Error('nested route missing back link');
  if (!nestedHtml.includes('asset-select') || !nestedHtml.includes('asset-matrix-body')) throw new Error('nested route missing asset UI');
  if (!app.includes("DATA_BASE = 'data/risk-score/'")) throw new Error('relative data path missing');
  if (app.includes('query1.finance.yahoo') || app.includes('fred.stlouisfed.org')) throw new Error('browser app contains live finance endpoint');
  if (!css.includes('.asset-picker') || !css.includes('@media (max-width: 760px)')) throw new Error('responsive asset CSS missing');
  if (summary.contract !== 'quant-research-summary' || summary.projectId !== 'risk-score') throw new Error('summary contract mismatch');
  if (!summary.primaryEntities?.[0]?.metrics?.topRiskScore && summary.primaryEntities?.[0]?.metrics?.topRiskScore !== 0) throw new Error('top risk metric missing');
  const required = ['MU', 'INTC', 'MRVL', 'WDC', 'SNDK', 'STX', '005930.KS', '000660.KS', 'SOXX', 'SOXQ', 'SMH', 'XSD', 'PSI', 'DRAM'];
  const universeSymbols = new Set(assetUniverse.assets?.map((asset) => asset.symbol));
  for (const symbol of required) if (!universeSymbols.has(symbol)) throw new Error(`universe missing ${symbol}`);
  if (assetSummary.contract !== 'asset-risk-summary' || assetSummary.defaultSymbol !== 'SOX') throw new Error('asset summary contract/default mismatch');
  for (const symbol of ['SOX', ...required]) if (!assetSummary.bySymbol?.[symbol]) throw new Error(`asset summary missing ${symbol}`);
  if (!assetSummary.bySymbol?.SNDK?.warnings?.length) throw new Error('SNDK short-history warning missing');
  if (!assetSummary.bySymbol?.DRAM?.warnings?.length) throw new Error('DRAM short-history warning missing');
  if (!assetSummary.bySymbol?.['005930.KS']?.current?.relativeStrengthBasis) throw new Error('Korea currency/relative strength basis missing');
  const soxx = assetSummary.bySymbol?.SOXX;
  if (soxx?.officialBenchmark?.name !== 'NYSE Semiconductor Index') throw new Error('SOXX official benchmark metadata missing or incorrectly labeled');
  if (soxx?.analysisBenchmark?.symbol !== 'SOX') throw new Error('SOXX analysis benchmark reference missing');
  const soxq = assetSummary.bySymbol?.SOXQ;
  if (soxq?.officialBenchmark?.name !== 'PHLX Semiconductor Sector Index' || soxq?.officialBenchmark?.symbol !== 'SOX') throw new Error('SOXQ official SOX benchmark metadata missing');
  if (soxq?.analysisBenchmark?.symbol !== 'SOX') throw new Error('SOXQ analysis benchmark missing');
  if (!soxq?.economicValidation?.status) throw new Error('SOXQ economic validation status missing');
  if (!soxq?.dataQuality?.level || !Array.isArray(soxq?.dataQuality?.providerAttempts)) throw new Error('SOXQ data quality/provider attempts missing');
  if (!soxx?.economicValidation?.status) throw new Error('SOXX economic validation status missing');
  if (!Number.isFinite(Number(soxx?.economicValidation?.validationScore))) throw new Error('SOXX validation score missing');
  if (!soxx?.dataQuality?.level || !Array.isArray(soxx?.dataQuality?.providerAttempts)) throw new Error('SOXX data quality/provider attempts missing');
  if (soxx.economicValidation.status === 'weak' && soxx.confidence?.level === 'high') throw new Error('weak SOXX validation must not have high confidence');
  if (soxx?.current?.date > soxx?.current?.sectorContextAsOf && soxx.current.sectorContextStatus === 'fresh') throw new Error('SOXX stale context mislabeled as fresh');
  if (!app.includes('Official benchmark') || !app.includes('Economic validation') || !app.includes('Best validation rule') || !app.includes('Data quality') || !app.includes('Price provider policy') || !app.includes('not calibrated to SOX probability')) throw new Error('score semantics UI labels missing');
  if (!assetDaily.rowsBySymbol?.MU?.length || !assetDaily.rowsBySymbol?.SOX?.length) throw new Error('asset daily rows missing');
  if (assetBacktest.primaryLabelMode !== 'volAdjusted' || !assetBacktest.assets?.MU?.periods?.full?.volAdjusted?.scoreBuckets || !assetBacktest.crossAssetValidation?.assetCount) throw new Error('asset vol-adjusted backtest diagnostics missing');
  if (dataStatus.contract !== 'risk-score-data-status' || dataStatus.availableAssetCount < required.length || !dataStatus.providerPolicy?.priceProviderPriority?.length) throw new Error('data status coverage/provider policy mismatch');
  console.log('PASS static server smoke served multi-asset route, nested assets, JSON contracts, universe, warnings, and backtest payloads');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
