# 落雨 AI 伴侣 · 开源工具集

> 落雨 ActApp 的开源模块集合，依据 **GNU Lesser General Public License v3.0** 发布。

---

## 本仓库包含什么

| 模块 | 文件 | 说明 |
|---|---|---|
| **API 接入** | `src/api-adapter.js` | 服务商端点推导、多模态内容构建、工具调用转换、自定义请求头、模型参数注入 |
| | `src/api-services.js` | 用户自配开放平台 API 服务的调用封装 |
| **工具集** | `src/chat-tools.js` | 对话中可调用的工具定义 |
| | `src/mcp.js` | MCP（Model Context Protocol）支持 |
| | `src/chat-mcp.js` | 将用户配置的远程 MCP 服务器接入对话 |
| **工作流引擎** | `src/workflow-engine.js` | 节点 + 连线的工作流模型与执行引擎 |
| | `src/workflow-tools.js` | 工作流的增删改查工具 |
| | `src/workflow-scheduler.js` | 定时调度（interval / specific_time / cron） |
| | `src/workflow-runner.js` | 各动作类型的执行器 |
| **其他** | `src/waifu.js` | 桌宠（Waifu）设置模型 |
| | `src/index.js` | 总入口 |
| **接口桩** | `src/stubs/` | 宿主能力与闭源模块的接口声明（不含实现），见 [stubs/README.md](src/stubs/README.md) |

---

## 关于「接口桩」

`src/stubs/` 目录下的文件**只声明接口，不含实现**。

开源模块在宿主环境中依赖若干**宿主能力**（如原生层的应用启动、屏幕操作）与**宿主自有模块**。
这些依赖不在开源范围内，但若直接缺失，开源模块将无法加载。

因此提供接口桩，说明"需要宿主提供什么"，但不提供实现。

**这符合 LGPL-3.0 第 4 条「组合作品」的规定**——开源部分与闭源部分可以组合分发，
只要开源部分本身完整、可独立获取、可被替换。

| 桩文件 | 对应能力 | 开源版行为 |
|---|---|---|
| `stubs/agent.js` | 原生能力（应用启动、屏幕读写、Shell、通知等） | `isAvailable()` 返回 `false`，其余抛提示错误 |
| `stubs/jealousy-patrol.js` | 吃醋巡查 | 返回失败码，不影响其余功能 |
| `stubs/api-control.js` | 请求前的配置校验钩子 | 全部放行，不做校验 |

**使用方按需实现即可**——只实现用得到的成员，其余删掉不影响加载。

---

## 核心能力说明

### API 端点推导

根据用户填写的 Base URL，自动推导出正确的调用地址，兼容多种填写习惯：

| 用户填写 | 推导结果 |
|---|---|
| `https://api.example.com` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `https://proxy.example.com/custom/v1` | `https://proxy.example.com/custom/v1/chat/completions` |
| `https://api.example.com/v2` | `https://api.example.com/v2/chat/completions` |
| 已含 `/chat/completions` | 原样返回 |
| 末尾带 `#` | 关闭自动补全，去掉 `#` 后原样返回 |

**模型列表端点**从聊天端点反推：`/chat/completions` → `/models`，兼容 `/v1`–`/v4` 版本路径。

### 服务商预设

| 服务商 | 端点 | 默认模型 |
|---|---|---|
| DeepSeek | `api.deepseek.com` | — |
| 月之暗面 | `api.moonshot.cn/v1` | — |
| 豆包 | `ark.cn-beijing.volces.com/api/v3` | — |
| 硅基流动 | `api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| 智谱 AI | `open.bigmodel.cn/api/paas/v4` | `glm-4` |
| 通义千问 | `dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 自定义 | 用户自填 | 用户自填 |

### 工作流引擎

节点 + 连线模型，支持触发节点、动作节点、条件分支与节点间参数引用。

调度支持三种模式：

