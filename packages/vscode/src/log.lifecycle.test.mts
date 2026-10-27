import assert from 'node:assert/strict';
import test from 'node:test';
import { createHost, deferred } from './test/host.mjs';

function echoed(host: any, level: string, message: string) {
  return host.logs.some(
    ([kind, ...parts]: unknown[]) =>
      kind === level &&
      parts.some((part) => typeof part === 'string' && part.includes(message)),
  );
}
function outputs(host: any, name: string) {
  return host.resources.filter(
    (resource: any) => resource.label === `output:${name}`,
  );
}

// The isolated entry imports the actual Logger and log.core. VS Code's output
// channel is the only sink boundary double; lifecycle/formatting are not copied.
test(
  'real Logger construction stays lazy and channel creation/append failures do not interrupt info or error',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realLogger: true });
    t.after(() => host.dispose());
    const { Logger } = host.subject;
    assert.deepEqual(
      host.outputEvents,
      [],
      'Even the module-level logger must allocate lazily',
    );
    Logger.resume();
    host.failOutputCreation = true;
    let logger: any;
    let prefixed: any;
    assert.doesNotThrow(() => {
      logger = new Logger('Creation-failure');
    });
    assert.doesNotThrow(() => {
      prefixed = logger.withPrefix('prefix');
    });
    assert.deepEqual(host.outputEvents, []);
    assert.doesNotThrow(() => prefixed.info('creation-info-survives'));
    assert.doesNotThrow(() =>
      prefixed.error(new Error('creation-error-survives')),
    );
    assert(
      host.outputEvents.some(
        (event: any) =>
          event.kind === 'create' && event.name === 'Creation-failure',
      ),
    );
    assert.equal(outputs(host, 'Creation-failure').length, 0);
    assert(echoed(host, 'info', 'creation-info-survives'));
    assert(echoed(host, 'error', 'creation-error-survives'));

    host.failOutputCreation = false;
    host.failOutputAppend = true;
    const beforeConstructor = host.outputEvents.length;
    const appendFailure = new Logger('Append-failure');
    assert.equal(host.outputEvents.length, beforeConstructor);
    assert.doesNotThrow(() => appendFailure.info('append-info-survives'));
    assert.doesNotThrow(() =>
      appendFailure.error(new Error('append-error-survives')),
    );
    assert(
      host.outputEvents.some(
        (event: any) =>
          event.kind === 'append' && event.name === 'Append-failure',
      ),
    );
    assert(echoed(host, 'info', 'append-info-survives'));
    assert(echoed(host, 'error', 'append-error-survives'));
    assert.doesNotThrow(() => Logger.disposeAll());
    assert(
      outputs(host, 'Append-failure').every((channel: any) => channel.disposed),
    );
  },
);

test(
  'late asynchronous logs from old and newly prefixed loggers cannot recreate a disposed output channel',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realLogger: true });
    const release = deferred();
    let late: Promise<void> | undefined;
    t.after(async () => {
      release.resolve();
      if (late) await Promise.allSettled([late]);
      host.dispose();
    });
    const { Logger } = host.subject;
    Logger.resume();
    const logger = new Logger('Late-output');
    const prefix = logger.withPrefix('before-disposal');
    logger.info('live-output');
    assert.equal(outputs(host, 'Late-output').length, 1);
    late = release.promise.then(() => {
      logger.info('late-info-console');
      prefix.error(new Error('late-error-console'));
      logger.withPrefix('after-disposal').warn('late-prefix-console');
    });
    Logger.disposeAll();
    assert(
      outputs(host, 'Late-output').every((channel: any) => channel.disposed),
    );
    const afterDisposal = [...host.outputEvents];
    release.resolve();
    await late;
    assert.deepEqual(
      host.outputEvents,
      afterDisposal,
      'No late create or append attempt may reach the disposed sink',
    );
    assert(echoed(host, 'info', 'late-info-console'));
    assert(echoed(host, 'error', 'late-error-console'));
    assert(echoed(host, 'warn', 'late-prefix-console'));
  },
);

test(
  'explicit Logger resume permits a fresh lazy channel that outputs normally and is reclaimed again',
  { timeout: 30_000 },
  async (t) => {
    const host = await createHost({ realLogger: true });
    t.after(() => host.dispose());
    const { Logger } = host.subject;
    Logger.resume();
    const old = new Logger('Resumed-output');
    old.info('first-lifetime-output');
    const [first] = outputs(host, 'Resumed-output');
    assert(first);
    Logger.disposeAll();
    assert.equal(first.disposed, true);
    const afterDisposal = [...host.outputEvents];
    old.info('before-resume-console-only');
    assert.deepEqual(host.outputEvents, afterDisposal);
    assert(echoed(host, 'info', 'before-resume-console-only'));

    Logger.resume();
    const fresh = new Logger('Resumed-output').withPrefix('resumed');
    assert.deepEqual(
      host.outputEvents,
      afterDisposal,
      'Resume and construction only enable later lazy allocation',
    );
    fresh.info('resumed-info-output');
    fresh.error(new Error('resumed-error-output'));
    const channels = outputs(host, 'Resumed-output');
    assert.equal(channels.length, 2);
    assert.notEqual(channels[1], first);
    assert.equal(channels[1].disposed, false);
    for (const message of ['resumed-info-output', 'resumed-error-output']) {
      assert(
        host.outputEvents.some(
          (event: any) =>
            event.kind === 'append' &&
            event.name === 'Resumed-output' &&
            event.line.includes(message),
        ),
      );
    }
    Logger.disposeAll();
    Logger.disposeAll();
    assert(channels.every((channel: any) => channel.disposed));
    assert.equal(
      host.outputEvents.filter(
        (event: any) =>
          event.kind === 'dispose' && event.name === 'Resumed-output',
      ).length,
      2,
    );
  },
);
