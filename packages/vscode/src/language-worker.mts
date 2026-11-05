import { parentPort } from 'node:worker_threads';
import { setLogger } from '@bscotch/gml-parser';
import { LanguageEngine } from './language/engine.mjs';
import type { WorkerRequest, WorkerResponse } from './language/protocol.mjs';

if (!parentPort)
  throw new Error('The language service requires a worker thread');
const port = parentPort;
let session = '';
let revision = 0;
const send = (message: WorkerResponse) => port.postMessage(message);
const log =
  (level: 'log' | 'warn' | 'error') =>
  (...args: unknown[]) =>
    send({
      session,
      event: 'log',
      level,
      message: args
        .map((value) =>
          value instanceof Error ? value.stack || value.message : String(value),
        )
        .join(' '),
    });
const logger = {
  log: log('log'),
  info: log('log'),
  debug: log('log'),
  dir: log('log'),
  warn: log('warn'),
  error: log('error'),
};
setLogger(logger);
const engine = new LanguageEngine({
  logger,
  onLoadProgress: (increment, message) =>
    send({ session, event: 'progress', increment, message }),
});
// Promise-based serialization is intentional here: the entire queue already runs
// on a separate thread, including synchronous parser transactions and queries.
let pending = Promise.resolve();
port.on('message', (request: WorkerRequest) => {
  pending = pending.then(async () => {
    try {
      if (request.kind === 'initialize') {
        if (session) throw new Error('Language worker is already initialized');
        session = request.session;
        await engine.initialize(request.input);
        send({
          id: request.id,
          session,
          ok: true,
          revision,
          value: undefined,
          diagnostics: engine.diagnostics(),
          completions: engine.completions(),
          nativeCandidates: engine.nativeCandidates(),
        });
        return;
      }
      if (request.session !== session)
        throw new Error('Obsolete language session');
      if (request.kind === 'update') {
        if (request.revision <= revision)
          throw new Error('Out-of-order language input');
        await engine.apply(request.inputs);
        revision = request.revision;
        send({
          id: request.id,
          session,
          ok: true,
          revision,
          value: undefined,
          diagnostics: engine.diagnostics(),
          completions: engine.completions(),
          nativeCandidates: request.inputs.some(
            (input) => !['document', 'close', 'disk'].includes(input.kind),
          )
            ? engine.nativeCandidates()
            : undefined,
        });
      } else {
        if (request.revision !== revision)
          throw new Error('Language input is not current');
        const value = await engine.query(request.query);
        send({ id: request.id, session, ok: true, revision, value });
      }
    } catch (error) {
      send({
        id: request.id,
        session: request.session,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
