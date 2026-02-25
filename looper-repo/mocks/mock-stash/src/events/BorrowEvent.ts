import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from '@btc-vision/as-bignum/assembly';

/**
 * Emitted when a user borrows from MockStash.
 *
 * @param user - The borrower address.
 * @param token - The borrowed token address.
 * @param amount - The amount borrowed.
 */
@final
export class BorrowEvent extends NetEvent {
    public constructor(user: Address, token: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH,
        );
        data.writeAddress(user);
        data.writeAddress(token);
        data.writeU256(amount);

        super('Borrow', data);
    }
}
