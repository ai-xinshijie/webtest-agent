import { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const doctorCommand = new Command('doctor')
  .description('Check environment health')
  .option('--verbose', 'show detailed checks')
  .action((options: { verbose?: boolean }) => {
    const cwd = process.cwd();
    const results: Array<{ name: string; pass: boolean; detail: string }> = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    results.push({
      name: 'Node.js',
      pass: majorVersion >= 20,
      detail: `${nodeVersion} ${majorVersion >= 20 ? '(OK)' : '(requires >= 20)'}`,
    });

    // Check project initialized
    const wtaDir = path.join(cwd, '.wta');
    results.push({
      name: 'Project',
      pass: existsSync(wtaDir),
      detail: existsSync(wtaDir) ? 'initialized' : 'not initialized (run wta init)',
    });

    // Check browser availability
    const browsersDir = path.join(cwd, 'vendor', 'browsers');
    const hasChromium = existsSync(path.join(browsersDir, 'chromium'));
    results.push({
      name: 'Browser (chromium)',
      pass: hasChromium,
      detail: hasChromium ? 'found in vendor/browsers' : 'not found (run wta install browsers)',
    });

    // Check Playwright browsers (fallback)
    try {
      const pwPath = execSync('npx playwright --version', { encoding: 'utf-8', timeout: 10000 }).trim();
      results.push({ name: 'Playwright', pass: true, detail: pwPath });
    } catch {
      results.push({ name: 'Playwright', pass: false, detail: 'not available' });
    }

    // Check API keys
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    results.push({
      name: 'OpenAI API',
      pass: hasOpenAI,
      detail: hasOpenAI ? 'configured' : 'OPENAI_API_KEY not set',
    });
    results.push({
      name: 'Anthropic API',
      pass: hasAnthropic,
      detail: hasAnthropic ? 'configured' : 'ANTHROPIC_API_KEY not set',
    });

    // Check display (for headed mode)
    const isLinux = process.platform === 'linux';
    const hasDisplay = !isLinux || !!process.env.DISPLAY;
    results.push({
      name: 'Display',
      pass: true,
      detail: isLinux ? (hasDisplay ? `DISPLAY=${process.env.DISPLAY}` : 'headless only (no DISPLAY)') : 'desktop',
    });

    // Print results
    console.log('\nWebTestAgent Environment Check\n');
    for (const result of results) {
      const icon = result.pass ? '[OK]' : '[!!]';
      console.log(`  ${icon} ${result.name}: ${result.detail}`);
    }

    const failures = results.filter(r => !r.pass);
    if (failures.length > 0) {
      console.log(`\n  ${failures.length} issue(s) found`);
      process.exit(1);
    } else {
      console.log('\n  All checks passed\n');
    }
  });
