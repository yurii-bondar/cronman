/**
 * Which store keeps the schedule. Only the driver named here has to be
 * installed: the backend package is loaded when `CronScheduler.start()` runs,
 * so a service on Postgres never pulls in the Mongo or Redis client.
 *
 * Every field beyond `driver` is passed to the matching `@agendajs/*-backend`
 * unchanged, except that the connection fields are reduced to whichever one
 * wins and the Postgres identifiers are validated before they reach SQL.
 *
 * The types of the client objects are deliberately `unknown` rather than
 * imported: the packages that declare them are optional, and importing a type
 * from one of them would make this package fail to compile for anyone who
 * installed only the other two.
 */
export interface PostgresStoreConfig {
	driver: "postgres";

	/** For example `postgresql://user:pass@localhost:5432/app`. */
	connectionString?: string;

	/**
	 * An existing `pg.Pool`. Preferred when the application already has one:
	 * the scheduler adds no second pool and never closes this one.
	 *
	 * Also the only way to attach your own `pool.on("error")` handler. The pool
	 * the backend opens for itself has none, and an unhandled `error` event on
	 * an idle connection ends the process.
	 */
	pool?: unknown;

	/**
	 * Full `pg.PoolConfig` for a pool the backend opens and closes itself —
	 * `connectionString` plus whatever else node-postgres takes (`max`,
	 * `options`, timeouts). Use it instead of `connectionString` when the
	 * defaults do not fit; use `pool` when you need to hold the pool yourself.
	 */
	poolConfig?: unknown;

	/**
	 * Table the jobs live in. Created on connect. Default `agenda_jobs`.
	 *
	 * A plain identifier, not a qualified name: the backend both quotes it as
	 * one identifier and splices it into a function name, so `"app.jobs"` is a
	 * table called `app.jobs`, never `jobs` in schema `app`. To place the
	 * tables in a schema, point the connection at it:
	 * `poolConfig: { connectionString, options: "-c search_path=app" }`.
	 */
	tableName?: string;

	/** LISTEN/NOTIFY channel, a plain identifier. Default `agenda_jobs`. */
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
