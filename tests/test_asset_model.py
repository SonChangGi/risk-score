from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import risk_score.asset_model as asset_model_module
from risk_score.asset_model import (
    ASSET_THRESHOLDS,
    add_asset_rule_signals,
    confidence_for_rows,
    economic_validation_from_periods,
    export_asset_json_outputs,
    fetch_or_load_prices,
    fmp_symbol_for_asset,
    generate_asset_payloads,
    load_universe_config,
    run_asset_pipeline,
)
from risk_score.model import run_pipeline


def dated_rows(n: int, start: date = date(2024, 1, 2)):
    rows = []
    for i in range(n):
        rows.append((start + timedelta(days=i)).isoformat())
    return rows


def sox_vix_rows(n: int = 120):
    sox = []
    vix = []
    for i, day in enumerate(dated_rows(n)):
        close = 100 + i * 0.8 if i < 55 else 144 - (i - 55) * 0.45 + (i % 7) * 0.4
        sox.append({'date': day, 'value': close})
        vix.append({'date': day, 'value': 15 + (i % 8) * 0.4 + (3 if i > 80 else 0)})
    return sox, vix


def price_rows(n: int = 120, start_price: float = 40, step: float = 0.6):
    rows = []
    for i, day in enumerate(dated_rows(n)):
        close = start_price + i * step + (i % 9) * 0.2
        rows.append({'date': day, 'close': close, 'adj_close': close, 'open': close * 0.99, 'high': close * 1.01, 'low': close * 0.98, 'volume': 1_000_000 + i})
    return rows


def mini_config():
    return {
        'schemaVersion': 1,
        'context': {},
        'assets': [
            {'symbol': 'SOX', 'providerSymbol': 'NASDAQSOX', 'name': 'SOX', 'type': 'Sector', 'group': 'SOX', 'currency': 'USD', 'source': 'fred', 'benchmark': 'self'},
            {'symbol': 'MU', 'providerSymbol': 'MU', 'name': 'Micron', 'type': 'US Stock', 'group': 'US Stocks', 'currency': 'USD', 'source': 'yahoo', 'benchmark': 'SOX'},
            {'symbol': '005930.KS', 'providerSymbol': '005930.KS', 'name': 'Samsung', 'type': 'Korea Stock', 'group': 'Korea Stocks', 'currency': 'KRW', 'source': 'yahoo', 'benchmark': 'SOX_USD_IF_FX_ELSE_KOSPI'},
            {'symbol': 'DRAM', 'providerSymbol': 'DRAM', 'name': 'Roundhill Memory ETF', 'type': 'ETF', 'group': 'ETFs', 'currency': 'USD', 'source': 'yahoo', 'benchmark': 'SOX', 'historyWarning': 'Trading history is short; backtest confidence is limited.'},
        ],
    }


