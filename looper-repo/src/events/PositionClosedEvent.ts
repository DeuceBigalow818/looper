import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from '@btc-vision/as-bignum/assembly';

/**
 * Emitted when a user closes their leveraged position.
 *
 * @param user - The position owner.
 * @param storedDeposit - The stored total deposit at open time.
 * @param storedDebt - The stored total debt at open time.
 * @param userReceives - Net MOTO returned to the user (after exit fee).
 * @param exitFee - Exit fee sent to treasury.
 */
@final
export class PositionClosedEvent extends NetEvent {
    public constructor(
        user: Address,
        storedDeposit: u256,
        storedDebt: u256,
        userReceives: u256,
        exitFee: u256,
    ) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 4,
        );
        data.writeAddress(user);
        data.writeU256(storedDeposit);
        data.writeU256(storedDebt);
        data.writeU256(userReceives);
        data.writeU256(exitFee);

        super('PositionClosed', data);
    }
}
