import { StepRunner } from '@gatehouse/engine';
import { loadWorkflow } from '@gatehouse/workflows';
import type { Runtime } from './runtime.ts';

function workflowOf(rt: Runtime, runId: string): string {
  const started = rt.events.list(runId).find((e) => e.type === 'RUN_STARTED')?.payload as { workflow?: string } | undefined;
  if (!started?.workflow) throw new Error(`no run ${runId}`);
  return started.workflow;
}

/** Steps from `stage` to the end of the workflow, in declared order. */
function fromStage(workflow: string, stage: string): string[] {
  const ids = loadWorkflow(workflow).steps.map((s) => s.id);
  const i = ids.indexOf(stage);
  if (i < 0) throw new Error(`workflow ${workflow} has no stage ${stage} (stages: ${ids.join(', ')})`);
  return ids.slice(i);
}

/**
 * Answers a blocking open question (blueprint v1 USER_CLARIFICATION). The answer becomes a source in
 * the frozen packet, so intake and everything after it run again on the next resume.
 */
export function answerQuestion(rt: Runtime, runId: string, question: string, answer: string): void {
  const wf = workflowOf(rt, runId);
  if (wf !== 'ticket') throw new Error('questions can only be answered on ticket runs');
  if (!/^Q\d+$/.test(question)) throw new Error('question id must look like Q1');
  rt.events.append(runId, 'CLARIFICATION', { question, answer: answer.slice(0, 4_000) });
  new StepRunner(rt.events, runId).invalidate(fromStage(wf, 'intake'), `answer to ${question}`);
}

/** Re-runs a stage (and everything after it) with the approver's feedback, e.g. after a rejected gate. */
export function retryFrom(rt: Runtime, runId: string, stage: string, note?: string): string[] {
  const wf = workflowOf(rt, runId);
  const steps = fromStage(wf, stage);
  if (note) rt.events.append(runId, 'REVIEWER_NOTE', { stage, note: note.slice(0, 4_000) });
  new StepRunner(rt.events, runId).invalidate(steps, note ? `retry from ${stage}: ${note.slice(0, 200)}` : `retry from ${stage}`);
  return steps;
}
