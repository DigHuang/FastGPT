import z from 'zod';
import type { OpenAPIPath } from '../../../type';
import { DevApiTagsMap } from '../../../tag';
import { requiredAlternatives } from '../../../../common/zod/openapi';
import { AgentSandboxVolumeNamePrefixSchema } from '../../../../common/system/config/schemas/subservice';
import { isValidServiceBaseUrl } from '../../../../common/string/url';

/* ============================================================================
 * API: 端到端测试 Kubernetes 动态 PVC 在线扩容能力
 * Route: POST /api/admin/system/config/testSandboxPvcResize
 * Method: POST
 * Description: 使用当前表单草稿或已保存配置，创建临时 0.5Gi PVC 与临时沙盒 Pod，实测 0.5Gi -> 1Gi 在线扩容并自动清理
 * Tags: ['Admin', 'InstanceConfig', 'AgentSandbox']
 * ============================================================================ */

const ServiceBaseUrlSchema = z
  .string()
  .trim()
  .refine((value) => isValidServiceBaseUrl(value), {
    message: 'Expected an HTTP(S) base URL without credentials, query or fragment'
  });

export const TestSandboxPvcResizeBodySchema = z
  .object({
    baseUrl: ServiceBaseUrlSchema.meta({
      description: 'OpenSandbox 服务基地址',
      example: 'http://opensandbox:8080'
    }),
    apiKey: z.string().optional().meta({
      description: 'OpenSandbox 新填写的草稿 API Key；省略并设置 useStoredApiKey 时复用已保存密钥',
      example: 'osb-secret-key'
    }),
    useStoredApiKey: z.boolean().optional().meta({
      description: '复用服务端已保存的 OpenSandbox API Key（与 apiKey 互斥）',
      example: true
    }),
    image: z.string().trim().min(1).meta({
      description: '用于创建临时测试容器的 Agent Sandbox 镜像',
      example: 'registry.cn-hangzhou.aliyuncs.com/fastgpt/fastgpt-agent-sandbox:v0.5.0'
    }),
    useServerProxy: z.boolean().default(true).meta({
      description: '是否启用 OpenSandbox 服务端代理访问容器数据面',
      example: true
    }),
    volumeManagerUrl: ServiceBaseUrlSchema.meta({
      description: 'Volume Manager 服务基地址',
      example: 'http://volume-manager:3005'
    }),
    volumeManagerToken: z.string().optional().meta({
      description:
        'Volume Manager 新填写的草稿 Token；省略并设置 useStoredVolumeManagerToken 时复用已保存密钥',
      example: 'vm-secret-token'
    }),
    useStoredVolumeManagerToken: z.boolean().optional().meta({
      description: '复用服务端已保存的 Volume Manager Token（与 volumeManagerToken 互斥）',
      example: true
    }),
    volumeNamePrefix: AgentSandboxVolumeNamePrefixSchema.optional().meta({
      description: 'PVC 命名前缀，缺省使用已保存值或默认前缀',
      example: 'fastgpt-session'
    })
  })
  .refine((body) => !body.useStoredApiKey || body.apiKey === undefined, {
    message: 'useStoredApiKey cannot be combined with a draft apiKey',
    path: ['useStoredApiKey']
  })
  .refine((body) => Boolean(body.useStoredApiKey) || Boolean(body.apiKey?.trim()), {
    message: 'OpenSandbox API Key is required',
    path: ['apiKey']
  })
  .refine((body) => !body.useStoredVolumeManagerToken || body.volumeManagerToken === undefined, {
    message: 'useStoredVolumeManagerToken cannot be combined with a draft volumeManagerToken',
    path: ['useStoredVolumeManagerToken']
  })
  .refine(
    (body) => Boolean(body.useStoredVolumeManagerToken) || Boolean(body.volumeManagerToken?.trim()),
    {
      message: 'Volume Manager Token is required',
      path: ['volumeManagerToken']
    }
  )
  .meta(
    requiredAlternatives([
      ['apiKey', 'volumeManagerToken'],
      ['useStoredApiKey', 'useStoredVolumeManagerToken'],
      ['apiKey', 'useStoredVolumeManagerToken'],
      ['useStoredApiKey', 'volumeManagerToken']
    ])
  );

export type TestSandboxPvcResizeBody = z.infer<typeof TestSandboxPvcResizeBodySchema>;

export const TestSandboxPvcResizeErrorCodeSchema = z
  .enum([
    'concurrent_test',
    'min_size_too_large',
    'rbac_denied',
    'expansion_not_allowed',
    'offline_resize_only',
    'resize_timeout',
    'failed'
  ])
  .meta({
    description: '测试失败时的结构化错误分类，供前端本地化展示',
    example: 'expansion_not_allowed'
  });
export type TestSandboxPvcResizeErrorCode = z.infer<typeof TestSandboxPvcResizeErrorCodeSchema>;

export const TestSandboxPvcResizeResponseSchema = z.object({
  supported: z.boolean().meta({
    description: '当前集群是否通过 0.5Gi 初始卷与 +0.5Gi 在线扩容验证',
    example: true
  }),
  responseTimeMs: z.number().nonnegative().meta({
    description: '端到端实测总耗时（毫秒）',
    example: 8420
  }),
  initialBytes: z.number().nonnegative().optional().meta({
    description: '初始 512Mi PVC 挂载后容器内文件系统总容量（字节）',
    example: 511705088
  }),
  resizedBytes: z.number().nonnegative().optional().meta({
    description: '在线扩容至 1024Mi 后容器内文件系统总容量（字节）',
    example: 1038090240
  }),
  errorCode: TestSandboxPvcResizeErrorCodeSchema.optional(),
  error: z.string().optional().meta({
    description: '测试失败时的脱敏诊断信息',
    example: 'StorageClass does not allow volume expansion'
  })
});
export type TestSandboxPvcResizeResponse = z.infer<typeof TestSandboxPvcResizeResponseSchema>;

export const AdminInstanceConfigTestSandboxPvcResizePath: OpenAPIPath = {
  '/api/admin/system/config/testSandboxPvcResize': {
    post: {
      summary: '测试 Kubernetes 沙盒动态 PVC 在线扩容能力',
      description:
        '仅超级管理员 root 可调用。创建临时 512Mi PVC 与临时沙盒 Pod，实测 512Mi -> 1024Mi 在线扩容能力并在结束后强制清理临时资源，不写入沙盒实例库',
      tags: [DevApiTagsMap.adminSettings],
      requestBody: {
        content: {
          'application/json': {
            schema: TestSandboxPvcResizeBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '实测完成',
          content: {
            'application/json': {
              schema: TestSandboxPvcResizeResponseSchema
            }
          }
        }
      }
    }
  }
};
