// Runs jobs: a croner timer per enabled job, plus "run now". One run per job at a time.
// Shell jobs run with /bin/sh as the service user, in their own process group, with a timeout
// (SIGTERM, then SIGKILL) and output capped at retention.job_output_kb while it streams.
// Collector jobs run built-in code only. After each run the job keeps its newest
// retention.job_runs_per_job runs (the daily retention job does the same for every job).

import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';
import { capOutput } from '../retention.ts';
import { runCollectorById } from './collectors.ts';
import { startCron } from './cron.ts';
import { getJob, getJobRun, listJobs, type JobRow, type JobRunRow } from './jobs.ts';

export const TIMEOUT_EXIT = 124;
export const SPAWN_FAILED_EXIT = 127;
export const INTERRUPTED_NOTE = '[interrupted: the service stopped during this run]';

export interface SchedulerOptions {
  log?: (msg: string) => void;
  /** Overrides the collector dispatcher (tests). */
  runCollector?: (db: Db, config: Config, id: string) => Promise<unknown>;
  /** How long to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  now?: () => Date;
}

interface Active {
  runId: number;
  child?: ChildProcess;
  done: Promise<JobRunRow>;
}

export class Scheduler {
  private readonly crons = new Map<number, () => void>();
  private readonly active = new Map<number, Active>();
  private started = false;
  private readonly db: Db;
  private readonly config: Config;
  private readonly opts: SchedulerOptions;

  constructor(db: Db, config: Config, opts: SchedulerOptions = {}) {
    this.db = db;
    this.config = config;
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.error(m)))(msg);
  }

  /** Closes runs left open by a previous process, then arms a timer for each enabled job. */
  start(): void {
    if (this.started) return;
    this.started = true;
    recoverInterrupted(this.db, this.now());
    for (const job of listJobs(this.db)) this.arm(job);
  }

  /** Re-reads one job (or all) after an edit, so its timer matches the database. */
  sync(jobId?: number): void {
    if (!this.started) return;
    if (jobId === undefined) {
      for (const stop of this.crons.values()) stop();
      this.crons.clear();
      for (const job of listJobs(this.db)) this.arm(job);
      return;
    }
    this.crons.get(jobId)?.();
    this.crons.delete(jobId);
    const job = getJob(this.db, jobId);
    if (job) this.arm(job);
  }

  private arm(job: JobRow): void {
    if (job.enabled !== 1) return;
    const tz = job.timezone ?? this.config.site.timezone;
    try {
      const stop = startCron(job.schedule, tz, () => this.onTick(job.id));
      this.crons.set(job.id, stop);
    } catch (err) {
      this.log(`job ${job.id} (${job.name}): bad schedule: ${(err as Error).message}`);
    }
  }

  private onTick(jobId: number): void {
    const job = getJob(this.db, jobId);
    if (!job || job.enabled !== 1) return;
    if (this.active.has(jobId)) {
      this.log(`job ${job.id} (${job.name}): still running, skipped this run`);
      return;
    }
    this.run(job, 'schedule', null).done.catch((err: unknown) =>
      this.log(`job ${job.id} (${job.name}) failed to run: ${(err as Error).message}`),
    );
  }

  /** Ids of jobs with a live timer. */
  armed(): number[] {
    return [...this.crons.keys()].sort((a, b) => a - b);
  }

  isRunning(jobId: number): boolean {
    return this.active.has(jobId);
  }

  /** Starts a run now. Throws 409 when this job is already running. */
  run(
    job: JobRow,
    trigger: 'schedule' | 'manual',
    actor: string | null,
  ): { run: JobRunRow; done: Promise<JobRunRow> } {
    if (this.active.has(job.id))
      throw new HttpError(409, 'job_running', `Job "${job.name}" is already running`);
    const run = this.db
      .prepare(
        `INSERT INTO job_runs (job_id, started_at, trigger, actor, truncated) VALUES (?, ?, ?, ?, 0)
         RETURNING *`,
      )
      .get(job.id, this.now().toISOString(), trigger, actor) as unknown as JobRunRow;
    const entry: Active = { runId: run.id, done: Promise.resolve(run) };
    this.active.set(job.id, entry);
    entry.done = (async () => {
      let result: { exit_code: number | null; output: string; truncated: boolean };
      try {
        result =
          job.kind === 'shell' ? await this.runShell(job, entry) : await this.runCollectorJob(job);
      } catch (err) {
        result = { exit_code: 1, output: `error: ${(err as Error).message}`, truncated: false };
      }
      try {
        return this.finish(job, run.id, result);
      } finally {
        this.active.delete(job.id);
      }
    })();
    return { run, done: entry.done };
  }

