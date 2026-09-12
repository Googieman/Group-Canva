export interface SaveCoordinatorOptions<T> {
  capture(): T;
  write(snapshot: T): Promise<void>;
  onSaved(snapshot: T): void;
}

export interface SaveCoordinator {
  markDirty(): void;
  save(): Promise<boolean>;
}

export function createSaveCoordinator<T>(options: SaveCoordinatorOptions<T>): SaveCoordinator {
  let generation = 0;
  let pending: Promise<boolean> | undefined;
  let requested = false;

  const run = async (): Promise<boolean> => {
    let success = true;
    do {
      requested = false;
      const capturedGeneration = generation;
      try {
        const snapshot = options.capture();
        await options.write(snapshot);
        options.onSaved(snapshot);
      } catch {
        success = false;
        break;
      }
      if (generation !== capturedGeneration) requested = true;
    } while (requested);
    return success;
  };

  return {
    markDirty() { generation++; },
    save() {
      if (pending) { requested = true; return pending; }
      const current = run();
      pending = current;
      void current.then(() => { if (pending === current) pending = undefined; }, () => { if (pending === current) pending = undefined; });
      return current;
    },
  };
}
