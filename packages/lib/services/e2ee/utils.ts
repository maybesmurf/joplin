import Logger from '../../Logger';
import BaseItem from '../../models/BaseItem';
import MasterKey from '../../models/MasterKey';
import Setting from '../../models/Setting';
import { MasterKeyEntity } from '../database/types';
import EncryptionService from '../EncryptionService';
import { getActiveMasterKeyId, setEncryptionEnabled } from '../synchronizer/syncInfoUtils';

const logger = Logger.create('e2ee/utils');

export async function setupAndEnableEncryption(masterKey: MasterKeyEntity = null, password: string = null) {
	if (!masterKey) {
		// May happen for example if there are master keys in info.json but none
		// of them is set as active. But in fact, unless there is a bug in the
		// application, this shouldn't happen.
		logger.warn('Setting up E2EE without a master key - user will need to either generate one or select one of the existing ones as active');
	}

	setEncryptionEnabled(true, masterKey ? masterKey.id : null);

	if (masterKey && password) {
		const passwordCache = Setting.value('encryption.passwordCache');
		passwordCache[masterKey.id] = password;
		Setting.setValue('encryption.passwordCache', passwordCache);
	}

	// Mark only the non-encrypted ones for sync since, if there are encrypted ones,
	// it means they come from the sync target and are already encrypted over there.
	await BaseItem.markAllNonEncryptedForSync();
}

export async function setupAndDisableEncryption() {
	// Allow disabling encryption even if some items are still encrypted, because whether E2EE is enabled or disabled
	// should not affect whether items will enventually be decrypted or not (DecryptionWorker will still work as
	// long as there are encrypted items). Also even if decryption is disabled, it's possible that encrypted items
	// will still be received via synchronisation.

	setEncryptionEnabled(false);

	// The only way to make sure everything gets decrypted on the sync target is
	// to re-sync everything.
	await BaseItem.forceSyncAll();
}

export async function generateMasterKeyAndEnableEncryption(service: EncryptionService, password: string) {
	let masterKey = await service.generateMasterKey(password);
	masterKey = await MasterKey.save(masterKey);
	await setupAndEnableEncryption(masterKey, password);
	await loadMasterKeysFromSettings(service);
	return masterKey;
}

export async function loadMasterKeysFromSettings(service: EncryptionService) {
	const masterKeys = await MasterKey.all();
	const passwords = Setting.value('encryption.passwordCache');
	const activeMasterKeyId = getActiveMasterKeyId();

	logger.info(`Trying to load ${masterKeys.length} master keys...`);

	for (let i = 0; i < masterKeys.length; i++) {
		const mk = masterKeys[i];
		const password = passwords[mk.id];
		if (service.isMasterKeyLoaded(mk.id)) continue;
		if (!password) continue;

		try {
			await service.loadMasterKey_(mk, password, activeMasterKeyId === mk.id);
		} catch (error) {
			logger.warn(`Cannot load master key ${mk.id}. Invalid password?`, error);
		}
	}

	logger.info(`Loaded master keys: ${service.loadedMasterKeysCount()}`);
}