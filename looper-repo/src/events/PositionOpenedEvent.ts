import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from '@btc-vision/as-bignum/assembly';

/**
 * Emitted when a user opens a leveraged position.
 *
 * @param user - The depositor address.
 * @param amount - Original deposit amount (before fee).
 * @param totalDeposited - Total collateral deposited into Stash (after looping).
 * @param totalBorrowed - Total debt borrowed from Stash.
 * @param entryFee - Entry fee sent to treasury.
 */
@final
export class PositionOpenedEvent extends NetEvent {
    public constructor(
        user: Address,
        amount: u256,
        totalDeposited: u256,
        totalBorrowed: u256,
        entryFee: u256,
    ) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 4,
        );
        data.writeAddress(user);
        data.writeU256(amount);
        data.writeU256(totalDeposited);
        data.writeU256(totalBorrowed);
        data.writeU256(entryFee);

        super('PositionOpened', data);
    }
}
