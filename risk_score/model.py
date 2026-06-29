from __future__ import annotations

import csv
import json
import math
import statistics
from copy import deepcopy
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

Record = dict[str, Any]

FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd=1990-01-01'

DEFAULT_THRESHOLDS: dict[str, float | int] = {
    'z20_overheat': 1.5,
    'rsi5_overheat': 70,
    'roc20_overheat': 0.10,
    'gap20_overheat': 0.04,
    'high20_close_ratio': 0.995,
    'drawdown50_damage_ratio': 0.95,
    'rebound20_ratio': 1.05,
    'ma_resistance_band': 0.03,
    'ma_resistance_cap': 1.02,
    'weak_roc20': 0.03,
    'vix_floor': 16,
    'large_down_day': -0.02,
    'strong_vix_delta': 1.0,
    'rf_down_day': -0.01,
    'downside_event': -0.05,
    'cooldown_days': 5,
}

RULES: list[tuple[str, str, str]] = [
    ('oh_ge_4', 'OH >= 4', 'OH model high-risk setup'),
    ('oh_eq_5', 'OH = 5', 'OH model extreme overheat'),
    ('rf_ge_4', 'RF >= 4', 'RF model high-risk rebound failure'),
    ('rf_eq_5', 'RF = 5', 'RF model strong lower-high warning'),
    ('setup_ge_4', 'OH >= 4 OR RF >= 4', 'Either top-risk setup is active'),
    ('red_zone', 'OH = 5 OR RF = 5', 'Either model is in red-zone'),
    ('confirmed_top_risk', 'confirmed_top_risk', 'Setup confirmed by price/VIX rollover'),
    ('rsi14_gt_70', 'RSI14 > 70', 'Single-indicator overbought baseline'),
    ('rsi5_gt_70', 'RSI5 > 70', 'Short-term RSI baseline'),
    ('z20_gt_1_5', 'z20 > 1.5', '20D z-score baseline'),
    ('gap20_gt_4', 'gap20 > 4%', '20D moving-average gap baseline'),
    ('roc20_gt_10', 'ROC20 > 10%', '20D momentum baseline'),
    ('rollover_after_setup', 'C < MA5 after OH/RF setup', 'Price rollover after recent setup'),
    ('vix_confirmation_simple', 'VIX > VIX_MA5 and delta VIX > 0', 'VIX confirmation baseline'),
]

OH_FACTORS = [
    ('z20_gt_1_5', 'z20 > 1.5', 'z20', '20D 평균 대비 통계적 과열'),
    ('rsi5_gt_70', 'RSI5 > 70', 'rsi5', '단기 과매수'),
    ('roc20_gt_10', 'ROC20 > 10%', 'roc20', '1개월 강한 momentum'),
    ('gap20_gt_4', 'gap20 > 4%', 'gap20', '20D 추세선 대비 유의미한 이격'),
    ('near_high20', 'C >= 99.5% of High20', 'close', '최근 고점권에서 rally 진행'),
]

RF_FACTORS = [
    ('prior_damage', 'C < MA50 OR C <= 95% High50', 'drawdown50', '중기 추세 훼손 또는 50D 고점 대비 5% 이상 하락'),
    ('rebound_from_low', 'C >= 105% Low20', 'rebound20', '20D 저점 대비 5% 이상 반등'),
    ('ma_resistance', 'Near MA20/MA50 resistance', 'gap20', 'MA20 또는 MA50 근처 반등 후 안착 미확인'),
    ('weak_momentum', 'ROC20 <= 3% OR MA20_slope5 < 0', 'roc20', '20D momentum 약화 또는 MA20 하락'),
    ('vix_not_low', 'VIX >= 16 OR VIX > VIX_MA20', 'vix_close', '변동성 regime이 아직 안정되지 않음'),
]


def fetch_fred_series(series_id: str) -> list[Record]:
    """Fetch a FRED CSV series into date/value records with blank observations as None.

    FRED sometimes leaves large all-history responses open long enough to trip local
    read timeouts. Yearly slices use the same official CSV endpoint but are more
    deterministic and keep the update job API-key free.
    """
    start_year = 2004 if series_id == 'NASDAQSOX' else 1990
    current_year = datetime.now(UTC).year
    by_date: dict[str, float | None] = {}
    for year in range(start_year, current_year + 1):
        start_day = '2004-09-01' if series_id == 'NASDAQSOX' and year == 2004 else f'{year}-01-01'
        url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start_day}&coed={year}-12-31'
        text = fetch_text_with_retries(url, series_id)
        for row in csv.DictReader(text.splitlines()):
            raw_date = row.get('observation_date') or row.get('DATE') or ''
            if not raw_date:
                continue
            raw_value = row.get(series_id) or row.get('value') or ''
            by_date[raw_date] = parse_float(raw_value)
    return [{'date': day, 'value': by_date[day]} for day in sorted(by_date)]


