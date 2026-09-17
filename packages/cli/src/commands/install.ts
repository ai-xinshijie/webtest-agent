import { Command } from 'commander';
import { execSync } from 'node:child_process';

export const installCommand = new Command('install')
  .description('Install or update browser binaries and system dependencies');

installCommand
  .command('browsers')
  .description('Download/update browser binaries to vendor/browsers')
  .option('--all', 'install all browsers (chromium, firefox, webkit)')
  .option('--browser <browser>', 'specific browser to install')
  .action(async (options: { all?: boolean; browser?: string }) => {
    console.log('Installing Playwright browsers...');

    const browsers = options.all
      ? ['chromium', 'firefox', 'webkit']
      : [options.browser ?? 'chromium'];

    for (const browser of browsers) {
      console.log(`  Installing ${browser}...`);
      try {
        execSync(
          `npx playwright install ${browser}`,
          { stdio: 'inherit', cwd: process.cwd() },
        );
        console.log(`  ${browser} installed`);
      } catch (error) {
        console.error(`  Failed to install ${browser}:`, error);
      }
    }

    console.log('\nNote: Browsers are installed to Playwright default location.');
    console.log('For bundled installation, copy browser files to vendor/browsers/');
  });

installCommand
  .command('deps')
  .description('Install system dependencies for headless mode (Linux)')
  .action(() => {
    if (process.platform !== 'linux') {
      console.log('System dependencies are only needed on Linux.');
      return;
    }

    console.log('Installing system dependencies...');
    try {
      execSync('npx playwright install-deps', { stdio: 'inherit', cwd: process.cwd() });
      console.log('System dependencies installed.');
    } catch (error) {
      console.error('Failed to install dependencies. Try:');
      console.error('  sudo apt-get install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \\\n    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \\\n    libxfixes3 libxrandr2 libgbm1 libasound2 fonts-noto-cjk');
    }
  });
