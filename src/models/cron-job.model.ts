/**
 * Where a run reports to. Pass the application's own logger — pino, winston,
 * a Sentry wrapper — and the default writes to the console, so a job needs no
 * logging wiring of its own.
 */
export interface CronLogger {
	info(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

/** The job object the store hands the handler. Only what a handler reads. */
export interface CronJobContext<Data = unknown> {
	attrs: {
		name: string;
		data?: Data;
		failCount?: number | null;
		lastRunAt?: Date | null;
	};
}

export interface CronJobOptions<Data> {

	/** Unique inside one registry. The scheduler prefixes it with the service name. */
	name: string;

	/**
	 * A crontab expression (`30 * * * *`), a human interval (`2 hours`), or a
	 * number of milliseconds. Crontab expressions are read in the scheduler's
	 * timezone.
	 */
	schedule: string | number;
	handler: (job: CronJobContext<Data>) => Promise<void>;

	/** Passed to every run as `job.attrs.data`. */
	data?: Data;

	/**
	 * Replaces `schedule` when `NODE_ENV` is not `production`, so a job that
	 * runs quarter-hourly in production can be watched locally without waiting.
	 */
	devSchedule?: string | number;

	/**
	 * Turns the job off without deleting it. A disabled job is not defined, and
	 * the scheduler removes its rows on the next start, so switching one off is
	 * a one word edit rather than a commented out registry line.
	 */
	enabled?: boolean;

	/**
	 * Run once at startup on top of the schedule. Off by default: with it on,
	 * every deploy fires every job, which turns a rolling restart into a burst.
	 */
	runOnStart?: boolean;

	/**
	 * How long one run may hold its lock. Past it another process may take the
	 * job over, so this is the honest worst case runtime and not a guess — a
	 * value below the real runtime is what makes a job run twice at once.
	 * Default five minutes.
	 */
	maxRuntimeMs?: number;

	/** Registry to join. Defaults to the shared `cronRegistry`. */
	registry?: CronJobSink;
}

/** What a registry has to offer a job being constructed. */
export interface CronJobSink {
	add(job: SchedulableCronJob): void;
}

/**
 * What the scheduler needs from a job once the type of its data is erased, so
 * jobs with unrelated payloads can sit in one registry.
 */
export interface SchedulableCronJob {
	readonly name: string;
	readonly schedule: string | number;
	readonly enabled: boolean;
	readonly runOnStart: boolean;
	readonly maxRuntimeMs: number;
	readonly data: unknown;

	/** The scheduler passes its own logger, so every job reports to one place. */
	run(job: CronJobContext, logger?: CronLogger): Promise<void>;
}
