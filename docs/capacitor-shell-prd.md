# MindFS Android App（Capacitor 壳化）PRD

## 1. 背景

MindFS 当前已经具备较成熟的 Web UI，并且在移动端浏览器/PWA 场景下已经有一定适配能力，包括移动端布局、底部操作栏、软键盘适配、PWA 安装引导等能力。为了进一步提升移动端可达性，希望在 **尽量少改前端代码** 的前提下，提供一个 Android App 形态，降低用户从浏览器访问到“像 App 一样使用”的门槛。

当前仓库中的 Web 前端基于 `React + Vite + Tailwind`，构建结果是静态资源，天然适合被 WebView 容器承载。同时，前端代码中大量依赖浏览器 API，如 `window`、`document`、`localStorage`、`indexedDB`、`serviceWorker`、`WebSocket`、`matchMedia`、`visualViewport` 等。这意味着若直接迁移到 React Native，同构成本会明显偏高，且会带来较大范围的 UI 和运行时改造。

因此，现阶段更合适的路线是：**优先采用 Capacitor 对现有 Web UI 进行 Android 壳化，先实现低成本、可上线、可维护的 App MVP，再逐步增强原生能力。**

***

## 2. 目标

### 2.1 产品目标

- 提供一个 Android App 形态的 MindFS 客户端。
- 在不重写现有前端的前提下，复用当前 Web UI。
- 保证 Android App 内能完成核心链路：登录、项目浏览、会话查看、文件浏览、会话流式更新。
- 为后续接入更多原生能力预留扩展空间。

### 2.2 方案目标

- 以 **最小改造范围** 完成 App MVP。
- 优先改造运行时适配层，而不是重做页面。
- 明确哪些能力属于本期范围，哪些能力延后。
- 形成一份可供产品、前端、客户端共同评审的方案文档。

### 2.3 非目标

本期不追求以下事项：

- 不重写现有 Web UI 为原生页面。
- 不在首期引入完整的推送、相机、通知、生物识别等高级原生能力。
- 不一次性迁移所有 `localStorage` / `indexedDB` 逻辑到原生存储。

***

## 3. 现状调研结论

### 3.1 当前 Web 技术栈适合壳化

当前 `web/` 前端具备以下特征：

建议的仓库结构基线：

- `web/`：现有 React + Vite 前端工程
- `web/`：React + Vite 前端工程与 npm 依赖，负责产出浏览器版与 Android 壳版静态资源
- `android/`：Android 原生工程、Capacitor 配置与 Android 壳版 Web 静态资源目录
- 两者保持同级目录，避免把原生工程嵌入 `web/` 内部；前端源码与原生工程边界清晰，便于职责划分、CI 配置与后续原生侧演进
- 构建工具为 Vite，`build` 输出静态资源。
- 前端框架为 React。
- 样式体系基于 Tailwind。
- 入口简单，适合打包进 Android WebView 容器。
- `vite.config.ts` 中已设置 `base: "./"`，适合静态资源相对路径部署。

这些条件使得现有 Web UI 很适合直接作为 Capacitor 的 `webDir` 输出内容。

### 3.2 当前代码强依赖浏览器运行时

当前前端大量依赖以下浏览器 API：

- `window` / `document`
- `window.location` / `window.history`
- `window.open`
- `localStorage`
- `indexedDB`
- `navigator.serviceWorker`
- `WebSocket`
- `matchMedia`
- `visualViewport`

这意味着：

- 在 **Capacitor + WebView** 中，大部分逻辑仍可沿用。

### 3.3 当前项目已具备移动端基础能力

仓库内已存在以下能力，可直接作为 Android App 的基础：

- PWA / 浏览器安装相关能力
- 移动端布局与底部操作区域
- 软键盘适配相关逻辑
- WebSocket 会话流
- 基于 `localStorage` / `indexedDB` 的缓存与会话存储
- 文件浏览、会话浏览、多项目管理

说明当前 Web UI 并不是桌面专用页面，而是已经具备一定“App 化”基础。

***

## 4. 方案选择

### 4.1 方案结论

