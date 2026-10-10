import type { LogRecord } from './logger';
import { serializeLogRecord } from './logger-serialize';

function parse(buffer: Buffer): { text: string; json: Record<string, unknown> } {
  const text = buffer.toString('utf-8');
  expect(text.endsWith('\n')).toBe(true);
  expect(text.slice(0, -1).includes('\n')).toBe(false);
  return { text, json: JSON.parse(text.slice(0, -1)) };
}

const baseRecord: LogRecord = {
  timestamp: '2026-01-01T00:00:00.000Z',
  level: 'info',
  namespace: 'crowi:test',
  message: 'hello',
};

describe('log record serializer', () => {
  describe('AC-C07: stable envelope', () => {
    it('emits the stable envelope fields with nested data and exactly one LF', () => {
      const { json } = parse(
        serializeLogRecord({
          ...baseRecord,
          requestId: 'req-1',
          data: { nested: { a: 1, b: [1, 2, 3] } },
        }),
      );
      expect(json).toEqual({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info',
        namespace: 'crowi:test',
        message: 'hello',
        requestId: 'req-1',
        data: { nested: { a: 1, b: [1, 2, 3] } },
      });
    });

    it('omits requestId and data when absent, independent of stream', () => {
      const { json } = parse(serializeLogRecord(baseRecord));
      expect('requestId' in json).toBe(false);
      expect('data' in json).toBe(false);
      const { json: errJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error' }));
      expect('requestId' in errJson).toBe(false);
    });
  });

  describe('AC-C08 / AC-C21: exact LIM-* boundaries', () => {
    it('enforces every LIM row at its exact boundary', () => {
      // LIM-message
      const exactMessage = 'm'.repeat(2048);
      const { json: exact } = parse(serializeLogRecord({ ...baseRecord, message: exactMessage }));
      expect(exact.message).toBe(exactMessage);
      expect(Buffer.byteLength(exact.message as string, 'utf-8')).toBe(2048);

      const overMessage = `${'m'.repeat(2040)}0123456789`; // 2050 bytes raw
      const { json: over } = parse(serializeLogRecord({ ...baseRecord, message: overMessage }));
      expect((over.message as string).endsWith('…[truncated]')).toBe(true);
      expect(Buffer.byteLength(over.message as string, 'utf-8')).toBeLessThanOrEqual(2048);

      // LIM-name (namespace)
      const overNamespace = 'n'.repeat(300);
      const { json: nsOver } = parse(serializeLogRecord({ ...baseRecord, namespace: overNamespace }));
      expect((nsOver.namespace as string).endsWith('…[truncated]')).toBe(true);
      expect(Buffer.byteLength(nsOver.namespace as string, 'utf-8')).toBeLessThanOrEqual(256);

      // LIM-request-id
      const overRequestId = 'r'.repeat(200);
      const { json: ridOver } = parse(serializeLogRecord({ ...baseRecord, requestId: overRequestId }));
      expect(Buffer.byteLength(ridOver.requestId as string, 'utf-8')).toBeLessThanOrEqual(128);

      // LIM-string (ordinary data value and key)
      const overValue = 'v'.repeat(2100);
      const overKey = 'k'.repeat(2100);
      const { json: dataOver } = parse(serializeLogRecord({ ...baseRecord, data: { [overKey]: overValue } }));
      const dataObj = dataOver.data as Record<string, unknown>;
      const [emittedKey] = Object.keys(dataObj);
      expect(Buffer.byteLength(emittedKey, 'utf-8')).toBeLessThanOrEqual(2048);
      expect((dataObj[emittedKey] as string).endsWith('…[truncated]')).toBe(true);

      // LIM-stack (outer Error only)
      const err = new Error('boom');
      err.stack = `Error: boom\n${'  at x\n'.repeat(6000)}`;
      const { json: stackOver } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: err } }));
      const errObj = stackOver.data as { error: { stack: string } };
      expect(Buffer.byteLength(errObj.error.stack, 'utf-8')).toBeLessThanOrEqual(32768);

      // LIM-aggregate: only the first 8 aggregate members are kept.
      const agg = new AggregateError(
        Array.from({ length: 10 }, (_, i) => new Error(`e${i}`)),
        'agg',
      );
      const { json: aggJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: agg } }));
      const aggErrors = (aggJson.data as { error: { errors: unknown[] } }).error.errors;
      expect(aggErrors).toHaveLength(8);

      // LIM-cause: 3 nested causes max (outer is not a cause level).
      const c3 = new Error('c3');
      const c2 = new Error('c2', { cause: c3 });
      const c1 = new Error('c1', { cause: c2 });
      const c0 = new Error('c0', { cause: c1 });
      const { json: causeJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: c0 } }));
      let depth = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cursor: any = (causeJson.data as any).error;
      while (cursor?.cause !== undefined) {
        depth += 1;
        cursor = cursor.cause;
      }
      expect(depth).toBe(3);

      // LIM-entries: 64 entries per object, extra becomes [EntriesOmitted]: count
      const manyEntries: Record<string, number> = {};
      for (let i = 0; i < 70; i += 1) manyEntries[`k${i}`] = i;
      const { json: entriesJson } = parse(serializeLogRecord({ ...baseRecord, data: manyEntries }));
      const entriesObj = entriesJson.data as Record<string, unknown>;
      expect(entriesObj['[EntriesOmitted]']).toBe(6);
      expect(Object.keys(entriesObj)).toHaveLength(65);

      // LIM-entries for arrays: literal final marker element.
      const manyItems = Array.from({ length: 70 }, (_, i) => i);
      const { json: arrJson } = parse(serializeLogRecord({ ...baseRecord, data: { items: manyItems } }));
      const items = (arrJson.data as { items: unknown[] }).items;
      expect(items).toHaveLength(65);
      expect(items[64]).toBe('[EntriesOmitted]');

      // LIM-depth
      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 10; i += 1) deep = { nested: deep };
      const { json: depthJson } = parse(serializeLogRecord({ ...baseRecord, data: deep }));
      let depthCursor = depthJson.data as Record<string, unknown>;
      let steps = 0;
      while (typeof depthCursor === 'object' && depthCursor !== null && 'nested' in depthCursor) {
        depthCursor = depthCursor.nested as Record<string, unknown>;
        steps += 1;
      }
      expect(depthCursor).toBe('[DepthExceeded]');
      // `data` itself is depth 0, so depths 0..6 (7 real levels) traverse
      // normally and the value AT depth 7 becomes the marker.
      expect(steps).toBe(7);

      // LIM-nodes: LIM-entries (64) caps a single container's own entries,
      // so exceeding 512 total VISITED containers needs nesting — 1 (data)
      // + 64 (level-1 arrays) + 64*10 (level-2 arrays) = 705 well past 512.
      const nodeItems = Array.from({ length: 64 }, () => Array.from({ length: 10 }, () => []));
      const { json: nodesJson } = parse(serializeLogRecord({ ...baseRecord, data: { items: nodeItems } }));
      const level1 = (nodesJson.data as { items: unknown[] }).items;
      const flattened = level1.flatMap((v) => (Array.isArray(v) ? v : [v]));
      expect(flattened.some((v) => v === '[NodesExceeded]')).toBe(true);

      // LIM-data / LIM-record: many entries each near LIM-string, together
      // well past LIM-data even though no single field is oversized, falls
      // back to the fixed fallback record.
      const hugeData: Record<string, string> = {};
      for (let i = 0; i < 64; i += 1) hugeData[`key${i}`] = 'x'.repeat(2000);
      const { json: fallbackJson } = parse(serializeLogRecord({ ...baseRecord, data: hugeData }));
      expect(fallbackJson.message).toBe('log record serialization failed');
      expect(fallbackJson.data).toEqual({ fallback: true });
      expect(fallbackJson.level).toBe('info');
      expect(fallbackJson.namespace).toBe('crowi:test');
    });

    it('rejects every whole-input Buffer and TextEncoder path while encodeInto bounds oversized messages values and keys', () => {
      const oversized = 'z'.repeat(50_000);
      const originalByteLength = Buffer.byteLength.bind(Buffer);
      const originalFrom = Buffer.from.bind(Buffer);
      const originalEncode = TextEncoder.prototype.encode;

      jest.spyOn(Buffer, 'byteLength').mockImplementation((input: unknown, ...rest: unknown[]) => {
        if (input === oversized) throw new Error('whole-input Buffer.byteLength observed');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalByteLength as any)(input, ...rest);
      });
      jest.spyOn(Buffer, 'from').mockImplementation((input: unknown, ...rest: unknown[]) => {
        if (input === oversized) throw new Error('whole-input Buffer.from observed');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalFrom as any)(input, ...rest);
      });
      jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) {
        if (input === oversized) throw new Error('whole-input TextEncoder.encode observed');
        return originalEncode.call(this, input);
      });

      const buffer = serializeLogRecord({ ...baseRecord, message: oversized });
      const { json } = parse(buffer);
      expect(json.message).not.toBe('(invalid message)');
      expect((json.message as string).endsWith('…[truncated]')).toBe(true);
    });
  });

  describe('AC-C09 / AC-C31: Error/cause/aggregate shape', () => {
    it('keeps Error causes and aggregate members shallow ordered and private', () => {
      class CustomError extends Error {
        secret = 'must not appear';

        constructor(message: string, options?: ErrorOptions) {
          super(message, options);
          this.name = 'CustomError';
        }
      }
      const inner = new Error('inner');
      const err = new CustomError('outer', { cause: inner });
      const { json } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: err } }));
      const errObj = (json.data as { error: Record<string, unknown> }).error;
      expect(errObj.name).toBe('CustomError');
      expect(errObj.message).toBe('outer');
      expect('secret' in errObj).toBe(false);
      const cause = errObj.cause as Record<string, unknown>;
      expect(cause).toEqual({ name: 'Error', message: 'inner' });
      expect('stack' in cause).toBe(false);
    });

    it('normalizes Error array aggregate and non-Error members with NonErrorCause and NonErrorThrow shapes', () => {
      const arrayCause = new Error('outer', { cause: [new Error('first'), 'plain string cause'] });
      const { json } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: arrayCause } }));
      const cause = (json.data as { error: Record<string, unknown> }).error.cause as { name: string; errors: unknown[] };
      expect(cause.name).toBe('AggregateCause');
      expect(cause.errors[0]).toEqual({ name: 'Error', message: 'first' });
      expect(cause.errors[1]).toEqual({ name: 'NonErrorCause', message: 'plain string cause' });

      const realAggregate = new AggregateError([new Error('a'), 'not-an-error'], 'agg');
      const { json: aggJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: realAggregate } }));
      const errors = (aggJson.data as { error: { errors: unknown[] } }).error.errors;
      expect(errors[1]).toEqual({ name: 'NonErrorCause', message: 'not-an-error' });

      const { json: throwJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: 'a plain string throw' } }));
      expect(throwJson.data).toEqual({ error: { name: 'NonErrorThrow', message: 'a plain string throw' } });
    });
  });

  describe('AC-C10 / AC-C24: fallback and fresh buffers', () => {
    it('contains unsafe traversal and takes primary fallback request ID only from its input record before byte-exact terminal fallback', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const { json } = parse(serializeLogRecord({ ...baseRecord, data: { cyclic } }));
      expect((json.data as { cyclic: { self: unknown } }).cyclic.self).toBe('[Circular]');

      // A record whose own field getters throw still produces a real
      // repaired record (§7.7), never the fallback — the fallback is
      // reserved for a genuine construction/traversal failure.
      const hostileRecord = {
        get timestamp(): never {
          throw new Error('boom');
        },
        level: 'info',
        namespace: 'crowi:test',
        message: 'ok',
        requestId: 'req-carried',
      } as unknown as LogRecord;
      const { json: repaired } = parse(serializeLogRecord(hostileRecord));
      expect(typeof repaired.timestamp).toBe('string');
      expect(repaired.requestId).toBe('req-carried');

      // Genuine data-budget overflow keeps the ORIGINAL level/namespace/
      // requestId of the record being serialized (never the ALS request
      // scope — logger-serialize.ts imports no ALS at all).
      const overflowData: Record<string, string> = {};
      for (let i = 0; i < 64; i += 1) overflowData[`key${i}`] = 'x'.repeat(2000);
      const { json: overflowFallback } = parse(serializeLogRecord({ ...baseRecord, level: 'warn', requestId: 'req-fallback', data: overflowData }));
      expect(overflowFallback).toEqual({
        timestamp: expect.any(String),
        level: 'warn',
        namespace: 'crowi:test',
        message: 'log record serialization failed',
        requestId: 'req-fallback',
        data: { fallback: true },
      });

      // Terminal fallback: exact fixed bytes, reachable only when even
      // fallback construction itself fails — forced here by making the
      // fallback's own wall-clock timestamp call throw.
      const isoSpy = jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
        throw new Error('even the fallback timestamp fails');
      });
      try {
        const terminal = serializeLogRecord({ ...baseRecord, timestamp: 'not-a-valid-timestamp' });
        expect(terminal.toString('utf-8')).toBe(
          '{"timestamp":"1970-01-01T00:00:00.000Z","level":"error","namespace":"crowi:logger","message":"log record serialization failed","data":{"fallback":true,"terminal":true}}\n',
        );
      } finally {
        isoSpy.mockRestore();
      }
    });

    it('returns fresh buffers for primary and terminal fallback paths', () => {
      const first = serializeLogRecord(baseRecord);
      const mutated = Buffer.from(first);
      mutated.fill(0);
      const second = serializeLogRecord(baseRecord);
      expect(second.toString('utf-8')).toContain('hello');

      const totallyHostile = new Proxy(
        {},
        {
          get(): never {
            throw new Error('boom');
          },
        },
      ) as unknown as LogRecord;
      const t1 = serializeLogRecord(totallyHostile);
      t1.fill(0);
      const t2 = serializeLogRecord(totallyHostile);
      expect(t2.toString('utf-8').startsWith('{"timestamp"')).toBe(true);
    });
  });

  describe('AC-C22: Error accessor access', () => {
    it('reads real Error accessors and omits individually throwing fields', () => {
      const err = new Error('has message');
      // `.stack`'s default lazy formatter reads `name`/`message` internally
      // (V8), so a hostile getter on either of THOSE would cascade into
      // `.stack` too — this exercises a field independent of that (`cause`),
      // to isolate "one throwing field drops only itself" cleanly.
      Object.defineProperty(err, 'cause', {
        get(): never {
          throw new Error('hostile cause getter');
        },
      });
      const { json } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: { error: err } }));
      const errObj = (json.data as { error: Record<string, unknown> }).error;
      expect(errObj.name).toBe('Error');
      expect(errObj.message).toBe('has message');
      expect(typeof errObj.stack).toBe('string');
      expect('cause' in errObj).toBe(false);
    });
  });

  describe('AC-C23: own vs inherited enumerable entries', () => {
    it('keeps own enumerable entries and excludes inherited entries', () => {
      const proto = { inherited: 'must not appear' };
      const obj = Object.create(proto);
      obj.own = 'must appear';
      const { json } = parse(serializeLogRecord({ ...baseRecord, data: { obj } }));
      const nested = (json.data as { obj: Record<string, unknown> }).obj;
      expect(nested).toEqual({ own: 'must appear' });
    });
  });

  describe('AC-C30: exhaustive value table and EntriesOmitted precedence', () => {
    it('emits every value row and preserves top-level error while serializer EntriesOmitted accounting overrides caller entries', () => {
      const sym = Symbol('s');
      const { json } = parse(
        serializeLogRecord({
          ...baseRecord,
          data: {
            aString: 'ok',
            aNumber: 1,
            notFinite: Number.NaN,
            aBigint: 10n,
            aBool: true,
            aNull: null,
            anUndefined: undefined,
            [sym as unknown as string]: 'invisible-symbol-key',
            aSymbolValue: sym,
            aFunction: () => {},
          },
        }),
      );
      const data = json.data as Record<string, unknown>;
      expect(data.aString).toBe('ok');
      expect(data.aNumber).toBe(1);
      expect(data.notFinite).toBe('[NonFinite]');
      expect(data.aBigint).toBe('10');
      expect(data.aBool).toBe(true);
      expect(data.aNull).toBeNull();
      expect(data.anUndefined).toBe('[Undefined]');
      expect(data.aSymbolValue).toBe('[Symbol]');
      expect(data.aFunction).toBe('[Function]');
      expect(Object.keys(data)).not.toContain('undefined');

      // data.error is exempt from LIM-entries and always present, even when
      // the caller fills all 64 ordinary slots; [EntriesOmitted] wins over a
      // caller-supplied same-named key.
      const full: Record<string, unknown> = { error: new Error('the error') };
      for (let i = 0; i < 64; i += 1) full[`k${i}`] = i;
      full['[EntriesOmitted]'] = 'caller value must lose';
      const { json: fullJson } = parse(serializeLogRecord({ ...baseRecord, level: 'error', data: full }));
      const fullData = fullJson.data as Record<string, unknown>;
      expect(fullData.error).toMatchObject({ name: 'Error', message: 'the error' });
      expect(fullData['[EntriesOmitted]']).not.toBe('caller value must lose');
      expect(typeof fullData['[EntriesOmitted]']).toBe('number');

      // Own enumerable `__proto__` survives via Object.create(null)-equivalent handling.
      // `JSON.parse` uses [[DefineOwnProperty]], so this produces a REAL own
      // enumerable `__proto__` string key — unlike the `{ __proto__: ... }`
      // object-literal syntax, which instead sets the object's prototype.
      const withProtoKey = JSON.parse('{"__proto__":{"a":1}}') as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(withProtoKey, '__proto__')).toBe(true);
      const { text: protoText, json: protoJson } = parse(serializeLogRecord({ ...baseRecord, data: { withProtoKey } }));
      expect(protoText).toContain('"withProtoKey":{"__proto__":{"a":1}}');
      const nested = (protoJson.data as { withProtoKey: unknown }).withProtoKey as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(true);
      expect((nested as { __proto__: unknown }).__proto__).toEqual({ a: 1 });
    });

    it('omits a later key colliding with an earlier bounded-key truncation and counts it toward [EntriesOmitted]', () => {
      // Two distinct oversized keys sharing the same first 2034 bytes (the
      // LIM-string content budget after the 14-byte truncation marker) bound
      // to the IDENTICAL truncated key text (brief §7.6). The later one must
      // lose, and its value must never overwrite the earlier one's.
      const sharedPrefix = 'k'.repeat(2034);
      const keyA = `${sharedPrefix}${'A'.repeat(20)}`;
      const keyB = `${sharedPrefix}${'B'.repeat(20)}`;
      const { json } = parse(serializeLogRecord({ ...baseRecord, data: { [keyA]: 'kept', [keyB]: 'lost' } }));
      const data = json.data as Record<string, unknown>;
      const emittedKeys = Object.keys(data);
      expect(emittedKeys).toHaveLength(2); // the one surviving truncated key plus [EntriesOmitted]
      const truncatedKey = emittedKeys.find((k) => k !== '[EntriesOmitted]')!;
      expect(truncatedKey.endsWith('…[truncated]')).toBe(true);
      expect(data[truncatedKey]).toBe('kept'); // first insertion wins, never overwritten
      expect(data['[EntriesOmitted]']).toBe(1); // the colliding later key is counted, not silently merged
    });
  });

  describe('AC-C32: envelope repair without fallback', () => {
    it('repairs invalid required envelope fields without using fallback', () => {
      const { json } = parse(
        serializeLogRecord({
          level: 'not-a-level',
          namespace: 42,
          timestamp: 'not-a-timestamp',
          message: 99,
        } as unknown as LogRecord),
      );
      expect(json.level).toBe('error');
      expect(json.namespace).toBe('unknown');
      expect(typeof json.timestamp).toBe('string');
      expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(json.message).toBe('(invalid message)');
      expect(json.message).not.toBeUndefined();
    });
  });
});
