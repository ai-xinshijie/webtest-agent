import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Brain,
  FileText,
  Gauge,
  Play,
  Plug,
  RefreshCw,
  Settings,
  Square,
  PanelsTopLeft,
} from 'lucide-react';

type View = 'dashboard' | 'monitor' | 'reports' | 'memory' | 'plugins' | 'settings';

interface TargetConfig {
  name: string;
  url: string;
  strategy: {
    runMode: 'continue' | 'fresh' | 'retest' | 'expand' | 'regression';
    depth: 'quick' | 'standard' | 'deep';
    parallel: number;
  };
}

interface SessionSummary {
  id: string;
  targetName: string;
  status: string;
  phase: string;
  startedAt: number;
  endedAt?: number;
  progress?: {
    executedActions: number;
    skippedActions: number;
    executedCombinations: number;
    executedPaths: number;
    chaosTests: number;
    coverage: {
      actions: { visited: number; blocked: number; pending: number; percentage: number };
      combinations: { covered: number; total: number; percentage: number };
      paths: { covered: number; total: number; percentage: number };
    };
  } | null;
}

interface TimelineLog {
  id: string;
  sequence: number;
  timestamp: number;
  source: 'script' | 'model' | 'system' | 'user';
  trigger?: { description?: string; module?: string; method?: string };
  action?: { type?: string; target?: string; params?: unknown };
  model?: { provider?: string; model?: string; request?: unknown; response?: unknown };
  result?: {
    status?: 'success' | 'failed' | 'skipped' | 'warning';
    duration?: number;
    output?: unknown;
    error?: string;
  };
  context?: { pageUrl?: string; phase?: string };
}

interface ReportFile {
  name: string;
  path: string;
  format: 'md' | 'json';
}

interface MemoryData {
  overview: {
    targetCount: number;
    testedItemCount: number;
    ruleCount: number;
    patternCount: number;
    summaryCount: number;
  };
  targets: Array<{
    name: string;
    memory: {
      testedItems: Array<{ itemKey: string; status: string; testCount: number; lastTestedAt: number }>;
      rules: Array<{ statement: string; confidence: number }>;
      patterns: Array<{ pattern: string; reliability: number }>;
      summaries: Array<{ sessionId: string; createdAt: number }>;
    };
  }>;
}

interface PluginInfo {
  name: string;
  version: string;
  enabled: boolean;
  loaded: boolean;
  toolCount: number;
  description?: string;
}

const sourceText: Record<TimelineLog['source'], string> = {
  script: '脚本',
  model: '模型',
  system: '系统',
  user: '用户',
};

