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
    StoredU256,
    AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';

import { DepositEvent } from './events/DepositEvent';
import { BorrowEvent } from './events/BorrowEvent';
import { RepayEvent } from './events/RepayEvent';
import { WithdrawEvent } from './events/WithdrawEvent';

/**
 * MockStash — A simplified lending pool mock for regtest testing.
 *
 * Implements the exact interface that LoopExecutor expects from Stash.
 * Simulates collateral deposits, borrows, repays, withdrawals, and
 * health factor calculations with a configurable LTV ratio.
 *
 * Lending model:
 *   - LTV (Loan-to-Value): 66 % by default (borrowable = collateral * 66 / 100)
 *   - Liquidation threshold: 80 %
 *   - Health factor = (collateral * liquidationThreshold) / debt
 *   - All values in 18-decimal fixed-point
 *
 * Token handling:
 *   - Uses OP20 transferFrom to pull tokens on deposit/repay
 *   - Uses OP20 transfer to send tokens on borrow/withdraw
 *   - The MockStash contract must hold a token reserve (mint to it in tests)
 */
@final
export class MockStash extends OP_NET {
    // ---------------------------------------------------------------
    //  Constants
    // ---------------------------------------------------------------

    /** 1e18 scaling factor. */
    private static readonly E18: u256 = u256.fromString('1000000000000000000');

    /** 100 in u256 for percentage calculations. */
    private static readonly HUNDRED: u256 = u256.fromU32(100);

    /** Default LTV: 66 %. Borrow up to 66 % of collateral value. */
    private static readonly LTV_PERCENT: u256 = u256.fromU32(66);

    /** Liquidation threshold: 80 %. Used for health factor calc. */
    private static readonly LIQ_THRESHOLD_PERCENT: u256 = u256.fromU32(80);

    // ---------------------------------------------------------------
    //  External OP20 selectors
    // ---------------------------------------------------------------

    /** OP20: transferFrom(address,address,uint256) */
    private static readonly TRANSFER_FROM_SEL: u32 = 0x23b872dd;

    /** OP20: transfer(address,uint256) */
    private static readonly TRANSFER_SEL: u32 = 0xa9059cbb;

    // ---------------------------------------------------------------
    //  Method selectors (this contract)
    // ---------------------------------------------------------------

    private readonly depositSel: Selector = encodeSelector(
        'deposit(address,uint256)',
    );
    private readonly borrowSel: Selector = encodeSelector(
        'borrow(address,uint256)',
    );
    private readonly repaySel: Selector = encodeSelector(
        'repay(address,uint256)',
    );
    private readonly withdrawSel: Selector = encodeSelector(
        'withdraw(address,uint256)',
    );
    private readonly healthFactorSel: Selector = encodeSelector(
        'healthFactor(address)',
    );
    private readonly borrowBalanceOfSel: Selector = encodeSelector(
        'borrowBalanceOf(address)',
    );
    private readonly maxBorrowableSel: Selector = encodeSelector(
        'maxBorrowable(address)',
    );
    private readonly depositBalanceOfSel: Selector = encodeSelector(
        'depositBalanceOf(address)',
    );
    private readonly setTokenSel: Selector = encodeSelector(
        'setToken(address)',
    );

    // ---------------------------------------------------------------
    //  Storage
    // ---------------------------------------------------------------

    /** Accepted collateral token address (set on deployment). */
    private readonly tokenPointer: u16 = Blockchain.nextPointer;
    private readonly token: StoredAddress = new StoredAddress(
        this.tokenPointer,
    );

    /** Total deposits across all users (for reserve tracking). */
    private readonly totalDepositsPointer: u16 = Blockchain.nextPointer;
    private readonly totalDeposits: StoredU256 = new StoredU256(
        this.totalDepositsPointer,
        u256.Zero,
    );

    /** Total borrows across all users. */
    private readonly totalBorrowsPointer: u16 = Blockchain.nextPointer;
    private readonly totalBorrows: StoredU256 = new StoredU256(
        this.totalBorrowsPointer,
        u256.Zero,
    );

