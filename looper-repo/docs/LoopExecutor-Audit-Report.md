# LoopExecutor Security Audit Report

**Contract:** LoopExecutor.ts (1003 lines, AssemblyScript / OPNet btc-runtime)
**Author:** Bob (AI-Assisted Audit)
**Date:** 2026-02-24
**Methodology:** OPNet Security Audit Guidelines + TypeScript Law 2026 + Complete Vulnerability Catalog

---

> **⚠️ DISCLAIMER:** This audit is AI-assisted and may contain errors, false positives, or miss critical vulnerabilities. This is NOT a substitute for a professional security audit. Do NOT deploy to mainnet based solely on this review.

---

## Executive Summary

This report covers the LoopExecutor smart contract, a one-click leveraged staking system integrating with the Stash lending protocol and MOTO token on OPNet. The audit identified **1 critical, 4 high, 3 medium, and 3 low/informational findings**.

The most impactful finding is an architectural concern: all user positions share a single Stash account (the LoopExecutor contract address), causing multi-user accounting collisions. Additionally, the `closePosition` unwind logic may deadlock against Stash's withdrawal health check, and the fee calculation rounds in the user's favor.

---

## Findings Summary

| ID | Title | Severity |
|----|-------|----------|
| C-01 | Reentrancy Guard Not Released on Revert Path | **CRITICAL** |
| H-01 | `approve()` Used Instead of `increaseAllowance()` | **HIGH** |
| H-02 | `closePosition` Unwind May Deadlock Against Stash Health Check | **HIGH** |
| H-03 | Shared Stash Position — Multi-User Accounting Collision | **HIGH** |
| H-04 | Fee Rounding Direction Favors User (Zero-Fee Dust Deposits) | **HIGH** |
| M-01 | Stored Debt Drifts from Actual Stash Debt (Interest Accrual) | MEDIUM |
| M-02 | No Events on `setStash()` / `setMoto()` | MEDIUM |
| M-03 | Unused `owner` StoredAddress (Dead Code) | MEDIUM |
| L-01 | No Emergency Escape for Positions When Paused | LOW |
| L-02 | No Maximum Deposit Cap | LOW |
| I-01 | View `@method()` Decorators Have No Params | INFO |

---

## Critical Findings

### C-01: Reentrancy Guard Not Released on Revert Path

**Severity:** CRITICAL (conditionally mitigated by runtime)

The manual reentrancy guard sets `locked=true` at method entry via `nonReentrant()` and releases via `releaseGuard()` before the return statement. If ANY code between these two points causes a revert — health factor check, `Blockchain.call()` failure, SafeMath underflow — `releaseGuard()` is never called.

**Affected lines:** `openPosition` (335→457), `closePosition` (484→575)

**Mitigation:** OPNet's runtime atomically rolls back ALL storage mutations on transaction revert, which means the lock is also rolled back. This makes the issue theoretical for current runtime behavior.

**However:** This assumption is undocumented in the contract and creates a fragile dependency on runtime internals. Any future runtime change that allows partial storage commits would instantly brick the contract.

**Recommendation:**
1. Confirm with OPNet runtime team that storage is atomically rolled back on revert
2. Add a prominent code comment documenting this assumption
3. If confirmed, downgrade to LOW

---

## High Findings

### H-01: `approve()` Used Instead of `increaseAllowance()`

**Severity:** HIGH — OPNet antipattern (ATK-05 / H-12)

**Lines:** 380, 498, 563

The contract uses `safeApprove()` with the OP20 `approve()` selector (`0x095ea7b3`). OPNet explicitly recommends `increaseAllowance()`/`decreaseAllowance()` to prevent the classic approve race condition.

While the LoopExecutor is the sole caller of its own approvals (mitigating the race in practice), this violates OPNet security standards.

**Fix:** Replace `APPROVE_SEL` with `INCREASE_ALLOWANCE_SEL = encodeSelector('increaseAllowance(address,uint256)')`. Replace the zero-reset on line 563 with `decreaseAllowance`.

---

### H-02: `closePosition` Unwind May Deadlock Against Stash Health Check

**Severity:** HIGH — User funds can become permanently stuck

In `closePosition()`, the contract attempts:
1. `stashWithdraw(withdrawForRepay)` — withdraw collateral to get tokens
2. `stashRepay(withdrawForRepay)` — repay debt with those tokens

**Problem:** Stash's `withdraw()` enforces a health check. Withdrawing collateral equal to the debt amount while debt remains outstanding crashes the health factor below 1.0. Stash rejects the withdrawal, the entire `closePosition` reverts, and user funds remain locked.

**This creates a deadlock:** the user needs to repay debt to withdraw, but needs to withdraw to get tokens to repay.

**Fix options:**
- **(A)** Implement an iterative unwind loop: withdraw a safe fraction → repay → repeat
- **(B)** Coordinate with Stash for an atomic `repayAndWithdraw` function
- **(C)** If Stash allows, call a flash-loan pattern to repay first, then withdraw all

---

### H-03: Shared Stash Position — Multi-User Accounting Collision

**Severity:** HIGH — Architectural design concern

The LoopExecutor interacts with Stash using `Blockchain.contract.address` for ALL deposit/borrow/repay/withdraw/query operations. This means ALL user positions are aggregated into a single Stash position.

