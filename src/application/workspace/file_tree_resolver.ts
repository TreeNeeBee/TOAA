import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { ProjectManagementPlanSchema } from '../../domain/project_management/management.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { FileTreeService } from './file_tree_service.js';

/**
 * One canonical `FileTreeService` per Project, for the lifetime of the process.
 *
 * The lock lives on the service instance, so a service built per attempt would give every attempt
 * its own lock and serialize nothing — the mutual exclusion would exist in the type system and not
 * in the run. Sharing the instance is what makes the lock a lock.
 */
const services = new Map<string, FileTreeService>();
const resolving = new Map<string, Promise<FileTreeService>>();

/** Test seam: a process that reuses ids across cases must not inherit another case's instance. */
export function resetFileTreeServices(): void {
  services.clear();
  resolving.clear();
}

/**
 * Finds the Project's master tree, creating it on first use.
 *
 * Lookup is by object rather than through the management plan's pointer so a workspace built before
 * the tree existed gains one without a migration. The plan is still updated to record ownership,
 * once, when the tree is created — the pointer is the ownership record, not the lookup index, and
 * writing it per file change is exactly what keeping the tree out of the plan avoids.
 */
export async function resolveFileTreeService(
  repository: DomainObjectRepositoryPort,
  projectId: ObjectId,
  workspaceRoot: string,
): Promise<FileTreeService> {
  const cached = services.get(projectId);
  if (cached) return cached;
  const pending = resolving.get(projectId);
  if (pending) return pending;
  const resolution = resolveCanonicalFileTree(repository, projectId, workspaceRoot)
    .finally(() => resolving.delete(projectId));
  resolving.set(projectId, resolution);
  return resolution;
}

async function resolveCanonicalFileTree(
  repository: DomainObjectRepositoryPort,
  projectId: ObjectId,
  workspaceRoot: string,
): Promise<FileTreeService> {
  const objects = await repository.list({ objectType: 'file-tree', projectId });
  const trees = objects.filter((object) => object.objectType === 'file-tree');
  if (trees.length > 1) {
    throw new Error(`Project ${projectId} owns ${trees.length} file trees; exactly one master tree is allowed`);
  }
  const existing = trees[0];
  if (existing) {
    const service = new FileTreeService(repository, workspaceRoot, existing.id);
    services.set(projectId, service);
    await recordOwnership(repository, projectId, existing.id);
    return service;
  }

  const tree = FileTreeService.create({ projectId });
  await repository.commit([tree]);
  await recordOwnership(repository, projectId, tree.id);
  const service = new FileTreeService(repository, workspaceRoot, tree.id);
  services.set(projectId, service);
  return service;
}

/**
 * Points the management plan at the tree it owns.
 *
 * A plan that already names the master tree is left alone. A different pointer is a corrupt
 * ownership boundary: Ticket and Gate worktrees cannot repoint PM at a candidate tree.
 */
async function recordOwnership(
  repository: DomainObjectRepositoryPort,
  projectId: ObjectId,
  fileTreeId: ObjectId,
): Promise<void> {
  const plans = await repository.list({ objectType: 'project-management-plan', projectId });
  const plan = plans.find((object) => object.objectType === 'project-management-plan');
  if (!plan || plan.objectType !== 'project-management-plan') return;
  if (plan.fileTree) {
    if (plan.fileTree.fileTreeId !== fileTreeId || plan.fileTree.branch !== 'master') {
      throw new Error(`Project management plan ${plan.id} references a non-canonical file tree`);
    }
    return;
  }
  await repository.commit([ProjectManagementPlanSchema.parse({
    ...plan,
    ...reviseObjectEnvelope(plan),
    fileTree: { fileTreeId, branch: 'master', ignoredPrefixes: [], publishManifestOnDelivery: true },
  })]);
}
