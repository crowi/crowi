#!/usr/bin/env node
// redact-context.mjs — テキストを codex prompt / レビュー証跡へ載せる前に secret を
// redact し、必要なら先頭 N コードポイントへ切り詰める共有 helper。
//
// crowi-qa SKILL §12 は「codex-run.sh へのオフロードは redaction 済みログのみ」を
// 規約として持つが、これまで実装が存在せず、各 run がその場しのぎで redact していた。
// この helper が §12 の機械的な実装になる: Authorization / Cookie ヘッダ、
// password / accessToken / refreshToken / wsToken / token の JSON フィールド、
// JWT 文字列、そして crowi が実際に扱う資格情報の形
// (AWS アクセスキー = plugin-storage-aws-s3、Slack トークン / webhook = plugin-slack、
// Resend API キー = plugin-mail-resend、GitHub トークン = gh CLI、PEM 秘密鍵)。
//
// Usage:
//   printf '%s' "$RAW_TEXT" | node .claude/scripts/redact-context.mjs [--take <N>]
//   --take <N>: redact 後に先頭 N コードポイントへ切り詰める(既定は切り詰めなし)。
//
// 切り詰めに head -c を使わないこと: バイト単位のため、日本語のようなマルチバイト
// 文字が N バイト目をまたぐと末尾に不完全なバイト列が残り、下流 (codex exec の
// prompt 読み込み等) が invalid UTF-8 で落ちる。コードポイント単位で切ることで
// サロゲートペア (絵文字) も割らない。
//
// sed に書き直さないこと: sed は行単位のため複数行の PEM 秘密鍵を跨いだマッチが
// できない。node の [\s\S] でまとめて処理する。

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// { re, sub } の配列。sub にキャプチャ ($1) を使えるので、ヘッダ名やフィールド名を
// 残したまま値だけを [REDACTED] にできる (crowi-qa §12 の「値の置換」規則)。
export const REDACTION_PATTERNS = [
  // JSON フィールド単位 (crowi-qa §12: フィールド名で機械的にマッチ)。値は文字列
  // (`"..."`) と配列 (`[...]`) の両方を受ける — fetch の Headers を
  // Object.fromEntries() すると "set-cookie" は配列になりうる。`[^\]]*` は最初の
  // `]` で終端するので、値そのものに `]` を含む cookie はそこで切れるが、それでも
  // redact はされる (境界がずれるだけで漏洩はしない)。
  {
    re: /("(?:password|accessToken|refreshToken|wsToken|token|clientSecret|cookie|setCookie|set-cookie)"\s*:\s*)("[^"]*"|\[[^\]]*\])/gi,
    sub: '$1"[REDACTED]"',
  },
  // HTTP ヘッダ (crowi-qa §12: Authorization と Cookie は値全体を置換。Set-Cookie は
  // "cookie" だけでは行頭アンカーにマッチしないので独立した選択肢として持つ)
  { re: /^([ \t]*(?:authorization|set-cookie|cookie)[ \t]*:).*$/gim, sub: '$1 [REDACTED]' },
  // JWT (crowi の access/refresh/ws token はフィールド外 — URL やログ行 — にも現れる)
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, sub: '[REDACTED]' },
  { re: /AKIA[0-9A-Z]{16}/g, sub: '[REDACTED]' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, sub: '[REDACTED]' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, sub: '[REDACTED]' },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, sub: '[REDACTED]' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, sub: '[REDACTED]' },
  { re: /xapp-[A-Za-z0-9-]{10,}/g, sub: '[REDACTED]' },
  { re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, sub: '[REDACTED]' },
  { re: /re_[A-Za-z0-9_]{16,}/g, sub: '[REDACTED]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, sub: '[REDACTED]' },
]

export function redact(text) {
  let out = String(text == null ? '' : text)
  for (const { re, sub } of REDACTION_PATTERNS) out = out.replace(re, sub)
  return out
}

// コードポイント単位で先頭 n 文字を取り出す。n が有限の非負数でなければ切り詰めない。
export function takeChars(text, n) {
  const s = String(text == null ? '' : text)
  if (!Number.isFinite(n) || n < 0) return s
  return [...s].slice(0, n).join('')
}

export function redactContext(text, { take } = {}) {
  const redacted = redact(text)
  return take === undefined || take === null ? redacted : takeChars(redacted, take)
}

function parseArgs(argv) {
  let take
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--take') {
      take = Number(argv[++i])
      if (!Number.isFinite(take) || take < 0) {
        console.error('redact-context: --take requires a non-negative number')
        process.exit(2)
      }
    }
  }
  return { take }
}

function main() {
  const { take } = parseArgs(process.argv.slice(2))
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    input = ''
  }
  process.stdout.write(redactContext(input, { take }))
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMainModule()) {
  main()
}
