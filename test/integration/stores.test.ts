import { afterEach, describe, expect, it } from "vitest";
import { CronJob } from "../../src/cron-job.js";
import { CronRegistry } from "../../src/cron-registry.js";
import { CronScheduler } from "../../src/cron-scheduler.js";
import type { StoreConfig } from "../../src/models/store.model.js";
import { fakeLogger } from "../helpers.js";

/**
 * The same round trip against each real store: a job runs, a job that is no
 * longer registered is removed, and only this service's names are touched.
 * Each driver is skipped unless its URL is in the environment, so `npm test`
 * needs no database and CI can add them one at a time:
 *
 *   CRONMAN_TEST_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/app
 *   CRONMAN_TEST_MONGO_URL=mongodb://127.0.0.1:27017/cronman
 *   CRONMAN_TEST_REDIS_URL=redis://127.0.0.1:6379
 */
const DRIVERS: { name: string; env: string; store: (url: string) => StoreConfig }[] = [
	{
		name: "postgres",
		env: "CRONMAN_TEST_POSTGRES_URL",
		store: (connectionString) => ({ driver: "postgres", connectionString }),
	},
	{
		name: "mongo",
		env: "CRONMAN_TEST_MONGO_URL",
		store: (address) => ({ driver: "mongo", address, collection: "cronmanTestJobs" }),
	},
	{
		name: "redis",
		env: "CRONMAN_TEST_REDIS_URL",
		store: (connectionString) => ({ driver: "redis", connectionString, keyPrefix: "cronman-test:" }),
	},
];

const RUN_TIMEOUT_MS = 20_000;

async function waitFor(condition: () => boolean, timeoutMs = RUN_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("timed out waiting for the job to run");
}

for (const driver of DRIVERS) {
	const url = process.env[driver.env];

	describe.skipIf(!url)(`CronScheduler on ${driver.name}`, () => {
		// A fresh service name per run, so a leftover row from an earlier run
		// cannot make this pass or fail for the wrong reason.
		const service = `cronman-test-${driver.name}-${Date.now()}`;
		const running: CronScheduler[] = [];

		function scheduler(jobs: CronRegistry | []): CronScheduler {
			const cron = new CronScheduler({
				service,
				store: driver.store(url as string),
				jobs: Array.isArray(jobs) ? jobs : jobs.list(),
				logger: fakeLogger(),

				// Agenda polls every five seconds by default; the tests should not.
				processEvery: "1 second",
			});

			running.push(cron);

			return cron;
		}

		afterEach(async () => {
			await Promise.all(running.splice(0).map((cron) => cron.stop()));
		});

		it("runs a job it scheduled", async () => {
			const registry = new CronRegistry();
			let runs = 0;

			new CronJob({
				name: "alpha",
				schedule: "0 3 * * *",
				runOnStart: true,
				data: { source: "integration" },
				handler: async (job) => {
					expect(job.attrs.data).toEqual({ source: "integration" });
					runs += 1;
				},
				registry,
			});

			const cron = scheduler(registry);
			const summary = await cron.start();

			expect(summary.scheduled).toEqual([`${service}::alpha`]);
			await waitFor(() => runs > 0);
			expect(runs).toBeGreaterThan(0);
		}, RUN_TIMEOUT_MS + 10_000);

		it("removes a job that is no longer registered, and nothing else", async () => {
			const registry = new CronRegistry();

			new CronJob({ name: "beta", schedule: "0 4 * * *", handler: async () => {}, registry });

			const cron = scheduler(registry);
			const summary = await cron.start();

			// alpha survived the previous test's stop, and is gone from this registry.
			expect(summary.removed).toBe(1);
			expect(summary.scheduled).toEqual([`${service}::beta`]);
		}, RUN_TIMEOUT_MS);

		it("queues a run on demand", async () => {
			const registry = new CronRegistry();
			let runs = 0;

			new CronJob({
				name: "beta",
				schedule: "0 4 * * *",
				handler: async () => {
					runs += 1;
				},
				registry,
			});

			const cron = scheduler(registry);

			await cron.start();
			await cron.runNow("beta");
			await waitFor(() => runs > 0);
			expect(runs).toBeGreaterThan(0);
		}, RUN_TIMEOUT_MS + 10_000);

		it("leaves the store with nothing of this service once the jobs are gone", async () => {
			const cron = scheduler([]);
			const summary = await cron.start();

			expect(summary.scheduled).toEqual([]);
			expect(summary.removed).toBe(1);
		}, RUN_TIMEOUT_MS);
	});
}
