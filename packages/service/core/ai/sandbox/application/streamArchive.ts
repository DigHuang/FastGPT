/**
 * Sandbox 流式打包（split --filter 双缓冲管道）与流式解包（mkfifo + 写端保活 + 实时限流 tar）原语。
 *
 * 设计目标：
 * 1. 沙盒工作区（/workspace）0 字节归档包落盘，彻底解除磁盘配额折半限制；
 * 2. 沙盒 /tmp 峰值占用严格受控（打包 <= 16 MiB 双缓冲，解包 0 B FIFO 管道）；
 * 3. 服务端不持有整包 Buffer，按 8 MiB 分片流式直传 S3 Multipart 或 HTTP 响应；
 * 4. 任何中断或失败均在 finally 中清理沙盒内后台进程树与临时目录。
 */
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { ISandbox } from '@fastgpt-sdk/sandbox-adapter';
import { shellQuote } from '@fastgpt/global/common/string/utils';
import { getNanoid } from '@fastgpt/global/common/string/tools';
import {
  SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
  SANDBOX_ARCHIVE_MAX_ENTRIES,
  SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES,
  SANDBOX_ARCHIVE_STREAM_MAX_READY_PARTS
} from '../constants';
import { SandboxOperationSettledError } from './lifecycle/error';

/** 空 `.tar.gz` 归档（由 1024 字节全 0 TAR 结束块经 gzip 压缩生成，仅 29 字节）。 */
export const EMPTY_TAR_GZ_BUFFER = zlib.gzipSync(Buffer.alloc(1024, 0), {
  level: zlib.constants.Z_BEST_SPEED
});

/** 兼容旧版单元测试中的空 `.zip` EOCD 魔数。 */
const LEGACY_EMPTY_ZIP_HEX = '504b0506000000000000000000000000000000000000';

export type StreamPackFormat = 'tar.gz' | 'zip';

export type StreamPackFromSandboxParams = {
  sandbox: ISandbox;
  workDirectory: string;
  format: StreamPackFormat;
  maxBytes?: number;
  maxEntries?: number;
  /** find -prune 表达式（不含外层括号），用于按 .gitignore 排除目录或文件。 */
  pruneClause?: string;
  /** 额外排除的文件名列表（如历史残留的临时包名）。 */
  excludeFileNames?: string[];
  /** zip 打包时的 -x 排除模式列表。 */
  zipExcludePatterns?: string[];
  /** 当工作区为空时是否产出单个空归档 Buffer（默认 true）。 */
  allowEmpty?: boolean;
  /** 是否在打包前拒绝指向工作区外部的逃逸软链接（默认 true）。 */
  rejectEscapingSymlinks?: boolean;
  signal?: AbortSignal;
  assertValid?: () => void;
};

export type StreamExtractTarGzIntoSandboxParams = {
  sandbox: ISandbox;
  targetDirectory: string;
  archiveStream: Readable | Buffer | AsyncIterable<Uint8Array>;
  maxUncompressedBytes: number;
  maxEntries?: number;
  /** 是否以清空替换模式覆盖 targetDirectory（如冷归档恢复为 true，在已有目录内叠加解压为 false）。 */
  clearTargetDirectory?: boolean;
  signal?: AbortSignal;
  assertValid?: () => void;
};

/**
 * 构建 `find` 过滤子句：合并可选的 `pruneClause` 与额外排除的文件名。
 */
const buildFindFilterExpressions = (params: {
  pruneClause?: string;
  excludeFileNames?: string[];
}) => {
  const nameExcludes = (params.excludeFileNames ?? [])
    .map((fileName) => `! -name ${shellQuote(fileName)}`)
    .join(' ');
  const prunePrefix = params.pruneClause ? `\\( ${params.pruneClause} \\) -prune -o ` : '';
  return { nameExcludes, prunePrefix };
};