def fetch_text_with_retries(url: str, series_id: str) -> str:
    headers = {'User-Agent': 'Mozilla/5.0'}
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=25) as response:
                return response.read().decode('utf-8')
        except (TimeoutError, URLError, OSError) as exc:
            last_error = exc
            if attempt == 2:
                raise RuntimeError(f'Failed to fetch FRED series {series_id} slice {url} after 3 attempts: {exc}') from exc
    raise RuntimeError(f'Failed to fetch FRED series {series_id}: {last_error}')

def join_sox_vix(sox_rows: list[Record], vix_rows: list[Record]) -> list[Record]:
    vix_by_date = {row['date']: row.get('value') for row in vix_rows if row.get('date')}
    joined: list[Record] = []
    for row in sox_rows:
        close = parse_float(row.get('value'))
        # SOX holidays arrive as blank FRED rows. Keep trading days only.
        if close is None:
            continue
        joined.append({'date': row['date'], 'close': close, 'vix_close': parse_float(vix_by_date.get(row['date']))})
    joined.sort(key=lambda item: item['date'])
    return joined


def compute_indicators(df: list[Record]) -> list[Record]:
    rows = deepcopy(df)
    closes = [parse_float(row.get('close')) for row in rows]
    vix = [parse_float(row.get('vix_close')) for row in rows]

    ma5 = rolling_mean(closes, 5)
    ma20 = rolling_mean(closes, 20)
    ma50 = rolling_mean(closes, 50)
    std20 = rolling_std(closes, 20)
    high20 = rolling_max(closes, 20)
    high50 = rolling_max(closes, 50)
    low20 = rolling_min(closes, 20)
    vix_ma5 = rolling_mean(vix, 5)
    vix_ma20 = rolling_mean(vix, 20)
    rsi5 = wilder_rsi(closes, 5)
    rsi14 = wilder_rsi(closes, 14)

    for i, row in enumerate(rows):
        close = closes[i]
        prev_close = closes[i - 1] if i > 0 else None
        row['ma5'] = ma5[i]
        row['ma20'] = ma20[i]
        row['ma50'] = ma50[i]
        row['std20'] = std20[i]
        row['high20'] = high20[i]
        row['high50'] = high50[i]
        row['low20'] = low20[i]
        row['vix_ma5'] = vix_ma5[i]
        row['vix_ma20'] = vix_ma20[i]
        row['ret_1'] = safe_ratio(close, prev_close, subtract_one=True)
        row['roc10'] = safe_ratio(close, closes[i - 10] if i >= 10 else None, subtract_one=True)
        row['roc20'] = safe_ratio(close, closes[i - 20] if i >= 20 else None, subtract_one=True)
        row['gap20'] = safe_ratio(close, ma20[i], subtract_one=True)
        row['drawdown50'] = safe_ratio(close, high50[i], subtract_one=True)
        row['rebound20'] = safe_ratio(close, low20[i], subtract_one=True)
        row['ma20_slope5'] = safe_ratio(ma20[i], ma20[i - 5] if i >= 5 else None, subtract_one=True)
        row['z20'] = None if close is None or ma20[i] is None or std20[i] in (None, 0) else (close - ma20[i]) / std20[i]
        row['rsi5'] = rsi5[i]
        row['rsi14'] = rsi14[i]
        row['vix_delta_1'] = None if vix[i] is None or i == 0 or vix[i - 1] is None else vix[i] - vix[i - 1]
    return rows


def compute_oh_score(df: list[Record]) -> list[Record]:
    rows = deepcopy(df)
    for row in rows:
        required = [row.get('z20'), row.get('rsi5'), row.get('roc20'), row.get('gap20'), row.get('high20'), row.get('close')]
        if any(parse_float(value) is None for value in required):
            row['oh_score'] = None
            row['oh_factors'] = {}
            continue
        factors = {
            'z20_gt_1_5': row['z20'] > DEFAULT_THRESHOLDS['z20_overheat'],
            'rsi5_gt_70': row['rsi5'] > DEFAULT_THRESHOLDS['rsi5_overheat'],
            'roc20_gt_10': row['roc20'] > DEFAULT_THRESHOLDS['roc20_overheat'],
            'gap20_gt_4': row['gap20'] > DEFAULT_THRESHOLDS['gap20_overheat'],
            'near_high20': row['close'] >= DEFAULT_THRESHOLDS['high20_close_ratio'] * row['high20'],
        }
        row['oh_factors'] = factors
        row['oh_score'] = int(sum(1 for value in factors.values() if value))
    return rows


