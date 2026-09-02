import type { Workspace } from '../workspace/workspace.js';
import type { DeliveryGateFinding } from '../domain/quality/delivery_gate.js';
import type { Language } from './plan.js';
import { getLanguageProfile } from './language.js';

/**
 * Checks language-level project artifacts that an LLM can write syntactically but incorrectly.
 *
 * These are delivery contracts, not test-runner diagnostics. Keeping the check here lets the
 * authoring Step reject a bad artifact immediately and lets a later Step route an already accepted
 * bad artifact back to its owner without interpreting runner prose.
 */
export async function inspectLanguageProjectContract(
  workspace: Workspace,
  language: Language,
): Promise<DeliveryGateFinding[]> {
  const profile = getLanguageProfile(language);
  const contract = profile.manifestContract;
  if (!contract || !(await workspace.exists(profile.manifestFile))) return [];

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await workspace.readFile(profile.manifestFile));
    if (!isRecord(parsed)) throw new Error('root value must be a JSON object');
    manifest = parsed;
  } catch (error) {
    return [manifestFinding(
      'language_manifest_invalid',
      `${profile.manifestFile} is not a valid project manifest.`,
      [`JSON parsing failed: ${(error as Error).message}`],
      profile.manifestFile,
    )];
  }

  const findings: DeliveryGateFinding[] = [];
  if (contract.testScript !== undefined) {
    const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
    const actual = scripts.test;
    if (actual !== contract.testScript) {
      findings.push(manifestFinding(
        'language_test_entrypoint_contract_invalid',
        `${profile.manifestFile} does not expose the required test entrypoint.`,
        [
          `Expected scripts.test=${JSON.stringify(contract.testScript)}.`,
          `Actual scripts.test=${JSON.stringify(actual)}.`,
          'The project test entrypoint must discover Runtime-selected baseline tests without excluding them.',
        ],
        profile.manifestFile,
      ));
    }
  }
  return findings;
}

function manifestFinding(
  code: string,
  summary: string,
  evidence: string[],
  manifestFile: string,
): DeliveryGateFinding {
  return {
    category: 'deliverable-defect',
    code,
    summary,
    evidence,
    target: 'high-level-design',
    affectedArtifacts: [manifestFile],
    dependencyPackages: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
