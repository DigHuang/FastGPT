import { describe, expect, it, vi } from 'vitest';
import type { ChatHistoryItemResType } from '@fastgpt/global/core/chat/type';
import {
  ModerationActionEnum,
  ModerationStageEnum
} from '@fastgpt/global/core/plugin/moderation/constants';
import { SseResponseEventEnum } from '@fastgpt/global/core/workflow/runtime/constants';
import { workflowSseEvent } from '@fastgpt/global/core/workflow/runtime/sse';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import {
  filterWorkflowFinalResponseData,
  finishWorkflowStreamResponse,
  getWorkflowDatasetCiteRetention,
  getWorkflowFinalResponseError,
  shouldRetainWorkflowNodeResponses
} from '@/service/core/workflow/nodeResponse';
import { createModerationFilteredWorkflowResponse } from '@fastgpt/service/core/workflow/dispatch/context/streamResponse';

describe('completion moderation visibility', () => {
  const child: ChatHistoryItemResType = {
    id: 'child',
    nodeId: 'child',
    moduleName: 'Answer',
    moduleType: FlowNodeTypeEnum.answerNode,
    error: 'Content blocked',
    moderationRecords: [
      {
        stage: ModerationStageEnum.output,
        actionTaken: ModerationActionEnum.block,
        verdict: 'block',
        content: 'private audit text',
        keywords: ['private']
      }
    ]
  };
  const response: ChatHistoryItemResType = {
    ...child,
    id: 'parent',
    nodeId: 'parent',
    moduleType: FlowNodeTypeEnum.chatNode,
    childrenResponses: [child]
  };

  it.each([false, undefined])(
    'hides audit details without explicit write permission: %s',
    (permission) => {
      const result = filterWorkflowFinalResponseData({
        responseData: [response],
        responseAllData: true,
        canReadModerationRecords: permission
      });
      expect(result[0].error).toBe('Content blocked');
      expect(result[0].moderationRecords).toBeUndefined();
      expect(result[0].childrenResponses?.[0].moderationRecords).toBeUndefined();
      expect(response.moderationRecords).toBeDefined();
      expect(child.moderationRecords).toBeDefined();
    }
  );

  it('preserves audit details for writers requesting full responses', () => {
    expect(
      filterWorkflowFinalResponseData({
        responseData: [response],
        responseAllData: true,
        canReadModerationRecords: true
      })
    ).toEqual([response]);
  });

  it('keeps public field filtering even when the caller has write permission', () => {
    const result = filterWorkflowFinalResponseData({
      responseData: [{ ...response, moduleType: FlowNodeTypeEnum.toolCall }],
      responseAllData: false,
      canReadModerationRecords: true
    });
    expect(result[0].moderationRecords).toBeUndefined();
  });

  it.each([false, undefined, true])(
    'filters node SSE before writing without changing other events: %s',
    (permission) => {
      const responseWrite = vi.fn();
      const write = createModerationFilteredWorkflowResponse({
        responseWrite,
        canReadModerationRecords: permission
      });
      const event = workflowSseEvent.flowNodeResponse(response);
      write(event);
      const emitted = responseWrite.mock.calls[0][0];
      expect(emitted.data.error).toBe('Content blocked');
      expect(emitted.data.moderationRecords).toEqual(
        permission ? response.moderationRecords : undefined
      );
      expect(emitted.data.childrenResponses[0].moderationRecords).toEqual(
        permission ? child.moderationRecords : undefined
      );
      expect(response.moderationRecords).toBeDefined();
      const answer = workflowSseEvent.answerDelta('approved text');
      write(answer);
      expect(responseWrite).toHaveBeenLastCalledWith(answer);
    }
  );
});

describe('workflow dataset cite visibility', () => {
  it.each([
    {
      name: '关闭 Share 引用时内部保留、最终 JSON 隐藏引用标记',
      input: { requestedRetainDatasetCite: true, showCite: false, isShare: true },
      expectedWorkflowRetain: true,
      expectedJsonRetain: false
    },
    {
      name: 'Share 请求主动关闭引用时内部仍保留、最终 JSON 隐藏引用标记',
      input: { requestedRetainDatasetCite: false, showCite: true, isShare: true },
      expectedWorkflowRetain: true,
      expectedJsonRetain: false
    },
    {
      name: '请求和权限都开启时最终 JSON 保留引用标记',
      input: { requestedRetainDatasetCite: true, showCite: true, isShare: true },
      expectedWorkflowRetain: true,
      expectedJsonRetain: true
    },
    {
      name: '普通 API 请求关闭引用时保持原语义',
      input: { requestedRetainDatasetCite: false, showCite: true, isShare: false },
      expectedWorkflowRetain: false,
      expectedJsonRetain: false
    }
  ] as const)('$name', ({ input, expectedWorkflowRetain, expectedJsonRetain }) => {
    expect(getWorkflowDatasetCiteRetention(input)).toEqual({
      workflowRetainDatasetCite: expectedWorkflowRetain,
      jsonRetainDatasetCite: expectedJsonRetain
    });
  });
});

