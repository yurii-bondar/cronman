import type { AgendaOptions, RetryDetails } from "agenda";
import type { CronJobContext, CronLogger, SchedulableCronJob } from "./cron-job.model.js";
import type { StoreConfig } from "./store.model.js";

/**
 * The part of Agenda this package uses. Declaring it makes the dependency
 * visible in one place and lets a test drive the scheduler without a store.
 */
export interface AgendaLike {
	on(event: "fail", listener: (error: Error, job: CronJobContext) => void): unknown;

	/** A run finished without throwing. */
	on(event: "success", listener: (job: CronJobContext) => void): unknown;

	/** A run finished either way — fired alongside `success` or `fail`. */
	on(event: "complete", listener: (job: CronJobContext) => void): unknown;

	/** A failed run was requeued under a `backoff` strategy rather than given up on. */
	on(event: "retry", listener: (job: CronJobContext, details: RetryDetails) => void): unknown;
	define(
		name: string,
		processor: (job: CronJobContext) => Promise<void>,
		options?: Record<string, unknown>,
	): void;
	start(): Promise<void>;
	every(
		interval: string | number,
		name: string,
		data?: unknown,
		options?: Record<string, unknown>,
	): Promise<unknown>;
	now(name: string, data?: unknown): Promise<unknown>;
	cancel(options: { names?: string[] }): Promise<number>;
	drain(options: { timeout?: number; closeConnection?: boolean }): Promise<DrainOutcome>;
	db: { getDistinctJobNames(): Promise<string[]> };
}

export interface DrainOutcome {
	timedOut: boolean;
	running: number;
}

export interface CronSchedulerOptions {

	/**
	 * The application this is. Becomes the job name prefix, so one table,
	 * collection or key space can hold the jobs of several services and each
	 * still recognises its own.
	 */
	service: string;

	/** Which store keeps the schedule. Required unless `engine` is given. */
	store?: StoreConfig;

	/** Timezone crontab expressions are read in. Default `UTC`. */
	timezone?: string;

	/** Defaults to every job registered through the `CronJob` constructor. */
	jobs?: SchedulableCronJob[];
	logger?: CronLogger;

	/**
	 * How long `stop()` waits for a running job before it gives up on it. Keep
	 * it below the shutdown budget of whatever supervises the process, or that
	 * kills it first, with the job still holding its lock. Default 8 seconds.
	 */
	drainTimeoutMs?: number;

	/**
	 * How often the store is polled for jobs that are due. Default 5 seconds,
	 * Agenda's own. The Postgres and Redis backends also push notifications, so
	 * this is the fallback rather than the only path.
	 */
	processEvery?: string | number;

	/**
	 * A ready Agenda instance, used instead of building one from `store`. This
	 * is the seam the tests use, and the way to reuse a connection this package
	 * knows nothing about.
	 */
	engine?: AgendaLike;

	/**
	 * Any other Agenda option — `logging`, `defaultConcurrency`,
	 * `maxConcurrency`, `defaultLockLimit`, … — passed straight to
	 * `new Agenda()`. Without it, options Agenda supports but this package
	 * does not name individually (persistent job logging chief among them)
	 * have no way to reach the engine at all.
	 *
	 * `backend` and `name` stay out of it: the scheduler builds the first from
	 * `store` and derives the second from `service` and the process id, and an
	 * override here would fight both.
	 */
	agendaOptions?: Omit<AgendaOptions, "backend" | "name">;
}

/** What one `start()` set up. Returned so a caller can log or assert on it. */
export interface CronStartSummary {
	scheduled: string[];
	removed: number;
}
