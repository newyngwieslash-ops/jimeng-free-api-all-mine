import _ from "lodash";

import accountPool, { AccountBusyError, type AccountProvider } from "@/lib/account-pool.ts";
import db, { touchApiKey } from "@/lib/database.ts";
import logger from "@/lib/logger.ts";

export interface ResolvedCredential {
  token: string;
  sessionId?: string;
  cookie?: string;
  accountId?: string;
  accountName?: string;
  provider?: AccountProvider;
  managedKey?: string;
}

const NON_FAILOVER_CODES = new Set([-2000, -2003, -2004, -2006]);

/** Resolve either a native upstream credential or a dashboard-managed API key. */
export function isManagedApiKey(value: string): boolean {
  return /^jm_[A-Za-z0-9_-]{20,}$/.test(value);
}

export function splitAuthCredentials(authorization: string): string[] {
  const raw = (authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return [];
  if (raw.includes("||")) {
    return raw.split("||").map((item) => item.trim()).filter(Boolean);
  }
  // Raw Cookie strings may contain commas inside Expires/sid_guard dates; keep intact.
  if (raw.includes(";") && raw.includes("=")) {
    return [raw];
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function shouldFailoverAccount(error: any): boolean {
  // 任务已提交上游（可能已扣积分），换号重提会重复扣费
  if (error?.noFailover) return false;
  const code = typeof error?.errcode === "number" ? error.errcode : undefined;
  if (code !== undefined && NON_FAILOVER_CODES.has(code)) return false;
  return true;
}

function failureCooldownMs(error: any): number {
  const code = typeof error?.errcode === "number" ? error.errcode : undefined;
  if (code === -2002) return 10 * 60_000; // 登录过期冷却 10 分钟
  if (code === -2009) return 30 * 60_000; // 积分/免费额度耗尽冷却 30 分钟
  return 30_000;
}

export async function resolveAuthorization(
  authorization: string,
  provider: AccountProvider = "jimeng",
  excludeIds?: string[]
): Promise<ResolvedCredential> {
  const tokens = splitAuthCredentials(authorization);
  if (tokens.length === 0) throw new Error("Authorization token is empty");

  const managedKey = tokens.find((token) => db.validateApiKey(token).valid);
  const looksLikeManagedKey = tokens.find(isManagedApiKey);
  if (managedKey) {
    const selected = accountPool.select("round_robin", { provider, excludeIds });
    touchApiKey(managedKey);
    return {
      token: provider === "doubao" ? selected.credential : selected.sessionId,
      sessionId: selected.sessionId,
      cookie: selected.credential,
      accountId: selected.account.id,
      accountName: selected.account.name,
      provider,
      managedKey,
    };
  }

  if (looksLikeManagedKey) {
    throw new Error("API key is invalid or disabled");
  }

  const picked = _.sample(tokens) as string;
  return { token: picked, provider };
}

export async function executeWithPoolFailover<T>(
  provider: AccountProvider,
  fn: (credential: ResolvedCredential) => Promise<T>,
  managedKey?: string
): Promise<{ result: T; credential: ResolvedCredential }> {
  const triedIds: string[] = [];
  let lastError: any;
  // 所有账号都在跑任务时排队等待，而不是直接失败
  const waitDeadline = Date.now() + (Number(process.env.ACCOUNT_WAIT_TIMEOUT_MS) || 5 * 60_000);

  while (true) {
    let selected;
    try {
      selected = accountPool.select("round_robin", { provider, excludeIds: triedIds, checkConcurrency: true });
    } catch (selectErr) {
      if (selectErr instanceof AccountBusyError && Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, ACCOUNT_WAIT_POLL_MS));
        continue;
      }
      if (triedIds.length > 0 && lastError) throw lastError;
      throw selectErr;
    }

    triedIds.push(selected.account.id);
    const credential: ResolvedCredential = {
      token: provider === "doubao" ? selected.credential : selected.sessionId,
      sessionId: selected.sessionId,
      cookie: selected.credential,
      accountId: selected.account.id,
      accountName: selected.account.name,
      provider,
      managedKey,
    };

    accountPool.acquire(selected.account.id);
    try {
      const result = await fn(credential);
      markCredentialSuccess(credential);
      refreshCreditsInBackground(credential);
      return { result, credential };
    } catch (error: any) {
      lastError = error;
      if (!shouldFailoverAccount(error)) throw error;
      markCredentialFailure(credential, failureCooldownMs(error));
      if (error?.errcode === -2009) refreshCreditsInBackground(credential);
      if (error?.isIpRiskControl) throw error;
      logger.warn(
        `[${provider}] 账号「${selected.account.name}」执行失败 (${error?.message || error})，尝试自动切换下一可用账号...`
      );
    } finally {
      accountPool.release(selected.account.id);
    }
  }
}

const ACCOUNT_WAIT_POLL_MS = 2000;

/** 用后刷新积分缓存，选号时据此跳过今天已无积分的账号 */
function refreshCreditsInBackground(credential: ResolvedCredential): void {
  if (!credential.accountId || process.env.ACCOUNT_REFRESH_AFTER_USE === "false") return;
  accountPool.refreshStatus(credential.accountId).catch((error) =>
    logger.warn(`刷新账号「${credential.accountName}」积分失败: ${error?.message || error}`)
  );
}

export async function executeWithCredentialFailover<T>(
  authorization: string,
  provider: AccountProvider,
  fn: (credential: ResolvedCredential) => Promise<T>
): Promise<{ result: T; credential: ResolvedCredential }> {
  const tokens = splitAuthCredentials(authorization);
  if (tokens.length === 0) throw new Error("Authorization token is empty");

  const managedKey = tokens.find((token) => db.validateApiKey(token).valid);
  const looksLikeManagedKey = tokens.find(isManagedApiKey);
  if (managedKey) {
    touchApiKey(managedKey);
    return executeWithPoolFailover(provider, fn, managedKey);
  }
  if (looksLikeManagedKey) {
    throw new Error("API key is invalid or disabled");
  }

  const shuffled = _.shuffle(tokens);
  let lastError: any;
  for (let i = 0; i < shuffled.length; i++) {
    const credential: ResolvedCredential = { token: shuffled[i], provider };
    try {
      const result = await fn(credential);
      return { result, credential };
    } catch (error: any) {
      lastError = error;
      if (!shouldFailoverAccount(error) || error?.isIpRiskControl || i === shuffled.length - 1) {
        throw error;
      }
      logger.warn(`[${provider}] 直传凭据 #${i + 1} 失败 (${error?.message || error})，切换下一凭据重试...`);
    }
  }
  throw lastError;
}

export function markCredentialSuccess(credential: ResolvedCredential): void {
  if (credential.accountId) accountPool.markSuccess(credential.accountId);
}

export function markCredentialFailure(credential: ResolvedCredential, cooldownMs?: number): void {
  if (credential.accountId) accountPool.markFailure(credential.accountId, cooldownMs);
}