**本期推荐方案：使用 Capacitor 对现有 MindFS Web UI 进行 Android 壳化。**

### 4.2 选择 Capacitor 的原因

1. **改造成本最低**
   - 可直接复用现有 React + Vite Web 前端。
   - 重点改运行时和宿主适配，不需要重写页面组件。
2. **上线路径最快**
   - 可以较快形成 Android MVP。
   - 前端与后端接口不需要大规模重构。
3. **与当前代码结构匹配度高**
   - 当前项目是典型浏览器应用，适合运行在 WebView 中。
   - 静态资源构建方式天然适合被 Capacitor 接管。
4. **可渐进增强**
   - 首期可以只做壳化。
   - 后续再按需补齐 Browser、Preferences、App、Keyboard 等原生插件能力。

### 4.3 为什么不优先做 React Native 同构

当前项目并不适合直接进入 React Native 同构阶段，主要原因如下：

- 大量业务逻辑直接依赖浏览器 API。
- 当前交互与布局大量基于 DOM、CSS 和 Web 事件模型。
- `localStorage`、`indexedDB`、`serviceWorker`、`window.open` 等能力均是 Web 宿主假设的一部分。
- 若直接做 RN，同构成本和验证成本都会明显高于壳化方案。

因此，Capacitor 更符合当前阶段“尽量少改前端代码”的目标。

***

## 5. 产品范围

### 5.1 本期范围

本期目标是完成 Android App 的最小可用版本（MVP），包括：

- Android App 容器工程建立
- 现有 Web UI 在 App 内加载运行
- API / WebSocket 接入
- 登录能力可用
- 项目列表与文件浏览可用
- 会话列表与会话详情可用
- 会话实时流式更新可用
- 基础移动端适配在真机上可用

### 5.2 非本期范围

以下内容不纳入当前阶段交付范围：

- 双端统一基础组件体系改造
- 全量原生能力接入
- 推送通知
- 生物识别
- 相机 / 相册 / 文件系统深度能力
- 全量缓存体系迁移到原生实现
- iOS App 同步交付

### 5.3 连接模型 / 部署模型

本期必须先明确 App 与 MindFS 服务端之间的连接模型，否则“endpoint 配置化”无法真正落地。

**本期建议收敛为单一模型：App 连接用户显式配置的远端或局域网 MindFS 服务。**

即：

- App 内页面运行在 Capacitor WebView 容器中。
- 页面 origin 视为容器本地 origin，不再等同于真实后端地址。
- MindFS 后端仍运行在独立的 `http(s)://host:port` 上。
- App 首次启动或进入登录前，需要有明确的服务地址配置入口。

本期先不支持：

- 自动发现局域网服务
- App 内置 / 捆绑本地 MindFS server
- 自签证书自动信任
- 无配置前提下自动从页面 origin 推断后端地址

**配置基线建议如下：**

- API base URL：由用户配置的服务地址显式给出
- WS base URL：优先显式配置；若未单独配置，可由 API base URL 通过协议映射派生
- 默认值：可提供一个开发/内测默认地址，但不能依赖页面 origin 自动推导
- 配置错误恢复：用户应能重新编辑服务地址，并提供基础连通性验证或错误提示

### 5.4 认证与存储基线

本期需要明确 App 宿主下的认证模型，避免继续隐含“浏览器同源 + cookie session”前提。

**MVP 认证基线建议：**

- 优先使用 token 模式完成登录态保持与接口鉴权
- HTTP 请求与 WebSocket 鉴权都应兼容 token 传递
- 本期不将 cookie 同源 session 作为 App 成功运行的前提

**存储基线建议：**

- MVP 阶段允许继续使用 `localStorage` 保存 token 和轻量配置
- 但仅将其视为可跑通 MVP 的过渡方案
- 若未来面向外部发布或上架，token 存储应升级为 Capacitor Preferences 或 secure storage 方案，并作为发布前检查项

***

## 6. Runtime 能力矩阵

为避免浏览器假设散落在各组件中，需明确 Web 与 App 两种宿主下的能力差异。

