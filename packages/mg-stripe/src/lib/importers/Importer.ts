import {Logger} from '../Logger.js';
import {isWarning} from '../helpers.js';
import {ErrorGroup} from './ErrorGroup.js';
import {ImportError} from './ImportError.js';
import {ImportStats} from './ImportStats.js';
import {ImportWarning} from './ImportWarning.js';
import {Queue} from '../Queue.js';
import {ReuseLastCall} from '../ReuseLastCall.js';

export type ImportProvider<T> = {
    /**
     *
     */
    getByID(oldId: string): Promise<T>
    getAll(): {[Symbol.asyncIterator](): AsyncIterator<T>}

    /**
     * Find the newID for a given oldID, in case the oldID was already imported previously in another run.
     */
    findExisting(oldItem: T): Promise<T|undefined>

    /**
     * Recreate an existing item in the new account.
     */
    recreate(oldItem: T): Promise<string>
    revert(oldItem: T, newItem: T): Promise<void>
    confirm?(oldItem: T, newItem: T): Promise<void>
}
export default class Importer<T extends {id: string}> {
    objectName: string;
    stats: ImportStats;
    provider: ImportProvider<T>;

    recreatedMap: Map<string, string> = new Map();
    revertedSet: Set<string> = new Set();
    confirmedSet: Set<string> = new Set();

    runningRecreateJobs = new ReuseLastCall<string>();
    runningRevertJobs = new ReuseLastCall<void>();
    runningConfirmJobs = new ReuseLastCall<void>();

    constructor(options: {objectName: string, provider: ImportProvider<T>, stats: ImportStats}) {
        this.objectName = options.objectName;
        this.provider = options.provider;
        this.stats = options.stats;
    }

    private async runInQueue(method: 'recreate' | 'revert' | 'confirm', options: {groupErrors: boolean} = {groupErrors: false}): Promise<ErrorGroup|undefined> {
        // Loop through all items in the provider and import them
        const queue = new Queue();
        const errorGroup = new ErrorGroup();
        for await (const item of this.provider.getAll()) {
            queue.add(async () => {
                try {
                    await this[method](item);
                } catch (e: any) {
                    if (!options.groupErrors) {
                        if (isWarning(e)) {
                            errorGroup.add(e);
                            return;
                        }
                        throw e;
                    }
                    if (isWarning(e)) {
                        Logger.shared.warn(e.toString());
                    } else {
                        Logger.shared.error(e.toString());
                    }
                    errorGroup.add(e);
                }
            });
        }
        await queue.waitUntilFinished();
        errorGroup.throwIfNotEmpty();

        return errorGroup.isEmpty ? undefined : errorGroup;
    }

    /**
     * Loop through all the available items in the old account, and recreate them in the new account.
     * @returns An ErrorGroup if there were only warnings
     */
    async recreateAll(): Promise<ErrorGroup|undefined> {
        return this.runInQueue('recreate', {groupErrors: true});
    }

    async revertAll() {
        return this.runInQueue('revert', {groupErrors: true});
    }

    async confirmAll() {
        return this.runInQueue('confirm', {groupErrors: true});
    }

    async recreateByObjectOrId(idOrItem: string | T) {
        if (typeof idOrItem === 'string') {
            return await this.recreateByID(idOrItem);
        } else {
            return await this.recreate(idOrItem);
        }
    }

    async recreateByID(id: string): Promise<string> {
        // Check if already imported
        const alreadyRecreatedId = this.recreatedMap.get(id);
        if (alreadyRecreatedId) {
            Logger.vv?.info(`Skipped ${this.objectName} ${id}, because already recreated as ${alreadyRecreatedId} in this run`);
            return alreadyRecreatedId;
        }

        const item = await this.provider.getByID(id);
        return await this.recreate(item);
    }

    async revertByObjectOrId(idOrItem: string | T) {
        if (typeof idOrItem === 'string') {
            return await this.revertByID(idOrItem);
        } else {
            return await this.revert(idOrItem);
        }
    }

    async revertByID(id: string): Promise<void> {
        // Check if already imported
        const alreadReverted = this.revertedSet.has(id);
        if (alreadReverted) {
            Logger.vv?.info(`Skipped reverting ${id}, because already reverted in this run`);
            return;
        }

        const item = await this.provider.getByID(id);
        return await this.revert(item);
    }

    async recreateAndConfirm(item: T): Promise<string> {
        const id = await this.recreate(item);
        await this.confirm(item);
        return id;
    }