def compute_rf_score(df: list[Record]) -> list[Record]:
    rows = deepcopy(df)
    for row in rows:
        required = [
            row.get('close'), row.get('ma20'), row.get('ma50'), row.get('high50'), row.get('low20'),
            row.get('roc20'), row.get('ma20_slope5'), row.get('vix_close'), row.get('vix_ma20')
        ]
        if any(parse_float(value) is None for value in required):
            row['rf_score'] = None
            row['rf_factors'] = {}
            continue
        close = row['close']
        ma20 = row['ma20']
        ma50 = row['ma50']
        factors = {
            'prior_damage': close < ma50 or close <= DEFAULT_THRESHOLDS['drawdown50_damage_ratio'] * row['high50'],
            'rebound_from_low': close >= DEFAULT_THRESHOLDS['rebound20_ratio'] * row['low20'],
            'ma_resistance': (
                min(abs(close / ma20 - 1), abs(close / ma50 - 1)) <= DEFAULT_THRESHOLDS['ma_resistance_band']
                and close <= DEFAULT_THRESHOLDS['ma_resistance_cap'] * max(ma20, ma50)
            ),
            'weak_momentum': row['roc20'] <= DEFAULT_THRESHOLDS['weak_roc20'] or row['ma20_slope5'] < 0,
            'vix_not_low': row['vix_close'] >= DEFAULT_THRESHOLDS['vix_floor'] or row['vix_close'] > row['vix_ma20'],
        }
        row['rf_factors'] = factors
        row['rf_score'] = int(sum(1 for value in factors.values() if value))
    return rows


def compute_confirmation(df: list[Record]) -> list[Record]:
    rows = deepcopy(df)
    setup_active_history: list[bool] = []
    for i, row in enumerate(rows):
        oh = parse_float(row.get('oh_score'))
        rf = parse_float(row.get('rf_score'))
        setup_active = oh is not None and rf is not None and (oh >= 4 or rf >= 4)
        setup_active_history.append(setup_active)
        setup_recent = any(setup_active_history[max(0, i - 2): i + 1])
        close = parse_float(row.get('close'))
        ma5 = parse_float(row.get('ma5'))
        ma20 = parse_float(row.get('ma20'))
        ret_1 = parse_float(row.get('ret_1'))
        vix = parse_float(row.get('vix_close'))
        vix_ma5 = parse_float(row.get('vix_ma5'))
        vix_delta = parse_float(row.get('vix_delta_1'))

        price_rollover = close is not None and ma5 is not None and close < ma5
        large_down_day = ret_1 is not None and ret_1 <= DEFAULT_THRESHOLDS['large_down_day']
        vix_confirmation = vix is not None and vix_ma5 is not None and vix_delta is not None and vix > vix_ma5 and vix_delta > 0
        strong_vix_confirmation = vix is not None and vix_ma5 is not None and vix_delta is not None and vix > vix_ma5 and vix_delta >= DEFAULT_THRESHOLDS['strong_vix_delta']
        confirmed_general = setup_recent and (price_rollover or large_down_day or vix_confirmation or strong_vix_confirmation)
        confirmed_rf = rf is not None and rf >= 4 and ((close is not None and ma20 is not None and close < ma20) or (ret_1 is not None and ret_1 <= DEFAULT_THRESHOLDS['rf_down_day']))
        confirmed = bool(confirmed_general or confirmed_rf)

        top = max(oh, rf) if oh is not None and rf is not None else None
        row.update({
            'setup_active': setup_active,
            'setup_recent': setup_recent,
            'price_rollover': price_rollover,
            'large_down_day': large_down_day,
            'vix_confirmation': vix_confirmation,
            'strong_vix_confirmation': strong_vix_confirmation,
            'confirmed_general': bool(confirmed_general),
            'confirmed_rf': bool(confirmed_rf),
            'confirmed_top_risk': confirmed,
            'top_risk_score': int(top) if top is not None else None,
            'regime': classify_regime(oh, rf),
            'action_level': action_level(oh, rf, confirmed),
            'action_label': action_label(oh, rf, confirmed),
            'action_text': action_text(oh, rf, confirmed),
        })
    return rows


def compute_forward_labels(df: list[Record], horizon: int = 5) -> list[Record]:
    rows = deepcopy(df)
    closes = [parse_float(row.get('close')) for row in rows]
    for i, row in enumerate(rows):
        if i + horizon >= len(rows) or closes[i] in (None, 0):
            row['fwd_min_5'] = None
            row['fwd_max_5'] = None
            row['fwd_ret_5'] = None
            row['downside_event_5d'] = None
            row['strict_top_5d'] = None
            continue
        future = [value for value in closes[i + 1:i + horizon + 1] if value is not None]
        if len(future) != horizon:
            row['fwd_min_5'] = None
            row['fwd_max_5'] = None
            row['fwd_ret_5'] = None
            row['downside_event_5d'] = None
            row['strict_top_5d'] = None
            continue
        fwd_min = min(future) / closes[i] - 1
        fwd_max = max(future) / closes[i] - 1
        fwd_ret = future[-1] / closes[i] - 1
        row['fwd_min_5'] = fwd_min
        row['fwd_max_5'] = fwd_max
        row['fwd_ret_5'] = fwd_ret
        row['downside_event_5d'] = fwd_min <= DEFAULT_THRESHOLDS['downside_event']
        row['strict_top_5d'] = fwd_max <= 0 and fwd_min <= DEFAULT_THRESHOLDS['downside_event']
    return rows


