import type {
  CompiledProjectExtension,
  CompiledProjectGraph,
} from '../../domain/planning/compiler.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { assertDomainGraph } from '../../domain/workflow/domain_graph.js';

export class ProjectGraphPersistenceService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async persistGraph(graph: CompiledProjectGraph): Promise<void> {
    assertDomainGraph(graph);
    await this.repository.commit([
      graph.project,
      graph.projectPlan,
      graph.managementPlan,
      ...graph.actors,
      ...graph.phases,
      ...graph.phasePlans,
      ...graph.steps,
      ...graph.tickets,
      ...graph.kpis,
      ...graph.deliverables,
    ]);
  }

  async persistExtension(extension: CompiledProjectExtension): Promise<void> {
    await this.repository.commit([
      ...extension.phases,
      ...extension.phasePlans,
      ...extension.tickets,
      ...extension.steps,
      ...extension.kpis,
      ...extension.deliverables,
      extension.projectPlan,
      extension.managementPlan,
      extension.project,
    ]);
  }
}
