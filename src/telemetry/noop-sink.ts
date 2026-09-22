/**
 * Structural no-op telemetry sink — the default when evidence is disabled.
 *
 * This is what makes "disabled" inert by construction rather than by condition:
 * there is no code path from this object to the filesystem, SQLite, timers, or
 * the home directory. No `if (enabled)` branch exists to get wrong.
 */
import type { DecisionEvent, TelemetrySink } from "./types.js";

export class NoopTelemetrySink implements TelemetrySink {
  readonly enabled = false;

  recordDecision(_event: DecisionEvent): void {
    // Intentionally empty: disabled mode persists nothing.
  }

  noteWriteError(): void {
    // Intentionally empty.
  }

  async flush(): Promise<void> {
    // Intentionally empty.
  }

  async close(): Promise<void> {
    // Intentionally empty.
  }

  writeErrorCount(): number {
    return 0;
  }
}

/** Shared instance — stateless and safe to reuse. */
export const NOOP_TELEMETRY_SINK: TelemetrySink = new NoopTelemetrySink();
