# magpie-officeace-plugin

<p align="center">
  <b>华为云 OfficeAce (AgentArts) 模型网关的 Magpie Provider 插件</b><br>
  <i>（同时代码兼容 OpenCode）</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Magpie-Plugin-blueviolet.svg" alt="Magpie Plugin">
  <img src="https://img.shields.io/badge/OpenCode-Compatible-blue.svg" alt="OpenCode Compatible">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License">
</p>

---

> 💖 **致谢与核心参考**  
> 本插件关于 OfficeAce 端点、华为云签名算法（`SDK-HMAC-SHA256` / `V11-HMAC-SHA256`）、DPoP 鉴权及请求体兼容修补等核心实现，均参考自开源项目 **[officeace2api](https://github.com/Q-shuang-dot/officeace2api)**，在此致以诚挚谢意！

---

## 📖 项目简介

`magpie-officeace-plugin` 是专为 **Magpie** 设计的 Provider 插件，用于将华为云的编程助手服务 **OfficeAce**（即 DevEco Studio 桌面助手背后的 **AgentArts** 模型网关）接入 Magpie 生态。

同时，插件在接口层完全遵循开放 Provider 规范，**向下保持对 OpenCode 的完整兼容**。

- **免安装桌面应用**：直接通过浏览器完成华为云 OAuth 官方授权，无需安装任何桌面端应用或抓包。
- **深度适配 Magpie**：支持 Magpie 原生的多账号负载、并发控制、积分额度监控卡片与自动额度轮换。
- **开箱即用**：自动为账号探测并匹配所属的专属网关与长期访问凭据，智能探测可用模型。

---

## ✨ 核心特性

| 特性 | 描述 |
| :--- | :--- |
| 🪶 **轻量免客户端登录** | 基于 **OAuth 2.0 PKCE + DPoP** 在浏览器中完成华为云官方登录，最长等待 5 分钟，自动回调，免手动复制 Token。 |
| 👥 **多账号与并发管理** | 原生适配 Magpie 账号池，支持多账号并存、并发控制（默认并发 4）、额度耗尽自动切换下一个账号。 |
| 🔑 **双登录模式** | 支持**浏览器一键扫码/账号登录**与**网关密钥直接导入**（已有 `baseUrl` 与 `Authorization` 快速复用）。 |
| 🔄 **无感续期机制** | 对话核心 **Basic 密钥永久有效**；读取积分用的临时 AK/SK 在后台静默自动续期，具备单向宽限期与并发锁兜底。 |
| 🧠 **模型智能适配** | 针对推理模型自动补偿 `max_tokens` 思考预算（+1024），自动剥离 GLM-5.3 冲突参数，支持流式与单次响应透明聚合。 |
| 📊 **积分看板与到期路由** | 使用华为云 `V11-HMAC-SHA256` 算法实时签名查询套餐额度，支持 Magpie 根据积分到期时间智能优先消费。 |
| 🎁 **每日签到领积分** | Magpie 原生 `auth.checkin`：调用订阅卡的幂等领取接口，一次领走每日签到奖励与一次性新人礼；前后余额对比给出实际入账积分，支持多账号逐个签到。 |

---

## 🤖 模型支持清单（实测可用性）

在 Magpie 中登录账号后，插件会向账号专属网关（`GET /models`）查询实际开通的模型列表。

不同套餐等级及当前华为云网关策略下，可用模型状态如下（在 Magpie 界面中可通过 **「只选可用」** 一键筛选）：

### 🟢 当前实测可用模型（可用并推荐）

| 模型 ID | 模型显示名称 | 上下文大小 | 推理深度支持 (Reasoning Effort) | 状态 | 说明 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | **1M** | `high` | 🟢 可用 | 推荐，支持超长上下文与深度思考 |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | **1M** | - | 🟢 可用 | 极速响应，适合常规编码与补全 |
| `deepseek-v4-flash-0731`| DeepSeek-V4-Flash-0731 | **1M** | - | 🟢 可用 | 历史版本快照 |
| `glm-5.3` | GLM-5.3 | 198K | - | 🟢 可用 | 插件已自动剥离不支持的 thinking 参数 |
| `glm-5.2` | GLM-5.2 | 198K | `high` | 🟢 可用 | 智谱 GLM 推理模型 |
| `glm-5.1` | GLM-5.1 | 198K | `high` | 🟢 可用 | 智谱 GLM 基础版 |
| `kimi-k2.6` | Kimi-K2.6 | 256K | - | 🟢 可用 | 月之暗面 Kimi 长文本模型 |
| `qwen3-32b` | Qwen3-32B | 128K | - | 🟢 可用 | 通义千问 32B 编程模型 |
| `qwen3-30b-a3b` | Qwen3-30B-A3B | 128K | - | 🟢 可用 | 通义千问 MoE 架构版本 |

---

## 🚀 安装与使用指南

### 在 Magpie 中使用（主要使用方式）

1. **添加插件**：在 Magpie 的插件管理中加载或导入 `magpie-officeace-plugin`。
2. **添加账号**：
   - 勾选启用 **OfficeAce** 提供商。
   - 点击 **添加账号**，选择 **OfficeAce account (browser)**（浏览器登录）。
   - 浏览器将自动打开华为云登录页面，登录你的华为云账号。
   - 登录完成后回到 Magpie，账号卡片将自动更新为已登录状态，并展示：
     - 当前账号 ID 与并发数（默认并发 4）。
     - 实时积分额度（例如：`6,500 / 6,500 积分 · 剩余 100%`）。
3. **多账号轮换**：
   - 可继续点击 **「添加另一个 OfficeAce 账号」**。
   - Magpie 会默认优先使用首个账号；勾选多个账号时，前一个额度用完将自动平滑无缝切换到下一个。
4. **每日签到**：
   - 在 Magpie 的插件页打开 OfficeAce 的每日签到开关，插件会对每个账号每天（北京时间）调用一次领取接口。
   - 领到积分时显示实际入账数；当天已领过则显示「今日已签」，重复调用不会重复发放。
   - 签到使用账号的临时控制台 AK/SK，Magpie 会在到期前自动续期；只导入了网关密钥的账号没有控制台凭据，签到不适用。

---

### 在 OpenCode 中兼容使用

由于本插件核心代码完全向下兼容 OpenCode 插件接口，亦可在 OpenCode 中直接使用：

1. 在 OpenCode 配置文件（如 `~/.config/opencode/opencode.json`）中声明插件：
   ```json
   {
     "plugins": [
       "magpie-officeace-plugin"
     ]
   }
   ```
2. 运行登录认证：
   ```bash
   opencode auth login
   ```
   选择 `OfficeAce` 并按照终端提示在浏览器中完成授权即可。

---

## 🔐 凭证生命周期与安全机制

很多用户关心 Token 过期问题，插件采用分层认证策略，兼顾安全与稳定：

```
                      ┌──────────────────────────────────────────────┐
                      │          华为云 OAuth 浏览器登录              │
                      └──────────────────────┬───────────────────────┘
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     ▼                                               ▼
       ┌───────────────────────────┐                   ┌───────────────────────────┐
       │   网关凭据 (Basic Key)    │                   │   临时凭据 (AK / SK)      │
       ├───────────────────────────┤                   ├───────────────────────────┤
       │ • 永久有效，永不过期      │                   │ • 有效期约 1 天          │
       │ • 专门用于模型对话 Chat    │                   │ • 仅用于查询额度/积分     │
       │ • 无需网络续期，永不掉线  │                   │ • 由 Refresh Token 自动续期│
       └───────────────────────────┘                   └───────────────────────────┘
```

| 凭据类型 | 作用与范围 | 有效期 | 续期与管理机制 |
| :--- | :--- | :--- | :--- |
| **网关 Basic 密钥** | 对话接口 (`/chat/completions`) 认证 | **永久有效** | **永不需要续期**！只要账号套餐有效即可永久发送对话。 |
| **控制台 AK/SK** | 读取订阅积分 (`/v1/subscription`) 与领取每日奖励 (`/v1/subscription/bonus/claim`) | 1 天 | 凭证快到期前 10 分钟内自动触发 DPoP 签名向华为云 STS 续期；Magpie 后台提前 60 分钟自动预热续期。 |
| **Refresh Token** | 轮换刷新临时 AK/SK | 约 30 天 | 每次使用即刻轮换。支持并发请求合并保护，并为刚失效的旧 Token 保留 1 分钟宽限缓冲。 |

> **持久化存储位置**：  
> - Magpie 中保存在 `plugin-auth.json`  
> - OpenCode 中保存在 `~/.config/opencode/auth.json`

---

## 🛠️ 接口修补与细节优化

为了保证 Agent 与 OfficeAce 网关之间稳定交互，插件内置了以下透明补丁机制：

1. **思考预算补偿 (`max_tokens`)**：
   - OfficeAce 网关中，推理模型的思考过程与回答内容**共享 `max_tokens` 预算**。如果预算过小，思考阶段耗尽后会导致回答为空。
   - 插件自动在 Agent 请求预算的基础上**追加 1024 tokens 余量**；当显式设定极小预算（`< 16`）时保持原样传递。
2. **模型兼容性裁剪**：
   - 针对 `glm-5.3` 及其衍生模型，自动剥离网关拒绝的 `thinking`、`enable_thinking`、`reasoning_effort`、`stream_options` 等参数。
   - `temperature` 自动限制在 `[0, 2]`，`top_p` 自动限制在 `[0, 1]`。
3. **流式聚合 (Stream Collapse)**：
   - 网关对流式请求支持最佳。若客户端或 Agent 要求单次非流式响应，插件自动以流式发起并在内部汇聚所有分块（保留思考内容 `reasoning_content`、函数调用与最终 `usage`），无缝封装后返回。
4. **积分耗尽友好拦截**：
   - 当遇到网关因积分不足拒绝请求时，自动附加提示信息，避免误判为网络异常或鉴权失效。

---

## 🔍 与 officeace2api 的定位对比

| 功能特性 | officeace2api | 本插件 (magpie-officeace-plugin) |
| :--- | :---: | :---: |
| **主要定位** | 独立运行的 API 代理服务 / 中转站 | Magpie 原生嵌入式 Provider 插件（兼容 OpenCode） |
| **客户端依赖** | 支持抓取本机客户端缓存凭证 | **完全免安装桌面客户端**，纯云端 OAuth |
| **多账号负载均衡** | 内置账号轮换池与冷却调度 | 由 Magpie 原生 UI 与调度引擎统一负责账号管理与路由 |
| **每日签到领积分** | 支持自动化签到 | **支持** Magpie 原生 `auth.checkin`，幂等领取 + 前后余额对账 |
| **运行开销** | 需常驻后台守护进程及额外端口 | 纯 JS 插件，按需加载，零额外守护进程开销 |

---

## 🧪 测试与验证

项目内置了完整的测试套件与离线模拟沙箱（所有请求均通过虚拟替身完成，不产生外部网络开销）：

```bash
# 运行极速冒烟测试 (Node.js 原生运行)
node smoke.mjs

# 运行完整单元测试套件 (需要安装 bun)
bun test
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 许可协议。
