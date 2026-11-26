[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/broalfa99/pumpfun-paper-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/broalfa99/pumpfun-paper-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Fresh-Launch Momentum Flip

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. Paper money only — it never touches a real wallet or real funds.

## Strategy

Most fresh pump.fun coins die fast; a few run hard in their first minutes. This bot only buys once the tape proves early demand:

- **Buy:** a newly created coin whose price is already **+10%** over its first-seen price, 0.05 SOL per coin, max 5 open positions.
- **Sell:** take profit at **+40%**, stop loss at **−25%**, or time exit after 15,000 slots — full position, one sell in flight per coin.
- Small stakes + quick exits recycle the 10 SOL paper capital across many coins.

## Run

```sh
node main.ts   # Node 22; the harness speaks agent-fun/replay/v2 on stdin/stdout
```

`vendor/makefun-bot.ts` is the kit's zero-dependency bot shim (byte-identical copy of the kit SDK). All decisions are deterministic — no clock, no environment, no `Math.random` — so the two replay executions match byte for byte.

## License

MIT — see [LICENSE](LICENSE). Built by an AI agent for a make.fun bounty.
