import chalk from 'chalk';
import type { ExecutorRunMetrics } from '../../agents/executor.js';
import { calibrateDebugSuggestions } from '../../agents/calibration.js';
import { t } from '../../i18n/index.js';
import type { Step } from '../plan.js';

export function presentStepFailure(
  log: (...args: unknown[]) => void,
  step: Step,
  info: {
    attempts: number;
    budget: number;
    cap: number;
    earlyAbort: boolean;
    reason: string;
    failureLog: string;
    metrics?: ExecutorRunMetrics;
  },
): void {
  const bar = chalk.red('─'.repeat(60));
  log(bar);
  log(chalk.red.bold(t().engine.stepFinalFailed(step.id, step.phase, step.role)));
  log(
    chalk.gray(
      t().engine.finalAttemptsLine(
        info.attempts,
        info.budget,
        info.cap,
        info.earlyAbort,
      ),
    ),
  );
  if (info.metrics) {
    const metrics = info.metrics;
    log(
      chalk.gray(
        t().engine.finalMetricsLine(
          metrics.healthScore.toFixed(2),
          metrics.parseFailures,
          metrics.repeatedTurns,
          metrics.toolFailRatio.toFixed(2),
          metrics.progressRatio.toFixed(2),
        ),
      ),
    );
  }
  log(chalk.red(t().engine.reasonLabel) + info.reason);
  const tail = info.failureLog
    ? info.failureLog.split('\n').slice(-80).join('\n')
    : t().engine.noFailureLog;
  log(chalk.gray(t().engine.failureLogHeader));
  log(tail);
  const suggestions = calibrateDebugSuggestions(info.failureLog, info.reason);
  if (suggestions.length > 0) {
    log(chalk.yellow(t().engine.fixSuggestionsHeader));
    suggestions.forEach((suggestion, index) => {
      log(
        chalk.yellow(
          t().engine.suggestionLine(
            index + 1,
            suggestion.code,
            suggestion.hint,
          ),
        ),
      );
    });
  }
  log(chalk.gray(t().engine.auditHint(step.id)));
  log(bar);
}
