import { WorkflowCheckIssueCodeEnum } from '@fastgpt/global/core/workflow/diagnostic/constants';
import { PluginStatusEnum } from '@fastgpt/global/core/plugin/type';
import {
  FlowNodeInputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { NodeInputKeyEnum, WorkflowIOValueTypeEnum } from '@fastgpt/global/core/workflow/constants';
import { getSelectedInputRenderType } from '@fastgpt/global/common/workflow/reference';
import {
  getToolConfigStatus,
  isToolInputValueConfigured
} from '@fastgpt/global/core/app/formEdit/utils';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import type { WorkflowBindingRequirement } from '@fastgpt/workflow-core/binding/type';
import type { TFunction } from 'next-i18next';
import type { WorkflowRuleIssue } from '../type';
import { resolvePluginDataErrorIssueCode } from './error';

/** 校验工作流节点中的虚拟机（Sandbox）与技能可用性约束，与 Agent V2 (checkAppFormSandboxIssues) 保持一致。 */
export const findWorkflowSandboxIssueNode = <
  T extends { data: Pick<FlowNodeItemType, 'flowNodeType' | 'inputs' | 'isFolded'> }
>({
  nodes,
  showSandbox,
  enableSandbox,
  t
}: {
  nodes: T[];
  showSandbox?: boolean;
  enableSandbox?: boolean;
  t: TFunction;
}): { node: T; message: string } | undefined => {
  for (const node of nodes) {
    if (node.data.isFolded) continue;

    if (node.data.flowNodeType === FlowNodeTypeEnum.agent) {
      const skills = node.data.inputs.find((input) => input.key === NodeInputKeyEnum.skills)?.value;
      const useAgentSandbox = Boolean(
        node.data.inputs.find((input) => input.key === NodeInputKeyEnum.useAgentSandbox)?.value
      );
      if (
        Array.isArray(skills) &&
        skills.length > 0 &&
        (!useAgentSandbox || !showSandbox || !enableSandbox)
      ) {
        return {
          node,
          message: t('skill:sandbox_skill_unavailable_toast')
        };
      }
    }

    if (
      node.data.flowNodeType === FlowNodeTypeEnum.agent ||
      node.data.flowNodeType === FlowNodeTypeEnum.toolCall
    ) {
      const useAgentSandbox = Boolean(
        node.data.inputs.find((input) => input.key === NodeInputKeyEnum.useAgentSandbox)?.value
      );
      if (useAgentSandbox && (!showSandbox || !enableSandbox)) {
        return {
          node,
          message: !showSandbox
            ? t('skill:sandbox_system_not_configured_toast')
            : t('app:sandbox_free_not_support')
        };
      }
    }
  }

  return undefined;
};

/** 展示当前节点的资源状态与外部绑定缺项；bindings 已按节点分组，不重跑模型、普通输入、图或 ACL 校验。 */
export const checkWorkflowNodeResourceRules = ({
  data,
  bindings
}: {
  data: FlowNodeItemType;
  bindings: WorkflowBindingRequirement[];
}): WorkflowRuleIssue[] => {
  const issues: WorkflowRuleIssue[] = [];
  const inputs = new Map(data.inputs.map((input) => [input.key, input]));
  if ((data.status ?? data.pluginData?.status) === PluginStatusEnum.Offline) {
    issues.push({ code: WorkflowCheckIssueCodeEnum.toolOffline });
  } else if (data.pluginData?.error) {
    issues.push({ code: resolvePluginDataErrorIssueCode(data.pluginData.error) });
  }

  // 密钥激活是运行/发布前置条件，普通串联工具与 selectedTools 挂载工具都需要检查。
  const systemInputConfig = inputs.get(NodeInputKeyEnum.systemInputConfig);
  if (systemInputConfig && !isToolInputValueConfigured({ input: systemInputConfig })) {
    issues.push({
      code: WorkflowCheckIssueCodeEnum.toolWaitingConfig,
      inputKey: NodeInputKeyEnum.systemInputConfig
    });
  }

  /** 资源删除/权限标记来自服务端快照，不根据客户端身份重新鉴权。 */
  const addResourceIssues = (
    value: unknown,
    inputKey: string,
    messageCode?: WorkflowCheckIssueCodeEnum
  ) => {
    if (!Array.isArray(value)) return;
    if (value.some((item) => item?.error === WorkflowCheckIssueCodeEnum.resourceNoPermission)) {
      issues.push({
        code: WorkflowCheckIssueCodeEnum.resourceNoPermission,
        inputKey,
        ...(messageCode ? { messageCode } : {})
      });
    }
    if (
      value.some(
        (item) => item?.error && item.error !== WorkflowCheckIssueCodeEnum.resourceNoPermission
      )
    ) {
      issues.push({
        code: WorkflowCheckIssueCodeEnum.resourceMissing,
        inputKey,
        ...(messageCode ? { messageCode } : {})
      });
    }
  };
  const isAgentNode = data.flowNodeType === FlowNodeTypeEnum.agent;
  addResourceIssues(
    inputs.get(NodeInputKeyEnum.datasetSelectList)?.value,
    NodeInputKeyEnum.datasetSelectList,
    isAgentNode ? WorkflowCheckIssueCodeEnum.agentDatasetAbnormal : undefined
  );
  addResourceIssues(
    inputs.get(NodeInputKeyEnum.skills)?.value,
    NodeInputKeyEnum.skills,
    isAgentNode ? WorkflowCheckIssueCodeEnum.agentSkillAbnormal : undefined
  );
  const datasetParams = inputs.get(NodeInputKeyEnum.datasetParams)?.value;
  if (
    isAgentNode &&
    datasetParams &&
    typeof datasetParams === 'object' &&
    !Array.isArray(datasetParams)
  ) {
    addResourceIssues(
      datasetParams.datasets,
      NodeInputKeyEnum.datasetParams,
      WorkflowCheckIssueCodeEnum.agentDatasetAbnormal
    );
  }
  if (isAgentNode) {
    const selectedTools = inputs.get(NodeInputKeyEnum.selectedTools)?.value;
    if (
      Array.isArray(selectedTools) &&
      selectedTools.some((tool) => {
        if (!tool || typeof tool !== 'object') return false;
        const status = tool.status ?? tool.pluginData?.status;
        if (status === PluginStatusEnum.Offline) return true;
        if (tool.pluginData?.error || tool.error) return true;
        if (tool.configStatus === 'invalid' || tool.configStatus === 'waitingForConfig') {
          return true;
        }
        return Array.isArray(tool.inputs) && getToolConfigStatus({ tool }).status !== 'configured';
      })
    ) {
      issues.push({
        code: WorkflowCheckIssueCodeEnum.agentToolAbnormal,
        inputKey: NodeInputKeyEnum.selectedTools
      });
    }
  }

  // Core 允许生成时暂不绑定外部资源；Web 运行/发布沿用可见必填资源必须已选择的规则。
  for (const binding of bindings) {
    if (binding.status !== 'missing' || !binding.resourceKind || binding.resourceKind === 'model')
      continue;
    const input = inputs.get(binding.inputKey);
    if (!input?.required || !input.valueType || input.valueType === WorkflowIOValueTypeEnum.boolean)
      continue;
    const renderType = getSelectedInputRenderType(input);
    if (renderType === FlowNodeInputTypeEnum.hidden || renderType === FlowNodeInputTypeEnum.off)
      continue;
    issues.push({
      code: WorkflowCheckIssueCodeEnum.requiredInputEmpty,
      inputKey: input.key,
      input
    });
  }
  return issues;
};