def add_rule_signals(df: list[Record]) -> list[Record]:
    rows = deepcopy(df)
    for row in rows:
        oh = parse_float(row.get('oh_score'))
        rf = parse_float(row.get('rf_score'))
        row['signal_oh_ge_4'] = oh is not None and oh >= 4
        row['signal_oh_eq_5'] = oh == 5
        row['signal_rf_ge_4'] = rf is not None and rf >= 4
        row['signal_rf_eq_5'] = rf == 5
        row['signal_setup_ge_4'] = row['signal_oh_ge_4'] or row['signal_rf_ge_4']
        row['signal_red_zone'] = row['signal_oh_eq_5'] or row['signal_rf_eq_5']
        row['signal_confirmed_top_risk'] = bool(row.get('confirmed_top_risk'))
        row['signal_rsi14_gt_70'] = parse_float(row.get('rsi14')) is not None and row['rsi14'] > 70
        row['signal_rsi5_gt_70'] = parse_float(row.get('rsi5')) is not None and row['rsi5'] > 70
        row['signal_z20_gt_1_5'] = parse_float(row.get('z20')) is not None and row['z20'] > DEFAULT_THRESHOLDS['z20_overheat']
        row['signal_gap20_gt_4'] = parse_float(row.get('gap20')) is not None and row['gap20'] > DEFAULT_THRESHOLDS['gap20_overheat']
        row['signal_roc20_gt_10'] = parse_float(row.get('roc20')) is not None and row['roc20'] > DEFAULT_THRESHOLDS['roc20_overheat']
        row['signal_rollover_after_setup'] = bool(row.get('setup_recent')) and bool(row.get('price_rollover'))
        row['signal_vix_confirmation_simple'] = bool(row.get('vix_confirmation'))
    return rows


def decluster_signals(df: list[Record], signal_col: str, cooldown: int = 5) -> list[Record]:
    rows = deepcopy(df)
    last_event_index = -10_000
    event_col = f'{signal_col}_event'
    for i, row in enumerate(rows):
        is_signal = bool(row.get(signal_col))
        is_event = is_signal and (i - last_event_index > cooldown)
        row[event_col] = is_event
        if is_event:
            last_event_index = i
    return rows


def compute_backtest_stats(df: list[Record]) -> dict[str, Any]:
    rows = add_rule_signals(df)
    latest = max((parse_iso_date(row['date']) for row in rows if row.get('date')), default=None)
    periods = build_periods(latest)
    result: dict[str, Any] = {
        'primaryMode': 'event',
        'cooldownDays': DEFAULT_THRESHOLDS['cooldown_days'],
        'horizonDays': 5,
        'rules': [{'id': rule_id, 'label': label, 'description': description} for rule_id, label, description in RULES],
        'periods': {},
        'thresholdSensitivity': threshold_sensitivity(rows),
        'notes': [
            'Event-level statistics are the primary interpretation because adjacent daily signals are clustered with a 5-trading-day cooldown.',
            'Threshold sensitivity is diagnostic only; default thresholds remain fixed round-number constants from the methodology.',
        ],
    }
    for period_id, period in periods.items():
        period_rows = [row for row in rows if in_period(row, period)]
        base_rows = [row for row in period_rows if parse_float(row.get('fwd_min_5')) is not None]
        base_downside = mean_bool(row.get('downside_event_5d') for row in base_rows)
        base_strict = mean_bool(row.get('strict_top_5d') for row in base_rows)
        rule_stats: dict[str, Any] = {}
        for rule_id, label, _description in RULES:
            signal_col = f'signal_{rule_id}'
            clustered = decluster_signals(period_rows, signal_col, int(DEFAULT_THRESHOLDS['cooldown_days']))
            daily_signal_rows = [row for row in period_rows if row.get(signal_col) and parse_float(row.get('fwd_min_5')) is not None]
            event_signal_rows = [row for row in clustered if row.get(f'{signal_col}_event') and parse_float(row.get('fwd_min_5')) is not None]
            rule_stats[rule_id] = {
                'label': label,
                'daily': summarize_signal_rows(daily_signal_rows, base_downside, base_strict, len([row for row in period_rows if row.get(signal_col)]), len(event_signal_rows)),
                'event': summarize_signal_rows(event_signal_rows, base_downside, base_strict, len([row for row in period_rows if row.get(signal_col)]), len(event_signal_rows)),
            }
        result['periods'][period_id] = {
            'label': period['label'],
            'start': period.get('start').isoformat() if period.get('start') else None,
            'end': period.get('end').isoformat() if period.get('end') else None,
            'sampleCount': len(base_rows),
            'baseRates': {
                'downsideHitRate': base_downside,
                'strictTopHitRate': base_strict,
            },
            'ruleStats': rule_stats,
        }
    return result


