import { describe, expect, it } from 'vitest';
import {
  getSkillPackageKey,
  getSkillPackagePrefix,
  toTarGzSkillStorageKey
} from '@fastgpt/service/common/s3/sources/skill';

describe('S3 skill object keys', () => {
  it('encodes raw identifiers exactly once and uses .tar.gz extension', () => {
    const params = {
      teamId: 'team one',
      skillId: 'skill%20one'
    };

    expect(getSkillPackagePrefix(params)).toBe('agent-skills/team%20one/skill%2520one/');
    expect(
      getSkillPackageKey({
        ...params,
        packageObjectId: 'package%2Fone'
      })
    ).toBe('agent-skills/team%20one/skill%2520one/package%252Fone.tar.gz');
    expect(toTarGzSkillStorageKey('agent-skills/team/skill/v1.zip')).toBe(
      'agent-skills/team/skill/v1.tar.gz'
    );
  });
});
