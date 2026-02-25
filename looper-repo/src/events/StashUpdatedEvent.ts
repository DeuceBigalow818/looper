import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted when the Stash lending pool address is updated.
 *
 * @param oldStash - The previous Stash address.
 * @param newStash - The new Stash address.
 */
@final
export class StashUpdatedEvent extends NetEvent {
    public constructor(oldStash: Address, newStash: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(oldStash);
        data.writeAddress(newStash);

        super('StashUpdated', data);
    }
}
