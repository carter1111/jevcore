/**
 * WP6 — version manifest for offline evaluation readiness.
 *
 * Collects version IDs for packs, policies, routing, and risk composition so
 * exported eval artifacts can pin reproducibility without storing content.
 * No upload, no training, no online learned safety actions.
 */
import { QUESTION_PACK_VERSION } from "./question-packs.js";
import { DOMAIN_PACK_VERSION } from "./domain-packs.js";
import { FAN_OUT_POLICY_VERSION } from "./fan-out-policy.js";
import { RISK_COMPOSITION_VERSION } from "./risk-composition.js";
import { POLICY_VERSION, GUARD_VERSION } from "./telemetry/session.js";
import { SCHEMA_VERSION } from "./telemetry/schema.js";

/** Manifest schema version (bump when this object's shape changes). */
export const EVAL_MANIFEST_VERSION = "2026-09-21.1";

/** Content-free, reproducible version pin for offline / shadow eval exports. */
export interface EvalVersionManifest {
  evalManifestVersion: string;
  guardVersion: string;
  policyVersion: string;
  questionPackVersion: string;
  domainPackVersion: string;
  fanOutPolicyVersion: string;
  riskCompositionVersion: string;
  evidenceSchemaVersion: number;
  /** P4 routing is deterministic code; pin by date tag until ROUTING_VERSION exists. */
  routingVersion: string;
}

export const ROUTING_VERSION = "2026-09-21.1";

/** Build a fresh manifest snapshot (pure; no I/O). */
export function buildEvalManifest(): EvalVersionManifest {
  return {
    evalManifestVersion: EVAL_MANIFEST_VERSION,
    guardVersion: GUARD_VERSION,
    policyVersion: POLICY_VERSION,
    questionPackVersion: QUESTION_PACK_VERSION,
    domainPackVersion: DOMAIN_PACK_VERSION,
    fanOutPolicyVersion: FAN_OUT_POLICY_VERSION,
    riskCompositionVersion: RISK_COMPOSITION_VERSION,
    evidenceSchemaVersion: SCHEMA_VERSION,
    routingVersion: ROUTING_VERSION,
  };
}
