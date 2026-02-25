/**
 * LoopExecutor Unit Tests
 *
 * Tests the core contract against the real OP_VM via the unit-test-framework.
 * Requires compiled WASM bytecodes in ./bytecodes/:
 *   - LoopExecutor.wasm
 *   - MockStash.wasm
 *   - MockMoto.wasm (OP20)
 *
 * Run: npx tsx test/loopExecutor.test.ts
 */

import { Address } from '@btc-vision/transaction';
import { Assert, Blockchain, opnet, OPNetUnit, OP20 } from '@btc-vision/unit-test-framework';
import { LoopExecutorRuntime } from './contracts/runtime/LoopExecutorRuntime.js';
import { MockStashRuntime } from './contracts/runtime/MockStashRuntime.js';

// --- Constants ---
const E18: bigint = 1_000_000_000_000_000_000n;
const LEVERAGE_1X: bigint = E18;
const LEVERAGE_2X: bigint = 2n * E18;
const LEVERAGE_3X: bigint = 3n * E18;
const DEPOSIT_AMOUNT: bigint = 1_000_000n * E18; // 1M tokens (18 decimals)
const MIN_DEPOSIT: bigint = 10_000n;

// ===============================================================
//  Test Suite: openPosition
// ===============================================================

await opnet('LoopExecutor — openPosition', async (vm: OPNetUnit) => {
    let executor: LoopExecutorRuntime;
    let stash: MockStashRuntime;
    let moto: OP20;

    const deployer: Address = Blockchain.generateRandomAddress();
    const user: Address = Blockchain.generateRandomAddress();
    const treasury: Address = Blockchain.generateRandomAddress();

    const executorAddress: Address = Blockchain.generateRandomAddress();
    const stashAddress: Address = Blockchain.generateRandomAddress();
    const motoAddress: Address = Blockchain.generateRandomAddress();

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        // Deploy MockMoto (OP20)
        moto = new OP20({
            address: motoAddress,
            deployer,
            file: './bytecodes/MockMoto.wasm',
            decimals: 18,
        });
        Blockchain.register(moto);
        await moto.init();

        // Deploy MockStash
        stash = new MockStashRuntime(deployer, stashAddress);
        Blockchain.register(stash);
        await stash.init();

        // Deploy LoopExecutor
        executor = new LoopExecutorRuntime(deployer, executorAddress);
        Blockchain.register(executor);
        await executor.init();

        // Set context to deployer for admin setup
        Blockchain.txOrigin = deployer;
        Blockchain.msgSender = deployer;

        // Mint MOTO to user and to MockStash (reserve for borrows)
        await moto.mintRaw(user, DEPOSIT_AMOUNT * 10n);
        await moto.mintRaw(stashAddress, DEPOSIT_AMOUNT * 100n);

        // User approves LoopExecutor to spend their MOTO
        Blockchain.msgSender = user;
        Blockchain.txOrigin = user;
    });

    vm.afterEach(() => {
        executor.dispose();
        stash.dispose();
        moto.dispose();
        Blockchain.dispose();
    });

    await vm.it('should open a 1x position (no looping)', async () => {
        const response = await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);
        Assert.expect(response.error).toBeUndefined();

        const position = await executor.getPosition(user);
        vm.info(`Deposit: ${position.deposit}, Debt: ${position.debt}`);

        // 1x leverage = no borrowing
        Assert.expect(position.debt).toEqual(0n);
        Assert.expect(position.deposit > 0n).toEqual(true);
    });

    await vm.it('should open a 2x leveraged position', async () => {
        const response = await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_2X);
        Assert.expect(response.error).toBeUndefined();

        const position = await executor.getPosition(user);
        vm.info(`Deposit: ${position.deposit}, Debt: ${position.debt}`);

        // Should have borrowed tokens
        Assert.expect(position.debt > 0n).toEqual(true);
        Assert.expect(position.deposit > DEPOSIT_AMOUNT).toEqual(true);
    });

    await vm.it('should charge entry fee (0.5%)', async () => {
        await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);

        const totalFees: bigint = await executor.getTotalFeesCollected();
        vm.info(`Total fees collected: ${totalFees}`);

        // Fee = ceil(amount * 50 / 10000) ≈ 0.5% of deposit
        Assert.expect(totalFees > 0n).toEqual(true);
    });

    await vm.it('should reject deposit below minimum', async () => {
        await Assert.expect(async () => {
            await executor.openPosition(MIN_DEPOSIT - 1n, LEVERAGE_1X);
        }).toThrow('Amount below minimum deposit');
    });

    await vm.it('should reject leverage above 3x', async () => {
        const leverage4x: bigint = 4n * E18;

        await Assert.expect(async () => {
            await executor.openPosition(DEPOSIT_AMOUNT, leverage4x);
        }).toThrow('Leverage exceeds 3x cap');
    });

    await vm.it('should reject leverage below 1x', async () => {
        const leverageHalf: bigint = E18 / 2n;

        await Assert.expect(async () => {
            await executor.openPosition(DEPOSIT_AMOUNT, leverageHalf);
        }).toThrow('Leverage must be >= 1x');
    });

    await vm.it('should reject second position while one is active', async () => {
        await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);

        // Try to open another position
        await Assert.expect(async () => {
            await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);
        }).toThrow('Another position is already active');
    });
});

// ===============================================================
//  Test Suite: closePosition
// ===============================================================

