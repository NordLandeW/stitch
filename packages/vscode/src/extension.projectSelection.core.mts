export interface ProjectCandidate {
  /** Full URI, so projects with the same name remain distinct. */
  uri: string;
  name: string;
  folderName: string;
}

interface SelectionState {
  get(key: string): unknown;
  update(key: string, value: string): PromiseLike<void>;
}

const selectedProjectKey = 'selectedProjectUri';

/** Workspace-scoped selection, independent of the editor's project lifecycle. */
export class ProjectSelection {
  private switching = false;

  constructor(private readonly state: SelectionState) {}

  async choose<T extends ProjectCandidate>(
    projects: readonly T[],
    allowedProjects: readonly string[],
    pick: (projects: readonly T[], previous?: T) => PromiseLike<T | undefined>,
    forcePick = false,
  ): Promise<T | undefined> {
    const allowed = allowedProjects.map((name) => name.toLowerCase());
    const filtered = allowed.length
      ? projects.filter(
          (project) =>
            allowed.includes(project.name.toLowerCase()) ||
            allowed.includes(project.folderName.toLowerCase()),
        )
      : projects;
    // Preserve the existing fallback when the allow-list matches nothing.
    const candidates = filtered.length ? filtered : projects;
    if (!candidates.length) return;

    const saved = this.state.get(selectedProjectKey);
    const previous = candidates.find((project) => project.uri === saved);
    if (!forcePick) {
      if (previous) return previous;
      if (candidates.length === 1) return candidates[0];
    }
    return await pick(candidates, previous);
  }

  async remember(project: Pick<ProjectCandidate, 'uri'>): Promise<void> {
    await this.state.update(selectedProjectKey, project.uri);
  }

  /** Save before reloading, while keeping cancellation and repeated commands harmless. */
  async switchProject(
    choose: () => PromiseLike<Pick<ProjectCandidate, 'uri'> | undefined>,
    activeProject: string | undefined,
    reload: () => PromiseLike<unknown>,
  ): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      const project = await choose();
      if (!project) return;
      await this.remember(project);
      if (project.uri !== activeProject) await reload();
    } finally {
      this.switching = false;
    }
  }
}
