export type SupportSource = 'telegram';
export type KnowledgeCandidateSource = SupportSource | 'answer_feedback' | 'answer_quality_signal';

export type SupportMessageSenderRole = 'user' | 'support' | 'system' | 'unknown';

export interface RawSupportMessage {
  source: SupportSource;
  chatIdHash: string;
  messageId: string;
  threadId?: string;
  replyToMessageId?: string;
  senderRole: SupportMessageSenderRole;
  sentAt: string;
  text: string;
  contentHash: string;
  ingestedAt: string;
  attachmentsMetadata?: Record<string, unknown>;
}

export type RedactedEntityType =
  | 'email'
  | 'phone'
  | 'evm_address'
  | 'solana_address'
  | 'url'
  | 'private_credential';

export interface RedactedEntitySummary {
  type: RedactedEntityType;
  count: number;
}

export type KnowledgeRiskFlag =
  | 'private_account_query'
  | 'private_transaction_data'
  | 'private_credentials'
  | 'investment_advice';

export type KnowledgeRiskLevel = 'low' | 'medium' | 'high';

export interface RedactionReport {
  entities: RedactedEntitySummary[];
  riskFlags: KnowledgeRiskFlag[];
  riskLevel: KnowledgeRiskLevel;
}

export interface RedactedSupportMessage extends Omit<RawSupportMessage, 'text'> {
  text: string;
  redactionReport: RedactionReport;
}

export type KnowledgeCandidateType = 'faq' | 'doc_patch' | 'boundary_example' | 'eval_case';

export type KnowledgeCandidateStatus =
  | 'draft'
  | 'needs_review'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'ingested'
  | 'eval_passed'
  | 'eval_failed';

export interface KnowledgeCandidateSourceRef {
  source: KnowledgeCandidateSource;
  chatIdHash: string;
  messageId: string;
  threadId?: string;
  qualitySignalReason?: string;
}

export interface ExistingKnowledgeMatch {
  title: string;
  score: number;
  file?: string;
  sourceUrl?: string;
}

export type GeneratedEvalIntent =
  | 'product_qa'
  | 'how_to'
  | 'tx_sandwich_detection'
  | 'realtime_account_query'
  | 'mev_or_chain_forensics'
  | 'investment_advice'
  | 'unknown';

export interface GeneratedEvalCase {
  question: string;
  expectedAnswer: string;
  expectedIntent?: GeneratedEvalIntent;
  minCitations?: number;
  requireExpectedAnswerText?: boolean;
}

export interface KnowledgeCandidate {
  id: string;
  type: KnowledgeCandidateType;
  status: KnowledgeCandidateStatus;
  question: string;
  proposedAnswer: string;
  targetCategory: 'product_faq' | 'policy_boundary' | 'doc_patch' | 'eval_case';
  sourceRefs: KnowledgeCandidateSourceRef[];
  redactionReport: RedactionReport;
  existingKnowledgeMatches: ExistingKnowledgeMatch[];
  confidence: number;
  riskLevel: KnowledgeRiskLevel;
  generatedEvalCases: GeneratedEvalCase[];
  reviewer?: string;
  reviewNotes?: string;
  publishedTarget?: string;
  createdAt: string;
  updatedAt: string;
}
