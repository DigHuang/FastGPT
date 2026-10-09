import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelScopeEnum, ModelTypeEnum } from '@fastgpt/global/core/ai/constants';

import { MongoAIModel } from '@fastgpt/service/core/ai/model/schema';
import { MongoAIDefaultModel } from '@fastgpt/service/core/ai/model/default/schema';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import {
  readModelCatalogRevision,
  readModelCatalogSnapshot,
  runModelTransaction
} from '@fastgpt/service/core/ai/model/entity';

// setup 已载入无事务 mock；修改同一 mock 函数的实现，让本文件使用真实 replica-set 事务。
beforeAll(async () => {
  const { mongoSessionRun: actualMongoSessionRun } = await vi.importActual<
    typeof import('@fastgpt/service/common/mongo/sessionRun')
  >('@fastgpt/service/common/mongo/sessionRun');
  vi.mocked(mongoSessionRun).mockImplementation(actualMongoSessionRun);
});

const modelData = {
  scope: ModelScopeEnum.system,
  type: ModelTypeEnum.llm,
  provider: 'OpenAI',
  model: 'transaction-model',
  name: 'Transaction model',
  isActive: true,
  config: { maxContext: 16000, maxResponse: 8000, quoteMaxToken: 12000 }
};

beforeEach(async () => {
  await Promise.all([MongoAIModel.deleteMany({}), MongoAIDefaultModel.deleteMany({})]);
});

describe('runModelTransaction', () => {
  it('commits model data, defaults and their revision together and returns the callback result', async () => {
    const modelId = await runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
      expect(session.inTransaction()).toBe(true);
      const [model] = await MongoAIModel.create([modelData], { session });
      await MongoAIDefaultModel.updateOne(
        { scope: ModelScopeEnum.system },
        { $set: { defaultModelIds: { llm: String(model._id) } } },
        { session }
      );
      return String(model._id);
    });

    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(1);
    await expect(readModelCatalogSnapshot({ scope: ModelScopeEnum.system })).resolves.toMatchObject(
      {
        models: [{ model: modelData.model }],
        defaultModelIds: { llm: modelId },
        revision: 1
      }
    );
  });

  it('rolls back both the first revision document and model writes if creation fails', async () => {
    const failure = new Error('abort initial catalog write');

    await expect(
      runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
        await MongoAIModel.create([modelData], { session });
        throw failure;
      })
    ).rejects.toBe(failure);

    await expect(MongoAIModel.countDocuments({})).resolves.toBe(0);
    await expect(MongoAIDefaultModel.countDocuments({})).resolves.toBe(0);
    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(0);
  });

  it('rolls back an existing revision, model and defaults after a business failure', async () => {
    const model = await MongoAIModel.create(modelData);
    await MongoAIDefaultModel.create({
      scope: ModelScopeEnum.system,
      catalogRevision: 7,
      defaultModelIds: { llm: String(model._id) }
    });
    const failure = new Error('abort catalog update');

    await expect(
      runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
        await MongoAIModel.updateOne(
          { _id: model._id },
          { $set: { name: 'Changed' } },
          { session }
        );
        await MongoAIDefaultModel.updateOne(
          { scope: ModelScopeEnum.system },
          { $set: { defaultModelIds: {} } },
          { session }
        );
        throw failure;
      })
    ).rejects.toBe(failure);

    await expect(readModelCatalogSnapshot({ scope: ModelScopeEnum.system })).resolves.toMatchObject(
      {
        models: [{ model: modelData.model, name: modelData.name }],
        defaultModelIds: { llm: String(model._id) },
        revision: 7
      }
    );
  });

  it('serializes concurrent commits without losing revisions or model updates', async () => {
    // 预建单例，将用例聚焦在目录写冲突重试，而非集合/索引初始化竞态。
    await MongoAIDefaultModel.create({ scope: ModelScopeEnum.system, catalogRevision: 0 });

    await Promise.all(
      ['model-a', 'model-b', 'model-c'].map((model) =>
        runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
          await MongoAIModel.create([{ ...modelData, model }], { session });
        })
      )
    );

    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(3);
    const snapshot = await readModelCatalogSnapshot({ scope: ModelScopeEnum.system });
    expect(snapshot.revision).toBe(3);
    expect(snapshot.models.map(({ model }) => model).sort()).toEqual([
      'model-a',
      'model-b',
      'model-c'
    ]);
  });
});

describe('readModelCatalogRevision', () => {
  it('uses revision zero for an empty catalog and historical records without a revision', async () => {
    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(0);
    await MongoAIDefaultModel.collection.insertOne({
      scope: ModelScopeEnum.system,
      defaultModelIds: {}
    });

    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(0);
    await runModelTransaction({ scope: ModelScopeEnum.system }, async () => 'migrated');
    await expect(readModelCatalogRevision({ scope: ModelScopeEnum.system })).resolves.toBe(1);
  });
});

describe('readModelCatalogSnapshot', () => {
  it('returns empty defaults and revision zero when no catalog exists', async () => {
    await expect(readModelCatalogSnapshot({ scope: ModelScopeEnum.system })).resolves.toEqual({
      models: [],
      defaultModelIds: {},
      revision: 0
    });
  });

  it('orders models newest first and strictly excludes team models from system snapshot', async () => {
    const sampleTmbId = '68ad85a7463006c963799a05';
    await MongoAIModel.create([
      { ...modelData, model: 'first' },
      { ...modelData, model: 'second' },
      { ...modelData, scope: ModelScopeEnum.team, tmbId: sampleTmbId, model: 'team-only' }
    ]);

    const found = await MongoAIModel.findOne({ scope: ModelScopeEnum.team, tmbId: sampleTmbId });
    expect(found).toBeDefined();

    const snapshot = await readModelCatalogSnapshot({ scope: ModelScopeEnum.system });

    expect(snapshot.models.map(({ model }) => model)).toEqual(['second', 'first']);
    expect(snapshot.models.some(({ model }) => model === 'team-only')).toBe(false);
    expect(snapshot.defaultModelIds).toEqual({});
    expect(snapshot.revision).toBe(0);
  });

  it('does not expose in-flight data with the uncommitted revision', async () => {
    const model = await MongoAIModel.create(modelData);
    await MongoAIDefaultModel.create({ scope: ModelScopeEnum.system, catalogRevision: 4 });

    await runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
      await MongoAIModel.updateOne(
        { _id: model._id },
        { $set: { name: 'Committed name' } },
        { session }
      );
      await MongoAIDefaultModel.updateOne(
        { scope: ModelScopeEnum.system },
        { $set: { defaultModelIds: { llm: String(model._id) } } },
        { session }
      );

      // 独立读事务在写事务提交前只能看到完整的旧目录。
      await expect(
        readModelCatalogSnapshot({ scope: ModelScopeEnum.system })
      ).resolves.toMatchObject({
        models: [{ name: modelData.name }],
        defaultModelIds: {},
        revision: 4
      });
    });

    await expect(readModelCatalogSnapshot({ scope: ModelScopeEnum.system })).resolves.toMatchObject(
      {
        models: [{ name: 'Committed name' }],
        defaultModelIds: { llm: String(model._id) },
        revision: 5
      }
    );
  });

  it('rejects invalid persisted default identifiers instead of publishing a partial snapshot', async () => {
    await MongoAIDefaultModel.collection.insertOne({
      scope: ModelScopeEnum.system,
      catalogRevision: 1,
      defaultModelIds: { llm: 123 }
    });

    await expect(readModelCatalogSnapshot({ scope: ModelScopeEnum.system })).rejects.toThrow();
  });
});
