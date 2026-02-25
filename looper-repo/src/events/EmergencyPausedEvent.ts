import {
    NetEvent,
    BytesWriter,
    Address,
    ADDRESS_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted when the contract is paused or unpaused.
 *
 * @param admin - The deployer who triggered the action.
 * @param paused - True if paused, false if unpaused.
 */
@final
export class EmergencyPausedEvent extends NetEvent {
    public constructor(admin: Address, paused: boolean) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + 1);
        data.writeAddress(admin);
        data.writeBoolean(paused);

        super('EmergencyPaused', data);
    }
}