    /** Per-user collateral deposits. mapping(address => u256) */
    private readonly userDepositsPointer: u16 = Blockchain.nextPointer;
    private readonly userDeposits: AddressMemoryMap = new AddressMemoryMap(
        this.userDepositsPointer,
    );

    /** Per-user outstanding debt. mapping(address => u256) */
    private readonly userBorrowsPointer: u16 = Blockchain.nextPointer;
    private readonly userBorrows: AddressMemoryMap = new AddressMemoryMap(
        this.userBorrowsPointer,
    );

    // ---------------------------------------------------------------
    //  Constructor
    // ---------------------------------------------------------------

    public constructor() {
        super();
    }

    // ---------------------------------------------------------------
    //  Deployment
    // ---------------------------------------------------------------

    /**
     * Initialises the mock with a token address.
     * Calldata: [token: Address]
     */
    public override onDeployment(calldata: Calldata): void {
        const tokenAddr: Address = calldata.readAddress();
        if (tokenAddr.equals(Address.zero())) {
            throw new Revert('Token cannot be zero address');
        }
        this.token.value = tokenAddr;
    }

    // ---------------------------------------------------------------
    //  Router
    // ---------------------------------------------------------------

    public override callMethod(calldata: Calldata): BytesWriter {
        const selector: Selector = calldata.readSelector();

        switch (selector) {
            case this.depositSel:
                return this.deposit(calldata);
            case this.borrowSel:
                return this.borrow(calldata);
            case this.repaySel:
                return this.repay(calldata);
            case this.withdrawSel:
                return this.withdraw(calldata);
            case this.healthFactorSel:
                return this.healthFactor(calldata);
            case this.borrowBalanceOfSel:
                return this.borrowBalanceOf(calldata);
            case this.maxBorrowableSel:
                return this.maxBorrowable(calldata);
            case this.depositBalanceOfSel:
                return this.depositBalanceOf(calldata);
            case this.setTokenSel:
                return this.setToken(calldata);
            default:
                return super.callMethod(calldata);
        }
    }

    // ===============================================================
    //  deposit(address token, uint256 amount)
    // ===============================================================