| 能力                                   | 浏览器 Web                       | Capacitor App（本期基线）                         |
| ------------------------------------ | ----------------------------- | ------------------------------------------- |
| API 地址解析                             | 可依赖页面同源或代理                    | 必须显式配置 API base URL                         |
| WebSocket 地址解析                       | 可由页面 host 推导                  | 必须显式配置或由 API base URL 派生                    |
| service worker                       | 开启                            | 关闭                                          |
| PWA 安装引导                             | 开启                            | 关闭                                          |
| `beforeinstallprompt` / display-mode | 有意义                           | 不作为 App 能力依据                                |
| 外链打开                                 | `window.open` / 浏览器新窗口        | 统一走平台导航层，优先系统浏览器 / Browser plugin           |
| 站内导航                                 | 浏览器路由                         | 仍走 SPA 路由，但需补充返回键语义                         |
| 登录态存储                                | `localStorage` / cookie 均可能存在 | MVP 使用 token + `localStorage`，不依赖 cookie 同源 |
| 返回键                                  | 浏览器默认行为                       | 由 App 宿主补充处理                                |
| 键盘 / viewport                        | 浏览器事件模型                       | 真机重点验证 `visualViewport` 与布局行为               |

***

## 7. 改造需求清单

### 7.1 P0：必须完成

#### P0-1：API / WS endpoint 配置化

**目标**

让 Web 前端在浏览器与 Capacitor App 两种宿主下，能够使用不同的后端地址策略，而不是默认依赖当前页面 host。

**原因**

当前前端的 HTTP 与 WebSocket 请求，默认采用“与页面同 origin”的寻址方式：

- 多数 API 请求通过相对路径 `/api/...` 发起，浏览器会自动将其解析为“当前页面的 scheme + host + port + 路径”。
- `web/src/services/base.ts` 中的 `wsURL()` 直接读取 `window.location.protocol` 与 `window.location.host` 拼接 WebSocket 地址。
- 项目中存在大量 `fetch(appPath("/api/..."))`、`fetch(appURL("/api/..."))`，以及少量直接写死的 `fetch("/api/...")` 调用，它们本质上都依赖“页面与后端同源”这一前提。

这意味着当前实现默认认为：**打开页面的那个地址，就是 API 服务地址，也是 WebSocket 服务地址。**

这一模型在当前浏览器部署中成立：

- 开发环境下，Vite 通过 proxy 将 `/api` 与 `/ws` 代理到本地 MindFS 服务。
- 生产环境下，MindFS 通常直接以同一个地址同时提供页面资源与后端接口。

但在 App 壳中，页面 origin 会变为 `capacitor://localhost` 或容器本地地址，而真实后端仍运行在独立的 `http(s)://host:port` 上。此时：

- `fetch("/api/...")` 会请求容器自身 origin，而不是 MindFS 后端。
- 基于 `window.location.host` 拼出的 WebSocket 地址也会指向错误位置。

因此必须将 API 与 WebSocket 地址改为**显式配置**，而不是继续从当前页面地址推导。

**建议改造方向**

- 保留 `appPath()` 这类路径拼接能力，但仅负责 path，不再隐含 host。
- 新增统一的 `getApiBaseURL()` / `getWsBaseURL()`。
- HTTP 请求统一拼接到显式配置的 API base URL。
- WebSocket 地址由显式配置或由 API base URL 派生，不再依赖 `window.location.host`。
- 清理所有裸写的 `fetch("/api/...")` 调用，统一收口到公共 URL 构造层。
- App 侧需同时处理网络策略与跨源访问问题，包括 Android 明文 HTTP 限制（如适用）与后端 CORS 放行。

**涉及文件**

- `web/src/services/base.ts`
- `web/src/services/connection.ts`
- `web/src/services/session.ts`

***

#### P0-2：WebSocket 连接改造

**目标**

确保会话流式链路在 Android App 中可以正常建立、断线重连并在宿主状态切换后恢复。

**原因**

当前会话系统依赖 WebSocket，是核心使用链路。若 WebSocket 地址推导或生命周期恢复不正确，App 的核心价值会失效。且 App/WebView 的前后台切换、锁屏恢复、网络切换与浏览器 tab 生命周期并不完全等价，不能直接假设现有浏览器事件模型在 App 中完全成立。

