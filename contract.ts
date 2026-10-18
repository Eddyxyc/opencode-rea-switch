/**
 * RPC contract shared by the server half and the TUI half.
 *
 * The server half owns the switch state and the MCP transform. The TUI half
 * only reads a status snapshot and asks for a mode change, so both sides can
 * stay in sync without either one writing opencode.json.
 */
import type { Rpc } from "@opencode/plugin"

export type ReaMode = "off" | "full" | "compact"
export type ReaVariant = "full" | "compact"
export type ServerPhase = "connected" | "pending" | "disabled" | "failed" | "needs_auth" | "missing"

export interface ServerStatus {
  readonly name: string
  readonly configured: boolean
  readonly status: ServerPhase
  readonly error?: string
  readonly reason?: string
}

export interface ReaStatus {
  readonly supported: boolean
  readonly reason?: string
  readonly mode: ReaMode
  readonly lastVariant: ReaVariant
  readonly full: ServerStatus
  readonly compact: ServerStatus
}

export interface SetModeResult {
  readonly ok: boolean
  readonly error?: string
  readonly state?: ReaStatus
}

const mode = { type: "string", enum: ["off", "full", "compact"] } as const
const variant = { type: "string", enum: ["full", "compact"] } as const
const phase = {
  type: "string",
  enum: ["connected", "pending", "disabled", "failed", "needs_auth", "missing"],
} as const

const empty = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const server = {
  type: "object",
  properties: {
    name: { type: "string" },
    configured: { type: "boolean" },
    status: phase,
    error: { type: "string" },
    reason: { type: "string" },
  },
  required: ["name", "configured", "status"],
  additionalProperties: false,
} as const

const status = {
  type: "object",
  properties: {
    supported: { type: "boolean" },
    reason: { type: "string" },
    mode,
    lastVariant: variant,
    full: server,
    compact: server,
  },
  required: ["supported", "mode", "lastVariant", "full", "compact"],
  additionalProperties: false,
} as const

export const contract = {
  id: "rea-switch",
  methods: {
    status: {
      input: empty,
      output: status,
    },
    setMode: {
      input: {
        type: "object",
        properties: { mode },
        required: ["mode"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          state: status,
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export function isReaMode(value: unknown): value is ReaMode {
  return value === "off" || value === "full" || value === "compact"
}
