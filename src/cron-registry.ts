import type { SchedulableCronJob } from "./models/cron-job.model.js";

/**
 * The list of cron jobs a process knows about. A job puts itself here when it
 * is constructed, so adding a job is one file plus one import line and nothing
 * in the scheduler changes.
 *
 * The shared instance below is what most applications use. A registry can also
 * be constructed directly and passed to `new CronJob({ registry })`, which is
 * what keeps two test files, or two schedulers in one process, apart.
 */
export class CronRegistry {
	private readonly jobs = new Map<string, SchedulableCronJob>();

	/**
	 * A repeated name would silently replace the earlier definition inside
	 * Agenda and leave one of the two handlers unreachable, so it is refused
	 * here instead.
	 */
	add(job: SchedulableCronJob): void {
		if (this.jobs.has(job.name)) {
			throw new Error(`cron job "${job.name}" is already registered`);
		}
		this.jobs.set(job.name, job);
	}

	get(name: string): SchedulableCronJob | undefined {
		return this.jobs.get(name);
	}

	has(name: string): boolean {
		return this.jobs.has(name);
	}

	/** Registration order, which is also the order the scheduler defines them in. */
	list(): SchedulableCronJob[] {
		return [...this.jobs.values()];
	}

	get size(): number {
		return this.jobs.size;
	}

	/** Forgets every job. Meant for tests, which register into a fresh registry. */
	clear(): void {
		this.jobs.clear();
	}
}

export const cronRegistry = new CronRegistry();
