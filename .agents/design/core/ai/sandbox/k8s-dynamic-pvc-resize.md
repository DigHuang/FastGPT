# Agent Sandbox Kubernetes 动态 PVC 扩容设计方案

状态：已实施（单测、Cargo test/clippy、TypeScript 增量编译与 ESLint 均通过）

关联文档：

- [Agent Sandbox 设计方案](./index.md)

## 1. 背景与目标

Kubernetes 运行时下，Agent Sandbox 持久卷统一挂载于 `$HOME`（`/home/sandbox`）。此前新建 PVC 时直接按实例配置 `subservice.agentSandbox.common.storageSizeGi` 一次性分配满额容量（如 10Gi），在大量会话并发但多数会话仅占用几十 MiB 的场景下会显著浪费集群存储配额。

本方案在 **仅 Kubernetes 运行时**、且管理员主动开启开关 `subservice.agentSandbox.opensandbox.enableDynamicPvcResize`（默认 `false`）的前提下，提供按需小盘建卷与写前在线自动扩容，并配套管理后台一键端到端实测按钮：

1. **按需建卷与阶梯扩容（FastGPT 侧单一策略源）**：
   - 新建 PVC 默认初始容量为 **`0.5Gi`（`512Mi`）**（不超过 `storageSizeGi`）；
   - 每次按 **`0.5Gi`（`512Mi`）** 的整数倍向上扩容，上限严格封顶为实例配置的 `storageSizeGi`（`storageSizeGiToMiB(storageSizeGi)` Mi）；
   - `volume-manager` 保持薄驱动层定位，只执行主站传入的精确 `claimName` + `storageSize` 幂等创建/扩容/查询/删除，不维护独立业务策略。
2. **写前触发与 O(1) 实时文件系统探测**：
   - 仅覆盖主站写入入口（`sandbox_write_file`、`sandbox_edit_file`、`sandbox_shell`、文件上传 `upload`、压缩包解压 `extractZip`、附件注入 `writeUrlFilesToSandbox`）及冷归档恢复建卷（`archive.ts`）；这一期不覆盖浏览器直连 IDE/终端写盘，也不新增定时巡检任务；
   - 触发条件：文件系统使用率 **`≥ 80%`** 且非特权用户真实可用空间 **`< 200 MiB`**；若调用方已知待写入字节数 `incomingBytes`（如带 `Content-Length` 上传、已知 buffer 大小的文件写入、附件注入），且 `availableBytes - incomingBytes < 200 MiB`，直接按 `512Mi` 向上对齐一步扩到位；
   - 扩容触发后同步短等待（默认最长 `10s`）直到容器内 `statvfs` 观察到文件系统总容量增大；若扩容失败或等待超时，记录告警并进入有界短冷却（`30s`）后 **fail-open** 放行，不阻塞正常业务（真满时由底层 `ENOSPC` 兜底）。
3. **管理后台一键端到端实测按钮**：
   - 位于系统配置 Agent Sandbox 页（仅 `runtime === 'kubernetes'` 展示），与独立布尔开关 `enableDynamicPvcResize` 并列（开关可自由切换，测试按钮辅助验证）；
   - 后端使用当前表单草稿（或已保存凭据）通过隔离的 OpenSandbox 连接与轻量临时 Pod 真实执行完整生命周期探测：`512Mi` 建卷 → 临时 Pod 绑定 → 校验初始实际分配容量未被隐式大幅拉大（`> 900MiB` 判定 `min_size_too_large`）→ 在线扩容 `512Mi → 1024Mi`（依据权威信号识别 `rbac_denied`、`expansion_not_allowed`、`offline_resize_only`、`resize_timeout` 与泛化 `failed`）→ `finally` 带短超时强制删除临时 Pod 与 PVC 并关闭隔离连接。

---

## 2. 权威数据源与核心不变量

- **容量上限与开关真相源**：系统实例配置快照 `subservice.agentSandbox`（其中 `opensandbox.enableDynamicPvcResize` 为 `applyMode: 'live'` 热生效，`common.storageSizeGi` 与 `opensandbox.runtime` 为 `applyMode: 'restart'`）。
- **单实例 PVC 声明容量真相源**：Kubernetes PVC 对象 `spec.resources.requests.storage`，`volume-manager` 在 `PATCH /v1/volumes/:claimName/resize` 执行前读取当前 PVC 请求容量：
  - 若 `currentRequestBytes >= targetBytes`，幂等返回 `resized: false`（既禁止缩容，也天然防多副本并发重复扩容）；
  - 仅操作携带 FastGPT `volume-manager` 所有权标签的活跃 PVC，拒绝未托管或 `Terminating` 状态 PVC。
