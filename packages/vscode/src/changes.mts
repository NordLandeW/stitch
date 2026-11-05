import { pathy } from '@bscotch/pathy';
import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import { stitchEvents } from './events.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { logger } from './log.mjs';

interface ChangeEvent {
  type: 'change' | 'create' | 'delete';
  uri: vscode.Uri;
}

export class ChangeTracker {
  protected queue: ChangeEvent[] = [];
  protected timeout: NodeJS.Timeout | undefined;
  private flushing?: Promise<void>;
  private failure?: unknown;
  private metadataPending = false;
  get allowsCompletionReuse() {
    return !this.disposed && !this.failure && !this.metadataPending;
  }
  get hasPending() {
    return !!this.flushing || !!this.queue.length || !!this.failure;
  }
  private disposed = false;
  protected cache = {
    /**
     * If `true`, then the project has not been run since the last clean
     * (so the cache is already clean). Useful for deciding whether or not
     * to trigger a new cache-clean, e.g. upon change to an atlas file.
     */
    igorCacheIsClean: false,
  };

  private readonly subscriptions: { off(): unknown }[] = [];
  constructor(readonly provider: StitchWorkspace) {
    this.subscriptions.push(
      stitchEvents.on(
        'clean-project-start',
        () => (this.cache.igorCacheIsClean = true),
      ),
      stitchEvents.on(
        'run-project-start',
        () => (this.cache.igorCacheIsClean = false),
      ),
    );
  }

  addChange(event: ChangeEvent) {
    if (this.disposed) return;
    const file = event.uri.path.toLowerCase();
    const metadata = file.endsWith('.gml')
      ? event.type !== 'change'
      : /\.(?:yy|yyp)$|\/options\/|\/stitch\.config\.json$/.test(file);
    this.metadataPending ||= metadata;
    this.provider.markExternalChange(metadata);
    this.failure = undefined;
    const duplicate =
      event.type === 'change' &&
      event.uri.path.endsWith('.gml') &&
      this.queue.some(
        (pending) =>
          pending.type === 'change' &&
          pending.uri.toString() === event.uri.toString(),
      );
    if (!duplicate) this.queue.push(event);
    clearTimeout(this.timeout);
    this.timeout = setTimeout(
      () => void this.flush().catch((error) => logger.error(error)),
      stitchConfig.externalChangeDelay,
    );
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timeout);
    this.queue = [];
    for (const subscription of this.subscriptions.splice(0)) subscription.off();
  }

  async flushPending() {
    if (this.failure) throw this.failure;
    return this.flush();
  }

  retryPending() {
    this.failure = undefined;
    return this.flush();
  }

  protected flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.disposed) return Promise.resolve();
    clearTimeout(this.timeout);
    this.flushing = Promise.resolve()
      .then(async () => {
        while (this.queue.length && !this.disposed) await this.flushQueue();
      })
      .catch((error) => {
        this.failure = error;
        throw error;
      })
      .finally(() => {
        this.flushing = undefined;
        if (!this.failure && !this.queue.length) this.metadataPending = false;
        if (!this.disposed && !this.failure)
          this.provider.publishPendingDiagnostics();
      });
    return this.flushing;
  }

  private async flushQueue() {
    const queue = this.queue;
    this.queue = [];

    // Sort by yyp, then yy, then gml files.
    queue.sort((a, b) => {
      for (const ext of ['.yyp', '.yy', '.gml', '.atlas', '.png']) {
        const aExt = a.uri.path.endsWith(ext);
        const bExt = b.uri.path.endsWith(ext);
        if (aExt && !bExt) {
          return -1;
        }
        if (bExt && !aExt) {
          return 1;
        }
        if (aExt && bExt) {
          return 0;
        }
      }
      return 0;
    });

    for (const [index, event] of queue.entries()) {
      if (this.disposed) return;
      try {
        const { type, uri } = event;
        const project = this.provider.getProject(uri);
        if (!project) {
          logger.warn(
            `For change event ${type} ${uri.path}, no project found.`,
          );
          continue;
        }

        await project.whenSourcesCurrent();
        if (this.disposed) return;

        // If this is an included file, we need to force-sync the project's files
        if (project.dir.join('datafiles').isParentOf(pathy(uri.fsPath))) {
          try {
            await project.syncIncludedFiles();
            stitchEvents.emit('datafiles-changed', project);
          } catch {}
          continue;
        }

        if (
          uri.fsPath.toLowerCase() ===
            project.stitchConfig.absolute.toLowerCase() ||
          project.dir.join('options').isParentOf(pathy(uri.fsPath))
        ) {
          await this.provider.reloadNativeInputs(project);
          continue;
        }

        /** The asset this changed file belongs to, if any. */
        const asset = project.getAsset(pathy(uri.fsPath));

        // Change to the yyp file implies that we have deleted
        // or added an asset, so we need to respond to that.
        if (type === 'change' && uri.path.endsWith('.yyp')) {
          logger.info(`yyp file changed on disk. Reloading!`);
          await this.provider.reloadProject(project);
          stitchEvents.emit('project-changed', project);
          continue;
        }

        // Refresh the resource file inventory even when watcher events for its
        // YY/YYP arrive separately or a legacy unlisted event was removed.
        if (['create', 'delete'].includes(type) && uri.path.endsWith('.gml')) {
          if (asset) await this.provider.reloadAsset(asset);
          continue;
        }
        // Changes to existing GML files can be handled immediately.
        if (type === 'change' && uri.path.endsWith('.gml')) {
          logger.info(`GML file "${uri.path}" changed on disk. Reloading!`);
          await this.provider.onChangeFile(uri);
        }
        // Changes to yy files can be handled immediately.
        // For now we
        // only care about objects, since object yy files list
        // their events.
        if (type === 'change' && uri.path.endsWith('.yy')) {
          logger.info(`yy file "${uri.path}" changed on disk. Reloading!`);
          if (!asset) {
            logger.warn(`No asset found for yy file "${uri.fsPath}".`);
          }
          if (asset) await this.provider.reloadAsset(asset);
        }

        // Changes to art assets should be accumulated with timestamps
        // until the user runs the project. Depending on config settings,
        // changes to .atlas files should result in an auto-clean, and changes
        // to .png files should result in a popup detailing all sprites changes.
        if (type === 'change' && uri.path.endsWith('.atlas')) {
          const shouldClean =
            stitchConfig.cleanOnSpineSpriteChange &&
            !this.cache.igorCacheIsClean;
          logger.info(
            `atlas file "${uri.path}" changed on disk. `,
            shouldClean ? 'Cleaning!' : 'Skipping cache-clean.',
          );
          if (shouldClean) {
            void project.run({ clean: true });
            // Set the cache to clean so that we don't clean again while looping
            // through the queue.
            this.cache.igorCacheIsClean = true;
          }
        }
        if (asset) {
          stitchEvents.emit('asset-changed', asset, type, uri);
        }
      } catch (error) {
        this.queue.unshift(...queue.slice(index));
        logger.error(error);
        throw error;
      }
    }
  }
}
