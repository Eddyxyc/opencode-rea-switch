import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_COMPACT_ENV,
  deriveCompact,
  isActivePhase,
  modeOf,
  normalizePersisted,
  targetFor,
  withDisabled,
} from "../src/state.ts"
import type { Mcp } from "@opencode/plugin"

const local: Mcp.ServerConfig = {
  type: "local",
  command: ["node", "rea.mjs", "mcp"],
  environment: { EXISTING: "1" },
}

test("normalizePersisted keeps valid choices and falls back to full", () => {
  assert.deepEqual(normalizePersisted({ mode: "compact", lastVariant: "compact" }), {
    mode: "compact",
    lastVariant: "compact",
  })
  assert.deepEqual(normalizePersisted({ mode: "off", lastVariant: "compact" }), {
    mode: "off",
    lastVariant: "compact",
  })
  assert.deepEqual(normalizePersisted({ mode: "nope", lastVariant: "nope" }), {
    mode: "full",
    lastVariant: "full",
  })
  assert.deepEqual(normalizePersisted(undefined), { mode: "full", lastVariant: "full" })
})

test("active rows include broken and auth states", () => {
  assert.equal(isActivePhase("connected"), true)
  assert.equal(isActivePhase("pending"), true)
  assert.equal(isActivePhase("failed"), true)
  assert.equal(isActivePhase("needs_auth"), true)
  assert.equal(isActivePhase("disabled"), false)
  assert.equal(isActivePhase("missing"), false)
})

test("modeOf reports every combination", () => {
  assert.equal(modeOf("connected", "disabled"), "full")
  assert.equal(modeOf("disabled", "connected"), "compact")
  assert.equal(modeOf("connected", "connected"), "both")
  assert.equal(modeOf("disabled", "disabled"), "off")
  assert.equal(modeOf("failed", "disabled"), "full")
  assert.equal(modeOf("missing", "pending"), "compact")
})

test("master restores the last variant; compact toggles between builds", () => {
  assert.equal(targetFor("master", "off", "compact"), "compact")
  assert.equal(targetFor("master", "full", "compact"), "off")
  assert.equal(targetFor("master", "both", "full"), "off")
  assert.equal(targetFor("compact", "full", "full"), "compact")
  assert.equal(targetFor("compact", "compact", "compact"), "full")
  assert.equal(targetFor("compact", "both", "full"), "full")
})

test("deriveCompact adds the schema profile without dropping existing env", () => {
  const compact = deriveCompact(local)
  assert.ok(compact)
  assert.equal(compact.type, "local")
  assert.deepEqual(compact.environment, { EXISTING: "1", ...DEFAULT_COMPACT_ENV })
  assert.deepEqual(compact.command, local.command)
  assert.equal(compact.disabled, false)
})

test("deriveCompact refuses remote servers", () => {
  assert.equal(deriveCompact({ type: "remote", url: "https://example.test/mcp" }), undefined)
})

test("custom compact environment overrides the defaults", () => {
  const compact = deriveCompact(local, { REA_MCP_INPUT_SCHEMA_PROFILE: "tiny", EXTRA: "yes" })
  assert.ok(compact)
  assert.deepEqual(compact.environment, {
    EXISTING: "1",
    REA_MCP_INPUT_SCHEMA_PROFILE: "tiny",
    EXTRA: "yes",
  })
})

test("withDisabled only changes the disabled flag", () => {
  const disabled = withDisabled(local, true)
  assert.equal(disabled.disabled, true)
  assert.deepEqual(disabled.command, local.command)
  assert.deepEqual(disabled.environment, local.environment)
})
