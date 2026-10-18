/**
 * TUI half of opencode-rea-switch.
 *
 * `/rea` (or the command palette) opens a small two-switch panel. All state
 * changes go through the RPC contract owned by the server half.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import {
  contract,
  type ReaMode,
  type ReaStatus,
  type ServerPhase,
  type ServerStatus,
  type SetModeResult,
} from "./contract.ts"
import { isActivePhase, modeOf, targetFor } from "./src/state.ts"

type NoticeKind = "ok" | "warn" | "error"
type Notice = { readonly kind: NoticeKind; readonly text: string }

const phaseLabel: Record<ServerPhase, string> = {
  connected: "运行中",
  pending: "启动中",
  disabled: "已停用",
  failed: "加载失败",
  needs_auth: "需要登录",
  missing: "未配置",
}

function open(context: Context) {
  context.ui.dialog.set({ size: "large", centered: true })
  context.ui.dialog.show(() => <ReaDialog context={context} />)
}

export default Plugin.define({
  id: "rea-switch.tui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "rea-switch.open",
          title: "REA 开关",
          description: "关闭 REA，或在完整版与压缩版之间切换",
          group: "REA",
          slash: { name: "rea" },
          palette: true,
          suggested: true,
          run: () => open(context),
        },
      ],
    }))
  },
})

function ReaDialog(props: { context: Context }) {
  const theme = props.context.theme
  const rpc = props.context.client.rpc(contract)
  const [state, setState] = createSignal<ReaStatus>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<Notice>()
  const [focus, setFocus] = createSignal<0 | 1>(0)

  let alive = true
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = async (initial = false) => {
    if (initial) setLoading(true)
    try {
      const next = (await rpc.status({})) as ReaStatus
      if (!alive) return
      setState(next)
      setError(undefined)
    } catch (cause) {
      if (!alive) return
      setError(messageOf(cause))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void refresh(true)
    timer = setInterval(() => {
      const current = state()
      if (current === undefined) return
      if (current.full.status === "pending" || current.compact.status === "pending") void refresh()
    }, 1000)
  })

  onCleanup(() => {
    alive = false
    if (timer !== undefined) clearInterval(timer)
  })

  const apply = async (target: ReaMode) => {
    if (busy()) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = (await rpc.setMode({ mode: target })) as SetModeResult
      if (!alive) return
      if (result.state !== undefined) setState(result.state)
      if (result.ok) {
        setNotice({ kind: "ok", text: successText(target) })
      } else {
        setNotice({ kind: "error", text: `切换失败：${result.error ?? "未知错误"}` })
        void refresh()
      }
    } catch (cause) {
      if (alive) setNotice({ kind: "error", text: `切换失败：${messageOf(cause)}` })
    } finally {
      if (alive) setBusy(false)
    }
  }

  const actual = () => {
    const current = state()
    return current === undefined ? "off" : modeOf(current.full.status, current.compact.status)
  }

  const masterOn = () => {
    const current = state()
    return current !== undefined && (isActivePhase(current.full.status) || isActivePhase(current.compact.status))
  }

  const compactOn = () => {
    const current = state()
    return current !== undefined && isActivePhase(current.compact.status)
  }

  const missingCompact = () => {
    const current = state()
    return current !== undefined && current.supported && !current.compact.configured
  }

  const toggle = (row: 0 | 1) => {
    const current = state()
    if (current === undefined || !current.supported || busy()) return
    const target = targetFor(row === 0 ? "master" : "compact", actual(), current.lastVariant)
    if (row === 1 && actual() === "off") {
      setNotice({ kind: "warn", text: "REA 已关闭：先打开上面的总开关，再选择版本" })
      return
    }
    if (target === "compact" && !current.compact.configured) {
      setNotice({ kind: "warn", text: "压缩版 REA 不可用：完整版不是本地服务器，也没有单独配置 rea-compact" })
      return
    }
    if (target === actual()) {
      setNotice({ kind: "warn", text: alreadyText(target) })
      return
    }
    void apply(target)
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "up", title: "上一项", run: () => setFocus((value) => (value === 0 ? 1 : 0)) },
      { bind: "down", title: "下一项", run: () => setFocus((value) => (value === 0 ? 1 : 0)) },
      { bind: "space", title: "切换", run: () => toggle(focus()) },
      { bind: "return", title: "切换", run: () => toggle(focus()) },
      { bind: "r", title: "刷新", run: () => void refresh() },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text fg={theme.text.base}>
        <b>REA 开关</b>
      </text>
      <text fg={theme.text.muted} wrapMode="word">
        总开关关闭 REA；打开后选择完整版或压缩版，两套不会同时运行。
      </text>
      <text fg={busy() ? theme.text.feedback.warning.base : theme.text.base}>
        {busy() ? "正在切换…" : modeText(actual())}
      </text>

      <Show when={notice()}>
        {(value) => (
          <box border={["left"]} borderColor={noticeColor(theme, value().kind)} paddingLeft={1}>
            <text fg={noticeColor(theme, value().kind)} wrapMode="word">
              {value().text}
            </text>
          </box>
        )}
      </Show>

      <Show when={error()}>
        {(value) => (
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              无法连接 REA 开关服务：{value()}
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              请确认插件已作为 server 插件加载（opencode plugin list），然后按 R 重试。
            </text>
          </box>
        )}
      </Show>

      <Show when={loading() && state() === undefined}>
        <text fg={theme.text.muted}>正在读取 REA 状态…</text>
      </Show>

      <Show when={state()}>
        {(current) => (
          <Show
            when={current().supported}
            fallback={
              <box flexDirection="column" gap={1}>
                <text fg={theme.text.feedback.error.base}>
                  <b>没有找到 REA 的 MCP 配置</b>
                </text>
                <text fg={theme.text.muted} wrapMode="word">
                  {current().reason ??
                    "请在 opencode.jsonc 的 mcp.servers 里声明 rea，或用插件选项 full 提供命令。"}
                </text>
              </box>
            }
          >
            <box flexDirection="column" gap={1}>
              <SwitchRow
                theme={theme}
                focused={focus() === 0}
                checked={masterOn()}
                disabled={busy()}
                title="启用 REA"
                hint={
                  actual() === "off"
                    ? "打开：恢复上次使用的版本（完整版 / 压缩版）"
                    : "关闭：两套 REA 都停用，REA 工具会从工具列表消失"
                }
                onFocus={() => setFocus(0)}
                onToggle={() => toggle(0)}
              />
              <SwitchRow
                theme={theme}
                focused={focus() === 1}
                checked={compactOn()}
                disabled={busy() || actual() === "off" || missingCompact()}
                title="使用压缩版 REA"
                hint={
                  actual() === "off"
                    ? "REA 已关闭：先打开上面的总开关，再选择版本"
                    : missingCompact()
                      ? "压缩版不可用：完整版不是本地服务器，也没有单独配置 rea-compact"
                      : compactOn()
                        ? "已启用压缩版；关闭会切回完整版"
                        : "打开会启用压缩版并停用完整版"
                }
                onFocus={() => setFocus(1)}
                onToggle={() => toggle(1)}
              />
            </box>

            <box flexDirection="column" gap={0}>
              <StatusRow theme={theme} row={current().full} />
              <StatusRow theme={theme} row={current().compact} />
            </box>

            <Show when={actual() === "both"}>
              <box border={["left"]} borderColor={theme.text.feedback.warning.base} paddingLeft={1}>
                <text fg={theme.text.feedback.warning.base} wrapMode="word">
                  两套同时在运行，token 占用最高：请关掉其中一个
                </text>
              </box>
            </Show>

            <text fg={theme.text.muted} wrapMode="word">
              压缩版通过 REA_MCP_INPUT_SCHEMA_PROFILE=compact、REA_MCP_OUTPUT_SCHEMA_PROFILE=off
              精简工具描述，适合有 32,768 节点上限的网关；本地直连时用完整版即可。
            </text>
          </Show>
        )}
      </Show>

      <text fg={theme.text.muted}>↑↓ 选择 · 空格 切换 · R 刷新 · Esc 关闭</text>
    </box>
  )
}

function SwitchRow(props: {
  theme: Context["theme"]
  focused: boolean
  checked: boolean
  disabled: boolean
  title: string
  hint: string
  onFocus: () => void
  onToggle: () => void
}) {
  return (
    <box flexDirection="column" onMouseDown={props.onFocus} onMouseUp={props.onToggle}>
      <box flexDirection="row" gap={1}>
        <text fg={props.focused ? props.theme.text.base : props.theme.text.muted}>{props.focused ? "▶" : " "}</text>
        <text fg={props.disabled ? props.theme.text.muted : props.theme.text.base}>
          <b>{props.title}</b>
        </text>
        <box flexGrow={1} />
        <text
          fg={
            props.disabled
              ? props.theme.text.muted
              : props.checked
                ? props.theme.text.feedback.success.base
                : props.theme.text.muted
          }
        >
          {props.checked ? "● 开" : "○ 关"}
        </text>
      </box>
      <text fg={props.theme.text.muted} wrapMode="word">
        {props.hint}
      </text>
    </box>
  )
}

function StatusRow(props: { theme: Context["theme"]; row: ServerStatus }) {
  const color = phaseColor(props.theme, props.row.status)
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={color}>●</text>
        <text fg={props.theme.text.base} flexGrow={1}>
          {props.row.name}
        </text>
        <text fg={color}>{props.row.configured ? phaseLabel[props.row.status] : "未配置"}</text>
      </box>
      <Show when={props.row.error ?? props.row.reason}>
        {(value) => (
          <text fg={props.theme.text.muted} wrapMode="word">
            {"  "}
            {value()}
          </text>
        )}
      </Show>
    </box>
  )
}

function phaseColor(theme: Context["theme"], phase: ServerPhase) {
  if (phase === "connected") return theme.text.feedback.success.base
  if (phase === "failed" || phase === "missing") return theme.text.feedback.error.base
  if (phase === "needs_auth" || phase === "pending") return theme.text.feedback.warning.base
  return theme.text.muted
}

function noticeColor(theme: Context["theme"], kind: NoticeKind) {
  if (kind === "ok") return theme.text.feedback.success.base
  if (kind === "warn") return theme.text.feedback.warning.base
  return theme.text.feedback.error.base
}

function modeText(actual: ReaMode | "both") {
  if (actual === "both") return "当前：两套同时在运行"
  if (actual === "full") return "当前运行：完整版（全部 REA 工具）"
  if (actual === "compact") return "当前运行：压缩版（约 1.15 万 JSON 节点）"
  return "已关闭：两套 REA 都没有加载"
}

function successText(target: ReaMode) {
  if (target === "off") return "已关闭 REA"
  if (target === "compact") return "已切换到压缩版 REA"
  return "已切换到完整版 REA"
}

function alreadyText(target: ReaMode) {
  if (target === "off") return "REA 已经是关闭状态"
  if (target === "compact") return "已经是压缩版了"
  return "已经是完整版了"
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
