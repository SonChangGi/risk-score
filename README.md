# risk-score

SOX Index 단기 고점 위험을 뉴스가 아닌 가격·추세·변동성 기반으로 스코어링하는 정적 GitHub Pages 대시보드입니다.

## What it shows

- **OH Score (0~5)**: 강한 상승 추세 말미의 과열형 top risk.
- **RF Score (0~5)**: 손상된 추세에서 반등이 MA20/MA50 저항에 막히는 rebound-failure risk.
- **Top Risk Score**: `max(OH Score, RF Score)`.
- **Confirmation**: 최근 setup 이후 MA5 하회, 큰 하락일, VIX 상승 확인, 또는 RF-specific rollover.
- **Backtest**: 신호 후 미래 5거래일 downside/strict top label, daily statistics, 5D cooldown event-level statistics, base-rate lift.

본 페이지는 투자 조언이 아니라 개인 리서치용 risk overlay입니다.

## Data sources

Required generated-data sources:

- SOX daily close: FRED `NASDAQSOX` (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=NASDAQSOX`)
- VIX daily close: FRED `VIXCLS` (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS`)

Optional/source-note only in v1:

- Nasdaq SOX overview: `https://indexes.nasdaqomx.com/Index/Overview/SOX`
- iShares SOXX page: `https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf`
- AAII Sentiment Survey: `https://www.aaii.com/sentimentsurvey/sent_results`
- CNN Fear & Greed: `https://edition.cnn.com/markets/fear-and-greed`
- Fundamental/revision data adapters are future 1~3 month cycle-risk panels and are not part of the 1~5D main score.

The browser reads only committed/generated JSON under `data/risk-score/`; it does not fetch FRED or finance providers live.

## Local run

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/update_risk_score_data.py
python3 -m http.server 8080
# open http://localhost:8080/
```

The page is subdirectory-safe and can also be served under `/quant-dashboard/risk-score/`.

## Data update

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/update_risk_score_data.py
```

Outputs:

- `data/risk-score/risk_score_daily.json`
- `data/risk-score/risk_score_summary.json`
- `data/risk-score/risk_score_backtest.json`

`risk_score_summary.json` follows the Quant Dashboard `quant-research-summary` contract so the central hub can show OH/RF/top/confirmation metrics.

## Deploy/sync to Quant Dashboard route

The requested public route is:

```text
https://sonchanggi.github.io/quant-dashboard/risk-score/
```

Because the current `risk-score` repo has no remote, the implementation keeps this repo as the source of truth and mirrors deployable static files into the Quant Dashboard Pages tree:

```bash
python3 scripts/sync_to_quant_dashboard.py
```

Default target:

```text
/Users/changgison/projects/quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score/
```

Only `index.html`, `assets/`, and `data/` are synced.

## Verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/update_risk_score_data.py
npm test
python3 scripts/sync_to_quant_dashboard.py
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/verify_quant_dashboard_sync.py
# from quant-dashboard worktree:
# npm test
# npm run test:publish  # after public Pages deployment
```

`npm test` runs syntax checks, static contract checks, and a local nested-route smoke for `/quant-dashboard/risk-score/`, nested assets, and nested JSON.

## Model formulas

Daily close only. No future data is used for signals.

Core indicators: `MA5`, `MA20`, `MA50`, `STD20`, `z20`, `ROC10`, `ROC20`, `gap20`, `drawdown50`, `rebound20`, `MA20_slope5`, `RSI5`, `RSI14`.

OH Score:

```text
1[z20 > 1.5]
+ 1[RSI5 > 70]
+ 1[ROC20 > 0.10]
+ 1[gap20 > 0.04]
+ 1[C >= 0.995 * High20]
```

RF Score:

```text
1[prior_damage]
+ 1[rebound_from_low]
+ 1[ma_resistance]
+ 1[weak_momentum]
+ 1[vix_not_low]
```

Confirmation:

```text
confirmed_top_risk = confirmed_general OR confirmed_rf
```

where common confirmation checks price rollover, large down day, and VIX rising above MA5.

## Known limitations

- FRED/Nasdaq/CBOE source data can lag or revise.
- Leading score can fire before a top is confirmed.
- Backtest hit rates describe historical distributions and are not future-performance guarantees.
- Optional sentiment/fundamental panels are not in v1 main score.
- Public deployment is served from the Quant Dashboard subtree; run the sync command plus `verify_quant_dashboard_sync.py` before publishing to prevent canonical/deploy drift.

## Future improvements

- Manual AAII/CNN CSV adapters for optional sentiment panels.
- SOXX benchmark overlay from a stable free source.
- Fundamental revision/valuation divergence panel for 1~3 month cycle risk.
- Screenshot-based visual regression after public deployment.
