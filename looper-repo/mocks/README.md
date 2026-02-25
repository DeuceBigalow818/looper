# Mock Contracts for LoopExecutor Testing

Two mock contracts that simulate the MOTO token and Stash lending pool for regtest integration testing.

## Contracts

### MockMoto (`mock-moto/`)

A standard OP20 token with a deployer-only `mint()` function. Mirrors the MOTO token interface.

**Methods (in addition to standard OP20):**

| Method | Access | Description |
|--------|--------|-------------|
| `mint(to, amount)` | Deployer only | Mint tokens to any address |

### MockStash (`mock-stash/`)

A simplified lending pool that implements the exact interface LoopExecutor expects from Stash.

**Lending parameters:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| LTV | 66% | Max borrow = 66% of deposited collateral |
| Liquidation threshold | 80% | Health factor = (deposits × 80%) / debt |
| Health factor format | 18-decimal FP | 1.0 = `1000000000000000000` |

**Methods:**

| Method | Description |
|--------|-------------|
| `deposit(token, amount)` | Supply collateral (pulls via transferFrom) |
| `borrow(token, amount)` | Borrow against collateral (sends tokens) |
| `repay(token, amount)` | Repay debt (pulls via transferFrom) |
| `withdraw(token, amount)` | Withdraw collateral (sends tokens) |
| `healthFactor(account)` | Returns health factor in 18-dec FP |
| `borrowBalanceOf(account)` | Returns outstanding debt |
| `maxBorrowable(account)` | Returns max additional borrowable amount |
| `depositBalanceOf(account)` | Returns collateral balance |
| `setToken(address)` | Admin: change accepted token |

## Build

```bash
# Build MockMoto
cd mock-moto
npm uninstall assemblyscript 2>/dev/null
npm install
npm run build

# Build MockStash
cd ../mock-stash
npm uninstall assemblyscript 2>/dev/null
npm install
npm run build

# Build LoopExecutor
cd ../loop-staking-executor
npm uninstall assemblyscript 2>/dev/null
npm install
npm run build
```

## Regtest Test Flow

### Step 1: Deploy contracts

Deploy in this order:

1. **MockMoto** — no calldata needed
2. **MockStash** — calldata: `[mockMotoAddress]`
3. **LoopExecutor** — calldata: `[treasuryAddress, mockStashAddress, mockMotoAddress]`

### Step 2: Seed balances

```
MockMoto.mint(testUser, 10_000e18)        # Give user MOTO to test with
MockMoto.mint(mockStashAddress, 100_000e18) # Give Stash reserves to lend from
```

### Step 3: Open a position

```
# User approves LoopExecutor to spend MOTO
MockMoto.approve(loopExecutorAddress, 1_000e18)

# User opens a 2x leveraged position with 1000 MOTO
LoopExecutor.openPosition(1_000e18, 2_000000000000000000)
#                         amount    targetLeverageE18 (2x)
```

**Expected behaviour:**
- Entry fee: 1000 × 0.5% = 5 MOTO → treasury
- Net deposit: 995 MOTO
- Loop iteration 1: Deposit 995, borrow 995 × 66% ≈ 656.7
- Loop iteration 2: Deposit 656.7, borrow remaining to reach ~1990 target
- Health factor checked after each borrow (must be ≥ 1.5)
- Final position: ~1990 deposited, ~995 debt → effective ~2x leverage

### Step 4: Verify position

```
LoopExecutor.getPosition(testUser) → (totalDeposit, totalDebt)
```

### Step 5: Close the position

```
LoopExecutor.closePosition()
```

**Expected behaviour:**
- Withdraw collateral from Stash
- Repay debt to Stash
- Net proceeds = collateral - debt
- Exit fee: net × 0.5% → treasury
- Remainder → user

### Step 6: Verify cleanup

```
LoopExecutor.getPosition(testUser) → (0, 0)
```

## Health Factor Math Example

With 66% LTV and 80% liquidation threshold:

```
User deposits 995 MOTO
Borrows 656.7 MOTO (66% of 995)

Health Factor = (995 × 0.80) × 1e18 / 656.7
             = 796 × 1e18 / 656.7
             ≈ 1.212e18

That's 1.21 — BELOW the 1.5 minimum!
```

This means at 66% LTV the LoopExecutor will NOT be able to borrow the full 66% on each iteration — it will be capped by the 1.5 health factor requirement. The loop will borrow less aggressively, which is the intended safety behaviour.

At 66% LTV, the effective max single-loop borrow is about 53% of collateral to maintain HF ≥ 1.5. Over 5 iterations this still achieves meaningful leverage (~1.9x–2.3x).

## Directory Structure

```
mock-moto/
├── src/
│   ├── index.ts
│   └── MockMoto.ts
├── package.json
├── asconfig.json
└── tsconfig.json

mock-stash/
├── src/
│   ├── index.ts
│   ├── MockStash.ts
│   └── events/
│       ├── DepositEvent.ts
│       ├── BorrowEvent.ts
│       ├── RepayEvent.ts
│       └── WithdrawEvent.ts
├── package.json
├── asconfig.json
└── tsconfig.json
```
