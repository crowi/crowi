#!/usr/bin/env node

/**
 * PreToolUse Hook for Bash
 * 危険なコマンドをブロック
 */

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[\/~]/,
  /sudo\s+/,
  /chmod\s+777/,
  />\s*\/etc\//,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
];

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const command = hookInput.tool_input?.command || '';
    
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        // Exit code 2 = block
        console.error(JSON.stringify({
          decision: 'block',
          reason: `Dangerous command blocked: ${command}`
        }));
        process.exit(2);
      }
    }
    
    // Allow
    process.exit(0);
  } catch (error) {
    // エラー時は許可
    process.exit(0);
  }
});