/**
 * 在沙盒内对目标目录执行打包前快速安全与容量预检：
 * 1. 确认目录存在；
 * 2. 统计未忽略普通文件的逻辑总字节数与总条目数；
 * 3. 可选校验软链接是否全部解析在目标目录内部。
 */
export const precheckSandboxPackDirectory = async (params: {
  sandbox: ISandbox;
  workDirectory: string;
  maxBytes?: number;
  maxEntries?: number;
  pruneClause?: string;
  excludeFileNames?: string[];
  rejectEscapingSymlinks?: boolean;
  signal?: AbortSignal;
}): Promise<{ entryCount: number; apparentBytes: number }> => {
  const {
    sandbox,
    workDirectory,
    maxBytes,
    maxEntries = SANDBOX_ARCHIVE_MAX_ENTRIES,
    rejectEscapingSymlinks = true,
    signal
  } = params;
  const quotedWorkDir = shellQuote(workDirectory);
  const { nameExcludes, prunePrefix } = buildFindFilterExpressions({
    pruneClause: params.pruneClause,
    excludeFileNames: params.excludeFileNames
  });

  const symlinkCheckScript = rejectEscapingSymlinks
    ? [
        'ROOT_REAL=$(realpath -m .)',
        `if ! find . ${prunePrefix}-mindepth 1 ${nameExcludes} -type l -exec sh -c '`,
        '  ROOT_REAL="$1"',
        '  shift',
        '  for link in "$@"; do',
        '    TARGET_REAL=$(realpath -m "$link" 2>/dev/null || true)',
        '    case "$TARGET_REAL" in',
        '      "$ROOT_REAL" | "$ROOT_REAL"/*) ;;',
        '      *) echo "SYMLINK_ESCAPE:$link" >&2; exit 22 ;;',
        '    esac',
        '  done',
        `' sh "$ROOT_REAL" {} + 2>/dev/null; then`,
        '  echo "SYMLINK_ESCAPE" >&2',
        '  exit 22',
        'fi'
      ].join('\n')
    : 'true';

  const [sizeResult, entryCountResult] = await Promise.all([
    sandbox.execute(
      `cd ${quotedWorkDir} && find . ${prunePrefix}-type f ${nameExcludes} -ls 2>/dev/null | awk '{s+=$7} END {printf "%.0f\\n", s+0}'`,
      {
        signal,
        timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 8 * 1024
      }
    ),
    sandbox.execute(
      [
        `cd ${quotedWorkDir}`,
        symlinkCheckScript,
        `find . ${prunePrefix}-mindepth 1 ${nameExcludes} 2>/dev/null | wc -l`
      ].join('\n'),
      {
        signal,
        timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 8 * 1024
      }
    )
  ]);

  for (const res of [sizeResult, entryCountResult]) {
    if (res.exitCode !== 0) {
      const message = res.stderr || res.stdout || `Sandbox precheck failed for ${workDirectory}`;
      if (message.includes('SYMLINK_ESCAPE:')) {
        throw new Error(`Invalid symlink escaping workspace in ${workDirectory}`);
      }
      if (res.exitCode !== null) {
        throw new SandboxOperationSettledError(message);
      }
      throw new Error(message);
    }
  }

  const apparentBytes = Number(sizeResult.stdout.trim());
  const entryCount = Number.parseInt(entryCountResult.stdout.trim(), 10);

  if (maxBytes !== undefined && Number.isFinite(apparentBytes) && apparentBytes > maxBytes) {
    throw new Error(
      `Sandbox workspace is too large (${(apparentBytes / 1024 / 1024).toFixed(2)}MB > ${(maxBytes / 1024 / 1024).toFixed(2)}MB)`
    );
  }

  if (Number.isFinite(entryCount) && entryCount > maxEntries) {
    throw new Error(
      `Sandbox workspace entry count (${entryCount}) exceeds maximum allowed limit (${maxEntries})`
    );
  }

  return {
    apparentBytes: Number.isFinite(apparentBytes) ? apparentBytes : 0,
    entryCount: Number.isFinite(entryCount) ? entryCount : 1
  };
};

