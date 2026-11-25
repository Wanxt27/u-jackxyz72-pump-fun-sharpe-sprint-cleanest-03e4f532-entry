// SteadyClip — a paper-trading bot for the Pump.fun Sharpe Sprint.
// Long-only momentum clipper: buy small, steady clips on young coins that are
// rising without having faded yet, exit fast on take-profit / stop-loss /
// trailing pullback / max hold. Built to maximise hourly Sharpe on a 6h replay:
// many small, controlled round trips instead of one moonshot.
//
// Strategy (original, composed from the agent-fun/replay/v2 SDK interface):
//  - Price per token (SOL) = virtual_quote_reserves / virtual_token_reserves.
//  - Each batch, sample every live curve's price into a short rolling window.
//  - BUY a mint once, ever, when ALL of these hold:
//      * at least 8 trades seen on the curve (real activity, not a fresh shell),
//      * price up >= 12% vs 8 samples ago (momentum),
//      * price within 3% of its 8-sample high (reversion filter: a coin that
//        spiked and already faded is skipped),
//      * price <= +45% vs its first-seen price (not overextended),
//      * young: at most 80 trades since creation (early in its life),
//      * fewer than 5 open/committed positions, enough free cash.
//    Size 0.08 SOL per buy, capped at 90% of the mint's per-order size cap,
//    never below the 0.01 SOL round-trip gate.
//  - SELL the whole position when any of these hits:
//      * take-profit +25% vs fee-inclusive entry cost per token,
//      * stop-loss -6%,
//      * trailing: once +15% up, exit on a -5% pullback from the peak,
//      * max hold: 50 trades after the buy.
//  - Never short, never re-buy a mint, never touch the clock, the environment
//    or Math.random: every decision is a pure function of the harness state,
//    so the two grading executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const BUY_SOL = 0.08; // SOL per buy
const MIN_TRADES = 8; // trades before a mint is eligible
const MOMENTUM_WINDOW = 8; // samples back for the momentum read
const MOMENTUM_MIN = 0.12; // +12% over the window
const FADE_BAND = 0.03; // must sit within 3% of the window high
const OVEREXTENDED = 0.45; // skip if +45% above first-seen price
const MAX_TRADES_YOUNG = 80; // young-coin ceiling, in trades
const TAKE_PROFIT = 0.12; // +12% — bank the clip sooner; +25% almost never prints on this tape
const STOP_LOSS = -0.04; // -4% — cut losers tighter
const TRAIL_ARM = 0.1; // trailing arms at +10%
const TRAIL_PULLBACK = 0.04; // exit on -4% from the peak
const MAX_HOLD_TRADES = 30; // max hold, in trades after the buy
const MAX_SLIPPAGE_BPS = 500;
const MAX_POSITIONS = 5;

interface Track {
  firstPrice: number;
  samples: number[]; // recent sampled prices, oldest first, capped
  buyPrice: number; // fee-inclusive entry cost per token (SOL), 0 when flat
  buyTrades: number; // curve.trades when the buy filled
  peak: number; // highest price seen since the buy
  bought: boolean; // bought once already (never re-buy)
  sellPending: boolean;
}

const tracks = new Map<string, Track>();
let fillsSeen = 0;
let buysFilled = 0;
let sellsFilled = 0;

