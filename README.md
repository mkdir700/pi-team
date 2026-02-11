# pi-team

`pi-team` 是一个专为多 Agent 协作设计的轻量级运行时系统。它通过 `teamd` 守护进程管理任务、消息和资源租约，确保在单机环境下实现可审计、可恢复且安全的协作。

## 核心特性

- **单写者模型**：仅 `teamd` 拥有工作区写入权，确保状态一致性。
- **任务与租约**：支持任务分派、领取（Claim）和租约自动过期/续期。
- **讨论线程**：内置 JSONL 格式的讨论线程，支持 Peer-to-Peer 交流。
- **安全拦截**：配套扩展可拦截 `write`、`edit` 和 `bash` 调用，防止无租约写入。
- **崩溃恢复**：支持 JSONL 尾部半行容忍和状态自动恢复。

## 快速上手

### 1. 安装依赖

确保已安装 Node.js 20+ 和 npm。

```bash
npm install
```

### 2. 构建与测试

```bash
# 编译项目
npm run build

# 运行测试套件
npm test
```

### 3. 启动 teamd 守护进程

`teamd` 负责管理特定团队的状态。

```bash
# 启动默认团队的守护进程并输出 JSON 格式的运行信息
npm run teamd:start -- --json
```

启动后，它会生成 `runtime.json`（通常位于 `~/.pi/teams/<teamId>/`），包含 API URL 和访问 Token。

### 4. 使用 CLI 工具

`pi-team` CLI 用于管理团队和查看状态。

```bash
# 查看守护进程状态
node dist/bin/pi-team.js daemon status --team default

# 获取 Agent 运行环境变量
node dist/bin/pi-team.js agent env --team default --agent leader
```

### 5. 运行演示脚本

项目包含端到端演示和崩溃恢复演练。

```bash
# 运行端到端协作演示（创建任务 -> 讨论 -> 领取 -> 完成）
npm run demo:e2e

# 运行崩溃恢复演示
npm run demo:crash-recovery
```

演示产生的证据文件和工作区将保存在 `.sisyphus/evidence/` 目录下。

## 扩展集成

`pi-team` 提供了一个配套扩展，用于在 Agent 环境中注册协作工具并实施写入拦截。

### 零手动环境变量（推荐）

从当前版本开始，扩展支持自动发现 `teamd` 连接信息：

1. 启动 `teamd`（会写入 `runtime.json`）。
2. 安装扩展到 `pi` 的扩展目录。
3. 直接启动 `pi`，无需手动 `export PI_*`。

示例：

```bash
# 1) 启动 teamd（默认会写到 ~/.pi/teams/<teamId>/runtime.json）
npm run teamd:start -- --team default --json

# 2) 安装扩展（全局）
mkdir -p ~/.pi/agent/extensions/
cp dist/extension/index.js ~/.pi/agent/extensions/team-coordination.js

# 3) 启动 pi（扩展会自动发现 runtime）
pi
```

如需使用非默认团队目录，可设置 `PI_TEAM_WORKSPACE_ROOT` 指向你的 teams 根目录。

详细安装与配置请参考：[Extension 指南](docs/extension.md)

## 故障排查与限制

关于常见问题、权限设置及 MVP 阶段的非目标，请参考：[故障排查与限制](docs/troubleshooting.md)

## 许可证

MIT
