export function shouldShowInitialAiSetup(input: {
  completed?: unknown;
  hasAgent?: unknown;
  hasSessionConfig?: unknown;
  hasAccountConfig?: boolean;
}): boolean {
  return Number(input.completed || 0) !== 1 &&
    Number(input.hasAgent || 0) === 0 &&
    Number(input.hasSessionConfig || 0) === 0 &&
    input.hasAccountConfig !== true;
}