def export_json_outputs(rows: list[Record], output_dir: str | Path = 'data/risk-score') -> dict[str, Path]:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows = add_rule_signals(rows)
    backtest = compute_backtest_stats(rows)
    latest = latest_scored_row(rows)
    if latest is None:
        raise ValueError('No scored rows available for summary export')
    generated_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    daily_payload = {
        'schemaVersion': 1,
        'contract': 'risk-score-daily',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'dataAsOf': latest['date'],
        'rows': [json_ready(row) for row in rows],
    }
    recent_signals = signal_history(rows, limit=80)
    summary = build_summary_payload(rows, latest, backtest, recent_signals, generated_at)
    paths = {
        'daily': out / 'risk_score_daily.json',
        'summary': out / 'risk_score_summary.json',
        'backtest': out / 'risk_score_backtest.json',
    }
    write_json(paths['daily'], daily_payload)
    write_json(paths['summary'], summary)
    write_json(paths['backtest'], backtest)
    return paths


def run_pipeline(sox_rows: list[Record], vix_rows: list[Record]) -> list[Record]:
    rows = join_sox_vix(sox_rows, vix_rows)
    rows = compute_indicators(rows)
    rows = compute_oh_score(rows)
    rows = compute_rf_score(rows)
    rows = compute_confirmation(rows)
    rows = compute_forward_labels(rows)
    rows = add_rule_signals(rows)
    return rows


def build_summary_payload(rows: list[Record], latest: Record, backtest: dict[str, Any], recent_signals: list[Record], generated_at: str) -> dict[str, Any]:
    factor_breakdown = build_factor_breakdown(latest)
    risk_score = {
        'current': json_ready({
            'date': latest['date'],
            'close': latest.get('close'),
            'oneDayReturn': latest.get('ret_1'),
            'vixClose': latest.get('vix_close'),
            'ohScore': latest.get('oh_score'),
            'rfScore': latest.get('rf_score'),
            'topRiskScore': latest.get('top_risk_score'),
            'regime': latest.get('regime'),
            'confirmation': bool(latest.get('confirmed_top_risk')),
            'actionLevel': latest.get('action_level'),
            'actionLabel': latest.get('action_label'),
            'actionText': latest.get('action_text'),
        }),
        'factorBreakdown': factor_breakdown,
        'recentSignals': [json_ready(row) for row in recent_signals],
        'thresholds': DEFAULT_THRESHOLDS,
        'modelPolicy': {
            'defaultThresholdsFixed': True,
            'noYtdTuning': True,
            'thresholdSensitivityIsDiagnosticOnly': True,
            'primaryBacktestMode': 'event',
        },
        'sourceStatus': {
            'sox': {'source': 'FRED NASDAQSOX', 'status': 'ok', 'url': FRED_CSV_URL.format(series_id='NASDAQSOX')},
            'vix': {'source': 'FRED VIXCLS', 'status': 'ok', 'url': FRED_CSV_URL.format(series_id='VIXCLS')},
        },
        'optionalSources': [
            {'name': 'Nasdaq SOX overview', 'status': 'source-note-only', 'url': 'https://indexes.nasdaqomx.com/Index/Overview/SOX', 'note': 'SOX description/constituents reference; not part of v1 score.'},
            {'name': 'iShares SOXX', 'status': 'optional-benchmark', 'url': 'https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf', 'note': 'SOXX may be used as benchmark later; core model uses SOX index.'},
            {'name': 'AAII Sentiment Survey', 'status': 'manual-or-adapter-future', 'url': 'https://www.aaii.com/sentimentsurvey/sent_results', 'note': 'Weekly broad sentiment prior; not in v1 main score.'},
            {'name': 'CNN Fear & Greed', 'status': 'manual-csv-or-adapter-future', 'url': 'https://edition.cnn.com/markets/fear-and-greed', 'note': 'No stable official historical API assumed; optional panel only.'},
            {'name': 'Fundamental revisions/valuation', 'status': 'future-adapter', 'url': '', 'note': 'Future 1-3 month cycle-risk panel, separate from 1-5D top model.'},
        ],
    }
    highlight_rules = ['setup_ge_4', 'red_zone', 'confirmed_top_risk', 'oh_ge_4', 'rf_ge_4']
    full_period = backtest.get('periods', {}).get('full', {}).get('ruleStats', {})
    risk_score['backtestHighlights'] = [
        {'ruleId': rule, **json_ready(full_period.get(rule, {}).get('event', {}))}
        for rule in highlight_rules if full_period.get(rule)
    ]
    return {
        'schemaVersion': 1,
        'contract': 'quant-research-summary',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'dataAsOf': latest['date'],
        'status': latest.get('action_label'),
        'coverage': {
            'entityCount': 1,
            'observationCount': len(rows),
            'startDate': rows[0]['date'] if rows else None,
            'endDate': latest['date'],
            'requiredSources': ['FRED NASDAQSOX', 'FRED VIXCLS'],
        },
        'primaryEntities': [
            {
                'id': 'sox-top-risk',
                'symbol': 'NASDAQSOX',
                'name': 'PHLX Semiconductor Sector Index Top-Risk Overlay',
                'label': 'SOX Top Risk Score',
                'status': latest.get('action_label'),
                'signals': signal_labels(latest),
                'metrics': json_ready({
                    'latestClose': latest.get('close'),
                    'oneDayReturn': latest.get('ret_1'),
                    'vixClose': latest.get('vix_close'),
                    'ohScore': latest.get('oh_score'),
                    'rfScore': latest.get('rf_score'),
                    'topRiskScore': latest.get('top_risk_score'),
                    'confirmedTopRisk': bool(latest.get('confirmed_top_risk')),
                    'regime': latest.get('regime'),
                    'actionLevel': latest.get('action_level'),
                }),
            }
        ],
        'riskScore': risk_score,
        'limitations': [
            '뉴스 기반 모델이 아니며 가격/추세/변동성 기반 risk overlay입니다.',
            'Leading score는 조기 경보라 너무 일찍 켜질 수 있으며, confirmation signal을 별도로 확인해야 합니다.',
            'FRED/Nasdaq/CBOE 원천 데이터 지연 또는 휴장일 공백이 있을 수 있습니다.',
            '백테스트 hit rate는 과거 분포 설명이며 투자 조언이나 미래 성과 보장이 아닙니다.',
            'AAII, CNN Fear & Greed, fundamental data는 v1 main score에 포함하지 않습니다.',
        ],
        'automation': {
            'cadence': 'daily-after-market-close',
            'script': 'python scripts/update_risk_score_data.py',
            'publicPath': '/quant-dashboard/risk-score/',
        },
    }


