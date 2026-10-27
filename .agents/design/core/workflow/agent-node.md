# 工作流 Agent 节点技术方案

## 1. 背景与设计目标

在 FastGPT 中，工作流（Workflow）擅长结构化、确定性路径的流程控制，而智能体（Agent）擅长任务规划、动态工具/技能调用与多轮自适应调整。在实际业务场景中，往往需要在结构化流程的局部引入动态处理环节。

本方案将 Agent Loop 封装为工作流中的标准节点（`FlowNodeTypeEnum.agent`），使其同时具备完整的 Agent Loop 能力与工作流节点特征。

### 1.1 核心能力矩阵

| 维度 | 设计决策与行为约定 |
| --- | --- |
| **节点开放范围** | 仅对**工作流应用**（`appSystemModuleTemplates`）开放，**不加入**工作流工具/插件（`pluginSystemModuleTemplates`），且**不加入** AI 辅助生成工作流白名单 |
| **Agent 核心能力** | 保留多轮 Agent Loop（上限 100 轮）、任务规划（`plan`）、追问（`ask_user`）、技能（Skills + Sandbox 虚拟机）、工具/子应用调用、知识库检索、对话上传文件自动解析及上下文压缩能力 |
| **输入配置项与顺序** | 输入项顺序严格对齐 Figma：`AI 模型` (`aiModel`) -> `提示词` (`aiSystemPrompt`) -> `虚拟机` (`useAgentSandbox`) -> `技能` (`skills`) -> `工具` (`selectedTools`) -> `知识库` (`datasetSelectList`) -> `聊天记录` (`history`) -> `用户问题` (`userChatInput`)；其中 `skills` 与 `selectedTools` **仅支持手动选择（不支持变量引用）**，`datasetSelectList` 支持**手动选择与变量引用**；`标签过滤` (`collectionFilterMatch`) 收敛至知识库「参数」弹窗中配置；**不提供**独立的 `fileUrlList`（文档链接）输入项，不暴露外部 `quoteQA` 端口 |
| **工具调用支持（`isTool: true`）** | 支持被「工具调用」节点通过 `selectedTools` 句柄连接；仅 `aiSystemPrompt`、`history`、`userChatInput`（默认 AI 生成）支持 `agentGenerated`，`useAgentSandbox` 显式设置 `canAgentGenerated: false`；切换 `aiSystemPrompt` 为 AI 生成时清空提示词文本，节点配置的技能、工具、知识库仍生效 |
| **Ask 追问与交互性** | `ask_user` 内置开启（无开关）；`FlowNodeTypeEnum.agent` 纳入 `INTERACTIVE_NODE_TYPES`，自动禁用应用评测并禁止放入 `parallelRun` 并行节点内部 |
| **流输出控制（`aiChatIsResponseText`）** | 关闭流输出（勾选「不返回输出内容」）时，**完全不向对话气泡展示 Agent 节点内容**（正文、思考过程、工具调用卡片、技能调用卡片、Plan 规划卡片与状态），但**不限制 `ask_user` 追问交互**；`answerText` 正常向后游传递，运行详情正常写入 `nodeResponses` |
| **错误捕获（`catchError`）** | Agent Loop 内部调用工具或技能产生的执行错误由 Agent Loop 自行消化处理，不触发节点级错误捕获；模型调用失败等节点级错误触发工作流 `catchError`，且在开启 `catchError` 时不在对话气泡中追加错误文本 |
| **工作流运行检查** | 判定逻辑与 Agent V2（`checkAppForm.ts`）对齐；统一异常提示文案：<br>• 工具异常：`引用的工具存在异常，请处理`<br>• 技能异常：`引用的技能存在异常，请处理`<br>• 知识库异常：`引用的知识库存在异常，请处理`<br>• 虚拟机异常：对齐 Agent V2 的 `checkAppFormSandboxIssues` |
| **导出敏感信息过滤** | 开启过滤时清除 Agent 节点的 `skills`、`selectedTools`、`datasetSelectList`、`datasetParams.datasets`，并剥离 `aiSystemPrompt` 中的 `{{@...@}}` 内联引用标签；同步更新 `common:filter_sensitive_info_tip` 多语言文案 |