function priceOf(curve: {
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
}): number {
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

function trackFor(mint: string, price: number): Track {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstPrice: price,
      samples: [],
      buyPrice: 0,
      buyTrades: 0,
      peak: 0,
      bought: false,
      sellPending: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state, batch) {
    const out: {
      side: 'buy' | 'sell';
      mint: string;
      quote_lamports?: bigint;
      token_amount?: bigint;
      max_slippage_bps: number;
    }[] = [];

    // Fold fills first: record entry prices, clear tracks on exits.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      fillsSeen++;
      const curve = state.curves.get(fill.mint);
      if (fill.side === 'buy') {
        buysFilled++;
        const t = trackFor(fill.mint, curve ? priceOf(curve) : 0);
        const tokens = BigInt(fill.token_amount);
        const spent = BigInt(fill.quote_lamports);
        t.buyPrice = tokens > 0n ? Number(spent) / Number(tokens) / 1e9 : 0;
        t.buyTrades = curve ? curve.trades : 0;
        t.peak = t.buyPrice;
        t.bought = true;
      } else {
        sellsFilled++;
        const t = tracks.get(fill.mint);
        if (t !== undefined) {
          t.buyPrice = 0;
          t.peak = 0;
          t.sellPending = false;
        }
      }
    }

    // Sample prices for every live curve.
    for (const [mint, curve] of state.curves) {
      if (curve.complete) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      const t = trackFor(mint, price);
      t.samples.push(price);
      if (t.samples.length > 24) t.samples.shift();
    }

    // Exits first: free slots before considering new entries.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const t = tracks.get(mint);
      if (curve === undefined || t === undefined || t.buyPrice <= 0 || t.sellPending) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      const ret = price / t.buyPrice - 1;
      if (ret > 0 && price > t.peak) t.peak = price;
      const trailHit =
        t.peak > t.buyPrice * (1 + TRAIL_ARM) && price <= t.peak * (1 - TRAIL_PULLBACK);
      const stale = curve.trades - t.buyTrades >= MAX_HOLD_TRADES;
      // Dead money: after 20 trades the clip is still under +5% — free the
      // slot for a fresher coin instead of babysitting a flat line.
      const deadMoney = curve.trades - t.buyTrades >= 20 && ret < 0.05;
      // Fade exit: the coin has fallen 8% off its recent 8-sample high, so the
      // momentum that justified the buy is gone — get out before it bleeds.
      let fadeExit = false;
      if (t.samples.length >= MOMENTUM_WINDOW) {
        let high = 0;
        for (let i = t.samples.length - MOMENTUM_WINDOW; i < t.samples.length; i++) {
          if (t.samples[i] > high) high = t.samples[i];
        }
        fadeExit = high > 0 && price < high * 0.92;
      }
      if (ret >= TAKE_PROFIT || ret <= STOP_LOSS || trailHit || stale || deadMoney || fadeExit) {
        t.sellPending = true;
        out.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // Entries: young rising coins that have not faded, one buy per mint ever.
    if (state.committedPositionCount() < MAX_POSITIONS) {
      for (const [mint, curve] of state.curves) {
        if (out.length >= 16) break;
        if (state.committedPositionCount() >= MAX_POSITIONS) break;
        if (curve.complete || curve.trades < MIN_TRADES) continue;
        if (curve.trades > MAX_TRADES_YOUNG) continue;
        if (state.positions.has(mint)) continue;
        if (state.pending.size > 0) {
          let pendingBuy = false;
          for (const p of state.pending.values()) {
            if (p.order.side === 'buy' && p.order.mint === mint) pendingBuy = true;
          }
          if (pendingBuy) continue;
        }
        const t = tracks.get(mint);
        if (t === undefined || t.bought) continue;
        if (t.samples.length < MOMENTUM_WINDOW + 1) continue;
        const price = t.samples[t.samples.length - 1];
        const back = t.samples[t.samples.length - 1 - MOMENTUM_WINDOW];
        if (back <= 0 || price / back - 1 < MOMENTUM_MIN) continue;
        let high = 0;
        for (let i = t.samples.length - MOMENTUM_WINDOW; i < t.samples.length; i++) {
          if (t.samples[i] > high) high = t.samples[i];
        }
        if (price < high * (1 - FADE_BAND)) continue;
        if (price > t.firstPrice * (1 + OVEREXTENDED)) continue;

        const cap = state.maxBuyLamports(mint);
        let amount = BigInt(Math.floor(BUY_SOL * 1e9));
        const cap90 = (cap * 90n) / 100n;
        if (amount > cap90) amount = cap90;
        if (amount < 10_000_000n) continue; // below the 0.01 SOL round-trip gate
        if (amount > state.freeCashLamports() - state.txFeeLamports()) continue;
        t.bought = true; // claim the mint now; the fill confirms the entry
        out.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    return out;
  },

  onDone(state) {
    mkdirSync('/output', { recursive: true });
    const summary = {
      strategy: 'SteadyClip',
      batches: state.seq + 1,
      fills: fillsSeen,
      buys_filled: buysFilled,
      sells_filled: sellsFilled,
      distinct_mints_traded: tracks.size,
      final_cash_lamports: state.cash.toString(),
      open_positions: state.positions.size,
    };
    writeFileSync('/output/summary.json', JSON.stringify(summary, null, 2) + '\n');
  },
});
