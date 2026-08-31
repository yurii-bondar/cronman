import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackend } from "../src/backends/create-backend.js";
import type { StoreConfig } from "../src/models/store.model.js";

const built: { kind: string; config: Record<string, unknown> }[] = [];

vi.mock("@agendajs/postgres-backend", () => ({
	PostgresBackend: class {
		constructor(config: Record<string, unknown>) {
			built.push({ kind: "postgres", config });
		}
	},
}));

vi.mock("@agendajs/mongo-backend", () => ({
	MongoBackend: class {
		constructor(config: Record<string, unknown>) {
			built.push({ kind: "mongo", config });
		}
	},
}));

vi.mock("@agendajs/redis-backend", () => ({
	RedisBackend: class {
		constructor(config: Record<string, unknown>) {
			built.push({ kind: "redis", config });
		}
	},
}));

describe("createBackend", () => {
	beforeEach(() => {
		built.length = 0;
	});

	describe("postgres", () => {
		it("opens its own pool from a connection string", async () => {
			await createBackend({
				driver: "postgres",
				connectionString: "postgresql://user:pass@localhost:5432/app",
				tableName: "cron_jobs",
			});

			expect(built[0]?.kind).toBe("postgres");
			expect(built[0]?.config).toMatchObject({
				connectionString: "postgresql://user:pass@localhost:5432/app",
				tableName: "cron_jobs",
			});
			expect(built[0]?.config).not.toHaveProperty("pool");
		});

		it("prefers a pool the application already holds", async () => {
			const pool = { marker: "the app pool" };

			await createBackend({
				driver: "postgres",
				pool,
				poolConfig: { marker: "ignored" },
				connectionString: "postgresql://ignored",
			});

			expect(built[0]?.config.pool).toBe(pool);
			expect(built[0]?.config).not.toHaveProperty("poolConfig");
			expect(built[0]?.config).not.toHaveProperty("connectionString");
		});

		it("passes a poolConfig through so the backend can size the pool it opens", async () => {
			const poolConfig = {
				connectionString: "postgresql://localhost/app",
				options: "-c search_path=cron",
				max: 2,
			};

			await createBackend({ driver: "postgres", poolConfig });

			expect(built[0]?.config.poolConfig).toBe(poolConfig);
			expect(built[0]?.config).not.toHaveProperty("connectionString");
		});

		it("refuses a tableName that reads as schema-qualified, and names the fix", async () => {
			await expect(
				createBackend({
					driver: "postgres",
					connectionString: "postgresql://localhost/app",
					tableName: "cron.agenda_jobs",
				}),
			).rejects.toThrow(/must be a plain identifier[\s\S]*search_path=cron/);
		});

		it("passes the log table through and holds it to the same rule", async () => {
			await createBackend({
				driver: "postgres",
				connectionString: "postgresql://localhost/app",
				logTableName: "cron_logs",
			});

			expect(built[0]?.config.logTableName).toBe("cron_logs");

			await expect(
				createBackend({
					driver: "postgres",
					connectionString: "postgresql://localhost/app",
					logTableName: "cron.logs",
				}),
			).rejects.toThrow(/logTableName must be a plain identifier/);
		});

		it("refuses a tableName Postgres would silently truncate", async () => {
			await expect(
				createBackend({
					driver: "postgres",
					connectionString: "postgresql://localhost/app",
					tableName: "a".repeat(46),
				}),
			).rejects.toThrow(/tableName must be at most 45 bytes/);

			await createBackend({
				driver: "postgres",
				connectionString: "postgresql://localhost/app",
				tableName: "a".repeat(45),
			});

			expect(built[0]?.config.tableName).toBe("a".repeat(45));
		});

		it("gives the channel the full identifier length, since nothing is derived from it", async () => {
			await createBackend({
				driver: "postgres",
				connectionString: "postgresql://localhost/app",
				channelName: "c".repeat(63),
			});

			expect(built[0]?.config.channelName).toBe("c".repeat(63));

			await expect(
				createBackend({
					driver: "postgres",
					connectionString: "postgresql://localhost/app",
					channelName: "c".repeat(64),
				}),
			).rejects.toThrow(/channelName must be at most 63 bytes/);
		});

		it("refuses a channelName that could break out of its quotes", async () => {
			await expect(
				createBackend({
					driver: "postgres",
					connectionString: "postgresql://localhost/app",
					channelName: 'cron"; DROP TABLE agenda_jobs; --',
				}),
			).rejects.toThrow(/channelName must be a plain identifier/);
		});

		it("passes the notification and schema switches through", async () => {
			await createBackend({
				driver: "postgres",
				connectionString: "postgresql://localhost/app",
				channelName: "cron",
				ensureSchema: false,
				disableNotifications: true,
			});

			expect(built[0]?.config).toMatchObject({
				channelName: "cron",
				ensureSchema: false,
				disableNotifications: true,
			});
		});

		it("refuses a config with no connection at all", async () => {
			await expect(createBackend({ driver: "postgres" })).rejects.toThrow(
				"the postgres cron store needs a connectionString, a poolConfig or a pool",
			);
		});
	});

	describe("mongo", () => {
		it("opens its own connection from an address", async () => {
			await createBackend({
				driver: "mongo",
				address: "mongodb://localhost:27017/app",
				collection: "cronJobs",
			});

			expect(built[0]?.kind).toBe("mongo");
			expect(built[0]?.config).toMatchObject({
				address: "mongodb://localhost:27017/app",
				collection: "cronJobs",
			});
		});

		it("prefers a Db the application already holds, under the key agenda wants", async () => {
			const db = { marker: "the app db" };

			await createBackend({ driver: "mongo", db, address: "mongodb://ignored" });

			expect(built[0]?.config.mongo).toBe(db);
			expect(built[0]?.config).not.toHaveProperty("address");
		});

		it("refuses a config with no connection at all", async () => {
			await expect(createBackend({ driver: "mongo" })).rejects.toThrow(
				"the mongo cron store needs an address or a db",
			);
		});
	});

	describe("redis", () => {
		it("opens its own client from a connection string", async () => {
			await createBackend({
				driver: "redis",
				connectionString: "redis://localhost:6379",
				keyPrefix: "cron:",
			});

			expect(built[0]?.kind).toBe("redis");
			expect(built[0]?.config).toMatchObject({
				connectionString: "redis://localhost:6379",
				keyPrefix: "cron:",
			});
		});

		it("prefers a client the application already holds, under the key agenda wants", async () => {
			const client = { marker: "the app redis" };

			await createBackend({ driver: "redis", client, connectionString: "redis://ignored" });

			expect(built[0]?.config.redis).toBe(client);
			expect(built[0]?.config).not.toHaveProperty("connectionString");
		});

		it("refuses a config with no connection at all", async () => {
			await expect(createBackend({ driver: "redis" })).rejects.toThrow(
				"the redis cron store needs a connectionString or a client",
			);
		});
	});

	it("names the drivers it knows when given one it does not", async () => {
		await expect(
			createBackend({ driver: "sqlite" } as unknown as StoreConfig),
		).rejects.toThrow(/unknown cron store driver "sqlite"/);
	});
});
