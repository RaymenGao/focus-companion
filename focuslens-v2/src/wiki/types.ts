export type MasteryState =
  | "pending_verification"
  | "weak"
  | "learning"
  | "pending_retest"
  | "mastered";

export type WikiView =
  | "diagnosis"
  | "library"
  | "organizer";

export type WikiOperation = {
  id: string;
  tool:
    | "create_page"
    | "update_fields"
    | "merge_pages"
    | "move_page"
    | "add_links"
    | "remove_links"
    | "archive_evidence"
    | "trash_page";
  reason: string;
  risk: "low" | "medium" | "high";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  conflicts: string[];
  selected: boolean;
};

export type WikiPageSummaryV2 = {
  id: string;
  type: "knowledge";
  title: string;
  shortTitle: string;
  subject: string;
  chapter: string;
  masteryState: MasteryState;
  path: string;
  termId?: string;
};

export type WikiPageV2 = WikiPageSummaryV2 & {
  markdown: string;
  meta: Record<string, unknown>;
};

export type WikiGraphNodeV2 = {
  id: string;
  label: string;
  full_title: string;
  type: "subject" | "chapter" | "knowledge" | "prerequisite";
  subject: string;
  chapter: string;
  mastery_state: MasteryState;
  evidence_count: number;
  page_id: string;
  why: string;
  recent_evidence: string;
  review_first: string;
  next_action: string;
};

export type WikiGraphV2 = {
  mode: "weak" | "full";
  nodes: WikiGraphNodeV2[];
  edges: Array<{
    source: string;
    target: string;
    type: "contains" | "prerequisite_of" | "related_to";
  }>;
};

export type WikiInboxItem = {
  id: string;
  meta: {
    event_id: string;
    locked_fields: string[];
    decision: {
      confidence: number;
      subject: string;
      chapter: string;
      short_title: string;
      full_title: string;
      common_reasons: string[];
      prerequisites: string[];
    };
  };
  sections: Record<string, string>;
};

export type WikiOrganizePlan = {
  runId: string;
  rounds: number;
  operations: WikiOperation[];
  conflicts: string[];
  estimatedCostUsd: number;
  sourceHashes: Record<string, string>;
  instruction: string;
  status?: "pending" | "executed" | "undone" | "failed";
  transactionId?: string;
  executedOperationIds?: string[];
};

export type OrganizerAiConfig = {
  aiBaseUrl: string;
  apiKey: string;
  model: string;
  enableThinking: boolean;
};

export type WikiTerm = {
  id: string;
  label: string;
  status: "active" | "archived";
  created_at: string;
  archived_at?: string;
};

export type WikiTermsResponse = {
  active_term_id: string;
  terms: WikiTerm[];
};