- **容器运行期可用空间真相源**：`fastgpt-ide-agent` 对 `$HOME` 调用 `libc::statvfs` 返回的 `{ totalBytes, availableBytes, usedBytes }`（O(1) 实时系统调用，不扫目录树、无 15s 缓存延迟）。
- **Docker 行为零回归**：`runtime === 'docker'` 继续走原有目录扫描 + 15s 缓存 + `FASTGPT_DISK_SOFT_LIMIT_BYTES` 软限制，不受任何影响。

---

## 3. 分模块详细设计

### 3.1 `fastgpt-ide-agent`（O(1) `statvfs` 探针与归档错误源透传）

- [disk.rs](../../../../../projects/fastgpt-ide-agent/src/disk.rs)：
  - `GET /disk-usage` 响应新增可选字段 `filesystem?: { totalBytes, availableBytes, usedBytes }`（Unix 下经 `libc::statvfs` 获取）；
  - 新增查询参数 `scope=filesystem`：仅执行 `libc::statvfs(get_home_root())`，完全跳过目录递归遍历与 15s 缓存，直接返回实时 `{ usedBytes, limitBytes, filesystem }`；
  - 缺省 `scope` 保持原有目录扫描 + 缓存语义（`filesystem: None`），对既有 Docker 调用方与单测完全向后兼容。
- [archive.rs](../../../../../projects/fastgpt-ide-agent/src/archive.rs)：
  - `extract_from_body` 错误格式化遍历完整 `std::error::Error::source()` 链，确保 `tar 0.4.46` 包装的内层 `io::Error`（如 `No space left on device (os error 28)`）完整透传到日志与 HTTP 500 响应体，使主站冷归档恢复 `ENOSPC` 自动扩容重试可靠触发。

### 3.2 共享卷契约与 `volume-manager`

- [volume.ts](../../../../../packages/global/core/ai/sandbox/volume.ts)：
  - 新增 `SandboxVolumePvcConditionSchema`、`SandboxVolumeResizeRequestSchema`、`SandboxVolumeResizeResponseSchema`；
  - 扩展 `SandboxVolumeInspectResponseSchema`，可选携带以字节为单位的 `requestedBytes`、`capacityBytes` 与 `conditions`（向后兼容旧客户端，隔离 K8s quantity 单位语法）。
- [IVolumeDriver.ts](../../../../../projects/volume-manager/src/drivers/IVolumeDriver.ts)、[K8sVolumeDriver.ts](../../../../../projects/volume-manager/src/drivers/K8sVolumeDriver.ts)、[DockerVolumeDriver.ts](../../../../../projects/volume-manager/src/drivers/DockerVolumeDriver.ts)、[volumes.ts](../../../../../projects/volume-manager/src/routes/volumes.ts)：
  - `IVolumeDriver` 收敛为 `inspect`（移除旧 `exists`）；`GET /v1/volumes/:claimName` 返回 `inspect` 结果（K8s 下在驱动内解析 `spec.resources.requests.storage` / `status.capacity.storage` 为 `requestedBytes` / `capacityBytes`，并附带 `status.conditions`）；
  - 新增 `PATCH /v1/volumes/:claimName/resize`：
    - K8s：在 `K8sVolumeDriver` 内部通过私有 `parseK8sStorageBytes`（支持二进制/十进制后缀与 `DecimalExponent` 科学计数如 `1e9`、`5e8`）校验合法性与单调递增，当前已满足时幂等返回 `resized: false`；通过 `application/merge-patch+json` 携带 `metadata.resourceVersion` 乐观锁 PATCH `spec.resources.requests.storage`，遭遇并发 `409 Conflict` 时重读 PVC 并在有界重试中按单调递增短路或重发，防止 K8s 1.27+ `RecoverVolumeExpansionFailure` 场景下并发较小请求静默回退更大目标；保留 K8s 返回的 `400` / `403` / `404` / `409` / `422` 状态码与错误文本供测试按钮精准分类；
    - Docker：返回 `400` 明确提示不支持 PVC 扩容。
  - 更新 [volume-manager/README.md](../../../../../projects/volume-manager/README.md) 的接口说明（含 `GET /:claimName` 与 `PATCH /:claimName/resize`）及 RBAC 最小权限（增加 `patch`）；**不改动 `deploy/*.yml`**。

