# 接口桩说明

本目录下的文件**只声明接口，不含实现**。

## 为什么需要它们

`src/` 中的开源模块，在宿主环境中依赖若干**宿主环境能力**与**宿主自有模块**。
这些依赖不在开源范围内，但如果直接缺失，开源模块将无法加载。

因此这里提供**接口桩**：把"需要宿主提供什么"写清楚，但不提供实现。

**这符合 LGPL-3.0 第 4 条「组合作品」的规定**——开源部分与闭源部分可以组合分发，
只要开源部分本身完整、可独立获取、可被替换。

---

## 各桩文件说明

### `agent.js` — 宿主原生能力

需要系统权限的能力，落雨客户端由 Android 原生层（Kotlin / UTS 插件）实现。

| 成员 | 说明 |
|---|---|
| `isAvailable()` | 原生能力是否可用（如 Shizuku 是否已授权） |
| `ready()` | 初始化就绪 |
| `startApp(pkg, activity, cb)` | 启动应用 |
| `getForegroundApp(cb)` | 获取前台应用 |
| `readScreen(cb)` | 读取屏幕内容 |
| `click(x, y, cb)` | 坐标点击 |
| `clickByText(text, cb)` | 按文本点击 |
| `pressHome(cb)` | 返回桌面 |
| `execShell(cmd, cb)` | 执行 Shell 命令 |
| `js(code, cb)` | 执行 JS 片段 |
| `sendNotification(title, message, cb)` | 发送系统通知 |
| `getTodayAppUsage(cb)` | 获取今日应用使用记录 |
| `getDiagnose(cb)` | 获取诊断信息 |

> 开源版本中 `isAvailable()` 返回 `false`，其余成员调用时抛出提示错误。
> **使用方按需实现即可**——只实现用得到的成员，其余删掉不影响加载。

### `jealousy-patrol.js` — 吃醋巡查

不在本仓库的开源范围内。只有 `patrol(options)` 一个接口。

工作流中对应 `jealousy_patrol` 动作节点。使用方可自行实现，或直接删除该节点。

---

## 使用方如何接入

### 方式一：自己实现（推荐）

复制本目录的桩文件到你的工程，把 `notImplemented(...)` 替换成真实实现。

### 方式二：直接改成空实现

如果不打算用原生能力，把 `agent.js` 简化成：

```javascript
export default {
  isAvailable() { return false }
}
```

调用了缺失成员的代码路径会自动走降级分支。

### 方式三：删除

如果完全不需要工作流中的原生动作，可以删掉 `workflow-runner.js` 中
调用 `getAgent()` 的代码段，并移除对桩文件的 import。

---

## 重要说明

- **桩文件不构成本仓库开源范围的一部分**，它们只是接口描述。
- 宿主中的真实实现**不受 LGPL-3.0 约束**（不属于本仓库分发的作品）。
- 如果你实现了这些接口并希望回馈社区，欢迎按 [CONTRIBUTING.md](../CONTRIBUTING.md) 提交。

---

**落雨开发团队**
