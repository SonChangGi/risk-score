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
  const [rootHtml, nestedHtml, app, css, summary] = await Promise.all([
    fetch(`${base}/`).then((r) => r.text()),
    fetch(`${base}${prefix}`).then((r) => r.text()),
    fetch(`${base}${prefix}assets/app.js`).then((r) => r.text()),
    fetch(`${base}${prefix}assets/styles.css`).then((r) => r.text()),
    fetch(`${base}${prefix}data/risk-score/risk_score_summary.json`).then((r) => r.json()),
  ]);
  if (!rootHtml.includes('SOX Top Risk Score')) throw new Error('root index missing title');
  if (!nestedHtml.includes('Back to Quant Dashboard')) throw new Error('nested route missing back link');
  if (!app.includes("DATA_BASE = 'data/risk-score/'")) throw new Error('relative data path missing');
  if (!css.includes('.metric-grid') || !css.includes('@media (max-width: 760px)')) throw new Error('responsive CSS missing');
  if (summary.contract !== 'quant-research-summary' || summary.projectId !== 'risk-score') throw new Error('summary contract mismatch');
  if (!summary.primaryEntities?.[0]?.metrics?.topRiskScore && summary.primaryEntities?.[0]?.metrics?.topRiskScore !== 0) throw new Error('top risk metric missing');
  console.log('PASS static server smoke served root, /quant-dashboard/risk-score/, nested assets, and nested JSON');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
