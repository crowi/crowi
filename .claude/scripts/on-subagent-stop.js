#!/usr/bin/env node

/**
 * SubagentStop Hook
 * サブエージェント完了時に次のアクションを提案
 */

const fs = require('fs');
const path = require('path');

// stdin から hook input を読み取り
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const result = processSubagentStop(hookInput);
    
    // 結果を stdout に出力
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Hook error: ${error.message}`);
    process.exit(0); // エラーでもブロックしない
  }
});

function processSubagentStop(hookInput) {
  const queuePath = path.join(__dirname, '../migration-state/queue.json');
  
  if (!fs.existsSync(queuePath)) {
    return { message: 'No migration queue found' };
  }
  
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const currentTask = queue.currentTask;
  
  if (!currentTask) {
    return { message: 'No active task' };
  }
  
  const taskPath = path.join(__dirname, `../migration-state/tasks/${currentTask}.json`);
  
  if (!fs.existsSync(taskPath)) {
    return { message: `Task file not found: ${currentTask}` };
  }
  
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  
  // ステータスに応じた次のアクションを提案
  const nextActions = {
    'PLANNED': {
      message: `タスク "${task.name}" の計画が完了しました`,
      nextAction: `Use the migration-implementer subagent to implement: ${task.id}`
    },
    'IN_PROGRESS': {
      message: `タスク "${task.name}" の実装中です`,
      nextAction: 'Continue implementation or mark as REVIEW when ready'
    },
    'REVIEW': {
      message: `タスク "${task.name}" がレビュー待ちです`,
      nextAction: `Use the migration-reviewer subagent to review: ${task.id}`
    },
    'NEEDS_WORK': {
      message: `タスク "${task.name}" に修正が必要です (${task.reviewAttempts}/3回目)`,
      nextAction: `Use the migration-implementer subagent to fix: ${task.id}`,
      feedback: task.reviewFeedback
    },
    'APPROVED': {
      message: `タスク "${task.name}" がレビュー承認されました`,
      nextAction: `Use the migration-committer subagent to commit: ${task.id}`
    },
    'COMMITTED': {
      message: `タスク "${task.name}" がコミットされました`,
      nextAction: 'PR をレビュー・マージしてください',
      prUrl: task.commitInfo?.prUrl
    },
    'DONE': {
      message: `タスク "${task.name}" が完了しました`,
      nextAction: '次の移行タスクに進んでください'
    }
  };
  
  return nextActions[task.status] || { 
    message: `Unknown status: ${task.status}` 
  };
}