    /**
     * Accepts collateral from the caller.
     * Pulls `amount` of `token` from msg.sender via transferFrom.
     *
     * @param token - Must match the configured token.
     * @param amount - Amount to deposit.
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Deposit')
    public deposit(calldata: Calldata): BytesWriter {
        const tokenAddr: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireToken(tokenAddr);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be > 0');
        }

        // Pull tokens from sender
        this.pullTokens(sender, amount);

        // Update state
        const currentDeposit: u256 = this.userDeposits.get(sender);
        this.userDeposits.set(sender, SafeMath.add(currentDeposit, amount));
        this.totalDeposits.set(
            SafeMath.add(this.totalDeposits.get(), amount),
        );

        this.emitEvent(new DepositEvent(sender, tokenAddr, amount));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  borrow(address token, uint256 amount)
    // ===============================================================

    /**
     * Borrows tokens against deposited collateral.
     * Transfers `amount` to the caller from this contract's reserves.
     *
     * @param token - Must match the configured token.
     * @param amount - Amount to borrow.
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Borrow')
    public borrow(calldata: Calldata): BytesWriter {
        const tokenAddr: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireToken(tokenAddr);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be > 0');
        }

        // Check borrowing capacity
        const maxBorrow: u256 = this.calculateMaxBorrowable(sender);
        if (u256.gt(amount, maxBorrow)) {
            throw new Revert('Exceeds borrowing capacity');
        }

        // Update state BEFORE sending tokens (CEI pattern)
        const currentBorrow: u256 = this.userBorrows.get(sender);
        this.userBorrows.set(sender, SafeMath.add(currentBorrow, amount));
        this.totalBorrows.set(
            SafeMath.add(this.totalBorrows.get(), amount),
        );

        // Send tokens to borrower
        this.sendTokens(sender, amount);

        this.emitEvent(new BorrowEvent(sender, tokenAddr, amount));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  repay(address token, uint256 amount)
    // ===============================================================

    /**
     * Repays borrowed tokens. Pulls `amount` from the caller.
     *
     * @param token - Must match the configured token.
     * @param amount - Amount to repay.
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Repay')
    public repay(calldata: Calldata): BytesWriter {
        const tokenAddr: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireToken(tokenAddr);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be > 0');
        }

        const currentBorrow: u256 = this.userBorrows.get(sender);
        if (u256.gt(amount, currentBorrow)) {
            throw new Revert('Repay exceeds debt');
        }

        // Pull tokens from sender
        this.pullTokens(sender, amount);

        // Update state
        this.userBorrows.set(sender, SafeMath.sub(currentBorrow, amount));
        this.totalBorrows.set(
            SafeMath.sub(this.totalBorrows.get(), amount),
        );

        this.emitEvent(new RepayEvent(sender, tokenAddr, amount));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  withdraw(address token, uint256 amount)
    // ===============================================================

    /**
     * Withdraws collateral. Sends `amount` back to the caller.
     * Reverts if withdrawal would make health factor < 1.0.
     *
     * @param token - Must match the configured token.
     * @param amount - Amount to withdraw.
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Withdraw')
    public withdraw(calldata: Calldata): BytesWriter {
        const tokenAddr: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireToken(tokenAddr);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be > 0');
        }

        const currentDeposit: u256 = this.userDeposits.get(sender);
        if (u256.gt(amount, currentDeposit)) {
            throw new Revert('Withdraw exceeds deposits');
        }

        // Check that withdrawal won't make position unhealthy
        const newDeposit: u256 = SafeMath.sub(currentDeposit, amount);
        const currentDebt: u256 = this.userBorrows.get(sender);

        if (u256.gt(currentDebt, u256.Zero)) {
            // healthFactor = (newDeposit * liqThreshold%) / debt
            const numerator: u256 = SafeMath.div(
                SafeMath.mul(
                    SafeMath.mul(newDeposit, MockStash.LIQ_THRESHOLD_PERCENT),
                    MockStash.E18,
                ),
                MockStash.HUNDRED,
            );
            const newHF: u256 = SafeMath.div(numerator, currentDebt);

            // Must stay >= 1.0 (1e18) after withdrawal
            if (u256.lt(newHF, MockStash.E18)) {
                throw new Revert('Withdrawal would make position unhealthy');
            }
        }

        // Update state BEFORE sending tokens
        this.userDeposits.set(sender, newDeposit);
        this.totalDeposits.set(
            SafeMath.sub(this.totalDeposits.get(), amount),
        );

        // Send tokens back
        this.sendTokens(sender, amount);

        this.emitEvent(new WithdrawEvent(sender, tokenAddr, amount));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  healthFactor(address account) → u256
    // ===============================================================

    /**
     * Calculates the health factor for an account.
     *
     * Formula: (deposits * liquidationThreshold%) / debt
     * Returns u256 in 18-decimal fixed-point.
     * If debt is zero, returns max u256 (infinite health).
     *
     * @param account - The account to check.
     */
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'factor', type: ABIDataTypes.UINT256 })
    public healthFactor(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const hf: u256 = this.calculateHealthFactor(account);

        const response: BytesWriter = new BytesWriter(32);
        response.writeU256(hf);
        return response;
    }

    // ===============================================================
    //  borrowBalanceOf(address account) → u256
    // ===============================================================

    /** Returns the outstanding debt of an account. */
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'balance', type: ABIDataTypes.UINT256 })
    public borrowBalanceOf(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const debt: u256 = this.userBorrows.get(account);

        const response: BytesWriter = new BytesWriter(32);
        response.writeU256(debt);
        return response;
    }

    // ===============================================================
    //  maxBorrowable(address account) → u256
    // ===============================================================

    /**
     * Returns the maximum additional amount an account can borrow.
     *
     * Formula: (deposits * LTV%) - currentDebt
     * Returns zero if already at or above capacity.
     */
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public maxBorrowable(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const maxBorrow: u256 = this.calculateMaxBorrowable(account);

        const response: BytesWriter = new BytesWriter(32);
        response.writeU256(maxBorrow);
        return response;
    }

    // ===============================================================
    //  depositBalanceOf(address account) → u256
    // ===============================================================

    /** Returns the collateral deposit balance of an account. */
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'balance', type: ABIDataTypes.UINT256 })
    public depositBalanceOf(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const deposit: u256 = this.userDeposits.get(account);

        const response: BytesWriter = new BytesWriter(32);
        response.writeU256(deposit);
        return response;
    }

    // ===============================================================
    //  ADMIN: setToken (for test flexibility)
    // ===============================================================

    /** Allows deployer to change the accepted token. For testing only. */
    @method({ name: 'newToken', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const newToken: Address = calldata.readAddress();
        if (newToken.equals(Address.zero())) {
            throw new Revert('Token cannot be zero address');
        }
        this.token.value = newToken;

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ===============================================================
    //  Internal: calculations
    // ===============================================================

    /**
     * Calculates health factor for an account.
     *
     * HF = (deposits * liqThreshold / 100) * 1e18 / debt
     *
     * If debt is 0, returns u256.Max (infinitely healthy).
     */
    private calculateHealthFactor(account: Address): u256 {
        const deposits: u256 = this.userDeposits.get(account);
        const debt: u256 = this.userBorrows.get(account);

        if (u256.eq(debt, u256.Zero)) {
            return u256.Max;
        }

        // numerator = deposits * liqThreshold% * 1e18 / 100
        const numerator: u256 = SafeMath.div(
            SafeMath.mul(
                SafeMath.mul(deposits, MockStash.LIQ_THRESHOLD_PERCENT),
                MockStash.E18,
            ),
            MockStash.HUNDRED,
        );

        return SafeMath.div(numerator, debt);
    }

    /**
     * Calculates the maximum additional amount an account can borrow.
     *
     * maxTotal = deposits * LTV% / 100
     * maxAdditional = maxTotal - currentDebt (floored at 0)
     */
    private calculateMaxBorrowable(account: Address): u256 {
        const deposits: u256 = this.userDeposits.get(account);
        const currentDebt: u256 = this.userBorrows.get(account);

        // maxTotalBorrow = deposits * 66 / 100
        const maxTotalBorrow: u256 = SafeMath.div(
            SafeMath.mul(deposits, MockStash.LTV_PERCENT),
            MockStash.HUNDRED,
        );

        if (u256.lte(maxTotalBorrow, currentDebt)) {
            return u256.Zero;
        }

        return SafeMath.sub(maxTotalBorrow, currentDebt);
    }

    // ===============================================================
    //  Internal: Token helpers
    // ===============================================================

    /** Validates the token parameter matches the configured token. */
    private requireToken(tokenAddr: Address): void {
        if (!tokenAddr.equals(this.token.value)) {
            throw new Revert('Unsupported token');
        }
    }

    /**
     * Pulls tokens from `from` into this contract via transferFrom.
     *
     * @param from - Source address.
     * @param amount - Amount to pull.
     */
    private pullTokens(from: Address, amount: u256): void {
        const writer: BytesWriter = new BytesWriter(100);
        writer.writeSelector(MockStash.TRANSFER_FROM_SEL);
        writer.writeAddress(from);
        writer.writeAddress(Blockchain.contract.address);
        writer.writeU256(amount);

        const result = Blockchain.call(this.token.value, writer, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Token transferFrom failed');
            }
        }
    }

    /**
     * Sends tokens from this contract to `to` via transfer.
     *
     * @param to - Destination address.
     * @param amount - Amount to send.
     */
    private sendTokens(to: Address, amount: u256): void {
        const writer: BytesWriter = new BytesWriter(68);
        writer.writeSelector(MockStash.TRANSFER_SEL);
        writer.writeAddress(to);
        writer.writeU256(amount);

        const result = Blockchain.call(this.token.value, writer, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Token transfer failed');
            }
        }
    }
}
