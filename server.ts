/**
 * Host half of opencode-rea-switch.
 *
 * It owns the switch state and edits the MCP server list through a transform,
 * so the choice applies to every session and to `opencode run`, not only to a
 * running TUI. The TUI half talks to this plugin over RPC.
 */
import { Plugin } from "@opencode/plugin"
import type { Mcp } from "@opencode/plugin"
import type { Schema } from "effect"
import {
  contract,
  isReaMode,
  type ReaMode,
  type ReaStatus,
  type ReaVariant,
  type ServerStatus,
  type SetModeResult,
} from "./contract.ts"
import {
  DEFAULT_COMPACT_ENV,
  DEFAULT_STATE,
  deriveCompact,
  isActivePhase,
  isRecord,
  isServerConfig,
  modeOf,
  normalizePersisted,
  withDisabled,
  type PersistedState,
} from "./src/state.ts"

type ServerConfig = Mcp.ServerConfig

const FULL_MISSING =
  "没有找到 REA 的 MCP 配置：请在 opencode.jsonc 的 mcp.servers 里声明 rea，或用插件选项 full 提供命令。"
const COMPACT_MISSING =
  "无法派生压缩版 REA：完整版不是本地 MCP 服务器；请在 mcp.servers 里声明 rea-compact，或用插件选项 compact 提供配置。"
const INVALID_MODE = "无效的 REA 模式。"
const SETTLE_TIMEOUT = 15_000
const POLL_INTERVAL = 250

interface Options {
  readonly fullName: string
  readonly compactName: string
  readonly full?: ServerConfig
  readonly compact?: ServerConfig
  readonly compactEnv: Readonly<Record<string, string>>
}

interface Availability {
  full: boolean
  compact: boolean
  reason?: string
}

export default Plugin.define({
  id: "rea-switch",
  async setup(ctx) {
    const options = readOptions(ctx.options)
    const stored = normalizePersisted(await ctx.storage.get("state"))
    let mode: ReaMode = stored.mode
    let lastVariant: ReaVariant = stored.lastVariant
    const availability: Availability = { full: false, compact: false }
    const suppressed = new Set<string>()

    const transform = await ctx.mcp.transform((editor) => {
      const sourceFull = editor.get(options.fullName) ?? options.full
      const sourceCompact =
        editor.get(options.compactName) ??
        options.compact ??
        (sourceFull === undefined ? undefined : deriveCompact(sourceFull, options.compactEnv))

      availability.full = sourceFull !== undefined
      availability.compact = sourceCompact !== undefined
      availability.reason = !availability.full ? FULL_MISSING : !availability.compact ? COMPACT_MISSING : undefined

      if (sourceFull !== undefined) {
        if (suppressed.has(options.fullName)) editor.remove(options.fullName)
        else editor.set(options.fullName, withDisabled(sourceFull, mode !== "full"))
      }
      if (sourceCompact !== undefined) {
        if (suppressed.has(options.compactName)) editor.remove(options.compactName)
        else editor.set(options.compactName, withDisabled(sourceCompact, mode !== "compact"))
      }
    })

    const statusNow = async (): Promise<ReaStatus> => {
      const response = await ctx.mcp.list()
      const byName = new Map(response.data.map((server) => [server.name, server]))
      return {
        supported: availability.full,
        ...(availability.reason === undefined ? {} : { reason: availability.reason }),
        mode,
        lastVariant,
        full: row(options.fullName, availability.full, availability.full ? undefined : availability.reason, byName),
        compact: row(
          options.compactName,
          availability.compact,
          availability.compact ? undefined : availability.reason === FULL_MISSING ? undefined : availability.reason,
          byName,
        ),
      }
    }

    const forceStop = async (name: string) => {
      suppressed.add(name)
      try {
        await ctx.mcp.reload()
      } finally {
        suppressed.delete(name)
      }
      await ctx.mcp.reload()
    }

    const heal = async (target: ReaMode) => {
      const state = await statusNow()
      const names =
        target === "off"
          ? [options.fullName, options.compactName]
          : [target === "full" ? options.compactName : options.fullName]
      for (const name of names) {
        const row = name === options.fullName ? state.full : state.compact
        if (isActivePhase(row.status)) await forceStop(name)
      }
    }

    const settle = async (target: ReaMode): Promise<ReaStatus> => {
      const started = Date.now()
      let state = await statusNow()
      while (Date.now() - started < SETTLE_TIMEOUT) {
        if (settled(state, target)) return state
        await sleep(POLL_INTERVAL)
        state = await statusNow()
      }
      return state
    }

    let queue: Promise<unknown> = Promise.resolve()
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const run = queue.then(work, work)
      queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    const setMode = (input: unknown): Promise<SetModeResult> =>
      serial(async () => {
        const next = isRecord(input) ? input.mode : undefined
        if (!isReaMode(next)) return { ok: false, error: INVALID_MODE }
        if (next !== "off" && !availability.full) return { ok: false, error: availability.reason ?? FULL_MISSING }
        if (next === "compact" && !availability.compact) return { ok: false, error: COMPACT_MISSING }

        const before = await statusNow()
        const actual = modeOf(before.full.status, before.compact.status)
        if (actual === next) {
          // The live MCP state already matches. Keep the remembered choice in
          // sync without bouncing a healthy server.
          if (mode !== next || (next !== "off" && lastVariant !== next)) {
            mode = next
            if (next !== "off") lastVariant = next
            await save(ctx, { mode, lastVariant })
          }
          return { ok: true, state: await statusNow() }
        }

        const previous: PersistedState = { mode, lastVariant }
        mode = next
        if (next !== "off") lastVariant = next
        try {
          await save(ctx, { mode, lastVariant })
          await ctx.mcp.reload()
          await heal(next)
          return { ok: true, state: await settle(next) }
        } catch (error) {
          mode = previous.mode
          lastVariant = previous.lastVariant
          await save(ctx, { mode, lastVariant }).catch(() => undefined)
          await ctx.mcp.reload().catch(() => undefined)
          return { ok: false, error: messageOf(error) }
        }
      })

    const rpc = await ctx.rpc.register(contract, {
      status: async () => statusNow(),
      setMode,
    })

    return async () => {
      await rpc.dispose()
      await transform.dispose()
    }
  },
})