**验收基线**

- 首次进入会话页时可以成功建立 WebSocket 连接
- App 前后台切换后，会话流式链路可以恢复
- 锁屏 / 解锁后，连接可在可接受时间内自动恢复
- Wi-Fi 与移动网络切换后，连接可自动重连
- 断线恢复后不出现 pending message 重复提交或明显丢失

**涉及文件**

- `web/src/services/connection.ts`
- `web/src/services/session.ts`

***

#### P0-3：禁用 App 内 service worker 注册

**目标**

在 Capacitor 环境中不注册 service worker。

**原因**

service worker 主要面向浏览器/PWA 的缓存与离线场景，在 App 壳内价值有限，且可能带来缓存更新和资源版本问题。

**涉及文件**

- `web/src/registerServiceWorker.ts`
- `web/src/main.tsx`

***

#### P0-4：禁用 App 内 PWA 安装逻辑

**目标**

在 App 中不展示“安装应用”“添加到主屏幕”等提示与按钮。

**原因**

用户已经处于 App 容器中，继续出现 PWA 安装引导会造成认知冲突，也会带来不必要的事件监听和状态逻辑。

**涉及文件**

- `web/src/components/FileTree.tsx`

***

### 7.2 P1：建议在 MVP 过程中完成

#### P1-1：启动流程整理

**目标**

统一 Web 与 App 的初始化流程，明确 runtime 检测、配置读取、SW 注册等启动顺序。

**涉及文件**

- `web/src/main.tsx`

***

#### P1-2：外链与导航行为适配

**目标**

统一处理站内导航、鉴权跳转、外链打开、页面 replace 等行为。

**原因**

浏览器和 WebView 对新窗口、外链打开方式的支持不同，需抽象出统一平台导航层。特别是依赖浏览器 popup 语义的预开窗模式，在 App 中不应继续作为稳定机制依赖。

**建议收口职责**

- internal navigate：站内 SPA 路由跳转
- replace：替代 `window.location.replace` 的统一入口
- auth redirect：登录态失效或鉴权跳转统一处理
- open external：统一走系统浏览器或 Browser plugin

**涉及文件**

- `web/src/App.tsx`
- `web/src/components/FileTree.tsx`

***

#### P1-3：登录 token 存储抽象

**目标**

将 token 存储从直接 `localStorage` 调用收敛为统一接口。

**原因**

首期可继续沿用 Web 存储，但后续应具备平滑迁移到 Capacitor Preferences 或安全存储的能力。

**涉及文件**

- `web/src/components/Login.tsx`
- 可新增 `web/src/services/storage.ts`

***

### 7.3 P2：可延后优化

#### P2-1：键盘 / viewport 真机适配优化

**目标**

确保 Android 真机上输入框、底部栏、抽屉和软键盘交互稳定。

**涉及文件**

- `web/src/layout/AppShell.tsx`
- `web/src/components/BottomSheet.tsx`
- `web/src/components/ActionBar.tsx`

***

#### P2-2：缓存策略梳理

**目标**

区分哪些缓存必须保留，哪些缓存可丢失，哪些缓存未来需要迁到原生侧。

**涉及文件**

- `web/src/services/file.ts`
- `web/src/services/session.ts`
- `web/src/components/Login.tsx`

***

## 8. 关键文件与改造点

