// Pump.fun Paper Sprint — "Fresh-Launch Momentum Flip".
//
// Paper trading only: this bot trades virtual SOL on the replay harness,
// never real funds, never a real wallet. One program, main.ts, Node 22.
//
// Idea: on pump.fun most fresh coins die fast and a few run hard in their
// first minutes. So the bot buys a coin once the tape proves early demand
// (price already +5% over its creation price — in practice the size cap
// binds first: real reserves must reach 2 SOL before a 0.05 SOL buy fits
// the 1% per-order cap), stakes a small fixed 0.05 SOL, then flips it:
// take profit at +100%, cut the loss at -20%, or exit on time after
// 30,000 slots. Small stakes + quick exits recycle the 10 SOL capital
// across many coins, which is also what the guardrails want (round trips
// of >= 0.01 SOL on at least 20 distinct mints).
//
// Determinism: the harness executes every entry twice and the two action
// logs must match byte for byte, so this bot never reads the clock, the
// environment or Math.random. All decisions come from the hello/batch
// state the harness hands over, in event order. Prices are compared with
// integer cross-multiplication (no floats), so results are exact.
//
// The hello message opens the run, each batch carries the slot's events,
// fills and marks, and the orders decided on a batch fill two slots later.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tunables ---------------------------------------------------------------
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_CAP_LAMPORTS = LAMPORTS_PER_SOL / 50n; // need cap >= 0.02 SOL
const BUY_TRIGGER_BPS = 10_500; // price +5% vs creation price
const CANDIDATE_MAX_AGE_SLOTS = 15_000; // give up waiting for momentum
const TAKE_PROFIT_BPS = 20_000; // entry price +100%: let winners run
const STOP_LOSS_BPS = 8_000; // entry price -20%
const MAX_HOLD_SLOTS = 30_000; // time exit
const BUY_SLIPPAGE_BPS = 10_000; // wide open: never miss the entry on latency
const SELL_SLIPPAGE_BPS = 500; // 5%: sells must not dump into thin air

/** Price as a virtual-reserve ratio: quote per token, kept as a pair. */
interface Price {
  quote: bigint;
  token: bigint;
}

/** A coin seen since its CreateEvent, waiting for its momentum trigger. */
interface Candidate {
  firstPrice: Price;
  firstSlot: number;
}

/** A coin we bought: what we paid (decision-time price) and when. */
interface Entry {
  entryPrice: Price;
  entrySlot: number;
}

const candidates = new Map<string, Candidate>();
const entries = new Map<string, Entry>();
const pendingSell = new Set<string>();

/** Ratio of `now` over `base`, in basis points (10000 = unchanged). */
function priceBps(now: Price, base: Price): bigint {
  if (base.quote === 0n || base.token === 0n || now.token === 0n) return 10_000n;
  return (now.quote * base.token * 10_000n) / (base.quote * now.token);
}

function curvePrice(state: BotState, mint: string): Price | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return {
    quote: curve.virtual_quote_reserves,
    token: curve.virtual_token_reserves,
  };
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Clear sell flags whose orders are no longer in flight: their fill
    // already came back (filled, rejected or failed), so the coin may be
    // sold again. Sells sent in this batch are added below.
    {
      const inFlightSell = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') inFlightSell.add(p.order.mint);
      }
      for (const mint of [...pendingSell]) {
        if (!inFlightSell.has(mint)) pendingSell.delete(mint);
      }
    }

    // 1. Register fresh coins, drop stale candidates, buy the ones whose
    //    early tape shows real demand. The first price comes from the
    //    CreateEvent's own virtual reserves: the shim's curve already holds
    //    the whole batch's trades by the time onBatch runs, so reading the
    //    price from state here would miss the pump inside the creation
    //    batch itself (most coins hit +5% in that very batch).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (
          !candidates.has(e.mint) &&
          !entries.has(e.mint) &&
          BigInt(e.virtual_token_reserves) > 0n
        ) {
          candidates.set(e.mint, {
            firstPrice: {
              quote: BigInt(e.virtual_quote_reserves),
              token: BigInt(e.virtual_token_reserves),
            },
            firstSlot: e.slot,
          });
        }
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const cand = candidates.get(e.mint);
      if (cand === undefined) continue;
      const price = curvePrice(state, e.mint);
      if (price === null) {
        candidates.delete(e.mint);
        continue;
      }
      const move = priceBps(price, cand.firstPrice);
      if (batch.slot - cand.firstSlot > CANDIDATE_MAX_AGE_SLOTS) {
        candidates.delete(e.mint); // never showed momentum: skip for good
        continue;
      }
      if (move < BUY_TRIGGER_BPS) continue; // still waiting for momentum
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_CAP_LAMPORTS) continue; // too thin to size yet:
      // keep the candidate and retry on a later batch, do NOT drop it
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (slots <= 0 || free < amount + tx) continue; // retry later instead
      candidates.delete(e.mint);
      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      } satisfies BuyInput);
      entries.set(e.mint, { entryPrice: price, entrySlot: batch.slot });
      free -= amount + tx;
      slots -= 1;
    }

    // 2. Manage open positions: take profit, stop loss, or time exit.
    //    Sells are full-position; one sell in flight per mint at a time.
    for (const [mint, holding] of state.positions) {
      const entry = entries.get(mint);
      if (entry === undefined || pendingSell.has(mint)) continue;
      const price = curvePrice(state, mint);
      if (price === null) continue;
      const move = priceBps(price, entry.entryPrice);
      const timedOut = batch.slot - entry.entrySlot >= MAX_HOLD_SLOTS;
      if (move >= TAKE_PROFIT_BPS || move <= STOP_LOSS_BPS || timedOut) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        } satisfies SellInput);
        pendingSell.add(mint);
      }
    }

    // 3. Forget entries whose position is gone and no order for that mint
    //    is in flight (a buy that was rejected never becomes a position).
    //    Orders sent in THIS batch are not in state.pending yet (the shim
    //    records them only after onBatch returns), so count them too —
    //    otherwise a fresh entry is deleted in the very batch that bought it.
    {
      const inFlight = new Set<string>();
      for (const p of state.pending.values()) inFlight.add(p.order.mint);
      for (const o of orders) inFlight.add(o.mint);
      for (const mint of [...entries.keys()]) {
        if (!state.positions.has(mint) && !inFlight.has(mint)) {
          entries.delete(mint);
        }
      }
    }

    return orders;
  },
});