### 3.3 FastGPT 主站配置、容量规划与写前自动扩容

- **配置注册**：
  - [subservice.ts](../../../../../packages/global/common/system/config/schemas/subservice.ts)：`opensandbox.enableDynamicPvcResize: z.boolean().default(false)`；
  - [pageFields.ts](../../../../../packages/global/common/system/config/pageFields.ts) 与 [registry.ts](../../../../../packages/global/common/system/config/registry.ts)（`applyMode: 'live'`）。
- **常量与容量规划/扩容模块**：
  - [constants.ts](../../../../../packages/global/core/ai/sandbox/constants.ts)：新增 `storageSizeGiToMiB()`（与 `storageSizeGiToBytes()` 并列）；
  - [constants.ts](../../../../../packages/service/core/ai/sandbox/constants.ts)：定义初始 `512Mi`、步长 `512Mi`、使用率阈值 `0.8`、最小剩余 `200MiB`、常规写前短等待 `10s`（轮询 `300ms`）、阻塞型等待 `90s`（轮询 `1s`，覆盖 kubelet 默认 60s 卷同步周期，用于 `incomingBytes > availableBytes` 与冷归档 `ENOSPC` 重试）、失败冷却 `30s`；
  - [pvcResize/plan.ts](../../../../../packages/service/core/ai/sandbox/application/pvcResize/plan.ts)（无副作用纯规划函数）：`computeArchiveRestoreStorageSize`、`computeTargetPvcResizePlan`、`computeRequiredGrowthBytes`、`isPvcAtMaxCapacity`（对 `incomingBytes` 缺口与冷归档恢复体积计入 ext4 非特权开销余量 ~8%，避免大写入或大恢复因元数据与 root 预留块触发 `ENOSPC`）；
  - [pvcResize/service.ts](../../../../../packages/service/core/ai/sandbox/application/pvcResize/service.ts)（运行期在线扩容编排）：
    - `ensureSandboxPvcCapacity` / `expandSandboxPvcToMaxCapacity`：有界失败冷却表（上限 512 淘汰最旧项）+ `GET /disk-usage?scope=filesystem` 探测 + 依赖 `volume-manager` 幂等 `resizeSessionVolume`：
      - 当 `resized: false` 时核对 PVC 权威 `requestedBytes` / `capacityBytes`：仅在已达 `maxMiB` 且 `capacity >= requested` 时短路返回；若 `capacity >= requested` 但 `requested < maxMiB`（如 `>= 26Gi` 卷因 ext4 静态元数据超 `512Mi` 导致 `statvfs.totalBytes` 低估当前卷大小），以权威 PVC 容量重算严格大于 `requested` 的目标并补发一次 PATCH；
      - `waitForFilesystemExpansion` 兼顾小数 `storageSizeGi` 末步增量 `< 32MiB` 的场景，并对多步扩容 / 已知 `incomingBytes` 等待 `availableBytes >= incomingBytes` 或满足目标增量（受等待超时兜底）；失败或超时 fail-open，可恢复传输错误透传给 `runWithRecovery`，调用方中止不污染冷却表。
