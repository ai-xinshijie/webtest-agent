import { Command } from 'commander';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const initCommand = new Command('init')
  .description('Initialize WebTestAgent project')
  .argument('[path]', 'project directory', '.')
  .action((targetPath: string) => {
    const root = path.resolve(targetPath);
    const wtaDir = path.join(root, '.wta');

    if (existsSync(wtaDir)) {
      console.log('Project already initialized at', wtaDir);
      return;
    }

    // Create directory structure
    mkdirSync(wtaDir, { recursive: true });
    mkdirSync(path.join(wtaDir, 'targets'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'plugins'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'sessions'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'reports'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'videos'), { recursive: true });

    // Create default config
    const config = {
      browser: {
        default: 'chromium',
        headless: 'auto',
        viewport: { width: 1920, height: 1080 },
        parallel: 1,
      },
      timeout: {
        navigation: 30000,
        action: 10000,
        screenshot: 5000,
      },
      logLevel: 'info',
    };

    writeFileSync(
      path.join(wtaDir, 'config.json'),
      JSON.stringify(config, null, 2),
    );

    console.log('Initialized WebTestAgent project at', root);
    console.log('  .wta/config.json       - Agent configuration');
    console.log('  .wta/targets/          - Test target configs');
    console.log('  .wta/plugins/          - Plugin directory');
    console.log('  .wta/sessions/         - Session data');
    console.log('  .wta/reports/          - Test reports');
    console.log('');
    console.log('Next steps:');
    console.log('  wta target add         - Add a test target');
    console.log('  wta run <target>       - Run tests');
    console.log('  wta doctor            - Check environment');
  });
