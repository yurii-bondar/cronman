import { Pool } from "pg";
import { CronScheduler } from "cronman";

// Importing the jobs is what registers them, so it has to happen before start.
import "./jobs.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const cron = new CronScheduler({
	service: "billing",
	store: { driver: "postgres", pool },
	timezone: "UTC",
});

await cron.start();

// Shut down in this order: the scheduler lets a running job finish, and only
// then does the pool it borrowed go away.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, async () => {
		await cron.stop();
		await pool.end();
		process.exit(0);
	});
}
