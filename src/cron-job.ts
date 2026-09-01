import type { BackoffStrategy } from "agenda";
import { cronRegistry } from "./cron-registry.js";
import type {
	CronJobContext,
	CronJobOptions,
	CronLogger,
	SchedulableCronJob,
} from "./models/cron-job.model.js";

const DEFAULT_MAX_RUNTIME_MS = 5 * 60_000;

/**
 * One cron job: its schedule, its handler, and the logging around a run. A job
 * is created by constructing this class, which also registers it — there is no
 * second step and no way to write a job the scheduler cannot see.
 */
export class CronJob<Data = void> implements SchedulableCronJob {
	readonly name: string;

	readonly schedule: string | number;

	readonly enabled: boolean;

	readonly runOnStart: boolean;

	readonly maxRuntimeMs: number;

	readonly data: unknown;

	readonly logging?: boolean;

	readonly priority?: number;

	readonly backoff?: BackoffStrategy;

	readonly forkMode?: boolean;

	readonly startDate?: Date | string;

	readonly endDate?: Date | string;

	readonly skipDays?: number[];

	private readonly handler: (job: CronJobContext<Data>) => Promise<void>;

	constructor(options: CronJobOptions<Data>) {
		if (!options.name?.trim()) throw new Error("a cron job needs a name");
		if (typeof options.handler !== "function") {
			throw new Error(`cron job "${options.name}" needs a handler`);
		}
		this.name = options.name;
		this.schedule = CronJob.pickSchedule(options);
		this.enabled = options.enabled ?? true;
		this.runOnStart = options.runOnStart ?? false;
		this.maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
		this.data = options.data;
		this.logging = options.logging;
		this.priority = options.priority;
		this.backoff = options.backoff;
		this.forkMode = options.forkMode;
		this.startDate = options.startDate;
		this.endDate = options.endDate;
		this.skipDays = options.skipDays;
		this.handler = options.handler;
		(options.registry ?? cronRegistry).add(this);
	}

	/**
	 * Runs the handler and reports how long it took. The error is logged and
	 * then rethrown on purpose: Agenda records the failure, counts it and backs
	 * off, which a swallowed error turns into a job that looks healthy forever.
	 */
	async run(job: CronJobContext, logger: CronLogger = console): Promise<void> {
		const startedAt = Date.now();

		logger.info(`cron ${this.name} start`);

		try {
			await this.handler(job as CronJobContext<Data>);
			logger.info(`cron ${this.name} done`, { ms: Date.now() - startedAt });
		} catch (e) {
			logger.error(`cron ${this.name} failed`, {
				ms: Date.now() - startedAt,
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
	}

	private static pickSchedule<T>(options: CronJobOptions<T>): string | number {
		if (process.env.NODE_ENV === "production") return options.schedule;

		return options.devSchedule ?? options.schedule;
	}
}
