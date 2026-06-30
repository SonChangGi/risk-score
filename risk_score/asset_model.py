from __future__ import annotations

import csv
import json
import math
import time
import urllib.parse
from copy import deepcopy
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from risk_score.model import (
    DEFAULT_THRESHOLDS,
    build_periods,
    classify_regime,
    compute_confirmation,
    compute_forward_labels,
    compute_indicators,
    compute_oh_score,
    compute_rf_score,
    json_ready,
    latest_scored_row,
    mean_bool,
    mean_float,
    median_float,
    parse_float,
    parse_iso_date,
    ratio_or_none,
    rolling_mean,
    rolling_min,
    rolling_max,
    rolling_std,
    run_pipeline,
    safe_ratio,
    write_json,
)

Record = dict[str, Any]

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UNIVERSE_PATH = ROOT / 'config' / 'asset_universe.json'
YAHOO_PERIOD1 = int(datetime(2004, 1, 1, tzinfo=UTC).timestamp())
USER_AGENT = 'Mozilla/5.0 (compatible; risk-score/0.2; +https://github.com/SonChangGi/risk-score)'

ASSET_THRESHOLDS: dict[str, float] = {
    'z20_overheat': 1.5,
    'rsi5_overheat': 70.0,
    'roc20z_overheat': 1.25,
    'high20_close_ratio': 0.995,
    'relz20_overheat': 1.0,
    'dd50z_damage': -1.0,
    'rebound20z': 0.75,
    'ma_resistance_band': 0.03,
    'ma_resistance_cap': 1.02,
    'weak_roc20z': 0.5,
    'vol_downside_sigma': -1.5,
    'vol_strict_up_sigma': 0.5,
    'asset_large_down_abs': 0.02,
    'asset_large_down_vol_mult': 0.75,
}

ASSET_RULES: list[tuple[str, str, str]] = [
    ('asset_oh_ge_4', 'Asset OH >= 4', 'Asset volatility-adjusted overheated setup'),
    ('asset_oh_eq_5', 'Asset OH = 5', 'Asset OH red-zone setup'),
    ('asset_rf_ge_4', 'Asset RF >= 4', 'Asset rebound-failure setup'),
    ('asset_rf_eq_5', 'Asset RF = 5', 'Asset RF red-zone setup'),
    ('asset_top_ge_4', 'Asset Top Risk >= 4', 'Either asset top-risk model is high'),
    ('asset_top_eq_5', 'Asset Top Risk = 5', 'Either asset top-risk model is red-zone'),
    ('asset_confirmed_risk', 'asset_confirmed_risk', 'Asset setup confirmed by price/relative rollover'),
    ('asset_actionable_signal', 'asset_actionable_signal', 'Asset confirmation plus active sector context'),
    ('asset_top_ge_4_sector_context', 'Asset Top >= 4 AND sector context', 'Leading setup aligned with SOX/VIX/VXN context'),
    ('rsi14_gt_70', 'RSI14 > 70', 'Single-factor overbought baseline'),
    ('rsi5_gt_70', 'RSI5 > 70', 'Single-factor short RSI baseline'),
    ('z20_gt_1_5', 'z20 > 1.5', 'Single-factor 20D z-score baseline'),
    ('relz20_gt_1_0', 'RelZ20 > 1.0', 'Relative-strength crowding baseline'),
    ('roc20z_gt_1_25', 'ROC20Z > 1.25', 'Volatility-adjusted momentum baseline'),
    ('price_below_ma5', 'P < MA5', 'Short-term price rollover baseline'),
]

PRIMARY_ECONOMIC_RULES = (
    'asset_top_ge_4',
    'asset_confirmed_risk',
    'asset_actionable_signal',
    'asset_top_ge_4_sector_context',
)

ECONOMIC_VALIDATION_MIN_EVENTS = 5
ECONOMIC_VALIDATION_PASS_LIFT = 1.05

ASSET_FACTORS = [
    ('z20_gt_1_5', 'z20 > 1.5', 'z20', 'OH', '20D 평균 대비 통계적 과열'),
    ('rsi5_gt_70', 'RSI5 > 70', 'rsi5', 'OH', '단기 과매수'),
    ('roc20z_gt_1_25', 'ROC20Z > 1.25', 'roc20z', 'OH', '20D 상승률을 해당 자산 변동성으로 표준화한 momentum 과열'),
    ('near_high20', 'P >= 99.5% of High20', 'close', 'OH', '최근 고점권에서 rally 진행'),
    ('relz20_gt_1_0', 'RelZ20 > 1.0', 'rel_z20', 'OH', 'benchmark 대비 relative strength 과열'),
    ('prior_damage', 'P < MA50 OR DD50Z < -1.0', 'dd50z', 'RF', '중기 추세 훼손 또는 변동성 조정 drawdown'),
    ('rebound_from_low', 'Rebound20Z > 0.75', 'rebound20z', 'RF', '20D 저점 대비 반등이 자산 변동성 대비 충분함'),
    ('ma_resistance', 'Near MA20/MA50 resistance', 'gap20', 'RF', 'MA20 또는 MA50 근처 반등 후 명확한 안착 미확인'),
    ('weak_momentum', 'ROC20Z < 0.5 OR MA20 slope < 0', 'roc20z', 'RF', '변동성 대비 20D momentum 약화 또는 MA20 하락'),
    ('relative_weakness', 'RS < RS MA20 OR RS MA20 slope < 0', 'relative_strength', 'RF', 'benchmark 대비 상대강도 하락'),
]


def load_universe_config(path: str | Path = DEFAULT_UNIVERSE_PATH) -> Record:
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    symbols = [asset['symbol'] for asset in config.get('assets', [])]
    if len(symbols) != len(set(symbols)):
        raise ValueError('asset universe has duplicate symbols')
    required = {'SOX', 'MU', 'INTC', 'MRVL', 'WDC', 'SNDK', 'STX', '005930.KS', '000660.KS', 'SOXX', 'SMH', 'XSD', 'PSI', 'DRAM'}
    missing = required - set(symbols)
    if missing:
        raise ValueError(f'asset universe missing required symbols: {sorted(missing)}')
    return config


def fetch_yahoo_daily_prices(symbol: str, *, period1: int = YAHOO_PERIOD1, period2: int | None = None) -> list[Record]:
    if period2 is None:
        period2 = int(time.time()) + 86400
    query = urllib.parse.urlencode({
        'period1': str(period1),
        'period2': str(period2),
        'interval': '1d',
        'events': 'history',
        'includeAdjustedClose': 'true',
    })
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe="")}?{query}'
    payload = http_json(url)
    chart = payload.get('chart') or {}
    result = (chart.get('result') or [None])[0]
    if not result:
        error = (chart.get('error') or {}).get('description') or 'empty chart result'
        raise ValueError(f'{symbol}: {error}')
    timestamps = result.get('timestamp') or []
    indicators = result.get('indicators') or {}
    quote = (indicators.get('quote') or [{}])[0]
    adj = (indicators.get('adjclose') or [{}])[0]
    rows: list[Record] = []
    for index, ts in enumerate(timestamps):
        close = list_get(quote.get('close'), index)
        adj_close = list_get(adj.get('adjclose'), index)
        adjusted = parse_float(adj_close if adj_close is not None else close)
        if adjusted is None:
            continue
        rows.append({
            'date': datetime.fromtimestamp(int(ts), tz=UTC).date().isoformat(),
            'open': parse_float(list_get(quote.get('open'), index)),
            'high': parse_float(list_get(quote.get('high'), index)),
            'low': parse_float(list_get(quote.get('low'), index)),
            'close': parse_float(close),
            'adj_close': adjusted,
            'volume': parse_float(list_get(quote.get('volume'), index)),
        })
    if not rows:
        raise ValueError(f'{symbol}: no usable adjusted close rows')
    return dedupe_by_date(rows)


