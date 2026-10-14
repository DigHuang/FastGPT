import JSZip from 'jszip';
import type { RuntimeSkillMetadataType } from '@fastgpt/global/core/ai/skill/type';
import { isGzipBuffer, scanTarGzEntries } from '../../../../common/file/archive/tarGz';
import { parseSkillMarkdown } from '../utils';
import { validateZipSafety } from './zipBuilder';

export type ExtractRuntimeSkillsFromPackageOptions = {
  allowEmpty?: boolean;
};

/**
 * 从已读取的 `SKILL.md` 文件列表中提取并校验运行态子 Skill 元数据。
 *
 * 供沙盒内直接读取 `SKILL.md` 文本以及从 `.tar.gz` / `.zip` 归档解析共用。
 */
export function extractRuntimeSkillsFromMarkdownEntries(
  entries: Array<{ path: string; content: string }>,
  options: ExtractRuntimeSkillsFromPackageOptions = {}
): RuntimeSkillMetadataType[] {
  const normalizedEntries = entries
    .map((entry) => ({
      path: normalizeRuntimeSkillPath(entry.path),
      content: entry.content
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const workspaceEntries = normalizedEntries.filter((entry) =>
    isWorkspaceRuntimeSkillMdPath(entry.path)
  );
  const skillMdEntries =
    workspaceEntries.length > 0
      ? workspaceEntries
      : normalizedEntries.filter((entry) => isLegacySkillMdPath(entry.path));

  if (skillMdEntries.length === 0) {
    if (options.allowEmpty) return [];
    throw new Error('Skill package must contain at least one skills/<name>/SKILL.md');
  }

  const nameSet = new Set<string>();
  const runtimeSkills: RuntimeSkillMetadataType[] = [];

  for (const entry of skillMdEntries) {
    const { frontmatter, error } = parseSkillMarkdown(entry.content);
    if (error) {
      throw new Error(`${entry.path}: ${error}`);
    }

    const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
    if (!name) {
      throw new Error(`${entry.path}: frontmatter name is required`);
    }

    if (nameSet.has(name)) {
      throw new Error(`Duplicate runtime skill name: ${name}`);
    }
    nameSet.add(name);

    runtimeSkills.push({
      name,
      description:
        typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      path: getRuntimeSkillMetadataPath(entry.path, name)
    });
  }

  return runtimeSkills;
}

/**
 * 从 Skill 包（支持 `.tar.gz` 与旧版 `.zip`）中解析运行态子 Skill 元数据。
 *
 * 标准 workspace 读取 `skills/<skillDir>/SKILL.md`；历史单 skill 包允许从根目录或
 * 一级目录 `SKILL.md` 兜底解析，并把 path 规范化为运行态可识别的
 * `skills/<name>/SKILL.md`。初始空白 workspace 可通过 `allowEmpty` 跳过空包校验。
 */
export async function extractRuntimeSkillsFromPackage(
  packageBuffer: Buffer,
  options: ExtractRuntimeSkillsFromPackageOptions = {}
): Promise<RuntimeSkillMetadataType[]> {
  if (isGzipBuffer(packageBuffer)) {
    const markdownEntries: Array<{ path: string; content: string }> = [];
    await scanTarGzEntries({
      source: packageBuffer,
      shouldReadContent: ({ path, type }) => {
        if (type !== 'file') return false;
        const normalized = normalizeRuntimeSkillPath(path);
        return isWorkspaceRuntimeSkillMdPath(normalized) || isLegacySkillMdPath(normalized);
      },
      onEntry: (entry) => {
        if (entry.type !== 'file') return;
        const normalized = normalizeRuntimeSkillPath(entry.path);
        if (isWorkspaceRuntimeSkillMdPath(normalized) || isLegacySkillMdPath(normalized)) {
          markdownEntries.push({
            path: normalized,
            content: entry.content.toString('utf8')
          });
        }
      }
    });

    return extractRuntimeSkillsFromMarkdownEntries(markdownEntries, options);
  }

  const zip = await JSZip.loadAsync(packageBuffer);
  const safety = validateZipSafety(zip);
  if (!safety.valid) {
    throw new Error(safety.error || 'Invalid skill package');
  }

  const candidateFiles = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path, file]) => ({
      path: normalizeRuntimeSkillPath(path),
      file
    }))
    .filter(
      (entry) => isWorkspaceRuntimeSkillMdPath(entry.path) || isLegacySkillMdPath(entry.path)
    );

  const markdownEntries = await Promise.all(
    candidateFiles.map(async (entry) => ({
      path: entry.path,
      content: await entry.file.async('string')
    }))
  );

  return extractRuntimeSkillsFromMarkdownEntries(markdownEntries, options);
}

function normalizeRuntimeSkillPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isWorkspaceRuntimeSkillMdPath(path: string): boolean {
  return /^skills\/[^/]+\/SKILL\.md$/i.test(path);
}

function isLegacySkillMdPath(path: string): boolean {
  return /^SKILL\.md$/i.test(path) || /^[^/]+\/SKILL\.md$/i.test(path);
}

function getRuntimeSkillMetadataPath(path: string, name: string): string {
  return isWorkspaceRuntimeSkillMdPath(path) ? path : `skills/${name}/SKILL.md`;
}
