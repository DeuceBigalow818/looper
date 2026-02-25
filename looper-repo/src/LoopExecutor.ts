import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    OP_NET,
    Revert,
    SafeMath,
    Selector,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';

import { PositionOpenedEvent } from './events/PositionOpenedEvent';
import { PositionClosedEvent } from './events/PositionClosedEvent';
import { EmergencyPausedEvent } from './events/EmergencyPausedEvent';
import { TreasuryUpdatedEvent } from './events/TreasuryUpdatedEvent';
import { StashUpdatedEvent } from './events/StashUpdatedEvent';
import { MotoUpdatedEvent } from './events/MotoUpdatedEvent';

/**
 * LoopExecutor — One-click leveraged staking on OPNet.
 *
 * Users deposit MOTO, which is supplied to Stash as collateral.
 * The contract then borrows additional MOTO against that collateral and
 * re-supplies it, repeating up to MAX_LOOPS times (bounded) to achieve
 * up to 3x effective leverage.
 *
 * Fee model:
 *   - 0.5 % entry fee (rounded UP to favour protocol)
 *   - 0.5 % exit fee (rounded UP to favour protocol)
 *   - Fees sent to a configurable treasury address.
 *
 * Risk constraints:
 *   - Single active position at a time (prevents shared-pool collisions)
 *   - Min deposit: 10 000 base units (prevents zero-fee dust attacks)
 *   - Max leverage cap: 3x
 *   - Health factor >= 1.5 enforced after every loop iteration
 *   - Reentrancy guard via manual StoredBoolean lock
 *   - Pause blocks openPosition; closePosition always allowed
 *
 * SECURITY NOTE — Reentrancy Guard & Storage Rollback (C-01 documented):
 *   The reentrancy guard uses a StoredBoolean lock. If a transaction
 *   reverts between nonReentrant() and releaseGuard(), the lock remains
 *   set. This is safe because OPNet's runtime atomically rolls back ALL
 *   storage mutations on transaction revert, including the lock.
 *   If OPNet ever changes to partial-commit semantics, this pattern
 *   must be revisited immediately.
 */
@final
export class LoopExecutor extends OP_NET {
    // ---------------------------------------------------------------
    //  Constants
    // ---------------------------------------------------------------

    private static readonly FEE_BASIS: u256 = u256.fromU32(10_000);
    private static readonly ENTRY_FEE_BPS: u256 = u256.fromU32(50);
    private static readonly EXIT_FEE_BPS: u256 = u256.fromU32(50);

    /** Minimum deposit to prevent zero-fee dust (H-04 fix). */
    private static readonly MIN_DEPOSIT: u256 = u256.fromU32(10_000);

    private static readonly MAX_LEVERAGE_E18: u256 = u256.fromString(
        '3000000000000000000',
    );
    private static readonly MIN_HEALTH_FACTOR_E18: u256 = u256.fromString(
        '1500000000000000000',
    );
    private static readonly E18: u256 = u256.fromString('1000000000000000000');
    private static readonly MAX_LOOPS: u32 = 5;

    // ---------------------------------------------------------------
    //  External selectors — OP20 token
    // ---------------------------------------------------------------

    private static readonly TRANSFER_FROM_SEL: u32 = 0x23b872dd;
    private static readonly TRANSFER_SEL: u32 = 0xa9059cbb;

    /** increaseAllowance instead of approve (H-01 fix). */
    private static readonly INCREASE_ALLOWANCE_SEL: u32 = encodeSelector(
        'increaseAllowance(address,uint256)',
    );
    private static readonly DECREASE_ALLOWANCE_SEL: u32 = encodeSelector(
        'decreaseAllowance(address,uint256)',
    );

    // ---------------------------------------------------------------
    //  External selectors — Stash lending pool
    // ---------------------------------------------------------------

