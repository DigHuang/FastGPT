import type { ChatHistoryItemResType } from '@fastgpt/global/core/chat/type';
import {
  filterNodeResponseTreeData,
  findFailedResponseNode,
  stripModerationRecordsFromNodeResponses
} from '@fastgpt/global/core/chat/utils';
import { getChildrenResponses } from '@fastgpt/global/core/chat/utils/mergeNode';
import { SseResponseEventEnum } from '@fastgpt/global/core/workflow/runtime/constants';
import {
  workflowSseEvent,
  type WorkflowResponseType
} from '@fastgpt/global/core/workflow/runtime/sse';
import { composeNodeResponseDetail } from '@fastgpt/service/core/chat/nodeResponseStorage';
import type {
  WorkflowDebugResponse,
  WorkflowRuntimeSummaryType
} from '@fastgpt/service/core/workflow/dispatch/type';

/**
 * 拆分 workflow 内部引用保留策略和当前请求的公开返回策略。
 *
 * 聊天记录需要保留引用 ID，才能让日志和后续重新开启引用展示时恢复引用。SSE 文本不在
 * 这里裁剪；stream=false 的最终 JSON 正文继续同时受请求参数和访问配置约束。
 */
export const getWorkflowDatasetCiteRetention = ({
  requestedRetainDatasetCite,
  showCite,
  isShare
}: {
  requestedRetainDatasetCite: boolean;
  showCite: boolean;
  isShare: boolean;
}) => {
  const jsonRetainDatasetCite = requestedRetainDatasetCite && showCite;

  return {
    // Share 内部始终保留引用关联供日志恢复；普通 API 保持原参数语义。
    workflowRetainDatasetCite: isShare ? true : jsonRetainDatasetCite,
    jsonRetainDatasetCite
  };
};

/**
 * 判断当前 completions 请求是否必须在服务端保留完整 nodeResponse 数组。
 *
 * V1 需要在结束时一次性返回详情；V2 流式普通请求由客户端逐条拼接。Share 仍保留数组，
 * 供既有的 pushResult2Remote 完成回调使用。
 */
export const shouldRetainWorkflowNodeResponses = ({
  apiVersion,
  stream,
  detail,
  isShare
}: {
  apiVersion: 'v1' | 'v2';
  stream: boolean;
  detail: boolean;
  isShare: boolean;
}) => {
  if (apiVersion === 'v1') {
    return detail || isShare;
  }

  return (!stream && detail) || isShare;
};

/**
 * 从 dispatch 返回的 flat nodeResponses 组合 workflow 最终详情。
 *
 * writer 只在请求内保留规范化后的扁平节点数据，业务入口需要最终 responseData 时再在这里
 * 拼回 childrenResponses，避免 writer 同时承担持久化和展示格式化两种职责。
 */
export const getWorkflowFinalResponseData = ({
  flatNodeResponses,
  shouldCollect
}: {
  flatNodeResponses?: ChatHistoryItemResType[];
  shouldCollect: boolean;
}): ChatHistoryItemResType[] =>
  shouldCollect
    ? composeNodeResponseDetail(flatNodeResponses?.map((response) => ({ data: response })) || [])
    : [];

/**
 * 按 completions 参数过滤最终 responseData。
 *
 * `responseAllData` 直接返回完整详情；否则保留前端拼树需要的最小字段，按
 * `responseDetail` 控制引用内容等敏感/大字段是否透出。
 */
export const filterWorkflowFinalResponseData = ({
  responseData,
  responseAllData,
  responseDetail,
  canReadModerationRecords = false
}: {
  responseData: ChatHistoryItemResType[];
  responseAllData?: boolean;
  responseDetail?: boolean;
  canReadModerationRecords?: boolean;
}) => {
  if (responseAllData) {
    return canReadModerationRecords
      ? responseData
      : stripModerationRecordsFromNodeResponses(responseData);
  }
  return filterNodeResponseTreeData({ nodeResponses: responseData, responseDetail });
};