def build_factor_breakdown(row: Record) -> list[Record]:
    factors: list[Record] = []
    for key, threshold, value_key, interpretation in OH_FACTORS:
        factors.append({
            'factor': key,
            'model': 'OH',
            'currentValue': row.get(value_key),
            'threshold': threshold,
            'signal': bool(row.get('oh_factors', {}).get(key)),
            'interpretation': interpretation,
        })
    for key, threshold, value_key, interpretation in RF_FACTORS:
        factors.append({
            'factor': key,
            'model': 'RF',
            'currentValue': row.get(value_key),
            'threshold': threshold,
            'signal': bool(row.get('rf_factors', {}).get(key)),
            'interpretation': interpretation,
        })
    confirmations = [
        ('price_rollover', 'C < MA5', row.get('close'), bool(row.get('price_rollover')), 'Confirmation', '가격이 MA5 아래로 내려오며 rally rollover 확인'),
        ('large_down_day', 'ret_1 <= -2%', row.get('ret_1'), bool(row.get('large_down_day')), 'Confirmation', '큰 하락일로 단기 매도 압력 확인'),
        ('vix_confirmation', 'VIX > VIX_MA5 and ΔVIX > 0', row.get('vix_close'), bool(row.get('vix_confirmation')), 'Confirmation', 'VIX 상승 전환으로 변동성 확인'),
        ('strong_vix_confirmation', 'VIX > VIX_MA5 and ΔVIX >= 1', row.get('vix_delta_1'), bool(row.get('strong_vix_confirmation')), 'Confirmation', '강한 VIX 상승 확인'),
    ]
    for key, threshold, value, signal, model, interpretation in confirmations:
        factors.append({'factor': key, 'model': model, 'currentValue': value, 'threshold': threshold, 'signal': signal, 'interpretation': interpretation})
    return [json_ready(item) for item in factors]


def signal_history(rows: list[Record], limit: int = 80) -> list[Record]:
    items = [row for row in rows if row.get('setup_active') or row.get('confirmed_top_risk') or row.get('signal_red_zone')]
    selected = items[-limit:]
    return [{
        'date': row.get('date'),
        'close': row.get('close'),
        'ohScore': row.get('oh_score'),
        'rfScore': row.get('rf_score'),
        'topRiskScore': row.get('top_risk_score'),
        'confirmation': row.get('confirmed_top_risk'),
        'fwdMin5': row.get('fwd_min_5'),
        'fwdMax5': row.get('fwd_max_5'),
        'fwdRet5': row.get('fwd_ret_5'),
        'downsideHit': row.get('downside_event_5d'),
        'strictTopHit': row.get('strict_top_5d'),
        'regime': row.get('regime'),
        'actionLabel': row.get('action_label'),
    } for row in reversed(selected)]


