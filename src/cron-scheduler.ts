import { Agenda } from "agenda";
import { createBackend } from "./backends/create-backend.js";
import { cronRegistry } from "./cron-registry.js";
import type { CronLogger, SchedulableCronJob } from "./models/cron-job.model.js";
import type {
	AgendaLike,
	CronSchedulerOptions,
	CronStartSummary,
} from "./models/cron-scheduler.model.js";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_DRAIN_TIMEOUT_MS = 8_000;

/**
 * Runs the registered cron jobs off a shared store. The schedule lives there
 * rather than in this process, so several replicas of one service share it and
 * exactly one of them executes each run — the lock belongs to the store, not
 * to a leader election the application would have to write.
 */
export class CronScheduler {
	private readonly options: CronSchedulerOptions;

	private readonly logger: CronLogger;

	private readonly timezone: string;

	/**
	 * Prefixes every job name with the service that owns it. The version of the
	 * service is deliberately not part of it: a version in the name recreates
	 * every schedule on each deploy and loses the run history with it.
	 */
	private readonly prefix: string;

	private activeEngine?: AgendaLike;

	constructor(options: CronSchedulerOptions) {
		if (!options.service?.trim()) throw new Error("a cron scheduler needs a service name");
		if (!options.store && !options.engine) {
			throw new Error("a cron scheduler needs a store or an engine");
		}
		this.options = options;
		this.logger = options.logger ?? console;
		this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
		this.prefix = `${options.service}::`;
	}

	/** The qualified names of the jobs this scheduler owns, enabled ones first. */
	get names(): string[] {
		return this.jobs().map((job) => this.qualify(job.name));
	}

	/**
	 * Connects, defines the enabled jobs, drops what is no longer registered
	 * and schedules the rest. Safe to call once; a second call is refused
	 * rather than quietly doubling the definitions.
	 */
	async start(): Promise<CronStartSummary> {
		if (this.activeEngine) throw new Error("cron scheduler is already started");

		const engine = this.options.engine ?? (await this.createEngine());

		this.activeEngine = engine;
		engine.on("fail", (error, job) => {
			this.logger.error("cron run failed", {
				job: job.attrs.name,
				attempts: job.attrs.failCount,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		const active = this.jobs().filter((job) => job.enabled);

		for (const job of active) {
			engine.define(this.qualify(job.name), (agendaJob) => job.run(agendaJob, this.logger), {
				// A cron job is usually a sweep over shared state: two runs at once
				// would both claim the same rows. One at a time, per replica and
				// globally, and the lock is held for as long as the job says it may
				// take.
				concurrency: 1,
				lockLimit: 1,
				lockLifetime: job.maxRuntimeMs,

				// Only affects one-off rows, which here means the extra run a
				// `runOnStart` job is given below. The repeating row stays.
				removeOnComplete: true,

				...definedFields({
					logging: job.logging,
					priority: job.priority,
					backoff: job.backoff,
				}),
			});
		}
		await engine.start();

		const removed = await this.dropUnregistered(active);

		for (const job of active) {
			await engine.every(job.schedule, this.qualify(job.name), job.data, {
				timezone: this.timezone,

				// A crontab schedule always points at the next matching slot, so an
				// extra run at startup has to be queued on its own rather than asked
				// for here — `skipImmediate` only moves a plain interval.
				skipImmediate: true,

				...definedFields({
					forkMode: job.forkMode,
					startDate: job.startDate,
					endDate: job.endDate,
					skipDays: job.skipDays,
				}),
			});

			if (job.runOnStart) await engine.now(this.qualify(job.name), job.data);
		}

		const summary: CronStartSummary = {
			scheduled: active.map((job) => this.qualify(job.name)),
			removed,
		};

		this.logger.info("cron started", {
			timezone: this.timezone,
			removed,
			jobs: active.map((job) => `${job.name} @ ${String(job.schedule)}`),
		});

		return summary;
	}

	/**
	 * Waits for a running job to finish instead of cutting it off, and leaves
	 * every connection the caller passed in open — the application owns those.
	 * Cutting the process down mid-run is what leaves a job locked until its
	 * lock expires.
	 *
	 * Agenda keeps one timer of its own after this, so a bare Node process does
	 * not exit on this call alone. Exit explicitly once shutdown is done.
	 */
	async stop(): Promise<void> {
		if (!this.activeEngine) return;

		const result = await this.activeEngine.drain({
			timeout: this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
			closeConnection: false,
		});

		// The budget can expire in the same moment the last job finishes, and a
		// timeout with nothing left running is not a problem worth an error in
		// the log — least of all one that can wake somebody up.
		if (result.timedOut && result.running > 0) {
			this.logger.error("cron shutdown timed out", { running: result.running });
		}
		this.activeEngine = undefined;
	}

	/**
	 * The underlying engine, once started — `undefined` before `start()` and
	 * after `stop()`. `AgendaLike.on()` covers `fail`, `success`, `complete`
	 * and `retry`, so a caller can hook into any of them directly:
	 *
	 * ```ts
	 * await cron.start();
	 * cron.engine?.on('retry', (job, details) => log.warn('retrying', details));
	 * ```
	 *
	 * `fail` is also logged internally regardless of this — see `start()`.
	 */
	get engine(): AgendaLike | undefined {
		return this.activeEngine;
	}

	/** Queues one run of a registered job now, on top of its schedule. */
	async runNow(name: string): Promise<void> {
		const engine = this.running();
		const job = this.jobs().find((candidate) => candidate.name === name);

		if (!job) throw new Error(`cron job "${name}" is not registered`);
		await engine.now(this.qualify(name), job.data);
	}

	/** The job name as it appears in the store. */
	qualify(name: string): string {
		return `${this.prefix}${name}`;
	}

	private jobs(): SchedulableCronJob[] {
		return this.options.jobs ?? cronRegistry.list();
	}

	private running(): AgendaLike {
		if (!this.activeEngine) throw new Error("cron scheduler is not started");

		return this.activeEngine;
	}

	private async createEngine(): Promise<AgendaLike> {
		const { store } = this.options;

		if (!store) throw new Error("a cron scheduler needs a store or an engine");

		const backend = await createBackend(store);
		const agenda = new Agenda({
			// Identifies which replica holds a lock, in the store and in a log line.
			name: `${this.options.service}-${process.pid}`,
			backend: backend as never,
			...(this.options.processEvery === undefined
				? {}
				: { processEvery: this.options.processEvery }),
			...this.options.agendaOptions,
		});

		return agenda as unknown as AgendaLike;
	}

	/**
	 * Removes the entries of jobs this service no longer has — one deleted from
	 * the code, or switched off. Scoped to this service's prefix, because the
	 * store is shared and Agenda's own `purge()` would take the other services'
	 * jobs with it, their names being undefined in this process.
	 */
	private async dropUnregistered(active: SchedulableCronJob[]): Promise<number> {
		const engine = this.running();
		const keep = new Set(active.map((job) => this.qualify(job.name)));
		const names = await engine.db.getDistinctJobNames();
		const stale = names.filter((name) => name.startsWith(this.prefix) && !keep.has(name));

		if (stale.length === 0) return 0;

		return engine.cancel({ names: stale });
	}
}

/**
 * Keeps an `undefined` field out of the options object entirely, rather than
 * set on it, so it reads as "not given" to Agenda instead of "explicitly
 * unset" — the distinction the checks in `define()`'s options matter for
 * (e.g. `logging` falling back to `loggingDefault`).
 */
function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}
