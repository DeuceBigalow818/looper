/**
 * deploy-regtest.ts — Deploys LoopExecutor, MockStash, and MockMoto to regtest.
 *
 * Usage:
 *   npx tsx scripts/deploy-regtest.ts
 *
 * Prerequisites:
 *   1. Build all contracts: npm run build (in each project)
 *   2. Set MNEMONIC env var or edit the mnemonic below
 *   3. Ensure regtest node is running at https://regtest.opnet.org
 *   4. Fund the deployer address with regtest BTC
 *
 * IMPORTANT: This script uses TransactionFactory for deployments only.
 * Contract interactions MUST use the `opnet` npm package.
 */

import * as fs from 'fs';
import {
    Mnemonic,
    TransactionFactory,
    OPNetLimitedProvider,
    BinaryWriter,
    type UTXO,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

// --- Configuration ---

interface DeployConfig {
    readonly network: typeof networks.regtest;
    readonly rpcUrl: string;
    readonly mnemonic: string;
    readonly feeRate: number;
    readonly gasSatFee: bigint;
}

interface DeployResult {
    readonly contractAddress: string;
    readonly fundingTxId: string;
    readonly revealTxId: string;
}

const CONFIG: DeployConfig = {
    network: networks.regtest,
    rpcUrl: 'https://regtest.opnet.org',
    mnemonic: process.env['MNEMONIC'] ?? 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    feeRate: 2,
    gasSatFee: 10_000n,
};

// --- Bytecode paths ---

interface BytecodePaths {
    readonly loopExecutor: string;
    readonly mockStash: string;
    readonly mockMoto: string;
}

const BYTECODES: BytecodePaths = {
    loopExecutor: './build/LoopExecutor.wasm',
    mockStash: './mocks/mock-stash/build/MockStash.wasm',
    mockMoto: './mocks/mock-moto/build/MockMoto.wasm',
};

// --- Deploy function ---

async function deployContract(
    factory: TransactionFactory,
    provider: OPNetLimitedProvider,
    wallet: ReturnType<Mnemonic['derive']>,
    bytecodeFile: string,
    calldata: Uint8Array | undefined,
    label: string,
): Promise<DeployResult> {
    console.log(`\n📦 Deploying ${label}...`);

    const bytecode: Uint8Array = fs.readFileSync(bytecodeFile);
    console.log(`   Bytecode: ${bytecode.length} bytes`);

    const utxos: UTXO[] = await provider.fetchUTXO({
        address: wallet.p2tr,
        minAmount: 100_000n,
        requestedAmount: 500_000n,
    });

    if (utxos.length === 0) {
        throw new Error(`No UTXOs available for ${label} deployment. Fund ${wallet.p2tr}`);
    }

    console.log(`   UTXOs: ${utxos.length} available`);

    const challenge = await provider.getChallenge();

    const result = await factory.signDeployment({
        from: wallet.p2tr,
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network: CONFIG.network,
        bytecode,
        calldata,
        utxos,
        challenge,
        feeRate: CONFIG.feeRate,
        priorityFee: 0n,
        gasSatFee: CONFIG.gasSatFee,
        linkMLDSAPublicKeyToAddress: true,
        revealMLDSAPublicKey: true,
    });

    // Broadcast funding TX
    const fundingResult = await provider.sendRawTransaction(result.transaction[0]);
    console.log(`   Funding TX: ${fundingResult.txid}`);

    // Broadcast deployment TX
    const revealResult = await provider.sendRawTransaction(result.transaction[1]);
    console.log(`   Reveal TX:  ${revealResult.txid}`);
    console.log(`   ✅ ${label} deployed at: ${result.contractAddress}`);

    return {
        contractAddress: result.contractAddress,
        fundingTxId: fundingResult.txid,
        revealTxId: revealResult.txid,
    };
}

// --- Main ---

async function main(): Promise<void> {
    console.log('🚀 LoOPer Regtest Deployment');
    console.log('============================\n');

    // Validate bytecodes exist
    for (const [name, path] of Object.entries(BYTECODES)) {
        if (!fs.existsSync(path)) {
            console.error(`❌ Missing bytecode: ${path}`);
            console.error(`   Build ${name} first: npm run build`);
            process.exit(1);
        }
    }

    const mnemonic = new Mnemonic(CONFIG.mnemonic, '', CONFIG.network);
    const wallet = mnemonic.derive(0);
    const provider = new OPNetLimitedProvider(CONFIG.rpcUrl);
    const factory = new TransactionFactory();

    console.log(`Deployer: ${wallet.p2tr}`);

    try {
        // 1. Deploy MockMoto (no calldata — onDeployment has defaults)
        const motoResult: DeployResult = await deployContract(
            factory, provider, wallet,
            BYTECODES.mockMoto, undefined,
            'MockMoto (OP20)',
        );

        // 2. Deploy MockStash (calldata: token address)
        const stashCalldata: BinaryWriter = new BinaryWriter();
        stashCalldata.writeAddress(motoResult.contractAddress);
        const stashResult: DeployResult = await deployContract(
            factory, provider, wallet,
            BYTECODES.mockStash, stashCalldata.getBuffer(),
            'MockStash (Lending Pool)',
        );

        // 3. Deploy LoopExecutor (calldata: treasury, stash, moto)
        const executorCalldata: BinaryWriter = new BinaryWriter();
        executorCalldata.writeAddress(wallet.p2tr); // treasury = deployer for testing
        executorCalldata.writeAddress(stashResult.contractAddress);
        executorCalldata.writeAddress(motoResult.contractAddress);
        const executorResult: DeployResult = await deployContract(
            factory, provider, wallet,
            BYTECODES.loopExecutor, executorCalldata.getBuffer(),
            'LoopExecutor',
        );

        // Summary
        console.log('\n============================');
        console.log('✅ Deployment Complete!\n');
        console.log('Contract Addresses:');
        console.log(`  MockMoto:      ${motoResult.contractAddress}`);
        console.log(`  MockStash:     ${stashResult.contractAddress}`);
        console.log(`  LoopExecutor:  ${executorResult.contractAddress}`);
        console.log(`  Treasury:      ${wallet.p2tr}`);
        console.log('\nNext steps:');
        console.log('  1. Mint MockMoto to your test wallet');
        console.log('  2. Mint MockMoto to MockStash (lending reserve)');
        console.log('  3. Approve LoopExecutor to spend your MockMoto');
        console.log('  4. Call openPosition(amount, leverageE18)');
    } finally {
        mnemonic.zeroize();
        wallet.zeroize();
    }
}

main().catch((error: Error) => {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
});
