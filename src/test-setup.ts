import "@testing-library/jest-dom/vitest";

// Radix measures its own parts with ResizeObserver, which jsdom does not
// implement — rendering a Checkbox, Select or Tooltip throws without this.
// A no-op is enough: nothing under test asserts on a measured size.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Node 26 ships its own `localStorage`/`sessionStorage` globals, left undefined
// unless the process was started with --localstorage-file. Vitest's jsdom
// environment aliases `window` to `globalThis`, so those undefined globals
// shadow the ones jsdom provides and every storage read in a test throws.
// Installing a real Web Storage here is what makes jsdom behave like a browser
// again; anything reading localStorage — the theme, the auth session store —
// is untestable otherwise.
class TestStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  [name: string]: unknown;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, {
    value: new TestStorage(),
    configurable: true,
    writable: true,
  });
}
