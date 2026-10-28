import { useCallback, useMemo } from 'react';
import { useContextSelector } from 'use-context-selector';
import { WorkflowActionsContext } from '../../../context/workflowActionsContext';
import { useSkillManager } from '@/pageComponents/app/detail/Edit/ChatAgent/hooks/useSkillManager';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { nodeInputIsReference } from '@fastgpt/global/common/workflow/reference';
import type { FlowNodeInputItemType } from '@fastgpt/global/core/workflow/type/io';
import type {
  SelectedAgentSkillItemType,
  SelectedToolItemType
} from '@fastgpt/global/core/app/formEdit/type';
import { getToolConfigStatus } from '@fastgpt/global/core/app/formEdit/utils';
import { getToolIdentityKey } from '@fastgpt/global/core/app/tool/utils';

/**
 * Adapts the ChatAgent's useSkillManager to work in the workflow node context.
 * Reads/writes selectedTools and skills from/to the node's input via onChangeNode.
 */
export const useAgentSkillManager = ({
  nodeId,
  inputs,
  selectedAgentSkills = [],
  onAddAgentSkill,
  onEnableSandbox,
  onClickDatasetSearch
}: {
  nodeId: string;
  inputs: FlowNodeInputItemType[];
  selectedAgentSkills?: SelectedAgentSkillItemType[];
  onAddAgentSkill?: (skill: SelectedAgentSkillItemType) => boolean;
  onEnableSandbox?: () => void;
  onClickDatasetSearch?: () => void;
}) => {
  const onChangeNode = useContextSelector(WorkflowActionsContext, (v) => v.onChangeNode);

  const toolsInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.selectedTools),
    [inputs]
  );
  const selectedTools: SelectedToolItemType[] = useMemo(
    () =>
      Array.isArray(toolsInput?.value)
        ? toolsInput.value.map((tool: SelectedToolItemType) => ({
            ...tool,
            configStatus:
              tool.configStatus ??
              (Array.isArray(tool.inputs) ? getToolConfigStatus({ tool }).status : undefined)
          }))
        : [],
    [toolsInput]
  );

  const fileLinkInput = useMemo(() => inputs.find((i) => i.key === 'fileLink'), [inputs]);
  const canUploadFile = fileLinkInput ? !!fileLinkInput.value : true;

  const datasetInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.datasetSelectList),
    [inputs]
  );
  const hasSelectedDataset = useMemo(() => {
    if (!datasetInput || !Array.isArray(datasetInput.value)) return false;
    if (nodeInputIsReference(datasetInput)) {
      return (
        datasetInput.value.length === 2 &&
        Boolean(datasetInput.value[0]) &&
        Boolean(datasetInput.value[1])
      );
    }
    return datasetInput.value.length > 0;
  }, [datasetInput]);

  const useAgentSandbox = useMemo(() => {
    const sandboxInput = inputs.find((i) => i.key === NodeInputKeyEnum.useAgentSandbox);
    return !!sandboxInput?.value;
  }, [inputs]);

  const onUpdateOrAddTool = useCallback(
    (tool: SelectedToolItemType) => {
      const toolKey = getToolIdentityKey(tool.pluginId, tool.source);
      const exists = selectedTools.find(
        (t) => getToolIdentityKey(t.pluginId, t.source) === toolKey
      );
      const newTools = exists
        ? selectedTools.map((t) =>
            getToolIdentityKey(t.pluginId, t.source) === toolKey ? tool : t
          )
        : [...selectedTools, tool];

      if (toolsInput) {
        onChangeNode({
          nodeId,
          key: NodeInputKeyEnum.selectedTools,
          type: 'updateInput',
          value: {
            ...toolsInput,
            value: newTools
          }
        });
      }
    },
    [selectedTools, toolsInput, nodeId, onChangeNode]
  );

  const onDeleteTool = useCallback(
    (id: string, source?: string) => {
      const toolKey = getToolIdentityKey(id, source);
      const newTools = selectedTools.filter(
        (t) => getToolIdentityKey(t.pluginId, t.source) !== toolKey
      );
      if (toolsInput) {
        onChangeNode({
          nodeId,
          key: NodeInputKeyEnum.selectedTools,
          type: 'updateInput',
          value: {
            ...toolsInput,
            value: newTools
          }
        });
      }
    },
    [selectedTools, toolsInput, nodeId, onChangeNode]
  );

  const { skillOption, selectedSkills, onClickSkill, onRemoveSkill, SkillModal } = useSkillManager({
    selectedTools,
    selectedAgentSkills,
    onUpdateOrAddTool,
    onDeleteTool,
    onAddAgentSkill,
    onEnableSandbox,
    canUploadFile,
    hasSelectedDataset,
    useAgentSandbox,
    onClickDatasetSearch
  });

  return {
    selectedTools,
    skillOption,
    selectedSkills,
    onClickSkill,
    onRemoveSkill,
    onUpdateOrAddTool,
    onDeleteTool,
    SkillModal
  };
};