const statusText: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  stopped: '已停止',
};

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function screenshotUrl(log: TimelineLog): string | null {
  const output = log.result?.output;
  if (typeof output !== 'string' || !output.endsWith('.png')) return null;
  const parts = output.split(/[\\/]/);
  if (parts.length < 2) return null;
  return `/screenshots/${parts.slice(-2).join('/')}`;
}

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [targets, setTargets] = useState<TargetConfig[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [mode, setMode] = useState<TargetConfig['strategy']['runMode']>('continue');
  const [phase, setPhase] = useState<'all' | 'explore' | 'test' | 'combo' | 'chaos'>('all');
  const [parallel, setParallel] = useState(1);
  const [headless, setHeadless] = useState(true);
  const [selectedSession, setSelectedSession] = useState('');
  const [timeline, setTimeline] = useState<TimelineLog[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [reports, setReports] = useState<ReportFile[]>([]);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [configText, setConfigText] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [targetResult, sessionResult] = await Promise.all([
      fetch('/api/targets'),
      fetch('/api/sessions'),
    ]);
    const targetData = await targetResult.json() as TargetConfig[];
    const sessionData = await sessionResult.json() as SessionSummary[];
    setTargets(targetData);
    setSessions(sessionData);
    if (!selectedTarget && targetData[0]) setSelectedTarget(targetData[0].name);
    if (!selectedSession && sessionData[0]) setSelectedSession(sessionData[0].id);
  }, [selectedSession, selectedTarget]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onmessage = event => {
      const message = JSON.parse(event.data as string) as { sessions?: SessionSummary[] };
      if (message.sessions) setSessions(message.sessions);
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (view !== 'monitor' || !selectedSession) return;
    let active = true;
    const load = async () => {
      const response = await fetch(`/api/sessions/${selectedSession}/timeline`);
      if (!active) return;
      setTimeline(await response.json() as TimelineLog[]);
    };
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view, selectedSession]);

  useEffect(() => {
    if (view !== 'reports') return;
    void fetch('/api/reports')
      .then(response => response.json())
      .then((data: ReportFile[]) => setReports(data));
  }, [view]);

  useEffect(() => {
    if (view !== 'memory') return;
    void fetch('/api/memory')
      .then(response => response.json())
      .then((data: MemoryData) => setMemory(data));
  }, [view]);

  useEffect(() => {
    if (view !== 'plugins') return;
    void fetch('/api/plugins')
      .then(response => response.json())
      .then((data: PluginInfo[]) => setPlugins(data));
  }, [view]);

  useEffect(() => {
    if (view !== 'settings') return;
    void fetch('/api/config')
      .then(response => response.json())
      .then((data: unknown) => setConfigText(JSON.stringify(data, null, 2)));
  }, [view]);

  const selected = useMemo(
    () => sessions.find(item => item.id === selectedSession) ?? null,
    [sessions, selectedSession],
  );

  const startRun = async () => {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: selectedTarget,
          mode,
          phase: phase === 'all' ? undefined : phase,
          parallel,
          headless,
        }),
      });
      const data = await response.json() as { sessionId?: string };
      if (data.sessionId) setSelectedSession(data.sessionId);
      setView('monitor');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async () => {
    if (!selectedSession) return;
    setBusy(true);
    try {
      await fetch(`/api/sessions/${selectedSession}/stop`, { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const resumeSession = async () => {
    if (!selectedSession) return;
    setBusy(true);
    try {
      await fetch(`/api/sessions/${selectedSession}/resume`, { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    setBusy(true);
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: configText,
      });
    } finally {
      setBusy(false);
    }
  };

  const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
    { id: 'dashboard', label: '总览', icon: Gauge },
    { id: 'monitor', label: '监控', icon: Activity },
    { id: 'reports', label: '报告', icon: FileText },
    { id: 'memory', label: '记忆', icon: Brain },
    { id: 'plugins', label: '插件', icon: Plug },
    { id: 'settings', label: '设置', icon: Settings },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <PanelsTopLeft size={20} />
          <span>WebTestAgent</span>
        </div>
        <nav className="nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={view === item.id ? 'nav-button active' : 'nav-button'}
              onClick={() => setView(item.id)}
            >
              <item.icon size={16} />
              {item.label}
            </button>
          ))}
        </nav>
        <button className="icon-button" title="刷新" onClick={() => void refresh()}>
          <RefreshCw size={16} />
        </button>
      </header>

      <main>
        {view === 'dashboard' && (
          <div className="dashboard-grid">
            <section className="panel">
              <h2>启动测试</h2>
              <div className="form-grid">
                <label>
                  测试目标
                  <select value={selectedTarget} onChange={event => setSelectedTarget(event.target.value)}>
                    {targets.map(target => (
                      <option key={target.name} value={target.name}>{target.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  运行模式
                  <select value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
                    <option value="continue">continue</option>
                    <option value="fresh">fresh</option>
                    <option value="retest">retest</option>
                    <option value="expand">expand</option>
                    <option value="regression">regression</option>
                  </select>
                </label>
                <label>
                  阶段
                  <select value={phase} onChange={event => setPhase(event.target.value as typeof phase)}>
                    <option value="all">全部</option>
                    <option value="explore">探索</option>
                    <option value="test">功能</option>
                    <option value="combo">组合</option>
                    <option value="chaos">混沌</option>
                  </select>
                </label>
                <label>
                  并行数
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={parallel}
                    onChange={event => setParallel(Number(event.target.value))}
                  />
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={headless} onChange={event => setHeadless(event.target.checked)} />
                  无头模式
                </label>
                <button className="primary-button" disabled={busy || !selectedTarget} onClick={() => void startRun()}>
                  <Play size={16} />
                  启动
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>测试目标</h2>
              <table>
                <thead>
                  <tr><th>名称</th><th>地址</th><th>深度</th><th>并行</th></tr>
                </thead>
                <tbody>
                  {targets.map(target => (
                    <tr key={target.name}>
                      <td>{target.name}</td>
                      <td className="mono">{target.url}</td>
                      <td>{target.strategy.depth}</td>
                      <td>{target.strategy.parallel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel wide">
              <h2>最近会话</h2>
              <table>
                <thead>
                  <tr><th>会话</th><th>目标</th><th>状态</th><th>阶段</th><th>动作</th><th>组合</th></tr>
                </thead>
                <tbody>
                  {sessions.slice(0, 12).map(session => (
                    <tr key={session.id} onClick={() => {
                      setSelectedSession(session.id);
                      setView('monitor');
                    }}>
                      <td className="mono">{session.id.slice(0, 8)}</td>
                      <td>{session.targetName}</td>
                      <td><span className={`status ${session.status}`}>{statusText[session.status] ?? session.status}</span></td>
                      <td>{session.phase}</td>
                      <td>{session.progress?.executedActions ?? 0}</td>
                      <td>{session.progress?.executedCombinations ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {view === 'monitor' && (
          <div className="monitor-grid">
            <section className="panel">
              <div className="panel-heading">
                <h2>{selected ? `${selected.targetName} / ${selected.id.slice(0, 8)}` : '会话监控'}</h2>
                <div className="button-row">
                  <button className="icon-button" title="恢复" disabled={busy} onClick={() => void resumeSession()}>
                    <Play size={16} />
                  </button>
                  <button className="icon-button danger" title="停止" disabled={busy} onClick={() => void stopSession()}>
                    <Square size={16} />
                  </button>
                </div>
              </div>
              <div className="metric-grid">
                <div className="metric">
                  <span>动作覆盖</span>
                  <strong>{selected?.progress?.coverage.actions.percentage.toFixed(1) ?? '0.0'}%</strong>
                </div>
                <div className="metric">
                  <span>组合覆盖</span>
                  <strong>{selected?.progress?.coverage.combinations.percentage.toFixed(1) ?? '0.0'}%</strong>
                </div>
                <div className="metric">
                  <span>路径覆盖</span>
                  <strong>{selected?.progress?.coverage.paths.percentage.toFixed(1) ?? '0.0'}%</strong>
                </div>
                <div className="metric">
                  <span>混沌测试</span>
                  <strong>{selected?.progress?.chaosTests ?? 0}</strong>
                </div>
              </div>
            </section>

            <section className="panel timeline-panel">
              <h2>执行时间线</h2>
              <select value={selectedSession} onChange={event => setSelectedSession(event.target.value)}>
                {sessions.map(session => (
                  <option key={session.id} value={session.id}>
                    {session.id.slice(0, 8)} / {statusText[session.status] ?? session.status}
                  </option>
                ))}
              </select>
              <div className="timeline">
                {timeline.map(log => {
                  const image = screenshotUrl(log);
                  return (
                    <div key={log.id} className="timeline-item">
                      <button
                        className="timeline-row"
                        onClick={() => setExpanded(current => ({ ...current, [log.id]: !current[log.id] }))}
                      >
                        <span className="time">{formatTime(log.timestamp)}</span>
                        <span className={`source ${log.source}`}>{sourceText[log.source]}</span>
                        <span className="description">{log.trigger?.description ?? '未命名操作'}</span>
                        <span className={`result ${log.result?.status ?? 'success'}`}>
                          {log.result?.status === 'failed' ? '失败' : log.result?.status === 'warning' ? '警告' : '成功'}
                        </span>
                        <span className="duration">{log.result?.duration ?? 0}ms</span>
                      </button>
                      {expanded[log.id] && (
                        <div className="timeline-detail">
                          <pre>{JSON.stringify({
                            触发: log.trigger,
                            操作: log.action,
                            模型: log.model,
                            结果: log.result,
                            上下文: log.context,
                          }, null, 2)}</pre>
                          {image && <img src={image} alt="测试截图" />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {view === 'reports' && (
          <section className="panel">
            <h2>测试报告</h2>
            <table>
              <thead><tr><th>文件</th><th>格式</th><th>路径</th></tr></thead>
              <tbody>
                {reports.map(report => (
                  <tr key={report.path}>
                    <td>{report.name}</td>
                    <td>{report.format.toUpperCase()}</td>
                    <td className="mono">{report.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {view === 'memory' && memory && (
          <section className="panel">
            <h2>记忆概览</h2>
            <div className="metric-grid">
              <div className="metric"><span>测试目标</span><strong>{memory.overview.targetCount}</strong></div>
              <div className="metric"><span>已测项</span><strong>{memory.overview.testedItemCount}</strong></div>
              <div className="metric"><span>规则</span><strong>{memory.overview.ruleCount}</strong></div>
              <div className="metric"><span>模式</span><strong>{memory.overview.patternCount}</strong></div>
              <div className="metric"><span>摘要</span><strong>{memory.overview.summaryCount}</strong></div>
            </div>
            <div className="memory-list">
              {memory.targets.map(target => (
                <article key={target.name}>
                  <h3>{target.name}</h3>
                  <p>已测项 {target.memory.testedItems.length}，规则 {target.memory.rules.length}，模式 {target.memory.patterns.length}</p>
                  <ul>
                    {target.memory.testedItems.slice(0, 8).map(item => (
                      <li key={item.itemKey}>{item.itemKey} · {item.status} · {item.testCount} 次</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        )}

        {view === 'plugins' && (
          <section className="panel">
            <h2>插件</h2>
            <table>
              <thead><tr><th>名称</th><th>版本</th><th>状态</th><th>工具</th></tr></thead>
              <tbody>
                {plugins.map(plugin => (
                  <tr key={plugin.name}>
                    <td>{plugin.name}</td>
                    <td>{plugin.version}</td>
                    <td>{plugin.enabled ? '启用' : '停用'}</td>
                    <td>{plugin.toolCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {view === 'settings' && (
          <section className="panel">
            <h2>配置</h2>
            <textarea value={configText} onChange={event => setConfigText(event.target.value)} spellCheck={false} />
            <div className="button-row">
              <button className="primary-button" disabled={busy} onClick={() => void saveConfig()}>保存配置</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
