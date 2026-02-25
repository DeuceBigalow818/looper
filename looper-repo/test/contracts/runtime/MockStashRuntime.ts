import { Address, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { BytecodeManager, CallResponse, ContractRuntime } from '@btc-vision/unit-test-framework';

export class MockStashRuntime extends ContractRuntime {
    readonly #depositSel: number = this.#sel('deposit(address,uint256)');
    readonly #borrowSel: number = this.#sel('borrow(address,uint256)');
    readonly #repaySel: number = this.#sel('repay(address,uint256)');
    readonly #withdrawSel: number = this.#sel('withdraw(address,uint256)');
    readonly #healthFactorSel: number = this.#sel('healthFactor(address)');
    readonly #borrowBalanceOfSel: number = this.#sel('borrowBalanceOf(address)');
    readonly #maxBorrowableSel: number = this.#sel('maxBorrowable(address)');
    readonly #depositBalanceOfSel: number = this.#sel('depositBalanceOf(address)');
    readonly #setTokenSel: number = this.#sel('setToken(address)');

    public constructor(
        deployer: Address,
        address: Address,
        gasLimit: bigint = 150_000_000_000n,
    ) {
        super({ address, deployer, gasLimit });
    }

    public async deposit(token: Address, amount: bigint): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#depositSel);
        calldata.writeAddress(token);
        calldata.writeU256(amount);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async borrow(token: Address, amount: bigint): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#borrowSel);
        calldata.writeAddress(token);
        calldata.writeU256(amount);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async repay(token: Address, amount: bigint): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#repaySel);
        calldata.writeAddress(token);
        calldata.writeU256(amount);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async withdraw(token: Address, amount: bigint): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#withdrawSel);
        calldata.writeAddress(token);
        calldata.writeU256(amount);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async healthFactor(account: Address): Promise<bigint> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#healthFactorSel);
        calldata.writeAddress(account);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readU256();
    }

    public async borrowBalanceOf(account: Address): Promise<bigint> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#borrowBalanceOfSel);
        calldata.writeAddress(account);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readU256();
    }

    public async maxBorrowable(account: Address): Promise<bigint> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#maxBorrowableSel);
        calldata.writeAddress(account);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readU256();
    }

    public async depositBalanceOf(account: Address): Promise<bigint> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#depositBalanceOfSel);
        calldata.writeAddress(account);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readU256();
    }

    public async setToken(newToken: Address): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#setTokenSel);
        calldata.writeAddress(newToken);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    protected handleError(error: Error): Error {
        return new Error(`(MockStash: ${this.address}) OP_NET: ${error.message}`);
    }

    protected defineRequiredBytecodes(): void {
        BytecodeManager.loadBytecode('./bytecodes/MockStash.wasm', this.address);
    }

    #sel(signature: string): number {
        return Number(`0x${this.abiCoder.encodeSelector(signature)}`);
    }

    #handleResponse(response: CallResponse): void {
        if (response.error) throw this.handleError(response.error);
        if (!response.response) throw new Error('No response to decode');
    }
}
