import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, Tag, Text } from '@chakra-ui/react';
import { Controller, useWatch, type Control } from 'react-hook-form';
import { useSafeTranslation } from '@fastgpt/web/hooks/useSafeTranslation';
import MyTooltip from '@fastgpt/web/components/common/MyTooltip';
import { getErrorMessage } from '@fastgpt/global/common/error/utils';
import { isValidServiceBaseUrl } from '@fastgpt/global/common/string/url';
import type { SystemInstanceConfigDomainMap } from '@fastgpt/global/common/system/config/schema';
import { AgentSandboxVolumeNamePrefixSchema } from '@fastgpt/global/common/system/config/schemas/subservice';
import type {
  TestSandboxPvcResizeBody,
  TestSandboxPvcResizeErrorCode,
  TestSandboxPvcResizeResponse
} from '@fastgpt/global/openapi/admin/system/instanceConfig/testSandboxPvcResize';
import { POST } from '@/web/common/api/request';
import AdminSwitchRow from '@/pageComponents/admin/settings/AdminSwitchRow';

type SubserviceConfigForm = SystemInstanceConfigDomainMap['subservice'];

type SandboxPvcResizeTestBarProps = {
  control: Control<SubserviceConfigForm>;
  openSandboxApiKey: string | undefined;
  isOpenSandboxApiKeyConfigured: boolean;
  volumeManagerToken: string | undefined;
  isVolumeManagerTokenConfigured: boolean;
};

const CAPABILITY_UNSUPPORTED_ERROR_CODES = new Set<TestSandboxPvcResizeErrorCode>([
  'min_size_too_large',
  'expansion_not_allowed',
  'offline_resize_only'
]);

const formatProbeMiB = (bytes?: number) =>
  bytes !== undefined ? `${Math.round(bytes / (1024 * 1024))} MiB` : '';

/**
 * Kubernetes 动态 PVC 扩容开关与一键端到端实测操作栏。
 *
 * 仅在 Kubernetes 运行时挂载，连接/镜像字段的 `useWatch` 收敛在子组件内部，
 * 避免 Docker 模式或常规输入编辑触发整个 Agent Sandbox 配置页重渲染。
 */
