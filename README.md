# opencode-rea-switch

OpenCode 版的 REA 开关，对应 DSH 插件
[dsh-rea-switch](https://github.com/Eddyxyc/dsh-rea-switch)。

一个总开关直接关闭 REA；打开后再用第二个开关选择 **完整版**（`rea`）或
**压缩版**（`rea-compact`）。两套 MCP 工具集不会同时运行。

和 DSH 版不同的是，这个版本把状态放在 **server 端**，所以：

- 开关对 `opencode` TUI、`opencode run` 和远程连接都生效；
- 不需要手改 `opencode.jsonc` 来切 `disabled`；
- 压缩版默认从完整版派生（同一命令 + schema profile 环境变量），
  不需要在配置里重复写一行。

## 功能

- 「启用 REA」总开关：关 → 两套都停用，REA 的 MCP 工具从工具列表消失；
  开 → 恢复上次选中的版本。
- 「使用压缩版 REA」：开 → 先停完整版再启压缩版；关 → 先停压缩版再启完整版。
- 上次选中的版本记在 server 端持久化存储里；重启 OpenCode 后仍然生效。
- 面板显示两行的实时 MCP 状态（运行中 / 启动中 / 已停用 / 加载失败 / 需要登录）。
- 如果手动在 `/mcps` 里把两套都连上，面板会显示黄色警告；下一次切换会自动
  把不该运行的那一套停掉。

## 依赖的运行配置

插件会从当前 OpenCode 配置里查找 `rea`。例如：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "rea": {
        "type": "local",
        "command": [
          "E:\\dev\\nodejs\\node.exe",
          "E:\\dev\\npm-global\\node_modules\\rea-agents\\scripts\\rea.mjs",
          "mcp"
        ]
      }
    }
  }
}
```

旧版的 `mcp.rea` 写法也可以，OpenCode 会先迁移成 `mcp.servers.rea`，插件看到的是
迁移后的配置。

**不需要**写 `rea-compact`。插件会自动派生：

```jsonc
{
  "type": "local",
  "command": [/* 和 rea 相同 */],
  "environment": {
    "REA_MCP_INPUT_SCHEMA_PROFILE": "compact",
    "REA_MCP_OUTPUT_SCHEMA_PROFILE": "off"
  }
}
```

如果已经有显式的 `rea-compact` 配置，插件会优先使用它，只改 `disabled`。

## 安装

### 从本地 checkout（推荐，改代码即时生效）

```powershell
# 在仓库根目录
.\install.ps1
```

脚本会在 `~/.config/opencode/plugins/opencode-rea-switch` 建一个 junction，
指向当前目录。OpenCode 会自动发现这个目录里的 `server.ts` 和 `tui.tsx`。

macOS / Linux：

```sh
./install.sh
```

然后重启一次 OpenCode（让 server 半加载）；之后改 TUI 代码会热重载，
改 server 代码需要重启。

### 从 npm / Git

```sh
opencode plugin add github:Eddyxyc/opencode-rea-switch
```

包同时导出 server 入口和 `./tui` 入口；OpenCode 会把它作为 server 插件加载，
并自动挂上同包的 TUI 入口。

也可以手动写进 `opencode.jsonc`：

```jsonc
{
  "plugins": [
    "github:Eddyxyc/opencode-rea-switch"
    // 或本地绝对路径："E:/项目/rea开关-opencode"
  ]
}
```

> 如果要发布到 npm，记得把 `package.json` 里的 `"private": true` 去掉。

## 使用

在 TUI 里输入：

```text
/rea
```

或者在命令面板里搜索 **REA 开关**。面板里的按键：

| 键 | 作用 |
| --- | --- |
| `↑` / `↓` | 在两行之间移动 |
| `空格` / `回车` | 切换当前行 |
| `R` | 刷新状态 |
| `Esc` | 关闭面板 |

## 状态机

| 总开关 | 压缩版 | 实际运行 | 说明 |
| --- | --- | --- | --- |
| 关 | — | 两套都停用 | REA 工具从工具列表消失 |
| 开 | 关 | `rea` | 完整版，全部 REA 工具 |
| 开 | 开 | `rea-compact` | 约 1.15 万 JSON 节点，适合有 32,768 节点上限的网关 |
| 开 | 开 + 手动连了完整版 | 两套 | 面板警告；下一次切换会修复 |

总开关关闭时会记住上次的版本；再次打开会回到同一个版本。默认是完整版。

## 配置选项

一般不需要。需要改服务器名、压缩版环境变量，或完整版不在配置里时，可以用对象
形式的插件配置：

```jsonc
{
  "plugins": [
    {
      "package": "opencode-rea-switch",
      "options": {
        "names": { "full": "rea", "compact": "rea-compact" },
        "compactEnv": {
          "REA_MCP_INPUT_SCHEMA_PROFILE": "compact",
          "REA_MCP_OUTPUT_SCHEMA_PROFILE": "off"
        },
        // 配置里没有 rea 时，用这里提供完整版配置
        "full": {
          "type": "local",
          "command": ["node", "E:/path/to/rea.mjs", "mcp"]
        }
      }
    }
  ]
}
```

`full` 和 `compact` 也可以是命令数组：

```jsonc
"full": ["node", "E:/path/to/rea.mjs", "mcp"]
```

## 架构

```text
TUI /rea
   │  RPC: rea-switch.status / rea-switch.setMode
   ▼