- **卷配置与 `OpenSandboxClient` 绑定**：
  - [config.ts](../../../../../packages/service/core/ai/sandbox/config.ts)：导出 `isAgentSandboxDynamicPvcResizeEnabled()` 与 `getInitialSandboxVolumeStorageSize()`；
  - [volume/config.ts](../../../../../packages/service/core/ai/sandbox/infrastructure/volume/config.ts) & [volume/service.ts](../../../../../packages/service/core/ai/sandbox/infrastructure/volume/service.ts)：
    - `getVolumeManagerEnvConfig()` 通过 `getInitialSandboxVolumeStorageSize()` 获取默认初始建卷容量（开启动态扩容时为 `min(512, storageSizeGiToMiB(storageSizeGi))Mi`）；
    - `ensureSessionVolume` / `inspectSessionVolume` / `resizeSessionVolume` / `deleteSessionVolume` 支持自定义 `vmConfig`（`deleteSessionVolume` 显式取消 404 响应体释放连接），`ensureSessionVolume` / `getSessionVolumeConfig` 支持覆盖 `storageSize`。
  - [opensandbox.ts](../../../../../packages/service/core/ai/sandbox/infrastructure/opensandbox/opensandbox.ts)：暴露只读 getter `workspaceClaimName`（直接从 `createConfig.volumes` 提取，零额外查询），并为草稿探测支持 `isolatedConnection: true` 隔离连接池。
- **统一写前入口与冷归档闭环**：
  - [ideAgent.ts](../../../../../packages/service/core/ai/sandbox/application/ideAgent.ts)：`getSandboxDiskUsage` 支持 `scope?: 'filesystem'` 与可选 `maxAttempts`（热路径写前检查默认 `1`，冷启动探测与归档打包传 `5` 应对 1319 端口就绪窗口）并解析可选 `filesystem` 字段；
  - [quota.ts](../../../../../packages/service/core/ai/sandbox/application/quota.ts)：`hasSandboxPreWriteDiskCheck` 统一判断 Docker 软限制或 K8s 动态扩容是否需要写前检查，`prepareSandboxDiskForWrite` 与 `assertSandboxWorkspaceWritable` 接收可选 `incomingBytes`，在 K8s 且开启动态扩容时调用 `ensureSandboxPvcCapacity` 后返回 `{ enabled: false, exceeded: false, ... }`；
  - [toolCall/type.ts](../../../../../packages/service/core/ai/sandbox/application/toolCall/type.ts)、[writeFile.tool.ts](../../../../../packages/service/core/ai/sandbox/application/toolCall/writeFile.tool.ts)、[shell.tool.ts](../../../../../packages/service/core/ai/sandbox/application/toolCall/shell.tool.ts)、[file.ts](../../../../../packages/service/core/ai/sandbox/application/file.ts)（K8s 动态扩容下下载完成后按总字节数单次探测扩容，避免双次探测/连续两次扩容）、[upload.ts](../../../../../projects/app/src/pages/api/core/ai/sandbox/upload.ts)：透传已知 `incomingBytes` 并在写前自动扩容；`extractZip.ts` 保持原写前 `prepareSandboxDiskForWrite` 调用，依赖默认水位阈值触发扩容（不额外估算解压后体积）；
  - [type.ts](../../../../../packages/service/core/ai/sandbox/type.ts) & [archive.ts](../../../../../packages/service/core/ai/sandbox/application/archive.ts)：`SandboxArchiveInfoSchema` 新增可选 `uncompressedBytes`；打包前尽力采集占盘字节数落库（冷恢复天然顺带回收已删空间），恢复建卷时动态计算按 `512Mi` 对齐的目标 PVC 大小（历史归档无该字段时按压缩体积 4 倍保守估算，封顶 `storageSizeGi`）；若因极端高压缩比解压遭遇 `ENOSPC` 且尚未达上限，自动在线扩容至 `storageSizeGi` 并等待生效后重试解压一次。

### 3.4 管理后台动态扩容实测 API 与 UI

