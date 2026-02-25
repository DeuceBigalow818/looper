import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted when the treasury address is updated.
 *
 * @param oldTreasury - The previous treasury address.
 * @param newTreasury - The new treasury address.
 */
@final
export class TreasuryUpdatedEvent extends NetEvent {
    public constructor(oldTreasury: Address, newTreasury: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(oldTreasury);
        data.writeAddress(newTreasury);

        super('TreasuryUpdated', data);
    }
}