    private static readonly STASH_DEPOSIT_SEL: u32 = encodeSelector(
        'deposit(address,uint256)',
    );
    private static readonly STASH_BORROW_SEL: u32 = encodeSelector(
        'borrow(address,uint256)',
    );
    private static readonly STASH_REPAY_SEL: u32 = encodeSelector(
        'repay(address,uint256)',
    );
    private static readonly STASH_WITHDRAW_SEL: u32 = encodeSelector(
        'withdraw(address,uint256)',
    );
    private static readonly STASH_HEALTH_FACTOR_SEL: u32 = encodeSelector(
        'healthFactor(address)',
    );
    private static readonly STASH_BORROW_BALANCE_SEL: u32 = encodeSelector(
        'borrowBalanceOf(address)',
    );
    private static readonly STASH_MAX_BORROWABLE_SEL: u32 = encodeSelector(
        'maxBorrowable(address)',
    );
    private static readonly STASH_DEPOSIT_BALANCE_SEL: u32 = encodeSelector(
        'depositBalanceOf(address)',
    );

    // ---------------------------------------------------------------
    //  Method selectors (this contract)
    // ---------------------------------------------------------------

    private readonly openPositionSel: Selector = encodeSelector(
        'openPosition(uint256,uint256)',
    );
    private readonly closePositionSel: Selector = encodeSelector(
        'closePosition()',
    );
    private readonly getPositionSel: Selector = encodeSelector(
        'getPosition(address)',
    );
    private readonly pauseSel: Selector = encodeSelector('pause()');
    private readonly unpauseSel: Selector = encodeSelector('unpause()');
    private readonly setTreasurySel: Selector = encodeSelector(
        'setTreasury(address)',
    );
    private readonly setStashSel: Selector = encodeSelector(
        'setStash(address)',
    );
    private readonly setMotoSel: Selector = encodeSelector(
        'setMoto(address)',
    );
    private readonly isPausedSel: Selector = encodeSelector('isPaused()');
    private readonly getTreasurySel: Selector = encodeSelector(
        'getTreasury()',
    );
    private readonly getStashSel: Selector = encodeSelector('getStash()');
    private readonly getMotoSel: Selector = encodeSelector('getMoto()');
    private readonly getTotalFeesCollectedSel: Selector = encodeSelector(
        'getTotalFeesCollected()',
    );

    // ---------------------------------------------------------------
    //  Storage (M-03 fix: owner removed — admin uses onlyDeployer)
    // ---------------------------------------------------------------

    private readonly treasuryPointer: u16 = Blockchain.nextPointer;
    private readonly treasury: StoredAddress = new StoredAddress(
        this.treasuryPointer,
    );

    private readonly stashPointer: u16 = Blockchain.nextPointer;
    private readonly stash: StoredAddress = new StoredAddress(
        this.stashPointer,
    );

    private readonly motoPointer: u16 = Blockchain.nextPointer;
    private readonly moto: StoredAddress = new StoredAddress(
        this.motoPointer,
    );

    private readonly pausedPointer: u16 = Blockchain.nextPointer;
    private readonly paused: StoredBoolean = new StoredBoolean(
        this.pausedPointer,
        false,
    );

    /** Reentrancy lock (C-01: rollback on revert documented above). */
    private readonly lockedPointer: u16 = Blockchain.nextPointer;
    private readonly locked: StoredBoolean = new StoredBoolean(
        this.lockedPointer,
        false,
    );

    private readonly totalFeesPointer: u16 = Blockchain.nextPointer;
    private readonly totalFeesCollected: StoredU256 = new StoredU256(
        this.totalFeesPointer,
        u256.Zero,
    );

    /**
     * H-03 fix: Only one position at a time. Zero address = no position.
     * Prevents shared Stash account collision between concurrent users.
     */
    private readonly activeUserPointer: u16 = Blockchain.nextPointer;
    private readonly activeUser: StoredAddress = new StoredAddress(
        this.activeUserPointer,
    );

