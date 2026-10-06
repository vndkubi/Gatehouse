import { createHash } from 'node:crypto';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { EventStore } from '@gatehouse/core';
import type { ApproverStore } from './approvers.ts';

export type GateDecisionValue = 'approve' | 'reject';

export interface GateDecision {
  gate: string;
  artifact: string;
  decision: GateDecisionValue;
  reason: string;
  nonce: string;
  credentialId: string;
  assertion: AuthenticationResponseJSON;
}

export interface WebAuthnOrigin {
  rpID: string;
  origin: string;
}

/**
 * The WebAuthn challenge commits to exactly what is being decided: gate, run, the hash of the
 * reviewed package and the decision. A signature over it cannot be replayed for another run,
 * another artifact version or the opposite decision.
 */
export function gateChallenge(gate: string, runId: string, artifact: string, decision: GateDecisionValue, nonce: string): Uint8Array<ArrayBuffer> {
  return digest(`gatehouse-gate|${gate}|${runId}|${artifact}|${decision}|${nonce}`);
}

export function digest(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(text).digest());
}

export const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** The gate a run is currently waiting on, if any (latest AWAITING_GATE without a decision after it). */
export function pendingGate(events: EventStore, runId: string): { gate: string; artifact: string } | null {
  const list = events.list(runId);
  const awaiting = list.filter((e) => e.type === 'AWAITING_GATE').at(-1);
  if (!awaiting) return null;
  const decided = list.some((e) => e.type === 'GATE_DECISION' && e.seq > awaiting.seq);
  return decided ? null : (awaiting.payload as { gate: string; artifact: string });
}

/**
 * Re-verifies a recorded decision from scratch: the assertion must be signed by a registered
 * approver's key over the challenge derived from this run, this artifact and this decision.
 * Anything written into the event log by other means fails here.
 */
export async function verifyDecision(
  events: EventStore,
  approvers: ApproverStore,
  runId: string,
  web: WebAuthnOrigin,
): Promise<{ ok: true; decision: GateDecision } | { ok: false; reason: string }> {
  const list = events.list(runId);
  const awaiting = list.filter((e) => e.type === 'AWAITING_GATE').at(-1);
  if (!awaiting) return { ok: false, reason: 'run is not waiting on a gate' };
  const decisionEvent = list.filter((e) => e.type === 'GATE_DECISION' && e.seq > awaiting.seq).at(-1);
  if (!decisionEvent) return { ok: false, reason: 'no decision recorded' };
  if (!events.verify(runId).ok) return { ok: false, reason: 'event chain is broken' };
  const d = decisionEvent.payload as GateDecision;
  const expected = awaiting.payload as { gate: string; artifact: string };
  if (d.gate !== expected.gate || d.artifact !== expected.artifact) return { ok: false, reason: 'decision is for a different gate or artifact version' };
  const approver = approvers.get(d.credentialId);
  if (!approver) return { ok: false, reason: 'decision is not signed by a registered approver' };
  try {
    const result = await verifyAuthenticationResponse({
      response: d.assertion,
      expectedChallenge: base64url(gateChallenge(d.gate, runId, d.artifact, d.decision, d.nonce)),
      expectedOrigin: web.origin,
      expectedRPID: web.rpID,
      // Counter freshness is enforced at decision time; this is an after-the-fact signature check.
      credential: { id: approver.credentialId, publicKey: Buffer.from(approver.publicKey, 'base64url'), counter: 0 },
      requireUserVerification: true,
    });
    return result.verified ? { ok: true, decision: d } : { ok: false, reason: 'signature did not verify' };
  } catch (err) {
    return { ok: false, reason: `signature did not verify: ${(err as Error).message}` };
  }
}

/** Origin the console serves passkey ceremonies from; signatures are only valid for it. */
export function consoleWebOrigin(port: number): WebAuthnOrigin {
  return { rpID: 'localhost', origin: `http://localhost:${port}` };
}

export class AwaitingGate extends Error {
  constructor(readonly gate: string, readonly artifact: string) {
    super(`waiting for ${gate} approval in the console`);
  }
}

export class GateRejected extends Error {
  constructor(readonly gate: string, readonly reason: string) {
    super(`${gate} was rejected${reason ? `: ${reason}` : ''}`);
  }
}

/**
 * Mid-pipeline gate. First call records AWAITING_GATE and stops the run (AwaitingGate). After a
 * human decides in the console, the run is resumed and this call re-verifies the signed
 * decision for exactly this artifact: approve continues, reject stops with GateRejected.
 */
export async function awaitGate(
  events: EventStore,
  approvers: ApproverStore,
  web: WebAuthnOrigin,
  runId: string,
  gate: string,
  artifact: string,
): Promise<void> {
  const list = events.list(runId);
  const awaiting = list.filter((e) => e.type === 'AWAITING_GATE' && (e.payload as { gate: string }).gate === gate).at(-1);
  if (!awaiting || (awaiting.payload as { artifact: string }).artifact !== artifact) {
    events.append(runId, 'AWAITING_GATE', { gate, artifact });
    throw new AwaitingGate(gate, artifact);
  }
  const decided = list.some((e) => e.type === 'GATE_DECISION' && e.seq > awaiting.seq);
  if (!decided) throw new AwaitingGate(gate, artifact);
  const check = await verifyDecision(events, approvers, runId, web);
  if (!check.ok) throw new Error(`${gate} decision rejected by verification: ${check.reason}`);
  if (check.decision.decision !== 'approve') throw new GateRejected(gate, check.decision.reason);
}

/** True when the latest decision on `gate` for this run is a verified approval of `artifact`. */
export async function isApproved(events: EventStore, approvers: ApproverStore, web: WebAuthnOrigin, runId: string, gate: string, artifact: string): Promise<boolean> {
  const list = events.list(runId);
  const awaiting = list.filter((e) => e.type === 'AWAITING_GATE' && (e.payload as { gate: string }).gate === gate).at(-1);
  if (!awaiting || (awaiting.payload as { artifact: string }).artifact !== artifact) return false;
  if (!list.some((e) => e.type === 'GATE_DECISION' && e.seq > awaiting.seq)) return false;
  const check = await verifyDecision(events, approvers, runId, web);
  return check.ok && check.decision.decision === 'approve';
}
