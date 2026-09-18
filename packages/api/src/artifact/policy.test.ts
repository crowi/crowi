import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { crowi } from 'src/test/setup';
import type { ArtifactDeliveryEnv } from 'src/util/env-schema';
import {
  ARTIFACT_BOOT_NOTE_DISABLED,
  ARTIFACT_BOOT_NOTE_SAME_ORIGIN_ACTIVE,
  ARTIFACT_BOOT_NOTE_SAME_ORIGIN_NEEDS_CLIENT_URL,
  ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE,
  ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_SHADOWS_SAME_ORIGIN,
  ARTIFACT_CONFIG_NAMESPACE,
  ARTIFACT_POLICY_KEY,
} from './config';
import { ARTIFACT_HARD_MAX_BYTES, ARTIFACT_MIN_MAX_BYTES, DEFAULT_ARTIFACT_MAX_BYTES } from './constants';
import {
  computeArtifactPolicyState,
  isArtifactWriteEnabled,
  reportArtifactPolicyAtBoot,
  resetArtifactConfigWarningsForTests,
  resolveArtifactPolicySnapshot,
  resolveArtifactPolicyState,
} from './policy';

const ENV_SEPARATE_ORIGIN: ArtifactDeliveryEnv = { artifactOrigin: 'https://artifacts.example.net', crowiOrigin: 'https://wiki.example.com' };
const ENV_SAME_ORIGIN_ELIGIBLE: ArtifactDeliveryEnv = { artifactOrigin: null, crowiOrigin: 'https://wiki.example.com' };
const ENV_NO_CLIENT_URL: ArtifactDeliveryEnv = { artifactOrigin: null, crowiOrigin: null };

function makeConfig(overrides: { policy?: unknown }): Readonly<Record<string, unknown>> {
  const config: Record<string, unknown> = {};
  if (overrides.policy !== undefined) {
    config[ARTIFACT_POLICY_KEY] = overrides.policy;
  }
  return config;
}

