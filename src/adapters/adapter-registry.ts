// ---------------------------------------------------------------------------
// Adapter registry — dynamic source adapter management
// ---------------------------------------------------------------------------

import type { SourceAdapter } from '../types.js';

export class AdapterRegistry {
  private adapters = new Map<string, SourceAdapter>();

  /** Register a source adapter */
  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Unregister an adapter by name */
  unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  /** Get an adapter by name */
  get(name: string): SourceAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Get all registered adapters */
  getAll(): SourceAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** List adapter names */
  listNames(): string[] {
    return Array.from(this.adapters.keys());
  }

  /** Check if an adapter is registered */
  has(name: string): boolean {
    return this.adapters.has(name);
  }
}
