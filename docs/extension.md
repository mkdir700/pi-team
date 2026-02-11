# Extension 指南

`pi-team` 扩展（`team-coordination`）是 Agent 与协作运行时交互的桥梁。它负责注册协作工具、轮询收件箱通知，并实施写入权限拦截。

## 安装方式

### 1. 全局安装

将构建好的扩展文件复制到 `pi` 的全局扩展目录：

```bash
mkdir -p ~/.pi/agent/extensions/
cp dist/extension/index.js ~/.pi/agent/extensions/team-coordination.js
```

### 2. 项目本地安装

在特定项目中使用时，可以安装到项目根目录：

```bash
mkdir -p .pi/extensions/
cp dist/extension/index.js .pi/extensions/team-coordination.js
```

## 环境变量配置

扩展通过环境变量获取 `teamd` 的连接信息。你可以使用 `pi-team agent env` 命令生成这些变量。

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `PI_TEAM_ID` | 团队 ID | `my-team` |
| `PI_AGENT_ID` | 当前 Agent 的 ID | `worker-1` |
| `PI_TEAMD_URL` | `teamd` 的 API 地址 | `http://127.0.0.1:4500` |
| `PI_TEAMD_TOKEN` | 访问 Token（直接提供） | `secret-token` |
| `PI_TEAMD_TOKEN_FILE` | 包含 Token 的文件路径 | `/path/to/runtime.json` |

> **注意**：如果同时提供 `PI_TEAMD_TOKEN` 和 `PI_TEAMD_TOKEN_FILE`，前者优先级更高。

## 注册的工具

扩展会自动注册以下工具（前缀为 `team.`）：

- `team.tasks.create`: 创建任务
- `team.tasks.claim`: 领取任务租约
- `team.tasks.complete`: 完成任务
- `team.tasks.fail`: 标记任务失败
- `team.tasks.list`: 列出所有任务
- `team.threads.start`: 启动讨论线程
- `team.threads.post`: 发送消息
- `team.threads.readTail`: 读取线程最新消息
- `team.threads.search`: 搜索线程内容
- `team.threads.linkToTask`: 将线程关联至任务

## 写入拦截逻辑

为了确保协作安全，扩展会拦截以下工具的调用：
- `write`
- `edit`
- `bash`

**拦截规则**：
1. 如果 Agent 当前没有持有覆盖目标路径的有效任务租约（Lease），调用将被阻断。
2. 拦截会返回明确的错误信息，提示 Agent 领取相关任务后再试。
3. 在无 UI 模式下，所有写入操作默认被阻断以确保保守安全。
