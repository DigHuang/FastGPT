import { ModelScopeEnum } from '@fastgpt/global/core/ai/constants';
import { Types, type ClientSession } from '../../../common/mongo';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { MongoAIDefaultModel } from './default/schema';
import { ModelDefaultIdsSchema } from '@fastgpt/global/core/ai/model/default';
import { MongoAIModel } from './schema';
import { UserError } from '@fastgpt/global/common/error/utils';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import { MongoModelStatusProbeRecord } from '../modelStatus/schema';
import { MongoResourcePermission } from '../../../support/permission/schema';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';

/** 运行时模型目录必须显式声明作用域；团队目录不能缺省成系统目录。 */
export type ModelCatalogScope =
  | { scope: ModelScopeEnum.system }
  | { scope: ModelScopeEnum.team; teamId: string };

/** 目录身份用于模型查询和版本记录，禁止无效团队身份触发跨域读取。 */
const getCatalogFilter = (context: ModelCatalogScope) => {
  if (context.scope === ModelScopeEnum.system) return { scope: ModelScopeEnum.system };
  if (!Types.ObjectId.isValid(context.teamId)) throw new UserError(ModelErrEnum.unExist);
  return { scope: ModelScopeEnum.team, teamId: context.teamId };
};

/** 目录修订号与模型写入使用同一事务，避免数据成功但失效通知丢失。外部 I/O 不得放入回调。 */
export const runModelTransaction = <T>(
  context: ModelCatalogScope,
  write: (session: ClientSession) => Promise<T>
) =>
  mongoSessionRun(
    async (session) => {
      // 同一目录写入竞争同一版本记录；不同团队不会竞争系统目录或其他团队的写锁。
      await MongoAIDefaultModel.updateOne(
        getCatalogFilter(context),
        { $inc: { catalogRevision: 1 }, $setOnInsert: { defaultModelIds: {} } },
        { upsert: true, session }
      );
      return write(session);
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
  );

/** 主节点上的权威修订号；线性化读取失败时不能把旧进程缓存当成最新目录。 */
export const readModelCatalogRevision = async (context: ModelCatalogScope) => {
  const record = await MongoAIDefaultModel.findOne(getCatalogFilter(context))
    .select({ catalogRevision: 1 })
    .read('primary')
    .readConcern('linearizable')
    .maxTimeMS(10000)
    .lean();
  return record?.catalogRevision ?? 0;
};

/** 模型、默认配置和修订号必须属于同一个快照，不能将新版本号标记到旧数据上。 */
export const readModelCatalogSnapshot = (context: ModelCatalogScope) =>
  mongoSessionRun(
    async (session) => {
      const filter = getCatalogFilter(context);
      const defaults = await MongoAIDefaultModel.findOne(filter).session(session).lean();
      const models = await MongoAIModel.find(filter).sort({ _id: -1 }).session(session).lean();
      return {
        models,
        defaultModelIds: ModelDefaultIdsSchema.parse(defaults?.defaultModelIds ?? {}),
        revision: defaults?.catalogRevision ?? 0
      };
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
  );

/** 删除模型及其派生记录；普通删除与 JSON 替换共用此入口，由上层提供目录事务。 */
export const deleteModelRecords = async (modelIds: string[], session: ClientSession) => {
  await MongoAIModel.deleteMany({ _id: { $in: modelIds } }, { session });
  await MongoResourcePermission.deleteMany(
    {
      resourceType: PerResourceTypeEnum.model,
      resourceId: { $in: modelIds }
    },
    { session }
  );
  await MongoModelStatusProbeRecord.deleteMany({ modelId: { $in: modelIds } }, { session });
};
