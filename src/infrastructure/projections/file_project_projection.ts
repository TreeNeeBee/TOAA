import { createHash } from 'node:crypto';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type {
  ProjectProjectionWriter,
  ProjectStatusProjection,
} from '../../application/project_management/project_projection.js';
import type { Workspace } from '../../workspace/workspace.js';

export const PROJECT_STATUS_PROJECTION_PATH = '.xcompiler/cache/pm/project-status.json';

export class FileProjectProjectionWriter implements ProjectProjectionWriter {
  constructor(private readonly workspace: Workspace) {}

  async write(projection: ProjectStatusProjection): Promise<void> {
    const content = JSON.stringify(projection);
    const snapshot = {
      kind: 'xcompiler.project-status-projection',
      version: 2,
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      projection,
    };
    await this.workspace.writeFileAtomic(
      PROJECT_STATUS_PROJECTION_PATH,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }

  async read(projectId: ObjectId): Promise<ProjectStatusProjection | undefined> {
    if (!(await this.workspace.exists(PROJECT_STATUS_PROJECTION_PATH))) return undefined;
    try {
      const snapshot = JSON.parse(await this.workspace.readFile(PROJECT_STATUS_PROJECTION_PATH)) as {
        kind?: unknown;
        version?: unknown;
        checksum?: unknown;
        projection?: unknown;
      };
      if (
        snapshot.kind !== 'xcompiler.project-status-projection' ||
        snapshot.version !== 2 ||
        typeof snapshot.checksum !== 'string' ||
        !snapshot.projection ||
        typeof snapshot.projection !== 'object'
      ) return undefined;
      const projection = snapshot.projection as ProjectStatusProjection;
      const content = JSON.stringify(projection);
      const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (checksum !== snapshot.checksum || projection.projectId !== projectId) return undefined;
      return projection;
    } catch {
      return undefined;
    }
  }

  async remove(_projectId: ObjectId): Promise<void> {
    await this.workspace.remove(PROJECT_STATUS_PROJECTION_PATH);
  }
}
