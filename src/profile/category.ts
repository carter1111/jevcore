/**
 * Map engine / policy signals → Profile delegation keys (T07).
 */
import type { DelegationKey } from "../profile/types.js";

/** Hard never-delegate categories (profile cannot soften). */
export const HARD_CATEGORY_KEYS: readonly DelegationKey[] = [
  "secretToRemoteProvider",
  "web3AssetAction",
] as const;

/**
 * Infer the primary soft/hard delegation category from reason codes.
 * Returns undefined when no category-specific rule applied (ordinary path).
 */
export function inferDelegationKey(reasonCodes: readonly string[]): DelegationKey | undefined {
  const codes = reasonCodes.map((c) => c.toUpperCase());

  if (codes.some((c) => c.startsWith("POL-SECRETS") || c.startsWith("POL-CI-SECRETS"))) {
    return "secretToRemoteProvider";
  }
  if (codes.some((c) => c.startsWith("POL-WEB3-ASSET") || c.startsWith("POL-PAY"))) {
    return "web3AssetAction";
  }
  if (codes.some((c) => c.startsWith("POL-AUTHZ"))) {
    return "authzChange";
  }
  if (
    codes.some(
      (c) =>
        c.startsWith("POL-DESTRUCTIVE") ||
        c.startsWith("POL-FORCE-PUSH") ||
        c.startsWith("POL-DB-DESTRUCTIVE") ||
        c.startsWith("POL-INFRA-DESTROY"),
    )
  ) {
    return "destructiveCommand";
  }
  if (codes.some((c) => c.includes("PROD") && c.startsWith("POL-"))) {
    return "productionDeploy";
  }
  if (codes.some((c) => c.includes("STAGING") && c.startsWith("POL-"))) {
    return "stagingDeploy";
  }
  if (
    codes.some(
      (c) =>
        c.startsWith("POL-DB-MIGRATION") ||
        c.startsWith("POL-DB-SCHEMA") ||
        c === "POL-DB-DEPLOY-UNKNOWN-1",
    )
  ) {
    return "localDevDatabase";
  }
  if (codes.some((c) => c === "LOW-CONF" || c.startsWith("LOW-CONF"))) {
    return "lowConfidenceLowRisk";
  }
  return undefined;
}

export function isHardDelegationKey(key: DelegationKey | undefined): boolean {
  return key !== undefined && (HARD_CATEGORY_KEYS as readonly string[]).includes(key);
}
