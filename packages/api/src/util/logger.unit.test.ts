import { createLogRecord, parseLogLevel } from './logger';
import type { Logger } from './logger';
import { runWithRequestScope } from './request-scope';

/**
 * Pure library tests — no Crowi/Mongo/Hono boot (unit project, brief §9.2).
 * Every case that needs a fresh module registry (floor memoization, `DEBUG`
 * latching, the mocked sink boundary) opens its own synchronous
 * `jest.isolateModules` block, registers its doubles with `jest.doMock`
 * inside it, and captures what it needs before the block returns — a
 * file-level double and per-block fresh doubles cannot coexist (brief §9.3).
 * `isolateLoggerModule` is the shared shape of that block: it mocks
 * `./logger-sink`, requires a fresh `./logger` under it, and creates one
 * logger per requested namespace before the block returns.
 */
function isolateLoggerModule(namespaces: string[]): { writeSpy: jest.Mock; loggers: Logger[] } {
  let writeSpy: jest.Mock | undefined;
  let loggers: Logger[] | undefined;
  jest.isolateModules(() => {
    jest.doMock('./logger-sink', () => ({ write: jest.fn(), writeFatal: jest.fn() }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    writeSpy = require('./logger-sink').write as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLogger } = require('./logger') as typeof import('./logger');
    loggers = namespaces.map((namespace) => createLogger(namespace));
  });
  return { writeSpy: writeSpy as jest.Mock, loggers: loggers as Logger[] };
}

describe('structured logger', () => {
  let originalLogLevel: string | undefined;
  let originalDebug: string | undefined;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    originalDebug = process.env.DEBUG;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  });

  describe('AC-C01: parseLogLevel', () => {
    it('parses levels with ASCII whitespace only and rejects NBSP padding', () => {
      expect(parseLogLevel(undefined)).toEqual({ level: 'info' });
      expect(parseLogLevel('')).toEqual({ level: 'info' });
      expect(parseLogLevel('   \t\r\n\f\v')).toEqual({ level: 'info' });
      expect(parseLogLevel('warn')).toEqual({ level: 'warn' });
      expect(parseLogLevel('WARN')).toEqual({ level: 'warn' });
      expect(parseLogLevel('  warn  ')).toEqual({ level: 'warn' });
      expect(parseLogLevel('\t warn \n')).toEqual({ level: 'warn' });
      // NBSP (U+00A0) is not ASCII whitespace: `String.prototype.trim` would
      // strip it, but this parser must not, so the padded value is invalid.
      expect(parseLogLevel(' warn ')).toEqual({ level: 'info', invalidValue: ' warn ' });
      expect(parseLogLevel('bogus')).toEqual({ level: 'info', invalidValue: 'bogus' });
    });
  });

  describe('AC-C02: invalid LOG_LEVEL warning', () => {
    it('offers one bounded ordinary warning and falls back for invalid LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'not-a-level';
      const {
        writeSpy,
        loggers: [logger],
      } = isolateLoggerModule(['crowi:test']);

      logger?.info('first admitted call');
      expect(writeSpy).toHaveBeenCalledTimes(2); // the invalid-LOG_LEVEL warning, then the ordinary call
      const warningCall = writeSpy?.mock.calls[0]?.[0];
      expect(warningCall).toMatchObject({
        level: 'warn',
        namespace: 'crowi:logger',
        message: 'invalid LOG_LEVEL; using info',
        data: { value: 'not-a-level', fallback: 'info' },
      });

      logger?.info('second admitted call');
      // The floor is memoized and the warning is a logical single offer —
      // no second warning on later calls.
      expect(writeSpy?.mock.calls.filter((call) => call[0].message === 'invalid LOG_LEVEL; using info')).toHaveLength(1);
    });
  });

  describe('AC-C03: severity admission and DEBUG namespace selection', () => {
    it('applies the floor before work and DEBUG only to debug namespaces', () => {
      process.env.LOG_LEVEL = 'warn';
      const {
        writeSpy,
        loggers: [logger],
      } = isolateLoggerModule(['crowi:test']);

      const hostileData = {
        get poison(): never {
          throw new Error('must not be touched for a rejected call');
        },
      };
      logger?.debug('below floor', hostileData as unknown as Record<string, unknown>);
      logger?.info('below floor', hostileData as unknown as Record<string, unknown>);
      expect(writeSpy).not.toHaveBeenCalled();

      logger?.warn('at floor');
      logger?.error('at floor', new Error('x'));
      expect(writeSpy).toHaveBeenCalledTimes(2);
    });

    it('admits debug only when DEBUG selects the namespace and the floor already allows debug', () => {
      process.env.LOG_LEVEL = 'debug';
      process.env.DEBUG = 'crowi:enabled-namespace';
      const {
        writeSpy,
        loggers: [enabledLogger, disabledLogger],
      } = isolateLoggerModule(['crowi:enabled-namespace', 'crowi:other-namespace']);

      disabledLogger?.debug('not selected by DEBUG');
      expect(writeSpy).not.toHaveBeenCalled();

      enabledLogger?.debug('selected by DEBUG');
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-C04: Logger method failure containment and error precedence', () => {
    it('contains every logger method failure and gives error argument precedence', () => {
      process.env.LOG_LEVEL = 'debug';
      process.env.DEBUG = 'crowi:test';
      const {
        writeSpy,
        loggers: [logger],
      } = isolateLoggerModule(['crowi:test']);

      const hostileData = {
        get willThrow(): never {
          throw new Error('hostile getter');
        },
      };

      expect(() => logger?.debug('msg', hostileData as unknown as Record<string, unknown>)).not.toThrow();
      expect(() => logger?.info('msg', hostileData as unknown as Record<string, unknown>)).not.toThrow();
      expect(() => logger?.warn('msg', hostileData as unknown as Record<string, unknown>)).not.toThrow();
      expect(() => logger?.error('msg', new Error('real'), hostileData as unknown as Record<string, unknown>)).not.toThrow();

      writeSpy?.mockClear();
      const originalError = new Error('the real one');
      logger?.error('msg', originalError, { error: 'caller cannot win' });
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy?.mock.calls[0]?.[0]?.data?.error).toBe(originalError);
    });
  });

  describe('AC-C05: request scope attachment at record creation', () => {
    it('reads request scope at record creation and omits it outside scope', () => {
      const outside = createLogRecord('info', 'crowi:test', 'no scope');
      expect(outside.requestId).toBeUndefined();
      expect('requestId' in outside).toBe(false);

      const inside = runWithRequestScope({ requestId: 'req-abc' }, () => createLogRecord('info', 'crowi:test', 'with scope'));
      expect(inside.requestId).toBe('req-abc');
    });
  });

  describe('AC-C19: unit Jest project wiring', () => {
    it('selects pure unit files by pattern in the root project graph with an early server floor', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('../../jest.config.js') as { projects: Array<Record<string, unknown>> };
      const unitProject = config.projects.find((p) => p.displayName === 'unit');
      const serverProject = config.projects.find((p) => p.displayName === 'server');

      expect(unitProject?.testMatch).toEqual(['<rootDir>/src/**/*.unit.test.ts']);
      expect(unitProject?.restoreMocks).toBe(true);
      expect(unitProject?.testEnvironment).toBe('node');
      expect(unitProject?.setupFilesAfterEnv).toBeUndefined();
      expect(unitProject?.setupFiles).toBeUndefined();

      expect(serverProject?.setupFiles).toEqual(['./src/test/logging-env.ts']);
      expect(serverProject?.testPathIgnorePatterns).toEqual(expect.arrayContaining(['\\.unit\\.test\\.ts$']));
    });
  });

  describe('AC-C20: lazy first-use floor resolution and memoization', () => {
    it('resolves the floor on first use after import and memoizes it', () => {
      delete process.env.LOG_LEVEL;
      const {
        writeSpy,
        loggers: [logger],
      } = isolateLoggerModule(['crowi:test']);

      // Set AFTER import but BEFORE first use: lazy resolution observes it.
      process.env.LOG_LEVEL = 'error';
      logger?.warn('below the just-set floor');
      expect(writeSpy).not.toHaveBeenCalled();

      // Changing it again after first use must not move the memoized floor.
      process.env.LOG_LEVEL = 'debug';
      logger?.warn('still below the memoized floor');
      expect(writeSpy).not.toHaveBeenCalled();

      logger?.error('at the memoized floor', new Error('x'));
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-C37: LOG_LEVEL taxonomy registration', () => {
    it('registers LOG_LEVEL once without a check and proves LOG_LEVE produces no LOG_LEVEL typo suggestion through validateEnv', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ENV_VAR_DESCRIPTORS, validateEnv } = require('./env-schema') as typeof import('./env-schema');
      const matches = ENV_VAR_DESCRIPTORS.filter((d) => d.name === 'LOG_LEVEL');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.check).toBeUndefined();

      const result = validateEnv({ SECRET_TOKEN: 'logger-test-default-secret-32-characters', LOG_LEVE: 'x' } as unknown as NodeJS.ProcessEnv);
      expect(result.warnings.some((w) => w.includes('LOG_LEVEL'))).toBe(false);
    });
  });
});