/**
 * 将完整 responseData 树转换成 debug 面板按 nodeId 索引的结构。
 *
 * dispatch 层只负责运行调度和事件转发；debug 接口作为业务入口，自己决定如何把嵌套详情
 * 转换成前端需要的 map，同时保留 dispatch 原本记录的 run/skip/interactive 状态。
 */
export const composeDebugNodeResponseMap = ({
  detailTree,
  currentNodeResponses
}: {
  detailTree: ChatHistoryItemResType[];
  currentNodeResponses: WorkflowDebugResponse['nodeResponses'];
}) => {
  const nodeResponses = { ...currentNodeResponses };

  const visit = (response: ChatHistoryItemResType) => {
    if (response.nodeId) {
      const currentDebugResponse = nodeResponses[response.nodeId];
      nodeResponses[response.nodeId] = {
        ...currentDebugResponse,
        nodeId: response.nodeId,
        type: currentDebugResponse?.type || 'run',
        response
      };
    }

    getChildrenResponses(response).forEach(visit);
  };

  detailTree.forEach(visit);

  return nodeResponses;
};

/**
 * 获取 workflow 执行的最终错误。
 *
 * 优先读取已剔除工具执行错误的 workflowRuntimeSummary.errorText。若 summary 不存在或未记录
 * 根错误，在从 finalResponseData 兜底回退时，统一复用 findFailedResponseNode 提取失败节点，
 * 避免工具执行详情被提升为 API 错误，同时在容器崩溃导致孤儿错误时能够正常兜底暴露。
 */
export const getWorkflowFinalResponseError = ({
  workflowRuntimeSummary,
  finalResponseData = []
}: {
  workflowRuntimeSummary?: WorkflowRuntimeSummaryType;
  finalResponseData?: ChatHistoryItemResType[];
}) => {
  if (workflowRuntimeSummary?.errorText) {
    return workflowRuntimeSummary.errorText;
  }

  const failedNode = findFailedResponseNode(finalResponseData);
  return failedNode?.error || failedNode?.errorText;
};

/**
 * 统一收尾 v1/v2 completions 的流式响应与未捕获错误透出。
 *
 * - 当客户端已通过 V2 实时 `flowNodeResponse` 或 V1 `flowResponses` 收到未捕获失败节点时，
 *   维持既有 `answerStop` + `done` 收尾协议，保留前端从节点响应中提取 `moduleName` 的能力；
 * - 当存在未捕获 `finalError` 但客户端本轮未收到任何失败节点（如 `detail=false`，或
 *   Share/OutLink 下非 `publicNodeMap` 节点报错）时，在 `answerStop` 后复用统一的
 *   `writeStreamError` 发送 `event: error`，避免流静默结束导致前端误判“应用无输出内容”。
 */
export const finishWorkflowStreamResponse = ({
  apiVersion,
  detail,
  finalError,
  hasEmittedStreamNodeError = false,
  feResponseData = [],
  responseWrite,
  writeStreamError
}: {
  apiVersion: 'v1' | 'v2';
  detail: boolean;
  finalError?: unknown;
  hasEmittedStreamNodeError?: boolean;
  feResponseData?: ChatHistoryItemResType[];
  responseWrite: WorkflowResponseType;
  writeStreamError: (error: unknown) => void;
}) => {
  responseWrite(workflowSseEvent.answerStop());

  if (apiVersion === 'v1' && detail) {
    // V1 兼容：flowResponses 的 data 为 JSON 数组字符串。
    responseWrite(
      workflowSseEvent.raw({
        event: SseResponseEventEnum.flowResponses,
        data: JSON.stringify(feResponseData)
      })
    );
  }

  const clientReceivedNodeError =
    detail &&
    (apiVersion === 'v2'
      ? hasEmittedStreamNodeError
      : Boolean(findFailedResponseNode(feResponseData)));

  if (
    finalError !== undefined &&
    finalError !== null &&
    finalError !== '' &&
    !clientReceivedNodeError
  ) {
    writeStreamError(finalError);
    return;
  }

  responseWrite(workflowSseEvent.done(detail ? SseResponseEventEnum.answer : undefined));
};