---

## 2. 节点模板与全局常量设计（`packages/global`）

### 2.1 节点模板注册与面板可见性

1. **调整模板分组（`packages/global/core/workflow/template/constants.ts`）**
   - 将 `AgentNode` 从隐藏的 `systemNodes` 移至 `appSystemModuleTemplates`（位于 `AiChatModule` 之后），使其仅在工作流应用画布中可见，工作流插件（`pluginSystemModuleTemplates`）中不可见。
2. **解除节点模板面板过滤（`projects/app/src/pageComponents/app/detail/WorkflowComponents/Flow/components/NodeTemplates/list.tsx`）**
   - 移除 `NodeTemplates/list.tsx` 中针对 `FlowNodeTypeEnum.agent` 的硬编码隐藏判断，使左侧节点面板、快捷添加与节点搜索均可检索并添加 Agent 节点。

### 2.2 `AgentNode` 模板与输入输出定义（`packages/global/core/workflow/template/system/agent/index.ts`）

- 设置 `isTool: true`，允许连接到「工具调用」节点。
- 输入项（`inputs`）配置与顺序（对齐 Figma `node-id=3820-7237`）：
  1. `aiModel`：模型选择与基础配置（保留回复上限 `showMaxToken`、多模态识别/提取对话文件 `showMultimodalConfig`、隐藏 AI 输出）及思考配置，隐藏高级 LLM 参数（温度、TopP、停止序列、返回格式）。
  2. `aiSystemPrompt`：`renderTypeList` 设为 `[FlowNodeInputTypeEnum.textarea, FlowNodeInputTypeEnum.reference, FlowNodeInputTypeEnum.agentGenerated]`，补充 `toolDescription`，并在富文本编辑器中输入 `@` 时支持关联并高亮节点已选的技能（`skills`）、工具（`selectedTools`）、知识库（`datasetSelectList`）及自动开启虚拟机。
  3. `useAgentSandbox`：显式标记 `canAgentGenerated: false`，避免在被工具调用连接时被自动注入 `agentGenerated` 渲染类型。
  4. `skills`：`renderTypeList: [FlowNodeInputTypeEnum.selectSkill]`（仅支持手动选择，不支持变量引用）。
  5. `selectedTools`：`renderTypeList: [FlowNodeInputTypeEnum.selectTool]`（仅支持手动选择，不支持变量引用）。
  6. `datasetSelectList`：`renderTypeList: [FlowNodeInputTypeEnum.selectDataset, FlowNodeInputTypeEnum.reference]`（支持「手动选择」与「变量引用」切换），搜索参数及 `collectionFilterMatch`（标签过滤）统一在知识库「参数」弹窗（`DatasetParamsModal`）中配置。
  7. `aiChatIsResponseText`：流输出开关（默认 `true`，在模型设置弹窗中控制）。
  8. `history`：引入 `Input_Template_History`（默认 6 轮，支持 `numberInput`、`reference`、`agentGenerated`）。
  9. `userChatInput`：引入 `Input_Template_UserChatInput`（必填，支持 `reference`、`textarea`、`agentGenerated`）。
- 移除独立的 `Input_Template_File_Link`（`fileUrlList`）；对于独立 Agent 应用，在 `agentForm2AppWorkflow`（`packages/global/core/app/formEdit/utils.ts`）转换时若节点不存在 `fileUrlList` 则自动补齐，保证独立 Agent 应用兼容性。
- 输出项（`outputs`）配置：
  - `answerText`（`string`）：AI 回复内容。
  - `errorText`（`string`，`type: FlowNodeOutputTypeEnum.error`）：错误捕获开启时暴露的错误信息出口。

### 2.3 交互节点类型标记（`packages/global/core/workflow/node/constant.ts`）

将 `FlowNodeTypeEnum.agent` 加入 `INTERACTIVE_NODE_TYPES`：
- 应用评测查询（`getInteractiveAppIdSet`）自动将含 Agent 节点的工作流识别为交互应用（`hasInteractiveNode: true`），禁止创建评测任务；
- 画布容器校验自动阻止将 Agent 节点拖入不支持交互暂停的 `parallelRun` 并行执行节点内。

