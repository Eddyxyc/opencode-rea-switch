#!/usr/bin/env node
/**
 * End-to-end probe for opencode-rea-switch.
 *
 * Starts an isolated `opencode serve` with a fixture MCP server, then drives
 * the plugin through its RPC contract:
 *
 *   full -> compact -> off -> full -> both (heal) -> compact (restart + persist)
 *
 * The fixture appends its environment to a log so the probe can prove that the
 * compact build really was launched with REA_MCP_INPUT_SCHEMA_PROFILE=compact.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(root, "test", "fixture", "mcp.mjs")
const work = path.join(os.tmpdir(), `opencode-rea-switch-probe-${process.pid}`)
const home = path.join(work, "home")
const project = path.join(work, "project")
const configDir = path.join(home, ".config", "opencode")
const configPath = path.join(configDir, "opencode.json")
const mcpLog = path.join(work, "mcp.log")
const serverLog = path.join(work, "server.log")

const opencodeInfo = resolveOpencode()
if (!opencodeInfo) {
  console.log(`SKIP: ${process.env.OPENCODE_BIN ?? "opencode"} is not available`)
  process.exit(0)
}
const opencode = opencodeInfo.bin

rmSync(work, { recursive: true, force: true })
mkdirSync(configDir, { recursive: true })
mkdirSync(project, { recursive: true })
mkdirSync(path.join(configDir, "plugins"), { recursive: true })
fsSymlink(root, path.join(configDir, "plugins", "opencode-rea-switch"))
writeFileSync(
  configPath,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          rea: {
            type: "local",
            command: [process.execPath, fixture, "full"],
            environment: { REA_PROBE_LOG: mcpLog },
          },
        },
      },
    },
    null,
    2,
  ),
)

const servers = []

try {
  const first = await start()
  const initial = await rpc(first, "status", {})
  assert.equal(initial.supported, true, "REA config should be discovered")
  assert.equal(initial.mode, "full")
  assert.ok(["pending", "connected"].includes(initial.full.status))
  assert.equal(initial.compact.configured, true, "compact build should be derived")
  assert.equal(initial.compact.status, "disabled")

  const full = await waitForState(first, (state) => state.full.status === "connected")
  assert.equal(full.lastVariant, "full")

  const compact = await setMode(first, "compact")
  assert.equal(compact.mode, "compact")
  assert.equal(compact.full.status, "disabled")
  assert.equal(compact.compact.status, "connected")
  assert.ok(
    readFileSync(mcpLog, "utf8").includes('"profile":"compact"'),
    "compact build should start with REA_MCP_INPUT_SCHEMA_PROFILE=compact",
  )
  assert.ok(
    readFileSync(mcpLog, "utf8").includes('"output":"off"'),
    "compact build should start with REA_MCP_OUTPUT_SCHEMA_PROFILE=off",
  )

  const off = await setMode(first, "off")
  assert.equal(off.mode, "off")
  assert.equal(off.full.status, "disabled")
  assert.equal(off.compact.status, "disabled")
  assert.equal(off.lastVariant, "compact", "master switch should remember the last variant")

  const back = await setMode(first, "full")
  assert.equal(back.mode, "full")
  assert.equal(back.full.status, "connected")
  assert.equal(back.compact.status, "disabled")

  // Simulate a manual /mcps connect while the other build is running. The next
  // switch must heal the "both" state instead of leaving both processes alive.
  await api(first, "POST", "/api/experimental/mcp/rea-compact/connect")
  const both = await waitForState(first, (state) => state.compact.status === "connected")
  assert.equal(both.full.status, "connected")
  assert.equal(both.compact.status, "connected")
  const healed = await setMode(first, "full")
  assert.equal(healed.full.status, "connected")
  assert.equal(healed.compact.status, "disabled")

  const beforeRestart = await setMode(first, "compact")
  assert.equal(beforeRestart.mode, "compact")
  await stop(first)

  const second = await start()
  const restored = await rpc(second, "status", {})
  assert.equal(restored.mode, "compact", "mode should survive a server restart")
  assert.equal(restored.lastVariant, "compact")
  const restoredLive = await waitForState(second, (state) => state.compact.status === "connected")
  assert.equal(restoredLive.full.status, "disabled")
  assert.equal(restoredLive.compact.status, "connected")
  await stop(second)

  console.log("PASS: full -> compact -> off -> full -> both healing -> restart persistence")
} finally {
  for (const server of servers) await stop(server)
  rmSync(work, { recursive: true, force: true })
}

async function start() {
  const port = await freePort()
  const log = serverLog + "." + port
  const child = spawn(opencode, ["serve", "--port", String(port), "--print-logs", "--log-level", "info"], {
    cwd: project,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      XDG_DATA_HOME: path.join(work, "xdg", "data"),
      XDG_CACHE_HOME: path.join(work, "xdg", "cache"),
      XDG_CONFIG_HOME: path.join(work, "xdg", "config"),
      XDG_STATE_HOME: path.join(work, "xdg", "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: opencodeInfo.shell,
    windowsHide: true,
  })
  let output = ""
  const collect = (chunk) => {
    output += chunk.toString()
    writeFileSync(log, output)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) writeFileSync(log, output + `\nexit ${code}\n`)
  })
  const password = await waitFor(
    () => {
      const match = stripAnsi(output).match(/password\s+(\S+)/)
      return match ? match[1] : undefined
    },
    20_000,
    () => `server did not print a password:\n${stripAnsi(output)}`,
  )
  const baseURL = `http://127.0.0.1:${port}`
  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  const server = { child, port, baseURL, auth, log }
  servers.push(server)
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${baseURL}/api/mcp`, { headers: { authorization: auth } })
        return response.status === 200
      } catch {
        return false
      }
    },
    20_000,
    () => `server did not become ready:\n${stripAnsi(output)}`,
  )
  return server
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.killed) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    server.child.kill("SIGTERM")
  }
  await waitFor(() => server.child.exitCode !== null || server.child.killed, 5_000, () => "server did not stop")
}

async function rpc(server, method, input) {
  const response = await fetch(`${server.baseURL}/api/rpc/rea-switch/${method}`, {
    method: "POST",
    headers: { authorization: server.auth, "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(25_000),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${method} failed: ${response.status} ${JSON.stringify(body)}`)
  return body.output
}

async function setMode(server, mode) {
  const result = await rpc(server, "setMode", { mode })
  if (!result.ok) throw new Error(`setMode(${mode}) failed: ${result.error}`)
  return result.state
}

async function api(server, method, endpoint, body) {
  const response = await fetch(server.baseURL + endpoint, {
    method,
    headers: {
      authorization: server.auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`${method} ${endpoint} failed: ${response.status}`)
  return response
}

async function waitForState(server, predicate) {
  let latest
  await waitFor(
    async () => {
      latest = await rpc(server, "status", {})
      return predicate(latest)
    },
    25_000,
    () => `state did not settle: ${JSON.stringify(latest)}`,
  )
  return latest
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(predicate, timeout, failure) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    last = await predicate()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(failure())
}

function resolveOpencode() {  const explicit = process.env.OPENCODE_BIN
  if (explicit) {
    if (!existsSync(explicit)) return undefined
    return { bin: explicit, shell: process.platform === "win32" && !explicit.toLowerCase().endsWith(".exe") }
  }
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" })
  if (result.status !== 0) return undefined
  const first = result.stdout.split(/\r?\n/).find(Boolean)
  if (!first) return undefined
  if (process.platform === "win32") {
    const exe = path.join(path.dirname(first), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    if (existsSync(exe)) return { bin: exe, shell: false }
    return { bin: first, shell: true }
  }
  return { bin: first, shell: false }
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

function fsSymlink(target, link) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
}
