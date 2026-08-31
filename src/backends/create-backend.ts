import type { PostgresStoreConfig, StoreConfig } from "../models/store.model.js";

/** What Postgres accepts unquoted, and so what these two names are held to. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

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
		if (!store.pool && !store.poolConfig && !store.connectionString) {
			throw new Error("the postgres cron store needs a connectionString, a poolConfig or a pool");
		}

		assertPlainIdentifier(store.tableName, "tableName");
		assertPlainIdentifier(store.channelName, "channelName");

		return {
			...postgresConnection(store),
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
 * Which of the three ways to reach Postgres the config asked for. A pool the
 * application holds wins over one the backend would open, because only the
 * first can carry an `error` handler and a lifetime the application controls.
 */
function postgresConnection(store: PostgresStoreConfig): Record<string, unknown> {
	if (store.pool) {
		return { pool: store.pool };
	}

	if (store.poolConfig) {
		return { poolConfig: store.poolConfig };
	}

	return { connectionString: store.connectionString };
}

/**
 * Both names reach Postgres spliced into SQL rather than bound as parameters —
 * `"${tableName}"` in the DDL, `LISTEN "${channelName}"` — so anything but a
 * plain identifier is either an injection or, more often, a misunderstanding
 * worth catching here rather than three queries later.
 */
function assertPlainIdentifier(value: string | undefined, field: string): void {
	if (value === undefined || PLAIN_IDENTIFIER.test(value)) {
		return;
	}

	if (value.includes(".")) {
		throw new Error(
			`the postgres cron store's ${field} must be a plain identifier: "${value}" names one object containing a dot, ` +
				`not "${value.slice(value.indexOf(".") + 1)}" in schema "${value.slice(0, value.indexOf("."))}". ` +
				`To put the tables in a schema, point the connection at it: ` +
				`poolConfig: { connectionString, options: "-c search_path=${value.slice(0, value.indexOf("."))}" }`,
		);
	}

	throw new Error(
		`the postgres cron store's ${field} must be a plain identifier — a letter or underscore ` +
			`followed by letters, digits, underscores or $ — got "${value}"`,
	);
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
