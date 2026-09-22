/**
 * Versioned, pure-data Question Pack for the TypeSafe provider.
 *
 * This module is intentionally **SDK-free and side-effect-free**: it holds only
 * structured question definitions plus their types. The provider
 * (`provider.ts`) is the only place that adapts these definitions into SDK
 * question builders, so the pack can be inspected and tested without the SDK,
 * a network, or a key.
 *
 * Structured criteria follow the TypeSafe "System One" guidance: a Choice
 * option describes `what` it covers, `notFor` (what belongs elsewhere), and
 * `examples`; a Score level describes `what`, `signals`, and `examples`; a
 * Noul describes both the `true` and `false` sides. Instructions are structured
 * (`question`, optional `focus`, and optional `inspect`/`compare` state paths).
 *
 * `QUESTION_PACK_VERSION` / `QUESTION_PACK_V1` are internal to this module, the
 * provider, and tests. They are deliberately NOT re-exported from `index.ts`, so
 * no public SDK surface, MCP output, telemetry event, or schema changes.
 */
import type { RiskFactor, TaskKind } from "./types.js";

/** Version identifier for the pack. Bump when question content changes. */
export const QUESTION_PACK_VERSION = "2026-09-21.1";

/** Structured instructions. `inspect`/`compare` are documented state-path refs. */
export interface QuestionInstructions {
  question: string;
  focus?: string;
  /** A backticked state path the question should inspect. */
  inspect?: string;
  /** Backticked state paths the question should compare. */
  compare?: readonly string[];
}

/** One Choice option's structured description. */
export interface ChoiceOption {
  what: string;
  notFor?: string;
  examples?: readonly string[];
}

/** One Score level's structured description. */
export interface ScoreLevel {
  what: string;
  signals?: readonly string[];
  examples?: readonly string[];
}

/** One Noul side's structured description. */
export interface NoulSide {
  what: string;
  notFor?: string;
  examples?: readonly string[];
}

/** A Choice question: instructions plus per-option structured criteria. */
export interface ChoiceSpec {
  instructions: QuestionInstructions;
  criteria: Record<TaskKind, ChoiceOption>;
}

/** A Score question: instructions plus ordered, structured levels. */
export interface ScoreSpec {
  instructions: QuestionInstructions;
  levels: readonly ScoreLevel[];
}

/** A Noul question: instructions plus both sides' structured criteria. */
export interface NoulSpec {
  instructions: QuestionInstructions;
  criteria: { true: NoulSide; false: NoulSide };
}

/** The complete, versioned question pack. */
export interface QuestionPack {
  version: string;
  kind: ChoiceSpec;
  risk: ScoreSpec;
  factors: Record<RiskFactor, NoulSpec>;
  securityReview: NoulSpec;
}

/**
 * The v1 pack. Risk levels are the single source of truth for the public
 * `RISK_CRITERIA` rubric (see `provider.ts`), preserving the existing level
 * cardinality (4) and ordering (Low → Critical).
 */
