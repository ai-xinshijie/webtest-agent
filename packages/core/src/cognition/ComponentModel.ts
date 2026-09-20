import type { ExtractedComponent } from '../perception/types.js';

export type ComponentType =
  | 'button' | 'input' | 'textarea' | 'select'
  | 'form' | 'table' | 'modal' | 'accordion'
  | 'tab' | 'toast' | 'checkbox' | 'radio'
  | 'navigation' | 'breadcrumb' | 'pagination'
  | 'link' | 'dropdown' | 'datepicker' | 'fileupload'
  | 'unknown';

/**
 * 组件在页面中的测试范围。业务组件计入主覆盖率，其余组件保留为探索证据。
 */
export type ComponentScope = 'business' | 'navigation' | 'shell' | 'third-party' | 'unknown';

export type PageRole =
  | 'login' | 'dashboard' | 'list' | 'detail'
  | 'form' | 'settings' | 'report' | 'modal' | 'unknown';

export interface PageNode {
  id: string;
  url: string;
  title: string;
  urlPattern: string;
  role: PageRole;
  components: Component[];
  navigationTargets: NavigationEdge[];
  meta: {
    firstSeenAt: number;
    lastVisitedAt: number;
    visitCount: number;
    testStatus: 'untested' | 'partial' | 'tested';
  };
}

export interface Component {
  id: string;
  pageId: string;
  type: ComponentType;
  selector: string;
  label: string;
  state: ComponentState;
  constraints: Constraint[];
  parent?: string;
  children: string[];
  scope?: ComponentScope;
  meta: {
    confidence: number;
    source: 'rule' | 'signature' | 'llm';
  };
}

export interface ComponentState {
  visible: boolean;
  enabled: boolean;
  value?: string;
  options?: string[];
  expanded?: boolean;
  validationErrors?: string[];
}

export interface Constraint {
  type: 'required' | 'maxLength' | 'pattern' | 'min' | 'max' | 'custom';
  value: any;
  message?: string;
}

export interface Interaction {
  id: string;
  componentId: string;
  action: ActionType;
  preconditions: string[];
  expectedEffects: string[];
  sideEffects: string[];
}

export type ActionType =
  | 'click' | 'type' | 'select'
  | 'hover' | 'scroll' | 'drag'
  | 'focus' | 'blur' | 'keyboard';

export interface NavigationEdge {
  fromPageId: string;
  toPageId: string;
  trigger: string;
  method: 'link' | 'button' | 'redirect' | 'menu';
}

export interface ComponentModel {
  pages: PageNode[];
  components: Component[];
  interactions: Interaction[];
  navigationGraph: NavigationEdge[];
  lastUpdatedAt: number;
}

/**
 * Classify a component from extracted data.
 * Layer 1: rule matching (deterministic, no LLM).
 */
export function classifyComponent(extracted: ExtractedComponent): {
  type: ComponentType;
  confidence: number;
  source: 'rule';
} {
  const tag = extracted.tag;
  const role = extracted.role;
  const classes = extracted.classes.map(c => c.toLowerCase()).join(' ');

  // High confidence: semantic tags
  if (tag === 'button' || role === 'button') return { type: 'button', confidence: 0.95, source: 'rule' };
  if (tag === 'a' || role === 'link') return { type: 'link', confidence: 0.95, source: 'rule' };
  if (tag === 'textarea' || role === 'textbox') return { type: 'textarea', confidence: 0.95, source: 'rule' };
  if (tag === 'select') return { type: 'select', confidence: 0.95, source: 'rule' };
  if (tag === 'form') return { type: 'form', confidence: 0.95, source: 'rule' };
  if (tag === 'table') return { type: 'table', confidence: 0.95, source: 'rule' };
  if (tag === 'input') {
    if (extracted.type === 'checkbox') return { type: 'checkbox', confidence: 0.95, source: 'rule' };
    if (extracted.type === 'radio') return { type: 'radio', confidence: 0.95, source: 'rule' };
    if (extracted.type === 'file') return { type: 'fileupload', confidence: 0.95, source: 'rule' };
    return { type: 'input', confidence: 0.9, source: 'rule' };
  }

  // High confidence: ARIA roles
  if (role === 'dialog') return { type: 'modal', confidence: 0.9, source: 'rule' };
  if (role === 'tab') return { type: 'tab', confidence: 0.9, source: 'rule' };
  if (role === 'combobox') return { type: 'select', confidence: 0.85, source: 'rule' };
  if (role === 'menuitem') return { type: 'dropdown', confidence: 0.85, source: 'rule' };

  // Medium confidence: component library classes
  if (classes.includes('ant-select') || classes.includes('el-select')) {
    return { type: 'select', confidence: 0.85, source: 'rule' };
  }
  if (classes.includes('ant-collapse') || classes.includes('ant-collapse-item')) {
    return { type: 'accordion', confidence: 0.85, source: 'rule' };
  }
  if (classes.includes('ant-modal') || classes.includes('el-dialog')) {
    return { type: 'modal', confidence: 0.85, source: 'rule' };
  }
  if (classes.includes('ant-tabs-tab')) {
    return { type: 'tab', confidence: 0.85, source: 'rule' };
  }
  if (classes.includes('ant-pagination') || classes.includes('el-pagination')) {
    return { type: 'pagination', confidence: 0.85, source: 'rule' };
  }
  if (classes.includes('ant-picker')) {
    return { type: 'datepicker', confidence: 0.8, source: 'rule' };
  }

  // Low confidence: clickability-based
  if (extracted.clickability.isHighConfidence) {
    return { type: 'button', confidence: 0.6, source: 'rule' };
  }

  return { type: 'unknown', confidence: 0.3, source: 'rule' };
}

/**
 * 用可解释的本地规则区分业务控件和页面外壳，避免菜单、页脚链接污染业务覆盖率。
 */
export function classifyComponentScope(
  extracted: ExtractedComponent,
  type: ComponentType = classifyComponent(extracted).type,
): ComponentScope {
  const classes = extracted.classes.join(' ').toLowerCase();
  const label = `${extracted.text ?? ''} ${extracted.ariaLabel ?? ''}`.toLowerCase();
  if (/cookie|captcha|recaptcha|intercom|zendesk|third[- ]party/.test(classes)) return 'third-party';
  if (/header|footer|navbar|sidebar|topbar|breadcrumb/.test(classes)) return 'shell';
  if (type === 'link' || /^(home|首页|文档|docs|github|关于|帮助|help)$/.test(label.trim())) return 'navigation';
  if (type === 'unknown') return 'unknown';
  return 'business';
}
