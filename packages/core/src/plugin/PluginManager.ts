import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export interface PluginTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface WtaPluginContext {
  pluginDir: string;
  dataDir: string;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface WtaPlugin {
  name: string;
  version: string;
  tools: PluginTool[];
  onInit?(context: WtaPluginContext): Promise<void> | void;
  onDispose?(): Promise<void> | void;
  executeTool(toolName: string, params: Record<string, unknown>): Promise<unknown>;
}

interface PluginManifest {
  name: string;
  version: string;
  entry: string;
  enabled: boolean;
  description?: string;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: WtaPlugin;
}

/**
 * 本地插件管理器。只加载受信任目录中的插件，不执行远端代码。
 */
export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();
  private currentContext?: WtaPluginContext;

  constructor(
    private pluginDir: string,
    private dataDir = join(pluginDir, '.data'),
  ) {}

  async loadAll(): Promise<WtaPlugin[]> {
    mkdirSync(this.pluginDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    this.currentContext = {
      pluginDir: this.pluginDir,
      dataDir: this.dataDir,
      log: (message, level = 'info') => {
        if (level === 'error') console.error(`插件：${message}`);
        else if (level === 'warn') console.warn(`插件：${message}`);
        else console.log(`插件：${message}`);
      },
    };

    const plugins: WtaPlugin[] = [];
    for (const entry of readdirSync(this.pluginDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const plugin = await this.load(join(this.pluginDir, entry.name));
      if (plugin) plugins.push(plugin);
    }
    return plugins;
  }

  async load(pluginPath: string): Promise<WtaPlugin | null> {
    const manifestPath = join(pluginPath, 'plugin.json');
    if (!existsSync(manifestPath)) return null;

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    } catch (error) {
      throw new Error(`插件清单解析失败：${pluginPath}，${error instanceof Error ? error.message : error}`);
    }

    this.validateManifest(manifest);
    if (!manifest.enabled) return null;

    const entryPath = resolve(pluginPath, manifest.entry);
    if (!entryPath.startsWith(resolve(pluginPath))) {
      throw new Error(`插件入口越界：${manifest.name}`);
    }

    const imported = await import(pathToFileURL(entryPath).href);
    const plugin = (imported.default ?? imported.plugin ?? imported) as WtaPlugin;
    if (plugin.name !== manifest.name) {
      throw new Error(`插件名称与清单不一致：${manifest.name}`);
    }

    await plugin.onInit?.(this.currentContext ?? {
      pluginDir: pluginPath,
      dataDir: this.dataDir,
      log: message => console.log(`插件：${message}`),
    });
    this.loaded.set(manifest.name, { manifest, plugin });
    return plugin;
  }

  list(): Array<PluginManifest & { loaded: boolean; toolCount: number }> {
    mkdirSync(this.pluginDir, { recursive: true });
    const result: Array<PluginManifest & { loaded: boolean; toolCount: number }> = [];

    for (const entry of readdirSync(this.pluginDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifestPath = join(this.pluginDir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      const loaded = this.loaded.get(manifest.name);
      result.push({
        ...manifest,
        loaded: Boolean(loaded),
        toolCount: loaded?.plugin.tools.length ?? 0,
      });
    }

    return result;
  }

  getTools(): PluginTool[] {
    return [...this.loaded.values()].flatMap(item => item.plugin.tools);
  }

  async executeTool(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    for (const { plugin } of this.loaded.values()) {
      if (!plugin.tools.some(tool => tool.name === name)) continue;
      return plugin.executeTool(name, params);
    }
    throw new Error(`未找到插件工具：${name}`);
  }

  setEnabled(name: string, enabled: boolean): void {
    const pluginPath = this.findPluginPath(name);
    const manifestPath = join(pluginPath, 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    manifest.enabled = enabled;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  install(source: string): string {
    if (/^https?:\/\/.+\.git$/.test(source) || /^git@.+\.git$/.test(source)) {
      return this.installFromGit(source);
    }

    const sourcePath = resolve(source);
    if (!existsSync(sourcePath)) throw new Error(`插件来源不存在：${source}`);
    const destination = join(this.pluginDir, basename(sourcePath));
    if (existsSync(destination)) throw new Error(`插件目录已存在：${destination}`);
    mkdirSync(this.pluginDir, { recursive: true });
    cpSync(sourcePath, destination, { recursive: true });
    return destination;
  }

  create(name: string, description = ''): string {
    const pluginPath = join(this.pluginDir, name);
    if (existsSync(pluginPath)) throw new Error(`插件目录已存在：${pluginPath}`);
    mkdirSync(pluginPath, { recursive: true });
    mkdirSync(join(pluginPath, 'src'), { recursive: true });

    writeFileSync(join(pluginPath, 'plugin.json'), JSON.stringify({
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      enabled: true,
      description,
    }, null, 2), 'utf-8');

    writeFileSync(join(pluginPath, 'package.json'), JSON.stringify({
      name,
      version: '0.1.0',
      type: 'module',
      private: true,
      dependencies: { '@wta/core': 'workspace:*' },
      scripts: { build: 'tsc -p tsconfig.json' },
    }, null, 2), 'utf-8');

    writeFileSync(join(pluginPath, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
      },
      include: ['src/**/*.ts'],
    }, null, 2), 'utf-8');

    writeFileSync(join(pluginPath, 'src', 'index.ts'), `import type { WtaPlugin } from '@wta/core';

const plugin: WtaPlugin = {
  name: '${name}',
  version: '0.1.0',
  tools: [{
    name: '${name}.example',
    description: '示例工具',
  }],
  async executeTool(toolName, params) {
    if (toolName !== '${name}.example') throw new Error('未知的插件工具：' + toolName);
    return { received: params };
  },
};

export default plugin;
`, 'utf-8');

    return pluginPath;
  }

  async disposeAll(): Promise<void> {
    for (const { plugin } of this.loaded.values()) await plugin.onDispose?.();
    this.loaded.clear();
  }

  private installFromGit(source: string): string {
    const name = basename(source.replace(/\.git$/, ''));
    const destination = join(this.pluginDir, name);
    if (existsSync(destination)) throw new Error(`插件目录已存在：${destination}`);
    mkdirSync(this.pluginDir, { recursive: true });

    const result = spawnSyncChecked('git', ['clone', '--depth', '1', source, destination]);
    if (!result) throw new Error(`Git 插件安装失败：${source}`);
    return destination;
  }

  private findPluginPath(name: string): string {
    const pluginPath = join(this.pluginDir, name);
    if (!existsSync(join(pluginPath, 'plugin.json'))) {
      throw new Error(`未找到插件：${name}`);
    }
    return pluginPath;
  }

  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name || !manifest.version || !manifest.entry) {
      throw new Error('插件清单必须包含 name、version 和 entry');
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.name)) {
      throw new Error(`插件名称不合法：${manifest.name}`);
    }
  }
}

function spawnSyncChecked(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' });
  return result.status === 0;
}
