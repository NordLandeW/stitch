import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import {
  computeGameMakerBuildCommand,
  type GameMakerRuntime,
} from './GameMakerRuntime.js';

function fakeRuntime() {
  return {
    executablePath: pathy('C:/runtime/Igor.exe'),
    directory: pathy('C:/runtime'),
    activeUserDirectory: async () => pathy('C:/user'),
  } as GameMakerRuntime;
}

describe('GameMakerRuntime commands', function () {
  it('adds the Igor debug flag to debug runs', async function () {
    const { args } = await computeGameMakerBuildCommand(fakeRuntime(), {
      project: 'C:/project/game.yyp',
      debug: true,
    });

    expect(args).to.include('--debug');
    expect(args).to.include('--dbgp=6509');
  });

  it('does not add the Igor debug flag to normal runs', async function () {
    const { args } = await computeGameMakerBuildCommand(fakeRuntime(), {
      project: 'C:/project/game.yyp',
    });

    expect(args).not.to.include('--debug');
    expect(args.some((arg) => arg.startsWith('--dbgp='))).to.be.false;
  });

  it('supports a custom debugger port', async function () {
    const { args } = await computeGameMakerBuildCommand(fakeRuntime(), {
      project: 'C:/project/game.yyp',
      debug: true,
      debuggerPort: 6510,
    });

    expect(args).to.include('--dbgp=6510');
  });
});
