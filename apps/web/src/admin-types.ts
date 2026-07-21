export type AdminPermission =
  | 'candidate:read'
  | 'candidate:review'
  | 'import:telegram'
  | 'publication:request'
  | 'trusted_author:manage';

export type CandidateStatus = 'approved' | 'pending' | 'published' | 'rejected';
export type PublicationStatus = 'failed' | 'queued' | 'running' | 'succeeded';

export interface AdminPrincipal {
  displayName: string;
  id: string;
  role: 'admin' | 'publisher' | 'reviewer' | 'viewer';
}

export interface AdminSession {
  permissions: AdminPermission[];
  principal: AdminPrincipal;
}

export interface KnowledgeCandidate {
  canonicalAnswer: string;
  contentHash: string;
  createdAt: string;
  id: string;
  question: string;
  sourceChannel: 'telegram' | 'telegram_export' | 'web';
  status: CandidateStatus;
  updatedAt: string;
  authorVerification?: {
    role?: string;
    source: string;
    status: string;
    userId?: string;
    validFrom?: string;
    validTo?: string;
    verifiedAt?: string;
  };
  conflictChunkIds?: string[];
  contextMessageIds?: string[];
  currentRevision?: number;
  duplicateCandidateIds?: string[];
  effectiveAt?: string;
  evidence?: string;
  extractionMethod?: string;
  proposedModule?: string;
  proposedTitle?: string;
  publishedAt?: string;
  publishedDocumentId?: string;
  qualityScore?: number;
  riskFlags?: string[];
  reviewNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  sourceAnswerMessageId?: string;
  sourceAnswerText?: string;
  sourceChatId?: string;
  sourceQuestionMessageId?: string;
  sourceQuestionText?: string;
  sourceUrl?: string;
  supersedes?: string[];
}

export interface CandidateRevision {
  canonicalAnswer: string;
  candidateId: string;
  createdAt: string;
  editedBy: string;
  id: number;
  question: string;
  revision: number;
  evidence?: string;
  proposedModule?: string;
  proposedTitle?: string;
  reason?: string;
}

export interface CandidateReview {
  candidateId: string;
  createdAt: string;
  decision: 'approve' | 'reject';
  id: number;
  reviewedBy: string;
  revision: number;
  note?: string;
}

export interface GovernanceAuditEvent {
  actor: string;
  createdAt: string;
  details: Record<string, unknown>;
  entityId: string;
  entityType: 'candidate' | 'publication' | 'trusted_author';
  eventType: string;
  id: string;
}

export interface ConflictReference {
  content: string;
  documentId: string;
  headingPath: string[];
  id: string;
  module: string;
  sourceType: 'admin_verified' | 'official_docs' | 'x_updates';
  status: 'current' | 'deprecated' | 'historical';
  title: string;
  effectiveAt?: string;
  sourceUrl?: string;
}

export interface PublicationJob {
  attemptCount: number;
  candidateId: string;
  createdAt: string;
  id: string;
  requestedBy: string;
  status: PublicationStatus;
  updatedAt: string;
  completedAt?: string;
  documentId?: string;
  lastError?: string;
  leaseExpiresAt?: string;
  runId?: string;
  startedAt?: string;
  workerId?: string;
}

export interface CandidateDetail {
  candidate: KnowledgeCandidate;
  conflicts: ConflictReference[];
  duplicates: KnowledgeCandidate[];
  history: {
    auditEvents: GovernanceAuditEvent[];
    reviews: CandidateReview[];
    revisions: CandidateRevision[];
  };
  publications: PublicationJob[];
}

export interface TrustedAuthor {
  chatId: string;
  createdAt: string;
  id: string;
  role: 'administrator' | 'knowledge_editor' | 'owner';
  updatedAt: string;
  userId: string;
  validFrom: string;
  verificationSource: 'import' | 'manual' | 'telegram_api';
  verifiedAt: string;
  verifiedBy: string;
  validTo?: string;
}

export interface TelegramImportResult {
  adminReplyCount: number;
  agentCandidateCount: number;
  candidateCount: number;
  created: KnowledgeCandidate[];
  deterministicCandidateCount: number;
  duplicateCount: number;
  messageCount: number;
  rejectedAgentProposalCount: number;
  runId: string;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
  threadCount: number;
  unverifiedAuthorMessageCount: number;
  verifiedAuthorMessageCount: number;
}