class AssetModelTests(unittest.TestCase):
    def test_config_universe_contains_required_assets_and_warnings(self):
        config = load_universe_config()
        by_symbol = {asset['symbol']: asset for asset in config['assets']}
        for symbol in ('MU', 'INTC', 'MRVL', 'WDC', 'SNDK', 'STX', '005930.KS', '000660.KS', 'SOXX', 'SOXQ', 'SMH', 'XSD', 'PSI', 'DRAM'):
            self.assertIn(symbol, by_symbol)
        self.assertIn('historyWarning', by_symbol['SNDK'])
        self.assertIn('historyWarning', by_symbol['DRAM'])
        self.assertEqual(by_symbol['SOXX']['officialBenchmark']['name'], 'NYSE Semiconductor Index')
        self.assertEqual(by_symbol['SOXX']['analysisBenchmark']['symbol'], 'SOX')
        self.assertIn('analysis reference', by_symbol['SOXX']['analysisBenchmark']['note'])
        self.assertEqual(by_symbol['SOXQ']['officialBenchmark']['name'], 'PHLX Semiconductor Sector Index')
        self.assertEqual(by_symbol['SOXQ']['officialBenchmark']['symbol'], 'SOX')
        self.assertIn('track', by_symbol['SOXQ']['officialBenchmark']['note'].lower())

    def test_asset_pipeline_uses_vol_adjusted_scores_and_labels_without_future_tail(self):
        sox, vix = sox_vix_rows()
        sector = run_pipeline(sox, vix)
        asset = mini_config()['assets'][1]
        rows = run_asset_pipeline(asset, price_rows(), sector)
        scored = [row for row in rows if row.get('top_risk_score') is not None]
        self.assertTrue(scored)
        for row in scored:
            self.assertGreaterEqual(row['oh_score'], 0)
            self.assertLessEqual(row['oh_score'], 5)
            self.assertGreaterEqual(row['rf_score'], 0)
            self.assertLessEqual(row['rf_score'], 5)
            self.assertEqual(row['top_risk_score'], max(row['oh_score'], row['rf_score']))
        self.assertTrue(all(row['fwd_min_5'] is None for row in rows[-5:]))
        self.assertTrue(any(row.get('roc20z') is not None for row in rows))
        self.assertTrue(any(row.get('rel_z20') is not None for row in rows))
        self.assertEqual(ASSET_THRESHOLDS['roc20z_overheat'], 1.25)

    def test_korea_uses_usdkrw_conversion_or_kospi_fallback(self):
        sox, vix = sox_vix_rows()
        sector = run_pipeline(sox, vix)
        asset = mini_config()['assets'][2]
        kr_prices = price_rows(start_price=70000, step=100)
        fx = [{'date': row['date'], 'close': 1400, 'adj_close': 1400} for row in kr_prices]
        rows = run_asset_pipeline(asset, kr_prices, sector, usdkrw_rows=fx)
        latest = rows[-1]
        self.assertEqual(latest['score_currency'], 'USD')
        self.assertAlmostEqual(latest['close'], latest['raw_close'] / 1400)
        self.assertEqual(latest['benchmark_symbol'], 'SOX')
        kospi = [{'date': row['date'], 'close': 2500 + i, 'adj_close': 2500 + i} for i, row in enumerate(kr_prices)]
        fallback = run_asset_pipeline(asset, kr_prices, sector, kospi_rows=kospi, usdkrw_rows=None)
        self.assertEqual(fallback[-1]['score_currency'], 'KRW')
        self.assertEqual(fallback[-1]['benchmark_symbol'], 'KOSPI')
        self.assertIn('USDKRW unavailable', fallback[-1]['currency_warning'])

    def test_asset_payloads_keep_sox_contract_and_add_required_outputs(self):
        sox, vix = sox_vix_rows()
        config = mini_config()
        payloads = generate_asset_payloads(
            sox,
            vix,
            config=config,
            sox_scored_rows=run_pipeline(sox, vix),
            price_rows_by_symbol={'MU': price_rows(), '005930.KS': price_rows(start_price=70000, step=80), 'DRAM': price_rows(80, 20, 0.2)},
            kospi_rows=[{'date': day, 'close': 2500 + i, 'adj_close': 2500 + i} for i, day in enumerate(dated_rows(120))],
            usdkrw_rows=[{'date': day, 'close': 1400, 'adj_close': 1400} for day in dated_rows(120)],
            fetch_missing=False,
        )
        self.assertIn('asset-risk-summary', payloads['summary']['contract'])
        self.assertIn('rowsBySymbol', payloads['daily'])
        self.assertIn('MU', payloads['backtest']['assets'])
        self.assertIn('volAdjusted', payloads['backtest']['assets']['MU']['periods']['full'])
        self.assertIn('crossAssetValidation', payloads['backtest'])
        self.assertIn('relative_weakness_sector_context', [rule['id'] for rule in payloads['backtest']['rules']])
        self.assertTrue(payloads['summary']['bySymbol']['SOX']['current']['topRiskScore'] is not None)
        self.assertEqual(payloads['summary']['bySymbol']['DRAM']['confidence']['level'], 'low')
        self.assertIn('dataQuality', payloads['summary']['bySymbol']['MU'])
        self.assertIn('providerPolicy', payloads['dataStatus'])

    def test_asset_json_export_writes_new_files(self):
        sox, vix = sox_vix_rows()
        config = {'schemaVersion': 1, 'context': {}, 'assets': mini_config()['assets'][:2]}
        with tempfile.TemporaryDirectory() as tmp:
            paths = export_asset_json_outputs(
                sox,
                vix,
                tmp,
                config=config,
                sox_scored_rows=run_pipeline(sox, vix),
                price_rows_by_symbol={'MU': price_rows()},
                fetch_missing=False,
            )
            for path in paths.values():
                self.assertTrue(Path(path).is_file())
            summary = json.loads(Path(paths['asset_summary']).read_text())
            self.assertEqual(summary['projectId'], 'risk-score')
            self.assertEqual(summary['defaultSymbol'], 'SOX')

    def test_context_lag_warns_and_degrades_asset_status(self):
        sox, vix = sox_vix_rows(120)
        config = {'schemaVersion': 1, 'context': {}, 'assets': mini_config()['assets'][:2]}
        payloads = generate_asset_payloads(
            sox,
            vix,
            config=config,
            sox_scored_rows=run_pipeline(sox, vix),
            price_rows_by_symbol={'MU': price_rows(124)},
            fetch_missing=False,
        )
        mu = payloads['summary']['bySymbol']['MU']
        current = mu['current']
        self.assertEqual(current['sectorContextStatus'], 'stale')
        self.assertGreater(current['sectorContextLagDays'], 0)
        self.assertEqual(mu['dataStatus']['status'], 'warning')
        self.assertTrue(any('Sector context is stale' in item for item in mu['warnings']))

    def test_weak_economic_validation_downgrades_confidence(self):
        fake_periods = {
            'full': {
                'volAdjusted': {
                    'baseRates': {'downsideHitRate': 0.1},
                    'ruleStats': {
                        rule: {'event': {'eventCount': 10, 'evaluatedCount': 10, 'downsideHitRate': 0.08, 'downsideHitRateLift': 0.8}}
                        for rule in ('asset_top_ge_4', 'asset_confirmed_risk', 'asset_actionable_signal', 'asset_top_ge_4_effective_context', 'asset_top_ge_4_soxq_proxy_context', 'asset_top_ge_4_sector_context', 'relative_weakness_sector_context')
                    },
                }
            },
            'ytd': {
                'volAdjusted': {
                    'baseRates': {'downsideHitRate': 0.1},
                    'ruleStats': {
                        rule: {'event': {'eventCount': 10, 'evaluatedCount': 10, 'downsideHitRate': 0.08, 'downsideHitRateLift': 0.8}}
                        for rule in ('asset_top_ge_4', 'asset_confirmed_risk', 'asset_actionable_signal', 'asset_top_ge_4_effective_context', 'asset_top_ge_4_soxq_proxy_context', 'asset_top_ge_4_sector_context', 'relative_weakness_sector_context')
                    },
                }
            }
        }
        validation = economic_validation_from_periods(fake_periods)
        self.assertEqual(validation['status'], 'weak')
        self.assertIn('validationScore', validation)
        self.assertIn('ytdDiagnostics', validation)
        self.assertTrue(validation['ytdDiagnostics']['warnings'])
        self.assertTrue(validation['weakRules'])
        asset = {'symbol': 'SOXX', 'type': 'ETF'}
        rows = [{'date': dated_rows(900)[i], 'downside_event_5d': False, 'vol_adj_downside_5d': False, 'signal_asset_confirmed_risk': i % 20 == 0} for i in range(900)]
        confidence = confidence_for_rows(rows, asset, validation)
        self.assertEqual(confidence['level'], 'low')
        self.assertIn('underperform', ' '.join(confidence['reasons']))

    def test_canonical_and_effective_context_rules_do_not_conflate(self):
        row = add_asset_rule_signals([{
            'oh_score': 4,
            'rf_score': 1,
            'top_risk_score': 4,
            'canonical_sector_context_active': False,
            'effective_sector_context_active': True,
            'sector_context_active': True,
            'sector_proxy_context_active': True,
            'relative_rollover': True,
            'rf_factors': {'relative_weakness': True},
        }])[0]
        self.assertFalse(row['signal_asset_top_ge_4_sector_context'])
        self.assertFalse(row['signal_relative_weakness_sector_context'])
        self.assertFalse(row['signal_sector_context_active'])
        self.assertTrue(row['signal_asset_top_ge_4_effective_context'])
        self.assertTrue(row['signal_asset_top_ge_4_soxq_proxy_context'])

    def test_asset_summary_exports_validation_and_benchmark_metadata(self):
        sox, vix = sox_vix_rows()
        config = mini_config()
        payloads = generate_asset_payloads(
            sox,
            vix,
            config=config,
            sox_scored_rows=run_pipeline(sox, vix),
            price_rows_by_symbol={'MU': price_rows(), '005930.KS': price_rows(start_price=70000, step=80), 'DRAM': price_rows(80, 20, 0.2)},
            kospi_rows=[{'date': day, 'close': 2500 + i, 'adj_close': 2500 + i} for i, day in enumerate(dated_rows(120))],
            usdkrw_rows=[{'date': day, 'close': 1400, 'adj_close': 1400} for day in dated_rows(120)],
            fetch_missing=False,
        )
        mu = payloads['summary']['bySymbol']['MU']
        self.assertIn('economicValidation', mu)
        self.assertIn('modelValidation', mu)
        self.assertIn('analysisBenchmark', mu)
        self.assertIn('scoreModel', mu['current'])
        self.assertIn('latestScoredDate', mu['current'])
        self.assertIn('validationScore', mu['economicValidation'])
        self.assertIn('dataQuality', mu)
        self.assertIn('providerAttempts', mu['dataQuality'])

    def test_soxq_proxy_context_is_exported_for_stale_sox_context(self):
        config = {
            'schemaVersion': 1,
            'context': {'sectorProxy': {'symbol': 'SOXQ', 'providerSymbol': 'SOXQ'}},
            'assets': [
                mini_config()['assets'][0],
                {**mini_config()['assets'][1], 'officialBenchmark': None},
                {
                    'symbol': 'SOXQ',
                    'providerSymbol': 'SOXQ',
                    'name': 'Invesco PHLX Semiconductor ETF',
                    'type': 'ETF',
                    'group': 'ETFs',
                    'currency': 'USD',
                    'source': 'yahoo',
                    'benchmark': 'SOX',
                    'analysisBenchmark': {'symbol': 'SOX', 'role': 'tracked_index_and_sector_reference'},
                    'officialBenchmark': {'symbol': 'SOX', 'name': 'PHLX Semiconductor Sector Index'},
                },
                {
                    'symbol': 'SOXX',
                    'providerSymbol': 'SOXX',
                    'name': 'iShares Semiconductor ETF',
                    'type': 'ETF',
                    'group': 'ETFs',
                    'currency': 'USD',
                    'source': 'yahoo',
                    'benchmark': 'SOX',
                    'analysisBenchmark': {'symbol': 'SOX', 'role': 'sector_reference'},
                    'officialBenchmark': {'name': 'NYSE Semiconductor Index'},
                },
            ],
        }
        sox, vix = sox_vix_rows(120)
        payloads = generate_asset_payloads(
            sox,
            vix,
            config=config,
            sox_scored_rows=run_pipeline(sox, vix),
            price_rows_by_symbol={'MU': price_rows(124), 'SOXQ': price_rows(124, start_price=50, step=0.7), 'SOXX': price_rows(124, start_price=200, step=0.55)},
            fetch_missing=False,
        )
        mu_current = payloads['summary']['bySymbol']['MU']['current']
        soxq_current = payloads['summary']['bySymbol']['SOXQ']['current']
        soxx_current = payloads['summary']['bySymbol']['SOXX']['current']
        self.assertEqual(mu_current['sectorContextStatus'], 'proxy')
        self.assertEqual(mu_current['effectiveSectorContextSource'], 'SOXQ')
        self.assertEqual(mu_current['sectorProxy']['symbol'], 'SOXQ')
        self.assertTrue(soxq_current['benchmarkProxyRisk']['enabled'])
        self.assertTrue(soxx_current['benchmarkProxyRisk']['enabled'])
        self.assertEqual(soxx_current['benchmarkProxyRisk']['overlayBasis'], 'analysis_reference')
        self.assertEqual(soxx_current['benchmarkProxyRisk']['analysisReferenceSymbol'], 'SOX')
        self.assertIn('asset_top_ge_4_soxq_proxy_context', [rule['id'] for rule in payloads['backtest']['rules']])
        self.assertIn('sectorProxy', payloads['dataStatus']['sourceStatus']['context'])

    def test_provider_symbol_policy_supports_fmp_only_for_usd_assets(self):
        self.assertEqual(fmp_symbol_for_asset({'symbol': 'MU', 'providerSymbol': 'MU', 'currency': 'USD'}), 'MU')
        self.assertEqual(fmp_symbol_for_asset({'symbol': 'SOXX', 'providerSymbol': 'SOXX', 'currency': 'USD'}), 'SOXX')
        self.assertEqual(fmp_symbol_for_asset({'symbol': 'SOXQ', 'providerSymbol': 'SOXQ', 'currency': 'USD'}), 'SOXQ')
        self.assertIsNone(fmp_symbol_for_asset({'symbol': '005930.KS', 'providerSymbol': '005930.KS', 'currency': 'KRW'}))

    def test_price_loader_falls_back_to_fmp_when_yahoo_fails(self):
        asset = {'symbol': 'MU', 'providerSymbol': 'MU', 'currency': 'USD'}
        original_yahoo = asset_model_module.fetch_yahoo_daily_prices
        original_fmp = asset_model_module.fetch_fmp_daily_prices
        original_key = os.environ.get(asset_model_module.FMP_API_KEY_ENV)
        try:
            os.environ[asset_model_module.FMP_API_KEY_ENV] = 'test-key'

            def fail_yahoo(symbol):
                raise RuntimeError(f'{symbol} unavailable')

            def fake_fmp(symbol):
                self.assertEqual(symbol, 'MU')
                return price_rows(40)

            asset_model_module.fetch_yahoo_daily_prices = fail_yahoo
            asset_model_module.fetch_fmp_daily_prices = fake_fmp
            rows, status = fetch_or_load_prices(asset, [])
            self.assertTrue(rows)
            self.assertEqual(status['source'], 'fmp_historical_eod')
            self.assertTrue(status['fallbackUsed'])
            self.assertEqual(status['providerAttempts'][0]['status'], 'error')
            self.assertEqual(status['providerAttempts'][-1]['provider'], 'fmp_historical_eod')
        finally:
            asset_model_module.fetch_yahoo_daily_prices = original_yahoo
            asset_model_module.fetch_fmp_daily_prices = original_fmp
            if original_key is None:
                os.environ.pop(asset_model_module.FMP_API_KEY_ENV, None)
            else:
                os.environ[asset_model_module.FMP_API_KEY_ENV] = original_key


if __name__ == '__main__':
    unittest.main()