---

## 3. 前端 `NodeAgent` 组件与交互设计（`projects/app`）

文件：`projects/app/src/pageComponents/app/detail/WorkflowComponents/Flow/nodes/NodeAgent/index.tsx`

### 3.1 工具调用连接态（`isTool`）与提示词 AI 生成模式

1. **工具连接态检测**：
   - 通过 `useWorkflowSelector` 检查是否存在指向当前节点 `getHandleId(nodeId, 'target', 'selectedTools')` 的连线，计算 `isTool`。
2. **提示词（`aiSystemPrompt`）切换 AI 生成**：
   - 向提示词标题栏的 `<InputLabel />` 传入 `isTool={isTool}`。
   - 当 `selectedTypeIndex` 切换至 `FlowNodeInputTypeEnum.agentGenerated` 时，`Label.tsx` 将 `promptInput.value` 清空为 `undefined`，原富文本编辑器替换为 `AgentGeneratedPlaceholder`（展示「由 AI 生成内容」占位块），而节点下方的技能、工具、知识库配置保持生效。
3. **对话输入区（`history` & `userChatInput`）**：
   - 底部输入区过滤集合定义为 `new Set([NodeInputKeyEnum.history, NodeInputKeyEnum.userChatInput])`，向 `<RenderInput />` 透传 `isTool={isTool}`，使连接工具调用节点后 `userChatInput` 默认切换为 AI 生成，`history` 支持手动切换为 AI 生成。

### 3.2 资源异常状态展示与快捷删除（对齐 Agent V2）

1. **技能区（Skills）**：
   - 当已配置技能（`selectedAgentSkills.length > 0`）但未开启虚拟机或系统/套餐不支持虚拟机（`!sandboxInput?.value || !showSandbox || !enableSandbox`）时，在技能栏右侧展示红色提示标签 `app:sandbox_unavailable_tag`。
2. **工具区（Tools）**：
   - 对齐 `ToolSelect.tsx`，通过 `getToolErrorMessage(tool, t)` 检测工具停用（`PluginStatusEnum.Offline`）、已删除/无权限（`pluginData.error`）或配置未完成（`configStatus === 'invalid' | 'waitingForConfig'` 或 `getToolConfigStatus` 返回 `waitingForConfig`），在节点工具卡片上渲染红框、错误 Tooltip、待配置标签及即将下线标签。
3. **知识库区（Datasets）**：
   - 为 `<DatasetCard />` 绑定 `onDelete={() => removeDataset(item.datasetId)}`，支持在节点上直接移除失效或异常的知识库。

---

## 4. 服务端调度与流输出控制（`packages/service`）

### 4.1 对话文件自动解析（`packages/service/core/workflow/dispatch/ai/agent/index.ts`）

- 工作流 Agent 节点移除了 `fileUrlList` 输入项，但仍需支持解析用户在当前轮对话或历史轮次中上传的文档与图片：
  ```ts
  const fileUrlInput = node.inputs.find((item) => item.key === NodeInputKeyEnum.fileUrlList);
  // 工作流 Agent 节点无独立 fileUrlList 输入项，默认开启对话文件解析；
  // 独立 Agent 应用存在 fileUrlList 输入项，按其数组非空判定是否解析
  const parseHistoryFiles = fileUrlInput ? !!fileUrlInput.value?.length : true;
  ```

### 4.2 流输出控制（`aiChatIsResponseText`）

当用户在节点上关闭流输出（`isResponseAnswerText === false`）时，需抑制所有面向最终用户对话气泡的流事件与可见响应项，同时保障 `ask_user` 追问交互、断点恢复元数据、节点输出变量与运行详情完整可用：

