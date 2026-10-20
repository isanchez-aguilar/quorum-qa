/** Build a fresh machine-readable report command shared by both review lanes. */
export function machineTestCommand(command: readonly string[], reportPath: string, testFile?: string): string[] {
  const argv: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    if (arg === '--outputFile') { i++; continue; }
    if (arg.startsWith('--outputFile=')) continue;
    argv.push(arg);
  }
  const jest = argv.some(arg => /(?:^|[/\\])jest(?:\.[cm]?js)?$/.test(arg));
  const reporter = jest ? '--json' : '--reporter=json';
  if (!argv.includes(reporter)) argv.push(reporter);
  argv.push(`--outputFile=${reportPath}`);
  if (testFile !== undefined) argv.push(`./${testFile.replace(/\\/g, '/').replace(/^\.\//, '')}`);
  return argv;
}
