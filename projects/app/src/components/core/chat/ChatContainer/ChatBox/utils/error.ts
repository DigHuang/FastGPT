import type { ErrorTextItemType } from '@fastgpt/global/core/chat/type';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * 统一解析聊天气泡的未捕获错误展示信息，供 ChatItem 错误卡片与 AIChatBubble 空态判定共用。
 *
 * 优先采用节点详情派生的 errorText（可保留 moduleName）；当历史记录裁剪节点详情或由
 * SSE `event: error` 兜底时，回退至 chat.errorMsg。
 */
export const resolveChatItemInlineError = ({
  errorMsg,
  errorText,
  fallbackModuleName,
  errorPrefix,
  translate
}: {
  errorMsg?: string;
  errorText?: ErrorTextItemType;
  fallbackModuleName?: string;
  errorPrefix: string;
  translate: TranslateFn;
}): { title: string; message: string } | undefined => {
  if (!errorMsg && !errorText) return undefined;

  const moduleName = errorText?.moduleName || fallbackModuleName;
  return {
    title: moduleName ? `${errorPrefix} - ${translate(moduleName)}` : errorPrefix,
    message: translate(errorText?.errorText || errorMsg || 'Unknow error')
  };
};

/**
 * 控制聊天气泡底部错误卡片的展示时机。
 * 正在生成的最后一条消息可能先收到节点错误再继续产出内容，生成中先隐藏，结束后再展示最终错误。
 */
export const shouldShowChatItemInlineError = ({
  hasInlineError,
  isChatting,
  isLastChild
}: {
  hasInlineError: boolean;
  isChatting: boolean;
  isLastChild: boolean;
}) => {
  return hasInlineError && !(isChatting && isLastChild);
};
