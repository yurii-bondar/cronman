# cronman — typed cron jobs on Postgres, MongoDB or Redis

[![CI](https://github.com/yurii-bondar/cronman/actions/workflows/ci.yml/badge.svg)](https://github.com/yurii-bondar/cronman/actions/workflows/ci.yml)

>#### Content
>[About](#about)<br>
[Install](#install)
[Quick start](#quick-start)
[Defining a job](#defining-a-job)
[The registry](#the-registry)
[The scheduler](#the-scheduler)
[Stores](#stores)
[Job names and automatic cleanup](#job-names)
[One run at a time](#one-run-at-a-time)
[Graceful shutdown](#graceful-shutdown)
[Logging](#logging)
[Schedules and timezones](#schedules)
[Testing](#testing)
[Known limitations](#known-limitations)
[License](#license)

<a name="about"><h2>About</h2></a>

A thin, typed layer over [Agenda](https://www.npmjs.com/package/agenda) 6 that
answers the questions every service repeats when it grows a second cron job:

- **A job is a class.** `new CronJob({ ... })` and that is the whole
  declaration — schedule, handler, lock lifetime, whether it may run at
  startup. Constructing it registers it, so a job the scheduler cannot see
  cannot be written.
- **One registry.** Adding a job is one file plus one import line. The
  scheduler is never edited.
- **The schedule lives in a store, not in the process.** Several replicas of
  one service share it and exactly one of them runs each occurrence — the lock
  belongs to the database, not to a leader election you have to write.
- **Postgres, MongoDB or Redis, your choice.** One config field. Only the
  driver you name has to be installed.
- **Jobs that are gone are removed.** Delete a job from the code, or switch it
  off, and its entry disappears from the store on the next start — and only
  the entries of your own service are ever touched.
- **Shutdown waits for the work.** `stop()` lets a running job finish instead
  of cutting it off with its lock held.

<a name="install"><h2>Install</h2></a>

```bash
npm install cronman

# then exactly one store driver
npm install @agendajs/postgres-backend            # Postgres
npm install @agendajs/mongo-backend mongodb       # MongoDB
npm install @agendajs/redis-backend               # Redis
```

The three backends are **optional** peer dependencies: a service on Postgres
never pulls in the Mongo or Redis client. Node 18+, ESM only.

<a name="quick-start"><h2>Quick start</h2></a>

```ts
// jobs/heartbeat.job.ts — one file per job
import { CronJob } from 'cronman';

export const heartbeatJob = new CronJob({
  name: 'heartbeat',
  schedule: '30 * * * *',   // every hour at half past
  runOnStart: true,         // plus once at startup
  handler: async () => {
    console.info('still alive');
  },
});
```

```ts
// jobs/index.ts — the list. Importing a job is what registers it.
export { heartbeatJob } from './heartbeat.job.js';
```

```ts
// index.ts
import { Pool } from 'pg';
import { CronScheduler } from 'cronman';
import './jobs/index.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const cron = new CronScheduler({
  service: 'billing',
  store: { driver: 'postgres', pool },
});

await cron.start();
// cron started { timezone: 'UTC', removed: 0, jobs: [ 'heartbeat @ 30 * * * *' ] }
```

<a name="defining-a-job"><h2>Defining a job</h2></a>

```ts
const purgeJob = new CronJob<{ retentionMonths: number }>({
  name: 'purge-old-rows',
  schedule: '1 0 1 * *',              // 00:01 on the 1st of every month
  devSchedule: '*/1 * * * *',         // outside production, every minute
  data: { retentionMonths: 60 },
  maxRuntimeMs: 30 * 60_000,
  handler: async (job) => {
    const { retentionMonths } = job.attrs.data ?? { retentionMonths: 60 };
    await purgeRowsOlderThan(retentionMonths);
  },
});
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | required | Unique inside one registry. The scheduler prefixes it with the service name. |
| `schedule` | `string \| number` | required | Crontab (`30 * * * *`), human interval (`2 hours`), or milliseconds. |
| `handler` | `(job) => Promise<void>` | required | The work. `job.attrs.data` carries `data`. |
| `data` | `Data` | — | Passed to every run. Typed by the class generic. |
| `devSchedule` | `string \| number` | — | Replaces `schedule` when `NODE_ENV !== 'production'`. |
| `enabled` | `boolean` | `true` | `false` leaves the code in place, stops the job, and removes its entry on the next start. |
| `runOnStart` | `boolean` | `false` | One extra run at startup, on top of the schedule. |
| `maxRuntimeMs` | `number` | `300000` | How long one run may hold its lock. See [One run at a time](#one-run-at-a-time). |
| `registry` | `CronRegistry` | shared | Which registry to join. Mostly for tests. |

`runOnStart` is queued as a separate one-off run rather than by moving the
schedule, because a crontab expression always points at the next matching slot
— Agenda's `skipImmediate` only shifts a plain interval. The one-off entry is
removed once it succeeds, so it does not accumulate across restarts.

<a name="the-registry"><h2>The registry</h2></a>

`cronRegistry` is the shared list a job joins when it is constructed. A
duplicate name is refused loudly, because Agenda would otherwise replace the
first definition and leave one of the two handlers unreachable.

```ts
import { cronRegistry, CronRegistry } from 'cronman';

cronRegistry.list();          // registration order
cronRegistry.has('heartbeat');
cronRegistry.get('heartbeat');
cronRegistry.size;
cronRegistry.clear();         // for tests

const isolated = new CronRegistry();   // pass as `registry` to keep jobs apart
```

<a name="the-scheduler"><h2>The scheduler</h2></a>

```ts
const cron = new CronScheduler({ service: 'billing', store, timezone: 'Europe/Kyiv' });

const summary = await cron.start();
// { scheduled: ['billing::heartbeat'], removed: 0 }

cron.names;                  // ['billing::heartbeat']
cron.qualify('heartbeat');   // 'billing::heartbeat'

await cron.runNow('heartbeat');   // one extra run, now
await cron.stop();
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `service` | `string` | required | Becomes the job name prefix. |
| `store` | `StoreConfig` | required¹ | Which store keeps the schedule. See [Stores](#stores). |
| `timezone` | `string` | `'UTC'` | The timezone crontab expressions are read in. |
| `jobs` | `SchedulableCronJob[]` | `cronRegistry.list()` | Explicit job list instead of the shared registry. |
| `logger` | `CronLogger` | `console` | Where runs report. See [Logging](#logging). |
| `drainTimeoutMs` | `number` | `8000` | How long `stop()` waits for a running job. |
| `processEvery` | `string \| number` | `'5 seconds'` | How often the store is polled for due jobs. |
| `engine` | `AgendaLike` | — | A ready Agenda instance instead of building one. See [Testing](#testing). |

¹ `store` is required unless `engine` is given.

`start()` refuses a second call rather than quietly doubling the definitions,
and `stop()` before `start()` is a no-op. A stopped scheduler can be started
again.

<a name="stores"><h2>Stores</h2></a>

Pick one driver. Every field beyond `driver` goes to the matching
`@agendajs/*-backend` unchanged.

### Postgres

```ts
store: { driver: 'postgres', pool }                     // reuse the app's pg.Pool
store: { driver: 'postgres', connectionString: '...' }  // or open its own
```

| Field | Default | Notes |
|---|---|---|
| `connectionString` | — | `postgresql://user:pass@host:5432/db` |
| `pool` | — | An existing `pg.Pool`. **Never closed by cronman.** Preferred: no second pool. |
| `tableName` | `agenda_jobs` | Created on connect. |
| `channelName` | `agenda_jobs` | `LISTEN`/`NOTIFY` channel. |
| `ensureSchema` | `true` | Set `false` if migrations own the table. |
| `disableNotifications` | `false` | Fall back to polling only. |

### MongoDB

```ts
store: { driver: 'mongo', db: client.db('billing'), collection: 'cronJobs' }
store: { driver: 'mongo', address: 'mongodb://127.0.0.1:27017/billing' }
```

| Field | Default | Notes |
|---|---|---|
| `address` | — | Connection string, when cronman should connect itself. |
| `db` | — | An existing `mongodb` `Db`. Used instead of `address`. |
| `collection` | `agendaJobs` | |
| `ensureIndex` | `true` | |

### Redis

```ts
store: { driver: 'redis', connectionString: 'redis://127.0.0.1:6379', keyPrefix: 'billing:cron:' }
store: { driver: 'redis', client: ioredisInstance }
```

| Field | Default | Notes |
|---|---|---|
| `connectionString` | — | `redis://host:6379` |
| `client` | — | An existing `ioredis` client. Used instead of `connectionString`. |
| `keyPrefix` | `agenda:` | |
| `channelName` | `agenda:notifications` | Pub/Sub channel. |

A config with neither a connection string nor a client is refused at
`start()`, so a typo becomes a clear message instead of a connection attempt
against a default address. A driver whose package is missing reports the
install line that fixes it.

Postgres and Redis also **push** notifications, so a job saved by one replica
is picked up immediately rather than on the next poll. MongoDB polls only.

<a name="job-names"><h2>Job names and automatic cleanup</h2></a>

Every job is stored as `<service>::<name>` — `billing::heartbeat`. Two things
follow:

- **One store can hold several services.** Each recognises its own entries,
  and nothing reaches across.
- **`start()` removes stale entries of this service only.** A job deleted from
  the code, or switched off with `enabled: false`, has its entry cancelled;
  the count comes back in the summary. Agenda's own `purge()` is deliberately
  not used — it removes every job whose name is undefined in the current
  process, which in a shared store means the other services' jobs.

The service **version** is deliberately not part of the name. A version there
recreates every schedule on each deploy and takes the run history with it.

<a name="one-run-at-a-time"><h2>One run at a time</h2></a>

A cron job is usually a sweep over shared state, and two runs at once would
both claim the same rows. Every job is defined with `concurrency: 1` and
`lockLimit: 1`, and holds its lock for `maxRuntimeMs`.

`maxRuntimeMs` is the honest worst case, not a guess: **a value below the real
runtime is what makes a job run twice at once**, because another replica may
take a job whose lock has expired. When a job legitimately runs long, raise it
rather than hoping.

<a name="graceful-shutdown"><h2>Graceful shutdown</h2></a>

```ts
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await cron.stop();   // waits for a running job, up to drainTimeoutMs
    await pool.end();    // only then let go of the connection cronman borrowed
    process.exit(0);
  });
}
```

Two things worth knowing:

- **Keep `drainTimeoutMs` below the shutdown budget of whatever supervises the
  process** (Kubernetes' `terminationGracePeriodSeconds`, your bootstrap's own
  timer). If that fires first, the process dies with the job still holding its
  lock, and the job stays locked until the lock expires.
- **`stop()` alone does not make Node exit.** It releases every connection,
  but Agenda leaves one internal timer behind. Exit explicitly once shutdown
  is done — the `process.exit(0)` above is not decoration.

<a name="logging"><h2>Logging</h2></a>

Pass any object with `info` and `error`; the default is `console`.

```ts
const cron = new CronScheduler({ service: 'billing', store, logger: pinoAdapter });
```

Every run already logs its start, its duration and its failures, so a handler
does not repeat that:

```text
cron started { timezone: 'UTC', removed: 1, jobs: [ 'heartbeat @ 30 * * * *' ] }
cron heartbeat start
cron heartbeat done { ms: 12 }
cron purge-old-rows failed { ms: 41, error: 'connection terminated' }
cron run failed { job: 'billing::purge-old-rows', attempts: 2, error: '...' }
```

A failing handler is logged **and rethrown**, on purpose: the store records
the failure, counts it and backs off. A swallowed error turns a broken job
into one that looks healthy forever. Log what the wrapper cannot know — how
many rows a pass deleted — and leave the rest to it.

<a name="schedules"><h2>Schedules and timezones</h2></a>

```ts
schedule: '30 * * * *'    // crontab, read in the scheduler's timezone
schedule: '1 0 1 * *'     // 00:01 on the first day of the month
schedule: '2 hours'       // human interval
schedule: 30_000          // milliseconds
```

`timezone` applies to crontab expressions and defaults to `UTC`. Intervals are
timezone-free by nature, so daylight saving cannot shift them.

<a name="testing"><h2>Testing</h2></a>

The scheduler talks to a small interface (`AgendaLike`), and `engine` is where
you put a stand-in. Every behaviour except the store itself is testable with
no database:

```ts
const cron = new CronScheduler({ service: 'billing', engine: fakeAgenda, jobs: registry.list() });
```

This package's own suite is split the same way:

```bash
npm test                  # unit suite, no database needed
npm run test:coverage

# the integration suite adds a driver per URL, and skips the ones you omit
CRONMAN_TEST_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/app \
CRONMAN_TEST_MONGO_URL=mongodb://127.0.0.1:27017/cronman \
CRONMAN_TEST_REDIS_URL=redis://127.0.0.1:6379 \
npm test
```

<a name="known-limitations"><h2>Known limitations</h2></a>

- **The store owns its schema.** The Postgres backend creates its table on
  connect, Mongo its collection and indexes, Redis its keys. If migrations
  own your schema instead, set `ensureSchema: false` and create the table
  yourself.
- **`stop()` does not end the process** — see
  [Graceful shutdown](#graceful-shutdown).
- **A crontab schedule cannot fire on definition.** `runOnStart` covers the
  "run it now as well" case; there is no way to make the recurring entry
  itself fire immediately.
- **`data` is stored, not shared.** It is serialised into the store when the
  job is scheduled. Changing `data` in code updates the entry on the next
  `start()`, not the runs already queued.
- **One scheduler per service name.** Two schedulers that share a `service`
  but not the same job list each treat the other's entries as stale and cancel
  them. Give them different service names, or the same jobs.

<a name="license"><h2>License</h2></a>

MIT © Yurii Bondar
