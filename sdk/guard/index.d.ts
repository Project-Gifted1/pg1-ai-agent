export type Decision = 'allow' | 'ask' | 'block';
export interface Reason { rule: string; detail: string }
export interface Action { id: string; tool: string; args: Record<string, unknown>; agent?: string | null }
export interface DecisionResult { decision: Decision; reasons: Reason[]; money: { amount: number | null } | null }

export interface Policy {
  version?: number;
  default?: Decision;
  tools?: { block?: string[]; ask?: string[]; allow?: string[] };
  money?: { tools?: string[]; amount_fields?: string[]; max_per_call?: number | null; max_per_day?: number | null; always_ask?: boolean };
  network?: { allow_domains?: string[]; block_domains?: string[]; block_private_addresses?: boolean; https_only?: boolean };
  secrets?: { block_in_arguments?: boolean };
  rate?: { per_tool_per_minute?: number };
}

export interface LogEntry { at: string; step: 'proposed' | 'pg1_check' | 'decided' | 'approved' | 'declined' | 'ran' | 'failed'; action_id: string; tool: string; args: unknown; [k: string]: unknown }
export interface Log { write(step: string, action: Action, extra?: Record<string, unknown>): LogEntry; entries(): LogEntry[]; replay(actionId: string): LogEntry[] }

export interface GuardOptions {
  policy?: Policy;
  /** Called for every action that needs a person; resolve true to run it. Not set: nothing that needs approval runs. */
  approve?: ((action: Action & { reasons: Reason[]; money: DecisionResult['money'] }) => Promise<boolean> | boolean) | null;
  log?: Log;
  /** A pg1-sdk PG1Client: money and install actions also get PG1's preflight check. */
  pg1?: { preflight(kind: string, subject: string, options?: Record<string, unknown>): Promise<any> } | null;
  clock?: () => number;
}

export interface Guard {
  check(tool: string, args?: Record<string, unknown>, meta?: { id?: string; agent?: string }): Promise<{ action: Action; decision: DecisionResult; approved: boolean }>;
  wrap<A extends Record<string, unknown>, R>(tool: string, fn: (args: A, ...rest: any[]) => Promise<R> | R, meta?: { agent?: string }): (args?: A, ...rest: any[]) => Promise<R>;
  wrapAll<T extends Record<string, any>>(tools: T, meta?: { agent?: string }): T;
  log: Log;
  policy: Required<Policy>;
}

export class GuardBlocked extends Error { code: 'blocked' | 'not_approved'; decision: DecisionResult }
export function createGuard(options?: GuardOptions): Guard;
export function createLog(options?: { sink?: ((entry: LogEntry) => void) | null; max?: number; clock?: () => number }): Log;
export function jsonlSink(path: string): (entry: LogEntry) => void;
export function resolvePolicy(policy?: Policy): Required<Policy>;
export function loadDefaultPolicy(): Required<Policy>;
export function evaluate(policy: Required<Policy>, action: Pick<Action, 'tool' | 'args'>, state?: unknown, now?: number): DecisionResult;
export function findSecrets(value: unknown): string[];
export function findUrls(value: unknown): string[];
export function findAmount(args: unknown, fields: string[]): number | null;
export function redact<T>(value: T): T;
export function globMatch(pattern: string, name: string): boolean;
