# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-06-30
- Primary product surfaces:
  - `index.html` SOX & Asset Top Risk Score static page
  - `assets/styles.css` risk-score visual system
  - `assets/app.js` static JSON renderer and SVG charts
  - `data/risk-score/*.json` generated public payloads
  - `scripts/update_risk_score_data.py` data/model/export pipeline
  - Quant Dashboard integration: `../quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/assets/app.js` project registry/summary adapter
- Evidence reviewed:
  - Quant Dashboard hub `index.html`, `assets/app.js`, `assets/styles.css`, `DESIGN.md` for project cards, Research Cockpit, summary panels, data-health states, and public JSON adapter patterns.
  - SOX cockpit worktree `index.html`, `assets/styles.css`, `assets/app.js`, `data/summary.json` for dark semiconductor dashboard palette, metric cards, table density, back-link convention, and proxy/source caveats.
  - Port cockpit `DESIGN.md` and `assets/styles.css` for dark quant cockpit hierarchy, status chips, static JSON boundary, and bidirectional Quant Dashboard navigation.
  - Risk-score task seed and FRED CSV probes for NASDAQSOX/VIXCLS static data pipeline feasibility.

## Brand
- Personality: institutional short-term risk overlay cockpit; calm, precise, audit-friendly, and semantically colored.
- Trust signals: explicit data freshness, source status, model formulas, no-news/no-advice language, OH/RF separation, confirmation distinction, and backtest base-rate comparison.
- Avoid: trading recommendations, threshold optimization language, fabricated sentiment/fundamental data, browser-side live finance fetching, and disconnected bright SaaS styling.

## Product goals
- Goals:
  - Show current SOX and selected semiconductor-related asset short-term top risk from price/trend/volatility/relative strength only.
  - Preserve economic interpretation by separating Overheated-top and Rebound-failure models.
  - Make confirmation filters and historical event-level hit rates visible before action copy.
  - Fit visually and operationally inside the Quant Dashboard static Pages family.
- Non-goals:
  - No news/NLP model, no intraday trading signal, no threshold tuning to recent outcomes, no direct investment advice.
  - Optional sentiment and fundamental data are documented/adapter-ready only; SOX main score remains SOX+VIX while the asset extension adds generated Yahoo/manual price adapters.
- Success signals:
  - Latest close/OH/RF/top/confirmation/actionable status render from generated JSON.
  - Backtest tables show daily and declustered event statistics across full/recent/YTD/ex-2026 windows.
  - Quant Dashboard can link to `/quant-dashboard/risk-score/` and summarize the Risk Score payload without importing local sibling source.

## Personas and jobs
- Primary personas: individual quant/research operator, semiconductor-cycle watcher, Quant Dashboard maintainer.
- User jobs:
  - Check whether current SOX strength is overheating or a lower-high rebound failure.
  - See whether leading setup has confirmed with price/VIX rollover.
  - Compare model rules against single-indicator baselines and event-level historical outcomes.
  - Navigate from Quant Dashboard to Risk Score and back without losing source/methodology context.
- Key contexts of use: daily GitHub Pages read, local refresh/script execution, mobile scan of current risk, desktop review of backtest tables.

## Information architecture
- Primary navigation: top `← Back to Quant Dashboard` link plus section anchors for Assets, Summary, Matrix, Factors, Charts, Backtest, Signals, Methodology.
- Core routes/screens: single static page deployable at repo root or subdirectory `/quant-dashboard/risk-score/` with relative assets/data.
- Content hierarchy:
  1. Header with latest date and source/freshness status.
  2. Asset selector and grouped universe chips.
  3. Asset risk matrix.
  4. Current risk summary cards and action overlay language.
  5. Factor breakdown table with thresholds and model ownership.
  6. Price/score/relative-strength/VIX-VXN charts with semantic markers.
  7. Backtest toggles: event-level first, daily secondary, vol-adjusted label primary for assets.
  8. Signal history table.
  9. Data/methodology/limitations and optional data adapters.

## Design principles
- Principle 1: Model separation before composite score.
- Principle 2: Leading risk is not a trade; confirmation and limitations stay adjacent.
- Principle 3: Static-data integrity over live-browser convenience.
- Principle 4: Color means risk state only; charts/tables remain readable without decorative noise.
- Tradeoffs: dense finance tables are acceptable if sticky/scroll-safe and paired with summary cards.

## Visual language
- Color: dark Quant Dashboard family base `#080a0f`, layered slate panels, cyan/violet accents, green/yellow/orange/red semantic risk colors. Red is reserved for red zone/confirmed risk, amber for watch/high risk, green for normal.
- Typography: system/Pretendard/Inter stack, tabular numeric figures for financial metrics, Korean/English finance copy.
- Spacing/layout rhythm: 8px grid; 18-28px panel padding; responsive summary grids collapse before tables overflow.
- Shape/radius/elevation: 18-28px cards, pill badges, subtle borders/shadows, no heavy neon.
- Motion: minimal hover/focus only; respect reduced motion.
- Imagery/iconography: no logos; use text badges and SVG charts/tooltips.

## Components
- Existing components to reuse:
  - Quant Dashboard/SOX-style hero, top nav, metric cards, `panel`, `table-wrap`, `status-chip`, `score-pill`, source/caveat panels.
