# risk-score

SOX Index 단기 고점 위험을 뉴스가 아닌 가격·추세·변동성 기반으로 스코어링하고, 동일한 risk-overlay 구조를 반도체 개별 종목/ETF까지 확장한 정적 GitHub Pages 대시보드입니다.

## What it shows

- **SOX OH/RF Score (0~5)**: 기존 SOX 과열형 top risk와 rebound-failure risk model을 그대로 유지합니다.
- **Asset OH/RF Score (0~5)**: 개별 종목/ETF에는 volatility-adjusted momentum(`ROC20Z`)과 relative strength(`RelZ20`)를 적용합니다.
- **Top Risk Score**: `max(OH Score, RF Score)`인 0~5 regime ladder입니다. SOX canonical score와 개별 자산 score는 같은 확률 척도가 아닙니다.
- **Sector context**: SOX high-risk/confirmed 상태, VIX rising, optional VXN rising을 자산 신호의 context로 표시하고, asset date와 SOX/VIX context date가 다르면 `stale` warning을 냅니다.
- **Benchmark semantics**: ETF의 `officialBenchmark`(발행사/공식 기준)와 이 대시보드의 `analysisBenchmark`(상대강도/섹터 해석 참조)를 분리합니다. SOX는 analysis reference일 수 있지만 모든 ETF의 공식 추종지수라는 의미가 아닙니다.
- **Confirmation vs Actionable**: `asset_confirmed_risk`(자산 자체 rollover)와 `asset_actionable_signal`(자산 confirmation + sector context)을 분리합니다.
- **Backtest**: 신호 후 미래 5거래일 absolute downside/strict top과 volatility-adjusted label, daily statistics, 5D cooldown event-level statistics, base-rate lift.
- **Economic validation**: 개별 자산 primary rule의 event-level volatility-adjusted downside lift가 base rate를 이기지 못하면 confidence를 낮추고 warning을 표시합니다. 추가로 validation score, best/weak rules, score-bucket diagnostics, cross-asset validation을 노출해 신호가 실제로 경제적으로 의미 있는지 확인합니다.
- **Data quality**: manual CSV override, Yahoo chart primary, optional Financial Modeling Prep fallback(`FMP_API_KEY`)의 provider attempts와 latest lag를 JSON/UI에 표시합니다.
- **Universe matrix**: SOX, MU, INTC, MRVL, WDC, SNDK, STX, 005930.KS, 000660.KS, SOXX, SMH, XSD, PSI, DRAM을 한눈에 비교합니다.

본 페이지는 투자 조언이 아니라 개인 리서치용 risk overlay입니다.

## Data sources

Required generated-data sources:

- SOX daily close: FRED `NASDAQSOX` (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=NASDAQSOX`)
- VIX daily close: FRED `VIXCLS` (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS`)
- Optional VXN close: FRED `VXNCLS` (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=VXNCLS`)
- US stock/ETF adjusted close: Yahoo chart endpoint used only by the local update script.
- Optional authenticated fallback: Financial Modeling Prep historical EOD endpoint, enabled only when `FMP_API_KEY` is set. Yahoo adjusted close remains the no-key primary path; FMP `adjClose` is preferred when available and otherwise carries an adjustment-policy warning.
- Korean stock adjusted close: Yahoo chart endpoint (`005930.KS`, `000660.KS`) plus `KRW=X` for USD conversion when available; `^KS11` is the local benchmark fallback.
- Manual fallback/override: `data/risk-score/manual_prices/{symbol}.csv` or `public/data/risk-score/manual_prices/{symbol}.csv` with `date, open, high, low, close, adj_close, volume`. Use this for provider outages or audited exports.
- Stooq CSV is not used as an automated fallback in this runtime because the endpoint returned a JavaScript/browser challenge during verification; it remains a manual-source candidate rather than a production provider.

Optional/source-note only in v1:

- Nasdaq SOX overview: `https://indexes.nasdaqomx.com/Index/Overview/SOX`
- iShares SOXX page: `https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf` (ETF official benchmark metadata; SOX remains an analysis reference when configured)
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

- Existing SOX contract files:
  - `data/risk-score/risk_score_daily.json`
  - `data/risk-score/risk_score_summary.json`
  - `data/risk-score/risk_score_backtest.json`
- New multi-asset files:
  - `data/risk-score/asset_universe.json`
  - `data/risk-score/asset_risk_daily.json`
  - `data/risk-score/asset_risk_summary.json`
  - `data/risk-score/asset_risk_backtest.json`
  - `data/risk-score/data_status.json`

`risk_score_summary.json` follows the Quant Dashboard `quant-research-summary` contract so the central hub can show OH/RF/top/confirmation metrics. The multi-asset extension adds new files rather than renaming existing fields.

Current multi-asset JSON exports include date/meaning diagnostics such as `sectorContextAsOf`, `sectorContextLagDays`, `sectorContextStatus`, `latestScoredDate`, `analysisBenchmark`, `officialBenchmark`, and `economicValidation`.

## Deploy/sync to Quant Dashboard route

The requested public route is:

```text
https://sonchanggi.github.io/quant-dashboard/risk-score/
```

The implementation keeps this repo as the source of truth and mirrors deployable static files into the Quant Dashboard Pages tree:

```bash
python3 scripts/sync_to_quant_dashboard.py
```

Default target:

```text
/Users/changgison/projects/quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score/
```

Only `index.html`, `assets/`, and `data/` are synced. The central Quant Dashboard project/link/summary contract is otherwise kept intact.

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

## Economic validation diagnostics

For non-SOX assets the dashboard reports:

- **Primary event-level rule lift** over the asset's own volatility-adjusted 5D downside base rate.
- **Validation score (0-100)** from best primary rule lift, event count, and high-risk-vs-normal score-bucket lift. This is diagnostic, not a probability.
- **Best/weak/validated rules** so SOXX-like ETF differences are visible instead of hidden.
- **Score-bucket diagnostics** comparing Top Risk >= 4 outcomes with score <= 2 outcomes.
- **Cross-asset validation** by group to show whether the fixed methodology generalizes across US stocks, Korea stocks, and ETFs.

The model still avoids ticker-specific threshold optimization. Strong validation means the fixed rule set has useful historical downside lift for that asset; weak validation means the score should be used only as a descriptive risk overlay.

## Model formulas

Daily close only. No future data is used for signals.

Core SOX indicators: `MA5`, `MA20`, `MA50`, `STD20`, `z20`, `ROC10`, `ROC20`, `gap20`, `drawdown50`, `rebound20`, `MA20_slope5`, `RSI5`, `RSI14`. Asset indicators add `RV20`, `ROC20Z`, `DD50Z`, `Rebound20Z`, `Relative Strength`, `RelZ20`, and RS MA slopes.

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

Asset OH Score:

```text
1[z20 > 1.5]
+ 1[RSI5 > 70]
+ 1[ROC20Z > 1.25]
+ 1[P >= 0.995 * High20]
+ 1[RelZ20 > 1.0]
```

Asset RF Score:

```text
1[P < MA50 OR DD50Z < -1.0]
+ 1[Rebound20Z > 0.75]
+ 1[near MA20/MA50 resistance]
+ 1[ROC20Z < 0.5 OR MA20_slope5 < 0]
+ 1[RS < RS_MA20 OR RS_MA20_slope5 < 0]
```

Asset confirmation/actionability:

```text
asset_confirmed_risk = recent_asset_setup AND (P < MA5 OR ret_1 <= -max(2%, 0.75*RV20) OR RS < RS_MA5)
asset_actionable_signal = asset_confirmed_risk AND sector_context_active
```

Sector context freshness:

```text
fresh  = selected asset date has a valid same-day scored SOX/VIX context
stale  = selected asset date uses the latest prior valid SOX/VIX context
unavailable = no valid prior SOX/VIX context exists
```

Vol-adjusted label:

```text
vol_adj_downside = fwd_min_5 <= -1.5 * RV20 * sqrt(5)
vol_adj_strict_top = fwd_max_5 <= 0.5 * RV20 * sqrt(5) AND vol_adj_downside
```

## Known limitations

- FRED/Nasdaq/CBOE source data can lag or revise.
- Leading score can fire before a top is confirmed.
- Backtest hit rates describe historical distributions and are not future-performance guarantees.
- Optional sentiment/fundamental panels are not in v1 main score.
- Yahoo chart adjusted-close access is no-key and best-effort; manual CSV override plus optional FMP API-key fallback exist for provider outages, with provider attempts and adjustment policy recorded in JSON.
- Korean FX mismatch is handled by USDKRW when available; if FX is unavailable, local KOSPI relative strength is shown with warning instead of pretending KRW/SOX comparability.
- SNDK and DRAM have short standalone histories, so event-level confidence is flagged low until more data accumulates.
- Public deployment is served from the Quant Dashboard subtree; run the sync command plus `verify_quant_dashboard_sync.py` before publishing to prevent canonical/deploy drift.
- SOXX and other ETF signals can be economically weaker than SOX despite similar sector exposure because the asset model is volatility/relative-strength adjusted and the ETF official benchmark/exposure may differ from SOX. The dashboard surfaces this through benchmark metadata and validation confidence instead of forcing scores to match.

## Future improvements

- Manual AAII/CNN CSV adapters for optional sentiment panels.
- Per-asset lazy JSON splitting if the universe grows materially beyond the default 14 symbols.
- Fundamental revision/valuation divergence panel for 1~3 month cycle risk.
- Screenshot-based visual regression after public deployment.