def http_json(url: str) -> Any:
    req = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json,text/plain,*/*'})
    with urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode('utf-8', 'replace'))


def read_manual_prices(path: Path) -> list[Record]:
    rows: list[Record] = []
    with path.open(newline='', encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            day = row.get('date') or row.get('Date')
            if not day:
                continue
            close = parse_float(row.get('adj_close') or row.get('Adj Close') or row.get('close') or row.get('Close'))
            if close is None:
                continue
            rows.append({
                'date': str(day)[:10],
                'open': parse_float(row.get('open') or row.get('Open')),
                'high': parse_float(row.get('high') or row.get('High')),
                'low': parse_float(row.get('low') or row.get('Low')),
                'close': parse_float(row.get('close') or row.get('Close')) or close,
                'adj_close': close,
                'volume': parse_float(row.get('volume') or row.get('Volume')),
                'source': 'manual_csv',
            })
    if not rows:
        raise ValueError(f'manual price file has no usable rows: {path}')
    return dedupe_by_date(rows)


def fetch_or_load_prices(asset: Record, manual_dirs: list[Path]) -> tuple[list[Record], Record]:
    symbol = asset['symbol']
    for directory in manual_dirs:
        path = directory / f'{symbol}.csv'
        if path.exists():
            return read_manual_prices(path), {'status': 'ok', 'source': 'manual_csv', 'path': str(path)}
    provider_symbol = asset.get('providerSymbol') or symbol
    rows = fetch_yahoo_daily_prices(provider_symbol)
    return rows, {'status': 'ok', 'source': 'yahoo_chart', 'providerSymbol': provider_symbol, 'rowCount': len(rows)}


def generate_asset_payloads(
    sox_rows: list[Record],
    vix_rows: list[Record],
    *,
    config: Record | None = None,
    sox_scored_rows: list[Record] | None = None,
    vxn_rows: list[Record] | None = None,
    price_rows_by_symbol: dict[str, list[Record]] | None = None,
    kospi_rows: list[Record] | None = None,
    usdkrw_rows: list[Record] | None = None,
    fetch_missing: bool = True,
    manual_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    config = config or load_universe_config()
    manual_dirs = manual_dirs or [ROOT / 'data' / 'risk-score' / 'manual_prices', ROOT / 'public' / 'data' / 'risk-score' / 'manual_prices']
    price_rows_by_symbol = dict(price_rows_by_symbol or {})
    source_status: Record = {
        'context': {
            'sox': {'status': 'ok', 'source': 'FRED NASDAQSOX', 'rowCount': len(sox_rows)},
            'vix': {'status': 'ok', 'source': 'FRED VIXCLS', 'rowCount': len(vix_rows)},
            'vxn': {'status': 'ok' if vxn_rows else 'unavailable', 'source': 'FRED VXNCLS', 'rowCount': len(vxn_rows or [])},
            'kospi': {'status': 'pending' if kospi_rows is None else 'ok', 'source': 'Yahoo ^KS11', 'rowCount': len(kospi_rows or [])},
            'usdkrw': {'status': 'pending' if usdkrw_rows is None else 'ok', 'source': 'Yahoo KRW=X', 'rowCount': len(usdkrw_rows or [])},
        },
        'assets': {},
    }
    if sox_scored_rows is None:
        sox_scored_rows = run_pipeline(sox_rows, vix_rows)
    sector_rows = add_sector_context(sox_scored_rows, vxn_rows)

    # Optional Korea context is fetched once by the static update script layer, never by browser code.
    if fetch_missing:
        if kospi_rows is None:
            try:
                kospi_rows = fetch_yahoo_daily_prices(config.get('context', {}).get('kospi', {}).get('providerSymbol', '^KS11'))
                source_status['context']['kospi'] = {'status': 'ok', 'source': 'yahoo_chart', 'providerSymbol': '^KS11', 'rowCount': len(kospi_rows)}
            except Exception as exc:  # noqa: BLE001 - optional context should degrade gracefully.
                source_status['context']['kospi'] = {'status': 'unavailable', 'source': 'yahoo_chart', 'providerSymbol': '^KS11', 'error': f'{type(exc).__name__}: {exc}'}
                kospi_rows = None
        if usdkrw_rows is None:
            try:
                usdkrw_rows = fetch_yahoo_daily_prices(config.get('context', {}).get('usdkrw', {}).get('providerSymbol', 'KRW=X'))
                source_status['context']['usdkrw'] = {'status': 'ok', 'source': 'yahoo_chart', 'providerSymbol': 'KRW=X', 'rowCount': len(usdkrw_rows)}
            except Exception as exc:  # noqa: BLE001
                source_status['context']['usdkrw'] = {'status': 'unavailable', 'source': 'yahoo_chart', 'providerSymbol': 'KRW=X', 'error': f'{type(exc).__name__}: {exc}'}
                usdkrw_rows = None

    rows_by_symbol: dict[str, list[Record]] = {}
    errors: dict[str, str] = {}
    for asset in config.get('assets', []):
        symbol = asset['symbol']
        if symbol == 'SOX':
            rows_by_symbol[symbol] = adapt_sox_rows_for_asset(sector_rows, asset)
            source_status['assets'][symbol] = {'status': 'ok', 'source': 'FRED NASDAQSOX', 'rowCount': len(rows_by_symbol[symbol])}
            continue
        try:
            if symbol not in price_rows_by_symbol:
                if not fetch_missing:
                    raise ValueError(f'no fixture price rows supplied for {symbol}')
                price_rows_by_symbol[symbol], status = fetch_or_load_prices(asset, manual_dirs)
                source_status['assets'][symbol] = status
            rows_by_symbol[symbol] = run_asset_pipeline(asset, price_rows_by_symbol[symbol], sector_rows, kospi_rows=kospi_rows, usdkrw_rows=usdkrw_rows)
            source_status['assets'].setdefault(symbol, {'status': 'ok', 'source': 'fixture', 'rowCount': len(price_rows_by_symbol[symbol])})
            source_status['assets'][symbol]['computedRowCount'] = len(rows_by_symbol[symbol])
        except Exception as exc:  # noqa: BLE001 - export data_status must preserve failures.
            errors[symbol] = f'{type(exc).__name__}: {exc}'
            source_status['assets'][symbol] = {'status': 'error', 'source': asset.get('source'), 'error': errors[symbol]}
            rows_by_symbol[symbol] = []

    generated_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    backtest = build_asset_backtest_payload(config, rows_by_symbol, generated_at)
    summary = build_asset_summary_payload(config, rows_by_symbol, backtest, source_status, errors, generated_at)
    daily = build_asset_daily_payload(config, rows_by_symbol, generated_at, summary)
    universe = build_universe_payload(config, generated_at)
    data_status = build_data_status_payload(config, source_status, summary, generated_at)
    return {
        'universe': universe,
        'daily': daily,
        'summary': summary,
        'backtest': backtest,
        'dataStatus': data_status,
        'rowsBySymbol': rows_by_symbol,
        'sourceStatus': source_status,
    }


def export_asset_json_outputs(
    sox_rows: list[Record],
    vix_rows: list[Record],
    output_dir: str | Path = 'data/risk-score',
    **kwargs: Any,
) -> dict[str, Path]:
    payloads = generate_asset_payloads(sox_rows, vix_rows, **kwargs)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = {
        'asset_universe': out / 'asset_universe.json',
        'asset_daily': out / 'asset_risk_daily.json',
        'asset_summary': out / 'asset_risk_summary.json',
        'asset_backtest': out / 'asset_risk_backtest.json',
        'data_status': out / 'data_status.json',
    }
    write_json(paths['asset_universe'], payloads['universe'])
    write_json(paths['asset_daily'], payloads['daily'])
    write_json(paths['asset_summary'], payloads['summary'])
    write_json(paths['asset_backtest'], payloads['backtest'])
    write_json(paths['data_status'], payloads['dataStatus'])
    return paths


def add_sector_context(sox_scored_rows: list[Record], vxn_rows: list[Record] | None = None) -> list[Record]:
    rows = deepcopy(sox_scored_rows)
    dates = [row['date'] for row in rows]
    vxn_values = align_series_values(dates, fred_or_price_rows(vxn_rows or []), 'close')
    vxn_ma5 = rolling_mean(vxn_values, 5)
    for i, row in enumerate(rows):
        vix = parse_float(row.get('vix_close'))
        vix_ma5 = parse_float(row.get('vix_ma5'))
        vix_delta = parse_float(row.get('vix_delta_1'))
        vix_rising = vix is not None and vix_ma5 is not None and vix_delta is not None and vix > vix_ma5 and vix_delta > 0
        vxn = vxn_values[i]
        prev_vxn = vxn_values[i - 1] if i > 0 else None
        vxn_delta = None if vxn is None or prev_vxn is None else vxn - prev_vxn
        vxn_rising = vxn is not None and vxn_ma5[i] is not None and vxn_delta is not None and vxn > vxn_ma5[i] and vxn_delta > 0
        oh = parse_float(row.get('oh_score'))
        rf = parse_float(row.get('rf_score'))
        row['vix_rising'] = bool(vix_rising)
        row['vxn_close'] = vxn
        row['vxn_ma5'] = vxn_ma5[i]
        row['vxn_delta_1'] = vxn_delta
        row['vxn_rising'] = bool(vxn_rising) if vxn is not None else None
        row['sector_context_active'] = bool(
            (oh is not None and oh >= 4)
            or (rf is not None and rf >= 4)
            or row.get('confirmed_top_risk')
            or vix_rising
            or vxn_rising
        )
    return rows


def benchmark_metadata(asset: Record) -> Record:
    return {
        'analysisBenchmark': asset.get('analysisBenchmark') or {'symbol': asset.get('benchmark'), 'role': 'analysis_reference'},
        'officialBenchmark': asset.get('officialBenchmark'),
    }


def is_valid_sector_context(row: Record | None) -> bool:
    if not row:
        return False
    return (
        parse_float(row.get('top_risk_score')) is not None
        and parse_float(row.get('oh_score')) is not None
        and parse_float(row.get('rf_score')) is not None
        and parse_float(row.get('vix_close')) is not None
    )


def context_lag_days(asset_day: str | None, context_day: str | None) -> int | None:
    asset_date = parse_iso_date(asset_day)
    sector_date = parse_iso_date(context_day)
    if asset_date is None or sector_date is None:
        return None
    return max((asset_date - sector_date).days, 0)


def sector_context_status(asset_day: str | None, context: Record | None) -> str:
    if not is_valid_sector_context(context):
        return 'unavailable'
    return 'fresh' if context.get('date') == asset_day else 'stale'


def sector_context_warning(asset_day: str | None, context: Record | None, status: str) -> str | None:
    if status == 'fresh':
        return None
    if status == 'stale' and context and context.get('date'):
        return f"Sector context is stale: asset date {asset_day} uses SOX/VIX context as of {context.get('date')}."
    return f"Sector context is unavailable for asset date {asset_day}; SOX/VIX confirmation fields are not same-day comparable."


def adapt_sox_rows_for_asset(sector_rows: list[Record], asset: Record) -> list[Record]:
    rows = []
    meta = benchmark_metadata(asset)
    for row in sector_rows:
        item = dict(row)
        status = 'fresh' if is_valid_sector_context(row) else 'unscored'
        item.update({
            'symbol': asset['symbol'],
            'name': asset.get('name'),
            'type': asset.get('type'),
            'group': asset.get('group'),
            'currency': 'USD',
            'score_currency': 'USD',
            'score_model': 'sox_canonical',
            'benchmark_symbol': 'SOX',
            'benchmark_as_of': row.get('date') if row.get('close') is not None else None,
            'relative_strength': 1.0,
            'relative_strength_status': 'sector baseline',
            'relative_strength_basis': 'self',
            'asset_confirmed_risk': bool(row.get('confirmed_top_risk')),
            'asset_actionable_signal': bool(row.get('confirmed_top_risk')),
            'asset_setup_active': bool(row.get('setup_active')),
            'asset_setup_recent': bool(row.get('setup_recent')),
            'sector_context_as_of': row.get('date') if is_valid_sector_context(row) else None,
            'sector_context_lag_days': 0 if is_valid_sector_context(row) else None,
            'sector_context_status': status,
            'sector_context_warning': None if status == 'fresh' else 'SOX/VIX sector context is not scored for this date.',
            **meta,
            'currency_warning': None,
        })
        rows.append(item)
    return rows


def run_asset_pipeline(asset: Record, price_rows: list[Record], sector_rows: list[Record], *, kospi_rows: list[Record] | None = None, usdkrw_rows: list[Record] | None = None) -> list[Record]:
    prepared = prepare_asset_price_context(asset, price_rows, sector_rows, kospi_rows=kospi_rows, usdkrw_rows=usdkrw_rows)
    rows = compute_indicators(prepared)
    rows = add_asset_specific_indicators(rows)
    rows = compute_asset_oh_score(rows)
    rows = compute_asset_rf_score(rows)
    rows = compute_asset_confirmation(rows)
    rows = compute_forward_labels(rows)
    rows = compute_vol_adjusted_labels(rows)
    rows = add_asset_rule_signals(rows)
    return rows


def prepare_asset_price_context(asset: Record, price_rows: list[Record], sector_rows: list[Record], *, kospi_rows: list[Record] | None = None, usdkrw_rows: list[Record] | None = None) -> list[Record]:
    price_rows = dedupe_by_date(price_rows)
    dates = [row['date'] for row in price_rows]
    sector_by_date = align_records(dates, sector_rows)
    valid_sector_by_date = align_records(dates, [row for row in sector_rows if is_valid_sector_context(row)])
    sox_values = align_series_values(dates, sector_rows, 'close')
    sox_records_by_date = align_records(dates, [row for row in sector_rows if parse_float(row.get('close')) is not None])
    kospi_values = align_series_values(dates, fred_or_price_rows(kospi_rows or []), 'close')
    usdkrw_values = align_series_values(dates, fred_or_price_rows(usdkrw_rows or []), 'close')
    meta = benchmark_metadata(asset)
    output: list[Record] = []
    for i, price_row in enumerate(price_rows):
        raw_close = parse_float(price_row.get('adj_close') or price_row.get('close'))
        if raw_close is None:
            continue
        raw_sector = sector_by_date.get(price_row['date']) or {}
        sector = valid_sector_by_date.get(price_row['date']) or {}
        context_status = sector_context_status(price_row['date'], sector)
        context_warning = sector_context_warning(price_row['date'], sector, context_status)
        fx_rate = usdkrw_values[i]
        benchmark_close = sox_values[i]
        benchmark_as_of = (sox_records_by_date.get(price_row['date']) or {}).get('date') if benchmark_close is not None else None
        benchmark_symbol = 'SOX'
        score_close = raw_close
        score_currency = asset.get('currency', 'USD')
        relative_basis = 'asset_vs_sox'
        currency_warning = None
        if asset.get('currency') == 'KRW':
            if fx_rate is not None and fx_rate > 0:
                score_close = raw_close / fx_rate
                score_currency = 'USD'
                benchmark_close = sox_values[i]
                benchmark_as_of = (sox_records_by_date.get(price_row['date']) or {}).get('date') if benchmark_close is not None else None
                benchmark_symbol = 'SOX'
                relative_basis = 'krw_asset_usd_converted_vs_sox'
            elif kospi_values[i] is not None:
                score_close = raw_close
                score_currency = 'KRW'
                benchmark_close = kospi_values[i]
                benchmark_as_of = price_row['date']
                benchmark_symbol = 'KOSPI'
                relative_basis = 'krw_asset_local_vs_kospi_fx_unavailable'
                currency_warning = 'USDKRW unavailable; using local KRW price versus KOSPI. SOX relative strength unavailable.'
            else:
                score_close = raw_close
                benchmark_close = None
                benchmark_symbol = None
                relative_basis = 'benchmark_unavailable'
                currency_warning = 'USDKRW and KOSPI unavailable; relative strength unavailable.'
        rel_strength = safe_ratio(score_close, benchmark_close) if benchmark_close is not None else None
        output.append({
            'date': price_row['date'],
            'symbol': asset['symbol'],
            'name': asset.get('name'),
            'type': asset.get('type'),
            'group': asset.get('group'),
            'currency': asset.get('currency'),
            'score_currency': score_currency,
            'raw_close': raw_close,
            'close': score_close,
            'open': parse_float(price_row.get('open')),
            'high': parse_float(price_row.get('high')),
            'low': parse_float(price_row.get('low')),
            'volume': parse_float(price_row.get('volume')),
            'vix_close': parse_float(sector.get('vix_close')),
            'vix_ma5': parse_float(sector.get('vix_ma5')),
            'vix_ma20': parse_float(sector.get('vix_ma20')),
            'vix_delta_1': parse_float(sector.get('vix_delta_1')),
            'vix_rising': sector.get('vix_rising'),
            'vxn_close': parse_float(sector.get('vxn_close')),
            'vxn_ma5': parse_float(sector.get('vxn_ma5')),
            'vxn_delta_1': parse_float(sector.get('vxn_delta_1')),
            'vxn_rising': sector.get('vxn_rising'),
            'sector_context_active': bool(sector.get('sector_context_active')),
            'sox_close': parse_float(sector.get('close')),
            'sox_oh_score': sector.get('oh_score'),
            'sox_rf_score': sector.get('rf_score'),
            'sox_top_risk_score': sector.get('top_risk_score'),
            'sox_confirmed_top_risk': bool(sector.get('confirmed_top_risk')),
            'raw_sector_context_date': raw_sector.get('date'),
            'raw_sector_context_scored': is_valid_sector_context(raw_sector),
            'sector_context_as_of': sector.get('date'),
            'sector_context_lag_days': context_lag_days(price_row['date'], sector.get('date')),
            'sector_context_status': context_status,
            'sector_context_warning': context_warning,
            'benchmark_symbol': benchmark_symbol,
            'benchmark_close': benchmark_close,
            'benchmark_as_of': benchmark_as_of,
            'score_model': 'asset_vol_relative',
            **meta,
            'fx_usdkrw': fx_rate,
            'relative_strength': rel_strength,
            'relative_strength_basis': relative_basis,
            'currency_warning': currency_warning,
        })
    return output


def add_asset_specific_indicators(rows: list[Record]) -> list[Record]:
    output = deepcopy(rows)
    closes = [parse_float(row.get('close')) for row in output]
    log_returns: list[float | None] = []
    for i, close in enumerate(closes):
        prev = closes[i - 1] if i > 0 else None
        log_returns.append(None if close is None or prev in (None, 0) else math.log(close / prev))
    rv20 = rolling_std(log_returns, 20)
    rs_values = [parse_float(row.get('relative_strength')) for row in output]
    rs_ma5 = rolling_mean(rs_values, 5)
    rs_ma20 = rolling_mean(rs_values, 20)
    rs_std20 = rolling_std(rs_values, 20)
    for i, row in enumerate(output):
        close = closes[i]
        row['log_ret_1'] = log_returns[i]
        row['rv20'] = rv20[i]
        row['rv20_5d'] = None if rv20[i] is None else rv20[i] * math.sqrt(5)
        row['roc20z'] = z_scaled_log_ratio(close, closes[i - 20] if i >= 20 else None, rv20[i], math.sqrt(20))
        row['dd50z'] = z_scaled_log_ratio(close, row.get('high50'), rv20[i], math.sqrt(50))
        row['rebound20z'] = z_scaled_log_ratio(close, row.get('low20'), rv20[i], math.sqrt(20))
        row['rs_ma5'] = rs_ma5[i]
        row['rs_ma20'] = rs_ma20[i]
        row['rs_std20'] = rs_std20[i]
        row['rel_z20'] = None if rs_values[i] is None or rs_ma20[i] is None or rs_std20[i] in (None, 0) else (rs_values[i] - rs_ma20[i]) / rs_std20[i]
        row['rs_ma20_slope5'] = safe_ratio(rs_ma20[i], rs_ma20[i - 5] if i >= 5 else None, subtract_one=True)
        row['relative_strength_status'] = relative_strength_status(row)
    return output


def z_scaled_log_ratio(current: Any, prior: Any, rv: Any, horizon_sqrt: float) -> float | None:
    current = parse_float(current)
    prior = parse_float(prior)
    rv = parse_float(rv)
    if current is None or prior in (None, 0) or rv in (None, 0):
        return None
    return math.log(current / prior) / (rv * horizon_sqrt)


def compute_asset_oh_score(rows: list[Record]) -> list[Record]:
    output = deepcopy(rows)
    for row in output:
        required = [row.get('z20'), row.get('rsi5'), row.get('roc20z'), row.get('high20'), row.get('close'), row.get('rel_z20')]
        if any(parse_float(value) is None for value in required):
            row['oh_score'] = None
            row['oh_factors'] = {}
            continue
        factors = {
            'z20_gt_1_5': row['z20'] > ASSET_THRESHOLDS['z20_overheat'],
            'rsi5_gt_70': row['rsi5'] > ASSET_THRESHOLDS['rsi5_overheat'],
            'roc20z_gt_1_25': row['roc20z'] > ASSET_THRESHOLDS['roc20z_overheat'],
            'near_high20': row['close'] >= ASSET_THRESHOLDS['high20_close_ratio'] * row['high20'],
            'relz20_gt_1_0': row['rel_z20'] > ASSET_THRESHOLDS['relz20_overheat'],
        }
        row['oh_factors'] = factors
        row['oh_score'] = int(sum(1 for value in factors.values() if value))
    return output


def compute_asset_rf_score(rows: list[Record]) -> list[Record]:
    output = deepcopy(rows)
    for row in output:
        required = [row.get('close'), row.get('ma20'), row.get('ma50'), row.get('dd50z'), row.get('rebound20z'), row.get('roc20z'), row.get('ma20_slope5'), row.get('relative_strength'), row.get('rs_ma20')]
        if any(parse_float(value) is None for value in required):
            row['rf_score'] = None
            row['rf_factors'] = {}
            continue
        close = row['close']
        ma20 = row['ma20']
        ma50 = row['ma50']
        rs = row['relative_strength']
        rs_ma20 = row['rs_ma20']
        factors = {
            'prior_damage': close < ma50 or row['dd50z'] < ASSET_THRESHOLDS['dd50z_damage'],
            'rebound_from_low': row['rebound20z'] > ASSET_THRESHOLDS['rebound20z'],
            'ma_resistance': min(abs(close / ma20 - 1), abs(close / ma50 - 1)) <= ASSET_THRESHOLDS['ma_resistance_band'] and close <= ASSET_THRESHOLDS['ma_resistance_cap'] * max(ma20, ma50),
            'weak_momentum': row['roc20z'] < ASSET_THRESHOLDS['weak_roc20z'] or row['ma20_slope5'] < 0,
            'relative_weakness': rs < rs_ma20 or (parse_float(row.get('rs_ma20_slope5')) is not None and row['rs_ma20_slope5'] < 0),
        }
        row['rf_factors'] = factors
        row['rf_score'] = int(sum(1 for value in factors.values() if value))
    return output


def compute_asset_confirmation(rows: list[Record]) -> list[Record]:
    output = deepcopy(rows)
    setup_history: list[bool] = []
    for i, row in enumerate(output):
        oh = parse_float(row.get('oh_score'))
        rf = parse_float(row.get('rf_score'))
        setup_active = oh is not None and rf is not None and (oh >= 4 or rf >= 4)
        setup_history.append(setup_active)
        setup_recent = any(setup_history[max(0, i - 2): i + 1])
        close = parse_float(row.get('close'))
        ma5 = parse_float(row.get('ma5'))
        ret_1 = parse_float(row.get('ret_1'))
        rv20 = parse_float(row.get('rv20'))
        rs = parse_float(row.get('relative_strength'))
        rs_ma5 = parse_float(row.get('rs_ma5'))
        price_rollover = close is not None and ma5 is not None and close < ma5
        vol_threshold = None if rv20 is None else -max(ASSET_THRESHOLDS['asset_large_down_abs'], ASSET_THRESHOLDS['asset_large_down_vol_mult'] * rv20)
        asset_large_down_day = ret_1 is not None and vol_threshold is not None and ret_1 <= vol_threshold
        relative_rollover = rs is not None and rs_ma5 is not None and rs < rs_ma5
        confirmed = bool(setup_recent and (price_rollover or asset_large_down_day or relative_rollover))
        actionable = bool(confirmed and row.get('sector_context_active'))
        top = max(oh, rf) if oh is not None and rf is not None else None
        row.update({
            'asset_setup_active': setup_active,
            'asset_setup_recent': setup_recent,
            'price_rollover': price_rollover,
            'asset_large_down_day': asset_large_down_day,
            'asset_large_down_threshold': vol_threshold,
            'relative_rollover': relative_rollover,
            'asset_confirmed_risk': confirmed,
            'asset_actionable_signal': actionable,
            'confirmed_top_risk': confirmed,
            'top_risk_score': int(top) if top is not None else None,
            'regime': classify_regime(oh, rf),
            'action_level': asset_action_level(oh, rf, confirmed, actionable),
            'action_label': asset_action_label(oh, rf, confirmed, actionable),
            'action_text': asset_action_text(oh, rf, confirmed, actionable),
        })
    return output


def compute_vol_adjusted_labels(rows: list[Record], horizon: int = 5) -> list[Record]:
    output = deepcopy(rows)
    for row in output:
        rv20 = parse_float(row.get('rv20'))
        fwd_min = parse_float(row.get('fwd_min_5'))
        fwd_max = parse_float(row.get('fwd_max_5'))
        if rv20 is None or fwd_min is None or fwd_max is None:
            row['vol_adj_downside_threshold_5d'] = None
            row['vol_adj_upside_threshold_5d'] = None
            row['vol_adj_downside_5d'] = None
            row['vol_adj_strict_top_5d'] = None
            continue
        downside_threshold = ASSET_THRESHOLDS['vol_downside_sigma'] * rv20 * math.sqrt(horizon)
        upside_threshold = ASSET_THRESHOLDS['vol_strict_up_sigma'] * rv20 * math.sqrt(horizon)
        row['vol_adj_downside_threshold_5d'] = downside_threshold
        row['vol_adj_upside_threshold_5d'] = upside_threshold
        row['vol_adj_downside_5d'] = fwd_min <= downside_threshold
        row['vol_adj_strict_top_5d'] = fwd_max <= upside_threshold and fwd_min <= downside_threshold
    return output


def add_asset_rule_signals(rows: list[Record]) -> list[Record]:
    output = deepcopy(rows)
    for row in output:
        oh = parse_float(row.get('oh_score'))
        rf = parse_float(row.get('rf_score'))
        top = parse_float(row.get('top_risk_score'))
        row['signal_asset_oh_ge_4'] = oh is not None and oh >= 4
        row['signal_asset_oh_eq_5'] = oh == 5
        row['signal_asset_rf_ge_4'] = rf is not None and rf >= 4
        row['signal_asset_rf_eq_5'] = rf == 5
        row['signal_asset_top_ge_4'] = top is not None and top >= 4
        row['signal_asset_top_eq_5'] = top == 5
        row['signal_asset_confirmed_risk'] = bool(row.get('asset_confirmed_risk'))
        row['signal_asset_actionable_signal'] = bool(row.get('asset_actionable_signal'))
        row['signal_asset_top_ge_4_sector_context'] = bool(row.get('signal_asset_top_ge_4')) and bool(row.get('sector_context_active'))
        row['signal_rsi14_gt_70'] = parse_float(row.get('rsi14')) is not None and row['rsi14'] > 70
        row['signal_rsi5_gt_70'] = parse_float(row.get('rsi5')) is not None and row['rsi5'] > 70
        row['signal_z20_gt_1_5'] = parse_float(row.get('z20')) is not None and row['z20'] > ASSET_THRESHOLDS['z20_overheat']
        row['signal_relz20_gt_1_0'] = parse_float(row.get('rel_z20')) is not None and row['rel_z20'] > ASSET_THRESHOLDS['relz20_overheat']
        row['signal_roc20z_gt_1_25'] = parse_float(row.get('roc20z')) is not None and row['roc20z'] > ASSET_THRESHOLDS['roc20z_overheat']
        row['signal_price_below_ma5'] = parse_float(row.get('close')) is not None and parse_float(row.get('ma5')) is not None and row['close'] < row['ma5']
    return output


def build_asset_backtest_payload(config: Record, rows_by_symbol: dict[str, list[Record]], generated_at: str) -> Record:
    assets: dict[str, Any] = {}
    for asset in config.get('assets', []):
        symbol = asset['symbol']
        if symbol == 'SOX':
            # SOX has its canonical backtest in risk_score_backtest.json; keep only a selector stub here.
            assets[symbol] = {
                'usesCanonicalSoxBacktest': True,
                'periods': {},
                'confidence': confidence_for_rows(rows_by_symbol.get(symbol, []), asset),
                'economicValidation': {'status': 'canonical', 'summary': 'SOX uses the canonical index backtest in risk_score_backtest.json.'},
            }
            continue
        rows = rows_by_symbol.get(symbol, [])
        assets[symbol] = build_backtest_for_rows(rows, asset)
    return json_ready({
        'schemaVersion': 1,
        'contract': 'asset-risk-backtest',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'primaryMode': 'event',
        'primaryLabelMode': 'volAdjusted',
        'cooldownDays': DEFAULT_THRESHOLDS['cooldown_days'],
        'horizonDays': 5,
        'rules': [{'id': rule_id, 'label': label, 'description': description} for rule_id, label, description in ASSET_RULES],
        'periods': period_labels_for_latest(rows_by_symbol),
        'assets': assets,
        'notes': [
            'SOX keeps the original canonical fixed -5% backtest in risk_score_backtest.json.',
            'Single stocks/ETFs prioritize volatility-adjusted labels; absolute labels remain available for comparison.',
            'Event-level statistics use a 5-trading-day cooldown per asset.',
        ],
    })


def build_backtest_for_rows(rows: list[Record], asset: Record) -> Record:
    latest = max((parse_iso_date(row['date']) for row in rows if row.get('date')), default=None)
    periods = build_asset_periods(latest)
    result_periods: dict[str, Any] = {}
    for period_id, period in periods.items():
        period_rows = [row for row in rows if in_period(row, period)]
        result_periods[period_id] = build_asset_period_stats(period_rows)
    economic_validation = economic_validation_from_periods(result_periods)
    return json_ready({
        'symbol': asset['symbol'],
        'name': asset.get('name'),
        'confidence': confidence_for_rows(rows, asset, economic_validation),
        'economicValidation': economic_validation,
        'periods': result_periods,
    })


def build_asset_period_stats(rows: list[Record]) -> Record:
    stats_by_label_mode = {}
    for label_mode in ('absolute', 'volAdjusted'):
        downside_key = 'downside_event_5d' if label_mode == 'absolute' else 'vol_adj_downside_5d'
        strict_key = 'strict_top_5d' if label_mode == 'absolute' else 'vol_adj_strict_top_5d'
        valid_rows = [row for row in rows if row.get(downside_key) is not None]
        base_downside = mean_bool(row.get(downside_key) for row in valid_rows)
        base_strict = mean_bool(row.get(strict_key) for row in valid_rows)
        rule_stats = {}
        for rule_id, label, _description in ASSET_RULES:
            signal_col = f'signal_{rule_id}'
            daily_rows = [row for row in rows if row.get(signal_col) and row.get(downside_key) is not None]
            event_rows = decluster_event_rows(rows, signal_col, int(DEFAULT_THRESHOLDS['cooldown_days']), required_key=downside_key)
            signal_count = len([row for row in rows if row.get(signal_col)])
            rule_stats[rule_id] = {
                'label': label,
                'daily': summarize_asset_signal_rows(daily_rows, base_downside, base_strict, signal_count, len(event_rows), downside_key, strict_key),
                'event': summarize_asset_signal_rows(event_rows, base_downside, base_strict, signal_count, len(event_rows), downside_key, strict_key),
            }
        stats_by_label_mode[label_mode] = {
            'sampleCount': len(valid_rows),
            'baseRates': {'downsideHitRate': base_downside, 'strictTopHitRate': base_strict},
            'ruleStats': rule_stats,
        }
    return json_ready(stats_by_label_mode)


def summarize_asset_signal_rows(rows: list[Record], base_downside: float | None, base_strict: float | None, signal_count: int, event_count: int, downside_key: str, strict_key: str) -> Record:
    downside_rate = mean_bool(row.get(downside_key) for row in rows)
    strict_rate = mean_bool(row.get(strict_key) for row in rows)
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
        'avgFwdRet5': mean_float(fwd_ret),
        'medianFwdRet5': median_float(fwd_ret),
        'avgFwdMin5': mean_float(fwd_min),
        'avgFwdMax5': mean_float(fwd_max),
        'maxAdverseContinuation': max(fwd_max) if fwd_max else None,
    })


def economic_validation_from_periods(periods: Record) -> Record:
    full_vol = periods.get('full', {}).get('volAdjusted', {})
    base_downside = (full_vol.get('baseRates') or {}).get('downsideHitRate')
    rules = full_vol.get('ruleStats') or {}
    primary: list[Record] = []
    for rule_id in PRIMARY_ECONOMIC_RULES:
        event = (rules.get(rule_id) or {}).get('event') or {}
        primary.append({
            'ruleId': rule_id,
            'eventCount': event.get('eventCount'),
            'evaluatedCount': event.get('evaluatedCount'),
            'downsideHitRate': event.get('downsideHitRate'),
            'downsideHitRateLift': event.get('downsideHitRateLift'),
            'baseDownsideHitRate': base_downside,
            'maxAdverseContinuation': event.get('maxAdverseContinuation'),
        })
    evaluable = [
        item for item in primary
        if parse_float(item.get('downsideHitRateLift')) is not None
        and parse_float(item.get('eventCount')) is not None
        and int(item['eventCount']) >= ECONOMIC_VALIDATION_MIN_EVENTS
    ]
    if not evaluable:
        status = 'insufficient'
        summary = 'Too few de-clustered primary-rule events to validate the asset signal economically.'
    else:
        best_lift = max(parse_float(item.get('downsideHitRateLift')) or 0 for item in evaluable)
        if best_lift >= ECONOMIC_VALIDATION_PASS_LIFT:
            status = 'validated'
            summary = 'At least one primary event-level vol-adjusted risk rule has downside lift above the diagnostic validation threshold.'
        elif best_lift <= 1.0:
            status = 'weak'
            summary = 'Primary event-level vol-adjusted risk rules do not beat the asset base downside rate; treat signals as descriptive risk overlays, not proven timing edges.'
        else:
            status = 'mixed'
            summary = 'Primary event-level vol-adjusted risk rules are near base rate; economic timing evidence is mixed.'
    return json_ready({
        'status': status,
        'primaryMode': 'event',
        'primaryLabelMode': 'volAdjusted',
        'minEvents': ECONOMIC_VALIDATION_MIN_EVENTS,
        'passLift': ECONOMIC_VALIDATION_PASS_LIFT,
        'baseDownsideHitRate': base_downside,
        'primaryRules': primary,
        'summary': summary,
    })


def build_asset_summary_payload(config: Record, rows_by_symbol: dict[str, list[Record]], backtest: Record, source_status: Record, errors: dict[str, str], generated_at: str) -> Record:
    assets = []
    for asset in config.get('assets', []):
        symbol = asset['symbol']
        rows = rows_by_symbol.get(symbol, [])
        latest = latest_asset_row(rows)
        bt = backtest.get('assets', {}).get(symbol, {})
        coverage = coverage_for_rows(rows)
        economic_validation = bt.get('economicValidation')
        confidence = bt.get('confidence') or confidence_for_rows(rows, asset, economic_validation)
        warnings = warnings_for_asset(asset, coverage, latest, errors.get(symbol), economic_validation)
        current = current_summary_for_asset(asset, latest)
        raw_status = source_status.get('assets', {}).get(symbol, {}).get('status', 'unknown')
        effective_status = raw_status
        if raw_status == 'ok' and symbol != 'SOX' and current.get('sectorContextStatus') != 'fresh':
            effective_status = 'warning'
        assets.append(json_ready({
            'symbol': symbol,
            'providerSymbol': asset.get('providerSymbol'),
            'name': asset.get('name'),
            'type': asset.get('type'),
            'group': asset.get('group'),
            'currency': asset.get('currency'),
            'benchmark': asset.get('benchmark'),
            **benchmark_metadata(asset),
            'current': current,
            'coverage': coverage,
            'confidence': confidence,
            'economicValidation': economic_validation,
            'modelValidation': economic_validation,
            'warnings': warnings,
            'dataStatus': {**source_status.get('assets', {}).get(symbol, {}), 'status': effective_status},
            'factorBreakdown': build_asset_factor_breakdown(latest) if latest else [],
            'recentSignals': signal_history_for_asset(rows),
        }))
    by_symbol = {asset['symbol']: asset for asset in assets}
    latest_dates = [asset['current'].get('date') for asset in assets if asset.get('current') and asset['current'].get('date')]
    data_as_of = max(latest_dates) if latest_dates else None
    sox_current = by_symbol.get('SOX', {}).get('current') or {}
    matrix = [matrix_row(asset) for asset in assets]
    return json_ready({
        'schemaVersion': 1,
        'contract': 'asset-risk-summary',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'dataAsOf': data_as_of,
        'defaultSymbol': 'SOX',
        'assets': assets,
        'bySymbol': by_symbol,
        'matrix': matrix,
        'sectorContextLatest': {
            'active': sox_current.get('sectorContextActive'),
            'soxOhScore': sox_current.get('soxOhScore') or sox_current.get('ohScore'),
            'soxRfScore': sox_current.get('soxRfScore') or sox_current.get('rfScore'),
            'soxConfirmedTopRisk': sox_current.get('confirmation'),
            'vixRising': sox_current.get('vixRising'),
            'vxnRising': sox_current.get('vxnRising'),
            'vxnAvailable': sox_current.get('vxnClose') is not None,
            'asOf': sox_current.get('sectorContextAsOf') or sox_current.get('date'),
            'lagDays': sox_current.get('sectorContextLagDays'),
            'status': sox_current.get('sectorContextStatus'),
            'displayDate': sox_current.get('displayDate') or sox_current.get('date'),
        },
        'methodology': {
            'soxModelPreserved': True,
            'scoreSemantics': 'SOX uses the canonical sector OH/RF model. Other assets use an experimental volatility-adjusted and relative-strength risk ladder; Top Risk is not a calibrated cross-asset probability.',
            'assetModel': 'Volatility-adjusted OH/RF score plus relative strength versus an analysis benchmark/reference, usually SOX or KOSPI fallback for Korea when FX is unavailable.',
            'benchmarkPolicy': 'officialBenchmark is issuer/index documentation where available; analysisBenchmark is the reference used for relative-strength context and can differ from the ETF official benchmark.',
            'koreaCurrencyPolicy': 'KRW prices are converted to USD using USDKRW for SOX-relative strength when available; otherwise local KOSPI relative strength is used with warning.',
            'primaryBacktestLabel': 'volAdjusted',
            'notInvestmentAdvice': True,
        },
    })


def build_asset_daily_payload(config: Record, rows_by_symbol: dict[str, list[Record]], generated_at: str, summary: Record, *, row_limit: int = 560) -> Record:
    compact: dict[str, list[Record]] = {}
    for asset in config.get('assets', []):
        symbol = asset['symbol']
        compact[symbol] = [compact_daily_row(row) for row in rows_by_symbol.get(symbol, [])[-row_limit:]]
    return json_ready({
        'schemaVersion': 1,
        'contract': 'asset-risk-daily',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'dataAsOf': summary.get('dataAsOf'),
        'rowLimitPerSymbol': row_limit,
        'rowsBySymbol': compact,
    })


def compact_daily_row(row: Record) -> Record:
    keys = [
        'date', 'symbol', 'close', 'score_currency', 'ret_1', 'ma5', 'ma20', 'ma50',
        'z20', 'rsi5', 'rsi14', 'rv20', 'roc20z', 'relative_strength', 'rs_ma5', 'rs_ma20',
        'rel_z20', 'oh_score', 'rf_score', 'top_risk_score', 'regime', 'asset_confirmed_risk',
        'asset_actionable_signal', 'sector_context_active', 'relative_strength_status', 'benchmark_symbol',
        'benchmark_as_of', 'sector_context_as_of', 'sector_context_lag_days', 'sector_context_status',
        'vix_close', 'vix_ma5', 'vix_ma20', 'vix_rising', 'vxn_close', 'vxn_ma5', 'vxn_rising',
        'confirmed_top_risk', 'signal_asset_top_ge_4', 'signal_asset_confirmed_risk', 'signal_asset_actionable_signal',
    ]
    return {key: row.get(key) for key in keys if key in row}


def build_universe_payload(config: Record, generated_at: str) -> Record:
    return json_ready({
        'schemaVersion': config.get('schemaVersion', 1),
        'contract': 'asset-universe',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'context': config.get('context', {}),
        'assets': config.get('assets', []),
    })


def build_data_status_payload(config: Record, source_status: Record, summary: Record, generated_at: str) -> Record:
    statuses = [asset.get('dataStatus', {}).get('status') for asset in summary.get('assets', [])]
    status = 'ok' if all(item == 'ok' for item in statuses if item) else 'warning'
    if any(item == 'error' for item in statuses):
        status = 'degraded'
    return json_ready({
        'schemaVersion': 1,
        'contract': 'risk-score-data-status',
        'projectId': 'risk-score',
        'generatedAt': generated_at,
        'status': status,
        'requiredUniverseCount': len(config.get('assets', [])),
        'availableAssetCount': len([asset for asset in summary.get('assets', []) if asset.get('coverage', {}).get('rowCount', 0) > 0]),
        'sourceStatus': source_status,
    })


def current_summary_for_asset(asset: Record, latest: Record | None) -> Record:
    if not latest:
        return {'symbol': asset['symbol'], 'name': asset.get('name'), 'dataStatus': 'unavailable'}
    is_sox = asset['symbol'] == 'SOX'
    score_model = latest.get('score_model') or ('sox_canonical' if is_sox else 'asset_vol_relative')
    score_model_label = 'Canonical SOX sector OH/RF model' if score_model == 'sox_canonical' else 'Asset-specific volatility-adjusted relative-strength model'
    return json_ready({
        'symbol': asset['symbol'],
        'name': asset.get('name'),
        'type': asset.get('type'),
        'group': asset.get('group'),
        'date': latest.get('date'),
        'displayDate': latest.get('date'),
        'latestScoredDate': latest.get('date') if latest.get('top_risk_score') is not None else None,
        'scoreModel': score_model,
        'scoreModelLabel': score_model_label,
        'close': latest.get('close'),
        'rawClose': latest.get('raw_close') or latest.get('close'),
        'currency': latest.get('currency') or asset.get('currency'),
        'scoreCurrency': latest.get('score_currency') or asset.get('currency'),
        'oneDayReturn': latest.get('ret_1'),
        'ohScore': latest.get('oh_score'),
        'rfScore': latest.get('rf_score'),
        'topRiskScore': latest.get('top_risk_score'),
        'regime': latest.get('regime'),
        'confirmation': bool(latest.get('asset_confirmed_risk') if asset['symbol'] != 'SOX' else latest.get('confirmed_top_risk')),
        'assetConfirmedRisk': bool(latest.get('asset_confirmed_risk')),
        'assetActionableSignal': bool(latest.get('asset_actionable_signal')),
        'sectorContextActive': bool(latest.get('sector_context_active')),
        'actionLevel': latest.get('action_level'),
        'actionLabel': latest.get('action_label'),
        'actionText': latest.get('action_text'),
        'relativeStrength': latest.get('relative_strength'),
        'relativeStrengthStatus': latest.get('relative_strength_status'),
        'relativeStrengthBasis': latest.get('relative_strength_basis'),
        'relZ20': latest.get('rel_z20'),
        'benchmarkSymbol': latest.get('benchmark_symbol'),
        'benchmarkClose': latest.get('benchmark_close'),
        'benchmarkAsOf': latest.get('benchmark_as_of'),
        **benchmark_metadata(asset),
        'fxUsdKrw': latest.get('fx_usdkrw'),
        'currencyWarning': latest.get('currency_warning'),
        'sectorContextAsOf': latest.get('sector_context_as_of'),
        'sectorContextLagDays': latest.get('sector_context_lag_days'),
        'sectorContextStatus': latest.get('sector_context_status') or ('fresh' if is_sox else 'unavailable'),
        'sectorContextWarning': latest.get('sector_context_warning'),
        'rawSectorContextDate': latest.get('raw_sector_context_date'),
        'rawSectorContextScored': latest.get('raw_sector_context_scored'),
        'vixClose': latest.get('vix_close'),
        'vixRising': latest.get('vix_rising'),
        'vxnClose': latest.get('vxn_close'),
        'vxnRising': latest.get('vxn_rising'),
        'soxOhScore': latest.get('sox_oh_score'),
        'soxRfScore': latest.get('sox_rf_score'),
        'soxTopRiskScore': latest.get('sox_top_risk_score'),
        'soxConfirmedTopRisk': latest.get('sox_confirmed_top_risk'),
    })


def build_asset_factor_breakdown(row: Record | None) -> list[Record]:
    if not row:
        return []
    factors = []
    for key, threshold, value_key, model, interpretation in ASSET_FACTORS:
        source = row.get('oh_factors' if model == 'OH' else 'rf_factors', {})
        factors.append({
            'factor': key,
            'model': model,
            'currentValue': row.get(value_key),
            'threshold': threshold,
            'signal': bool(source.get(key)),
            'interpretation': interpretation,
        })
    confirmations = [
        ('price_rollover', 'P < MA5', row.get('close'), bool(row.get('price_rollover')), 'Confirmation', '가격이 MA5 아래로 내려오며 rally rollover 확인'),
        ('asset_large_down_day', 'ret <= -max(2%, .75*RV20)', row.get('ret_1'), bool(row.get('asset_large_down_day')), 'Confirmation', '자산 변동성 대비 큰 하락일 확인'),
        ('relative_rollover', 'RS < RS MA5', row.get('relative_strength'), bool(row.get('relative_rollover')), 'Confirmation', 'benchmark 대비 상대강도 단기 이탈'),
        ('sector_context_active', 'SOX/VIX/VXN context active', row.get('sox_top_risk_score'), bool(row.get('sector_context_active')), 'Sector', '섹터 고점 리스크 또는 변동성 상승 context'),
    ]
    for key, threshold, value, signal, model, interpretation in confirmations:
        factors.append({'factor': key, 'model': model, 'currentValue': value, 'threshold': threshold, 'signal': signal, 'interpretation': interpretation})
    return [json_ready(item) for item in factors]


def signal_history_for_asset(rows: list[Record], limit: int = 80) -> list[Record]:
    interesting = [row for row in rows if row.get('asset_setup_active') or row.get('asset_confirmed_risk') or row.get('asset_actionable_signal') or row.get('top_risk_score') == 5]
    selected = interesting[-limit:]
    return [json_ready({
        'date': row.get('date'),
        'close': row.get('close'),
        'rawClose': row.get('raw_close'),
        'ohScore': row.get('oh_score'),
        'rfScore': row.get('rf_score'),
        'topRiskScore': row.get('top_risk_score'),
        'confirmation': row.get('asset_confirmed_risk'),
        'actionable': row.get('asset_actionable_signal'),
        'fwdMin5': row.get('fwd_min_5'),
        'fwdMax5': row.get('fwd_max_5'),
        'fwdRet5': row.get('fwd_ret_5'),
        'downsideHit': row.get('downside_event_5d'),
        'strictTopHit': row.get('strict_top_5d'),
        'volAdjDownsideHit': row.get('vol_adj_downside_5d'),
        'volAdjStrictTopHit': row.get('vol_adj_strict_top_5d'),
        'regime': row.get('regime'),
    }) for row in reversed(selected)]


def matrix_row(asset_summary: Record) -> Record:
    current = asset_summary.get('current') or {}
    return json_ready({
        'symbol': asset_summary.get('symbol'),
        'name': asset_summary.get('name'),
        'type': asset_summary.get('type'),
        'group': asset_summary.get('group'),
        'latest': current.get('close'),
        'rawLatest': current.get('rawClose'),
        'scoreCurrency': current.get('scoreCurrency'),
        'currency': current.get('currency'),
        'oneDayReturn': current.get('oneDayReturn'),
        'ohScore': current.get('ohScore'),
        'rfScore': current.get('rfScore'),
        'topRiskScore': current.get('topRiskScore'),
        'regime': current.get('regime'),
        'confirmed': current.get('assetConfirmedRisk') or current.get('confirmation'),
        'sectorContext': current.get('sectorContextActive'),
        'sectorContextStatus': current.get('sectorContextStatus'),
        'sectorContextAsOf': current.get('sectorContextAsOf'),
        'sectorContextLagDays': current.get('sectorContextLagDays'),
        'actionable': current.get('assetActionableSignal'),
        'relativeStrength': current.get('relativeStrengthStatus'),
        'analysisBenchmark': asset_summary.get('analysisBenchmark'),
        'officialBenchmark': asset_summary.get('officialBenchmark'),
        'dataStatus': asset_summary.get('dataStatus', {}).get('status'),
        'confidence': asset_summary.get('confidence', {}).get('level'),
        'economicValidationStatus': asset_summary.get('economicValidation', {}).get('status'),
        'warnings': asset_summary.get('warnings'),
    })


def coverage_for_rows(rows: list[Record]) -> Record:
    scored = [row for row in rows if parse_float(row.get('top_risk_score')) is not None]
    evaluated_abs = [row for row in rows if row.get('downside_event_5d') is not None]
    evaluated_vol = [row for row in rows if row.get('vol_adj_downside_5d') is not None]
    return {
        'startDate': rows[0]['date'] if rows else None,
        'endDate': rows[-1]['date'] if rows else None,
        'rowCount': len(rows),
        'scoredCount': len(scored),
        'evaluatedAbsoluteCount': len(evaluated_abs),
        'evaluatedVolAdjustedCount': len(evaluated_vol),
        'sufficientHistory': len(evaluated_abs) >= 756,
    }


def confidence_for_rows(rows: list[Record], asset: Record, economic_validation: Record | None = None) -> Record:
    if asset.get('symbol') == 'SOX':
        return {'level': 'high', 'confirmedSignalCount': len([row for row in rows if row.get('confirmed_top_risk')]), 'reasons': ['SOX uses the canonical index model and canonical backtest.']}
    coverage = coverage_for_rows(rows)
    events = len([row for row in rows if row.get('signal_asset_confirmed_risk')])
    forced_warning = bool(asset.get('historyWarning'))
    if forced_warning or coverage['evaluatedAbsoluteCount'] < 252 or events < 3:
        level = 'low'
    elif coverage['evaluatedAbsoluteCount'] < 756 or events < 8:
        level = 'medium'
    else:
        level = 'high'
    reasons = []
    validation_status = (economic_validation or {}).get('status')
    if validation_status == 'weak':
        level = 'low'
        reasons.append('Primary event-level vol-adjusted risk rules underperform the asset base downside rate.')
    elif validation_status == 'mixed' and level == 'high':
        level = 'medium'
        reasons.append('Primary event-level vol-adjusted risk rules are near base rate; confidence is capped at medium.')
    elif validation_status == 'insufficient' and level != 'low':
        level = 'medium'
        reasons.append('Primary economic validation has insufficient de-clustered events; confidence is capped.')
    elif validation_status == 'validated':
        reasons.append('At least one primary event-level vol-adjusted risk rule shows downside lift above the diagnostic threshold.')
    if asset.get('historyWarning'):
        reasons.append(asset['historyWarning'])
    if coverage['evaluatedAbsoluteCount'] < 756:
        reasons.append('Less than roughly three trading years of evaluated history.')
    if events < 8:
        reasons.append('Few confirmed-risk events after de-clustering; interpret hit rates cautiously.')
    return {'level': level, 'confirmedSignalCount': events, 'economicValidationStatus': validation_status, 'reasons': dedupe_strings(reasons)}


def warnings_for_asset(asset: Record, coverage: Record, latest: Record | None, error: str | None = None, economic_validation: Record | None = None) -> list[str]:
    warnings = []
    if error:
        warnings.append(error)
    if asset.get('historyWarning'):
        warnings.append(asset['historyWarning'])
    if coverage.get('evaluatedAbsoluteCount', 0) < 756 and asset['symbol'] != 'SOX':
        warnings.append('Backtest confidence is limited because evaluated history is shorter than roughly three trading years.')
    if latest and latest.get('currency_warning'):
        warnings.append(latest['currency_warning'])
    if latest and latest.get('vxn_close') is None:
        warnings.append('VXN optional context unavailable; sector context uses SOX/VIX only.')
    if latest and latest.get('sector_context_warning') and asset['symbol'] != 'SOX':
        warnings.append(latest['sector_context_warning'])
    official = asset.get('officialBenchmark')
    analysis = asset.get('analysisBenchmark') or {}
    if asset.get('type') == 'ETF' and official:
        official_name = official.get('name') or 'issuer-defined benchmark/exposure'
        analysis_symbol = analysis.get('symbol') or asset.get('benchmark') or 'analysis benchmark'
        warnings.append(f"{asset['symbol']} official benchmark/exposure is {official_name}; {analysis_symbol} is used only as the analysis reference for relative strength.")
    validation_status = (economic_validation or {}).get('status')
    if validation_status == 'weak':
        warnings.append('Economic validation is weak: primary event-level vol-adjusted risk rules do not beat the asset base downside rate.')
    elif validation_status == 'mixed':
        warnings.append('Economic validation is mixed: primary event-level vol-adjusted risk rules are close to base rate.')
    elif validation_status == 'insufficient' and asset['symbol'] != 'SOX':
        warnings.append('Economic validation has too few de-clustered primary-rule events for a strong conclusion.')
    return dedupe_strings(warnings)


def latest_asset_row(rows: list[Record]) -> Record | None:
    return latest_scored_row(rows) or (rows[-1] if rows else None)


def relative_strength_status(row: Record) -> str:
    if row.get('relative_strength_basis') == 'self':
        return 'sector baseline'
    relz = parse_float(row.get('rel_z20'))
    benchmark = row.get('benchmark_symbol') or 'benchmark'
    if relz is None:
        return f'unavailable vs {benchmark}'
    if relz > 1:
        return f'strong vs {benchmark}'
    if relz < -1:
        return f'weak vs {benchmark}'
    return f'neutral vs {benchmark}'


def asset_action_level(oh: float | None, rf: float | None, confirmed: bool, actionable: bool) -> str:
    if oh is None or rf is None:
        return 'insufficient'
    if actionable:
        return 'confirmed-red'
    if confirmed:
        return 'high-risk'
    if oh == 5 or rf == 5:
        return 'red-zone'
    if oh >= 4 or rf >= 4:
        return 'high-risk'
    if oh == 3 or rf == 3:
        return 'watch'
    return 'normal'


def asset_action_label(oh: float | None, rf: float | None, confirmed: bool, actionable: bool) -> str:
    return {
        'insufficient': 'Insufficient data',
        'normal': 'Normal',
        'watch': 'Watch',
        'high-risk': 'Confirmed Risk' if confirmed and not actionable else 'High Risk',
        'red-zone': 'Red Zone',
        'confirmed-red': 'Actionable Risk',
    }[asset_action_level(oh, rf, confirmed, actionable)]


def asset_action_text(oh: float | None, rf: float | None, confirmed: bool, actionable: bool) -> str:
    if oh is None or rf is None:
        return 'rolling window와 benchmark/FX 데이터가 충분해질 때까지 score를 계산하지 않습니다.'
    if actionable:
        return '종목 자체 rollover와 SOX/VIX/VXN sector context가 동시에 악화된 risk overlay 상태입니다.'
    if confirmed:
        return '종목 자체 차트는 confirmation이 켜졌지만 sector context와 함께 확인해야 합니다.'
    if oh == 5 or rf == 5:
        return 'red-zone risk overlay입니다. 신규 추격매수 제한과 hedge 준비를 점검할 수 있습니다.'
    if oh >= 4 or rf >= 4:
        return 'leading setup이 high-risk 구간입니다. confirmation 및 sector context 확인이 필요합니다.'
    if oh == 3 or rf == 3:
        return 'watch 구간입니다. 상대강도와 MA5 rollover를 점검합니다.'
    return '일반 포지션 유지 관점의 risk overlay 상태입니다.'


def build_asset_periods(latest: date | None) -> dict[str, dict[str, Any]]:
    periods = build_periods(latest)
    if latest is not None:
        periods['since_2020'] = {'label': 'Since 2020', 'start': date(2020, 1, 1), 'end': latest}
    # UI order: full, since_2020, recent_3y, recent_1y, ytd, ex_2026.
    ordered: dict[str, dict[str, Any]] = {}
    for key in ['full', 'since_2020', 'recent_3y', 'recent_1y', 'ytd', 'ex_2026']:
        if key in periods:
            ordered[key] = periods[key]
    return ordered


def period_labels_for_latest(rows_by_symbol: dict[str, list[Record]]) -> Record:
    latest_dates = [parse_iso_date(row['date']) for rows in rows_by_symbol.values() for row in rows if row.get('date')]
    latest = max((item for item in latest_dates if item is not None), default=None)
    return {key: {'label': value['label'], 'start': value.get('start').isoformat() if value.get('start') else None, 'end': value.get('end').isoformat() if value.get('end') else None} for key, value in build_asset_periods(latest).items()}


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


def decluster_event_rows(rows: list[Record], signal_col: str, cooldown: int, *, required_key: str) -> list[Record]:
    selected: list[Record] = []
    last_event_index = -10_000
    for i, row in enumerate(rows):
        if row.get(signal_col) and i - last_event_index > cooldown:
            last_event_index = i
            if row.get(required_key) is not None:
                selected.append(row)
    return selected


def align_records(target_dates: list[str], records: list[Record]) -> dict[str, Record]:
    sorted_records = sorted([row for row in records if row.get('date')], key=lambda row: row['date'])
    output: dict[str, Record] = {}
    j = 0
    last: Record | None = None
    for day in target_dates:
        while j < len(sorted_records) and sorted_records[j]['date'] <= day:
            last = sorted_records[j]
            j += 1
        if last is not None:
            output[day] = last
    return output


def align_series_values(target_dates: list[str], rows: list[Record], value_key: str) -> list[float | None]:
    records = align_records(target_dates, rows)
    return [parse_float(records.get(day, {}).get(value_key)) for day in target_dates]


def fred_or_price_rows(rows: list[Record]) -> list[Record]:
    output = []
    for row in rows:
        value = parse_float(row.get('close'))
        if value is None:
            value = parse_float(row.get('adj_close'))
        if value is None:
            value = parse_float(row.get('value'))
        if row.get('date') and value is not None:
            output.append({'date': row['date'], 'close': value})
    return dedupe_by_date(output)


def dedupe_by_date(rows: list[Record]) -> list[Record]:
    by_date = {str(row['date'])[:10]: {**row, 'date': str(row['date'])[:10]} for row in rows if row.get('date')}
    return [by_date[day] for day in sorted(by_date)]


def list_get(items: Any, index: int) -> Any:
    if not isinstance(items, list) or index >= len(items):
        return None
    return items[index]


def dedupe_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            output.append(item)
    return output
