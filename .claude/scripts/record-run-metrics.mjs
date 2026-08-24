#!/usr/bin/env node
// record-run-metrics.mjs — 1 回の workflow/pipeline run の効果測定メトリクスを
// `.reviews/codex-runs/<slug>/metrics.jsonl` に 1 行 (JSON) 追記する。
//
// pipeline のチューニング判断 (レビュー attempt 数の妥当性・codex fallback の頻度・
// simplify の効きなど) を感覚ではなく実測で行うための土台。追記専用の JSON Lines で
// 1 run = 1 行。書き込みが壊れても既存行は失わない。`.reviews/` は gitignore 済みの
// local state なので commit には乗らない。
//
// Workflow ランタイム (pipeline スクリプト本体) は resume 安全性のため Date.now() /
// new Date() を throw する。そのため pipeline は mechanical agent 経由でこのスクリプトを
// Bash 実行し、timestamp はこの子プロセス側の Date から採る (pipeline 自身は時刻を
// 触らない)。
//
// Usage:
//   echo '<metrics json>' | node .claude/scripts/record-run-metrics.mjs --dir <runDir> [--file metrics.jsonl]
//   node .claude/scripts/record-run-metrics.mjs --dir <runDir> --data '<metrics json>'
//
// runDir は呼び出し側が解決するディレクトリ (例 .reviews/codex-runs/<slug>)。
// 無ければ作る (bash のリダイレクトと違い、親ディレクトリの不在で落ちない)。

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 1

// input (任意のメトリクスオブジェクト) に schemaVersion / recordedAt を付与して
// 1 レコードにする。形は run 種別ごとに違ってよい。object であることだけ要求する。
export function buildRecord(input, { now = () => new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('record-run-metrics: metrics must be a JSON object')
  }
  return {
    schemaVersion: typeof input.schemaVersion === 'number' ? input.schemaVersion : SCHEMA_VERSION,
    recordedAt: now().toISOString(),
    ...input,
  }
}

// dir を作り、file に record を 1 行 JSON として追記する。書いたパスを返す。
export function appendRecord(dir, file, record) {
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, file)
  appendFileSync(target, `${JSON.stringify(record)}\n`)
  return target
}

function parseArgs(argv) {
  const out = { dir: null, file: 'metrics.jsonl', data: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--file') out.file = argv[++i]
    else if (a === '--data') out.data = argv[++i]
  }
  return out
}

function main() {
  const { dir, file, data } = parseArgs(process.argv.slice(2))
  if (!dir) {
    console.error('record-run-metrics: --dir <runDir> is required')
    process.exit(2)
  }
  let raw = data
  if (raw == null) {
    try {
      raw = readFileSync(0, 'utf8')
    } catch {
      raw = ''
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`record-run-metrics: metrics is not valid JSON: ${e.message}`)
    process.exit(1)
  }
  let record
  try {
    record = buildRecord(parsed)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  const target = appendRecord(dir, file, record)
  process.stdout.write(`${JSON.stringify({ wrote: true, path: target })}\n`)
  process.exit(0)
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
