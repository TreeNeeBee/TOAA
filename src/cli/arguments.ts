import { Help, InvalidArgumentError, type Command } from 'commander';
import { PLAN_INTENTS, type PlanIntent } from '../core/plan.js';
import { normaliseLocale, t, type Locale } from '../i18n/index.js';

const LOCALE_ALIASES = new Set([
  'en', 'us', 'uk', 'gb', 'en-us', 'en-gb',
  'zh', 'cn', 'zh-cn', 'zh-hans', 'chinese',
]);

/** Apply localized Commander section headings and built-in option descriptions. */
export function configureLocalizedHelp(command: Command): Command {
  const defaultFormatHelp = Help.prototype.formatHelp;
  const defaultOptionDescription = Help.prototype.optionDescription;
  command.configureHelp({
    formatHelp(current, helper) {
      return defaultFormatHelp.call(helper, current, helper)
        .replace(/^Usage:/mu, t().cli.helpUsage)
        .replace(/^Arguments:/mu, t().cli.helpArguments)
        .replace(/^Options:/mu, t().cli.helpOptions)
        .replace(/^Commands:/mu, t().cli.helpCommands);
    },
    optionDescription(option) {
      return defaultOptionDescription.call(this, option)
        .replace(/\(default: ([^)]+)\)$/u, (_, value: string) => t().cli.defaultValue(value));
    },
  });
  return command.helpOption('-h, --help', t().cli.helpOption);
}

/** Read the global locale before Commander builds translated help text. */
export function localeFromArgv(argv: string[]): string | undefined {
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--lang') return argv[index + 1];
    if (arg.startsWith('--lang=')) return arg.slice('--lang='.length);
  }
  return undefined;
}

export function parseLocale(value: string): Locale {
  if (!LOCALE_ALIASES.has(value.trim().toLowerCase())) {
    throw new InvalidArgumentError(t().cli.invalidLocale(value));
  }
  return normaliseLocale(value);
}

export function parseIntent(value: string): PlanIntent {
  const normalized = value.trim().toLowerCase();
  if (!PLAN_INTENTS.includes(normalized as PlanIntent)) {
    throw new InvalidArgumentError(t().cli.invalidIntent(value, PLAN_INTENTS.join(', ')));
  }
  return normalized as PlanIntent;
}

export function parseStepId(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^(?:P\d{1,3}-)?S\d{3,}$/u.test(normalized)) {
    throw new InvalidArgumentError(t().cli.invalidStepId(value));
  }
  return normalized;
}

export function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new InvalidArgumentError(t().cli.invalidNonNegativeInteger(value));
  }
  return Number(value);
}
