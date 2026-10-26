import { workflowRunSchema, type Snapshot, type WorkflowRun } from './model.js';

export function workflowRunFromEnv(env: NodeJS.ProcessEnv): WorkflowRun | undefined {
  if (env.GITHUB_ACTIONS !== 'true') return undefined;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Missing or invalid GITHUB_RUN_ATTEMPT');
  return { ...workflowRunSchema.parse({ repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID }), attempt };
}

export function reuseSnapshot(previous: Snapshot | undefined, sameRange: boolean, run?: WorkflowRun): boolean {
  // Local invocations retain their existing output-directory / explicit-ref semantics.
  if (!run) return !!previous && sameRange;
  const sameRun = previous?.workflowRun?.repository === run.repository && previous.workflowRun.runId === run.runId;
  if (sameRun) {
    if (!sameRange) throw new Error('Source range inputs changed within the same workflow run; start a new Run workflow');
    return true;
  }
  if (run.attempt > 1) {
    throw new Error('No snapshot for this workflow run, or another run has replaced it. Start a new Run workflow; an old rerun cannot overwrite a newer release range');
  }
  // A new dispatch resolves the range again, including snapshots from older tool versions.
  return false;
}
