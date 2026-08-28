/**
 * Which store keeps the schedule. Only the driver named here has to be
 * installed: the backend package is loaded when `CronScheduler.start()` runs,
 * so a service on Postgres never pulls in the Mongo or Redis client.
 *
 * Every field beyond `driver` is passed to the matching `@agendajs/*-backend`
 * unchanged. The types of the client objects are deliberately `unknown` rather
 * than imported: the packages that declare them are optional, and importing a
 * type from one of them would make this package fail to compile for anyone who
 * installed only the other two.
 */
export interface PostgresStoreConfig {
	driver: "postgres";

	/** For example `postgresql://user:pass@localhost:5432/app`. */
	connectionString?: string;

	/**
	 * An existing `pg.Pool`. Preferred when the application already has one:
	 * the scheduler adds no second pool and never closes this one.
	 */
	pool?: unknown;

	/** Table the jobs live in. Created on connect. Default `agenda_jobs`. */
	tableName?: string;

	/** LISTEN/NOTIFY channel. Default `agenda_jobs`. */
	channelName?: string;

	/** Create the table and its indexes on connect. Default true. */
	ensureSchema?: boolean;

	/** Fall back to polling instead of LISTEN/NOTIFY. Default false. */
	disableNotifications?: boolean;
}

export interface MongoStoreConfig {
	driver: "mongo";

	/** For example `mongodb://localhost:27017/app`. */
	address?: string;

	/** An existing `mongodb` `Db` instance, used instead of `address`. */
	db?: unknown;

	/** Collection the jobs live in. Default `agendaJobs`. */
	collection?: string;

	/** Create the indexes on connect. Default true. */
	ensureIndex?: boolean;
}

export interface RedisStoreConfig {
	driver: "redis";

	/** For example `redis://localhost:6379`. */
	connectionString?: string;

	/** An existing `ioredis` client, used instead of `connectionString`. */
	client?: unknown;

	/** Prefix for every key. Default `agenda:`. */
	keyPrefix?: string;

	/** Pub/Sub channel. Default `agenda:notifications`. */
	channelName?: string;
}

export type StoreConfig = PostgresStoreConfig | MongoStoreConfig | RedisStoreConfig;

export type StoreDriver = StoreConfig["driver"];