describe('shouldRetainWorkflowNodeResponses', () => {
  it.each([
    {
      name: 'V1 流式详情需要在结束时返回完整数组',
      input: { apiVersion: 'v1', stream: true, detail: true, isShare: false },
      expected: true
    },
    {
      name: 'V1 非详情且非 Share 不保留',
      input: { apiVersion: 'v1', stream: true, detail: false, isShare: false },
      expected: false
    },
    {
      name: 'V2 流式详情由客户端逐条拼接，不保留完整数组',
      input: { apiVersion: 'v2', stream: true, detail: true, isShare: false },
      expected: false
    },
    {
      name: 'V2 非流式详情需要返回 JSON 数组',
      input: { apiVersion: 'v2', stream: false, detail: true, isShare: false },
      expected: true
    },
    {
      name: 'V2 Share 为既有远程回调保留完整数组',
      input: { apiVersion: 'v2', stream: true, detail: true, isShare: true },
      expected: true
    }
  ] as const)('$name', ({ input, expected }) => {
    expect(shouldRetainWorkflowNodeResponses(input)).toBe(expected);
  });
});

describe('getWorkflowFinalResponseError', () => {
  it('returns workflowRuntimeSummary.errorText directly when present', () => {
    expect(
      getWorkflowFinalResponseError({
        workflowRuntimeSummary: {
          responseIds: [],
          finishedNodeIds: [],
          errorText: 'Root node failed',
          errorCount: 1,
          hasLoopRunBreak: false,
          hasToolStop: false,
          hasNestedEnd: false,
          citeCollectionIds: [],
          llmInputTokens: 0,
          llmOutputTokens: 0,
          totalPoints: 10
        },
        finalResponseData: [
          {
            id: 'node-1',
            moduleType: FlowNodeTypeEnum.chatNode,
            errorText: 'Different error'
          }
        ]
      })
    ).toBe('Root node failed');
  });

  it('delegates to findFailedResponseNode when summary has no errorText', () => {
    expect(
      getWorkflowFinalResponseError({
        finalResponseData: [
          {
            id: 'llm-node',
            moduleType: FlowNodeTypeEnum.chatNode,
            error: { message: 'OpenAI API key expired' }
          }
        ]
      })
    ).toEqual({ message: 'OpenAI API key expired' });
  });

  it('returns undefined when finalResponseData has no failure', () => {
    expect(
      getWorkflowFinalResponseError({
        finalResponseData: [
          {
            id: 'sandbox-tool-node',
            moduleType: FlowNodeTypeEnum.tool,
            errorText: 'Tool error: file not found'
          }
        ]
      })
    ).toBeUndefined();
  });
});

describe('finishWorkflowStreamResponse', () => {
  it('writes stream error for V2 when finalError was not emitted via flowNodeResponse', () => {
    const responseWrite = vi.fn();
    const writeStreamError = vi.fn();

    finishWorkflowStreamResponse({
      apiVersion: 'v2',
      detail: true,
      finalError: 'Sandbox error: unavailable',
      hasEmittedStreamNodeError: false,
      responseWrite,
      writeStreamError
    });

    expect(responseWrite).toHaveBeenCalledTimes(1);
    expect(responseWrite.mock.calls[0]?.[0]?.event).toBe(SseResponseEventEnum.answer);
    expect(writeStreamError).toHaveBeenCalledWith('Sandbox error: unavailable');
  });

  it('writes stream error for V2 when detail is false even if sink emitted node errors', () => {
    const responseWrite = vi.fn();
    const writeStreamError = vi.fn();

    finishWorkflowStreamResponse({
      apiVersion: 'v2',
      detail: false,
      finalError: 'Upstream failed',
      hasEmittedStreamNodeError: true,
      responseWrite,
      writeStreamError
    });

    expect(writeStreamError).toHaveBeenCalledWith('Upstream failed');
    expect(responseWrite.mock.calls.some(([payload]) => payload.data === '[DONE]')).toBe(false);
  });

  it('finishes normally without duplicate stream error when V2 already emitted the failed node', () => {
    const responseWrite = vi.fn();
    const writeStreamError = vi.fn();

    finishWorkflowStreamResponse({
      apiVersion: 'v2',
      detail: true,
      finalError: 'Sandbox error: unavailable',
      hasEmittedStreamNodeError: true,
      responseWrite,
      writeStreamError
    });

    expect(writeStreamError).not.toHaveBeenCalled();
    expect(responseWrite.mock.calls.at(-1)?.[0]).toEqual({
      event: SseResponseEventEnum.answer,
      data: '[DONE]'
    });
  });

  it('writes stream error for V1 when detail is true but filtered feResponseData drops the failing node', () => {
    const responseWrite = vi.fn();
    const writeStreamError = vi.fn();

    finishWorkflowStreamResponse({
      apiVersion: 'v1',
      detail: true,
      finalError: 'HTTP node failed',
      feResponseData: [],
      responseWrite,
      writeStreamError
    });

    expect(
      responseWrite.mock.calls.some(
        ([payload]) => payload.event === SseResponseEventEnum.flowResponses && payload.data === '[]'
      )
    ).toBe(true);
    expect(writeStreamError).toHaveBeenCalledWith('HTTP node failed');
  });

  it('finishes normally for V1 when feResponseData already contains the failed node', () => {
    const responseWrite = vi.fn();
    const writeStreamError = vi.fn();

    finishWorkflowStreamResponse({
      apiVersion: 'v1',
      detail: true,
      finalError: 'Agent failed',
      feResponseData: [
        {
          id: 'agent-1',
          moduleType: FlowNodeTypeEnum.agent,
          errorText: 'Agent failed'
        }
      ],
      responseWrite,
      writeStreamError
    });

    expect(writeStreamError).not.toHaveBeenCalled();
    expect(responseWrite.mock.calls.at(-1)?.[0]).toEqual({
      event: SseResponseEventEnum.answer,
      data: '[DONE]'
    });
  });
});
