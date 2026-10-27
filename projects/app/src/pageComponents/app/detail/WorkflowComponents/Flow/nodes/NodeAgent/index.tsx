import { Box, Button, Flex, Grid, HStack, Switch, useDisclosure } from '@chakra-ui/react';
import { ModelTypeEnum } from '@fastgpt/global/core/ai/constants';
import { NodeInputKeyEnum, WorkflowIOValueTypeEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeInputTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type { FlowNodeInputItemType } from '@fastgpt/global/core/workflow/type/io';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import Avatar from '@fastgpt/web/components/common/Avatar';
import MyIcon from '@fastgpt/web/components/common/Icon';
import MyIconButton from '@fastgpt/web/components/common/Icon/button';
import FormLabel from '@fastgpt/web/components/common/MyBox/FormLabel';
import MyTooltip from '@fastgpt/web/components/common/MyTooltip';
import { useTranslation } from 'next-i18next';
import dynamic from 'next/dynamic';
import React, { useCallback, useMemo } from 'react';
import { type NodeProps } from 'reactflow';
import { useContextSelector } from 'use-context-selector';

import Container from '../../components/Container';
import IOTitle from '../../components/IOTitle';
import NodeCard from '../render/NodeCard';
import RenderInput from '../render/RenderInput';
import InputLabel from '../render/RenderInput/Label';
import RenderOutput from '../render/RenderOutput';
import CatchError from '../render/RenderOutput/CatchError';
import RenderToolInput, { hasDynamicToolInput } from '../render/RenderToolInput';
import { useReference } from '../render/RenderInput/templates/Reference';

import { AppContext } from '@/pageComponents/app/detail/context';
import { WorkflowActionsContext } from '../../../context/workflowActionsContext';
import { WorkflowBufferDataContext } from '../../../context/workflowInitContext';
import { WorkflowUtilsContext } from '../../../context/workflowUtilsContext';

import { useSystemStore } from '@/web/common/system/useSystemStore';
import { useModelDetail } from '@/web/core/ai/model/useModelDetail';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { getEditorVariables } from '../../../utils';
import { useWorkflowQuoteLimit } from '../../hooks/useWorkflowQuoteLimit';

import OptimizerPopover from '@/components/common/PromptEditor/OptimizerPopover';
import { useDatasetTagFilterPrune } from '@/components/core/dataset/DatasetTagFilterRows';
import {
  getDatasetSearchParamInputs,
  getDatasetSearchParams
} from '../render/RenderInput/templates/SelectDatasetParams.utils';
import { useAgentSkillManager } from './useAgentSkillManager';

import DatasetCard from '@/components/core/app/DatasetCard';
import SkillCard from '@/components/core/app/SkillCard';
import { RechargeModal } from '@/components/support/wallet/NotSufficientModal';
import { useUserStore } from '@/web/support/user/useUserStore';
import type { SelectedAgentSkillItemType } from '@fastgpt/global/core/app/formEdit/type';
import { getToolIdentityKey, isDebugToolSource } from '@fastgpt/global/core/app/tool/utils';
import type { DatasetTagFilterValue } from '@fastgpt/global/core/dataset/search/tagFilter/type';
import { getSelectedInputRenderType } from '@fastgpt/global/common/workflow/reference';
import QuestionTip from '@fastgpt/web/components/common/MyTooltip/QuestionTip';

import DebugToolTag from '@fastgpt/web/components/core/plugin/tool/DebugToolTag';
import MyTag from '@fastgpt/web/components/common/Tag/index';
import {
  PluginStatusEnum,
  PluginStatusMap,
  type PluginStatusType
} from '@fastgpt/global/core/plugin/type';
import { getToolErrorMessage } from '@/web/core/workflow/check/message';
import { useConfirm } from '@fastgpt/web/hooks/useConfirm';
import { useToast } from '@fastgpt/web/hooks/useToast';
import WorkflowSandboxConfig, {
  createSandboxEntrypointInput
} from '../components/WorkflowSandboxConfig';

const PromptEditor = dynamic(() => import('@fastgpt/web/components/common/Textarea/PromptEditor'));
const SkillSelectModal = dynamic(
  () => import('@/pageComponents/app/detail/Edit/FormComponent/ToolSelector/SkillSelectModal')
);
const ToolSelectModal = dynamic(
  () => import('@/pageComponents/app/detail/Edit/FormComponent/ToolSelector/ToolSelectModal')
);
const ReferenceRender = dynamic(() => import('../render/RenderInput/templates/Reference'));
const DatasetParamsModal = dynamic(() => import('@/components/core/app/DatasetParamsModal'));
const DatasetSelectModal = dynamic(() => import('@/components/core/app/DatasetSelectModal'));

/* ======== Helper: get current renderType of an input ======== */
const getRenderType = (input: FlowNodeInputItemType) =>
  getSelectedInputRenderType(input) || FlowNodeInputTypeEnum.custom;

const agentModelSettingProps = {
  showTemperature: false,
  showTopP: false,
  showStopSign: false,
  showResponseFormat: false
};

const chooseButtonTooltipProps = {
  offset: [0, 8] as [number, number],
  px: 3,
  py: 2,
  fontSize: 'xs',
  borderRadius: 'md',
  arrowSize: 8,
  boxShadow: '0px 2px 4px 0px rgba(161, 167, 179, 0.25), 0px 0px 1px 0px rgba(121, 141, 159, 0.25)',
  shouldWrapChildren: false
} as const;

const ManualInputLabel = React.memo(function ManualInputLabel({
  input,
  RightComponent
}: {
  input: FlowNodeInputItemType;
  RightComponent?: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <Flex className="nodrag" cursor={'default'} alignItems={'center'}>
      <FormLabel color={'myGray.600'}>{t(input.label as any)}</FormLabel>
      {RightComponent && (
        <>
          <Box flex={'1'} />
          {RightComponent}
        </>
      )}
    </Flex>
  );
});

// TODO: 待优化，不一定需要重写，用模板渲染也可以
const NodeAgent = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { nodeId, catchError, inputs, outputs } = data;
  const { t } = useTranslation();
  const { toast } = useToast();

  const onChangeNode = useContextSelector(WorkflowActionsContext, (v) => v.onChangeNode);
  const { splitToolInputs, splitOutput } = useContextSelector(WorkflowUtilsContext, (ctx) => ctx);
  const { getNodeById, edges } = useContextSelector(WorkflowBufferDataContext, (v) => v);
  const { appDetail } = useContextSelector(AppContext, (v) => v);
  const { feConfigs } = useSystemStore();
  const llmMaxQuoteContext = useWorkflowQuoteLimit();
  const externalProviderWorkflowVariables = feConfigs?.externalProviderWorkflowVariables;
  const { teamPlanStatus, isTeamAdmin } = useUserStore();
  const enableSandbox = !teamPlanStatus?.standard || !!teamPlanStatus?.standard?.enableSandbox;
  const showSandbox = feConfigs.show_agent_sandbox;
  const { openConfirm, ConfirmModal } = useConfirm();

  // Split tool/common inputs and outputs
  const { isTool, commonInputs } = useMemoEnhance(
    () => splitToolInputs(inputs, nodeId),
    [inputs, nodeId, splitToolInputs]
  );
  const { successOutputs, errorOutputs } = useMemoEnhance(
    () => splitOutput(outputs),
    [splitOutput, outputs]
  );

  // Editor variables for PromptEditor
  const editorVariables = useMemoEnhance(
    () =>
      getEditorVariables({
        nodeId,
        getNodeById,
        edges,
        appDetail,
        t
      }),
    [nodeId, getNodeById, edges, appDetail, t]
  );
  const externalVariables = useMemo(
    () =>
      externalProviderWorkflowVariables?.map((item) => ({
        key: item.key,
        label: item.name
      })) || [],
    [externalProviderWorkflowVariables]
  );
  const allVariables = useMemo(
    () => [...(editorVariables || []), ...(externalVariables || [])],
    [editorVariables, externalVariables]
  );

  // 节点 inputs 是已保存参数的唯一来源；弹窗自行维护草稿，避免本地副本遗漏模型 ID。
  const datasetParamsData = useMemo(() => getDatasetSearchParams(inputs), [inputs]);
  const { referenceList: tagFilterReferenceList } = useReference({
    nodeId,
    valueType: WorkflowIOValueTypeEnum.any
  });
  const {
    isOpen: isOpenDatasetParams,
    onOpen: onOpenDatasetParams,
    onClose: onCloseDatasetParams
  } = useDisclosure();
  const {
    isOpen: isOpenDatasetSelect,
    onOpen: onOpenDatasetSelect,
    onClose: onCloseDatasetSelect
  } = useDisclosure();

  // ---- Prompt ----
  const promptInput = useMemo(
    () => commonInputs.find((i) => i.key === NodeInputKeyEnum.aiSystemPrompt),
    [commonInputs]
  );
  const skillsInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.skills),
    [inputs]
  );
  const sandboxInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.useAgentSandbox),
    [inputs]
  );
  const sandboxEntrypointInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.sandboxEntrypoint),
    [inputs]
  );
  const toolsInput = useMemo(
    () => inputs.find((i) => i.key === NodeInputKeyEnum.selectedTools),
    [inputs]
  );

  // Split commonInputs into groups
  const modelSettingInputKeys = useMemo(
    () =>
      new Set([
        NodeInputKeyEnum.aiModelId,
        NodeInputKeyEnum.aiModel,
        NodeInputKeyEnum.aiChatTemperature,
        NodeInputKeyEnum.aiChatMaxToken,
        NodeInputKeyEnum.aiChatIsResponseText,
        NodeInputKeyEnum.aiChatVision,
        NodeInputKeyEnum.aiChatAudio,
        NodeInputKeyEnum.aiChatVideo,
        NodeInputKeyEnum.aiChatExtractFiles,
        NodeInputKeyEnum.aiChatReasoning,
        NodeInputKeyEnum.aiChatReasoningEffort,
        NodeInputKeyEnum.aiChatTopP,
        NodeInputKeyEnum.aiChatStopSign,
        NodeInputKeyEnum.aiChatResponseFormat,
        NodeInputKeyEnum.aiChatJsonSchema
      ]),
    []
  );
  const manualKeys = useMemo(
    () =>
      new Set([
        ...modelSettingInputKeys,
        NodeInputKeyEnum.aiSystemPrompt,
        NodeInputKeyEnum.skills,
        NodeInputKeyEnum.useAgentSandbox,
        NodeInputKeyEnum.sandboxEntrypoint,
        NodeInputKeyEnum.selectedTools
      ]),
    [modelSettingInputKeys]
  );
  const modelInputs = useMemo(
    () => commonInputs.filter((i) => modelSettingInputKeys.has(i.key as NodeInputKeyEnum)),
    [commonInputs, modelSettingInputKeys]
  );
  // Inputs rendered after dataset (history, userChatInput)
  const chatInputKeys = useMemo(
    () => new Set([NodeInputKeyEnum.history, NodeInputKeyEnum.userChatInput]),
    []
  );
  const chatInputs = useMemo(
    () => commonInputs.filter((i) => chatInputKeys.has(i.key as NodeInputKeyEnum)),
    [commonInputs, chatInputKeys]
  );
  // Dataset inputs
  const datasetInputs = useMemo(
    () =>
      commonInputs.filter(
        (i) =>
          !manualKeys.has(i.key as NodeInputKeyEnum) &&
          !chatInputKeys.has(i.key as NodeInputKeyEnum)
      ),
    [commonInputs, manualKeys, chatInputKeys]
  );
  const datasetSelectInput = useMemo(
    () => datasetInputs.find((i) => i.key === NodeInputKeyEnum.datasetSelectList),
    [datasetInputs]
  );
  const datasetSelectRenderType = useMemo(
    () =>
      datasetSelectInput ? getRenderType(datasetSelectInput) : FlowNodeInputTypeEnum.selectDataset,
    [datasetSelectInput]
  );
  const selectedDatasets = useMemo(
    () =>
      datasetSelectRenderType === FlowNodeInputTypeEnum.selectDataset &&
      Array.isArray(datasetSelectInput?.value)
        ? datasetSelectInput.value
        : [],
    [datasetSelectInput, datasetSelectRenderType]
  );
  const datasetIds = useMemo(
    () => selectedDatasets.map((item) => item.datasetId),
    [selectedDatasets]
  );
  const handlePruneTagFilter = useCallback(
    (nextFilter: DatasetTagFilterValue) => {
      for (const input of getDatasetSearchParamInputs({
        inputs,
        values: {
          ...datasetParamsData,
          collectionFilterMatch: nextFilter
        }
      })) {
        if (input.key !== NodeInputKeyEnum.collectionFilterMatch) continue;
        if (inputs.some((item) => item.key === input.key)) {
          onChangeNode({ nodeId, type: 'updateInput', key: input.key, value: input });
        } else {
          onChangeNode({ nodeId, type: 'addInput', value: input });
        }
      }
    },
    [datasetParamsData, inputs, nodeId, onChangeNode]
  );
  useDatasetTagFilterPrune({
    datasetIds,
    value: datasetParamsData.collectionFilterMatch,
    onChange: handlePruneTagFilter
  });
  const onClickDatasetSearch = useCallback(() => {
    if (
      datasetSelectRenderType === FlowNodeInputTypeEnum.reference ||
      selectedDatasets.length > 0
    ) {
      onOpenDatasetParams();
      return;
    }

    onOpenDatasetSelect();
  }, [datasetSelectRenderType, onOpenDatasetParams, onOpenDatasetSelect, selectedDatasets.length]);
  const authTmbIdInput = useMemo(
    () => datasetInputs.find((i) => i.key === NodeInputKeyEnum.authTmbId),
    [datasetInputs]
  );

  const onChangeAuthTmbId = useCallback(
    (checked: boolean) => {
      if (!authTmbIdInput) return;
      onChangeNode({
        nodeId,
        type: 'updateInput',
        key: NodeInputKeyEnum.authTmbId,
        value: {
          ...authTmbIdInput,
          value: checked
        }
      });
    },
    [authTmbIdInput, nodeId, onChangeNode]
  );

  // ---- Prompt ----
  const onPromptChange = useCallback(
    (text: string) => {
      if (!promptInput) return;
      onChangeNode({
        nodeId,
        key: NodeInputKeyEnum.aiSystemPrompt,
        type: 'updateInput',
        value: { ...promptInput, value: text }
      });
    },
    [promptInput, nodeId, onChangeNode]
  );
  const promptRenderType = useMemo(() => {
    if (!promptInput) return FlowNodeInputTypeEnum.textarea;
    return getRenderType(promptInput);
  }, [promptInput]);
  const PromptSkillTip = useMemo(
    () =>
      promptRenderType === FlowNodeInputTypeEnum.textarea ? (
        <HStack fontSize={'xs'} fontWeight={'medium'} spacing={1} color={'myGray.500'}>
          <MyIcon name={'infoRounded'} w={'16px'} color={'myGray.500'} />
          <Box>{t('workflow:agent.prompt_skill_tip')}</Box>
        </HStack>
      ) : undefined,
    [promptRenderType, t]
  );
  const OptimizerPopoverComponent = useCallback(
    ({ iconButtonStyle }: { iconButtonStyle: Record<string, any> }) => (
      <OptimizerPopover
        iconButtonStyle={iconButtonStyle}
        defaultPrompt={promptInput?.value}
        onChangeText={onPromptChange}
      />
    ),
    [promptInput?.value, onPromptChange]
  );

  // ---- Skills ----
  const selectedAgentSkills: SelectedAgentSkillItemType[] = useMemo(
    () => (Array.isArray(skillsInput?.value) ? skillsInput!.value : []),
    [skillsInput]
  );
  const isAgentSkillSandboxUnavailable = useMemo(
    () =>
      selectedAgentSkills.length > 0 && (!sandboxInput?.value || !showSandbox || !enableSandbox),
    [enableSandbox, sandboxInput?.value, selectedAgentSkills.length, showSandbox]
  );
  const statusLabelMap: Partial<Record<PluginStatusType, string>> = useMemo(
    () => ({
      [PluginStatusEnum.SoonOffline]: t('app:toolkit_status_soon_offline'),
      [PluginStatusEnum.Offline]: t('common:error.tool_not_exist')
    }),
    [t]
  );
  const statusTooltipMap: Partial<Record<PluginStatusType, string>> = useMemo(
    () => ({
      [PluginStatusEnum.SoonOffline]: t('app:tool_soon_offset_tips'),
      [PluginStatusEnum.Offline]: t('app:tool_offset_tips')
    }),
    [t]
  );
  const {
    isOpen: isOpenSkillSelect,
    onOpen: onOpenSkillSelect,
    onClose: onCloseSkillSelect
  } = useDisclosure();
  const {
    isOpen: isOpenRecharge,
    onOpen: onOpenRecharge,
    onClose: onCloseRecharge
  } = useDisclosure();
  const openSkillSelect = useCallback(() => {
    if (!showSandbox) {
      toast({
        status: 'warning',
        title: t('skill:sandbox_skill_system_not_configured_toast')
      });
      return;
    }
    if (!enableSandbox) {
      openConfirm({
        title: t('skill:sandbox_plan_not_supported_title'),
        customContent: t('skill:sandbox_skill_plan_not_supported_content'),
        onConfirm: isTeamAdmin ? onOpenRecharge : undefined,
        confirmText: isTeamAdmin ? t('skill:sandbox_upgrade_action') : t('common:Close'),
        cancelText: t('common:Close'),
        showCancel: isTeamAdmin
      })();
      return;
    }
    onOpenSkillSelect();
  }, [
    enableSandbox,
    onOpenSkillSelect,
    showSandbox,
    t,
    toast,
    isTeamAdmin,
    onOpenRecharge,
    openConfirm
  ]);
  const onAddAgentSkill = useCallback(
    (skill: SelectedAgentSkillItemType) => {
      if (!skillsInput) return false;
      if (!showSandbox) {
        toast({
          status: 'warning',
          title: t('skill:sandbox_skill_system_not_configured_toast')
        });
        return false;
      }
      if (!enableSandbox) {
        openConfirm({
          title: t('skill:sandbox_plan_not_supported_title'),
          customContent: t('skill:sandbox_skill_plan_not_supported_content'),
          onConfirm: isTeamAdmin ? onOpenRecharge : undefined,
          confirmText: isTeamAdmin ? t('skill:sandbox_upgrade_action') : t('common:Close'),
          cancelText: t('common:Close'),
          showCancel: isTeamAdmin
        })();
        return false;
      }

      onChangeNode([
        {
          nodeId,
          key: NodeInputKeyEnum.skills,
          type: 'updateInput',
          value: {
            ...skillsInput,
            value: [skill, ...selectedAgentSkills.filter((item) => item.skillId !== skill.skillId)]
          }
        },
        ...(sandboxInput
          ? [
              {
                nodeId,
                key: NodeInputKeyEnum.useAgentSandbox,
                type: 'updateInput' as const,
                value: {
                  ...sandboxInput,
                  value: true
                }
              }
            ]
          : [])
      ]);
      if (sandboxInput && !sandboxInput.value) {
        toast({
          status: 'success',
          title: t('skill:sandbox_auto_enabled_for_skill')
        });
      }
      return true;
    },
    [
      enableSandbox,
      isTeamAdmin,
      nodeId,
      onChangeNode,
      onOpenRecharge,
      openConfirm,
      sandboxInput,
      selectedAgentSkills,
      showSandbox,
      skillsInput,
      t,
      toast
    ]
  );
  const onChangeAgentSandbox = useCallback(
    (checked: boolean) => {
      if (!sandboxInput) return;
      if (checked) {
        if (!showSandbox) {
          toast({
            status: 'warning',
            title: t('skill:sandbox_system_not_configured_toast')
          });
          return;
        }
        if (!enableSandbox) {
          toast({
            status: 'warning',
            title: t('app:sandbox_free_not_support')
          });
          return;
        }
      }
      if (!checked && enableSandbox && selectedAgentSkills.length > 0) {
        toast({
          status: 'warning',
          title: t('skill:sandbox_disable_blocked_toast')
        });
        return;
      }

      onChangeNode({
        nodeId,
        key: NodeInputKeyEnum.useAgentSandbox,
        type: 'updateInput',
        value: {
          ...sandboxInput,
          value: checked
        }
      });
    },
    [
      enableSandbox,
      nodeId,
      onChangeNode,
      sandboxInput,
      selectedAgentSkills.length,
      showSandbox,
      t,
      toast
    ]
  );
  // Skill manager (for PromptEditor @ integration)
  const {
    selectedTools,
    skillOption,
    selectedSkills,
    onClickSkill,
    onRemoveSkill,
    onUpdateOrAddTool,
    onDeleteTool,
    SkillModal
  } = useAgentSkillManager({
    nodeId,
    inputs,
    selectedAgentSkills,
    onAddAgentSkill,
    onEnableSandbox: () => onChangeAgentSandbox(true),
    onClickDatasetSearch
  });
  // ---- Tools ----
  const {
    isOpen: isOpenToolSelect,
    onOpen: onOpenToolSelect,
    onClose: onCloseToolSelect
  } = useDisclosure();

  // ---- Model ----
  const { model: currentModel } = useModelDetail({
    modelType: ModelTypeEnum.llm,
    modelId: inputs.find((input) => input.key === NodeInputKeyEnum.aiModelId)?.value,
    model: inputs.find((input) => input.key === NodeInputKeyEnum.aiModel)?.value
  });

  return (
    <NodeCard minW={'524px'} selected={selected} {...data}>
      {isTool && hasDynamicToolInput(data) && (
        <Container>
          <RenderToolInput nodeId={nodeId} inputs={inputs} />
        </Container>
      )}

      <Container>
        <IOTitle text={t('common:Input')} nodeId={nodeId} inputs={inputs} />

        {/* 1. Model settings */}
        {modelInputs.length > 0 && (
          <RenderInput
            nodeId={nodeId}
            flowInputList={modelInputs}
            settingLLMModelProps={agentModelSettingProps}
          />
        )}

        {/* 2. System prompt */}
        {promptInput && (
          <Box position={'relative'} mb={5}>
            <InputLabel
              nodeId={nodeId}
              input={promptInput}
              RightComponent={PromptSkillTip}
              isTool={isTool}
            />
            <Box mt={2} className={'nodrag'}>
              {promptRenderType === FlowNodeInputTypeEnum.textarea ? (
                <PromptEditor
                  minH={140}
                  bg={'white'}
                  title={t('common:core.ai.Prompt')}
                  isRichText={true}
                  showOpenModal={true}
                  value={promptInput.value || ''}
                  onChange={onPromptChange}
                  variables={allVariables}
                  variableLabels={editorVariables}
                  skillOption={skillOption}
                  selectedSkills={selectedSkills}
                  onClickSkill={onClickSkill}
                  onRemoveSkill={onRemoveSkill}
                  ExtensionPopover={[OptimizerPopoverComponent]}
                  placeholder={t('workflow:agent.prompt_placeholder')}
                />
              ) : promptRenderType === FlowNodeInputTypeEnum.agentGenerated ? (
                <Flex
                  h={'40px'}
                  alignItems={'center'}
                  px={3}
                  bg={'myGray.50'}
                  border={'base'}
                  borderColor={'myGray.200'}
                  borderRadius={'md'}
                  color={'myGray.500'}
                  fontSize={'sm'}
                >
                  {t('common:core.workflow.inputType.agentGeneratedInputPlaceholder')}
                </Flex>
              ) : (
                <ReferenceRender inputs={inputs} item={promptInput} nodeId={nodeId} />
              )}
            </Box>
          </Box>
        )}

        {/* 3. Sandbox */}
        <WorkflowSandboxConfig
          nodeId={nodeId}
          sandboxInput={sandboxInput}
          sandboxEntrypointInput={sandboxEntrypointInput}
          showSandbox={!!showSandbox}
          enableSandbox={enableSandbox}
          isPlus={feConfigs?.isPlus}
          onChangeSandbox={onChangeAgentSandbox}
          onChangeEntrypoint={(value) => {
            onChangeNode({
              nodeId,
              key: NodeInputKeyEnum.sandboxEntrypoint,
              type: 'replaceInput',
              value: sandboxEntrypointInput
                ? {
                    ...sandboxEntrypointInput,
                    value
                  }
                : createSandboxEntrypointInput(value)
            });
          }}
        />

        {/* 4. Skills section (manual selection) */}
        {skillsInput && (
          <Box mb={5}>
            <ManualInputLabel
              input={skillsInput}
              RightComponent={
                isAgentSkillSandboxUnavailable ? (
                  <MyTag
                    colorSchema={'red'}
                    type={'borderFill'}
                    cursor={'pointer'}
                    onClick={openSkillSelect}
                  >
                    {t('skill:sandbox_unavailable_tag')}
                  </MyTag>
                ) : undefined
              }
            />
            <Box mt={2} className={'nodrag'}>
              <Grid
                gridTemplateColumns={'repeat(2, minmax(0, 1fr))'}
                gridGap={3}
                minW={'350px'}
                w={'100%'}
              >
                <MyTooltip label={t('workflow:agent.select_skill')} {...chooseButtonTooltipProps}>
                  <Button
                    variant={'primaryOutline'}
                    h={10}
                    w={'100%'}
                    leftIcon={<MyIcon name={'common/selectLight'} w={'14px'} />}
                    onClick={openSkillSelect}
                  >
                    {t('common:Choose')}
                  </Button>
                </MyTooltip>
                {selectedAgentSkills.map((item) => (
                  <SkillCard
                    key={item.skillId}
                    skill={item}
                    avatarSize={'18px'}
                    nameFontWeight={'medium'}
                    flexProps={{
                      h: 10,
                      px: 3,
                      py: 2.5,
                      boxShadow: 'none'
                    }}
                    onDelete={() => {
                      if (!skillsInput) return;
                      onChangeNode({
                        nodeId,
                        key: NodeInputKeyEnum.skills,
                        type: 'updateInput',
                        value: {
                          ...skillsInput,
                          value: selectedAgentSkills.filter((s) => s.skillId !== item.skillId)
                        }
                      });
                    }}
                  />
                ))}
              </Grid>
              {isOpenSkillSelect && (
                <SkillSelectModal
                  selectedSkills={selectedAgentSkills}
                  onAddSkill={(skill: SelectedAgentSkillItemType) => {
                    onAddAgentSkill(skill);
                  }}
                  onRemoveSkill={(skillId: string) => {
                    if (!skillsInput) return;
                    onChangeNode({
                      nodeId,
                      key: NodeInputKeyEnum.skills,
                      type: 'updateInput',
                      value: {
                        ...skillsInput,
                        value: selectedAgentSkills.filter((s) => s.skillId !== skillId)
                      }
                    });
                  }}
                  onClose={onCloseSkillSelect}
                />
              )}
            </Box>
          </Box>
        )}

        {/* 5. Tools section (manual selection) */}
        {toolsInput && (
          <Box mb={5}>
            <ManualInputLabel input={toolsInput} />
            <Box mt={2} className={'nodrag'}>
              <Grid
                gridTemplateColumns={'repeat(2, minmax(0, 1fr))'}
                gridGap={3}
                minW={'350px'}
                w={'100%'}
              >
                <MyTooltip label={t('workflow:agent.select_tool')} {...chooseButtonTooltipProps}>
                  <Button
                    variant={'primaryOutline'}
                    h={10}
                    w={'100%'}
                    leftIcon={<MyIcon name={'common/selectLight'} w={'14px'} />}
                    onClick={onOpenToolSelect}
                  >
                    {t('common:Choose')}
                  </Button>
                </MyTooltip>
                {selectedTools.map((item) => {
                  const status = item.pluginData?.status || item.status;
                  const toolError = getToolErrorMessage({
                    status,
                    error: item.pluginData?.error,
                    t
                  });
                  const hasToolError = !!toolError;
                  const isUnconfigured = item.configStatus === 'waitingForConfig';
                  const isDebugTool = isDebugToolSource(item.source);

                  return (
                    <MyTooltip
                      key={getToolIdentityKey(item.pluginId || item.id, item.source)}
                      label={toolError || item.intro}
                    >
                      <Flex
                        alignItems={'center'}
                        h={10}
                        boxShadow={'none'}
                        bg={'white'}
                        border={'base'}
                        borderColor={hasToolError ? 'red.600' : 'myGray.200'}
                        px={3}
                        py={2.5}
                        borderRadius={'md'}
                        _hover={{
                          borderColor: hasToolError ? 'red.600' : 'primary.300',
                          '& .delete-btn': { display: 'flex' },
                          '& .tool-status-tag': { display: 'none' },
                          '& .setting-btn': { display: 'flex' }
                        }}
                      >
                        <Avatar src={item.avatar} w={'18px'} borderRadius={'xs'} />
                        <Box
                          ml={1.5}
                          flex={'1 0 0'}
                          w={0}
                          className="textEllipsis"
                          fontWeight={'medium'}
                          fontSize={['sm', 'sm']}
                          color={hasToolError ? 'red.600' : 'myGray.900'}
                        >
                          {item.name}
                        </Box>
                        {status === PluginStatusEnum.SoonOffline && (
                          <MyTooltip label={statusTooltipMap[status]}>
                            <MyTag
                              display={'block'}
                              className="tool-status-tag"
                              colorSchema={PluginStatusMap[status].tagColor}
                              type="borderFill"
                            >
                              {statusLabelMap[status]}
                            </MyTag>
                          </MyTooltip>
                        )}
                        {toolError && (
                          <MyTag colorSchema="red" type="fill" className="tool-status-tag">
                            <MyIcon name={'common/error'} w={'14px'} mr={1} />
                            <Box color={'red.600'} maxW={'150px'} className="textEllipsis">
                              {toolError}
                            </Box>
                          </MyTag>
                        )}
                        {isUnconfigured && (
                          <MyTag colorSchema="blue" type="fill" className="tool-status-tag">
                            {t('app:wait_for_config')}
                          </MyTag>
                        )}
                        {isDebugTool && <DebugToolTag className="tool-status-tag" />}
                        {!hasToolError && (
                          <MyIconButton
                            className="setting-btn"
                            display={'none'}
                            icon="common/setting"
                            tip={t('app:tool_param_config')}
                            onClick={(e) => {
                              e.stopPropagation();
                              onClickSkill(item.pluginId!);
                            }}
                          />
                        )}
                        <Box className="delete-btn" display={'none'}>
                          <MyIconButton
                            icon="delete"
                            hoverBg="red.50"
                            hoverColor="red.600"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteTool(item.pluginId!, item.source);
                            }}
                          />
                        </Box>
                      </Flex>
                    </MyTooltip>
                  );
                })}
              </Grid>
              {isOpenToolSelect && currentModel && (
                <ToolSelectModal
                  selectedTools={selectedTools}
                  selectedModel={currentModel}
                  fileSelectConfig={{}}
                  onAddTool={(tool) => onUpdateOrAddTool({ ...tool, id: tool.pluginId! })}
                  onRemoveTool={(tool) => onDeleteTool(tool.id, tool.source)}
                  onClose={onCloseToolSelect}
                />
              )}
            </Box>
          </Box>
        )}

        {/* 6. Dataset section (supports manual selection and variable reference) */}
        {datasetSelectInput && (
          <Box mb={5}>
            <InputLabel
              nodeId={nodeId}
              input={datasetSelectInput}
              isTool={isTool}
              RightComponent={
                <HStack spacing={2} className="nodrag">
                  {feConfigs?.isPlus && authTmbIdInput && (
                    <Flex alignItems={'center'}>
                      <Box
                        fontSize={'xs'}
                        fontWeight={'medium'}
                        color={'myGray.600'}
                        whiteSpace={'nowrap'}
                      >
                        {t('workflow:auth_tmb_id')}
                      </Box>
                      <QuestionTip ml={1} label={t('workflow:auth_tmb_id_tip')} />
                      <Switch
                        ml={2}
                        size={'sm'}
                        isChecked={!!authTmbIdInput.value}
                        onChange={(e) => onChangeAuthTmbId(e.target.checked)}
                      />
                    </Flex>
                  )}
                  <Button
                    variant={'transparentBase'}
                    leftIcon={<MyIcon name={'edit'} w={'12px'} />}
                    iconSpacing={1}
                    size={'xs'}
                    mr={'-5px'}
                    color={'myGray.600'}
                    onClick={onOpenDatasetParams}
                  >
                    {t('common:Params')}
                  </Button>
                </HStack>
              }
            />
            <Box mt={2} className={'nodrag'}>
              {datasetSelectRenderType === FlowNodeInputTypeEnum.selectDataset ? (
                <>
                  <Grid
                    gridTemplateColumns={'repeat(2, minmax(0, 1fr))'}
                    gridGap={3}
                    minW={'350px'}
                    w={'100%'}
                  >
                    <MyTooltip
                      label={t('common:core.chat.Select dataset')}
                      {...chooseButtonTooltipProps}
                    >
                      <Button
                        variant={'primaryOutline'}
                        h={10}
                        w={'100%'}
                        leftIcon={<MyIcon name={'common/selectLight'} w={'14px'} />}
                        onClick={onOpenDatasetSelect}
                      >
                        {t('common:Choose')}
                      </Button>
                    </MyTooltip>
                    {selectedDatasets.map((dataset) => (
                      <DatasetCard
                        key={dataset.datasetId}
                        dataset={dataset}
                        flexProps={{
                          h: 10,
                          px: 3,
                          py: 2.5,
                          boxShadow: 'none'
                        }}
                        onDelete={(datasetId) => {
                          if (!datasetSelectInput) return;
                          onChangeNode({
                            nodeId,
                            key: NodeInputKeyEnum.datasetSelectList,
                            type: 'updateInput',
                            value: {
                              ...datasetSelectInput,
                              value: selectedDatasets.filter((item) => item.datasetId !== datasetId)
                            }
                          });
                        }}
                      />
                    ))}
                  </Grid>
                  {isOpenDatasetSelect && (
                    <DatasetSelectModal
                      defaultSelectedDatasets={selectedDatasets.map((d) => ({
                        datasetId: d.datasetId,
                        name: d.name,
                        avatar: d.avatar,
                        vectorModel: d.vectorModel,
                        error: d.error
                      }))}
                      onChange={(e) => {
                        if (!datasetSelectInput) return;
                        onChangeNode({
                          nodeId,
                          key: NodeInputKeyEnum.datasetSelectList,
                          type: 'updateInput',
                          value: { ...datasetSelectInput, value: e }
                        });
                      }}
                      onClose={onCloseDatasetSelect}
                    />
                  )}
                </>
              ) : (
                <ReferenceRender inputs={inputs} item={datasetSelectInput} nodeId={nodeId} />
              )}
            </Box>
          </Box>
        )}

        {/* 7. Chat inputs (history, userChatInput) */}
        {chatInputs.length > 0 && (
          <RenderInput nodeId={nodeId} flowInputList={chatInputs} isTool={isTool} />
        )}
      </Container>

      {successOutputs.length > 0 && (
        <Container>
          <IOTitle text={t('common:Output')} nodeId={nodeId} catchError={catchError} />
          <RenderOutput nodeId={nodeId} flowOutputList={successOutputs} />
        </Container>
      )}
      {catchError && <CatchError nodeId={nodeId} errorOutputs={errorOutputs} />}

      <SkillModal />

      <ConfirmModal />
      {isOpenRecharge && (
        <RechargeModal
          onClose={onCloseRecharge}
          onPaySuccess={() => {
            onCloseRecharge();
          }}
        />
      )}

      {isOpenDatasetParams && (
        <DatasetParamsModal
          {...datasetParamsData}
          maxTokens={llmMaxQuoteContext}
          showTagFilter={!!feConfigs?.isPlus}
          datasetIds={datasetIds}
          tagFilterReferenceList={tagFilterReferenceList}
          onClose={onCloseDatasetParams}
          onSuccess={(e) => {
            for (const input of getDatasetSearchParamInputs({ inputs, values: e })) {
              if (inputs.some((item) => item.key === input.key)) {
                onChangeNode({ nodeId, type: 'updateInput', key: input.key, value: input });
              } else {
                onChangeNode({ nodeId, type: 'addInput', value: input });
              }
            }
          }}
        />
      )}
    </NodeCard>
  );
};

export default React.memo(NodeAgent);
