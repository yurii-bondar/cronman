import type { CronLogger } from "./models/cron-job.model.js";

/** The fields of an Agenda job the guard reads. */
interface HeldJob {
	attrs: { _id?: unknown; name: string; lockedAt?: Date | null };
}

/**
 * The internals of Agenda 6.2.6's `JobProcessor` the guard touches. None of it
 * is exported, which is why it is declared here and checked at run time
 * rather than imported.
 */
interface JobProcessorInternals {
	lockedJobs: HeldJob[];
	runningJobs: HeldJob[];
	jobQueue: { getQueue(): HeldJob[] };
	updateStatus(name: string, key: "locked", delta: number): void;
	process(): Promise<void>;
}

interface EngineInternals {
	jobProcessor?: unknown;
	definitions?: Record<string, { lockLifetime?: number } | undefined>;
	db?: { unlockJob?(attrs: HeldJob["attrs"]): Promise<unknown> };
}

/**
 * Agenda 6.2.6 drops a job whose lock has expired by the time its turn in the
 * local queue comes (`JobProcessor.jobProcessing`): the job leaves the queue,
 * but stays in `lockedJobs`, its name's `locked` count is not given back, and
 * the store row keeps its lock. Under the `lockLimit: 1` every job here is
 * defined with, that count never falls below the limit again, so the process
 * stops locking that job for good — it never runs again until a restart, and
 * nothing is logged. A stall longer than `maxRuntimeMs` between the lock and
 * the turn is enough: a laptop asleep, a long GC pause, a throttled container.
 *
 * Before each poll, the guard gives back every lock that is held but neither
 * queued nor running and has outlived its lifetime, the way Agenda itself
 * releases a job it decides not to run yet. Returns false, and changes
 * nothing, on an engine that does not look like that version's.
 */
export function guardLockLeaks(engine: unknown, logger: CronLogger): boolean {
	const internals = engine as EngineInternals;
	const processor = internals.jobProcessor;

	if (!isJobProcessor(processor) || typeof internals.db?.unlockJob !== "function") return false;

	const poll = processor.process.bind(processor);

	processor.process = async () => {
		await releaseLeakedLocks(processor, internals, logger);
		await poll();
	};

	return true;
}

/** Gives back the leaked locks; exported for the tests. */
export async function releaseLeakedLocks(
	processor: JobProcessorInternals,
	engine: EngineInternals,
	logger: CronLogger,
	now = Date.now(),
): Promise<number> {
	const busy = new Set([...processor.jobQueue.getQueue(), ...processor.runningJobs].map(idOf));
	const leaked = processor.lockedJobs.filter((job) => !busy.has(idOf(job)) && expired(job, engine, now));

	for (const job of leaked) {
		processor.lockedJobs.splice(processor.lockedJobs.indexOf(job), 1);
		processor.updateStatus(job.attrs.name, "locked", -1);

		try {
			await engine.db?.unlockJob?.(job.attrs);
		} catch (error) {
			// The store lock has expired anyway, so another poll can take the job
			// even if this unlock never lands.
			logger.error("cron could not unlock a released job", {
				job: job.attrs.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		logger.error("cron released a lock Agenda had leaked", {
			job: job.attrs.name,
			lockedAt: job.attrs.lockedAt?.toISOString(),
		});
	}

	return leaked.length;
}

function expired(job: HeldJob, engine: EngineInternals, now: number): boolean {
	const lifetime = engine.definitions?.[job.attrs.name]?.lockLifetime;
	const lockedAt = job.attrs.lockedAt;

	if (lifetime === undefined || !lockedAt) return false;

	return new Date(lockedAt).getTime() < now - lifetime;
}

function idOf(job: HeldJob): unknown {
	return job.attrs._id === undefined ? job : String(job.attrs._id);
}

function isJobProcessor(value: unknown): value is JobProcessorInternals {
	const candidate = value as Partial<JobProcessorInternals> | undefined;

	return (
		Array.isArray(candidate?.lockedJobs) &&
		Array.isArray(candidate?.runningJobs) &&
		typeof candidate?.jobQueue?.getQueue === "function" &&
		typeof candidate?.updateStatus === "function" &&
		typeof candidate?.process === "function"
	);
}
