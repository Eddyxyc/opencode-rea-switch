#!/usr/bin/env node
/**
 * Tiny MCP stdio fixture used by the integration probe. It reports one tool
 * whose description names the REA schema profile read from the environment, and
 * appends a line to REA_PROBE_LOG on startup so the probe can prove the compact
 * variant was launched with the expected environment.
 */
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const profile = process.env.REA_MCP_INPUT_SCHEMA_PROFILE ?? "full"
const output = process.env.REA_MCP_OUTPUT_SCHEMA_PROFILE ?? "on"
const label = process.argv[2] ?? "fixture"

if (process.env.REA_PROBE_LOG) {
  appendFileSync(
    process.env.REA_PROBE_LOG,
    JSON.stringify({ pid: process.pid, label, profile, output, argv: process.argv.slice(2) }) + "\n",
  )
}

const tools = [
  {
    name: "rea_probe",
    description: `REA probe (${label}, input=${profile}, output=${output})`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
  },
]

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

const handlers = {
  initialize() {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: `rea-probe-${label}`, version: "1.0.0" },
    }
  },
  "notifications/initialized"() {
    return null
  },
  "tools/list"() {
    return { tools }
  },
  "tools/call"(params) {
    return {
      content: [{ type: "text", text: `${params.name}:${label}:${profile}` }],
    }
  },
  "resources/list"() {
    return { resources: [] }
  },
  "prompts/list"() {
    return { prompts: [] }
  },
}

const rl = createInterface({ input: process.stdin })
rl.on("line", async (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
    return
  }
  const handler = handlers[request.method]
  if (handler === undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `not found: ${request.method}` } })
    return
  }
  if (request.id === undefined) {
    handler(request.params)
    return
  }
  try {
    send({ jsonrpc: "2.0", id: request.id, result: await handler(request.params) })
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error) } })
  }
})
