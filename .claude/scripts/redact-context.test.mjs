import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { REDACTION_PATTERNS, redact, redactContext, takeChars } from './redact-context.mjs'

const CLI = fileURLToPath(new URL('./redact-context.mjs', import.meta.url))

test('redacts a multi-line PEM private key (the case a line-based sed cannot match)', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nfoo/bar\n-----END RSA PRIVATE KEY-----'
  const out = redact(`before\n${pem}\nafter`)
  assert.ok(!out.includes('MIIEow'))
  assert.ok(out.includes('[REDACTED]'))
  assert.ok(out.startsWith('before\n'))
  assert.ok(out.endsWith('\nafter'))
})

test('redacts the token fields crowi-qa §12 names, keeping the field name', () => {
  const body =
    '{"accessToken":"eyJa.bb.cc","refreshToken":"rt-1","wsToken":"w","token":"t","password":"p","cookie":"crowi.accessToken=zzz","user":"u"}'
  const out = redact(body)
  assert.ok(out.includes('"accessToken":"[REDACTED]"'))
  assert.ok(out.includes('"refreshToken":"[REDACTED]"'))
  assert.ok(out.includes('"wsToken":"[REDACTED]"'))
  assert.ok(out.includes('"token":"[REDACTED]"'))
  assert.ok(out.includes('"password":"[REDACTED]"'))
  assert.ok(out.includes('"cookie":"[REDACTED]"'))
  assert.ok(out.includes('"user":"u"'), 'non-secret fields survive')
})

test('redacts Authorization, Cookie and Set-Cookie header values, keeping the header name', () => {
  const raw =
    'Authorization: Bearer abc.def.ghi\nCookie: crowi.accessToken=zzz\nSet-Cookie: crowi.wsToken=yyy; HttpOnly\nAccept: text/html'
  const out = redact(raw)
  assert.match(out, /^Authorization: \[REDACTED\]$/m)
  assert.match(out, /^Cookie: \[REDACTED\]$/m)
  assert.match(out, /^Set-Cookie: \[REDACTED\]$/m)
  assert.ok(out.includes('Accept: text/html'))
})

test('redacts a JSON "set-cookie" field, both as a string and as an array (fetch Headers -> Object.fromEntries shape)', () => {
  const stringForm = redact('{"headers":{"set-cookie":"crowi.sessionId=abcdef1234567890; HttpOnly","content-type":"text/plain"}}')
  assert.ok(stringForm.includes('"set-cookie":"[REDACTED]"'))
  assert.ok(!stringForm.includes('sessionId=abcdef1234567890'))
  assert.ok(stringForm.includes('"content-type":"text/plain"'), 'unrelated fields survive')

  const arrayForm = redact('{"set-cookie":["crowi.sessionId=a","crowi.csrf=b"]}')
  assert.ok(arrayForm.includes('"set-cookie":"[REDACTED]"'))
  assert.ok(!arrayForm.includes('crowi.sessionId=a'))
  assert.ok(!arrayForm.includes('crowi.csrf=b'))
})

test('redacts a bare JWT outside any field (e.g. in a URL or log line)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P'
  const out = redact(`GET /collab?token=${jwt} 101`)
  assert.ok(!out.includes(jwt))
  assert.ok(out.includes('[REDACTED]'))
})

test('takeChars cuts by code point, never splitting a surrogate pair', () => {
  assert.equal(takeChars('日本語テキスト', 3), '日本語')
  assert.equal(takeChars('a😀b', 2), 'a😀')
  const cut = takeChars('あ'.repeat(10), 5)
  assert.ok(Buffer.from(cut, 'utf8').toString('utf8') === cut, 'no broken byte sequence')
})

test('takeChars without a finite bound returns the input unchanged', () => {
  assert.equal(takeChars('abc', undefined), 'abc')
  assert.equal(takeChars('abc', Number.POSITIVE_INFINITY), 'abc')
  assert.equal(takeChars('abc', -1), 'abc')
})

test('redactContext composes redact + take', () => {
  const out = redactContext('AKIAABCDEFGHIJKLMNOP tail', { take: 10 })
  assert.equal(out, '[REDACTED]')
})

test('every pattern entry has a global regex and a string substitution', () => {
  for (const { re, sub } of REDACTION_PATTERNS) {
    assert.ok(re instanceof RegExp && re.global, `${re} must be global`)
    assert.equal(typeof sub, 'string')
  }
})

test('CLI: stdin -> stdout with --take, and rejects a negative --take', () => {
  const out = execFileSync(process.execPath, [CLI, '--take', '10'], { input: 'AKIAABCDEFGHIJKLMNOP tail' })
  assert.equal(out.toString('utf8'), '[REDACTED]')
  assert.throws(() => execFileSync(process.execPath, [CLI, '--take', '-1'], { input: 'x', stdio: 'pipe' }))
})