| 模式 | 说明 |
|---|---|
| `interval` | 固定间隔重复 |
| `specific_time` | 指定时刻执行 |
| `cron` | cron 表达式 |

---

## 环境说明

本模块为 **纯 JavaScript（ES5 风格）**，无构建步骤、无外部依赖。

**代码中包含 uni-app 的条件编译指令**（`#ifdef` / `#ifndef` / `#endif`，共 18 处）。
这些指令由 uni-app 编译期处理；在其他环境下它们会被视为普通注释，不影响运行。

调用 `uni.*` API 的部分（如 `uni.request`、`uni.getStorageSync`）需要 uni-app 环境。
如需在其他环境使用，请替换为等价的网络与存储实现。

---

## 如何获取源码

本仓库即完整源码。

---

## 如何使用

```javascript
import { apiAdapter, workflowEngine } from './src/index.js'

// 推导聊天端点
const url = apiAdapter.buildChatUrl('https://api.example.com')

// 推导模型列表端点
const modelsUrl = apiAdapter.buildModelsUrl(url)
```

在 uni-app / uni-app x 工程中，将 `src/` 下的文件放入 `common/` 目录即可直接引用。

---

## 如何替换本模块

**本模块可自由替换，这是 LGPL-3.0 赋予使用者的权利。**

1. Fork 或克隆本仓库
2. 修改 `src/` 下的源码
3. 将修改后的文件覆盖到落雨工程对应路径（默认 `common/`）
4. 重新编译 App，修改即可生效

**本模块不包含任何签名校验、完整性检查或防篡改机制，替换不受任何限制。**

---

## 如何参与开发

**欢迎任何团队与个人参与。**

- 提交 Issue：报告问题或提出建议
- 提交 Pull Request：修复缺陷、新增服务商适配、完善文档
- 参与讨论：在 Issue 中交流设计思路

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 开源范围说明

落雨 ActApp **仅开源本仓库所列模块**，其余功能暂不开源。

**这在 LGPL-3.0 框架下是允许的**——LGPL 与 GPL 的核心区别正在于此：

> **LGPL 允许「库开源 + 主程序闭源」，GPL 不允许。**

本仓库的源码可自由获取、修改与再分发，但**落雨客户端主体不属于本仓库，不在开源范围内**。

---

## 来源与致谢

本项目的实现参考了以下开源项目的设计：

| 项目 | 地址 | 许可证 |
|---|---|---|
| Operit | https://github.com/AAswordman/Operit | LGPL-3.0 |

详细说明见 [NOTICE](NOTICE) 与 [THIRD-PARTY.md](THIRD-PARTY.md)。

---

## 许可证

依据 **GNU Lesser General Public License v3.0** 发布，全文见 [LICENSE](LICENSE)。

```
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

---

## English

### Luoyu AI Companion · Open Toolkit

Open-source modules of **Luoyu ActApp**, released under the
**GNU Lesser General Public License v3.0**.

**Contents** — API endpoint resolution, multimodal content building, tool-call
conversion, toolset definitions, MCP support, and a node-based workflow engine
with scheduling.

**Build** — Pure JavaScript (ES5 style), no build step, no dependencies.
The code contains uni-app conditional-compilation directives, which are
no-ops outside the uni-app toolchain.

**Interface stubs** — `src/stubs/` declares host capabilities (native agent,
configuration validation) and host-owned modules **without implementations**,
so that the open modules load and remain usable. This is permitted by
LGPL-3.0 section 4 (Combined Works).

**Replacing these modules** — You may replace them freely (a right granted by
LGPL-3.0). No signature checks or integrity verification are performed.

**Contributions** — Welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Scope** — Only the modules in this repository are open-sourced; the rest of
Luoyu ActApp remains proprietary. This is permitted by LGPL-3.0, which unlike
GPL allows an open library combined with a proprietary application.

---

**落雨开发团队 · Luoyu Development Team**
