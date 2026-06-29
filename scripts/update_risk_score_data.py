#!/usr/bin/env python3
"""Fetch FRED SOX/VIX data and export static Risk Score JSON."""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from risk_score.model import export_json_outputs, fetch_fred_series, run_pipeline


def read_series_csv(path: Path, series_id: str) -> list[dict]:
    rows = []
    with path.open(newline='', encoding='utf-8') as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rows.append({'date': row.get('observation_date') or row.get('date'), 'value': row.get(series_id) or row.get('value')})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', default=str(ROOT / 'data' / 'risk-score'))
    parser.add_argument('--sox-csv', type=Path, help='Optional local FRED-format NASDAQSOX CSV fixture')
    parser.add_argument('--vix-csv', type=Path, help='Optional local FRED-format VIXCLS CSV fixture')
    args = parser.parse_args()

    if args.sox_csv:
        sox_rows = read_series_csv(args.sox_csv, 'NASDAQSOX')
    else:
        sox_rows = fetch_fred_series('NASDAQSOX')

    if args.vix_csv:
        vix_rows = read_series_csv(args.vix_csv, 'VIXCLS')
    else:
        vix_rows = fetch_fred_series('VIXCLS')

    rows = run_pipeline(sox_rows, vix_rows)
    paths = export_json_outputs(rows, args.output_dir)
    for key, path in paths.items():
        print(f'{key}: {path}')
    latest = next(row for row in reversed(rows) if row.get('top_risk_score') is not None)
    print(
        'latest:',
        latest['date'],
        f"close={latest['close']:.2f}",
        f"OH={latest['oh_score']}/5",
        f"RF={latest['rf_score']}/5",
        f"Top={latest['top_risk_score']}/5",
        f"confirmed={latest['confirmed_top_risk']}",
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
