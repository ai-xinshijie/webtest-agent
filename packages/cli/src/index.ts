import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { doctorCommand } from './commands/doctor.js';
import { targetCommand } from './commands/target.js';
import { reportCommand } from './commands/report.js';
import { installCommand } from './commands/install.js';
import { daemonCommand, guiCommand } from './commands/daemon.js';
import { attachCommand } from './commands/attach.js';
import { memoryCommand } from './commands/memory.js';
import { pluginCommand } from './commands/plugin.js';
import { configCommand } from './commands/config.js';
import { modelCommand } from './commands/model.js';
import { mcpCommand } from './commands/mcp.js';
import { statusCommand, stopCommand } from './commands/session.js';
import { authCommand } from './commands/auth.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('wta')
    .description('自主 Web 界面深度测试代理')
    .version('0.1.0');

  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(doctorCommand);
  program.addCommand(targetCommand);
  program.addCommand(reportCommand);
  program.addCommand(installCommand);
  program.addCommand(daemonCommand);
  program.addCommand(guiCommand);
  program.addCommand(attachCommand);
  program.addCommand(memoryCommand);
  program.addCommand(pluginCommand);
  program.addCommand(configCommand);
  program.addCommand(modelCommand);
  program.addCommand(mcpCommand);
  program.addCommand(statusCommand);
  program.addCommand(stopCommand);
  program.addCommand(authCommand);

  return program;
}

export const program = createProgram();
