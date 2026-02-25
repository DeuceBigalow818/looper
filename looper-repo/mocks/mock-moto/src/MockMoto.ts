import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    OP20,
    OP20InitParameters,
    Blockchain,
    Calldata,
    BytesWriter,
} from '@btc-vision/btc-runtime/runtime';

/**
 * MockMoto — A mintable OP20 token for regtest testing.
 *
 * Deployer can mint arbitrary amounts to any address.
 * Mirrors the MOTO token interface for integration tests.
 */
@final
export class MockMoto extends OP20 {
    public constructor() {
        super();
    }

    /** Initialise token metadata on deployment. No calldata required. */
    public override onDeployment(_calldata: Calldata): void {
        this.instantiate(
            new OP20InitParameters(
                u256.fromString('1000000000000000000000000000'), // 1B * 1e18
                18,
                'Mock MOTO',
                'mMOTO',
            ),
        );
    }

    /**
     * Public mint — deployer only. Mints tokens to `to`.
     *
     * @param to - Recipient address.
     * @param amount - Amount to mint (18 decimals).
     */
    @method(
        { name: 'to', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Minted')
    public mint(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        this._mint(calldata.readAddress(), calldata.readU256());

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }
}
