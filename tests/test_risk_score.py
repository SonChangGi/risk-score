from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from risk_score.model import (
    DEFAULT_THRESHOLDS,
    add_rule_signals,
    compute_backtest_stats,
    compute_confirmation,
    compute_forward_labels,
    compute_indicators,
    compute_oh_score,
    compute_rf_score,
    decluster_signals,
    export_json_outputs,
    run_pipeline,
)


def synthetic_rows(n: int = 90):
    sox = []
    vix = []
    for i in range(n):
        # 상승 후 하락/반등을 섞어 OH/RF와 forward labels가 모두 생기게 한다.
        if i < 45:
            close = 100 + i * 1.8
        elif i < 60:
            close = 181 - (i - 45) * 2.8
        elif i < 75:
            close = 139 + (i - 60) * 1.5
        else:
            close = 161 - (i - 75) * 1.2
        sox.append({'date': f'2024-01-{(i % 28) + 1:02d}' if i < 28 else f'2024-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}', 'value': close})
        vix.append({'date': sox[-1]['date'], 'value': 15 + (i % 7) * 0.9 + (4 if 48 <= i <= 66 else 0)})
    return sox, vix


class RiskScoreModelTests(unittest.TestCase):
    def setUp(self):
        sox, vix = synthetic_rows()
        self.rows = run_pipeline(sox, vix)

    def test_indicators_warm_up_after_windows(self):
        rows = compute_indicators([{'date': f'2024-01-{i + 1:02d}', 'close': 100 + i, 'vix_close': 16 + i * 0.1} for i in range(60)])
        self.assertIsNone(rows[18]['ma20'])
        self.assertIsNotNone(rows[19]['ma20'])
        self.assertIsNotNone(rows[20]['roc20'])
        self.assertIsNotNone(rows[20]['z20'])
        self.assertIsNotNone(rows[14]['rsi14'])

    def test_scores_are_in_range_and_top_is_max(self):
        scored = [row for row in self.rows if row.get('top_risk_score') is not None]
        self.assertTrue(scored)
        for row in scored:
            self.assertGreaterEqual(row['oh_score'], 0)
            self.assertLessEqual(row['oh_score'], 5)
            self.assertGreaterEqual(row['rf_score'], 0)
            self.assertLessEqual(row['rf_score'], 5)
            self.assertEqual(row['top_risk_score'], max(row['oh_score'], row['rf_score']))

    def test_forward_labels_use_future_horizon_only(self):
        base = [{'date': f'2024-01-{i + 1:02d}', 'close': 100 + i, 'vix_close': 16} for i in range(12)]
        labelled = compute_forward_labels(base, horizon=5)
        self.assertAlmostEqual(labelled[0]['fwd_min_5'], 1 / 100)
        self.assertAlmostEqual(labelled[0]['fwd_max_5'], 5 / 100)
        self.assertAlmostEqual(labelled[0]['fwd_ret_5'], 5 / 100)
        for row in labelled[-5:]:
            self.assertIsNone(row['fwd_min_5'])
            self.assertIsNone(row['fwd_max_5'])
            self.assertIsNone(row['fwd_ret_5'])

    def test_declustering_uses_five_day_cooldown(self):
        rows = [{'date': str(i), 'signal': True} for i in range(12)]
        clustered = decluster_signals(rows, 'signal', cooldown=5)
        event_indices = [i for i, row in enumerate(clustered) if row['signal_event']]
        self.assertEqual(event_indices, [0, 6])

    def test_backtest_contains_required_periods_and_primary_event_mode(self):
        stats = compute_backtest_stats(self.rows)
        self.assertEqual(stats['primaryMode'], 'event')
        for period in ['full', 'recent_3y', 'recent_1y', 'ytd', 'ex_2026']:
            self.assertIn(period, stats['periods'])
        full = stats['periods']['full']
        self.assertIn('baseRates', full)
        self.assertIn('setup_ge_4', full['ruleStats'])
        self.assertIn('event', full['ruleStats']['setup_ge_4'])
        self.assertTrue(stats['thresholdSensitivity'])
        self.assertTrue(all(item['reportOnly'] for item in stats['thresholdSensitivity']))

    def test_threshold_constants_match_prompt_defaults(self):
        self.assertEqual(DEFAULT_THRESHOLDS['z20_overheat'], 1.5)
        self.assertEqual(DEFAULT_THRESHOLDS['rsi5_overheat'], 70)
        self.assertEqual(DEFAULT_THRESHOLDS['roc20_overheat'], 0.10)
        self.assertEqual(DEFAULT_THRESHOLDS['gap20_overheat'], 0.04)
        self.assertEqual(DEFAULT_THRESHOLDS['cooldown_days'], 5)

    def test_json_export_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = export_json_outputs(self.rows, tmp)
            for path in paths.values():
                self.assertTrue(Path(path).is_file())
            summary = json.loads(Path(paths['summary']).read_text())
            self.assertEqual(summary['schemaVersion'], 1)
            self.assertEqual(summary['contract'], 'quant-research-summary')
            self.assertEqual(summary['projectId'], 'risk-score')
            entity = summary['primaryEntities'][0]
            for key in ['latestClose', 'oneDayReturn', 'ohScore', 'rfScore', 'topRiskScore', 'confirmedTopRisk', 'vixClose']:
                self.assertIn(key, entity['metrics'])
            self.assertTrue(summary['riskScore']['modelPolicy']['defaultThresholdsFixed'])
            self.assertTrue(summary['riskScore']['modelPolicy']['noYtdTuning'])


if __name__ == '__main__':
    unittest.main()
