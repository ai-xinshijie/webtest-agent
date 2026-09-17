export interface ExtractedComponent {
  tag: string;
  role: string | null;
  text?: string;
  id?: string;
  classes: string[];
  testId?: string;
  ariaLabel: string | null;
  placeholder: string | null;

  state: {
    visible: boolean;
    enabled: boolean;
    inViewport: boolean;
    cursorPointer: boolean;
    userSelectNone: boolean;
  };

  clickability: {
    score: number;
    isInteractive: boolean;
    isHighConfidence: boolean;
    signals: {
      isSemanticTag: boolean;
      hasAriaRole: boolean;
      cursorPointer: boolean;
      hasOnclick: boolean;
      hasTabIndex: boolean;
    };
  };

  value?: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  validationMessage?: string;

  parentDialog?: string;
  parentForm?: string;
  parentAccordion?: string;

  rect: { x: number; y: number; w: number; h: number };
  selector: string | null;
}

export interface StructuredObservation {
  type: 'structured';
  timestamp: number;
  url: string;
  title: string;
  components: ExtractedComponent[];
  forms: Array<{ id: string; fieldCount: number; hasFileInput: boolean }>;
  dialogCount: number;
  loadingOverlayCount: number;
  networkEvents: NetworkEvent[];
}

export interface NetworkEvent {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
}

export interface Observation {
  type: 'structured' | 'visual' | 'fused';
  timestamp: number;
  url: string;
  components?: ExtractedComponent[];
  screenshot?: string;
  networkEvents?: NetworkEvent[];
}