describe('computeArtifactPolicyState', () => {
  describe('§R-1..R-4', () => {
    const baseConfig = (settings: { sameOriginEnabled?: boolean; allowWebFonts?: boolean; maxBytes?: number } = {}) =>
      makeConfig({
        policy: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES, ...settings },
      });

    it('R-1: artifactOrigin set, sameOriginEnabled false -> separate-origin, writeEnabled true, no inactive reason', () => {
      const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: baseConfig({ sameOriginEnabled: false }) });
      expect(state.snapshot).toMatchObject({
        deliveryMode: 'separate-origin',
        artifactOrigin: 'https://artifacts.example.net',
        crowiOrigin: 'https://wiki.example.com',
        writeEnabled: true,
      });
      expect(state.sameOriginInactiveReason).toBeNull();
    });

    it("R-1: artifactOrigin set, sameOriginEnabled true -> separate-origin, reason 'separate-origin-active' (Mode B stored but inactive)", () => {
      const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: baseConfig({ sameOriginEnabled: true }) });
      expect(state.snapshot.deliveryMode).toBe('separate-origin');
      expect(state.snapshot.writeEnabled).toBe(true);
      expect(state.sameOriginInactiveReason).toBe('separate-origin-active');
    });

    it('R-2: artifactOrigin null, sameOriginEnabled true, crowiOrigin set -> same-origin, artifactOrigin === crowiOrigin', () => {
      const state = computeArtifactPolicyState({ env: ENV_SAME_ORIGIN_ELIGIBLE, config: baseConfig({ sameOriginEnabled: true }) });
      expect(state.snapshot).toMatchObject({
        deliveryMode: 'same-origin',
        artifactOrigin: 'https://wiki.example.com',
        crowiOrigin: 'https://wiki.example.com',
        writeEnabled: true,
      });
      expect(state.sameOriginInactiveReason).toBeNull();
    });

    it("R-3: artifactOrigin null, sameOriginEnabled true, crowiOrigin null -> disabled, reason 'client-url-unset'", () => {
      const state = computeArtifactPolicyState({ env: ENV_NO_CLIENT_URL, config: baseConfig({ sameOriginEnabled: true }) });
      expect(state.snapshot).toMatchObject({ deliveryMode: 'disabled', artifactOrigin: null, crowiOrigin: null, writeEnabled: false });
      expect(state.sameOriginInactiveReason).toBe('client-url-unset');
    });

    it('R-4: artifactOrigin null, sameOriginEnabled false, crowiOrigin set -> disabled, no reason', () => {
      const state = computeArtifactPolicyState({ env: ENV_SAME_ORIGIN_ELIGIBLE, config: baseConfig({ sameOriginEnabled: false }) });
      expect(state.snapshot).toMatchObject({ deliveryMode: 'disabled', artifactOrigin: null, crowiOrigin: 'https://wiki.example.com', writeEnabled: false });
      expect(state.sameOriginInactiveReason).toBeNull();
    });

    it('R-4: artifactOrigin null, sameOriginEnabled false, crowiOrigin null -> disabled, no reason', () => {
      const state = computeArtifactPolicyState({ env: ENV_NO_CLIENT_URL, config: baseConfig({ sameOriginEnabled: false }) });
      expect(state.snapshot).toMatchObject({ deliveryMode: 'disabled', artifactOrigin: null, crowiOrigin: null, writeEnabled: false });
      expect(state.sameOriginInactiveReason).toBeNull();
    });

    it('allowWebFonts / maxBytes propagate onto the snapshot regardless of mode', () => {
      const state = computeArtifactPolicyState({
        env: ENV_SEPARATE_ORIGIN,
        config: baseConfig({ allowWebFonts: true, maxBytes: 5 * 1024 * 1024 }),
      });
      expect(state.snapshot.allowWebFonts).toBe(true);
      expect(state.snapshot.maxBytes).toBe(5 * 1024 * 1024);
    });
  });

  describe('§C 表 — reading the stored artifact:policy value', () => {
    it('C-0: a missing artifact:policy key resolves to all defaults with no invalidFields', () => {
      const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: makeConfig({}) });
      expect(state.settings).toEqual({ sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES });
      expect(state.invalidFields).toEqual([]);
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'not-an-object'],
    ])('C-0: artifact:policy = %s -> all defaults + invalidFields === ["policy"] only (not also the 3 fields)', (_label, value) => {
      const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: makeConfig({ policy: value }) });
      expect(state.settings).toEqual({ sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES });
      expect(state.invalidFields).toEqual(['policy']);
    });

    describe('C-1 / C-2: boolean fields', () => {
      it.each([
        ['sameOriginEnabled', true, true, false],
        ['sameOriginEnabled', 'true', false, true],
        ['sameOriginEnabled', 1, false, true],
        ['sameOriginEnabled', undefined, false, false],
        ['allowWebFonts', true, true, false],
        ['allowWebFonts', 'true', false, true],
        ['allowWebFonts', 1, false, true],
        ['allowWebFonts', undefined, false, false],
      ] as const)('%s = %p -> %p (invalid: %p)', (field, raw, expected, invalid) => {
        const record: Record<string, unknown> = { maxBytes: DEFAULT_ARTIFACT_MAX_BYTES };
        if (raw !== undefined) record[field] = raw;
        const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: makeConfig({ policy: record }) });
        expect(state.settings[field]).toBe(expected);
        expect(state.invalidFields.includes(field)).toBe(invalid);
      });
    });

    it.each([
      ['missing', undefined, DEFAULT_ARTIFACT_MAX_BYTES, false],
      ['a non-integer', 1.5, DEFAULT_ARTIFACT_MAX_BYTES, true],
      ['a numeric string', '2097152', DEFAULT_ARTIFACT_MAX_BYTES, true],
      ['below range (65535)', 65535, DEFAULT_ARTIFACT_MAX_BYTES, true],
      ['above range (10485761)', 10485761, DEFAULT_ARTIFACT_MAX_BYTES, true],
      ['the min boundary (65536)', ARTIFACT_MIN_MAX_BYTES, ARTIFACT_MIN_MAX_BYTES, false],
      ['the max boundary (10485760)', ARTIFACT_HARD_MAX_BYTES, ARTIFACT_HARD_MAX_BYTES, false],
    ])('C-3: maxBytes = %s -> %p (invalid: %p)', (_label, raw, expected, invalid) => {
      const record: Record<string, unknown> = { sameOriginEnabled: false, allowWebFonts: false };
      if (raw !== undefined) record.maxBytes = raw;
      const state = computeArtifactPolicyState({ env: ENV_SEPARATE_ORIGIN, config: makeConfig({ policy: record }) });
      expect(state.settings.maxBytes).toBe(expected);
      expect(state.invalidFields.includes('maxBytes')).toBe(invalid);
    });
  });
});

