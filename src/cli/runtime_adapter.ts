import chalk from 'chalk';
import { confirm, editor, input, select } from '@inquirer/prompts';
import { spinner as ora } from '../util/spinner.js';
import type { RuntimeIO, RuntimeInteraction, RuntimeLogLevel, RuntimeProgress } from '../runtime.js';

function renderLog(level: RuntimeLogLevel, message: string): void {
  switch (level) {
    case 'success':
      console.log(chalk.green('✔'), message);
      return;
    case 'warning':
      console.log(chalk.yellow('!'), message);
      return;
    case 'error':
      console.error(chalk.red('✖'), message);
      return;
    case 'dim':
      console.log(chalk.gray(message));
      return;
    case 'accent':
      console.log(chalk.cyan(message));
      return;
    case 'raw':
    case 'info':
      console.log(message);
      return;
  }
}

/**
 * The IO an execution stage runs under: identical to the interactive adapter except that it never
 * stops to ask.
 *
 * Every clarification and approval belongs to `build`, which owns the human gates and the plan the
 * user confirmed. Asking again at execution time stalls an unattended run on a question that was
 * already answered, and there is no new information at that point to answer it with.
 *
 * The request is still recorded: the permission service writes an InteractionRequest and a
 * DecisionRecord either way, so the audit shows what was authorized and on what basis.
 */
export function createNonInteractiveCliRuntimeIO(): RuntimeIO {
  const io = createCliRuntimeIO();
  return {
    ...io,
    requestPermission: async (request) => ({
      approved: true,
      reason:
        `Authorized by the build-stage gate: ${request.operationType} carries no separate ` +
        'execution-time prompt.',
    }),
  };
}

export function createCliRuntimeIO(): RuntimeIO {
  return {
    terminalOutput: true,
    emit(event) {
      if (event.type === 'log') renderLog(event.level, event.message);
    },
    progress(message, opts): RuntimeProgress {
      const spin = ora(message, { animate: opts?.animate ?? true }).start();
      return {
        succeed: (msg) => { spin.succeed(msg); },
        fail: (msg) => { spin.fail(msg); },
        stop: () => { spin.stop(); },
      };
    },
    interaction: createCliInteraction(),
    requestPermission: async (request) => {
      const approved = await confirm({
        message: [
          `${request.operationType}: ${request.target}`,
          request.reason,
          `Risk: ${request.risk}`,
          `Scope: ${request.scope}`,
        ].join('\n'),
        default: false,
      });
      return {
        approved,
        reason: approved ? 'Approved by CLI user.' : request.denyBehavior,
      };
    },
  };
}

function createCliInteraction(): RuntimeInteraction {
  return {
    input,
    confirm,
    editor,
    select,
    readMultiline: async ({ message }) => {
      console.log(chalk.gray(message));
      return readMultilineFromStdin();
    },
    pauseStdin: () => {
      try {
        if ((process.stdin as { isTTY?: boolean }).isTTY) process.stdin.pause();
      } catch {
        /* ignore */
      }
    },
  };
}

async function readMultilineFromStdin(): Promise<string> {
  // 避开 node:readline —— 在 pkg 打包下 TTY 场景下 readline 的 native cleanup
  // 会在 rl.close() 后下一个 tick 触发 SIGSEGV。改为手工读取 stdin chunk。
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim() === '') {
          process.stdin.removeListener('data', onData);
          process.stdin.removeListener('end', onEnd);
          try { process.stdin.pause(); } catch { /* stdin already closed */ }
          resolve(lines.join('\n'));
          return;
        }
        lines.push(line);
      }
    };
    const onEnd = () => {
      if (buf.trim()) lines.push(buf.replace(/\r$/, ''));
      process.stdin.removeListener('data', onData);
      try { process.stdin.pause(); } catch { /* stdin already closed */ }
      resolve(lines.join('\n'));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    try { process.stdin.resume(); } catch { /* stdin is not resumable */ }
  });
}