- **OpenAPI 合约**：[testSandboxPvcResize.ts](../../../../../packages/global/openapi/admin/system/instanceConfig/testSandboxPvcResize.ts)（注册到 [admin/system/index.ts](../../../../../packages/global/openapi/admin/system/index.ts)，仅站内 `DevApiTagsMap.adminSettings`，不声明 `x-fastgpt-sdk`；通过 `requiredAlternatives` 声明草稿凭据 / 已存凭据组合约束保证 DevAPI 请求示例合法；响应提供 7 个权威错误码：`concurrent_test`、`min_size_too_large`、`rbac_denied`、`expansion_not_allowed`、`offline_resize_only`、`resize_timeout`、`failed`）。
- **探测服务**：[pvcResize/probe.ts](../../../../../packages/service/core/ai/sandbox/application/pvcResize/probe.ts)
  - 复用 `LeaseCache`（键 `agent-sandbox:pvc-resize-probe`）防止并发触发多个探测 Pod；
  - 使用 `isolatedConnection: true`、`buildBaseSandboxRuntimeEnv({ runtime: 'kubernetes' })`、轻量规格（`0.5 CPU / 512MiB`）与兜底 `timeoutSeconds: 300`，避免草稿探测污染线上连接池、受旧 Docker/高配额配置影响或在异常中断后永久泄漏探测 Pod；错误诊断经密钥剥离与 `replaceSensitiveText` 脱敏，不透传原始 K8s JSON；
  - 探测流程：`512Mi` 建卷（建卷前即标记需清理，超时不确定态也执行幂等删卷）→ 临时 Pod 挂载 → 测 `initialBytes`（支持瞬时 1319 建连重试，`> 900MiB` 报 `min_size_too_large`）→ 在线扩至 `1024Mi` 轮询验证生效：
    - 错误分类先匹配 `EXPANSION_DISABLED_ERROR_RE`（覆盖 K8s `PersistentVolumeClaimResize` 准入插件返回的 `403 Forbidden`）再将普通 `403` 归为 `rbac_denied`；未绑定 PVC 的 `422` 归入 `failed`；
    - 正常在线 CSI 扩容期会出现短暂 `FileSystemResizePending=True`（标准 kubelet 默认 60s 同步周期才调用 `NodeExpandVolume`），轮询坚持到 `100s` 验证窗口到期后仍处于该条件才判定 `offline_resize_only`，避免云盘/本地 LVM 误判，且中止信号及时透传不吞异常；
    - `finally` 带 15s 超时清理临时 Pod 与 PVC 并关闭隔离连接。
- **API 路由与 UI**：
  - [testSandboxPvcResize.ts](../../../../../projects/app/src/pages/api/admin/system/config/testSandboxPvcResize.ts)：`authSystemAdmin` + `parseApiInput` 入参校验，与 `/api/admin/system/config/probe` 保持一致允许直接复用已存凭据（容错 `strict: false` 读取的非字符串损坏值返回 400）；
  - [SandboxPvcResizeTestBar.tsx](../../../../../projects/app/src/pageComponents/admin/subservice/agent-sandbox/SandboxPvcResizeTestBar.tsx)（挂载于 [agent-sandbox/index.tsx](../../../../../projects/app/src/pageComponents/admin/subservice/agent-sandbox/index.tsx) K8s 区域）：
    - 收敛连接/镜像/前缀 `useWatch`、`volumeNamePrefix` 校验与 `useServerProxy ?? true`（必填项未填完整时禁用并附 Tooltip）；
    - 使用同步 `inFlightRef` 锁、与输入快照解耦的 `isTesting` 状态（防连点及编辑后重复触发服务端 `concurrent_test`）、卸载 `AbortController` 取消与 `240s` 请求超时；
    - 区分「不支持动态扩容」（仅 `min_size_too_large` / `expansion_not_allowed` / `offline_resize_only`，其中 `min_size_too_large` 展示实测分配容量）与「测试失败」（`concurrent_test` / `rbac_denied` / `resize_timeout` / `failed` / 请求异常），5 种语言 `admin.json` 完全对齐。

---

## 4. 实现待办（TODO）

- [x] **Step 1**：升级 `fastgpt-ide-agent` `disk.rs` 增加 `libc::statvfs` 与 `?scope=filesystem` 快速路径，补单测并过 `cargo test` / `cargo clippy`。
- [x] **Step 2**：扩展 `packages/global/core/ai/sandbox/volume.ts` 与 `projects/volume-manager`（`inspect` 详情 + `PATCH /:claimName/resize`，收敛移除旧 `exists`），补齐 `volume-manager` 单测。
- [x] **Step 3**：接入系统配置 `enableDynamicPvcResize`、FastGPT `pvcResize/` 核心引擎、全部写前入口与冷归档恢复闭环。
- [x] **Step 4**：实现管理后台 `testSandboxPvcResize` OpenAPI 合约、单步端到端探测服务、API 路由、独立测试栏组件 `SandboxPvcResizeTestBar.tsx` 及全量 i18n。
- [x] **Step 5**：补齐各层 Vitest 单测并运行 `cargo test`、`cargo clippy`、`volume-manager` test、FastGPT 受影响单测与 `typecheck`。
