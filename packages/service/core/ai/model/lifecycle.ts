import type { SystemModelDocumentDataType } from '@fastgpt/global/core/ai/model/schema';
import type {
  CreateModelResponse,
  UpdateModelBody
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ChannelType } from '@fastgpt/global/core/ai/model/scope';
import { getLogger, LogCategories } from '../../../common/logger';
import {
  appendModelToChannels,
  removeModelsFromChannels,
  syncModelNameInChannels
} from './channel/binding';
import { importSystemModels } from './import';
import { createModel, deleteModels, updateModel, restoreModelName } from './mutation';

const logger = getLogger(LogCategories.MODULE.AI.MODEL);

/**
 * 聚合创建模型与其渠道快捷绑定的通用生命周期服务。
 * 1. 调用 createModel 在 Mongo 中完成唯一性校验与事务落库；
 * 2. 若传入 channelIds，调用 appendModelToChannels 进行渠道快捷关联；
 * 3. 渠道绑定属于非强一致副作用，如果追加失败由底层记录日志并安全吞错，不破坏模型已创建成功的事实。
 */
export const createModelWithLifecycle = async ({
  modelData,
  channelType,
  channelIds,
  tmbId,
  teamId
}: {
  modelData: SystemModelDocumentDataType;
  channelType: ChannelType;
  channelIds?: number[];
  tmbId?: string;
  teamId?: string;
}): Promise<CreateModelResponse> => {
  const createResult = await createModel({
    modelData,
    channelType,
    tmbId,
    teamId
  });

  if (channelIds && channelIds.length > 0) {
    await appendModelToChannels({
      channelIds,
      model: modelData.model,
      channelType,
      tmbId: channelType === 'team' ? (tmbId ?? '') : ''
    });
  }

  return createResult;
};

/**
 * 聚合更新模型配置并自动同步渠道上游映射的通用生命周期服务。
 * 1. 自动注入 syncModelNameInChannels；
 * 2. 当模型标识发生变更时，协调更新 Mongo 并在模型所属的作用域桶内同步全部渠道的 models 与 model_mapping；
 * 3. 若渠道同步失败，由底层触发补偿回滚保持两端一致。
 */
export const updateModelWithLifecycle = async (
  props: UpdateModelBody & { tmbId?: string; teamId?: string }
): Promise<void> => {
  const change = await updateModel(props);
  await synchronizeModelRenames({
    changes: [change],
    channelType: props.channelType,
    tmbId: props.tmbId,
    teamId: props.teamId
  });
};

/** 普通编辑和 JSON 导入共用改名副作用；渠道内部回滚后补偿 Mongo 名称，失败保留明确诊断。 */
const synchronizeModelRenames = async ({
  changes,
  channelType,
  tmbId,
  teamId
}: {
  changes: { modelId: string; oldModel: string; newModel: string }[];
  channelType: ChannelType;
  tmbId?: string;
  teamId?: string;
}) => {
  const failures: unknown[] = [];
  for (const change of changes) {
    if (change.oldModel === change.newModel) continue;
    try {
      await syncModelNameInChannels({ ...change, channelType, tmbId: tmbId ?? '' });
    } catch (error) {
      await restoreModelName({ ...change, channelType, tmbId, teamId }).catch((rollbackError) => {
        logger.error('Rollback model name after channel failure failed', {
          ...change,
          rollbackError
        });
      });
      failures.push(error);
    }
  }
  // 导入中的各个改名独立提交，某一项失败也要继续同步后续项，避免留下未处理的 Mongo 名称。
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Multiple model channel renames failed');
};

/** JSON 替换与普通 CRUD 共用渠道改名和删除清理，避免导入后留下过期渠道引用。 */
export const importSystemModelsWithLifecycle = async (
  props: Parameters<typeof importSystemModels>[0]
) => {
  const changes = await importSystemModels(props);
  try {
    await synchronizeModelRenames({ changes: changes.renamedModels, channelType: 'system' });
  } finally {
    await cleanDeletedModelChannels({ models: changes.removedModels, channelType: 'system' });
  }
};

/** 删除已经提交，渠道清理失败只记录诊断，不能将成功删除误报为数据库失败。 */
const cleanDeletedModelChannels = async ({
  models,
  channelType,
  tmbId
}: {
  models: string[];
  channelType: ChannelType;
  tmbId?: string;
}) => {
  if (models.length === 0) return;
  await removeModelsFromChannels({ models, channelType, tmbId: tmbId ?? '' }).catch((error) => {
    logger.error('Clean up channel mappings after model deletion failed', {
      channelType,
      models,
      error
    });
  });
};

/**
 * 聚合删除模型及其渠道映射清理的通用生命周期服务。
 * 1. 调用 deleteModels 在 Mongo 事务中删除模型实体、关联探测历史与权限记录，并返回已删除模型的 model 标识列表；
 * 2. 自动调用 removeModelsFromChannels 清理 AIProxy 渠道中对这些已删除模型引用的 models 与 model_mapping 映射；
 * 3. 渠道映射清理属于 AIProxy 侧副作用，若失败仅记录错误日志，不回滚已成功删除的 Mongo 实体。
 */
export const deleteModelsWithLifecycle = async (props: {
  modelIds: string[];
  channelType: ChannelType;
  tmbId?: string;
  teamId?: string;
}): Promise<string[]> => {
  const deletedModels = await deleteModels(props);
  await cleanDeletedModelChannels({
    models: deletedModels,
    channelType: props.channelType,
    tmbId: props.tmbId
  });
  return deletedModels;
};