export const QUESTION_PACK_V1: QuestionPack = {
  version: QUESTION_PACK_VERSION,

  kind: {
    instructions: {
      question: "What kind of software-development task is `task`?",
      focus: "Classify the primary engineering discipline, not the technology used.",
      inspect: "`task`",
    },
    criteria: {
      frontend: {
        what: "User-facing UI, web/mobile app presentation, client-side behavior",
        notFor: "Server-side rendering logic, build tooling, or API design",
        examples: ["Add a login form", "Fix a CSS layout bug"],
      },
      backend: {
        what: "Server logic, APIs, services, data access, business rules",
        notFor: "Purely visual changes or on-chain interactions",
        examples: ["Add a REST endpoint", "Fix a query in the service layer"],
      },
      web3: {
        what: "Blockchain, smart contracts, wallets, on-chain interactions",
        notFor: "Generic backend code that merely stores crypto prices",
        examples: ["Add an ERC-20 approve call", "Write a Solidity vesting contract"],
      },
      devops: {
        what: "Build, deploy, CI, infrastructure, config, tooling",
        notFor: "Application business logic",
        examples: ["Add a CI workflow", "Change a Terraform module"],
      },
      testing: {
        what: "Adds or changes tests, test infrastructure, or QA tooling",
        notFor: "Production feature code that happens to be verified by tests",
        examples: ["Add unit tests for a helper", "Set up a test fixture"],
      },
      research: {
        what: "Investigation, analysis, evaluation, or exploration without code changes",
        notFor: "Work that edits source or configuration",
        examples: ["Compare two libraries", "Read code and summarize behavior"],
      },
      general: {
        what: "None of the categories fit cleanly",
        notFor: "Anything that clearly belongs to a category above",
        examples: ["Rename a top-level directory"],
      },
    },
  },

  risk: {
    instructions: {
      question: "How risky is executing `task` autonomously?",
      focus: "Judge blast radius and reversibility, not effort or file count alone.",
      inspect: "`task`",
    },
    // Ordering is Low → Critical and MUST NOT change: normalization divides by
    // (levels - 1), so cardinality and order are load-bearing.
    levels: [
      {
        what: "Low: safe, isolated, easily reversible change",
        signals: ["Single file or additive change", "No data or production impact"],
        examples: ["Add a docstring", "Add a self-contained unit test"],
      },
      {
        what: "Medium: touches a few files / moderate blast radius",
        signals: ["Several files or modules", "Some coupling to existing behavior"],
        examples: ["Refactor a helper used in a few places"],
      },
      {
        what: "High: broad scope, destructive, or touching data",
        signals: ["Many files/modules", "Deletes or rewrites behavior", "Touches user data or schema"],
        examples: ["Migrate a database column", "Rewrite a service's data access"],
      },
      {
        what: "Critical: production, data loss, security, or irreversible",
        signals: ["Production impact", "Potential data loss", "Security-sensitive", "Hard to roll back"],
        examples: ["Deploy to production", "Rotate credentials", "Force-push a protected branch"],
      },
    ],
  },

  factors: {
    scope: {
      instructions: {
        question: "Does this change touch a broad scope (many files/modules)?",
        focus: "Judge breadth of the change surface, not the size of a single file.",
      },
      criteria: {
        true: {
          what: "Spans many files or several modules",
          notFor: "A single isolated file",
          examples: ["Change a shared interface used across the codebase"],
        },
        false: {
          what: "Limited to a narrow, local surface",
          notFor: "Changes that ripple across modules",
          examples: ["Edit one self-contained component"],
        },
      },
    },
    destructive: {
      instructions: {
        question: "Does this change delete, rewrite, or move existing behavior?",
        focus: "Look for removal or replacement, not addition.",
      },
      criteria: {
        true: {
          what: "Removes, replaces, or relocates existing behavior",
          notFor: "Purely additive changes",
          examples: ["Delete a deprecated function", "Move a module to a new path"],
        },
        false: {
          what: "Adds or adjusts behavior without removing it",
          notFor: "Deletions or rewrites",
          examples: ["Add a new optional parameter"],
        },
      },
    },
    data: {
      instructions: {
        question: "Does this change touch user data, identity, or database schema?",
        focus: "Look for persistence, schema, or identity concerns.",
      },
      criteria: {
        true: {
          what: "Touches stored data, schema, or identity",
          notFor: "In-memory-only or purely presentational changes",
          examples: ["Add a migration", "Change an auth claim"],
        },
        false: {
          what: "Does not affect stored data, schema, or identity",
          notFor: "Migrations or identity changes",
          examples: ["Adjust a CSS token"],
        },
      },
    },
    security: {
      instructions: {
        question: "Does this change touch authentication, secrets, crypto, or network-facing code?",
        focus: "Look for security-sensitive surfaces, not general backend code.",
      },
      criteria: {
        true: {
          what: "Touches auth, secrets, crypto, or network-facing code",
          notFor: "Ordinary business logic",
          examples: ["Change a token validator", "Handle a private key"],
        },
        false: {
          what: "Does not touch security-sensitive surfaces",
          notFor: "Auth, secrets, crypto, or network boundaries",
          examples: ["Rename a variable in a view"],
        },
      },
    },
    irreversible: {
      instructions: {
        question: "Would this change be hard or impossible to roll back?",
        focus: "Judge reversibility, not severity.",
      },
      criteria: {
        true: {
          what: "Hard or impossible to undo",
          notFor: "Easily reverted changes",
          examples: ["Run an irreversible migration", "Publish a release"],
        },
        false: {
          what: "Easily reverted by a normal revert",
          notFor: "Irreversible operations",
          examples: ["Edit a source file under version control"],
        },
      },
    },
    unclear: {
      instructions: {
        question: "Is the risk profile of this change unclear?",
        focus: "Judge whether the available evidence is sufficient to assess risk.",
      },
      criteria: {
        true: {
          what: "Evidence is insufficient or the impact is ambiguous",
          notFor: "Changes whose impact is well understood",
          examples: ["A vague request with no file hints"],
        },
        false: {
          what: "The change and its impact are well understood",
          notFor: "Ambiguous or under-specified changes",
          examples: ["A precise, scoped edit with clear files"],
        },
      },
    },
  },

  securityReview: {
    instructions: {
      question: "Should a dedicated security review be required before this change is executed?",
      focus: "Judge whether the change warrants explicit security scrutiny.",
      compare: ["`task`", "`touchedFiles`"],
    },
    criteria: {
      true: {
        what: "Warrants a dedicated security review before execution",
        notFor: "Routine, non-sensitive changes",
        examples: ["Change authentication or authorization behavior"],
      },
      false: {
        what: "Does not warrant a dedicated security review",
        notFor: "Security-sensitive changes",
        examples: ["Update a README"],
      },
    },
  },
};

/**
 * The public risk rubric, derived from the pack so the pack is the single source
 * of truth for level cardinality and ordering.
 */
export function riskCriteriaFromPack(pack: QuestionPack = QUESTION_PACK_V1): readonly string[] {
  return pack.risk.levels.map((level) => level.what);
}