**Consequences:**
1. `healthFactor()` returns the **aggregate** health, not per-user. One user's risky 3x position affects health checks for all users.
2. `maxBorrowable()` returns total remaining capacity, consumable by any user's `openPosition`.
3. `closePosition` queries `stashBorrowBalance()` and `stashDepositBalance()` which return **aggregate** values, not the calling user's portion. A user closing their position would attempt to repay/withdraw the entire pool's balance, not just their own.
4. Interest accrual applies to aggregate debt, distorting per-user accounting.

**Fix:** For MVP, restrict to single active position globally (add a `positionCount` counter capped at 1). For multi-user: use stored per-user values from `userDeposits`/`userDebts` for accounting in `closePosition` rather than querying Stash aggregate balances.

---

### H-04: Fee Rounding Direction Favors User

**Severity:** HIGH — Slow drain via rounding (ATK-13 / H-19)

Fee calculation: `entryFee = (amount × 50) / 10000`

`SafeMath.div` truncates (rounds toward zero). For amounts not divisible by 200, the fee is rounded DOWN:

- `amount = 199` → fee = 9950 / 10000 = **0** (zero fee!)
- `amount = 399` → fee = 19950 / 10000 = **1** (0.25% instead of 0.5%)

Any deposit under 200 base units pays zero entry fee. Over many transactions, this accumulates as protocol revenue loss.

**Fix:** Round UP (protocol-favoring):
```
fee = (amount × FEE_BPS + FEE_BASIS - 1) / FEE_BASIS
```
Or enforce a minimum deposit (e.g., 1000+ units) so rounding is negligible.

---

## Medium Findings

### M-01: Stored Debt Drifts from Actual Stash Debt

`userDebts` stores a snapshot from `openPosition` time. If Stash accrues interest, the stored value diverges from actual debt. `getPosition()` returns stale data. `closePosition` correctly queries the live Stash balance, so the unwind itself is accurate — but user-facing data is misleading.

**Fix:** Make `getPosition()` query Stash for live values, or document that stored values are snapshots.

### M-02: No Events on `setStash()` / `setMoto()`

These admin functions change critical contract addresses but emit no events. Off-chain monitoring cannot track these changes. Add `StashUpdated` and `MotoUpdated` events.

### M-03: Unused `owner` StoredAddress (Dead Code)

The `owner` StoredAddress (line 177) is set in `onDeployment` using `Blockchain.tx.origin` but is never read for access control. All admin functions use `onlyDeployer()` from `OP_NET` base class, which has its own deployer tracking. The `owner` field wastes a storage pointer.

**Fix:** Remove the unused `owner`/`ownerPointer`, or implement a `transferOwnership` pattern.

---

## Low / Informational

### L-01: No Emergency Escape for Positions When Paused

If the contract is paused, `closePosition` is blocked by `whenNotPaused()`. User funds remain locked with no escape. Consider allowing `closePosition` while paused, or adding an `emergencyWithdraw` function.

### L-02: No Maximum Deposit Cap

No cap on per-user or total deposits. A single large deposit could exhaust Stash's lending capacity, blocking other users.

### I-01: View `@method()` Decorators Have No Params

Several view methods (`isPausedView`, `getTreasuryView`, etc.) use `@method()` with no arguments. This is correct for parameterless methods — noted for completeness only.

---

## Passed Checks ✅

| Check | Result |
|-------|--------|
| All u256 arithmetic uses SafeMath | ✅ PASS |
| No `while` loops | ✅ PASS — bounded `for` (MAX_LOOPS=5) |
| No f32/f64 floats | ✅ PASS |
| No Buffer usage | ✅ PASS — BytesWriter/Uint8Array only |
| No built-in AssemblyScript Map | ✅ PASS — uses AddressMemoryMap |
| Admin access control (onlyDeployer) | ✅ PASS |
| Input validation (zero, bounds) | ✅ PASS |
| Constructor has no business logic | ✅ PASS |
| Storage pointers via Blockchain.nextPointer | ✅ PASS — all unique |
| @method decorators declare all params | ✅ PASS |
| Events on major state changes | ✅ PASS (except setStash/setMoto) |
| SafeERC20 return value checks | ✅ PASS |
| stopOnFailure=true on all Blockchain.call() | ✅ PASS |
| Bounded loop gas | ✅ PASS — MAX_LOOPS=5 |
| @final on contract class | ✅ PASS |
| callMethod() delegates to super | ✅ PASS |
| BytesWriter sizes match written data | ✅ PASS |
| No Blockchain.log() calls | ✅ PASS |
| No decorator imports | ✅ PASS |

---

## Prioritised Recommendations

1. **CRITICAL:** Confirm OPNet runtime storage rollback on revert (C-01). Document assumption.
2. **HIGH:** Replace `approve()` with `increaseAllowance()`/`decreaseAllowance()` (H-01).
3. **HIGH:** Redesign `closePosition` as iterative partial-repay-then-withdraw loop (H-02).
4. **HIGH:** Restrict to single concurrent position or fix multi-user accounting (H-03).
5. **HIGH:** Fix fee rounding to round UP or enforce minimum deposit (H-04).
6. **MEDIUM:** Add missing events, remove dead `owner` field (M-01 through M-03).
7. **LOW:** Allow `closePosition` while paused or add `emergencyWithdraw` (L-01).
