import type { Page, Route } from 'playwright';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';

export type NetworkFaultType = 'abort' | 'http-500' | 'http-503' | 'slow' | 'timeout' | 'offline';

export interface NetworkFault {
  type: NetworkFaultType;
  urlPattern: string | RegExp;
  delayMs?: number;
  responseBody?: string;
}

interface ActiveRoute {
  fault: NetworkFault;
  handler: (route: Route) => Promise<void>;
}

/**
 * 通过 Playwright 路由拦截注入网络异常，用于验证前端容错能力。
 */
export class NetworkFaultInjector {
  private routes: ActiveRoute[] = [];

  constructor(private logger?: AgentLogger) {}

  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  async apply(page: Page, fault: NetworkFault, context: AgentLogContext = { phase: 'chaos' }): Promise<void> {
    const handler = async (route: Route) => {
      const resourceType = route.request().resourceType();
      if (!['xhr', 'fetch'].includes(resourceType)) {
        await route.continue();
        return;
      }
      if (fault.type === 'abort' || fault.type === 'offline') {
        await route.abort(fault.type === 'offline' ? 'internetDisconnected' : 'failed');
        return;
      }

      if (fault.type === 'http-500' || fault.type === 'http-503') {
        await route.fulfill({
          status: fault.type === 'http-500' ? 500 : 503,
          contentType: 'application/json',
          body: fault.responseBody ?? JSON.stringify({ message: '注入的网络故障' }),
        });
        return;
      }

      if (fault.type === 'slow' || fault.type === 'timeout') {
        const delay = fault.delayMs ?? (fault.type === 'timeout' ? 30000 : 3000);
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, 30000)));
        await route.continue();
        return;
      }

      await route.continue();
    };

    const execute = () => page.route(fault.urlPattern, handler);
    if (this.logger) {
      await this.logger.runScript(
        { description: `注入网络故障：${fault.type}`, module: 'NetworkFaultInjector', method: 'apply' },
        { type: 'network-fault', target: String(fault.urlPattern), params: { fault: fault.type, delayMs: fault.delayMs } },
        execute,
        context,
      );
    } else {
      await execute();
    }

    this.routes.push({ fault, handler });
  }

  async restore(page: Page, fault?: NetworkFault, context: AgentLogContext = { phase: 'chaos' }): Promise<void> {
    const active = fault ? this.routes.filter(item => item.fault === fault) : this.routes;
    for (const item of active) {
      const execute = () => page.unroute(item.fault.urlPattern, item.handler);
      if (this.logger) {
        await this.logger.runScript(
          { description: `恢复网络故障：${item.fault.type}`, module: 'NetworkFaultInjector', method: 'restore' },
          { type: 'network-fault-restore', target: String(item.fault.urlPattern) },
          execute,
          context,
        );
      } else {
        await execute();
      }
    }

    this.routes = this.routes.filter(item => !active.includes(item));
  }

  async restoreAll(page: Page, context: AgentLogContext = { phase: 'chaos' }): Promise<void> {
    await this.restore(page, undefined, context);
  }

  getActiveFaults(): NetworkFault[] {
    return this.routes.map(item => item.fault);
  }
}
