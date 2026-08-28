import { beforeEach, describe, expect, it } from "vitest";
import { CronJob } from "../src/cron-job.js";
import { CronRegistry, cronRegistry } from "../src/cron-registry.js";

function job(registry: CronRegistry, name: string): CronJob {
	return new CronJob({ name, schedule: "* * * * *", handler: async () => {}, registry });
}

describe("CronRegistry", () => {
	let registry: CronRegistry;

	beforeEach(() => {
		registry = new CronRegistry();
	});

	it("keeps registration order", () => {
		job(registry, "first");
		job(registry, "second");
		job(registry, "third");

		expect(registry.list().map((j) => j.name)).toEqual(["first", "second", "third"]);
		expect(registry.size).toBe(3);
	});

	it("refuses a duplicate name instead of replacing the first job", () => {
		const first = job(registry, "same");

		expect(() => job(registry, "same")).toThrow('cron job "same" is already registered');
		expect(registry.get("same")).toBe(first);
		expect(registry.size).toBe(1);
	});

	it("answers has() and get()", () => {
		const only = job(registry, "only");

		expect(registry.has("only")).toBe(true);
		expect(registry.has("missing")).toBe(false);
		expect(registry.get("only")).toBe(only);
		expect(registry.get("missing")).toBeUndefined();
	});

	it("clears", () => {
		job(registry, "gone");
		registry.clear();

		expect(registry.size).toBe(0);
		expect(registry.list()).toEqual([]);
	});

	it("keeps two registries apart", () => {
		const other = new CronRegistry();

		job(registry, "shared-name");
		expect(() => job(other, "shared-name")).not.toThrow();
		expect(registry.size).toBe(1);
		expect(other.size).toBe(1);
	});

	it("exports a shared registry a job joins by default", () => {
		const before = cronRegistry.size;

		new CronJob({ name: "default-registry", schedule: "* * * * *", handler: async () => {} });

		expect(cronRegistry.size).toBe(before + 1);
		expect(cronRegistry.has("default-registry")).toBe(true);
		cronRegistry.clear();
	});
});
