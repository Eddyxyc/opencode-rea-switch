#!/usr/bin/env bun
/**
 * Smoke test for the TUI half. It loads tui.tsx with Bun, calls setup with a
 * fake plugin context, and verifies that the palette/slash command is
 * registered and opens the dialog. The JSX inside the dialog is not rendered.
 */
import assert from "node:assert/strict"

if (typeof Bun === "undefined") {
  console.log("SKIP: run this probe with Bun (bun test/tui-probe.mjs)")
  process.exit(0)
}

const plugin = (await import("../tui.tsx")).default
assert.equal(plugin.id, "rea-switch.tui")

let layer
let dialogOpened = false
const context = {
  keymap: {
    layer(factory) {
      layer = factory()
    },
  },
  ui: {
    dialog: {
      set() {},
      show() {
        dialogOpened = true
      },
    },
  },
  client: { rpc: () => ({}) },
  theme: {},
}

await plugin.setup(context)
assert.ok(layer, "setup should register a keymap layer")
const command = layer.commands.find((item) => item.id === "rea-switch.open")
assert.ok(command, "the REA command should be registered")
assert.equal(command.title, "REA 开关")
assert.deepEqual(command.slash, { name: "rea" })
assert.equal(command.palette, true)
command.run()
assert.equal(dialogOpened, true, "running the command should open the dialog")

console.log("PASS: TUI command registration and dialog open")