server half (server.ts)
   │  ctx.mcp.transform()
   ▼
OpenCode MCP service
   ├─ rea          disabled = mode !== "full"
   └─ rea-compact  disabled = mode !== "compact"
```

- TUI 半只负责显示和转发操作，不直接改 MCP。
- server 半用 `ctx.mcp.transform()` 增删/启停两行，状态存在 `ctx.storage`。
- 因为改的是 transform 而不是配置文件，插件卸载后配置会回到原样。

## 自检

```sh
npm install

# 纯状态机单测
npm test

# TUI 命令注册冒烟测试（需要 Bun）
bun test/tui-probe.mjs

# 端到端：起一个隔离的 opencode serve，跑
# full -> compact -> off -> full -> both 修复 -> 重启持久化
node test/probe.mjs

# 类型检查
npm run typecheck
```

`test/probe.mjs` 需要 PATH 里有 `opencode`。它会使用临时 XDG 目录、临时配置和
一个假的 MCP stdio 服务器，不会碰你的真实配置或数据库。

## 已知限制

- 必须同时加载 server 半和 TUI 半。只把 `tui.tsx` 放进插件目录时，面板会提示
  连不上开关服务。
- 启动时 OpenCode 可能先按配置连上完整版，随后插件才把它停掉并切到压缩版；
  这个窗口通常只有几百毫秒。想彻底避免，可以把配置里的 `rea` 写成
  `"disabled": true`，让插件按记住的模式启用它（代价是插件未加载时 REA 保持关闭）。
- 运行时 transform 不会写回 `opencode.jsonc`。如果直接停用/卸载插件，配置里的
  默认值会重新生效。
- compact 派生只适用于本地 MCP 服务器；远程 `rea` 需要显式配置 `rea-compact`。
- TUI 面板的视觉渲染只做了类型检查和命令注册冒烟测试；交互逻辑由真实
  `opencode serve` 的 RPC 端到端测试覆盖。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.ts` | server 半：状态、MCP transform、RPC |
| `tui.tsx` | TUI 半：`/rea` 命令和两开关面板 |
| `contract.ts` | 两端共享的 RPC schema |
| `src/state.ts` | 状态机、compact 派生等纯函数 |
| `test/probe.mjs` | 隔离的 `opencode serve` 端到端测试 |
| `test/tui-probe.mjs` | Bun 下的 TUI 命令注册冒烟测试 |
