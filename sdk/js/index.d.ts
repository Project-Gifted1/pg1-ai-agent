export interface SignatureBlock { alg: 'EdDSA'; kid: string; request_hash: string; sources: string[]; timestamp: string; version: string; sig: string }
export interface Verification { valid: boolean; reason: string; kid?: string }
export interface Jwks { keys: Array<{ kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg?: string; use?: string }> }
export interface CallResult<T = any> { result?: T; signature?: SignatureBlock | null; verified?: Verification | null; paid?: boolean; paymentRequired?: any }
export type Payer = (paymentRequired: any, ctx: { tool: string; args: any }) => Promise<any>;
export type PreflightAction = 'pay' | 'open' | 'install' | 'patch' | 'trust_agent';
export const DEFAULT_BASE_URL: string;
export function canonicalJson(value: unknown): string;
export function requestHash(tool: string, args: unknown): Promise<string>;
export function verifyResult(input: { result: any; signature: SignatureBlock; jwks: Jwks; tool?: string | null; args?: any }): Promise<Verification>;
export function verifyWebhook(secret: string, body: string, header: string, opts?: { toleranceSec?: number; nowSec?: number }): Promise<boolean>;
export class PG1Error extends Error { code: any; data: any }
export class PG1Client {
  constructor(opts?: { baseUrl?: string; apiKey?: string | null; payer?: Payer | null; fetch?: typeof fetch; verify?: boolean; jwksTtlMs?: number });
  jwks(opts?: { refresh?: boolean }): Promise<Jwks>;
  listTools(): Promise<any[]>;
  call<T = any>(name: string, args?: Record<string, unknown>, opts?: { payment?: any }): Promise<CallResult<T>>;
  preflight(action: PreflightAction, target: string, opts?: { chain?: string; ecosystem?: 'npm' | 'pypi' }): Promise<CallResult<{ decision: 'no_flags' | 'flagged' | 'unknown'; reasons: any[]; checks: any[]; latency_ms: number }>>;
  checkWalletSanctions(address: string): Promise<CallResult>;
  checkWalletAge(address: string, chain?: string): Promise<CallResult>;
  checkDomainAge(domain: string): Promise<CallResult>;
  checkHostnameReputation(hostname: string): Promise<CallResult>;
  checkPackage(ecosystem: 'npm' | 'pypi', name: string, version?: string): Promise<CallResult>;
  checkX402Endpoint(url: string): Promise<CallResult>;
  checkAgentCard(urlOrDomain: string): Promise<CallResult>;
  getCveDetails(cveId: string): Promise<CallResult>;
  getCveByProduct(product: string, opts?: { vendor?: string; version?: string }): Promise<CallResult>;
  getThreatActorProfile(name: string): Promise<CallResult>;
  getUsageStatus(): Promise<CallResult>;
}