describe('resolveArtifactPolicySnapshot / resolveArtifactPolicyState (booted crowi)', () => {
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    configSnapshot = await snapshotCrowiConfig(crowi);
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  afterEach(() => {
    resetArtifactConfigWarningsForTests();
  });

  describe('AC-DP-2: installer seed + saveConfig round trip', () => {
    it('a fresh install seeds artifact:policy with the documented defaults, and it is the only artifact:* row', async () => {
      const Config = crowi.model('Config');
      await Config.deleteMany({ ns: 'crowi' });
      await Config.applicationInstall();
      await crowi.getConfigService().load();

      const snapshot = resolveArtifactPolicySnapshot(crowi);
      expect(snapshot.allowWebFonts).toBe(false);
      expect(snapshot.maxBytes).toBe(DEFAULT_ARTIFACT_MAX_BYTES);

      const rows = (await Config.find({ ns: 'crowi', key: /^artifact:/ })
        .lean()
        .exec()) as { key: string }[];
      expect(rows.map((r) => r.key)).toEqual([ARTIFACT_POLICY_KEY]);
    });

    it('a custom saved object round-trips through saveConfig -> load -> resolveArtifactPolicySnapshot', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: true, maxBytes: 5 * 1024 * 1024 },
      });
      const snapshot = resolveArtifactPolicySnapshot(crowi);
      expect(snapshot.allowWebFonts).toBe(true);
      expect(snapshot.maxBytes).toBe(5 * 1024 * 1024);
    });
  });

  describe('AC-DP-3: invalid stored values warn once per field per process, never including the value', () => {
    it('a hand-edited object with 2 invalid fields warns exactly once for each, across 3 resolutions', async () => {
      const Config = crowi.model('Config');
      await Config.updateOne(
        { ns: 'crowi', key: ARTIFACT_POLICY_KEY },
        { $set: { value: JSON.stringify({ sameOriginEnabled: 'on', maxBytes: '2097152' }) } },
        { upsert: true },
      ).exec();
      await crowi.getConfigService().load();

      const writes: (() => void)[] = [];
      const bootNoteSpy = jest.spyOn(crowi, 'bootNote').mockImplementation((write) => {
        writes.push(write);
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        resolveArtifactPolicySnapshot(crowi);
        resolveArtifactPolicySnapshot(crowi);
        resolveArtifactPolicySnapshot(crowi);

        for (const write of writes) write();

        const sameOriginCalls = warnSpy.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('sameOriginEnabled'));
        const maxBytesCalls = warnSpy.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('.maxBytes'));
        expect(sameOriginCalls).toHaveLength(1);
        expect(maxBytesCalls).toHaveLength(1);
        expect(warnSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('2097152'))).toBe(false);
        expect(warnSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('"on"'))).toBe(false);
      } finally {
        warnSpy.mockRestore();
        bootNoteSpy.mockRestore();
      }
    });

    it('a hand-edited non-object value warns once with the "policy" field name only', async () => {
      const Config = crowi.model('Config');
      await Config.updateOne({ ns: 'crowi', key: ARTIFACT_POLICY_KEY }, { $set: { value: JSON.stringify('broken') } }, { upsert: true }).exec();
      await crowi.getConfigService().load();

      const writes: (() => void)[] = [];
      const bootNoteSpy = jest.spyOn(crowi, 'bootNote').mockImplementation((write) => {
        writes.push(write);
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        resolveArtifactPolicySnapshot(crowi);
        for (const write of writes) write();

        const policyCalls = warnSpy.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('artifact:policy holds an invalid stored value'));
        expect(policyCalls).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        bootNoteSpy.mockRestore();
      }
    });
  });

  describe('AC-DP-4: snapshot shape / overloads / freeze', () => {
    it('returns a frozen object with exactly 6 fields', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const snapshot = resolveArtifactPolicySnapshot(crowi);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.keys(snapshot)).toHaveLength(6);
    });

    it('the 1-arg overload matches resolveArtifactPolicySnapshot(crowi).writeEnabled', () => {
      expect(isArtifactWriteEnabled(crowi)).toBe(resolveArtifactPolicySnapshot(crowi).writeEnabled);
    });

    it("the 2-arg overload returns the snapshot's own writeEnabled and never re-reads crowi.getArtifactDeliveryEnv / crowi.getConfig", () => {
      const snapshot = resolveArtifactPolicySnapshot(crowi);
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv');
      const configSpy = jest.spyOn(crowi, 'getConfig');
      try {
        expect(isArtifactWriteEnabled(crowi, snapshot)).toBe(snapshot.writeEnabled);
        expect(envSpy).not.toHaveBeenCalled();
        expect(configSpy).not.toHaveBeenCalled();
      } finally {
        envSpy.mockRestore();
        configSpy.mockRestore();
      }
    });

    it('unknown/missing config resolves both overloads to false', async () => {
      const Config = crowi.model('Config');
      await Config.deleteMany({ ns: 'crowi', key: ARTIFACT_POLICY_KEY }).exec();
      await crowi.getConfigService().load();
      expect(isArtifactWriteEnabled(crowi)).toBe(false);
    });

    it('two resolutions of the same in-memory state are equal; a save changes the next resolution', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const first = resolveArtifactPolicySnapshot(crowi);
      const second = resolveArtifactPolicySnapshot(crowi);
      expect(second).toEqual(first);

      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: true, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const third = resolveArtifactPolicySnapshot(crowi);
      expect(third.allowWebFonts).toBe(true);
      expect(third.allowWebFonts).not.toBe(first.allowWebFonts);
    });
  });

  describe('AC-DP-5: R-1 / R-3 reproduced on a booted harness via a getArtifactDeliveryEnv spy', () => {
    it('R-1: a spied artifactOrigin resolves separate-origin with writeEnabled true', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_SEPARATE_ORIGIN);
      try {
        const snapshot = resolveArtifactPolicySnapshot(crowi);
        expect(snapshot.deliveryMode).toBe('separate-origin');
        expect(snapshot.artifactOrigin).toBe('https://artifacts.example.net');
        expect(snapshot.writeEnabled).toBe(true);
      } finally {
        envSpy.mockRestore();
      }
    });

    it("R-3: a spied crowiOrigin:null with sameOriginEnabled:true resolves disabled + reason 'client-url-unset'", async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_NO_CLIENT_URL);
      try {
        const state = resolveArtifactPolicyState(crowi);
        expect(state.snapshot.deliveryMode).toBe('disabled');
        expect(state.snapshot.writeEnabled).toBe(false);
        expect(state.sameOriginInactiveReason).toBe('client-url-unset');
      } finally {
        envSpy.mockRestore();
      }
    });
  });

  describe('AC-DP-6: reportArtifactPolicyAtBoot emits exactly one line per state', () => {
    const captureBootNoteWrites = (): (() => void)[] => {
      const writes: (() => void)[] = [];
      jest.spyOn(crowi, 'bootNote').mockImplementation((write) => {
        writes.push(write);
      });
      return writes;
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('R-1 with no inactive reason -> M-4a only', async () => {
      await crowi.getConfigService().saveConfig('crowi', {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_SEPARATE_ORIGIN);
      const writes = captureBootNoteWrites();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      reportArtifactPolicyAtBoot(crowi);

      expect(writes).toHaveLength(1);
      writes[0]();
      expect(logSpy).toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE);
      envSpy.mockRestore();
    });

    it('R-1 with an inactive reason -> M-3 only, never M-4a', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_SEPARATE_ORIGIN);
      const writes = captureBootNoteWrites();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      reportArtifactPolicyAtBoot(crowi);

      expect(writes).toHaveLength(1);
      writes[0]();
      expect(logSpy).toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_SHADOWS_SAME_ORIGIN);
      expect(logSpy).not.toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE);
      envSpy.mockRestore();
    });

    it('R-2 (same-origin active) -> M-4b only', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_SAME_ORIGIN_ELIGIBLE);
      const writes = captureBootNoteWrites();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      reportArtifactPolicyAtBoot(crowi);

      expect(writes).toHaveLength(1);
      writes[0]();
      expect(logSpy).toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_SAME_ORIGIN_ACTIVE);
      envSpy.mockRestore();
    });

    it('R-3 (same-origin needs CLIENT_URL) -> M-2 only', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_NO_CLIENT_URL);
      const writes = captureBootNoteWrites();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      reportArtifactPolicyAtBoot(crowi);

      expect(writes).toHaveLength(1);
      writes[0]();
      expect(warnSpy).toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_SAME_ORIGIN_NEEDS_CLIENT_URL);
      envSpy.mockRestore();
    });

    it('R-4 (nothing configured) -> M-1 only', async () => {
      await crowi.getConfigService().saveConfig(ARTIFACT_CONFIG_NAMESPACE, {
        [ARTIFACT_POLICY_KEY]: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES },
      });
      const envSpy = jest.spyOn(crowi, 'getArtifactDeliveryEnv').mockReturnValue(ENV_SAME_ORIGIN_ELIGIBLE);
      const writes = captureBootNoteWrites();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      reportArtifactPolicyAtBoot(crowi);

      expect(writes).toHaveLength(1);
      writes[0]();
      expect(warnSpy).toHaveBeenCalledWith(ARTIFACT_BOOT_NOTE_DISABLED);
      envSpy.mockRestore();
    });
  });
});
