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
  private running: Promise<void> | undefined;
  private readonly subscriptions: { off(): unknown }[] = [];
  private disposed = false;
  protected cache = {
    /**
     * If `true`, then the project has not been run since the last clean
     * (so the cache is already clean). Useful for deciding whether or not
     * to trigger a new cache-clean, e.g. upon change to an atlas file.
     */
    igorCacheIsClean: false,
  };

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

  /** Query providers join the same reconciliation rather than seeing queued disk changes. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    do {
      clearTimeout(this.timeout);
      this.running ||= Promise.resolve()
        .then(async () => {
          while (this.queue.length && !this.disposed) await this.flushQueue();
        })
        .finally(() => {
          this.running = undefined;
        });
      await this.running;
    } while (!this.disposed && (this.queue.length || this.running));
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

    for (const event of queue) {
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

        // If this is an included file, we need to force-sync the project's files
        if (project.dir.join('datafiles').isParentOf(pathy(uri.fsPath))) {
          try {
            await project.syncIncludedFiles();
            if (this.disposed) return;
            stitchEvents.emit('datafiles-changed', project);
          } catch (error) {
            logger.warn('Could not synchronize Included Files', error);
          }
          continue;
        }

        if (uri.path.endsWith('/stitch.config.json')) {
          await project.reloadConfig();
          await project.analysis.analyze();
          continue;
        }

        /** The asset this changed file belongs to, if any. */
        const asset = project.getAsset(pathy(uri.fsPath));

        // Change to the yyp file implies that we have deleted
        // or added an asset, so we need to respond to that.
        if (uri.path.endsWith('.yyp')) {
          logger.info(`yyp file changed on disk. Reloading!`);
          await project.reloadYyp();
          if (this.disposed) return;
          stitchEvents.emit('project-changed', project);
          continue;
        }

        // Broad GML watching includes metadata-owned paths outside resource
        // directories. Generated caches and orphan files have no source owner.
        if (
          uri.path.endsWith('.gml') &&
          !project.getGmlFile(pathy(uri.fsPath)) &&
          !project.sourceOwners(pathy(uri.fsPath)).length
        )
          continue;
        // Reconcile the actual listed files even if the metadata watcher did
        // not fire (for example an externally restored or removed event file).
        if (['create', 'delete'].includes(type) && uri.path.endsWith('.gml')) {
          await project.reloadResource(pathy(uri.fsPath));
        }
        // Changes to existing GML files can be handled immediately.
        if (type === 'change' && uri.path.endsWith('.gml')) {
          logger.info(`GML file "${uri.path}" changed on disk. Reloading!`);
          await this.provider.onChangeFile(uri);
        }
        // Metadata changes include extensions and parent/event removal.
        if (uri.path.endsWith('.yy')) {
          logger.info(`yy file "${uri.path}" changed on disk. Reloading!`);
          await project.reloadResource(pathy(uri.fsPath));
        }

        if (this.disposed) return;
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
            void project
              .run({ clean: true })
              .catch((error) => logger.error(error));
            // Set the cache to clean so that we don't clean again while looping
            // through the queue.
            this.cache.igorCacheIsClean = true;
          }
        }
        if (asset) {
          stitchEvents.emit('asset-changed', asset, type, uri);
        }
      } catch (error) {
        logger.error(error);
      }
    }
  }
}
