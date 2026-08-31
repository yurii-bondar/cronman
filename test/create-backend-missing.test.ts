import { describe, expect, it } from "vitest";
import { createBackend } from "../src/backends/create-backend.js";
import type { BackendModule } from "../src/backends/create-backend.js";

/** What Node throws when the optional peer dependency was never installed. */
function moduleNotFound(packageName: string): Error {
	const error = new Error(`Cannot find package '${packageName}'`) as Error & { code: string };

	error.code = "ERR_MODULE_NOT_FOUND";

	return error;
}

describe("createBackend when the backend package is not usable", () => {
	it("turns a missing optional dependency into the install line that fixes it", async () => {
		await expect(
			createBackend({ driver: "redis", connectionString: "redis://localhost:6379" }, (name) =>
				Promise.reject(moduleNotFound(name)),
			),
		).rejects.toThrow(
			"@agendajs/redis-backend is not installed. Run: npm install @agendajs/redis-backend",
		);
	});

	it("passes an unrelated import failure through untouched", async () => {
		await expect(
			createBackend({ driver: "postgres", connectionString: "postgresql://localhost/app" }, () =>
				Promise.reject(new Error("disk on fire")),
			),
		).rejects.toThrow("disk on fire");
	});

	it("says so when the package is there but exports nothing it can use", async () => {
		await expect(
			createBackend({ driver: "mongo", address: "mongodb://localhost:27017/app" }, async () =>
				({}) as BackendModule,
			),
		).rejects.toThrow("@agendajs/mongo-backend does not export MongoBackend");
	});

	it("validates the store config before it touches the package", async () => {
		let loaded = false;

		await expect(
			createBackend({ driver: "postgres" }, async () => {
				loaded = true;

				return {} as BackendModule;
			}),
		).rejects.toThrow("needs a connectionString, a poolConfig or a pool");
		expect(loaded).toBe(false);
	});
});
