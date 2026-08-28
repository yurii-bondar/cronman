import type { StoreConfig } from "../models/store.model.js";

/**
 * The backend packages are optional peer dependencies, so they are imported at
 * runtime and treated as untyped here. Importing their types instead would put
 * all three in this package's own .d.ts, and a consumer who installed only one
 * of them could no longer compile.
 */
export type BackendModule = Record<string, new (config: unknown) => unknown>;

/**
 * How the backend package is fetched. Overridable so a test can stand in for a
 * package that is not installed, or one that exports something unexpected.
 */
export interface BackendLoader {
	(packageName: string): Promise<BackendModule>;
}

const PACKAGE_BY_DRIVER = {
	postgres: "@agendajs/postgres-backend",
	mongo: "@agendajs/mongo-backend",
	redis: "@agendajs/redis-backend",
} as const;

const CLASS_BY_DRIVER = {
	postgres: "PostgresBackend",
	mongo: "MongoBackend",
	redis: "RedisBackend",
} as const;

/** Builds the Agenda backend the store config asks for. */
export async function createBackend(store: StoreConfig, load: BackendLoader = importPackage): Promise<unknown> {
	const packageName = PACKAGE_BY_DRIVER[store.driver];

	if (!packageName) {
		throw new Error(
			`unknown cron store driver "${String(store.driver)}", expected one of: ${Object.keys(PACKAGE_BY_DRIVER).join(", ")}`,
		);
	}

	const config = backendConfig(store);
	const module = await loadOrExplain(packageName, load);
	const Backend = module[CLASS_BY_DRIVER[store.driver]];

	if (typeof Backend !== "function") {
		throw new Error(`${packageName} does not export ${CLASS_BY_DRIVER[store.driver]}`);
	}

	return new Backend(config);
}

/**
 * Turns a store config into the options of its backend. Each driver has one
 * way to reuse a connection the application already holds and one way to open
 * its own, and refusing neither is what turns a typo into a clear message
 * rather than a connection attempt against a default address.
 */
function backendConfig(store: StoreConfig): Record<string, unknown> {
	if (store.driver === "postgres") {
		if (!store.pool && !store.connectionString) {
			throw new Error("the postgres cron store needs a connectionString or a pool");
		}

		return {
			...(store.pool ? { pool: store.pool } : { connectionString: store.connectionString }),
			tableName: store.tableName,
			channelName: store.channelName,
			ensureSchema: store.ensureSchema,
			disableNotifications: store.disableNotifications,
		};
	}

	if (store.driver === "mongo") {
		if (!store.db && !store.address) {
			throw new Error("the mongo cron store needs an address or a db");
		}

		return {
			...(store.db ? { mongo: store.db } : { address: store.address }),
			collection: store.collection,
			ensureIndex: store.ensureIndex,
		};
	}

	if (!store.client && !store.connectionString) {
		throw new Error("the redis cron store needs a connectionString or a client");
	}

	return {
		...(store.client ? { redis: store.client } : { connectionString: store.connectionString }),
		keyPrefix: store.keyPrefix,
		channelName: store.channelName,
	};
}

/**
 * Turns a missing optional dependency into the install line that fixes it, and
 * leaves every other import failure alone. It wraps the call rather than the
 * import itself, so a replaced loader reports a missing package the same way.
 */
async function loadOrExplain(packageName: string, load: BackendLoader): Promise<BackendModule> {
	try {
		return await load(packageName);
	} catch (e) {
		const code = (e as { code?: string }).code;

		if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
			throw new Error(`${packageName} is not installed. Run: npm install ${packageName}`, {
				cause: e,
			});
		}
		throw e;
	}
}

async function importPackage(packageName: string): Promise<BackendModule> {
	return (await import(packageName)) as BackendModule;
}
