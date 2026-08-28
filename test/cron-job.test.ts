import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronJob } from "../src/cron-job.js";
import { CronRegistry } from "../src/cron-registry.js";
import { fakeLogger, jobContext } from "./helpers.js";

const FIVE_MINUTES_MS = 5 * 60_000;

describe("CronJob", () => {
	let registry: CronRegistry;
	const nodeEnv = process.env.NODE_ENV;

	beforeEach(() => {
		registry = new CronRegistry();
	});

	afterEach(() => {
		process.env.NODE_ENV = nodeEnv;
		vi.restoreAllMocks();
	});

	it("registers itself and applies the defaults", () => {
		const job = new CronJob({
			name: "nightly",
			schedule: "0 3 * * *",
			handler: async () => {},
			registry,
		});

		expect(registry.get("nightly")).toBe(job);
		expect(job.enabled).toBe(true);
		expect(job.runOnStart).toBe(false);
		expect(job.maxRuntimeMs).toBe(FIVE_MINUTES_MS);
		expect(job.data).toBeUndefined();
	});

	it("keeps the options it was given", () => {
		const job = new CronJob({
			name: "hourly",
			schedule: "30 * * * *",
			handler: async () => {},
			data: { batch: 100 },
			enabled: false,
			runOnStart: true,
			maxRuntimeMs: 1_000,
			registry,
		});

		expect(job.schedule).toBe("30 * * * *");
		expect(job.enabled).toBe(false);
		expect(job.runOnStart).toBe(true);
		expect(job.maxRuntimeMs).toBe(1_000);
		expect(job.data).toEqual({ batch: 100 });
	});

	it("accepts a millisecond interval as a schedule", () => {
		const job = new CronJob({ name: "ms", schedule: 30_000, handler: async () => {}, registry });

		expect(job.schedule).toBe(30_000);
	});

	it("refuses a job with no name", () => {
		expect(
			() => new CronJob({ name: "  ", schedule: "* * * * *", handler: async () => {}, registry }),
		).toThrow("a cron job needs a name");
	});

	it("refuses a job with no handler", () => {
		expect(
			() =>
				new CronJob({
					name: "broken",
					schedule: "* * * * *",
					handler: undefined as unknown as () => Promise<void>,
					registry,
				}),
		).toThrow('cron job "broken" needs a handler');
	});

	describe("devSchedule", () => {
		it("replaces the schedule outside production", () => {
			process.env.NODE_ENV = "development";

			const job = new CronJob({
				name: "dev",
				schedule: "0 3 * * *",
				devSchedule: "*/1 * * * *",
				handler: async () => {},
				registry,
			});

			expect(job.schedule).toBe("*/1 * * * *");
		});

		it("is ignored in production", () => {
			process.env.NODE_ENV = "production";

			const job = new CronJob({
				name: "prod",
				schedule: "0 3 * * *",
				devSchedule: "*/1 * * * *",
				handler: async () => {},
				registry,
			});

			expect(job.schedule).toBe("0 3 * * *");
		});

		it("leaves the schedule alone when it is not set", () => {
			process.env.NODE_ENV = "development";

			const job = new CronJob({
				name: "no-dev",
				schedule: "0 3 * * *",
				handler: async () => {},
				registry,
			});

			expect(job.schedule).toBe("0 3 * * *");
		});
	});

	describe("run", () => {
		it("passes the job through to the handler", async () => {
			const seen: unknown[] = [];
			const job = new CronJob<{ batch: number }>({
				name: "with-data",
				schedule: "* * * * *",
				data: { batch: 7 },
				handler: async (agendaJob) => {
					seen.push(agendaJob.attrs.data);
				},
				registry,
			});

			await job.run(jobContext({ batch: 7 }));

			expect(seen).toEqual([{ batch: 7 }]);
		});

		it("logs the start and the duration of a run", async () => {
			const logger = fakeLogger();
			const job = new CronJob({
				name: "timed",
				schedule: "* * * * *",
				handler: async () => {},
				registry,
			});

			await job.run(jobContext(), logger);

			expect(logger.info).toHaveBeenNthCalledWith(1, "cron timed start");
			expect(logger.info).toHaveBeenNthCalledWith(2, "cron timed done", {
				ms: expect.any(Number),
			});
			expect(logger.error).not.toHaveBeenCalled();
		});

		it("logs a failure and rethrows it so the store records it", async () => {
			const logger = fakeLogger();
			const job = new CronJob({
				name: "failing",
				schedule: "* * * * *",
				handler: async () => {
					throw new Error("boom");
				},
				registry,
			});

			await expect(job.run(jobContext(), logger)).rejects.toThrow("boom");
			expect(logger.error).toHaveBeenCalledWith("cron failing failed", {
				ms: expect.any(Number),
				error: "boom",
			});
		});

		it("reports a thrown non-error as a string", async () => {
			const logger = fakeLogger();
			const job = new CronJob({
				name: "odd",
				schedule: "* * * * *",
				handler: async () => {
					throw "just a string";
				},
				registry,
			});

			await expect(job.run(jobContext(), logger)).rejects.toBeTruthy();
			expect(logger.error).toHaveBeenCalledWith("cron odd failed", {
				ms: expect.any(Number),
				error: "just a string",
			});
		});

		it("falls back to the console when no logger is passed", async () => {
			const info = vi.spyOn(console, "info").mockImplementation(() => {});
			const job = new CronJob({
				name: "console",
				schedule: "* * * * *",
				handler: async () => {},
				registry,
			});

			await job.run(jobContext());

			expect(info).toHaveBeenCalledWith("cron console start");
		});
	});
});