| 文件                                   | 当前问题/特点                                      | 改造方向                     |
| ------------------------------------ | -------------------------------------------- | ------------------------ |
| `web/src/services/base.ts`           | 依赖 `window.location` 推导 URL                  | 抽 runtime 与 endpoint 配置层 |
| `web/src/services/connection.ts`     | WebSocket 地址依赖当前 host                        | 统一改为配置化 WS 地址            |
| `web/src/services/session.ts`        | 会话链路依赖浏览器宿主假设                                | 对齐新的 WS 策略，重点验证恢复逻辑      |
| `web/src/registerServiceWorker.ts`   | 默认注册 SW                                      | App 场景禁用                 |
| `web/src/components/FileTree.tsx`    | 含大量 PWA 安装逻辑                                 | App 场景隐藏/禁用              |
| `web/src/App.tsx`                    | 存在 `window.open`、location replace、history 逻辑 | 抽导航适配层                   |
| `web/src/components/Login.tsx`       | 直接读写 `localStorage` 保存 token                 | 抽统一存储接口                  |
| `web/src/layout/AppShell.tsx`        | 依赖 `visualViewport` 和 resize 逻辑              | 真机验证并按需修补                |
| `web/src/components/BottomSheet.tsx` | 直接基于 `window.innerWidth` 等能力适配移动端            | 真机验证交互稳定性                |
| `web/src/components/ActionBar.tsx`   | 交互密集，含拖拽、触摸、resize                           | 真机重点测试                   |

### 8.1 建议新增的适配层文件

### 8.2 建议新增的容器工程目录

- `android/`
  - 独立存放 Android 原生工程与 Capacitor 配置（`capacitor.config.ts/json`）
  - 当前 `webDir` 直接指向 `android/app/src/main/assets/public`，该目录作为 App 加载入口
- `web/package.json` 提供 `npm run build:android`，用于将 Android 壳版静态资源直接构建到该目录
  - 网络策略、返回键、原生插件接入均在该目录下演进

为了避免平台判断散落在各个组件中，建议新增以下适配层：

- `web/src/services/runtime.ts`
  - 判断是否为 Capacitor 宿主
  - 读取运行时配置
  - 决定是否启用 SW / PWA
- `web/src/services/platformNavigation.ts`
  - 统一处理外链、新窗口、replace、内部导航
- `web/src/services/storage.ts`
  - 统一处理 token 和关键设置项存储

***

## 9. 分阶段实施规划

### Phase 1：最小可用壳化（MVP）

**目标**

在 Android 上跑通一套最小可用的 MindFS App。

**产出**

- Capacitor Android 容器工程（建议位于仓库根目录下的 `android/`，与 `web/` 同级）
- App 当前从 `android/app/src/main/assets/public` 加载 Web 产物
- `web` 可分别执行 `npm run build` 产出浏览器版资源，以及执行 `npm run build:android` 直接产出 Android 壳版资源
- API / WS 可正常连接
- 登录、会话、文件浏览可用
- App 内禁用 SW 与 PWA 安装引导

**Capacitor / Android 容器侧工作项**

- 初始化 Capacitor Android 工程，并采用与 `web/` 同级的 `android/` 目录布局；当前 `webDir` 指向 `android/app/src/main/assets/public`
- `web/package.json` 已提供 `build:android` 脚本，用于直接生成 Android 壳版资源并写入 `android/app/src/main/assets/public`
- 梳理 Android 网络访问策略，包括 cleartext traffic 与 network security config
- 确定首期是否引入 Browser、App、Keyboard 等 Capacitor 插件
- 建立基础调试链路，包括真机查看 WebView console、网络请求与容器日志
- 明确本地开发、构建、`sync`、真机运行的最小流程
- 明确目录约定：`android/` 与 `web/` 同级，避免把 Android 工程嵌入 `web/` 子目录

***

### Phase 2：App 场景体验修补

**目标**

解决 WebView 宿主下与浏览器体验差异较大的问题。

**产出**

- Android 返回键处理
- 外链改系统浏览器打开
- 键盘与底部区域布局优化
- 启动流程整理
- token 存储抽象

***

### Phase 3：原生能力增强

**目标**

在 MVP 稳定后，逐步补足更强的 App 能力。

**产出**

- Preferences / secure storage
- Browser / App / Keyboard 等 Capacitor 插件能力
- 下载、分享、通知等原生增强能力

***

## 10. 风险与依赖

### 10.1 同源假设失效

当前 Web 实现并不是抽象意义上的“可能同源”，而是代码层面真实采用了同源寻址：API 大量通过相对路径 `/api/...` 发起，WebSocket 则由 `window.location.protocol` 与 `window.location.host` 直接拼接生成。因此壳化后只要页面 origin 变成 `capacitor://localhost` 或容器本地地址，请求目标就会随之偏离真实 MindFS 后端。