  private finish(
    job: JobRow,
    runId: number,
    r: { exit_code: number | null; output: string; truncated: boolean },
  ): JobRunRow {
    const capped = capOutput(r.output, this.config.retention.job_output_kb);
    this.db
      .prepare(
        'UPDATE job_runs SET ended_at = ?, exit_code = ?, output = ?, truncated = ? WHERE id = ?',
      )
      .run(
        this.now().toISOString(),
        r.exit_code,
        capped.output,
        r.truncated || capped.truncated ? 1 : 0,
        runId,
      );
    keepNewestRuns(this.db, job.id, this.config.retention.job_runs_per_job);
    return getJobRun(this.db, runId) as JobRunRow;
  }

  private async runCollectorJob(
    job: JobRow,
  ): Promise<{ exit_code: number; output: string; truncated: boolean }> {
    const id = job.collector_id ?? '';
    const runner = this.opts.runCollector ?? runCollectorById;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${job.timeout_s} s`)),
        job.timeout_s * 1000,
      );
      timer.unref();
    });
    try {
      const report = await Promise.race([runner(this.db, this.config, id), timeout]);
      return { exit_code: 0, output: JSON.stringify(report ?? null, null, 2), truncated: false };
    } catch (err) {
      const timedOut = /^timed out after/.test((err as Error).message);
      return {
        exit_code: timedOut ? TIMEOUT_EXIT : 1,
        output: `collector ${id}: ${(err as Error).message}`,
        truncated: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private runShell(
    job: JobRow,
    entry: Active,
  ): Promise<{ exit_code: number; output: string; truncated: boolean }> {
    const limit = this.config.retention.job_output_kb * 1024;
    const grace = this.opts.killGraceMs ?? 5000;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (b: Buffer) => {
        if (size > limit) {
          truncated = true;
          return; // keep reading so the child never blocks on a full pipe
        }
        chunks.push(b);
        size += b.length;
      };
      let child: ChildProcess;
      try {
        child = spawn('/bin/sh', ['-c', job.command ?? ''], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true, // own process group, so a timeout stops the whole pipeline
        });
      } catch (err) {
        resolve({ exit_code: SPAWN_FAILED_EXIT, output: (err as Error).message, truncated: false });
        return;
      }
      entry.child = child;
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          /* already gone */
        }
      };
      let hardKill: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        hardKill = setTimeout(() => killGroup('SIGKILL'), grace);
        hardKill.unref();
      }, job.timeout_s * 1000);
      timer.unref();
      let settled = false;
      const settle = (exit_code: number, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        let output = Buffer.concat(chunks).toString('utf8');
        if (truncated) output = capOutput(output, this.config.retention.job_output_kb).output;
        resolve({ exit_code, output: output + extra, truncated });
      };
      child.on('error', (err) => settle(SPAWN_FAILED_EXIT, `\n[could not start: ${err.message}]`));
      child.on('close', (code, signal) => {
        if (timedOut) return settle(TIMEOUT_EXIT, `\n[timed out after ${job.timeout_s} s]`);
        if (code !== null) return settle(code);
        const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
        settle(n ? 128 + n : 1, `\n[stopped by ${signal ?? 'a signal'}]`);
      });
    });
  }

  /** Stops every timer and running shell job. Waits for running jobs to record their end. */
  async stop(): Promise<void> {
    for (const stop of this.crons.values()) stop();
    this.crons.clear();
    this.started = false;
    const waits: Promise<unknown>[] = [];
    for (const a of this.active.values()) {
      if (a.child?.pid) {
        try {
          process.kill(-a.child.pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
      waits.push(a.done.catch(() => null));
    }
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 3000).unref())]);
  }
}

/** Marks runs that never ended (the service stopped mid-run) as interrupted. */
export function recoverInterrupted(db: Db, now = new Date()): number {
  return Number(
    db
      .prepare(
        `UPDATE job_runs SET ended_at = ?, exit_code = NULL,
           output = CASE WHEN output IS NULL OR output = '' THEN ? ELSE output || char(10) || ? END
         WHERE ended_at IS NULL`,
      )
      .run(now.toISOString(), INTERRUPTED_NOTE, INTERRUPTED_NOTE).changes,
  );
}

export function keepNewestRuns(db: Db, jobId: number, keep: number): number {
  return Number(
    db
      .prepare(
        `DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (
           SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?)`,
      )
      .run(jobId, jobId, keep).changes,
  );
}

// One scheduler per database, so routes and the server share the running set.
const schedulers = new WeakMap<Db, Scheduler>();

export function schedulerFor(db: Db, config: Config, opts?: SchedulerOptions): Scheduler {
  let s = schedulers.get(db);
  if (!s) {
    s = new Scheduler(db, config, opts);
    schedulers.set(db, s);
  }
  return s;
}

export function forgetScheduler(db: Db): void {
  schedulers.delete(db);
}
