import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProjectSelection,
  type ProjectCandidate,
} from './extension.projectSelection.core.mjs';

const first = {
  uri: 'file:///workspace/first/Game.yyp',
  name: 'Game',
  folderName: 'first',
};
const second = {
  uri: 'file:///workspace/second/Game.yyp',
  name: 'Game',
  folderName: 'second',
};
const projects = [first, second];

function createState() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string) => values.get(key),
    update: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const noPicker = async (): Promise<ProjectCandidate | undefined> => {
  assert.fail('The picker should not be shown');
};

test('remembers a choice across selector instances without prompting again', async () => {
  const state = createState();
  const initial = new ProjectSelection(state);
  const chosen = await initial.choose(projects, [], async (choices) => {
    assert.deepEqual(choices, projects);
    return second;
  });
  assert.equal(chosen, second);
  await initial.remember(chosen!);

  const reopened = new ProjectSelection(state);
  assert.equal(await reopened.choose(projects, [], noPicker), second);
  assert.deepEqual([...state.values.values()], [second.uri]);
});

test('keeps choices separate between workspaces', async () => {
  const one = new ProjectSelection(createState());
  const two = new ProjectSelection(createState());
  await one.remember(first);
  await two.remember(second);
  assert.equal(await one.choose(projects, [], noPicker), first);
  assert.equal(await two.choose(projects, [], noPicker), second);
});

test('selects the only candidate automatically and leaves an empty workspace alone', async () => {
  const selector = new ProjectSelection(createState());
  assert.equal(await selector.choose([first], [], noPicker), first);
  assert.equal(await selector.choose([], [], noPicker), undefined);
  assert.equal(await selector.choose([], [], noPicker, true), undefined);
});

test('explicit selection opens the picker even with a remembered or single project', async () => {
  const selector = new ProjectSelection(createState());
  await selector.remember(first);
  let prompts = 0;
  const pick = async (
    choices: readonly ProjectCandidate[],
    previous?: ProjectCandidate,
  ) => {
    prompts++;
    assert.equal(previous, first);
    return choices.at(-1);
  };
  assert.equal(await selector.choose(projects, [], pick, true), second);
  assert.equal(await selector.choose([first], [], pick, true), first);
  assert.equal(prompts, 2);
});

test('cancelling a switch preserves the remembered project', async () => {
  const selector = new ProjectSelection(createState());
  await selector.remember(first);
  assert.equal(
    await selector.choose(projects, [], async () => undefined, true),
    undefined,
  );
  assert.equal(await selector.choose(projects, [], noPicker), first);
});

test('cancelled initial selection is not remembered', async () => {
  const state = createState();
  const selector = new ProjectSelection(state);
  assert.equal(
    await selector.choose(projects, [], async () => undefined),
    undefined,
  );
  assert.equal(state.values.size, 0);
  let prompted = false;
  await selector.choose(projects, [], async () => {
    prompted = true;
    return first;
  });
  assert.equal(prompted, true);
});

test('a missing saved project falls back to the current candidates', async () => {
  const selector = new ProjectSelection(createState());
  await selector.remember({ ...first, uri: 'file:///deleted/Game.yyp' });
  assert.equal(
    await selector.choose(projects, [], async (choices, previous) => {
      assert.equal(previous, undefined);
      assert.deepEqual(choices, projects);
      return second;
    }),
    second,
  );
  assert.equal(await selector.choose([first], [], noPicker), first);
});

test('allow-list filtering takes precedence over the saved project', async () => {
  const selector = new ProjectSelection(createState());
  await selector.remember(first);
  assert.equal(await selector.choose(projects, ['SECOND'], noPicker), second);
  assert.equal(await selector.choose(projects, ['gAmE'], noPicker), first);
  assert.equal(
    await selector.choose(projects, ['does-not-exist'], noPicker),
    first,
  );
});

test('matches full URIs rather than project names, including remote authorities', async () => {
  const selector = new ProjectSelection(createState());
  const remote = {
    ...first,
    uri: 'vscode-remote://ssh-remote+host/workspace/first/Game.yyp',
  };
  await selector.remember(remote);
  assert.equal(await selector.choose([first, remote], [], noPicker), remote);
});

test('waits for persistence and reports storage failures to the caller', async () => {
  const state = createState();
  let complete!: () => void;
  const stored = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const selector = new ProjectSelection({ ...state, update: () => stored });
  let finished = false;
  const saving = selector.remember(first).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  complete();
  await saving;
  assert.equal(finished, true);

  const failed = new ProjectSelection({
    ...state,
    update: async () => {
      throw new Error('storage unavailable');
    },
  });
  await assert.rejects(failed.remember(first), /storage unavailable/);
});

test('switching waits for storage before reloading into the remembered project', async () => {
  const state = createState();
  let complete!: () => void;
  const stored = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const calls: string[] = [];
  const selector = new ProjectSelection({
    ...state,
    async update(key, value) {
      calls.push('save');
      await stored;
      await state.update(key, value);
    },
  });
  const switching = selector.switchProject(
    async () => second,
    first.uri,
    async () => {
      calls.push('reload');
      assert.equal(
        await new ProjectSelection(state).choose(projects, [], noPicker),
        second,
      );
    },
  );
  await Promise.resolve();
  assert.deepEqual(calls, ['save']);
  complete();
  await switching;
  assert.deepEqual(calls, ['save', 'reload']);
});

test('switch cancellation and selecting the current project never reload', async () => {
  const state = createState();
  const selector = new ProjectSelection(state);
  await selector.remember(first);
  const noReload = async () => assert.fail('The current window must stay open');
  await selector.switchProject(async () => undefined, first.uri, noReload);
  await selector.switchProject(async () => first, first.uri, noReload);
  assert.equal(await selector.choose(projects, [], noPicker), first);
});

test('a command can select a project after initial loading was cancelled or failed', async () => {
  const selector = new ProjectSelection(createState());
  let reloads = 0;
  await selector.switchProject(
    async () => second,
    undefined,
    async () => {
      reloads++;
    },
  );
  assert.equal(reloads, 1);
  assert.equal(await selector.choose(projects, [], noPicker), second);
});

test('concurrent switch commands share one picker and allow a later retry', async () => {
  const selector = new ProjectSelection(createState());
  let choose!: (project: ProjectCandidate | undefined) => void;
  const picking = new Promise<ProjectCandidate | undefined>((resolve) => {
    choose = resolve;
  });
  let prompts = 0;
  let reloads = 0;
  const pick = () => {
    prompts++;
    return picking;
  };
  const reload = async () => {
    reloads++;
  };
  const firstCommand = selector.switchProject(pick, first.uri, reload);
  await selector.switchProject(pick, first.uri, reload);
  assert.equal(prompts, 1);
  choose(undefined);
  await firstCommand;
  assert.equal(reloads, 0);
  await selector.switchProject(async () => second, first.uri, reload);
  assert.equal(reloads, 1);
});

test('a failed save does not reload or block future switch commands', async () => {
  const state = createState();
  let fail = true;
  const selector = new ProjectSelection({
    ...state,
    async update(key, value) {
      if (fail) throw new Error('storage unavailable');
      await state.update(key, value);
    },
  });
  let reloads = 0;
  const reload = async () => {
    reloads++;
  };
  await assert.rejects(
    selector.switchProject(async () => second, first.uri, reload),
    /storage unavailable/,
  );
  assert.equal(reloads, 0);
  fail = false;
  await selector.switchProject(async () => second, first.uri, reload);
  assert.equal(reloads, 1);
});
