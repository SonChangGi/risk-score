#!/usr/bin/env python3
"""Sync deployable Risk Score static assets into the Quant Dashboard Pages tree."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = Path('/Users/changgison/projects/quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score')

DEPLOY_ITEMS = ['index.html', 'assets', 'data']


def copy_item(src: Path, dst: Path) -> None:
    if dst.exists():
        if dst.is_dir():
            shutil.rmtree(dst)
        else:
            dst.unlink()
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=DEFAULT_TARGET)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    missing = [item for item in DEPLOY_ITEMS if not (ROOT / item).exists()]
    if missing:
        raise SystemExit(f'missing deploy item(s): {", ".join(missing)}')

    print(f'sync target: {args.target}')
    for item in DEPLOY_ITEMS:
        src = ROOT / item
        dst = args.target / item
        print(f'{src} -> {dst}')
        if not args.dry_run:
            copy_item(src, dst)
    if not args.dry_run:
        print('sync complete')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