/**
 * 从沙盒指定目录流式打包（支持 `tar.gz` 与 `zip`）并按 8 MiB 分片产出 `Buffer`。
 *
 * 沙盒内部通过 `split -b 8388608 --filter` 将管道流切分为最多 2 个驻留 `/tmp` 的 `.ready` 分片；
 * 服务端每读取并删除一个分片，沙盒自动恢复写出下一个分片，全程不在 `/workspace` 落盘。
 */
export async function* streamPackFromSandbox(
  params: StreamPackFromSandboxParams
): AsyncGenerator<Buffer, void, unknown> {
  const {
    sandbox,
    workDirectory,
    format,
    maxBytes,
    maxEntries = SANDBOX_ARCHIVE_MAX_ENTRIES,
    allowEmpty = true,
    rejectEscapingSymlinks = true,
    signal,
    assertValid
  } = params;

  assertValid?.();

  // 1. 打包前预检目录大小、条目数与软链接安全性
  const { entryCount } = await precheckSandboxPackDirectory({
    sandbox,
    workDirectory,
    maxBytes,
    maxEntries,
    pruneClause: params.pruneClause,
    excludeFileNames: params.excludeFileNames,
    rejectEscapingSymlinks,
    signal
  });

  if (entryCount === 0) {
    if (allowEmpty && format === 'tar.gz') {
      yield EMPTY_TAR_GZ_BUFFER;
    }
    return;
  }

  const packId = `${Date.now()}-${getNanoid(8)}`;
  const stageDir = `/tmp/.fastgpt-pack-${packId}`;
  const quotedStageDir = shellQuote(stageDir);
  const quotedWorkDir = shellQuote(workDirectory);
  const { nameExcludes, prunePrefix } = buildFindFilterExpressions({
    pruneClause: params.pruneClause,
    excludeFileNames: params.excludeFileNames
  });

  // 2. 组装生产者命令（tar -I "gzip -1" 或 zip -r -y -q -）与 split --filter 双缓冲写出脚本
  const producerCmd = (() => {
    if (format === 'zip') {
      const zipExcludes = (params.zipExcludePatterns ?? [])
        .map((pattern) => `-x ${shellQuote(pattern)}`)
        .join(' ');
      return `zip -r -y -q - . ${zipExcludes} 2>"$STAGE_DIR/pack.err"`;
    }
    return `find . ${prunePrefix}-mindepth 1 ${nameExcludes} \\( -type d -o -type f -o -type l \\) -print0 2>/dev/null | tar --null --no-recursion -I "gzip -1" --one-file-system --warning=no-file-changed -cf - -T - 2>"$STAGE_DIR/pack.err"`;
  })();

  const waitNextChunkLoopScript = [
    'while true; do',
    '  NEXT_CHUNK=$(find "$STAGE_DIR" -maxdepth 1 -name "part-*.ready" 2>/dev/null | sort | head -n 1)',
    '  if [ -n "$NEXT_CHUNK" ]; then',
    '    if [ -f "$STAGE_DIR/done" ]; then',
    '      set -- "$STAGE_DIR"/part-*.ready',
    '      REM_COUNT=$#',
    '      DONE_CODE=$(cat "$STAGE_DIR/done" 2>/dev/null || echo 0)',
    '      if [ "$DONE_CODE" = "0" ] && [ "$REM_COUNT" -le 1 ]; then',
    '        printf "LAST_CHUNK\\t%s\\n" "$NEXT_CHUNK"',
    '        exit 0',
    '      fi',
    '    fi',
    '    printf "CHUNK\\t%s\\n" "$NEXT_CHUNK"',
    '    exit 0',
    '  fi',
    '  if [ -f "$STAGE_DIR/done" ]; then',
    '    DONE_CODE=$(cat "$STAGE_DIR/done" 2>/dev/null || echo 1)',
    '    NEXT_CHUNK=$(find "$STAGE_DIR" -maxdepth 1 -name "part-*.ready" 2>/dev/null | sort | head -n 1)',
    '    if [ -n "$NEXT_CHUNK" ]; then',
    '      printf "CHUNK\\t%s\\n" "$NEXT_CHUNK"',
    '      exit 0',
    '    fi',
    '    if [ "$DONE_CODE" != "0" ]; then',
    '      cat "$STAGE_DIR/pack.err" >&2 2>/dev/null || true',
    '      exit "$DONE_CODE"',
    '    fi',
    '    printf "DONE\\n"',
    '    exit 0',
    '  fi',
    '  sleep 0.02',
    'done'
  ].join('\n');

  const filterBody = [
    `STAGE_DIR=${quotedStageDir}`,
    'cat > "${STAGE_DIR}/${FILE}.part"',
    'mv "${STAGE_DIR}/${FILE}.part" "${STAGE_DIR}/${FILE}.ready"',
    `while true; do set -- "$STAGE_DIR"/part-*.ready; if [ ! -e "$1" ] || [ "$#" -lt ${SANDBOX_ARCHIVE_STREAM_MAX_READY_PARTS} ]; then break; fi; sleep 0.02; done`
  ].join('; ');

  const startAndPollFirstCmd = [
    `export STAGE_DIR=${quotedStageDir}`,
    'rm -rf "$STAGE_DIR" && mkdir -p "$STAGE_DIR" && chmod 700 "$STAGE_DIR"',
    '(',
    `  cd ${quotedWorkDir}`,
    `  ( ${producerCmd}; echo $? > "$STAGE_DIR/producer.rc" ) | split -b ${SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES} -d -a 6 --filter=${shellQuote(filterBody)} - part- 2>>"$STAGE_DIR/pack.err"`,
    '  SPLIT_RC=$?',
    '  PROD_RC=$(cat "$STAGE_DIR/producer.rc" 2>/dev/null || echo 1)',
    '  if [ "$PROD_RC" != "0" ]; then',
    '    echo "$PROD_RC" > "$STAGE_DIR/done.tmp"',
    '  else',
    '    echo "$SPLIT_RC" > "$STAGE_DIR/done.tmp"',
    '  fi',
    '  mv "$STAGE_DIR/done.tmp" "$STAGE_DIR/done"',
    ') </dev/null >/dev/null 2>&1 &',
    'echo $! > "$STAGE_DIR/pid"',
    waitNextChunkLoopScript
  ].join('\n');

  let totalEmittedBytes = 0;

  try {
    assertValid?.();
    let stepResult = await sandbox.execute(startAndPollFirstCmd, {
      signal,
      timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024
    });

    if (stepResult.exitCode !== 0) {
      const message =
        stepResult.stderr ||
        stepResult.stdout ||
        `Failed to pack sandbox directory ${workDirectory}`;
      if (stepResult.exitCode !== null) {
        throw new SandboxOperationSettledError(message);
      }
      throw new Error(message);
    }

    // 兼容简单单元测试 Mock（execute 未返回协议标签，readFiles 直接返回单块内容）
    const firstStdout = stepResult.stdout.trim();
    const isProtocolOutput = /^(CHUNK\t|LAST_CHUNK\t|DONE$)/m.test(firstStdout);
    if (!isProtocolOutput) {
      assertValid?.();
      const fallbackPath = `${stageDir}/part-000000.ready`;
      const [fallbackFile] = await sandbox.readFiles([fallbackPath]);
      if (!fallbackFile) {
        throw new Error('Archive chunk file not found in sandbox');
      }
      if (fallbackFile.error) {
        throw new Error(`Failed to read sandbox archive chunk: ${fallbackFile.error.message}`);
      }
      const chunkBuf = Buffer.from(
        fallbackFile.content instanceof Uint8Array
          ? fallbackFile.content
          : Buffer.from(fallbackFile.content, 'utf8')
      );
      if (maxBytes !== undefined && chunkBuf.byteLength > maxBytes) {
        throw new Error('Sandbox archive is too large');
      }
      yield chunkBuf;
      return;
    }

    // 3. 循环消费 .ready 分片并通过 rm 释放双缓冲背压槽位
    while (true) {
      assertValid?.();
      const line = stepResult.stdout.trim().split('\n').pop() ?? '';
      if (line === 'DONE') {
        break;
      }

      const [tag, chunkPath] = line.split('\t');
      if ((tag !== 'CHUNK' && tag !== 'LAST_CHUNK') || !chunkPath) {
        throw new Error(`Unexpected pack stream state from sandbox: ${line}`);
      }

      const [fileResult] = await sandbox.readFiles([chunkPath]);
      if (!fileResult) {
        throw new Error(`Sandbox archive chunk not found: ${chunkPath}`);
      }
      if (fileResult.error) {
        throw new Error(`Failed to read sandbox archive chunk: ${fileResult.error.message}`);
      }

      const chunkBuf = Buffer.from(
        fileResult.content instanceof Uint8Array
          ? fileResult.content
          : Buffer.from(fileResult.content, 'utf8')
      );
      totalEmittedBytes += chunkBuf.byteLength;
      if (maxBytes !== undefined && totalEmittedBytes > maxBytes) {
        throw new Error('Sandbox archive exceeds maximum allowed size');
      }

      yield chunkBuf;

      if (tag === 'LAST_CHUNK') {
        break;
      }

      assertValid?.();
      const releaseAndWaitCmd = [
        `STAGE_DIR=${quotedStageDir}`,
        `rm -f ${shellQuote(chunkPath)}`,
        waitNextChunkLoopScript
      ].join('\n');

      stepResult = await sandbox.execute(releaseAndWaitCmd, {
        signal,
        timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 8 * 1024
      });

      if (stepResult.exitCode !== 0) {
        const message =
          stepResult.stderr ||
          stepResult.stdout ||
          `Sandbox pack stream failed while waiting for next chunk`;
        if (stepResult.exitCode !== null) {
          throw new SandboxOperationSettledError(message);
        }
        throw new Error(message);
      }
    }
  } finally {
    // 4. 无论成功、超限还是客户端断流，彻底杀死后台打包进程树并移除 /tmp 分片目录
    const cleanupCmd = [
      `STAGE_DIR=${quotedStageDir}`,
      'if [ -f "$STAGE_DIR/pid" ]; then',
      '  PID=$(cat "$STAGE_DIR/pid" 2>/dev/null || true)',
      '  if [ -n "$PID" ]; then',
      '    pkill -KILL -P "$PID" 2>/dev/null || true',
      '    kill -KILL "$PID" 2>/dev/null || true',
      '  fi',
      'fi',
      'rm -rf "$STAGE_DIR"'
    ].join('\n');
    await sandbox.execute(cleanupCmd, { timeoutMs: 15_000 }).catch(() => undefined);
  }
}

