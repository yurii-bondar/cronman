import { vi } from "vitest";
import type { CronJobContext, CronLogger } from "../src/models/cron-job.model.js";
import type { AgendaLike, DrainOutcome } from "../src/models/cron-scheduler.model.js";

type LogFn = (message: string, fields?: Record<string, unknown>) => void;

export function fakeLogger() {
	const logger = { info: vi.fn<LogFn>(), error: vi.fn<LogFn>() };

	return logger satisfies CronLogger;
}

export function jobContext<Data>(data?: Data, name = "job"): CronJobContext<Data> {
	return { attrs: { name, data } };
}

export interface DefinedJob {
	name: string;
	processor: (job: CronJobContext) => Promise<void>;
	options?: Record<string, unknown>;
}

export interface ScheduledJob {
	interval: string | number;
	name: string;
	data: unknown;
	options?: Record<string, unknown>;
}

/**
 * A stand-in for Agenda that records what the scheduler asked of it. The
 * scheduler talks to `AgendaLike` and nothing else, so every behaviour except
 * the store itself can be asserted without a database.
 */
export class FakeAgenda implements AgendaLike {
	defined: DefinedJob[] = [];

	scheduled: ScheduledJob[] = [];

	ranNow: { name: string; data: unknown }[] = [];

	cancelled: string[][] = [];

	drains: { timeout?: number; closeConnection?: boolean }[] = [];

	started = 0;

	storedNames: string[] = [];

	drainOutcome: DrainOutcome = { timedOut: false, running: 0 };

	failListener?: (error: Error, job: CronJobContext) => void;

	db = {
		getDistinctJobNames: async (): Promise<string[]> => this.storedNames,
	};

	on(event: "fail", listener: (error: Error, job: CronJobContext) => void): this {
		if (event === "fail") this.failListener = listener;

		return this;
	}

	define(
		name: string,
		processor: (job: CronJobContext) => Promise<void>,
		options?: Record<string, unknown>,
	): void {
		this.defined.push({ name, processor, options });
	}

	async start(): Promise<void> {
		this.started += 1;
	}

	async every(
		interval: string | number,
		name: string,
		data?: unknown,
		options?: Record<string, unknown>,
	): Promise<unknown> {
		this.scheduled.push({ interval, name, data, options });

		return undefined;
	}

	async now(name: string, data?: unknown): Promise<unknown> {
		this.ranNow.push({ name, data });

		return undefined;
	}

	async cancel(options: { names?: string[] }): Promise<number> {
		this.cancelled.push(options.names ?? []);

		return options.names?.length ?? 0;
	}

	async drain(options: { timeout?: number; closeConnection?: boolean }): Promise<DrainOutcome> {
		this.drains.push(options);

		return this.drainOutcome;
	}
}