    private readonly userDepositsPointer: u16 = Blockchain.nextPointer;
    private readonly userDeposits: AddressMemoryMap = new AddressMemoryMap(
        this.userDepositsPointer,
    );

    private readonly userDebtsPointer: u16 = Blockchain.nextPointer;
    private readonly userDebts: AddressMemoryMap = new AddressMemoryMap(
        this.userDebtsPointer,
    );

    // ---------------------------------------------------------------
    //  Constructor & Deployment
    // ---------------------------------------------------------------

    public constructor() {
        super();
    }

    public override onDeployment(calldata: Calldata): void {
        const treasuryAddr: Address = calldata.readAddress();
        const stashAddr: Address = calldata.readAddress();
        const motoAddr: Address = calldata.readAddress();

        this.validateNonZeroAddress(treasuryAddr, 'treasury');
        this.validateNonZeroAddress(stashAddr, 'stash');
        this.validateNonZeroAddress(motoAddr, 'moto');

        this.treasury.value = treasuryAddr;
        this.stash.value = stashAddr;
        this.moto.value = motoAddr;
    }

    // ---------------------------------------------------------------
    //  Router
    // ---------------------------------------------------------------

    public override callMethod(calldata: Calldata): BytesWriter {
        const selector: Selector = calldata.readSelector();

        switch (selector) {
            case this.openPositionSel:
                return this.openPosition(calldata);
            case this.closePositionSel:
                return this.closePosition(calldata);
            case this.getPositionSel:
                return this.getPosition(calldata);
            case this.pauseSel:
                return this.pause(calldata);
            case this.unpauseSel:
                return this.unpause(calldata);
            case this.setTreasurySel:
                return this.setTreasury(calldata);
            case this.setStashSel:
                return this.setStash(calldata);
            case this.setMotoSel:
                return this.setMoto(calldata);
            case this.isPausedSel:
                return this.isPausedView(calldata);
            case this.getTreasurySel:
                return this.getTreasuryView(calldata);
            case this.getStashSel:
                return this.getStashView(calldata);
            case this.getMotoSel:
                return this.getMotoView(calldata);
            case this.getTotalFeesCollectedSel:
                return this.getTotalFeesCollectedView(calldata);
            default:
                return super.callMethod(calldata);
        }
    }

    // ===============================================================
    //  openPosition
    // ===============================================================

