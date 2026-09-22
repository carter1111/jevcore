/**
 * Memory v1 types — preferences.sqlite ledger (never authority).
 */

export type GrantScope = "once" | "session";

export type PreferenceUserAction =
  | "approve_once"
  | "approve_session"
  | "reject"
  | "skip_plan"
  | "accept_plan"
  | "self_handle"
  | "change_profile"
  | "use_safer_path"
  | "cancel";

export type SuggestionStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "snoozed"
  | "expired";

export type ConfidenceBucket = "low" | "medium" | "high";

export type ProfileRevisionSource =
  | "user_cli"
  | "user_ui"
  | "imported"
  | "accepted_suggestion";

export interface SessionGrantRecord {
  grantId: string;
  createdAt: string;
  sessionId: string;
  category: string;
  scope: GrantScope;
  expiresAt: string;
  policyRuleId?: string;
  reasonCode?: string;
  revokedAt?: string;
}

export interface PreferenceEventRecord {
  eventId: string;
  occurredAt: string;
  profileRevision: number;
  category: string;
  decisionMode: string;
  userAction: PreferenceUserAction;
  scope?: GrantScope | "profile";
  reasonCode?: string;
  policyRuleId?: string;
  sessionId?: string;
  expiresAt?: string;
}

export interface OverrideEventRecord {
  eventId: string;
  occurredAt: string;
  category: string;
  action: PreferenceUserAction;
  policyRuleId?: string;
  reasonCode?: string;
  sessionId?: string;
}

export interface LearnedSuggestionRecord {
  suggestionId: string;
  createdAt: string;
  category: string;
  currentProfileValue: string;
  proposedProfileValue: string;
  evidenceCount: number;
  confidenceBucket: ConfidenceBucket;
  status: SuggestionStatus;
  createdFromEventRange?: string;
  resolvedAt?: string;
}

export interface ProfileRevisionRecord {
  revision: number;
  createdAt: string;
  source: ProfileRevisionSource;
  /** Full profile JSON string — validated by Profile layer (T05), stored opaque here. */
  profileJson: string;
  summary: string;
}

/** Fields that must never appear in stored string values. */
export const MEMORY_FORBIDDEN_FIELD_NAMES = [
  "task",
  "command",
  "diff",
  "prompt",
  "sourceCode",
  "source_code",
  "repo",
  "branch",
  "path",
  "repository",
  "providerPayload",
  "rawException",
  "secret",
  "credential",
  "privateKey",
  "seedPhrase",
  "apiKey",
] as const;
