import { Address, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { BytecodeManager, CallResponse, ContractRuntime } from '@btc-vision/unit-test-framework';

interface PositionData {
    readonly deposit: bigint;
    readonly debt: bigint;
}

export class LoopExecutorRuntime extends ContractRuntime {
    // --- Method selectors ---
    readonly #openPositionSel: number = this.#sel('openPosition(uint256,uint256)');
    readonly #closePositionSel: number = this.#sel('closePosition()');
    readonly #getPositionSel: number = this.#sel('getPosition(address)');
    readonly #pauseSel: number = this.#sel('pause()');
    readonly #unpauseSel: number = this.#sel('unpause()');
    readonly #setTreasurySel: number = this.#sel('setTreasury(address)');
    readonly #setStashSel: number = this.#sel('setStash(address)');
    readonly #setMotoSel: number = this.#sel('setMoto(address)');
    readonly #isPausedSel: number = this.#sel('isPaused()');
    readonly #getTreasurySel: number = this.#sel('getTreasury()');
    readonly #getStashSel: number = this.#sel('getStash()');
    readonly #getMotoSel: number = this.#sel('getMoto()');
    readonly #getTotalFeesCollectedSel: number = this.#sel('getTotalFeesCollected()');

    public constructor(
        deployer: Address,
        address: Address,
        gasLimit: bigint = 300_000_000_000n,
    ) {
        super({ address, deployer, gasLimit });
    }

    // ===============================================================
    //  Core methods
    // ===============================================================

    public async openPosition(amount: bigint, targetLeverageE18: bigint): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#openPositionSel);
        calldata.writeU256(amount);
        calldata.writeU256(targetLeverageE18);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async closePosition(): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#closePositionSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async getPosition(user: Address): Promise<PositionData> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#getPositionSel);
        calldata.writeAddress(user);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);

        const reader: BinaryReader = new BinaryReader(response.response);
        return {
            deposit: reader.readU256(),
            debt: reader.readU256(),
        };
    }

    // ===============================================================
    //  Admin methods
    // ===============================================================

    public async pause(): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#pauseSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async unpause(): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#unpauseSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async setTreasury(newTreasury: Address): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#setTreasurySel);
        calldata.writeAddress(newTreasury);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async setStash(newStash: Address): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#setStashSel);
        calldata.writeAddress(newStash);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    public async setMoto(newMoto: Address): Promise<CallResponse> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#setMotoSel);
        calldata.writeAddress(newMoto);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return response;
    }

    // ===============================================================
    //  View methods
    // ===============================================================

    public async isPaused(): Promise<boolean> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#isPausedSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readBoolean();
    }

    public async getTreasury(): Promise<Address> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#getTreasurySel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readAddress();
    }

    public async getStash(): Promise<Address> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#getStashSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readAddress();
    }

    public async getMoto(): Promise<Address> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#getMotoSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readAddress();
    }

    public async getTotalFeesCollected(): Promise<bigint> {
        const calldata: BinaryWriter = new BinaryWriter();
        calldata.writeSelector(this.#getTotalFeesCollectedSel);

        const response: CallResponse = await this.execute({ calldata: calldata.getBuffer() });
        this.#handleResponse(response);
        return new BinaryReader(response.response).readU256();
    }

    // ===============================================================
    //  Internal
    // ===============================================================

    protected handleError(error: Error): Error {
        return new Error(`(LoopExecutor: ${this.address}) OP_NET: ${error.message}`);
    }

    protected defineRequiredBytecodes(): void {
        BytecodeManager.loadBytecode('./bytecodes/LoopExecutor.wasm', this.address);
    }

    #sel(signature: string): number {
        return Number(`0x${this.abiCoder.encodeSelector(signature)}`);
    }

    #handleResponse(response: CallResponse): void {
        if (response.error) throw this.handleError(response.error);
        if (!response.response) throw new Error('No response to decode');
    }
}