这意味着 endpoint 配置化不是优化项，而是 App 壳化能否工作的前置条件。除前端改造外，还需要同时考虑：

- Android 是否允许访问目标 HTTP 服务（若使用明文 HTTP）
- 后端是否允许来自 App 宿主 origin 的跨源请求（CORS）
- 认证方案是否仍依赖 cookie / 同源 session
- WebSocket 在跨源条件下是否可携带并恢复登录态

### 10.2 WebView 与浏览器行为差异

以下能力在 App 内部与浏览器表现可能不同：

- `window.open`
- `window.location.replace`
- `serviceWorker`
- `beforeinstallprompt`
- `display-mode`
- `visualViewport`
- 返回键行为

### 10.3 软键盘与视口问题

Android WebView 常见问题包括：

- 输入框被软键盘遮挡
- 固定底栏错位
- 抽屉/弹层与键盘交互异常
- 高度计算抖动

### 10.4 WebSocket 稳定性

需重点关注以下场景：

- App 切后台后恢复
- 网络切换后自动重连
- 长连接中断后的状态恢复

### 10.5 存储策略演进

首期继续沿用 Web 存储问题不大，但需要提前预留抽象层，避免未来升级为原生存储时改造成本过高。

### 10.6 返回键与宿主交互语义

Android 返回键即使不在首期做完整增强，也必须纳入 MVP 真机验证范围。至少需要明确：

- 根页面按返回键时的行为
- 弹层、抽屉或底部面板打开时是否优先关闭当前 UI
- 登录页、详情页、会话页的返回层级是否符合用户预期
- 会话进行中按返回键时是否会导致状态丢失或中断

***

## 11. 验收标准

### 11.1 功能验收

- Android App 可以正常启动并加载 MindFS Web UI
- 用户可以在 App 中完成登录
- 用户可以浏览项目列表和文件树
- 用户可以查看会话列表与会话内容
- 会话流式输出可正常显示
- WebSocket 断开后可恢复

### 11.2 体验验收

- App 中不再出现“安装应用”“添加到主屏幕”等 PWA 引导
- 主要移动端页面在真机上可正常操作
- 输入框与底部操作区在软键盘弹起时不出现严重遮挡或错位
- 外链行为符合 App 使用预期
- Android 返回键行为经过真机验证，不出现明显违背用户预期的跳转

### 11.3 工程验收

- 目录结构采用 `web/` 与 `android/` 同级布局，不将 Android 容器工程嵌入 `web/` 子目录
- 关键改造集中在运行时适配层，不引入大规模页面重写
- Web 版本仍可正常运行
- 文档中列出的 P0 项全部具备明确落地路径
- repo 中不再保留裸写 `fetch("/api/...")` 作为 App 主路径依赖
- repo 中不再保留通过 `window.location.host` 或 `window.location.protocol` 直接推导 WebSocket 地址的主路径实现
- App runtime 下不会注册 service worker
- App runtime 下不会展示或监听 PWA 安装相关 UI / 事件
- Android 打包资产入口页不再保留 manifest 与 Apple/PWA meta 标签
- 外链、新窗口、replace 等行为已有统一收口入口
- App 连接模型、认证模型、容器侧网络策略已有明确说明

### 11.4 真机稳定性验收

- 前后台切换后，会话流式链路可恢复
- 锁屏 / 解锁后，连接状态可恢复
- Wi-Fi 与移动网络切换后，WebSocket 可自动重连
- 登录态、会话状态与待发送消息在恢复过程中不出现明显错乱

***

## 12. 结论

对于当前 MindFS 仓库而言，**Capacitor 壳化是实现 Android App 的最优短期路径**。该方案能最大程度复用现有 Web UI，并把改造重点控制在 endpoint、WebSocket、PWA/SW、导航与存储等运行时适配层。

该路线既能满足”尽量少改前端代码”的要求，也能为后续原生能力增强保留空间。当前推荐先完成 MVP 壳化，再根据真实使用反馈决定是否继续向更深层的 App 化能力演进。

