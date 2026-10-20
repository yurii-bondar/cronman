import { describe, expect, it, vi } from "vitest";
import { guardLockLeaks, releaseLeakedLocks } from "../src/lock-leak-guard.js";
import { FakeAgenda, fakeLogger } from "./helpers.js";

const LIFETIME_MS = 70_000;
const NOW = Date.parse("2026-10-20T06:00:00Z");

function heldJob(id: string, lockedAgoMs: number, name = "svc::export") {
	return { attrs: { _id: id, name, lockedAt: new Date(NOW - lockedAgoMs) } };
}

/** The slice of Agenda 6.2.6's `JobProcessor` and engine the guard works on. */
function agendaInternals(jobs: { locked?: ReturnType<typeof heldJob>[]; queued?: string[]; running?: string[] }) {
	const lockedJobs = [...(jobs.locked ?? [])];
	const byId = (ids: string[] = []) => lockedJobs.filter((job) => ids.includes(job.attrs._id));
	const status: Record<string, { locked: number }> = {};

	const count = (name: string, delta: number) => {
		status[name] = { locked: (status[name]?.locked ?? 0) + delta };
	};

	for (const job of lockedJobs) count(job.attrs.name, 1);

	const processor = {
		lockedJobs,
		runningJobs: byId(jobs.running),
		jobQueue: { getQueue: () => byId(jobs.queued) },
		updateStatus: (name: string, _key: "locked", delta: number) => count(name, delta),
		process: vi.fn(async () => {}),
	};
	const engine = {
		jobProcessor: processor,
		definitions: { "svc::export": { lockLifetime: LIFETIME_MS } },
		db: { unlockJob: vi.fn(async () => {}) },
	};

	return { processor, engine, status };
}

describe("releaseLeakedLocks", () => {
	it("gives back a lock that is held, neither queued nor running, and past its lifetime", async () => {
		const leaked = heldJob("a", LIFETIME_MS + 1);
		const { processor, engine, status } = agendaInternals({ locked: [leaked] });
		const logger = fakeLogger();

		expect(await releaseLeakedLocks(processor, engine, logger, NOW)).toBe(1);

		expect(processor.lockedJobs).toEqual([]);
		expect(status["svc::export"]?.locked).toBe(0);
		expect(engine.db.unlockJob).toHaveBeenCalledWith(leaked.attrs);
		expect(logger.error).toHaveBeenCalledWith("cron released a lock Agenda had leaked", {
			job: "svc::export",
			lockedAt: leaked.attrs.lockedAt.toISOString(),
		});
	});

	it("leaves a queued job, a running job and a lock still within its lifetime alone", async () => {
		const { processor, engine, status } = agendaInternals({
			locked: [heldJob("queued", LIFETIME_MS + 1), heldJob("running", LIFETIME_MS + 1), heldJob("fresh", 1_000)],
			queued: ["queued"],
			running: ["running"],
		});

		expect(await releaseLeakedLocks(processor, engine, fakeLogger(), NOW)).toBe(0);

		expect(processor.lockedJobs).toHaveLength(3);
		expect(status["svc::export"]?.locked).toBe(3);
		expect(engine.db.unlockJob).not.toHaveBeenCalled();
	});

	it("still releases the job locally when the store refuses the unlock, and says so", async () => {
		const { processor, engine, status } = agendaInternals({ locked: [heldJob("a", LIFETIME_MS + 1)] });
		const logger = fakeLogger();

		engine.db.unlockJob.mockRejectedValueOnce(new Error("connection reset"));

		expect(await releaseLeakedLocks(processor, engine, logger, NOW)).toBe(1);

		expect(status["svc::export"]?.locked).toBe(0);
		expect(logger.error).toHaveBeenCalledWith("cron could not unlock a released job", {
			job: "svc::export",
			error: "connection reset",
		});
	});
});

describe("guardLockLeaks", () => {
	it("releases the leaked locks before each poll, so the poll can lock the job again", async () => {
		const { processor, engine } = agendaInternals({ locked: [heldJob("a", 365 * 24 * 3_600_000)] });
		const poll = processor.process;
		let heldAtPoll = -1;

		poll.mockImplementation(async () => {
			heldAtPoll = processor.lockedJobs.length;
		});

		expect(guardLockLeaks(engine, fakeLogger())).toBe(true);
		await processor.process();

		expect(poll).toHaveBeenCalledTimes(1);
		expect(heldAtPoll).toBe(0);
	});

	it("changes nothing on an engine without Agenda's job processor", () => {
		const engine = new FakeAgenda();

		expect(guardLockLeaks(engine, fakeLogger())).toBe(false);
		expect(guardLockLeaks({ jobProcessor: { lockedJobs: [] }, db: { unlockJob: async () => {} } }, fakeLogger())).toBe(
			false,
		);
	});
});