- New/changed components:
  - Asset selector, grouped universe chips, and clickable risk matrix.
  - Factor breakdown table with on/off badges and economic interpretation.
  - Lightweight SVG chart renderer for price/score/VIX with markers and `<title>` tooltips.
  - Backtest mode toggles for event-level vs daily stats and absolute vs volatility-adjusted labels.
  - Signal history table with latest notable risk events.
  - Optional sentiment/fundamental adapter cards clearly marked inactive/manual.
- Variants and states: loading, stale, degraded, normal, watch, high-risk, red-zone, confirmed-red, optional-unavailable.
- Token/component ownership: repo-native CSS variables in `assets/styles.css`; no new frontend framework.

## Accessibility
- Target standard: WCAG 2.1 AA-oriented static dashboard.
- Keyboard/focus behavior: visible focus ring on links/buttons/toggles; no hover-only required information.
- Contrast/readability: dark surfaces with readable muted text, table row separation, chart labels with sufficient contrast.
- Screen-reader semantics: labelled sections, table captions, status `aria-live`, SVG titles/aria labels.
- Reduced motion and sensory considerations: decorative transitions only and disabled under `prefers-reduced-motion`.

## Responsive behavior
- Supported breakpoints/devices: 360px mobile, tablet, desktop research monitor.
- Layout adaptations: summary/factor panels stack; wide tables horizontally scroll; charts keep min heights and avoid clipping markers.
- Touch/hover differences: buttons/toggles at least 42px tall; tooltips also encoded in visible/source text.

## Interaction states
- Loading: dark skeleton/status text while JSON fetches.
- Empty: explicit generated-data missing message and script command.
- Error: show failed static JSON and keep methodology visible.
- Success: current scores, source status, and generated timestamp are visible.
- Disabled: optional panels explain manual/adapter requirements.
- Offline/slow network: static page still loads shell; JSON fetch failure is explicit.

## Content voice
- Tone: Korean-first, cautious, research-overlay language.
- Terminology: OH Score, RF Score, Top Risk Score, Confirmation, event-level hit rate, base-rate lift, source status, stale/degraded.
- Microcopy rules: avoid “매수/매도하라”; use “검토”, “준비”, “위험 overlay”, “추가 확인”. Always state no news model and not investment advice.

## Implementation constraints
- Framework/styling system: vanilla HTML/CSS/JS, Python data pipeline; Node/Python tests; no bundler.
- Design-token constraints: follow Quant Dashboard dark-family variables; keep asset/data paths relative for subdirectory deployment.
- Performance constraints: generated daily payload can be capped for browser timelines while preserving full backtest aggregate in JSON.
- Compatibility constraints: GitHub Pages static hosting, local `python3 -m http.server`, no client secrets/API keys.
- Test/screenshot expectations: node syntax/static smoke, Python unit tests, data script execution, optional local screenshot/smoke when feasible.


## Model integrity checks
- Default SOX thresholds are literal fixed constants from the prompt and are never optimized by the update script. Asset thresholds are round-number volatility/relative-strength extensions, not fitted to YTD outcomes.
- Backtest reporting must separate daily and declustered event-level statistics, with event-level treated as primary.
- Period splits include full, recent 3 years, recent 1 year, YTD, and ex-2026; 2026/YTD cannot drive threshold changes.
- Threshold sensitivity is a diagnostic table only and cannot feed model defaults.

## Deployment and hub contract decision
- Public route decision: serve the app from Quant Dashboard's static tree at `risk-score/`, yielding `https://sonchanggi.github.io/quant-dashboard/risk-score/`.
- Source/deploy split: `risk-score` remains the canonical implementation repo; `scripts/sync_to_quant_dashboard.py` mirrors only static deploy artifacts into `/Users/changgison/projects/quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score/`.
- Hub summary contract: `data/risk-score/risk_score_summary.json` uses the existing `quant-research-summary` schema so Quant Dashboard can load it through the same adapter pattern as sibling projects.
- Protected boundary: Quant Dashboard changes are limited to the Risk Score project entry/link/card, summary adapter/fallback/parser/renderer, tests strictly needed for that new adapter/link, and the `risk-score/` deploy subtree. Existing sibling project outputs/adapters/methodology must not be changed.

## Open questions
- [x] Actual deployment owner/path: canonical source stays in `risk-score`; deployable static files are synced into `/Users/changgison/projects/quant-dashboard.omx-worktrees/launch-feat-quant-dashboard/risk-score/` to serve `/quant-dashboard/risk-score/`. Both canonical `risk-score` and Quant Dashboard worktrees have remotes; live deployment verification depends on pushing canonical updates and synced Quant Dashboard subtree updates. / owner: this implementation / impact: required for public route.
- [ ] Whether AAII/CNN sentiment should become manually uploaded CSV adapters after v1. / owner: future / impact: optional panel only.

## Multi-asset extension decisions
- Universe ownership: `config/asset_universe.json`; model logic reads config and exports `asset_universe.json` for the browser.
- Static boundary: FRED/Yahoo/manual CSV access is script/Python only. `assets/app.js` loads generated JSON files and contains no provider endpoints.
- Korea FX policy: use `KRW=X` to convert KRW prices to USD for SOX-relative strength when available; otherwise use `^KS11` local benchmark and display warning.
- Short-history policy: SNDK and DRAM carry explicit warnings and low-confidence flags regardless of current score quality.
- Backtest policy: SOX keeps canonical fixed -5% backtest; individual assets expose absolute and vol-adjusted labels with vol-adjusted event-level as primary.
