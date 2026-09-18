/**
 * job-analytics — the per-project record of how long each job took.
 *
 * `{projectDir}/job-analytics.json` is the app's durable per-render report: the
 * last ten runs of each job type, keyed by job type, read back by the studio's
 * performance history. It is separate from the LL pipeline's `analytics.json`,
 * which has a different (stage-based) schema.
 *
 * Lifted out of main.ts's `audiobook:append-analytics` handler on 2026-09-18 so
 * the read-modify-write below has somewhere to take a lock and somewhere a
 * keeper can drive it from; the handler is now the IPC door and nothing else.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile } from './manifest-service';
import { withManifestFileLock } from './library-lock';

/** How many runs of one job type a project keeps. */
export const MAX_ANALYTICS_HISTORY = 10;

export type AnalyticsJobType =
  'tts-conversion' | 'reassembly' | 'video-assembly' | 'rvc' | 'translation';

/** The array in `job-analytics.json` each job type's runs are appended to. */
const TYPE_TO_KEY: Record<AnalyticsJobType, string> = {
  'tts-conversion': 'ttsJobs',
  'reassembly': 'reassemblyJobs',
  'video-assembly': 'videoAssemblyJobs',
  'rvc': 'rvcJobs',
  'translation': 'translationJobs',
};

const EMPTY_ANALYTICS = (): Record<string, unknown[]> => ({
  ttsJobs: [], reassemblyJobs: [], videoAssemblyJobs: [], rvcJobs: [], translationJobs: [],
});

/**
 * Append one job's analytics to `{projectDir}/job-analytics.json`, replacing
 * any earlier entry with the same `jobId` and keeping the last
 * `MAX_ANALYTICS_HISTORY` runs of that type.
 *
 * UNDER THE PROJECT'S LOCK, because this is a read-modify-write on a file two
 * machines share. `atomicWriteFile` prevents a TORN file, not a LOST UPDATE:
 * the PC and the Mac both mount the library over Samba (ruling 2026-08-17),
 * and two runs of one book finishing inside the same read-modify-write window
 * leave one of them simply gone. That is the manifest bug `library-lock` was
 * written for, in the file beside the manifest — so it takes the SAME lock
 * (`.manifest.lock` in the project directory), not a second one with its own
 * staleness rules to keep in step.
 */
export async function appendJobAnalytics(
  projectDir: string,
  jobType: AnalyticsJobType,
  analytics: { jobId: string; [key: string]: unknown },
): Promise<void> {
  const key = TYPE_TO_KEY[jobType];
  if (!key) throw new Error(`appendJobAnalytics: "${jobType}" is not a job type this file records`);

  const analyticsPath = path.join(projectDir, 'job-analytics.json');
  await withManifestFileLock(projectDir, async () => {
    let existing: Record<string, unknown[]> = EMPTY_ANALYTICS();
    try {
      existing = JSON.parse(await fs.readFile(analyticsPath, 'utf-8'));
    } catch { /* first write */ }

    const priorRuns = (existing[key] || []) as { jobId: string }[];
    existing[key] = [...priorRuns.filter((j) => j.jobId !== analytics.jobId), analytics]
      .slice(-MAX_ANALYTICS_HISTORY);

    await atomicWriteFile(analyticsPath, JSON.stringify(existing, null, 2));
  });
}