***

## 13. 实现现状（代码层已验证）

### 13.1 目录结构（已完成）

```
mindfs/
├── web/          # React + Vite 前端工程，产出浏览器版与 Android 壳版静态资源
└── android/      # Android 原生工程，Capacitor 配置，Web 静态资源加载入口
```

- `web/` 与 `android/` 同级，边界清晰
- `android/capacitor.config.ts` 中 `webDir` 指向 `app/src/main/assets/public`
- `androidScheme` 设置为 `https`

### 13.2 构建链路（已完成）

| 命令 | 产出 | 说明 |
|------|------|------|
| `npm --prefix web run build` | `web/dist/` | 浏览器版，含 SW、PWA meta、manifest |
| `npm --prefix web run build:android` | `android/app/src/main/assets/public/` | Android 壳版，去除 SW、PWA meta，清空目标目录后重建 |

`build:android` 通过 `rimraf` 清空目标目录后重建，避免历史残留文件（旧 `service-worker.js`、`cordova.js` 等）污染构建结果。

### 13.3 已完成的核心改造

**新增适配层文件：**

| 文件 | 说明 |
|------|------|
| `web/src/services/runtime.ts` | 宿主检测，`isCapacitorRuntime()`，`getApiBaseURL()`，`getWsBaseURL()`，SW/PWA 开关 |
| `web/src/services/storage.ts` | token 与服务地址统一存储接口（基于 localStorage，预留原生存储迁移边界） |
| `web/src/services/platformNavigation.ts` | 外链统一走 `@capacitor/browser`，replace 收口 |

**改造要点：**

- `web/src/services/base.ts`：`appURL()` 和 `wsURL()` 统一通过 `getApiBaseURL()` / `getWsBaseURL()` 解析，不再依赖页面 origin
- `web/src/services/connection.ts`：WebSocket 地址由显式 baseUrl 传入，不读 `window.location`
- `web/src/services/session.ts`：WebSocket 断线重连、前后台恢复（`visibilitychange`）、网络切换恢复（`window online`）、pending message 重发均已实现
- `web/src/registerServiceWorker.ts`：`shouldRegisterServiceWorker()` 守卫，Capacitor 宿主不注册 SW
- `web/src/components/FileTree.tsx`：`shouldEnablePWAInstall()` 守卫，Capacitor 宿主不展示 PWA 安装引导，不监听 `beforeinstallprompt`
- `web/src/main.tsx`：Capacitor 宿主下加载 `@capacitor/app` 插件监听 `backButton`，有历史可回退则回退，否则 `minimizeApp()`
- `web/index.html`：使用 `<!--APP_SHELL_PWA_LINKS-->` 占位，`build:android` 时自动移除 manifest / Apple / PWA meta 标签
- `web/src/components/Login.tsx`：服务地址配置入口，`handleCheckEndpoint` 基础连通性验证

**Android 工程配置：**

- `AndroidManifest.xml`：`INTERNET` 权限，`usesCleartextTraffic=”true”`，`networkSecurityConfig` 引用，`windowSoftInputMode=”adjustResize”`（确保软键盘弹出时视口正确收缩，配合 `visualViewport` API 精确感知键盘高度）
- `network_security_config.xml`：`<base-config cleartextTrafficPermitted=”true” />`，支持局域网 HTTP 服务连接

**软键盘与 Viewport 适配改造（P2-1）：**

- `AndroidManifest.xml`：Activity 新增 `android:windowSoftInputMode=”adjustResize”`，确保 Android WebView 在软键盘弹出时通过 `visualViewport` 正确上报可见区域高度
- `web/src/layout/AppShell.tsx`：
  - `useResponsive` 改为优先读取 `visualViewport.width` 检测移动端，同时注册 `visualViewport resize` 事件
  - `getVisibleViewportRect()` 新增返回 `visibleHeight`（即 `visualViewport.height`）
  - mobile 模式下 AppShell 的 `height` / `minHeight` 改为由 `visibleHeight`（px 值）动态驱动，而非静态 `100%`；确保键盘弹起时 shell 整体高度随视口收缩，底部 ActionBar 不被键盘遮挡
