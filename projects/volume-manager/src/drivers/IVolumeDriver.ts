import type {
  SandboxVolumeEnsureRequest,
  SandboxVolumeEnsureResponse,
  SandboxVolumeInspectResponse,
  SandboxVolumeResizeRequest,
  SandboxVolumeResizeResponse
} from '@fastgpt/global/core/ai/sandbox/volume';

export type IVolumeDriver = {
  inspect(
    claimName: string,
    options?: { allowLegacyUnlabeled?: boolean }
  ): Promise<SandboxVolumeInspectResponse | null>;
  ensure(params: SandboxVolumeEnsureRequest): Promise<SandboxVolumeEnsureResponse>;
  resize(
    claimName: string,
    params: SandboxVolumeResizeRequest
  ): Promise<SandboxVolumeResizeResponse>;
  remove(claimName: string, options?: { allowLegacyUnlabeled?: boolean }): Promise<void>;
  list(): Promise<string[]>;
};