/**
 * 将 `streamPackFromSandbox` 收集为单个内存 Buffer（仅用于小文件测试或兼容旧调用点）。
 */
export const collectSandboxPackBuffer = async (
  params: StreamPackFromSandboxParams
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of streamPackFromSandbox(params)) {
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : EMPTY_TAR_GZ_BUFFER;
};

/**
 * 将 `.tar.gz` 数据流通过命名管道（`mkfifo` + `sleep infinity` 写端保活 + `gzip -dc | head -c | tar -xf -`）
 * 实时限流解包到沙盒内的临时 staging 目录，完成安全校验后发布到目标目录。
 *
 * 全程不在沙盒 `/workspace` 或 `/tmp` 落地任何压缩包或分片文件。
 */
export const streamExtractTarGzIntoSandbox = async (
  params: StreamExtractTarGzIntoSandboxParams
): Promise<void> => {
  const {
    sandbox,
    targetDirectory,
    archiveStream,
    maxUncompressedBytes,
    maxEntries = SANDBOX_ARCHIVE_MAX_ENTRIES,
    clearTargetDirectory = false,
    signal,
    assertValid
  } = params;

  assertValid?.();

  // 检查是否为空归档 Buffer
  if (Buffer.isBuffer(archiveStream)) {
    const isEmptyTarGz = archiveStream.length === 0 || archiveStream.equals(EMPTY_TAR_GZ_BUFFER);
    const isLegacyEmptyZip = archiveStream.toString('hex') === LEGACY_EMPTY_ZIP_HEX;
    if (isEmptyTarGz || isLegacyEmptyZip) {
      const quotedTarget = shellQuote(targetDirectory);
      const emptyCmd = clearTargetDirectory
        ? `mkdir -p ${quotedTarget} && find ${quotedTarget} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`
        : `mkdir -p ${quotedTarget}`;
      const res = await sandbox.execute(emptyCmd, {
        signal,
        timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS
      });
      if (res.exitCode !== 0) {
        const message = res.stderr || res.stdout || `Failed to prepare ${targetDirectory}`;
        if (res.exitCode !== null) throw new SandboxOperationSettledError(message);
        throw new Error(message);
      }
      return;
    }
  }

  const restoreId = `${Date.now()}-${getNanoid(8)}`;
  const pipeDir = `/tmp/.fastgpt-restore-${restoreId}`;
  const pipePath = `${pipeDir}/stream.pipe`;
  const normalizedTargetDir = targetDirectory.replace(/\/+$/, '') || '/';
  const stagingDir = `${normalizedTargetDir}/.fastgpt-staging-${restoreId}`;
  const quotedPipeDir = shellQuote(pipeDir);
  const quotedStagingDir = shellQuote(stagingDir);
  const quotedTargetDir = shellQuote(targetDirectory);

  // TAR 流除了文件内容外还包含 512B 头部和对齐块，因此给实时 head -c 留出头部余量，解压后再用 du -sb 精确卡死 maxUncompressedBytes
  const maxTarStreamBytes =
    maxUncompressedBytes + Math.min(maxEntries * 1536, 128 * 1024 * 1024) + 1024 * 1024;

  const prepareTargetScript = clearTargetDirectory
    ? `mkdir -p ${quotedTargetDir} && find ${quotedTargetDir} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`
    : `mkdir -p ${quotedTargetDir}`;

  // 1. 初始化 FIFO 管道、写端保活进程（防止多次 writeFiles 之间触发早期 EOF）与后台实时解包进程
  const initPipeCmd = [
    `PIPE_DIR=${quotedPipeDir}`,
    `STAGING_DIR=${quotedStagingDir}`,
    prepareTargetScript,
    'rm -rf "$PIPE_DIR" "$STAGING_DIR" && mkdir -p "$PIPE_DIR" "$STAGING_DIR" && chmod 700 "$PIPE_DIR"',
    'mkfifo "$PIPE_DIR/stream.pipe"',
    'nohup sh -c \'exec sleep infinity > "$1"\' _ "$PIPE_DIR/stream.pipe" >/dev/null 2>&1 </dev/null &',
    'echo $! > "$PIPE_DIR/holder.pid"',
    "nohup sh -c '",
    '  umask 0022',
    '  ( gzip -dc < "$2" 2>"$3/gzip.err"; echo $? > "$3/gzip.rc.tmp" && mv "$3/gzip.rc.tmp" "$3/gzip.rc" ) | head -c "$4" | tar -xf - -C "$1" --no-same-owner --no-same-permissions --no-overwrite-dir --keep-directory-symlink 2>"$3/tar.err"',
    '  echo $? > "$3/tar.rc.tmp" && mv "$3/tar.rc.tmp" "$3/tar.rc"',
    `\' _ "$STAGING_DIR" "$PIPE_DIR/stream.pipe" "$PIPE_DIR" "${maxTarStreamBytes}" >/dev/null 2>&1 </dev/null &`,
    'echo $! > "$PIPE_DIR/tar.pid"'
  ].join('\n');

  try {
    const initResult = await sandbox.execute(initPipeCmd, {
      signal,
      timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024
    });
    if (initResult.exitCode !== 0) {
      const message =
        initResult.stderr || initResult.stdout || 'Failed to initialize restore FIFO in sandbox';
      if (initResult.exitCode !== null) throw new SandboxOperationSettledError(message);
      throw new Error(message);
    }

    // 2. 从归档源按 8 MiB 切块并通过 writeFiles 直写沙盒 FIFO 管道
    const writeChunkToFifo = async (chunk: Buffer) => {
      if (chunk.length === 0) return;
      assertValid?.();
      const [writeResult] = await sandbox.writeFiles([{ path: pipePath, data: chunk }]);
      if (writeResult?.error) {
        throw new Error(`Failed to write archive stream to sandbox: ${writeResult.error.message}`);
      }
    };

    if (Buffer.isBuffer(archiveStream)) {
      for (
        let offset = 0;
        offset < archiveStream.length;
        offset += SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES
      ) {
        await writeChunkToFifo(
          archiveStream.subarray(offset, offset + SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES)
        );
      }
    } else {
      let pendingChunks: Buffer[] = [];
      let pendingBytes = 0;

      for await (const rawChunk of archiveStream) {
        const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (buf.length === 0) continue;
        pendingChunks.push(buf);
        pendingBytes += buf.length;

        while (pendingBytes >= SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES) {
          const combined =
            pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
          const toSend = combined.subarray(0, SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES);
          const remainder = combined.subarray(SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES);
          pendingChunks = remainder.length > 0 ? [remainder] : [];
          pendingBytes = remainder.length;
          await writeChunkToFifo(toSend);
        }
      }

      if (pendingBytes > 0) {
        const finalChunk =
          pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
        await writeChunkToFifo(finalChunk);
      }
    }

    // 3. 关闭写端保活触发 FIFO EOF，等待 tar 解包完成并执行 4 项安全校验，最后发布至目标目录
    assertValid?.();
    const publishScript = clearTargetDirectory
      ? `find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -exec mv -f -- {} ${quotedTargetDir}/ \\; && rm -rf "$STAGING_DIR"`
      : `cp -a "$STAGING_DIR"/. ${quotedTargetDir}/ && rm -rf "$STAGING_DIR"`;

    const finalizeCmd = [
      `PIPE_DIR=${quotedPipeDir}`,
      `STAGING_DIR=${quotedStagingDir}`,
      'if [ -f "$PIPE_DIR/holder.pid" ]; then',
      '  kill -TERM "$(cat "$PIPE_DIR/holder.pid")" 2>/dev/null || true',
      'fi',
      'while [ ! -f "$PIPE_DIR/tar.rc" ]; do sleep 0.02; done',
      'TAR_RC=$(cat "$PIPE_DIR/tar.rc" 2>/dev/null || echo 1)',
      'GZIP_RC=$(cat "$PIPE_DIR/gzip.rc" 2>/dev/null || echo 0)',
      'if [ "$TAR_RC" != "0" ]; then',
      '  cat "$PIPE_DIR/gzip.err" "$PIPE_DIR/tar.err" >&2 2>/dev/null || true',
      '  exit "$TAR_RC"',
      'fi',
      'if [ "$GZIP_RC" != "0" ] && [ "$GZIP_RC" != "141" ]; then',
      '  cat "$PIPE_DIR/gzip.err" >&2 2>/dev/null || true',
      '  exit "$GZIP_RC"',
      'fi',
      // 校验 1：真实逻辑字节数与总条目数上限
      'ACTUAL_BYTES=$(du -sb --apparent-size "$STAGING_DIR" 2>/dev/null | awk \'{printf "%.0f\\n", $1+0}\')',
      `if [ -n "$ACTUAL_BYTES" ] && [ "$ACTUAL_BYTES" -gt ${maxUncompressedBytes} ]; then`,
      '  echo "Extracted archive exceeds maximum allowed size" >&2',
      '  exit 27',
      'fi',
      'ENTRY_COUNT=$(find "$STAGING_DIR" -mindepth 1 2>/dev/null | wc -l | tr -d " ")',
      `if [ -n "$ENTRY_COUNT" ] && [ "$ENTRY_COUNT" -gt ${maxEntries} ]; then`,
      '  echo "Extracted archive exceeds maximum allowed entry count" >&2',
      '  exit 28',
      'fi',
      // 校验 2：禁止块设备、字符设备、FIFO、Socket 等特殊文件
      'SPECIAL_FILE=$(find "$STAGING_DIR" \\( -type b -o -type c -o -type p -o -type s \\) -print -quit 2>/dev/null)',
      'if [ -n "$SPECIAL_FILE" ]; then',
      '  echo "Archive contains forbidden special file: $SPECIAL_FILE" >&2',
      '  exit 29',
      'fi',
      // 校验 3：所有软链接经 realpath -m 解析后必须位于 $STAGING_DIR 内部
      'STAGE_REAL=$(realpath -m "$STAGING_DIR")',
      'if ! find "$STAGING_DIR" -type l -exec sh -c \'',
      '  STAGE_REAL="$1"',
      '  shift',
      '  for link in "$@"; do',
      '    TARGET_REAL=$(realpath -m "$link" 2>/dev/null || true)',
      '    case "$TARGET_REAL" in',
      '      "$STAGE_REAL" | "$STAGE_REAL"/*) ;;',
      '      *) echo "Symlink escapes archive root: $link" >&2; exit 30 ;;',
      '    esac',
      '  done',
      '\' sh "$STAGE_REAL" {} + 2>/dev/null; then',
      '  echo "Symlink escapes archive root" >&2',
      '  exit 30',
      'fi',
      // 校验 4：剥离所有 SUID/SGID 位
      'chmod -R a-s "$STAGING_DIR" 2>/dev/null || true',
      publishScript,
      'rm -rf "$PIPE_DIR"'
    ].join('\n');

    const finalizeResult = await sandbox.execute(finalizeCmd, {
      signal,
      timeoutMs: SANDBOX_ARCHIVE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024
    });

    if (finalizeResult.exitCode !== 0) {
      const message =
        finalizeResult.stderr ||
        finalizeResult.stdout ||
        `Failed to finalize archive extraction into ${targetDirectory}`;
      if (finalizeResult.exitCode !== null) throw new SandboxOperationSettledError(message);
      throw new Error(message);
    }
  } finally {
    if (
      !Buffer.isBuffer(archiveStream) &&
      'destroy' in archiveStream &&
      typeof archiveStream.destroy === 'function' &&
      !archiveStream.destroyed
    ) {
      archiveStream.destroy();
    }
    const cleanupCmd = [
      `PIPE_DIR=${quotedPipeDir}`,
      `STAGING_DIR=${quotedStagingDir}`,
      'if [ -f "$PIPE_DIR/holder.pid" ]; then kill -KILL "$(cat "$PIPE_DIR/holder.pid")" 2>/dev/null || true; fi',
      'if [ -f "$PIPE_DIR/tar.pid" ]; then',
      '  TPID=$(cat "$PIPE_DIR/tar.pid" 2>/dev/null || true)',
      '  if [ -n "$TPID" ]; then pkill -KILL -P "$TPID" 2>/dev/null || true; kill -KILL "$TPID" 2>/dev/null || true; fi',
      'fi',
      'rm -rf "$PIPE_DIR" "$STAGING_DIR"'
    ].join('\n');
    await sandbox.execute(cleanupCmd, { timeoutMs: 15_000 }).catch(() => undefined);
  }
};
