# LoOPer — One-Click Leveraged Staking on Bitcoin

<div align="center">

**Lo*OP*er** automates leveraged staking via the **Stash** lending protocol and **MOTO** token on [OP_NET](https://opnet.org) — smart contracts on Bitcoin Layer 1.

Users deposit MOTO → the contract loops *deposit → borrow → re-deposit* up to **5 times**, achieving up to **3× effective leverage**.

[![OPNet](https://img.shields.io/badge/Built%20on-OPNet-0066ff?style=for-the-badge&logo=bitcoin&logoColor=white)](https://opnet.org)
[![License](https://img.shields.io/badge/License-Proprietary-red?style=for-the-badge)](LICENSE)
[![Audit](https://img.shields.io/badge/Audit-Passed-00aa00?style=for-the-badge)](docs/LoopExecutor-ReAudit-Report.md)

</div>

---

## How It Works

```
User deposits MOTO
       │
       ▼
┌─────────────────────────────────────────┐
│  LoOPer Contract                        │
│                                         │
│  1. Deduct 0.5% entry fee → Treasury    │
│  2. Supply MOTO to Stash as collateral  │
│  3. Borrow more MOTO from Stash         │
│  4. Re-supply borrowed MOTO             │
│  5. Repeat (up to 5 loops)              │
│  6. Enforce Health Factor ≥ 1.5         │
│                                         │
│  Result: up to 3× leveraged position    │
└─────────────────────────────────────────┘
```

## Key Features

- **Leveraged Looping** — Deposit → borrow → re-deposit up to 5 iterations (MAX_LOOPS = 5)
- **Target Leverage** — User-specified, capped at 3×
- **Entry / Exit Fees** — 0.5% each, rounded UP to favour the protocol
- **Health Factor** — Enforced ≥ 1.5 after every loop iteration
- **Single Position** — Only one active position at a time (prevents shared Stash collisions)
- **Pause / Unpause** — Admin can pause new deposits; `closePosition` always works
- **Iterative Unwind** — `closePosition` safely unwinds via partial withdraw → repay loops

## Project Structure

```
looper/
├── src/
│   ├── index.ts                    # Entry point (factory + abort)
│   ├── LoopExecutor.ts             # Main contract (~860 lines)
│   └── events/
│       ├── PositionOpenedEvent.ts   # Emitted on openPosition
│       ├── PositionClosedEvent.ts   # Emitted on closePosition
│       ├── EmergencyPausedEvent.ts  # Emitted on pause/unpause
│       ├── TreasuryUpdatedEvent.ts  # Emitted on setTreasury
│       ├── StashUpdatedEvent.ts     # Emitted on setStash
│       └── MotoUpdatedEvent.ts      # Emitted on setMoto
├── ui/
│   └── index.html                  # Win95-themed frontend (self-contained)
├── mocks/
│   ├── mock-stash/                 # Stash lending pool mock
│   └── mock-moto/                  # MOTO OP20 token mock
├── docs/
│   ├── LoopExecutor-Audit-Report.md
│   └── LoopExecutor-ReAudit-Report.md
├── scripts/
│   └── deploy-regtest.ts           # Deployment script
├── test/
│   └── loopExecutor.test.ts        # Unit tests (OP_VM)
├── package.json
├── asconfig.json
├── tsconfig.json
└── README.md
```

## UI Preview

The frontend is a **Windows 95-themed** single-page application with full staking functionality:

- **Deposit tab** — Amount input, leverage slider (1×–3×), position summary with health factor
- **Withdraw tab** — Active position view, one-click close with iterative unwind
- **Info tab** — Protocol parameters, security info, how-it-works guide
- **Win95 chrome** — Title bars, taskbar, desktop icons, meme sidebars, ticker bar

Open `ui/index.html` in any browser — no build step needed, fully self-contained.

## Audit Status

All findings from the initial audit have been addressed:

| Finding | Severity | Status |
|---------|----------|--------|
| C-01: Reentrancy guard rollback | Critical | ✅ Documented |
| H-01: approve → increaseAllowance | High | ✅ Fixed |
| H-02: closePosition deadlock | High | ✅ Iterative unwind |
| H-03: Multi-user collision | High | ✅ Single position cap |
| H-04: Fee rounding | High | ✅ Round UP + min deposit |
| M-01: Stale debt display | Medium | Known limitation (snapshot) |
| M-02: Missing events | Medium | ✅ Added |
| M-03: Dead owner field | Medium | ✅ Removed |
| L-01: closePosition when paused | Low | ✅ Always allowed |

Full reports: [`docs/LoopExecutor-Audit-Report.md`](docs/LoopExecutor-Audit-Report.md) · [`docs/LoopExecutor-ReAudit-Report.md`](docs/LoopExecutor-ReAudit-Report.md)

## Build

```bash
# Install dependencies
npm install

# Build all contracts (LoopExecutor + mocks)
npm run build:all

# Or individually
npm run build              # LoopExecutor only
npm run build:release      # Release build (optimized)
npm run build:mocks        # MockStash + MockMoto
```

## Test

Unit tests run against the real OP_VM via `@btc-vision/unit-test-framework`.

```bash
# Prerequisites: build all contracts first
npm run build:all

# Copy WASM to test bytecodes directory
cp build/LoopExecutor.wasm test/bytecodes/
cp mocks/mock-stash/build/MockStash.wasm test/bytecodes/
cp mocks/mock-moto/build/MockMoto.wasm test/bytecodes/

# Run tests
npm test
```

Test coverage: openPosition (1×/2×/3× leverage, fees, min deposit, max leverage, duplicate position), closePosition (fund return, non-owner rejection, close-while-paused, re-open after close), Admin (pause/unpause, access control, address updates).

## Deploy to Regtest

```bash
# Set mnemonic
export MNEMONIC="your twelve word mnemonic ..."

# Deploy all 3 contracts
npm run deploy:regtest
```

Deployment order: MockMoto → MockStash → LoopExecutor (addresses wired automatically).

**Deployment calldata:** `onDeployment` expects `[treasury: Address, stash: Address, moto: Address]`

## Contract Interface

| Method | Access | Description |
|--------|--------|-------------|
| `openPosition(uint256, uint256)` | Public | Deposit MOTO with target leverage |
| `closePosition()` | Position owner | Unwind and return funds |
| `getPosition(address)` | View | Returns (deposit, debt) |
| `isPaused()` | View | Check pause status |
| `getTotalFeesCollected()` | View | Total protocol fees |
| `pause()` / `unpause()` | Admin | Emergency pause |
| `setTreasury(address)` | Admin | Update fee recipient |
| `setStash(address)` | Admin | Update Stash address |
| `setMoto(address)` | Admin | Update MOTO address |

## Protocol Parameters

| Parameter | Value |
|-----------|-------|
| Max Leverage | 3.0× |
| Max Loop Iterations | 5 |
| Entry Fee | 0.50% (ceil) |
| Exit Fee | 0.50% (ceil) |
| Min Deposit | 10,000 MOTO |
| Min Health Factor | 1.50 |

## Tech Stack

- **Smart Contract** — AssemblyScript → WASM (OPNet runtime)
- **Runtime** — `@btc-vision/btc-runtime`
- **Testing** — `@btc-vision/unit-test-framework` (OP_VM)
- **Frontend** — Vanilla HTML/CSS/JS (Windows 95 theme)
- **Blockchain** — Bitcoin Layer 1 via OP_NET

## Remaining Items for Mainnet

- N-01: Fix allowance overflow risk (use exact amounts instead of u256.Max)
- N-02: Calculate proceeds from actual balance, not stored snapshots

## License

Proprietary — All rights reserved.
