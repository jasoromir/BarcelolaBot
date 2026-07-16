import type { JobHistory } from '../persistence/jobHistory.js';
import type { AppLogger } from '../log/logger.js';
import type { JobName, JobOutcome } from '../types.js';

export interface RunOpts {
  jobName: JobName;
  dryRun: boolean;
  history: JobHistory;
  logger: AppLogger;
  fn: (ctx: { jobRunId: number }) => Promise<Omit<JobOutcome, 'jobName' | 'dryRun'>>;
}

const runningJobs = new Set<JobName>();

export async function runJob(opts: RunOpts): Promise<JobOutcome> {
  if (runningJobs.has(opts.jobName)) {
    opts.logger.warn({
      source: 'jobs',
      eventType: `${opts.jobName}_already_running`,
      message: `${opts.jobName} already running, skipping duplicate invocation`,
    });
    return {
      jobName: opts.jobName,
      dryRun: opts.dryRun,
      status: 'skipped',
      toursCount: 0,
      groupsSent: 0,
      groupsClosed: 0,
    };
  }
  runningJobs.add(opts.jobName);
  const id = opts.history.start(opts.jobName, { dryRun: opts.dryRun });
  opts.logger.info({
    source: 'jobs',
    eventType: `${opts.jobName}_start`,
    message: `${opts.jobName} job started (dryRun=${opts.dryRun})`,
    metadata: { jobRunId: id },
  });
  try {
    const partial = await opts.fn({ jobRunId: id });
    opts.history.finish(id, partial);
    opts.logger.info({
      source: 'jobs',
      eventType: `${opts.jobName}_end`,
      message: `${opts.jobName} job finished: ${partial.status}`,
      metadata: { jobRunId: id, ...partial },
    });
    return { jobName: opts.jobName, dryRun: opts.dryRun, ...partial };
  } catch (err) {
    const errMsg = (err as Error).message;
    opts.history.finish(id, {
      status: 'failed',
      toursCount: 0,
      groupsSent: 0,
      groupsClosed: 0,
      error: errMsg,
    });
    opts.logger.error({
      source: 'jobs',
      eventType: `${opts.jobName}_error`,
      message: errMsg,
      metadata: { jobRunId: id },
    });
    return {
      jobName: opts.jobName,
      dryRun: opts.dryRun,
      status: 'failed',
      toursCount: 0,
      groupsSent: 0,
      groupsClosed: 0,
      error: errMsg,
    };
  } finally {
    runningJobs.delete(opts.jobName);
  }
}