1. **SSE 事件流抑制**：
   - 在 `packages/service/core/workflow/dispatch/ai/agent/adapter/runtime.ts` 中：
     ```ts
     const streamAnswer = context.params.isResponseAnswerText !== false;
     const eventStream = createAgentLoopCoreEventStream({
       workflowStreamResponse: context.runtime.workflowStreamResponse,
       streamAnswer,
       streamReasoning: streamAnswer && context.params.aiChatReasoning !== false
     });
     ```
   - 在 `packages/service/core/workflow/dispatch/ai/agentLoopCore/adapter/eventStream/createEventStream.ts` 中，除原有的正文、思考、工具调用受 `streamAnswer` 控制外，为 `streamPlanStatus` 与 `streamPlan` 补充 `if (!streamAnswer) return;` 守卫，确保关闭流输出时不会向前端推送 Plan 状态与规划卡片事件。
2. **`assistantResponses` 可见内容过滤**：
   - 在 `packages/service/core/workflow/dispatch/ai/agent/index.ts` 中，当 `isResponseAnswerText === false` 时通过 `filterHiddenStreamAssistantResponses` 过滤 `assistantResponses`，剔除 `text`、`reasoning`、`tools`、`skills`、`plan`、`planStatus` 等 UI 可见字段，仅保留恢复运行所需的隐藏元数据（`agentAsk`、`agentPlanUpdate`、`contextCheckpoint`）。
   - 若触发 `ask_user`（`outputSummary.finishReason === 'interactive'`），`[DispatchNodeResponseKeyEnum.interactive]` 照常返回，驱动前端渲染追问表单。
   - `data[NodeOutputKeyEnum.answerText]` 与 `[DispatchNodeResponseKeyEnum.nodeResponse]` 照常返回，不影响下游节点引用与运行详情查看。

### 4.3 工具调用返回值与错误捕获（`packages/service/core/workflow/dispatch/ai/agent/index.ts`）

1. **`toolResponse` 返回值**：
   - 当 Agent 节点作为工具被 `ToolCallNode` 调用完成（`done` / `error` / `aborted`）时，返回 `[DispatchNodeResponseKeyEnum.toolResponse]`：
     ```ts
     [DispatchNodeResponseKeyEnum.toolResponse]: outputSummary.errorText
       ? { error: outputSummary.errorText }
       : finalOutput.answerText
     ```
2. **错误捕获（`catchError`）气泡抑制**：
   - 当发生节点级错误（`outputSummary.errorText`）且节点开启了 `props.node.catchError === true` 时，不将错误文本追加到对话气泡 `assistantResponses` 中，仅通过 `data[NodeOutputKeyEnum.errorText]` 与 `error` 字段交由工作流错误捕获分支处理。

---

## 5. 工作流运行检查与导入导出过滤（`projects/app`）

### 5.1 资源检查（对齐 Agent V2）

1. **新增诊断码（`packages/global/core/workflow/diagnostic/constants.ts`）**：
   - 在 `WorkflowCheckIssueCodeEnum` 及 `WORKFLOW_CHECK_PENDING_HANDLE_CODES` 中新增：
     - `agentToolAbnormal = 'agent_tool_abnormal'`（`引用的工具存在异常，请处理`）
     - `agentSkillAbnormal = 'agent_skill_abnormal'`（`引用的技能存在异常，请处理`）
     - `agentDatasetAbnormal = 'agent_dataset_abnormal'`（`引用的知识库存在异常，请处理`）
2. **Agent 节点资源校验规则（`projects/app/src/web/core/workflow/check/resource.ts`）**：
   - **工具检查（`selectedTools`）**：对齐 `checkAppForm.ts` 的 `hasToolError`，当任一已选工具命中以下条件时报告 `agentToolAbnormal`：
     - `(tool.status ?? tool.pluginData?.status) === PluginStatusEnum.Offline`
     - `Boolean(tool.pluginData?.error)`
     - `tool.configStatus === 'invalid' || tool.configStatus === 'waitingForConfig'`
     - `Array.isArray(tool.inputs) && getToolConfigStatus({ tool }).status === 'waitingForConfig'`
     - `resources.toolExistsMap?.get(tool.id) === false`
   - **技能检查（`skills`）**：当技能缺失或无权限时，保留底层 `code`（`resourceMissing` / `resourceNoPermission`），并设置 `messageCode: WorkflowCheckIssueCodeEnum.agentSkillAbnormal`。
   - **知识库检查（`datasetSelectList` / `datasetParams.datasets`）**：当节点为 `FlowNodeTypeEnum.agent` 且知识库缺失或无权限时，设置 `messageCode: WorkflowCheckIssueCodeEnum.agentDatasetAbnormal`。

