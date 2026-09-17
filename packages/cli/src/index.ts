import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { doctorCommand } from './commands/doctor.js';
import { targetCommand } from './commands/target.js';
import { reportCommand } from './commands/report.js';
import { installCommand } from './commands/install.js';

const program = new Command();

program
  .name('wta')
  .description('Autonomous Web UI testing agent')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(doctorCommand);
program.addCommand(targetCommand);
program.addCommand(reportCommand);
program.addCommand(installCommand);

program.parse();