    async recreate(item: T): Promise<string> {
        return this.runningRecreateJobs.schedule(item.id, async () => {
            // Check if already imported
            // We need to repeat this because sometimes the item is passed directly to this method, without going through recreateByID()
            const alreadyRecreatedId = this.recreatedMap.get(item.id);
            if (alreadyRecreatedId) {
                Logger.vv?.info(`Skipped ${this.objectName} ${item.id}, because already recreated as ${alreadyRecreatedId} in this run`);
                return alreadyRecreatedId;
            }

            // To make sure the operation is idempotent, we first check if the item was already recreated in a previous run.
            const reuse = await this.provider.findExisting(item);
            if (reuse) {
                Logger.vv?.info(`Skipped ${this.objectName} ${item.id} because already recreated as ${reuse.id} in a previous run`);
                this.stats.trackReused(this.objectName);

                // Mark id, so we don't need to look it up again
                this.recreatedMap.set(item.id, reuse.id);
                return reuse.id;
            }

            // Import
            Logger.vv?.info(`Recreating ${this.objectName} ${item.id}...`);

            let newID: string;
            try {
                newID = await this.provider.recreate(item);
            } catch (e: any) {
                if (e instanceof ImportWarning) {
                    throw new ImportWarning({
                        message: 'Failed to recreate ' + this.objectName + ' ' + item.id,
                        cause: e
                    });
                }
                throw new ImportError({
                    message: 'Failed to recreate ' + this.objectName + ' ' + item.id,
                    cause: e
                });
            }

            this.recreatedMap.set(item.id, newID);
            Logger.v?.ok(`Recreated ${this.objectName} ${item.id} as ${newID} in new account`);
            this.stats.trackImported(this.objectName);
            return newID;
        });
    }

    async revert(item: T): Promise<void> {
        return this.runningRevertJobs.schedule(item.id, async () => {
            // Check if already reverted
            const alreadyReverted = this.revertedSet.has(item.id);
            if (alreadyReverted) {
                Logger.vv?.info(`Skipped reverting ${this.objectName} ${item.id}, because already reverted in this run`);
                return;
            }

            const newItem = await this.provider.findExisting(item);
            if (!newItem) {
                // Not yet created
                Logger.vv?.info(`Skipped reverting ${this.objectName} ${item.id} because not yet recreated in new account`);

                // Mark id, so we don't need to look it up again
                this.revertedSet.add(item.id);
                return;
            }

            // Import
            Logger.vv?.info(`Removing ${newItem.id} (${item.id} in old account)`);

            try {
                await this.provider.revert(item, newItem);
            } catch (e: any) {
                if (e instanceof ImportWarning) {
                    throw new ImportWarning({
                        message: 'Failed to revert ' + this.objectName + ' ' + item.id,
                        cause: e
                    });
                }
                throw new ImportError({
                    message: 'Failed to revert ' + this.objectName + ' ' + item.id,
                    cause: e
                });
            }

            this.revertedSet.add(item.id);
            Logger.v?.ok(`Removed ${newItem.id}`);
            this.stats.trackReverted(this.objectName);
        });
    }

    async confirm(item: T): Promise<void> {
        return this.runningConfirmJobs.schedule(item.id, async () => {
            if (!this.provider.confirm) {
                return;
            }

            // Check if already reverted
            const alreadyConfirmed = this.confirmedSet.has(item.id);
            if (alreadyConfirmed) {
                Logger.vv?.info(`Skipped confirming ${item.id}, because already confirmed in this run`);
                return;
            }

            const newItem = await this.provider.findExisting(item);
            if (!newItem) {
                // Not yet created
                // Logger.vv?.info(`Skipped confirming ${item.id} because not yet recreated in new account`);
                //this.stats.addWarning('Could not confirm ' + this.objectName + ' ' + item.id + ' because not yet recreated in new account: did you disable creating new subscriptions in the old account? Consider running copy again.');

                // Mark id, so we don't need to look it up again
                this.confirmedSet.add(item.id);

                throw new ImportWarning({
                    message: 'Could not confirm ' + this.objectName + ' ' + item.id + ' because not yet recreated in new account: did you disable creating new subscriptions in the old account? Consider running copy again.'
                });
            }

            // Import
            Logger.vv?.info(`Confirming ${newItem.id} (${item.id} in old account)`);

            try {
                await this.provider.confirm(item, newItem);
            } catch (e: any) {
                if (e instanceof ImportWarning) {
                    throw new ImportWarning({
                        message: 'Failed to confirm ' + this.objectName + ' ' + item.id,
                        cause: e
                    });
                }
                throw new ImportError({
                    message: 'Failed to confirm ' + this.objectName + ' ' + item.id,
                    cause: e
                });
            }

            this.confirmedSet.add(item.id);
            Logger.v?.ok(`Confirmed ${newItem.id}`);
            this.stats.trackConfirmed(this.objectName);
        });
    }
}
