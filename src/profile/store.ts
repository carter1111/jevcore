/**
 * Profile v1 store — load / atomic write / revision ledger hook.
 *
 * Write sequence (Improvement Doc §3.4 / Partner §6):
 *   validate → temp → chmod 0600 → fsync → rename → backup → PreferencesMemory.recordProfileRevision
 *
 * Learned suggestions never call this store automatically.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  PreferencesMemory,
  type PreferencesMemoryOptions,
  type ProfileRevisionSource,
} from "../memory/index.js";
import { applyPreset, createDefaultProfile } from "./defaults.js";
import {
  resolveProfileBackupPath,
  resolveProfilePath,
} from "./paths.js";
import {
  DELEGATION_MODES,
  HARD_DELEGATION_KEYS,
  type DelegationKey,
  type DelegationMode,
  type ProfilePreset,
  type ProfileV1,
} from "./types.js";
import {
  normalizeDelegationToken,
  parseAndValidateProfileJson,
  ProfileValidationError,
  SETTABLE_FIELDS,
  validateProfile,
} from "./validate.js";

export interface ProfileStoreOptions {
  profilePath?: string;
  /** Preferences DB options (tests inject databasePath). */
  memory?: PreferencesMemoryOptions;
  /** Injected memory instance (tests); otherwise constructed from memory opts. */
  preferencesMemory?: PreferencesMemory;
  now?: () => Date;
  /** Skip memory revision on write (tests of file layer only). Default false. */
  skipRevisionLedger?: boolean;
}

export interface WriteProfileResult {
  profile: ProfileV1;
  path: string;
  backupPath: string;
  revisionRecorded: boolean;
}

export class ProfileStore {
  readonly profilePath: string;
  private readonly now: () => Date;
  private readonly skipRevisionLedger: boolean;
  private memory: PreferencesMemory | undefined;
  private readonly memoryOptions: PreferencesMemoryOptions;
  private readonly injectedMemory: PreferencesMemory | undefined;

  constructor(options: ProfileStoreOptions = {}) {
    this.profilePath = options.profilePath ?? resolveProfilePath();
    this.now = options.now ?? (() => new Date());
    this.skipRevisionLedger = options.skipRevisionLedger === true;
    this.memoryOptions = options.memory ?? {};
    this.injectedMemory = options.preferencesMemory;
  }

  get backupPath(): string {
    return resolveProfileBackupPath(this.profilePath);
  }

  private getMemory(): PreferencesMemory {
    if (this.injectedMemory) return this.injectedMemory;
    if (!this.memory) {
      this.memory = new PreferencesMemory(this.memoryOptions);
    }
    return this.memory;
  }

  /** Close underlying preferences DB if we opened one. */
  close(): void {
    if (this.memory && !this.injectedMemory) {
      this.memory.close();
      this.memory = undefined;
    }
  }

  exists(): boolean {
    return existsSync(this.profilePath);
  }

  /**
   * Load and validate profile.json.
   * Throws if missing or invalid.
   */
  load(): ProfileV1 {
    if (!existsSync(this.profilePath)) {
      throw new ProfileValidationError(`profile not found: ${this.profilePath}`);
    }
    const text = readFileSync(this.profilePath, "utf8");
    return parseAndValidateProfileJson(text);
  }

  /** Load or return undefined when absent. */
  tryLoad(): ProfileV1 | undefined {
    if (!existsSync(this.profilePath)) return undefined;
    return this.load();
  }

  /**
   * Create default profile if missing. No-op overwrite unless force.
   */
  init(options: { force?: boolean; preset?: ProfilePreset } = {}): WriteProfileResult {
    if (this.exists() && !options.force) {
      throw new ProfileValidationError(
        `profile already exists at ${this.profilePath} (use --force to overwrite)`,
      );
    }
    const priorRev = this.exists() ? this.load().profileRevision : 0;
    let profile = createDefaultProfile(this.now);
    if (options.preset) {
      profile = applyPreset(profile, options.preset, this.now);
    }
    profile = {
      ...profile,
      profileRevision: options.force && priorRev > 0 ? priorRev + 1 : 1,
    };
    return this.write(profile, {
      source: "user_cli",
      summary: options.preset ? `init with preset ${options.preset}` : "init default profile",
    });
  }

