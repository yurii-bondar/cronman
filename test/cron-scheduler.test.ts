import { beforeEach, describe, expect, it } from "vitest";
import { CronJob } from "../src/cron-job.js";
import { CronRegistry } from "../src/cron-registry.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { FakeAgenda, fakeLogger, jobContext } from "./helpers.js";

function scheduler(engine: FakeAgenda, registry: CronRegistry, logger = fakeLogger()) {
	return {
		logger,
		cron: new CronScheduler({ service: "play", engine, jobs: registry.list(), logger }),
	};
}

describe("CronScheduler", () => {
	let registry: CronRegistry;
	let engine: FakeAgenda;

	beforeEach(() => {
		registry = new CronRegistry();
		engine = new FakeAgenda();
	});

	describe("constructor", () => {
		it("needs a service name", () => {
			expect(() => new CronScheduler({ service: " ", engine })).toThrow(
				"a cron scheduler needs a service name",
			);
		});

		it("needs a store or an engine", () => {
			expect(() => new CronScheduler({ service: "play" })).toThrow(
				"a cron scheduler needs a store or an engine",
			);
		});
	});

	describe("start", () => {
		it("defines and schedules every enabled job under the service prefix", async () => {
			new CronJob({ name: "example", schedule: "30 * * * *", handler: async () => {}, registry });
			new CronJob({ name: "purge", schedule: "1 0 1 * *", handler: async () => {}, registry });

			const { cron } = scheduler(engine, registry);
			const summary = await cron.start();

			expect(engine.defined.map((d) => d.name)).toEqual(["play::example", "play::purge"]);
			expect(engine.scheduled.map((s) => [s.name, s.interval])).toEqual([
				["play::example", "30 * * * *"],
				["play::purge", "1 0 1 * *"],
			]);
			expect(engine.started).toBe(1);
			expect(summary).toEqual({ scheduled: ["play::example", "play::purge"], removed: 0 });
		});

		it("locks a job to one run at a time for as long as it may take", async () => {
			new CronJob({
				name: "slow",
				schedule: "* * * * *",
				maxRuntimeMs: 1_800_000,
				handler: async () => {},
				registry,
			});

			const { cron } = scheduler(engine, registry);

			await cron.start();

			expect(engine.defined[0]?.options).toEqual({
				concurrency: 1,
				lockLimit: 1,
				lockLifetime: 1_800_000,
				removeOnComplete: true,
			});
		});

		it("reads crontab in the configured timezone and never fires on definition", async () => {
			new CronJob({ name: "kyiv", schedule: "0 4 * * *", handler: async () => {}, registry });

			const cron = new CronScheduler({
				service: "play",
				engine,
				jobs: registry.list(),
				timezone: "Europe/Kyiv",
				logger: fakeLogger(),
			});

			await cron.start();

			expect(engine.scheduled[0]?.options).toEqual({
				timezone: "Europe/Kyiv",
				skipImmediate: true,
			});
		});

		it("defaults to UTC", async () => {
			new CronJob({ name: "utc", schedule: "0 4 * * *", handler: async () => {}, registry });
			await scheduler(engine, registry).cron.start();

			expect(engine.scheduled[0]?.options).toMatchObject({ timezone: "UTC" });
		});

		it("queues an extra run for a runOnStart job, and only for it", async () => {
			new CronJob({
				name: "eager",
				schedule: "30 * * * *",
				runOnStart: true,
				data: { source: "boot" },
				handler: async () => {},
				registry,
			});
			new CronJob({ name: "patient", schedule: "30 * * * *", handler: async () => {}, registry });

			await scheduler(engine, registry).cron.start();

			expect(engine.ranNow).toEqual([{ name: "play::eager", data: { source: "boot" } }]);
		});

		it("skips a disabled job entirely", async () => {
			new CronJob({
				name: "off",
				schedule: "* * * * *",
				enabled: false,
				handler: async () => {},
				registry,
			});
			new CronJob({ name: "on", schedule: "* * * * *", handler: async () => {}, registry });

			const { cron } = scheduler(engine, registry);
			const summary = await cron.start();

			expect(engine.defined.map((d) => d.name)).toEqual(["play::on"]);
			expect(summary.scheduled).toEqual(["play::on"]);
		});

		it("passes the job data through to the schedule", async () => {
			new CronJob({
				name: "with-data",
				schedule: "* * * * *",
				data: { batch: 500 },
				handler: async () => {},
				registry,
			});

			await scheduler(engine, registry).cron.start();

			expect(engine.scheduled[0]?.data).toEqual({ batch: 500 });
		});

		it("runs the job through its own logging when the store calls it", async () => {
			const runs: string[] = [];

			new CronJob({
				name: "invoked",
				schedule: "* * * * *",
				handler: async () => {
					runs.push("ran");
				},
				registry,
			});

			const { cron, logger } = scheduler(engine, registry);

			await cron.start();
			await engine.defined[0]?.processor(jobContext());

			expect(runs).toEqual(["ran"]);
			expect(logger.info).toHaveBeenCalledWith("cron invoked start");
		});

		it("refuses to start twice", async () => {
			const { cron } = scheduler(engine, registry);

			await cron.start();
			await expect(cron.start()).rejects.toThrow("cron scheduler is already started");
		});

		it("reports a non-error failure as a string", async () => {
			const { cron, logger } = scheduler(engine, registry);

			await cron.start();
			engine.failListener?.(
				"lock lost" as unknown as Error,
				{ attrs: { name: "play::example", failCount: 1 } },
			);

			expect(logger.error).toHaveBeenCalledWith("cron run failed", {
				job: "play::example",
				attempts: 1,
				error: "lock lost",
			});
		});

		it("logs a failure the store reports", async () => {
			const { cron, logger } = scheduler(engine, registry);

			await cron.start();
			engine.failListener?.(new Error("wallet timeout"), {
				attrs: { name: "play::example", failCount: 3 },
			});

			expect(logger.error).toHaveBeenCalledWith("cron run failed", {
				job: "play::example",
				attempts: 3,
				error: "wallet timeout",
			});
		});
	});

	describe("dropping jobs that are gone", () => {
		it("removes only this service's stale names", async () => {
			engine.storedNames = [
				"play::example",
				"play::deleted-last-release",
				"wallet::outbox",
				"session::cleanup",
			];
			new CronJob({ name: "example", schedule: "* * * * *", handler: async () => {}, registry });

			const { cron } = scheduler(engine, registry);
			const summary = await cron.start();

			expect(engine.cancelled).toEqual([["play::deleted-last-release"]]);
			expect(summary.removed).toBe(1);
		});

		it("removes a job that was switched off", async () => {
			engine.storedNames = ["play::off"];
			new CronJob({
				name: "off",
				schedule: "* * * * *",
				enabled: false,
				handler: async () => {},
				registry,
			});

			await scheduler(engine, registry).cron.start();

			expect(engine.cancelled).toEqual([["play::off"]]);
		});

		it("cancels nothing when the store holds only registered jobs", async () => {
			engine.storedNames = ["play::example"];
			new CronJob({ name: "example", schedule: "* * * * *", handler: async () => {}, registry });

			await scheduler(engine, registry).cron.start();

			expect(engine.cancelled).toEqual([]);
		});
	});

	describe("stop", () => {
		it("drains with the configured budget and leaves the connection open", async () => {
			const cron = new CronScheduler({
				service: "play",
				engine,
				jobs: [],
				drainTimeoutMs: 2_000,
				logger: fakeLogger(),
			});

			await cron.start();
			await cron.stop();

			expect(engine.drains).toEqual([{ timeout: 2_000, closeConnection: false }]);
		});

		it("defaults the drain budget to eight seconds", async () => {
			const { cron } = scheduler(engine, registry);

			await cron.start();
			await cron.stop();

			expect(engine.drains[0]?.timeout).toBe(8_000);
		});

		it("says so when a job outlived the budget", async () => {
			engine.drainOutcome = { timedOut: true, running: 2 };

			const { cron, logger } = scheduler(engine, registry);

			await cron.start();
			await cron.stop();

			expect(logger.error).toHaveBeenCalledWith("cron shutdown timed out", { running: 2 });
		});

		it("stays quiet when the budget expired with nothing left running", async () => {
			engine.drainOutcome = { timedOut: true, running: 0 };

			const { cron, logger } = scheduler(engine, registry);

			await cron.start();
			await cron.stop();

			expect(logger.error).not.toHaveBeenCalled();
		});

		it("is a no-op before start", async () => {
			const { cron } = scheduler(engine, registry);

			await expect(cron.stop()).resolves.toBeUndefined();
			expect(engine.drains).toEqual([]);
		});

		it("can be started again after stopping", async () => {
			const { cron } = scheduler(engine, registry);

			await cron.start();
			await cron.stop();
			await expect(cron.start()).resolves.toMatchObject({ removed: 0 });
			expect(engine.started).toBe(2);
		});
	});

	describe("runNow", () => {
		it("queues a registered job under its qualified name", async () => {
			new CronJob({
				name: "purge",
				schedule: "1 0 1 * *",
				data: { dryRun: false },
				handler: async () => {},
				registry,
			});

			const { cron } = scheduler(engine, registry);

			await cron.start();
			await cron.runNow("purge");

			expect(engine.ranNow).toEqual([{ name: "play::purge", data: { dryRun: false } }]);
		});

		it("refuses a name nobody registered", async () => {
			const { cron } = scheduler(engine, registry);

			await cron.start();
			await expect(cron.runNow("ghost")).rejects.toThrow('cron job "ghost" is not registered');
		});

		it("refuses to queue anything before start", async () => {
			new CronJob({ name: "purge", schedule: "* * * * *", handler: async () => {}, registry });

			const { cron } = scheduler(engine, registry);

			await expect(cron.runNow("purge")).rejects.toThrow("cron scheduler is not started");
		});
	});

	describe("names", () => {
		it("qualifies every registered job", () => {
			new CronJob({ name: "a", schedule: "* * * * *", handler: async () => {}, registry });
			new CronJob({ name: "b", schedule: "* * * * *", handler: async () => {}, registry });

			const { cron } = scheduler(engine, registry);

			expect(cron.names).toEqual(["play::a", "play::b"]);
			expect(cron.qualify("a")).toBe("play::a");
		});
	});
});