const SandboxPvcResizeTestBar = ({
  control,
  openSandboxApiKey,
  isOpenSandboxApiKeyConfigured,
  volumeManagerToken,
  isVolumeManagerTokenConfigured
}: SandboxPvcResizeTestBarProps) => {
  const { t } = useSafeTranslation();

  const openSandboxBaseUrl = useWatch({
    control,
    name: 'agentSandbox.opensandbox.baseUrl'
  });
  const openSandboxImage = useWatch({
    control,
    name: 'agentSandbox.opensandbox.image'
  });
  const openSandboxUseServerProxy = useWatch({
    control,
    name: 'agentSandbox.opensandbox.useServerProxy'
  });
  const volumeManagerUrl = useWatch({
    control,
    name: 'agentSandbox.opensandbox.volumeManagerUrl'
  });
  const volumeNamePrefix = useWatch({
    control,
    name: 'agentSandbox.opensandbox.volumeNamePrefix'
  });

  const trimmedBaseUrl = openSandboxBaseUrl?.trim() ?? '';
  const trimmedImage = openSandboxImage?.trim() ?? '';
  const trimmedVolumeManagerUrl = volumeManagerUrl?.trim() ?? '';
  const trimmedPrefix = volumeNamePrefix?.trim() ?? '';

  const canRunTest =
    isValidServiceBaseUrl(trimmedBaseUrl) &&
    Boolean(trimmedImage) &&
    isValidServiceBaseUrl(trimmedVolumeManagerUrl) &&
    (!trimmedPrefix || AgentSandboxVolumeNamePrefixSchema.safeParse(trimmedPrefix).success) &&
    (openSandboxApiKey !== undefined
      ? Boolean(openSandboxApiKey.trim())
      : isOpenSandboxApiKeyConfigured) &&
    (volumeManagerToken !== undefined
      ? Boolean(volumeManagerToken.trim())
      : isVolumeManagerTokenConfigured);

  const disabledTooltip = !canRunTest ? t('admin:sandbox_pvc_resize_test_disabled_tip') : undefined;

  const payload = useMemo<TestSandboxPvcResizeBody>(
    () => ({
      baseUrl: trimmedBaseUrl,
      ...(openSandboxApiKey !== undefined
        ? { apiKey: openSandboxApiKey }
        : { useStoredApiKey: isOpenSandboxApiKeyConfigured }),
      image: trimmedImage,
      useServerProxy: openSandboxUseServerProxy ?? true,
      volumeManagerUrl: trimmedVolumeManagerUrl,
      ...(volumeManagerToken !== undefined
        ? { volumeManagerToken }
        : { useStoredVolumeManagerToken: isVolumeManagerTokenConfigured }),
      ...(trimmedPrefix ? { volumeNamePrefix: trimmedPrefix } : {})
    }),
    [
      trimmedBaseUrl,
      openSandboxApiKey,
      isOpenSandboxApiKeyConfigured,
      trimmedImage,
      openSandboxUseServerProxy,
      trimmedVolumeManagerUrl,
      volumeManagerToken,
      isVolumeManagerTokenConfigured,
      trimmedPrefix
    ]
  );

  // 结果绑定探测输入快照，输入变化时隐藏旧结果；isTesting 与输入解耦，确保服务端单实例租约在途期间不重复提交。
  const payloadKey = useMemo(() => JSON.stringify(payload), [payload]);
  const [isTesting, setIsTesting] = useState(false);
  const [completedProbe, setCompletedProbe] = useState<{
    key: string;
    result: TestSandboxPvcResizeResponse;
  }>();
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  const result = completedProbe?.key === payloadKey ? completedProbe.result : undefined;
  const isUnsupportedCapability = Boolean(
    result &&
    !result.supported &&
    result.errorCode &&
    CAPABILITY_UNSUPPORTED_ERROR_CODES.has(result.errorCode)
  );

  const getErrorText = (res: TestSandboxPvcResizeResponse) => {
    switch (res.errorCode) {
      case 'concurrent_test':
        return t('admin:sandbox_pvc_resize_test_err_concurrent_test');
      case 'min_size_too_large': {
        const base = t('admin:sandbox_pvc_resize_test_err_min_size_too_large');
        const provisioned = formatProbeMiB(res.initialBytes);
        return provisioned ? `${base} (${provisioned})` : base;
      }
      case 'rbac_denied':
        return t('admin:sandbox_pvc_resize_test_err_rbac_denied');
      case 'expansion_not_allowed':
        return t('admin:sandbox_pvc_resize_test_err_expansion_not_allowed');
      case 'offline_resize_only':
        return t('admin:sandbox_pvc_resize_test_err_offline_resize_only');
      case 'resize_timeout':
        return t('admin:sandbox_pvc_resize_test_err_resize_timeout');
      case 'failed': {
        const prefix = t('admin:sandbox_pvc_resize_test_err_failed');
        return res.error ? `${prefix} (${res.error})` : prefix;
      }
      default:
        return res.error || t('admin:probe_request_failed');
    }
  };

  const handleTest = async () => {
    if (!canRunTest || abortControllerRef.current) return;
    const requestId = ++requestIdRef.current;
    const requestKey = payloadKey;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsTesting(true);
    setCompletedProbe(undefined);

    try {
      const res = await POST<TestSandboxPvcResizeResponse>(
        '/admin/system/config/testSandboxPvcResize',
        payload,
        { timeout: 240_000, cancelToken: controller }
      );
      if (requestIdRef.current !== requestId) return;
      setCompletedProbe({ key: requestKey, result: res });
    } catch (err: unknown) {
      if (requestIdRef.current !== requestId) return;
      setCompletedProbe({
        key: requestKey,
        result: {
          supported: false,
          responseTimeMs: 0,
          error: getErrorMessage(err, t('admin:probe_request_failed'))
        }
      });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (requestIdRef.current === requestId) {
        setIsTesting(false);
      }
    }
  };

  return (
    <Box gridColumn={'1 / -1'}>
      <Flex alignItems={'center'} justifyContent={'space-between'} gap={4} flexWrap={'wrap'}>
        <Box flex={'1 1 320px'}>
          <Controller
            name="agentSandbox.opensandbox.enableDynamicPvcResize"
            control={control}
            render={({ field }) => (
              <AdminSwitchRow
                name={field.name}
                label={t('admin:sandbox_enable_dynamic_pvc_resize')}
                tooltip={t('admin:sandbox_enable_dynamic_pvc_resize_tooltip')}
                isChecked={Boolean(field.value)}
                onChange={field.onChange}
              />
            )}
          />
        </Box>
        <MyTooltip label={disabledTooltip} isDisabled={!disabledTooltip || isTesting}>
          <Button
            type={'button'}
            size={'sm'}
            variant={'outline'}
            colorScheme={'blue'}
            flexShrink={0}
            isLoading={isTesting}
            isDisabled={!canRunTest}
            onClick={handleTest}
          >
            {t('admin:sandbox_pvc_resize_test_button')}
          </Button>
        </MyTooltip>
      </Flex>
      {isTesting && (
        <Text mt={1.5} fontSize={'xs'} color={'myGray.500'}>
          {t('admin:sandbox_pvc_resize_testing_tip')}
        </Text>
      )}
      {result && (
        <HStack mt={2} spacing={2} alignItems={'center'} flexWrap={'wrap'}>
          <Tag
            size={'sm'}
            colorScheme={result.supported ? 'green' : 'red'}
            variant={'subtle'}
            flexShrink={0}
          >
            {result.supported
              ? t('admin:sandbox_pvc_resize_test_supported')
              : isUnsupportedCapability
                ? t('admin:sandbox_pvc_resize_test_unsupported')
                : t('admin:sandbox_pvc_resize_test_failed')}
          </Tag>
          {result.supported ? (
            <Text fontSize={'xs'} color={'myGray.600'}>
              {[formatProbeMiB(result.initialBytes), formatProbeMiB(result.resizedBytes)]
                .filter(Boolean)
                .join(' → ')}{' '}
              ({(result.responseTimeMs / 1000).toFixed(1)}s)
            </Text>
          ) : (
            <Text fontSize={'xs'} color={'red.500'} wordBreak={'break-word'}>
              {getErrorText(result)}
            </Text>
          )}
        </HStack>
      )}
    </Box>
  );
};

export default React.memo(SandboxPvcResizeTestBar);
