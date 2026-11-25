# Pump.fun Sharpe Sprint — SteadyClip Paper Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Wanxt27/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Wanxt27/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. One program, `main.ts` (Node 22), speaking the `agent-fun/replay/v2` protocol: it reads `hello` / `batch` / `done` NDJSON on stdin and answers each batch with one `reply` carrying its orders. Paper trading only — no real funds, ever.

## Strategy — SteadyClip

Long-only momentum clipper: buy small, steady clips on young coins that are rising without having faded yet, exit fast. Built to maximise hourly Sharpe on a 6-hour replay: many small, controlled round trips instead of one moonshot.

- **Price** per token (SOL) = virtual quote reserves / virtual token reserves, sampled per batch into a short rolling window per mint.
- **Buy** a mint once, ever, when: ≥8 trades seen, price up ≥12% vs 8 samples ago, price within 3% of its 8-sample high (reversion filter — a coin that spiked and already faded is skipped), price ≤ +45% vs first-seen price, and the coin is young (≤80 trades). Max 5 open positions.
- **Size** 0.08 SOL per buy, capped at 90% of the mint's per-order size cap, never below the 0.01 SOL round-trip gate.
- **Sell** the whole position on take-profit +12%, stop-loss −4%, a trailing exit (arms at +10%, out on a −4% pullback from the peak), a fade exit (−8% off the recent high), a dead-money exit (under +5% after 20 trades), or a 30-trade max hold.
- **Never re-buys** a mint, never shorts. Deterministic: no clock, no environment, no randomness; mints considered in first-seen order.

## Dev grade (kit's `grade-local`, `--driver process`, `--stress 5`)

- Net PnL **−0.308 SOL** on the dev window (90% interval −0.486 … −0.144 SOL), return −3.1%
- **41 coins** traded, 41 round trips (≥ 0.01 SOL each), 77 fills, win rate 7.3%
- Max drawdown **3.3%** — guardrails met (≥ 20 coins, drawdown ≤ 50%)
- Two executions reproduce byte for byte (deterministic); 8 orders rejected, 1 failed
- Fees: 0.061 SOL curve + 0.009 SOL tx; net PnL at 2× fees −0.373 SOL
- Stress: 5 block surrogates, median −0.25 SOL, 5 of 5 lost money
- Top 3 coins made 100% of the gains; without them net PnL is −0.31 SOL

Note: two risk/exit revisions (tighter TP/SL/trailing, plus fade and dead-money exits) produced a byte-identical action log on this dev window — its price moves are jump-dominated, so both exit parameter sets trigger on the same batches. The dev window is a hard tape for momentum (most coins fade right after their first spike). PnL is below holding cash on this window, so it would rank but win no prize here; the final tape is recorded after entries close, so the same rules run on unseen coins.

## Run

```sh
node main.ts  # reads agent-fun/replay/v2 NDJSON on stdin, replies on stdout
```

## License

MIT — see [LICENSE](LICENSE).