    @method(
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'targetLeverageE18', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('PositionOpened')
    public openPosition(calldata: Calldata): BytesWriter {
        this.whenNotPaused();
        this.nonReentrant();

        const sender: Address = Blockchain.tx.sender;
        const amount: u256 = calldata.readU256();
        const targetLeverageE18: u256 = calldata.readU256();

        // --- Validation (H-04: min deposit enforced) ---
        if (u256.lt(amount, LoopExecutor.MIN_DEPOSIT)) {
            throw new Revert('Amount below minimum deposit');
        }
        if (u256.gt(targetLeverageE18, LoopExecutor.MAX_LEVERAGE_E18)) {
            throw new Revert('Leverage exceeds 3x cap');
        }
        if (u256.lt(targetLeverageE18, LoopExecutor.E18)) {
            throw new Revert('Leverage must be >= 1x');
        }

        // H-03: Only one position globally at a time
        if (!this.activeUser.value.equals(Address.zero())) {
            throw new Revert('Another position is already active');
        }

        // --- Pull MOTO ---
        this.safeTransferFrom(
            this.moto.value,
            sender,
            Blockchain.contract.address,
            amount,
        );

        // --- Entry fee (H-04: rounded UP) ---
        const entryFee: u256 = this.feeRoundUp(
            amount,
            LoopExecutor.ENTRY_FEE_BPS,
        );
        const netDeposit: u256 = SafeMath.sub(amount, entryFee);

        if (u256.gt(entryFee, u256.Zero)) {
            this.safeTransfer(this.moto.value, this.treasury.value, entryFee);
            this.totalFeesCollected.set(
                SafeMath.add(this.totalFeesCollected.get(), entryFee),
            );
        }

        // --- Allowance for Stash (H-01: increaseAllowance) ---
        this.safeIncreaseAllowance(
            this.moto.value,
            this.stash.value,
            u256.Max,
        );

        // --- Leverage loop ---
        let totalDeposited: u256 = u256.Zero;
        let totalBorrowed: u256 = u256.Zero;
        let currentAmount: u256 = netDeposit;

        const targetTotalDeposit: u256 = SafeMath.div(
            SafeMath.mul(netDeposit, targetLeverageE18),
            LoopExecutor.E18,
        );

        for (let i: u32 = 0; i < LoopExecutor.MAX_LOOPS; i++) {
            if (u256.eq(currentAmount, u256.Zero)) {
                break;
            }

            this.stashDeposit(currentAmount);
            totalDeposited = SafeMath.add(totalDeposited, currentAmount);

            if (u256.gte(totalDeposited, targetTotalDeposit)) {
                break;
            }

            const maxBorrowable: u256 = this.stashMaxBorrowable();
            if (u256.eq(maxBorrowable, u256.Zero)) {
                break;
            }

            const remaining: u256 = SafeMath.sub(
                targetTotalDeposit,
                totalDeposited,
            );
            const borrowAmount: u256 = u256.lt(maxBorrowable, remaining)
                ? maxBorrowable
                : remaining;

            if (u256.eq(borrowAmount, u256.Zero)) {
                break;
            }

            this.stashBorrow(borrowAmount);
            totalBorrowed = SafeMath.add(totalBorrowed, borrowAmount);
            this.enforceHealthFactor();

            currentAmount = borrowAmount;
        }

        this.enforceHealthFactor();

        // --- Store position ---
        this.activeUser.value = sender;
        this.userDeposits.set(sender, totalDeposited);
        this.userDebts.set(sender, totalBorrowed);

        this.emitEvent(
            new PositionOpenedEvent(
                sender,
                amount,
                totalDeposited,
                totalBorrowed,
                entryFee,
            ),
        );

        this.releaseGuard();

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  closePosition (L-01: always allowed even when paused)
    // ===============================================================

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('PositionClosed')
    public closePosition(calldata: Calldata): BytesWriter {
        // L-01 FIX: No whenNotPaused() — users can always exit
        this.nonReentrant();

        const sender: Address = Blockchain.tx.sender;
        const storedDeposit: u256 = this.userDeposits.get(sender);

        if (u256.eq(storedDeposit, u256.Zero)) {
            throw new Revert('No open position');
        }
        if (!this.activeUser.value.equals(sender)) {
            throw new Revert('Not position owner');
        }

        // --- Live Stash balances ---
        let remainingDebt: u256 = this.stashBorrowBalance();
        let remainingCollateral: u256 = this.stashDepositBalance();

        // --- Allowance for repayment (H-01: increaseAllowance) ---
        this.safeIncreaseAllowance(
            this.moto.value,
            this.stash.value,
            u256.Max,
        );

        // --- H-02 FIX: Iterative unwind ---
        // Withdraw safe fraction → repay → repeat until debt = 0.
        for (let i: u32 = 0; i < LoopExecutor.MAX_LOOPS; i++) {
            if (u256.eq(remainingDebt, u256.Zero)) {
                break;
            }
            if (u256.eq(remainingCollateral, u256.Zero)) {
                break;
            }

            // Calculate safe withdrawal amount:
            // If collateral > debt, the excess can be safely withdrawn.
            // Otherwise withdraw half of collateral to stay healthy.
            let withdrawAmount: u256 = SafeMath.div(
                remainingCollateral,
                u256.fromU32(2),
            );

            if (u256.gt(remainingCollateral, remainingDebt)) {
                const excess: u256 = SafeMath.sub(
                    remainingCollateral,
                    remainingDebt,
                );
                if (u256.gt(excess, withdrawAmount)) {
                    withdrawAmount = excess;
                }
            }

            if (u256.eq(withdrawAmount, u256.Zero)) {
                withdrawAmount = u256.One;
            }
            if (u256.gt(withdrawAmount, remainingCollateral)) {
                withdrawAmount = remainingCollateral;
            }

            this.stashWithdraw(withdrawAmount);

            // Repay as much as possible from withdrawn tokens
            const repayAmount: u256 = u256.lt(withdrawAmount, remainingDebt)
                ? withdrawAmount
                : remainingDebt;

            if (u256.gt(repayAmount, u256.Zero)) {
                this.stashRepay(repayAmount);
                remainingDebt = SafeMath.sub(remainingDebt, repayAmount);
            }

            remainingCollateral = SafeMath.sub(
                remainingCollateral,
                withdrawAmount,
            );
        }

        // Withdraw any remaining collateral (debt should be zero now)
        if (u256.gt(remainingCollateral, u256.Zero)) {
            this.stashWithdraw(remainingCollateral);
        }

        // Safety check: ensure no residual debt
        const residualDebt: u256 = this.stashBorrowBalance();
        if (u256.gt(residualDebt, u256.Zero)) {
            throw new Revert('Unwind incomplete: residual debt remains');
        }

        // --- Net proceeds from stored values ---
        // Since this is a single-user system, stored values are authoritative
        // for the original principal. Actual P&L = what contract holds after unwind.
        const storedDebt: u256 = this.userDebts.get(sender);
        const netProceeds: u256 = u256.gt(storedDeposit, storedDebt)
            ? SafeMath.sub(storedDeposit, storedDebt)
            : u256.Zero;

        // --- Exit fee (H-04: rounded UP) ---
        let exitFee: u256 = u256.Zero;
        let userReceives: u256 = netProceeds;

        if (u256.gt(netProceeds, u256.Zero)) {
            exitFee = this.feeRoundUp(
                netProceeds,
                LoopExecutor.EXIT_FEE_BPS,
            );
            userReceives = SafeMath.sub(netProceeds, exitFee);

            if (u256.gt(exitFee, u256.Zero)) {
                this.safeTransfer(
                    this.moto.value,
                    this.treasury.value,
                    exitFee,
                );
                this.totalFeesCollected.set(
                    SafeMath.add(this.totalFeesCollected.get(), exitFee),
                );
            }
            if (u256.gt(userReceives, u256.Zero)) {
                this.safeTransfer(this.moto.value, sender, userReceives);
            }
        }

        // --- Clear position ---
        this.userDeposits.set(sender, u256.Zero);
        this.userDebts.set(sender, u256.Zero);
        this.activeUser.value = Address.zero();

        // H-01: reset allowance with decreaseAllowance
        this.safeDecreaseAllowance(
            this.moto.value,
            this.stash.value,
            u256.Max,
        );

        this.emitEvent(
            new PositionClosedEvent(
                sender,
                storedDeposit,
                storedDebt,
                userReceives,
                exitFee,
            ),
        );

        this.releaseGuard();

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  Views
    // ===============================================================

    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'deposit', type: ABIDataTypes.UINT256 },
        { name: 'debt', type: ABIDataTypes.UINT256 },
    )
    public getPosition(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(64);
        response.writeU256(this.userDeposits.get(user));
        response.writeU256(this.userDebts.get(user));
        return response;
    }

    @method()
    @returns({ name: 'paused', type: ABIDataTypes.BOOL })
    public isPausedView(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(this.paused.get());
        return response;
    }

    @method()
    @returns({ name: 'treasury', type: ABIDataTypes.ADDRESS })
    public getTreasuryView(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(32);
        response.writeAddress(this.treasury.value);
        return response;
    }

    @method()
    @returns({ name: 'stash', type: ABIDataTypes.ADDRESS })
    public getStashView(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(32);
        response.writeAddress(this.stash.value);
        return response;
    }

    @method()
    @returns({ name: 'moto', type: ABIDataTypes.ADDRESS })
    public getMotoView(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(32);
        response.writeAddress(this.moto.value);
        return response;
    }

    @method()
    @returns({ name: 'totalFees', type: ABIDataTypes.UINT256 })
    public getTotalFeesCollectedView(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(32);
        response.writeU256(this.totalFeesCollected.get());
        return response;
    }

    // ===============================================================
    //  Admin
    // ===============================================================

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('EmergencyPaused')
    public pause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.set(true);
        this.emitEvent(new EmergencyPausedEvent(Blockchain.tx.sender, true));
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('EmergencyPaused')
    public unpause(_calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this.paused.set(false);
        this.emitEvent(new EmergencyPausedEvent(Blockchain.tx.sender, false));
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method({ name: 'newTreasury', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('TreasuryUpdated')
    public setTreasury(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const newTreasury: Address = calldata.readAddress();
        this.validateNonZeroAddress(newTreasury, 'treasury');
        const oldTreasury: Address = this.treasury.value;
        this.treasury.value = newTreasury;
        this.emitEvent(new TreasuryUpdatedEvent(oldTreasury, newTreasury));
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    /** M-02 FIX: event emitted on Stash address change. */
    @method({ name: 'newStash', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('StashUpdated')
    public setStash(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const newStash: Address = calldata.readAddress();
        this.validateNonZeroAddress(newStash, 'stash');
        const oldStash: Address = this.stash.value;
        this.stash.value = newStash;
        this.emitEvent(new StashUpdatedEvent(oldStash, newStash));
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    /** M-02 FIX: event emitted on MOTO address change. */
    @method({ name: 'newMoto', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('MotoUpdated')
    public setMoto(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const newMoto: Address = calldata.readAddress();
        this.validateNonZeroAddress(newMoto, 'moto');
        const oldMoto: Address = this.moto.value;
        this.moto.value = newMoto;
        this.emitEvent(new MotoUpdatedEvent(oldMoto, newMoto));
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  Internal helpers
    // ===============================================================

    private nonReentrant(): void {
        if (this.locked.get()) {
            throw new Revert('Reentrant call');
        }
        this.locked.set(true);
    }

    private releaseGuard(): void {
        this.locked.set(false);
    }

    private whenNotPaused(): void {
        if (this.paused.get()) {
            throw new Revert('Contract is paused');
        }
    }

    private validateNonZeroAddress(addr: Address, label: string): void {
        if (addr.equals(Address.zero())) {
            throw new Revert(`${label} cannot be zero address`);
        }
    }

    /**
     * H-04 FIX: fee rounded UP (ceil) to favour protocol.
     * ceil(amount * bps / basis) = (amount * bps + basis - 1) / basis
     */
    private feeRoundUp(amount: u256, bps: u256): u256 {
        const numerator: u256 = SafeMath.mul(amount, bps);
        return SafeMath.div(
            SafeMath.add(
                numerator,
                SafeMath.sub(LoopExecutor.FEE_BASIS, u256.One),
            ),
            LoopExecutor.FEE_BASIS,
        );
    }

    private enforceHealthFactor(): void {
        const hf: u256 = this.stashHealthFactor();
        if (u256.lt(hf, LoopExecutor.MIN_HEALTH_FACTOR_E18)) {
            throw new Revert('Health factor below minimum 1.5');
        }
    }

    // --- Safe OP20 helpers (H-01: increaseAllowance/decreaseAllowance) ---

    private safeTransferFrom(
        token: Address, from: Address, to: Address, amount: u256,
    ): void {
        const w: BytesWriter = new BytesWriter(100);
        w.writeSelector(LoopExecutor.TRANSFER_FROM_SEL);
        w.writeAddress(from);
        w.writeAddress(to);
        w.writeU256(amount);
        const r = Blockchain.call(token, w, true);
        if (r.data.byteLength > 0 && !r.data.readBoolean()) {
            throw new Revert('transferFrom failed');
        }
    }

    private safeTransfer(token: Address, to: Address, amount: u256): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.TRANSFER_SEL);
        w.writeAddress(to);
        w.writeU256(amount);
        const r = Blockchain.call(token, w, true);
        if (r.data.byteLength > 0 && !r.data.readBoolean()) {
            throw new Revert('transfer failed');
        }
    }

    private safeIncreaseAllowance(
        token: Address, spender: Address, amount: u256,
    ): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.INCREASE_ALLOWANCE_SEL);
        w.writeAddress(spender);
        w.writeU256(amount);
        const r = Blockchain.call(token, w, true);
        if (r.data.byteLength > 0 && !r.data.readBoolean()) {
            throw new Revert('increaseAllowance failed');
        }
    }

    private safeDecreaseAllowance(
        token: Address, spender: Address, amount: u256,
    ): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.DECREASE_ALLOWANCE_SEL);
        w.writeAddress(spender);
        w.writeU256(amount);
        const r = Blockchain.call(token, w, true);
        if (r.data.byteLength > 0 && !r.data.readBoolean()) {
            throw new Revert('decreaseAllowance failed');
        }
    }

    // --- Stash cross-contract calls ---

    private stashDeposit(amount: u256): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.STASH_DEPOSIT_SEL);
        w.writeAddress(this.moto.value);
        w.writeU256(amount);
        Blockchain.call(this.stash.value, w, true);
    }

    private stashBorrow(amount: u256): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.STASH_BORROW_SEL);
        w.writeAddress(this.moto.value);
        w.writeU256(amount);
        Blockchain.call(this.stash.value, w, true);
    }

    private stashRepay(amount: u256): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.STASH_REPAY_SEL);
        w.writeAddress(this.moto.value);
        w.writeU256(amount);
        Blockchain.call(this.stash.value, w, true);
    }

    private stashWithdraw(amount: u256): void {
        const w: BytesWriter = new BytesWriter(68);
        w.writeSelector(LoopExecutor.STASH_WITHDRAW_SEL);
        w.writeAddress(this.moto.value);
        w.writeU256(amount);
        Blockchain.call(this.stash.value, w, true);
    }

    private stashHealthFactor(): u256 {
        const w: BytesWriter = new BytesWriter(36);
        w.writeSelector(LoopExecutor.STASH_HEALTH_FACTOR_SEL);
        w.writeAddress(Blockchain.contract.address);
        const r = Blockchain.call(this.stash.value, w, true);
        return r.data.readU256();
    }

    private stashBorrowBalance(): u256 {
        const w: BytesWriter = new BytesWriter(36);
        w.writeSelector(LoopExecutor.STASH_BORROW_BALANCE_SEL);
        w.writeAddress(Blockchain.contract.address);
        const r = Blockchain.call(this.stash.value, w, true);
        return r.data.readU256();
    }

    private stashMaxBorrowable(): u256 {
        const w: BytesWriter = new BytesWriter(36);
        w.writeSelector(LoopExecutor.STASH_MAX_BORROWABLE_SEL);
        w.writeAddress(Blockchain.contract.address);
        const r = Blockchain.call(this.stash.value, w, true);
        return r.data.readU256();
    }

    private stashDepositBalance(): u256 {
        const w: BytesWriter = new BytesWriter(36);
        w.writeSelector(LoopExecutor.STASH_DEPOSIT_BALANCE_SEL);
        w.writeAddress(Blockchain.contract.address);
        const r = Blockchain.call(this.stash.value, w, true);
        return r.data.readU256();
    }
}