- `web/src/components/BottomSheet.tsx`：
  - `isMobile` / `isDark` 初始状态改为安全初始化（兼容 SSR/无 window 环境）
  - `isDark` 改为响应式 `useEffect` 监听 `prefers-color-scheme` 变化，不再在初始化时静态读取
  - mobile 模式下 BottomSheet 添加 `paddingBottom: “env(safe-area-inset-bottom, 0px)”`，避免内容被底部安全区（Home Indicator）遮挡

### 13.4 代码层静态扫描结果

| 检查项 | 结果 |
|--------|------|
| 裸写 `fetch(“/api/...”)` | ✅ 无 |
| `window.location.host` / `window.location.protocol` 推导 WS 地址 | ✅ 无（仅 runtime.ts 中用于宿主检测，不是 WS 推导） |
| App runtime 注册 SW | ✅ 已通过 `shouldRegisterServiceWorker()` 守卫 |
| App runtime 展示/监听 PWA 安装 | ✅ 已通过 `shouldEnablePWAInstall()` 守卫 |
| Android 壳版入口页含 manifest/PWA meta | ✅ 无 |
| Android 壳版含 `service-worker.js` | ✅ 无 |
| TypeScript 类型检查 | ✅ `npm run typecheck` 通过，无错误 |

### 13.5 外部环境阻塞项（已解除）

原阻塞项均已解除：

| 项目 | 结果 |
|--------|------|
| Android 构建验证（`gradlew assembleDebug`） | ✅ 已构建成功（修复 Java 21→17 兼容，见 §13.8） |
| 真机安装（adb connect 10.76.222.94:41917） | ✅ `adb install` 成功 |
| App 启动 | ✅ App 在小米 Android 16 真机上正常启动，Capacitor 运行正常 |
| 功能验收（登录、浏览、会话） | ⏳ 需要运行中的 MindFS 服务 |
| WebSocket 连接与恢复验证 | ⏳ 需要运行中的 MindFS 服务 |
| 软键盘 / 返回键 / 体验验证 | ⏳ 可在真机上手动验证 |

### 13.6 已验证范围

- 代码层：全部 P0 改造项已完成，包括 endpoint 配置化、WS 地址解耦、SW/PWA 禁用、导航层抽象、存储接口抽象、返回键处理策略
- 代码层：P2-1 软键盘/viewport 适配已完成代码改造（`AppShell`、`BottomSheet`、`AndroidManifest` 三处已修补，详见 §13.3）
- 构建层：`npm run build` 与 `npm run build:android` 均可成功执行，产物符合预期
- 静态扫描：无裸写相对路径 API 请求，无基于 `window.location` 推导的 WS 地址
- 类型检查：`npm run typecheck` 无错误
- **Android APK 构建**：`gradlew assembleDebug` BUILD SUCCESSFUL（已修复 Java 版本兼容问题）
- **真机安装与启动**：App 成功安装并在 Xiaomi Android 16 真机（API 36）上正常启动

### 13.7 未验证范围

- 登录、项目浏览、会话、WebSocket 等功能验收（需要运行中的 MindFS 服务）
- 软键盘 / viewport 交互稳定性（代码层已改造，需手动真机验证最终效果）
- Android 返回键行为在不同页面栈下的实际表现（代码层策略已实现，需手动真机确认符合预期）

### 13.8 构建问题修复说明

`@capacitor/android@8.x` 的 `build.gradle` 中硬编码 `JavaVersion.VERSION_21`，而宿主环境只有 Java 17。

修复方式：在 `android/build.gradle` 的 `allprojects` 块中加入 `afterEvaluate`，强制覆盖所有子模块的 `compileOptions`：

```groovy
allprojects {
    afterEvaluate { project ->
        if (project.hasProperty('android')) {
            project.android {
                compileOptions {
                    sourceCompatibility JavaVersion.VERSION_17
                    targetCompatibility JavaVersion.VERSION_17
                }
            }
        }
    }
}
```

构建时需设置环境变量：`JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64`