### 5.2 虚拟机（Sandbox）检查（对齐 Agent V2）

在 `workflowUtilsContext.tsx`（发布/保存检查）与 `useDebug.tsx`（单步/下一步调试检查）中通过 `findWorkflowSandboxIssueNode` 扫描未折叠的 `FlowNodeTypeEnum.agent` 节点：
1. 已配置 `skills`（`skills.length > 0`），但未开启 `useAgentSandbox` 或系统未启用虚拟机（`!feConfigs?.show_agent_sandbox`）或团队套餐不支持（`!myTeamPlanStatus?.standard?.enableSandbox`） -> 标记节点 `isError: true` 并提示 `skill:sandbox_skill_unavailable_toast`。
2. 开启了 `useAgentSandbox`，但 `!feConfigs?.show_agent_sandbox` -> 标记节点错误并提示 `skill:sandbox_system_not_configured_toast`。
3. 开启了 `useAgentSandbox`，但 `!myTeamPlanStatus?.standard?.enableSandbox` -> 标记节点错误并提示 `app:sandbox_free_not_support`。

### 5.3 导出敏感信息过滤与文案更新

1. **敏感数据清理（`projects/app/src/web/core/workflow/utils.ts`）**：
   - 在 `filterSensitiveNodesData` 中针对 `FlowNodeTypeEnum.agent`：
     - 将 `skills`、`selectedTools`、`datasetSelectList` 重置为 `[]`；
     - 将 `datasetParams.datasets` 重置为 `[]`；
     - 使用正则 `/\{\{@[^@{}]+@\}\}/g` 剥离 `aiSystemPrompt` 字符串中的内联技能/工具/知识库引用标签。
2. **文案更新（`packages/web/i18n/{zh-CN,en,zh-Hant}/common.json`）**：
   - 更新 `filter_sensitive_info_tip`，明确列出「系统工具」临时密钥、「工具节点」鉴权参数值、「知识库搜索节点」知识库信息、「Agent节点」配置的技能、工具、知识库信息，以及开启过滤后的清除效果说明。

---

## 6. Todo

- [x] 将 `AgentNode` 移入 `appSystemModuleTemplates` 并解除 `NodeTemplates/list.tsx` 的隐藏过滤
- [x] 完善 `AgentNode` 模板：开启 `isTool: true`，支持 `aiSystemPrompt` / `history` / `userChatInput` 的 `agentGenerated`，移除独立 `fileUrlList` 输入项，并在 `agentForm2AppWorkflow` 中保持独立 Agent 应用兼容
- [x] 将 `FlowNodeTypeEnum.agent` 加入 `INTERACTIVE_NODE_TYPES` 以禁用应用评测并限制放入并行节点
- [x] 完善前端 `NodeAgent` 组件：支持工具调用连接态、提示词 AI 生成占位渲染、技能虚拟机不可用提示、工具异常状态展示及知识库删除操作
- [x] 调整服务端 `dispatchRunAgent` 与 `createEventStream`：支持无 `fileUrlList` 输入项时默认解析对话文件、关闭流输出时抑制可见流事件与 `assistantResponses`（保留 `ask_user` 交互）、补充 `toolResponse` 返回值及 `catchError` 气泡抑制
- [x] 对齐 Agent V2 实现工作流 Agent 节点的工具/技能/知识库诊断检查与 Sandbox 虚拟机运行检查
- [x] 在 `filterSensitiveNodesData` 中支持过滤 Agent 节点的技能、工具、知识库及提示词内联引用标签，并更新多语言提示文案
- [x] 补充并通过工作流模板、节点检查、敏感信息过滤及 `dispatchRunAgent` 相关单元测试