def threshold_sensitivity(rows: list[Record]) -> list[Record]:
    specs = [
        ('z20', 'z20 > threshold', [1.0, 1.5, 2.0]),
        ('rsi5', 'RSI5 > threshold', [65, 70, 75]),
        ('gap20', 'gap20 > threshold', [0.03, 0.04, 0.05]),
        ('roc20', 'ROC20 > threshold', [0.08, 0.10, 0.12]),
    ]
    base_rows = [row for row in rows if parse_float(row.get('fwd_min_5')) is not None]
    base_downside = mean_bool(row.get('downside_event_5d') for row in base_rows)
    output: list[Record] = []
    for field, label, thresholds in specs:
        for threshold in thresholds:
            signal_rows = [row for row in rows if parse_float(row.get(field)) is not None and row[field] > threshold and parse_float(row.get('fwd_min_5')) is not None]
            output.append(json_ready({
                'field': field,
                'rule': label,
                'threshold': threshold,
                'signalCount': len(signal_rows),
                'downsideHitRate': mean_bool(row.get('downside_event_5d') for row in signal_rows),
                'downsideLiftRatio': ratio_or_none(mean_bool(row.get('downside_event_5d') for row in signal_rows), base_downside),
                'reportOnly': True,
            }))
    return output


def summarize_signal_rows(rows: list[Record], base_downside: float | None, base_strict: float | None, signal_count: int, event_count: int) -> dict[str, Any]:
    downside_rate = mean_bool(row.get('downside_event_5d') for row in rows)
    strict_rate = mean_bool(row.get('strict_top_5d') for row in rows)
    fwd_ret = [row['fwd_ret_5'] for row in rows if parse_float(row.get('fwd_ret_5')) is not None]
    fwd_min = [row['fwd_min_5'] for row in rows if parse_float(row.get('fwd_min_5')) is not None]
    fwd_max = [row['fwd_max_5'] for row in rows if parse_float(row.get('fwd_max_5')) is not None]
    return json_ready({
        'signalCount': signal_count,
        'eventCount': event_count,
        'evaluatedCount': len(rows),
        'downsideHitRate': downside_rate,
        'strictTopHitRate': strict_rate,
        'downsideHitRateLift': ratio_or_none(downside_rate, base_downside),
        'strictTopHitRateLift': ratio_or_none(strict_rate, base_strict),
        'downsideHitRateDelta': None if downside_rate is None or base_downside is None else downside_rate - base_downside,
        'avgFwdRet5': mean_float(fwd_ret),
        'medianFwdRet5': median_float(fwd_ret),
        'avgFwdMin5': mean_float(fwd_min),
        'avgFwdMax5': mean_float(fwd_max),
        'maxAdverseContinuation': max(fwd_max) if fwd_max else None,
    })


def build_periods(latest: date | None) -> dict[str, dict[str, Any]]:
    if latest is None:
        return {'full': {'label': 'Full period', 'start': None, 'end': None}}
    return {
        'full': {'label': 'Full period', 'start': None, 'end': latest},
        'recent_3y': {'label': 'Recent 3Y', 'start': shift_year(latest, -3), 'end': latest},
        'recent_1y': {'label': 'Recent 1Y', 'start': shift_year(latest, -1), 'end': latest},
        'ytd': {'label': f'{latest.year} YTD', 'start': date(latest.year, 1, 1), 'end': latest},
        'ex_2026': {'label': 'Pre-2026 history', 'start': None, 'end': date(2025, 12, 31)},
    }


def in_period(row: Record, period: dict[str, Any]) -> bool:
    row_date = parse_iso_date(row.get('date'))
    if row_date is None:
        return False
    start = period.get('start')
    end = period.get('end')
    if start and row_date < start:
        return False
    if end and row_date > end:
        return False
    return True


def latest_scored_row(rows: list[Record]) -> Record | None:
    for row in reversed(rows):
        if parse_float(row.get('top_risk_score')) is not None:
            return row
    return None


def classify_regime(oh: float | None, rf: float | None) -> str:
    if oh is None or rf is None:
        return 'Insufficient data'
    if oh >= 3 and rf >= 3:
        return 'Mixed'
    if oh > rf and oh >= 3:
        return 'Overheated'
    if rf > oh and rf >= 3:
        return 'Rebound Failure'
    if oh >= 4:
        return 'Overheated'
    if rf >= 4:
        return 'Rebound Failure'
    return 'Normal'


def action_level(oh: float | None, rf: float | None, confirmed: bool) -> str:
    if oh is None or rf is None:
        return 'insufficient'
    if confirmed:
        return 'confirmed-red'
    if oh == 5 or rf == 5:
        return 'red-zone'
    if oh >= 4 or rf >= 4:
        return 'high-risk'
    if oh == 3 or rf == 3:
        return 'watch'
    return 'normal'


