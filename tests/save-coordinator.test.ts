import { describe, expect, it } from 'vitest';
import { createSaveCoordinator } from '../client/save-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}

describe('serialized save coordination', () => {
  it('writes a follow-up snapshot when state changes during an earlier write', async () => {
    let current = { revision: 1, assets: ['first'] };
    const writes: Array<typeof current> = [];
    const persisted: Array<typeof current> = [];
    const gates = [deferred<void>(), deferred<void>()];
    const coordinator = createSaveCoordinator({
      capture: () => structuredClone(current),
      write: async (snapshot) => { writes.push(snapshot); await gates[writes.length - 1]!.promise; },
      onSaved: snapshot => persisted.push(snapshot),
    });

    coordinator.markDirty();
    const first = coordinator.save();
    expect(writes).toEqual([{ revision: 1, assets: ['first'] }]);
    current = { revision: 2, assets: ['first', 'arrived-while-saving'] };
    coordinator.markDirty();
    const second = coordinator.save();
    expect(second).toBe(first);
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual([
      { revision: 1, assets: ['first'] },
      { revision: 2, assets: ['first', 'arrived-while-saving'] },
    ]);
    gates[1]!.resolve();
    await expect(first).resolves.toBe(true);
    expect(persisted).toEqual(writes);
  });

  it('does not report an acknowledgement when the durable write fails', async () => {
    const persisted: unknown[] = [];
    const coordinator = createSaveCoordinator({
      capture: () => ({ revision: 4 }),
      write: async () => { throw new Error('quota'); },
      onSaved: snapshot => persisted.push(snapshot),
    });
    coordinator.markDirty();
    await expect(coordinator.save()).resolves.toBe(false);
    expect(persisted).toEqual([]);
  });
});
