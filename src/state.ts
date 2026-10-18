import type { Mcp } from "@opencode/plugin"
import type { ReaMode, ReaVariant, ServerPhase } from "../contract.ts"

export interface PersistedState {
  readonly mode: ReaMode
  readonly lastVariant: ReaVariant
}

export const DEFAULT_STATE: PersistedState = { mode: "full", lastVariant: "full" }

export const DEFAULT_COMPACT_ENV: Readonly<Record<string, string>> = {
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
}

export function normalizePersisted(value: unknown): PersistedState {
  const record = isRecord(value) ? value : {}
  return {
    mode: record.mode === "off" || record.mode === "full" || record.mode === "compact" ? record.mode : DEFAULT_STATE.mode,
    lastVariant: record.lastVariant === "compact" ? "compact" : "full",
  }
}

/** A row counts as "on" when it is connected, starting, broken, or waiting for auth. */
export function isActivePhase(phase: ServerPhase): boolean {
  return phase === "connected" || phase === "pending" || phase === "failed" || phase === "needs_auth"
}

export function modeOf(full: ServerPhase, compact: ServerPhase): ReaMode | "both" {
  const fullOn = isActivePhase(full)
  const compactOn = isActivePhase(compact)
  if (fullOn && compactOn) return "both"
  if (fullOn) return "full"
  if (compactOn) return "compact"
  return "off"
}

/**
 * Master switch: off in any on state, otherwise restore the variant used last.
 * Compact switch: on moves to compact, off moves back to full.
 */
export function targetFor(
  row: "master" | "compact",
  actual: ReaMode | "both",
  lastVariant: ReaVariant,
): ReaMode {
  if (row === "master") return actual === "off" ? lastVariant : "off"
  return actual === "compact" || actual === "both" ? "full" : "compact"
}

export function withDisabled(config: Mcp.ServerConfig, disabled: boolean): Mcp.ServerConfig {
  return { ...config, disabled }
}

/** The compact build is the same command with the schema-profile environment. */
export function deriveCompact(
  full: Mcp.ServerConfig,
  environment: Readonly<Record<string, string>> = DEFAULT_COMPACT_ENV,
): Mcp.ServerConfig | undefined {
  if (full.type !== "local") return undefined
  return {
    ...full,
    environment: { ...(full.environment ?? {}), ...environment },
    disabled: false,
  }
}

export function isServerConfig(value: unknown): value is Mcp.ServerConfig {
  if (!isRecord(value)) return false
  if (value.type === "local") {
    return Array.isArray(value.command) && value.command.every((item) => typeof item === "string")
  }
  if (value.type === "remote") return typeof value.url === "string"
  return false
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
