import { useEffect, useState, type DependencyList } from 'react';

/**
 * Where the library browser is: a section, and in it a group or a folder, an item, and a slide
 * of that item.
 */
export interface LibraryRoute {
  section: string;
  item?: string;
  folder?: string;
  group?: string;
  slide?: number;
}

/** The answer of an asynchronous read, followed as its inputs change. */
export function useRead<T>(
  read: () => Promise<T>,
  deps: DependencyList,
): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string; deps?: DependencyList }>({});
  useEffect(() => {
    let live = true;
    read().then(
      (value) => live && setState({ value, deps }),
      (error: unknown) =>
        live && setState({ error: error instanceof Error ? error.message : String(error), deps }),
    );
    return () => {
      live = false;
    };
    // The caller names what the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const current =
    state.deps !== undefined &&
    state.deps.length === deps.length &&
    state.deps.every((dep, i) => Object.is(dep, deps[i]));
  return current ? state : {};
}

/** Whether a text matches what the person searched for, in any of its names. */
export function matches(query: string, ...names: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return names.some((name) => name?.toLowerCase().includes(needle));
}
