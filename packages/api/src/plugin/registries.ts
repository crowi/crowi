import type {
  AuthDriver,
  AuthRegistry,
  MailSender,
  MailSenderRegistry,
  NotifierDriver,
  NotifierRegistry,
  SearchDriver,
  SearchRegistry,
  StorageDriver,
  StorageRegistry,
} from '@crowi/plugin-api';

/**
 * Generic backing registry for all the typed registries below. Each
 * registry stores `(driverName → driver)` and remembers which plugin
 * registered each entry so the runtime can give clear error messages
 * on collisions.
 */
export class DriverRegistry<T> {
  private drivers = new Map<string, { plugin: string; driver: T }>();

  constructor(private readonly kind: string) {}

  register(driverName: string, driver: T, registeringPlugin: string): void {
    const existing = this.drivers.get(driverName);
    if (existing) {
      throw new Error(`Plugin '${registeringPlugin}' tried to register ${this.kind} driver '${driverName}', but '${existing.plugin}' already did.`);
    }
    this.drivers.set(driverName, { plugin: registeringPlugin, driver });
  }

  get(driverName: string): T | undefined {
    return this.drivers.get(driverName)?.driver;
  }

  has(driverName: string): boolean {
    return this.drivers.has(driverName);
  }

  /**
   * Reverse lookup: the registered `(driverName, plugin)` for a driver
   * instance, or undefined. Lets handlers report the active driver's
   * name without re-implementing the identity scan.
   */
  entryOf(driver: T): { driverName: string; plugin: string } | undefined {
    for (const [driverName, entry] of this.drivers) {
      if (entry.driver === driver) return { driverName, plugin: entry.plugin };
    }
    return undefined;
  }

  list(): { driverName: string; plugin: string }[] {
    return Array.from(this.drivers.entries()).map(([driverName, { plugin }]) => ({ driverName, plugin }));
  }
}

/**
 * Per-plugin scope handed to `registerStorage(scope, ctx)`. Closes
 * over the registering plugin's name so we don't have to make plugins
 * pass it themselves on every call.
 */
export const makeStorageScope = (registry: DriverRegistry<StorageDriver>, plugin: string): StorageRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeSearchScope = (registry: DriverRegistry<SearchDriver>, plugin: string): SearchRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeAuthScope = (registry: DriverRegistry<AuthDriver>, plugin: string): AuthRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeNotifierScope = (registry: DriverRegistry<NotifierDriver>, plugin: string): NotifierRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});

export const makeMailScope = (registry: DriverRegistry<MailSender>, plugin: string): MailSenderRegistry => ({
  register: (driverName, driver) => registry.register(driverName, driver, plugin),
});
