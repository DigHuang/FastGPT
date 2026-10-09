import { TmpDataEnum } from '@fastgpt/global/support/tmpData/constants';
import { MongoTmpData } from '@fastgpt/service/support/tmpData/schema';
import { setTmpData } from '@fastgpt/service/support/tmpData/controller';
import {
  clearAllMyModelsCache,
  clearMyModelsCache
} from '@fastgpt/service/support/permission/model/cache';
import { Types } from '@fastgpt/service/common/mongo';
import { beforeEach, describe, expect, it } from 'vitest';

describe('model catalog cache invalidation', () => {
  beforeEach(async () => {
    await MongoTmpData.deleteMany({});
  });

  it('deletes only caches belonging to the changed team', async () => {
    const firstTeamId = new Types.ObjectId().toString();
    const secondTeamId = new Types.ObjectId().toString();
    const firstTmbId = new Types.ObjectId().toString();
    const secondTmbId = new Types.ObjectId().toString();

    await Promise.all([
      setTmpData({
        type: TmpDataEnum.MyModels,
        metadata: { teamId: firstTeamId, tmbId: firstTmbId },
        data: { teamId: firstTeamId, tmbId: firstTmbId, modelIds: [], version: 'first' }
      }),
      setTmpData({
        type: TmpDataEnum.MyModels,
        metadata: { teamId: firstTeamId, tmbId: secondTmbId },
        data: { teamId: firstTeamId, tmbId: secondTmbId, modelIds: [], version: 'second' }
      }),
      setTmpData({
        type: TmpDataEnum.MyModels,
        metadata: { teamId: secondTeamId, tmbId: firstTmbId },
        data: { teamId: secondTeamId, tmbId: firstTmbId, modelIds: [], version: 'third' }
      })
    ]);

    await clearMyModelsCache({ teamId: firstTeamId });

    await expect(MongoTmpData.countDocuments({ 'data.teamId': firstTeamId })).resolves.toBe(0);
    await expect(MongoTmpData.countDocuments({ 'data.teamId': secondTeamId })).resolves.toBe(1);
  });

  it('deletes every model cache without deleting unrelated temporary data', async () => {
    const firstTeamId = new Types.ObjectId().toString();
    const secondTeamId = new Types.ObjectId().toString();
    const firstTmbId = new Types.ObjectId().toString();
    const secondTmbId = new Types.ObjectId().toString();

    await Promise.all([
      setTmpData({
        type: TmpDataEnum.MyModels,
        metadata: { teamId: firstTeamId, tmbId: firstTmbId },
        data: { teamId: firstTeamId, tmbId: firstTmbId, modelIds: [], version: 'first' }
      }),
      setTmpData({
        type: TmpDataEnum.MyModels,
        metadata: { teamId: secondTeamId, tmbId: secondTmbId },
        data: { teamId: secondTeamId, tmbId: secondTmbId, modelIds: [], version: 'second' }
      }),
      MongoTmpData.create({
        dataId: ['unrelated', firstTeamId, firstTmbId].join('--'),
        data: { teamId: firstTeamId, tmbId: firstTmbId },
        expireAt: new Date(Date.now() + 60_000)
      })
    ]);

    await clearAllMyModelsCache();

    await expect(MongoTmpData.countDocuments({ dataId: { $regex: /^my_models--/ } })).resolves.toBe(
      0
    );
    await expect(MongoTmpData.countDocuments({ dataId: /^unrelated--/ })).resolves.toBe(1);
  });
});