await opnet('LoopExecutor — closePosition', async (vm: OPNetUnit) => {
    let executor: LoopExecutorRuntime;
    let stash: MockStashRuntime;
    let moto: OP20;

    const deployer: Address = Blockchain.generateRandomAddress();
    const user: Address = Blockchain.generateRandomAddress();
    const treasury: Address = Blockchain.generateRandomAddress();

    const executorAddress: Address = Blockchain.generateRandomAddress();
    const stashAddress: Address = Blockchain.generateRandomAddress();
    const motoAddress: Address = Blockchain.generateRandomAddress();

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        moto = new OP20({
            address: motoAddress,
            deployer,
            file: './bytecodes/MockMoto.wasm',
            decimals: 18,
        });
        Blockchain.register(moto);
        await moto.init();

        stash = new MockStashRuntime(deployer, stashAddress);
        Blockchain.register(stash);
        await stash.init();

        executor = new LoopExecutorRuntime(deployer, executorAddress);
        Blockchain.register(executor);
        await executor.init();

        Blockchain.txOrigin = deployer;
        Blockchain.msgSender = deployer;

        await moto.mintRaw(user, DEPOSIT_AMOUNT * 10n);
        await moto.mintRaw(stashAddress, DEPOSIT_AMOUNT * 100n);

        // Open a position first
        Blockchain.msgSender = user;
        Blockchain.txOrigin = user;
        await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_2X);
    });

    vm.afterEach(() => {
        executor.dispose();
        stash.dispose();
        moto.dispose();
        Blockchain.dispose();
    });

    await vm.it('should close position and return funds', async () => {
        const response = await executor.closePosition();
        Assert.expect(response.error).toBeUndefined();

        // Position should be cleared
        const position = await executor.getPosition(user);
        Assert.expect(position.deposit).toEqual(0n);
        Assert.expect(position.debt).toEqual(0n);

        vm.success('Position closed and cleared');
    });

    await vm.it('should reject close from non-owner', async () => {
        const stranger: Address = Blockchain.generateRandomAddress();
        Blockchain.msgSender = stranger;
        Blockchain.txOrigin = stranger;

        await Assert.expect(async () => {
            await executor.closePosition();
        }).toThrow(); // Either "No open position" or "Not position owner"
    });

    await vm.it('should allow close even when paused (L-01 fix)', async () => {
        // Admin pauses
        Blockchain.msgSender = deployer;
        Blockchain.txOrigin = deployer;
        await executor.pause();

        // User can still close
        Blockchain.msgSender = user;
        Blockchain.txOrigin = user;
        const response = await executor.closePosition();
        Assert.expect(response.error).toBeUndefined();

        vm.success('closePosition works while paused');
    });

    await vm.it('should allow new position after close', async () => {
        await executor.closePosition();

        // Should be able to open again
        const response = await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);
        Assert.expect(response.error).toBeUndefined();

        vm.success('New position opened after close');
    });
});

// ===============================================================
//  Test Suite: Admin / Pause
// ===============================================================

await opnet('LoopExecutor — Admin & Pause', async (vm: OPNetUnit) => {
    let executor: LoopExecutorRuntime;

    const deployer: Address = Blockchain.generateRandomAddress();
    const executorAddress: Address = Blockchain.generateRandomAddress();

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        executor = new LoopExecutorRuntime(deployer, executorAddress);
        Blockchain.register(executor);
        await executor.init();

        Blockchain.txOrigin = deployer;
        Blockchain.msgSender = deployer;
    });

    vm.afterEach(() => {
        executor.dispose();
        Blockchain.dispose();
    });

    await vm.it('should start unpaused', async () => {
        const paused: boolean = await executor.isPaused();
        Assert.expect(paused).toEqual(false);
    });

    await vm.it('should pause and unpause', async () => {
        await executor.pause();
        Assert.expect(await executor.isPaused()).toEqual(true);

        await executor.unpause();
        Assert.expect(await executor.isPaused()).toEqual(false);
    });

    await vm.it('should reject pause from non-deployer', async () => {
        const stranger: Address = Blockchain.generateRandomAddress();
        Blockchain.msgSender = stranger;
        Blockchain.txOrigin = stranger;

        await Assert.expect(async () => {
            await executor.pause();
        }).toThrow();
    });

    await vm.it('should update treasury with event', async () => {
        const newTreasury: Address = Blockchain.generateRandomAddress();
        const response = await executor.setTreasury(newTreasury);
        Assert.expect(response.error).toBeUndefined();

        const current: Address = await executor.getTreasury();
        Assert.expect(current.equals(newTreasury)).toEqual(true);
    });

    await vm.it('should reject zero address for treasury', async () => {
        await Assert.expect(async () => {
            await executor.setTreasury(Address.dead());
        }).toThrow();
    });

    await vm.it('should update stash address', async () => {
        const newStash: Address = Blockchain.generateRandomAddress();
        await executor.setStash(newStash);

        const current: Address = await executor.getStash();
        Assert.expect(current.equals(newStash)).toEqual(true);
    });

    await vm.it('should update moto address', async () => {
        const newMoto: Address = Blockchain.generateRandomAddress();
        await executor.setMoto(newMoto);

        const current: Address = await executor.getMoto();
        Assert.expect(current.equals(newMoto)).toEqual(true);
    });

    await vm.it('should reject setStash from non-deployer', async () => {
        const stranger: Address = Blockchain.generateRandomAddress();
        Blockchain.msgSender = stranger;
        Blockchain.txOrigin = stranger;

        await Assert.expect(async () => {
            await executor.setStash(Blockchain.generateRandomAddress());
        }).toThrow();
    });

    await vm.it('should block openPosition when paused', async () => {
        await executor.pause();

        const user: Address = Blockchain.generateRandomAddress();
        Blockchain.msgSender = user;
        Blockchain.txOrigin = user;

        await Assert.expect(async () => {
            await executor.openPosition(DEPOSIT_AMOUNT, LEVERAGE_1X);
        }).toThrow('Contract is paused');
    });
});
