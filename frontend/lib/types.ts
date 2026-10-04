// Mirrors src/models.py and src/report.py. The agent sends these as camelCase JSON.

export type Segment = 'Entrepreneur' | 'Independent' | 'Privatier' | 'Top Executive';
export type RiskScore = 'High' | 'Medium' | 'Low';
export type Stage = 'wealth' | 'family' | 'report';
export type Section = 'wealth' | 'family' | 'general';
export type PointKind = 'missing' | 'inconsistency' | 'plausibility' | 'topic' | 'inefficiency';
export type Scenario = 'death';
/** Who leads the conversation: Warren, point by point, or the banker. */
export type Mode = 'guided' | 'listening';
/** The language Warren speaks and writes the report in. The screen stays in English. */
export type Language = 'en' | 'fr' | 'es';
export type StepOutcome = 'answered' | 'for_meeting' | 'dismissed' | 'skipped';
/** How the steps are grouped on screen. */
export type StepGroup = 'briefing' | 'wealth' | 'family' | 'general' | 'simulation' | 'report';
/** The part of the wealth view a step is about. */
export type WealthSection = 'balance' | 'cashflow' | 'pensions';

/** One step of the guided review. Mirrors Step in src/models.py. */
export interface Step {
  id: string;
  /** A gate asks the banker to confirm before the review moves to its next part. */
  kind: 'briefing' | 'point' | 'gate' | 'offer' | 'simulation' | 'closing';
  group: StepGroup;
  stage: Stage;
  scenario: Scenario | null;
  focus: WealthSection | null;
  title: string;
  say: string;
  pointIds: string[];
  itemId: string | null;
  /** Everything on screen the step is about: lit, and scrolled to, while it lasts. */
  targetIds: string[];
  /** 'banker' for a point the banker asked to note: recorded, never asked about. */
  origin: 'review' | 'banker';
  status: 'pending' | 'done';
  outcome: StepOutcome | null;
}

export interface Place {
  city: string | null;
  country: string | null;
}

export interface Client {
  id: string;
  name: string;
  dateOfBirth: string;
  domicile: Place;
  segment: Segment;
  riskScore: RiskScore;
  performanceYtdPct: number;
  lastContact: string | null;
}

export interface Asset {
  id: string;
  type: string;
  bankable: boolean | null;
  label: string | null;
  amount: number | null;
  currency: string | null;
  country: string | null;
  bank: string | null;
  /** Country whose tax law attaches to the asset; distinct from where it is booked. */
  situs?: string | null;
  holding?: string | null;
  clientSharePct?: number | null;
}

export interface Liability {
  id: string;
  type: string;
  label: string | null;
  amount: number | null;
  currency: string | null;
  country: string | null;
  bank: string | null;
  securedByAssetId: string | null;
}

export interface Pension {
  id: string;
  type: string;
  provider: string | null;
  amount: number | null;
  currency: string | null;
  country: string | null;
}

export interface CashFlow {
  id: string;
  direction: 'income' | 'expense';
  frequency: 'recurring' | 'one_off' | null;
  type: string;
  label: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
}

export interface FamilyMember {
  id: string;
  relation: string;
  name: string | null;
  birthYear: number | null;
  residence: Place | null;
  otherParentId: string | null;
  notes: string | null;
}

export interface Family {
  maritalStatus: string | null;
  hasChildren: boolean | null;
  maritalRegime?: string | null;
  hasWill?: boolean | null;
  members: FamilyMember[];
}

export interface MeetingPoint {
  id: string;
  section: Section;
  kind: PointKind;
  text: string;
  source: 'rule' | 'agent' | 'banker';
  status: 'open' | 'resolved' | 'dismissed';
  relatedItemId: string | null;
  ruleKey: string | null;
  /** For a cost of inaction: the bank expert to involve and the amount at stake. */
  expert?: string | null;
  amount?: number | null;
}

export interface Slice {
  key: string;
  value: number;
  share: number;
}

export interface ReportPoint {
  pointIds: string[];
  section: Section;
  topic: string;
  opener: string;
}

export interface ReportExpert {
  id: string;
  label: string;
  reasons: string[];
  amount: number;
}

export interface SuccessionTax {
  ruleId: string;
  layer: 'situs' | 'heir';
  topic: string;
  country: string;
  assetIds: string[];
  heirId: string | null;
  base: number;
  low: number;
  high: number;
  expert: string;
  source: string;
}

export interface SuccessionHeir {
  memberId: string | null;
  label: string;
  relation: string;
  country: string | null;
  sharePct: number;
  gross: number;
  tax: number;
  net: number;
  aumAtBank: number;
}

/** What would happen on the client's death. Mirrors src/succession.py. */
export interface Succession {
  rulesVersion: string;
  illustrative: boolean;
  assumptions: string[];
  missingInputs: string[];
  experts: Record<string, string>;
  heirsModelled: boolean;
  estate: number;
  costLow: number;
  costHigh: number;
  netToHeirs: number;
  liquidAssets: number;
  liquidityGap: number;
  taxes: SuccessionTax[];
  heirs: SuccessionHeir[];
  excluded: { memberId: string; reason: string }[];
}

export interface Report {
  status: 'generating' | 'ready';
  generatedAt: string | null;
  narrated: boolean;
  summary: string;
  figures: Record<string, number>;
  assetsByType: Slice[];
  assetsByCurrency: Slice[];
  assetsByCountry: Slice[];
  points: ReportPoint[];
  experts?: ReportExpert[];
}

/** A free-text note the banker wrote in the CRM after a contact with the client. */
export interface ActivityNote {
  id: string;
  date: string;
  author: string | null;
  text: string;
  /** What the note says that belongs in a structured field of the CRM. */
  facts: { id: string; section: Section; summary: string }[];
}

/** What is known about a client; the shape stored in data/clients.json. */
export interface Dossier {
  client: Client;
  assets: Asset[];
  liabilities: Liability[];
  pensions: Pension[];
  cashFlows: CashFlow[];
  family: Family;
  activityNotes?: ActivityNote[];
}

/** The full state of a preparation session, as sent by the agent. */
export interface PrepState extends Dossier {
  rev: number;
  stage: Stage;
  meetingPoints: MeetingPoint[];
  report: Report | null;
  succession: Succession | null;
  /** The simulation the agent has put on screen, if any. */
  scenario: Scenario | null;
  mode: Mode;
  language: Language;
  agenda: Step[];
  /** The step the review is on; null once it is complete. */
  currentStepId: string | null;
}

export interface Settings {
  houseBank: string;
  baseCurrency: string;
  fxToBase: Record<string, number>;
}