def action_label(oh: float | None, rf: float | None, confirmed: bool) -> str:
    return {
        'insufficient': 'Insufficient data',
        'normal': 'Normal',
        'watch': 'Watch',
        'high-risk': 'High Risk',
        'red-zone': 'Red Zone',
        'confirmed-red': 'Confirmed Red',
    }[action_level(oh, rf, confirmed)]


def action_text(oh: float | None, rf: float | None, confirmed: bool) -> str:
    return {
        'insufficient': 'rolling window가 충분해질 때까지 score를 계산하지 않습니다.',
        'normal': '일반 포지션 유지 관점의 risk overlay 상태입니다.',
        'watch': '신규 추격매수 억제와 trailing stop 점검을 고려할 수 있는 관찰 구간입니다.',
        'high-risk': 'overweight 일부 축소 또는 hedge 준비 여부를 점검할 수 있는 high-risk overlay 구간입니다.',
        'red-zone': 'hedge ratio 상향, 감익 검토, 신규 추격매수 제한을 점검할 수 있는 red-zone overlay입니다.',
        'confirmed-red': 'leading setup이 가격/변동성 확인 신호와 결합되어 적극적인 beta 축소 또는 protective hedge 검토가 필요한 상태로 분류됩니다.',
    }[action_level(oh, rf, confirmed)]


def signal_labels(row: Record) -> list[str]:
    labels = []
    if row.get('oh_score') is not None:
        labels.append(f"OH {row['oh_score']}/5")
    if row.get('rf_score') is not None:
        labels.append(f"RF {row['rf_score']}/5")
    if row.get('confirmed_top_risk'):
        labels.append('Confirmed top-risk')
    labels.append(str(row.get('regime', 'Normal')))
    return labels


def rolling_window(values: list[float | None], window: int, i: int) -> list[float] | None:
    if i + 1 < window:
        return None
    chunk = values[i - window + 1:i + 1]
    if any(value is None for value in chunk):
        return None
    return [float(value) for value in chunk]


def rolling_mean(values: list[float | None], window: int) -> list[float | None]:
    output = []
    for i in range(len(values)):
        chunk = rolling_window(values, window, i)
        output.append(None if chunk is None else sum(chunk) / window)
    return output


def rolling_std(values: list[float | None], window: int) -> list[float | None]:
    output = []
    for i in range(len(values)):
        chunk = rolling_window(values, window, i)
        output.append(None if chunk is None or len(chunk) < 2 else statistics.stdev(chunk))
    return output


def rolling_max(values: list[float | None], window: int) -> list[float | None]:
    output = []
    for i in range(len(values)):
        chunk = rolling_window(values, window, i)
        output.append(None if chunk is None else max(chunk))
    return output


def rolling_min(values: list[float | None], window: int) -> list[float | None]:
    output = []
    for i in range(len(values)):
        chunk = rolling_window(values, window, i)
        output.append(None if chunk is None else min(chunk))
    return output


def wilder_rsi(values: list[float | None], period: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    gains: list[float] = []
    losses: list[float] = []
    avg_gain = None
    avg_loss = None
    for i in range(1, len(values)):
        if values[i] is None or values[i - 1] is None:
            gains.append(0)
            losses.append(0)
            continue
        change = values[i] - values[i - 1]
        gain = max(change, 0)
        loss = max(-change, 0)
        if i <= period:
            gains.append(gain)
            losses.append(loss)
            if i == period:
                avg_gain = sum(gains[-period:]) / period
                avg_loss = sum(losses[-period:]) / period
                output[i] = rsi_from_avgs(avg_gain, avg_loss)
        else:
            assert avg_gain is not None and avg_loss is not None
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
            output[i] = rsi_from_avgs(avg_gain, avg_loss)
    return output


def rsi_from_avgs(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def safe_ratio(numerator: float | None, denominator: float | None, subtract_one: bool = False) -> float | None:
    numerator = parse_float(numerator)
    denominator = parse_float(denominator)
    if numerator is None or denominator in (None, 0):
        return None
    ratio = numerator / denominator
    return ratio - 1 if subtract_one else ratio


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def finite_or_none(value: Any) -> float | None:
    return parse_float(value)


def parse_iso_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def shift_year(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:
        return day.replace(month=2, day=28, year=day.year + years)


def mean_bool(values: Any) -> float | None:
    vals = [bool(value) for value in values if value is not None]
    if not vals:
        return None
    return sum(1 for value in vals if value) / len(vals)


def mean_float(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def median_float(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def ratio_or_none(value: float | None, base: float | None) -> float | None:
    if value is None or base in (None, 0):
        return None
    return value / base


def json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_ready(item) for item in value]
    if isinstance(value, tuple):
        return [json_ready(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(json_ready(payload), ensure_ascii=False, indent=2, sort_keys=False) + '\n', encoding='utf-8')
