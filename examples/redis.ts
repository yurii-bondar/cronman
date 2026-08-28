import { CronScheduler } from "cronman";

import "./jobs.js";

// No client of its own to pass: the scheduler opens one from the URL and
// closes it when the store owns it.
const cron = new CronScheduler({
	service: "billing",
	store: {
		driver: "redis",
		connectionString: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
		keyPrefix: "billing:cron:",
	},
});

await cron.start();
