import { ModelScopeEnum, ModelTypeEnum } from '@fastgpt/global/core/ai/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authSystemAdmin: vi.fn(),
  authUserPer: vi.fn(),
  findModelData: vi.fn(),
  testModelConnection: vi.fn()
}));
vi.mock('@/service/middleware/entry', () => ({ NextAPI: (handler: unknown) => handler }));
vi.mock('@fastgpt/service/support/permission/user/auth', () => ({
  authSystemAdmin: mocks.authSystemAdmin,
  authUserPer: mocks.authUserPer
}));
vi.mock('@fastgpt/service/core/ai/model', () => ({
  getTeamModelHandle: async () => ({ findModelData: mocks.findModelData })
}));
// API 层只验证身份、入参和草稿/实例选择；真实 Provider 分支与取消语义在 service 测试覆盖。
vi.mock('@fastgpt/service/core/ai/model/test', () => ({
  testModelConnection: mocks.testModelConnection
}));
import handler from '@/pages/api/core/ai/model/test';

const installedModel = {
  modelId: '68ad85a7463006c963799a05',
  type: ModelTypeEnum.llm,
  provider: 'OpenAI',
  model: 'test-routing-model',
  name: 'Test routing model',
  scope: ModelScopeEnum.system,
  isActive: true,
  requestUrl: 'https://model.example.com/v1/chat/completions',
  requestAuth: 'model-secret',
  config: { maxContext: 16000, maxResponse: 8000, quoteMaxToken: 12000 }
};
const { modelId: _id, ...draftModel } = installedModel;

describe('model test API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.feConfigs = { isPlus: true } as typeof global.feConfigs;
    mocks.authSystemAdmin.mockResolvedValue({ teamId: 'root-team', tmbId: 'root-tmb' });
    mocks.authUserPer.mockResolvedValue({
      teamId: 'root-team',
      tmbId: 'root-tmb',
      isRoot: true,
      tmb: { permission: {} }
    });
    mocks.findModelData.mockReturnValue(installedModel);
    mocks.testModelConnection.mockResolvedValue(undefined);
  });

  it('applies an explicit channel to a request-local copy and preserves the cached connection', async () => {
    await handler({
      query: { modelId: installedModel.modelId, channelId: '7', channelType: 'system' }
    } as never);
    expect(mocks.testModelConnection).toHaveBeenCalledWith({
      teamId: 'root-team',
      channelId: 7,
      model: { ...installedModel, requestUrl: undefined, requestAuth: undefined }
    });
    expect(installedModel.requestAuth).toBe('model-secret');
    expect(installedModel.requestUrl).toBe('https://model.example.com/v1/chat/completions');
  });

  it('preserves installed connection settings when no channel is selected', async () => {
    await handler({ query: { modelId: installedModel.modelId, channelType: 'system' } } as never);
    expect(mocks.testModelConnection).toHaveBeenCalledWith({
      model: installedModel,
      teamId: 'root-team',
      channelId: undefined
    });
  });

  it('rejects another member model before invoking the connection test, including root requests', async () => {
    mocks.findModelData.mockReturnValue({
      ...installedModel,
      scope: ModelScopeEnum.team,
      teamId: 'root-team',
      tmbId: 'other-member'
    });
    await expect(
      handler({ query: { modelId: installedModel.modelId, channelType: 'team' } } as never)
    ).rejects.toBe('modelUnExist');
    expect(mocks.testModelConnection).not.toHaveBeenCalled();
  });

  it('tests a POST draft without looking up a persisted model', async () => {
    await handler({
      method: 'POST',
      body: { modelData: draftModel, channelId: 9, channelType: 'system' }
    } as never);
    expect(mocks.findModelData).not.toHaveBeenCalled();
    expect(mocks.testModelConnection).toHaveBeenCalledWith({
      teamId: 'root-team',
      channelId: 9,
      model: expect.objectContaining({
        modelId: 'draft-model-test',
        model: draftModel.model,
        requestUrl: undefined,
        requestAuth: undefined
      })
    });
  });

  it('ignores incomplete billing fields in a preview draft', async () => {
    await handler({
      method: 'POST',
      body: {
        modelData: { ...draftModel, priceTiers: [{ minInputTokens: 0 }] },
        channelId: 9,
        channelType: 'system'
      }
    } as never);
    expect(mocks.testModelConnection.mock.calls[0][0].model).not.toHaveProperty('priceTiers');
  });

  it('rejects a TTS draft without a voice at the request boundary', async () => {
    await expect(
      handler({
        method: 'POST',
        body: {
          modelData: { ...draftModel, type: ModelTypeEnum.tts, config: { voices: [] } },
          channelId: 10,
          channelType: 'system'
        }
      } as never)
    ).rejects.toMatchObject({ name: 'ApiRequestInputParseError' });
    expect(mocks.testModelConnection).not.toHaveBeenCalled();
  });
});