function row(
  name: string,
  configured: boolean,
  reason: string | undefined,
  byName: ReadonlyMap<string, { status: { status: string; error?: string } }>,
): ServerStatus {
  const live = byName.get(name)
  const phase = live?.status.status
  const status: ServerStatus["status"] = !configured
    ? "missing"
    : phase === "connected" || phase === "pending" || phase === "disabled" || phase === "failed" || phase === "needs_auth"
      ? phase
      : "pending"
  const error = live?.status.error
  return {
    name,
    configured,
    status,
    ...(error === undefined ? {} : { error }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function settled(state: ReaStatus, target: ReaMode): boolean {
  if (target === "off") return !isActivePhase(state.full.status) && !isActivePhase(state.compact.status)
  if (target === "full") {
    return (
      state.full.status !== "pending" &&
      state.full.status !== "disabled" &&
      !isActivePhase(state.compact.status)
    )
  }
  return (
    state.compact.status !== "pending" &&
    state.compact.status !== "disabled" &&
    !isActivePhase(state.full.status)
  )
}

function save(ctx: { storage: { set: (key: string, value: Schema.Json) => Promise<void> } }, value: PersistedState) {
  return ctx.storage.set("state", value as unknown as Schema.Json)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.message === "string") return error.message
  return String(error)
}

function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  const names = isRecord(raw.names) ? raw.names : {}
  const fullName = nonEmpty(names.full) ?? "rea"
  const compactName = nonEmpty(names.compact) ?? "rea-compact"
  const compactEnv = { ...DEFAULT_COMPACT_ENV }
  if (isRecord(raw.compactEnv)) {
    for (const [key, value] of Object.entries(raw.compactEnv)) {
      if (typeof value === "string") compactEnv[key] = value
    }
  }
  return {
    fullName,
    compactName,
    full: optionServer(raw.full),
    compact: optionServer(raw.compact),
    compactEnv,
  }
}

function optionServer(value: unknown): ServerConfig | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { type: "local", command: [...value] }
  }
  return isServerConfig(value) ? structuredClone(value) : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
