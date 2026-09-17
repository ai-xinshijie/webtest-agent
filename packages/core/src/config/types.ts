export interface AgentConfig {
  /** Database file path */
  dbPath: string;
  /** Browser executable directory (vendor/browsers) */
  browserDir: string;
  /** Default browser */
  defaultBrowser: 'chromium' | 'firefox' | 'webkit';
  /** Headless mode: auto detects based on OS */
  headless: boolean | 'auto';
  /** Default viewport */
  viewport: { width: number; height: number };
  /** Timeout settings */
  timeout: {
    navigation: number;
    action: number;
    screenshot: number;
  };
  /** Parallel browser count */
  parallel: number;
  /** LLM model routing */
  models: ModelRouting;
  /** Logging */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ModelRouting {
  [taskType: string]: {
    provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
    model: string;
    baseUrl?: string;
    apiKey?: string;
    temperature: number;
    maxTokens: number;
  };
}

export interface TargetConfig {
  name: string;
  url: string;
  credentials: {
    username: string;
    password: string;
    usernameHint?: string;
    passwordHint?: string;
  };
  strategy: {
    runMode: 'continue' | 'fresh' | 'retest' | 'expand' | 'regression';
    depth: 'quick' | 'standard' | 'deep';
    maxDuration: number; // seconds
    maxPages: number;
    parallel: number;
    screenshot: 'always' | 'on-error' | 'never';
    video: boolean;
    headless: boolean | 'auto';
  };
  scope: {
    includePaths: string[];
    excludePaths: string[];
  };
  models?: Partial<ModelRouting>;
}

export function createDefaultConfig(rootDir: string): AgentConfig {
  return {
    dbPath: `${rootDir}/.wta/wta.db`,
    browserDir: `${rootDir}/vendor/browsers`,
    defaultBrowser: 'chromium',
    headless: 'auto',
    viewport: { width: 1920, height: 1080 },
    timeout: {
      navigation: 30000,
      action: 10000,
      screenshot: 5000,
    },
    parallel: 1,
    models: {
      'component-identify': {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        temperature: 0,
        maxTokens: 2000,
      },
      'exploration-decide': {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0,
        maxTokens: 1000,
      },
      'quality-reasoning': {
        provider: 'openai',
        model: 'o1',
        temperature: 1,
        maxTokens: 4000,
      },
      'visual-analysis': {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0,
        maxTokens: 2000,
      },
      'pattern-inference': {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        temperature: 0.2,
        maxTokens: 2000,
      },
      'memory-compression': {
        provider: 'anthropic',
        model: 'claude-haiku-3-5',
        temperature: 0,
        maxTokens: 1000,
      },
    },
    logLevel: 'info',
  };
}
