import { MongoClient } from "mongodb";
import { CronScheduler } from "cronman";

import "./jobs.js";

const client = new MongoClient(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017");

await client.connect();

const cron = new CronScheduler({
	service: "billing",
	store: { driver: "mongo", db: client.db("billing"), collection: "cronJobs" },
});

await cron.start();
