import { CronJob } from "cronman";

/**
 * One file per job, and constructing it is what registers it. Nothing has to
 * be added to the scheduler.
 */
export const heartbeatJob = new CronJob({
	name: "heartbeat",
	schedule: "30 * * * *",
	runOnStart: true,
	handler: async () => {
		console.info("still alive");
	},
});

export const purgeJob = new CronJob<{ retentionMonths: number }>({
	name: "purge-old-rows",

	// 00:01 on the first day of every month, in the scheduler's timezone.
	schedule: "1 0 1 * *",
	data: { retentionMonths: 60 },

	// It works in batches and may legitimately run long. The lock has to
	// outlive that, or a second replica joins in.
	maxRuntimeMs: 30 * 60_000,
	handler: async (job) => {
		const { retentionMonths } = job.attrs.data ?? { retentionMonths: 60 };

		console.info(`purging rows older than ${retentionMonths} months`);
	},
});
