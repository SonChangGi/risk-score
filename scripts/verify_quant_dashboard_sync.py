#!/usr/bin/env python3
"""Fail if the Quant Dashboard deploy subtree has drifted from canonical Risk Score files."""
from __future__ import annotations

import argparse
import filecmp
import json
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from sync_to_quant_dashboard import DEFAULT_TARGET, DEPLOY_ITEMS, ROOT


def compare_paths(src: Path, dst: Path) -> list[str]:
    problems: list[str] = []
    if not dst.exists():
        return [f'missing target path: {dst}']
    if src.is_file():
        if not dst.is_file():
            return [f'target is not a file: {dst}']
        if not filecmp.cmp(src, dst, shallow=False):
            return [f'file drift: {src.relative_to(ROOT)} != {dst}']
        return []
    if not dst.is_dir():
        return [f'target is not a directory: {dst}']

    src_files = sorted(path for path in src.rglob('*') if path.is_file())
    dst_files = sorted(path for path in dst.rglob('*') if path.is_file())
    src_rel = {path.relative_to(src) for path in src_files}
    dst_rel = {path.relative_to(dst) for path in dst_files}
    for rel in sorted(src_rel - dst_rel):
        problems.append(f'missing target file: {dst / rel}')
    for rel in sorted(dst_rel - src_rel):
        problems.append(f'extra target file: {dst / rel}')
    for rel in sorted(src_rel & dst_rel):
        if not filecmp.cmp(src / rel, dst / rel, shallow=False):
            problems.append(f'file drift: {(src / rel).relative_to(ROOT)} != {dst / rel}')
    return problems


def build_report(target: Path) -> dict[str, Any]:
    item_reports = []
    problems: list[str] = []
    for item in DEPLOY_ITEMS:
        src = ROOT / item
        dst = target / item
        item_problems = compare_paths(src, dst)
        item_reports.append({
            'item': item,
            'source': str(src),
            'target': str(dst),
            'status': 'pass' if not item_problems else 'fail',
            'problems': item_problems,
        })
        problems.extend(item_problems)
    return {
        'status': 'pass' if not problems else 'fail',
        'sourceRoot': str(ROOT),
        'targetRoot': str(target),
        'items': item_reports,
        'problemCount': len(problems),
        'problems': problems,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=DEFAULT_TARGET)
    parser.add_argument('--json', action='store_true', help='Print machine-readable report.')
    args = parser.parse_args()

    report = build_report(args.target)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif report['status'] == 'pass':
        print(f"PASS deploy subtree matches canonical Risk Score files: {args.target}")
    else:
        print(f"FAIL deploy subtree drift detected: {args.target}")
        for problem in report['problems']:
            print(f'- {problem}')
    return 0 if report['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