  /**
   * Atomically write a validated profile and append a revision ledger entry.
   */
  write(
    candidate: ProfileV1,
    meta: { source: ProfileRevisionSource; summary: string },
  ): WriteProfileResult {
    const validated = validateProfile(candidate);
    const next: ProfileV1 = {
      ...validated,
      updatedAt: this.now().toISOString(),
    };

    const dir = dirname(this.profilePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }

    const payload = `${JSON.stringify(next, null, 2)}\n`;
    const tmp = join(dir, `.profile.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, payload, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);

      // Backup previous authority file (if any) before replace.
      if (existsSync(this.profilePath)) {
        try {
          copyFileSync(this.profilePath, this.backupPath);
          chmodSync(this.backupPath, 0o600);
        } catch {
          /* best-effort backup */
        }
      }

      renameSync(tmp, this.profilePath);
      chmodSync(this.profilePath, 0o600);

      // Best-effort fsync of directory entry (rename durability).
      try {
        const dfd = openSync(dir, "r");
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch {
        /* some platforms disallow directory fsync */
      }
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }

    let revisionRecorded = false;
    if (!this.skipRevisionLedger) {
      const mem = this.getMemory();
      mem.open();
      mem.recordProfileRevision({
        revision: next.profileRevision,
        source: meta.source,
        summary: meta.summary,
        profileJson: JSON.stringify(next),
        createdAt: next.updatedAt,
      });
      revisionRecorded = true;
    }

    return {
      profile: next,
      path: this.profilePath,
      backupPath: this.backupPath,
      revisionRecorded,
    };
  }

  /** Bump revision and write (used by mutating CLI ops on an existing profile). */
  commit(
    mutator: (current: ProfileV1) => ProfileV1,
    meta: { source: ProfileRevisionSource; summary: string },
  ): WriteProfileResult {
    if (!this.exists()) {
      throw new ProfileValidationError(`profile not found: ${this.profilePath}`);
    }
    const current = this.load();
    const mutated = mutator(current);
    const next: ProfileV1 = {
      ...mutated,
      profileRevision: current.profileRevision + 1,
    };
    return this.write(next, meta);
  }

  applyPreset(preset: ProfilePreset): WriteProfileResult {
    return this.commit(
      (cur) => applyPreset(cur, preset, this.now),
      { source: "user_cli", summary: `preset ${preset}` },
    );
  }

  /**
   * Set a single field via CLI kebab keys.
   * Rejects hard-boundary relaxations.
   */
  setField(fieldKey: string, rawValue: string): WriteProfileResult {
    const spec = SETTABLE_FIELDS[fieldKey];
    if (!spec) {
      throw new ProfileValidationError(
        `Unknown field "${fieldKey}". See: jev-guard profile set --help`,
      );
    }

    return this.commit(
      (cur) => {
        const next = structuredClone(cur) as ProfileV1;
        if (spec.kind === "delegation") {
          const mode = normalizeDelegationToken(rawValue);
          if (!(DELEGATION_MODES as readonly string[]).includes(mode)) {
            throw new ProfileValidationError(
              `Invalid delegation mode "${rawValue}". Expected one of: ${DELEGATION_MODES.join(", ")}`,
            );
          }
          const key = spec.path as DelegationKey;
          if (
            (HARD_DELEGATION_KEYS as readonly string[]).includes(key) &&
            mode !== "never_delegate"
          ) {
            throw new ProfileValidationError(
              `Hard boundary ${key} must remain never_delegate`,
            );
          }
          next.delegation[key] = mode as DelegationMode;
        } else if (spec.kind === "interruption") {
          const token = rawValue.trim().toLowerCase().replace(/_/g, "-");
          if (token !== "cautious" && token !== "balanced" && token !== "assertive") {
            throw new ProfileValidationError(
              "interruptionPreference must be cautious|balanced|assertive",
            );
          }
          next.interruptionPreference = token;
        } else if (spec.kind === "collaboration") {
          if (spec.path === "executeFeedback") {
            const token = rawValue.trim().toLowerCase().replace(/-/g, "_");
            if (
              token !== "each_step" &&
              token !== "session_summary" &&
              token !== "silent"
            ) {
              throw new ProfileValidationError("executeFeedback invalid");
            }
            next.collaboration.executeFeedback = token;
          } else if (spec.path === "explanationStyle") {
            const token = rawValue.trim().toLowerCase();
            if (token !== "concise" && token !== "detailed") {
              throw new ProfileValidationError("explanationStyle invalid");
            }
            next.collaboration.explanationStyle = token;
          } else if (spec.path === "maxPlanSteps") {
            const n = Number(rawValue);
            if (!Number.isInteger(n) || n < 1 || n > 20) {
              throw new ProfileValidationError("maxPlanSteps must be 1..20");
            }
            next.collaboration.maxPlanSteps = n;
          } else if (spec.path === "locale") {
            next.collaboration.locale = rawValue.trim();
          }
        }
        return next;
      },
      { source: "user_cli", summary: `set ${fieldKey}=${rawValue}` },
    );
  }

  reset(preset: ProfilePreset = "balanced"): WriteProfileResult {
    let profile = createDefaultProfile(this.now);
    profile = applyPreset(profile, preset, this.now);
    const currentRev = this.exists() ? this.load().profileRevision : 0;
    profile = { ...profile, profileRevision: currentRev + 1 };
    return this.write(profile, {
      source: "user_cli",
      summary: `reset to ${preset}`,
    });
  }

  exportJson(): string {
    const profile = this.load();
    return `${JSON.stringify(profile, null, 2)}\n`;
  }

  importJson(text: string, source: ProfileRevisionSource = "imported"): WriteProfileResult {
    const imported = parseAndValidateProfileJson(text);
    const currentRev = this.exists() ? this.load().profileRevision : 0;
    const next: ProfileV1 = {
      ...imported,
      profileRevision: currentRev + 1,
      updatedAt: this.now().toISOString(),
    };
    return this.write(next, {
      source,
      summary: "import profile.json",
    });
  }

  /**
   * History from preferences.sqlite (revision ledger).
   * Does not reimplement SQLite — uses PreferencesMemory only.
   */
  history(limit = 20): Array<{
    revision: number;
    createdAt: string;
    source: string;
    summary: string;
  }> {
    const mem = this.getMemory();
    mem.open();
    const latest = mem.latestRevisionNumber();
    const rows: Array<{
      revision: number;
      createdAt: string;
      source: string;
      summary: string;
    }> = [];
    for (let r = latest; r >= 1 && rows.length < limit; r--) {
      const rec = mem.getProfileRevision(r);
      if (rec) {
        rows.push({
          revision: rec.revision,
          createdAt: rec.createdAt,
          source: rec.source,
          summary: rec.summary,
        });
      }
    }
    return rows;
  }
}

/** Serialize profile for export / tests. Prefer ProfileStore.write for authority. */
export function serializeProfile(profile: ProfileV1): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

/** Ensure a directory exists with 0700 when creating profile tree. */
export function ensureProfileDir(profilePath: string): void {
  const dir = dirname(profilePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
}
