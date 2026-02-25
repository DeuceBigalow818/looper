import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted when the MOTO token address is updated.
 *
 * @param oldMoto - The previous MOTO address.
 * @param newMoto - The new MOTO address.
 */
@final
export class MotoUpdatedEvent extends NetEvent {
    public constructor(oldMoto: Address, newMoto: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(oldMoto);
        data.writeAddress(newMoto);

        super('MotoUpdated', data);
    }
}
