import { describe, expect, it } from 'vitest';
import { request } from 'node:http';

import { renderChatPage, renderOpsPage, startStaticWebServer } from './index.js';

describe('renderChatPage', () => {
  it('renders a polished support workbench that streams chat and shows citations', () => {
    const html = renderChatPage();

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="quick-prompt"');
    expect(html).toContain('id="messages"');
    expect(html).toContain('<form id="chat-form"');
    expect(html).toContain('<textarea id="message"');
    expect(html).toContain('fetch("/api/chat/stream"');
    expect(html).toContain('body.getReader()');
    expect(html).toContain('appendMessage("assistant"');
    expect(html).toContain('renderCitations(assistantMessage.citations');
    expect(html).toContain('renderAttachments(assistantMessage.attachments');
    expect(html).toContain('document.createElement("video")');
    expect(html).toContain('document.createElement("img")');
    expect(html).toContain('.attachment img');
    expect(html).toContain('className = "feedback-actions"');
    expect(html).toContain('fetch("/api/feedback"');
  });

  it('does not render citation payloads with innerHTML', () => {
    const html = renderChatPage();

    expect(html).not.toContain('citations.innerHTML = (payload.citations || [])');
  });

  it('renders streamed assistant markdown safely after metadata arrives', () => {
    const html = renderChatPage();

    expect(html).toContain('assistantMessage.rawAnswer += payload.delta || ""');
    expect(html).toContain('renderMarkdown(assistantMessage.answer, assistantMessage.rawAnswer)');
    expect(html).toContain('function renderMarkdown(target, markdown)');
    expect(html).toContain('function appendInlineMarkdown(parent, text)');
    expect(html).not.toContain('assistantMessage.answer.innerHTML');
    expect(html).not.toContain('innerHTML =');
  });

  it('submits the raw assistant answer in feedback after markdown rendering', () => {
    const html = renderChatPage();

    expect(html).toContain(
      'answer: assistantMessage.rawAnswer || assistantMessage.answer.textContent || ""',
    );
  });

  it('does not pretend to handle API routes in standalone mode', async () => {
    const server = startStaticWebServer(0);
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected test server to bind to a TCP port');
      }

      const response = await post(address.port, '/api/chat');

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('<!doctype html>');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

describe('renderOpsPage', () => {
  it('renders an ops dashboard that fetches protected summary data', () => {
    const html = renderOpsPage();

    expect(html).toContain('XXYY Ops');
    expect(html).toContain('id="ops-token"');
    expect(html).toContain('fetch("/api/ops/summary"');
    expect(html).toContain('Authorization: "Bearer " + token');
    expect(html).toContain('renderHealth(summary.health)');
    expect(html).toContain('renderKnowledge(summary.knowledge)');
    expect(html).toContain('renderFeedback(summary.feedback)');
    expect(html).toContain(
      'renderEvalFailures(summary.knowledgeCandidateQueues?.recentEvalFailures || [])',
    );
    expect(html).toContain(
      'renderQualitySignals(summary.knowledgeCandidateQueues?.recentQualitySignals || [])',
    );
    expect(html).toContain('summary.knowledgeCandidateQueues?.needsReviewCount || 0');
    expect(html).toContain('summary.knowledgeCandidateQueues?.qualitySignalNeedsReviewCount || 0');
    expect(html).toContain('summary.knowledgeCandidateQueues?.approvedEvalCaseCount || 0');
    expect(html).toContain('summary.knowledgeCandidateQueues?.evalFailedCount || 0');
    expect(html).toContain('id="knowledge-eval-failures"');
    expect(html).toContain('id="knowledge-quality-signals"');
    expect(html).toContain('recent.failureReasons');
    expect(html).toContain('Quality gap · " + recent.candidateId');
    expect(html).toContain('recent.targetCategory');
    expect(html).toContain('recent.riskLevel');
    expect(html).toContain('Transaction Analysis');
    expect(html).toContain('renderTxAnalysis(summary.txAnalysis, summary.txAnalysisRuntime)');
    expect(html).toContain('summary.byReviewStatus || {}');
    expect(html).toContain('Review · " + status');
    expect(html).toContain('Runtime · provider');
    expect(html).toContain('Browser concurrency');
    expect(html).toContain('Browser retry');
    expect(html).toContain('Browser timeout');
  });

  it('renders transaction analysis report and screenshot links in ops rows', () => {
    const html = renderOpsPage();

    expect(html).toContain('link("Report", report.reportUrl)');
    expect(html).toContain('link("Screenshot", report.screenshotUrl)');
    expect(html).toContain('link("Explorer", report.explorerUrl)');
    expect(html).toContain('link("XXYY", report.xxyyPoolUrl)');
    expect(html).toContain('screenshotMarkerNode(report)');
    expect(html).toContain('function screenshotMarkerNode(report)');
    expect(html).toContain('Target row marked');
    expect(html).toContain('Target row unmarked');
    expect(html).toContain('probeAttemptNodes(report)');
    expect(html).toContain('function probeAttemptNodes(report)');
    expect(html).toContain('"Probe " +');
    expect(html).toContain('formatChainLabel(attempt.chain)');
    expect(html).toContain('formatProbeReason(attempt.reason)');
    expect(html).toContain('relatedTransactionLinks(report)');
    expect(html).toContain('link(relatedTransactionLabel(transaction), transaction.explorerUrl)');
    expect(html).toContain('function relatedTransactionLabel(transaction)');
    expect(html).toContain('formatTradeSideLabel(transaction.side)');
    expect(html).toContain('"Trader " + transaction.traderAddress');
    expect(html).toContain('"Time " + transaction.timestamp');
    expect(html).toContain(
      'report.targetTraderAddress ? text("Trader " + report.targetTraderAddress) : undefined',
    );
    expect(html).toContain(
      'report.transactionTime ? text("Time " + report.transactionTime) : undefined',
    );
    expect(html).toContain(
      'report.routerAddress ? text("Router " + report.routerAddress) : undefined',
    );
    expect(html).toContain(
      'report.unsupportedExplorerHost ? text("Unsupported explorer " + report.unsupportedExplorerHost) : undefined',
    );
    expect(html).toContain(
      'report.unsupportedChainHint ? text("Unsupported chain " + report.unsupportedChainHint) : undefined',
    );
    expect(html).toContain(
      'report.analysisRuleVersion ? text("Rule " + report.analysisRuleVersion) : undefined',
    );
    expect(html).toContain('Rule · " + version');
    expect(html).toContain('document.createElement("a")');
    expect(html).toContain('anchor.target = "_blank"');
  });

  it('renders a transaction analysis report search panel for ops review', () => {
    const html = renderOpsPage();

    expect(html).toContain('id="tx-report-form"');
    expect(html).toContain('id="tx-report-hash"');
    expect(html).toContain('id="tx-report-chain"');
    expect(html).toContain('list="tx-report-chain-options"');
    expect(html).toContain('id="tx-report-chain-options"');
    expect(html).toContain('<option value="ETH">');
    expect(html).toContain('<option value="BNBChain">');
    expect(html).toContain('<option value="BNB Smart Chain">');
    expect(html).not.toContain('<select id="tx-report-chain"');
    expect(html).toContain('id="tx-report-status"');
    expect(html).toContain('id="tx-report-review-status"');
    expect(html).toContain('<option value="in_review">In review</option>');
    expect(html).toContain('id="tx-report-assignee"');
    expect(html).toContain('id="tx-report-reason"');
    expect(html).toContain('<option value="not_configured">not_configured</option>');
    expect(html).toContain('<option value="invalid_reference">invalid_reference</option>');
    expect(html).toContain('<option value="tx_failed">tx_failed</option>');
    expect(html).toContain('<option value="tx_pending">tx_pending</option>');
    expect(html).toContain('id="tx-report-results"');
    expect(html).toContain('function loadTxReports()');
    expect(html).toContain('new URLSearchParams()');
    expect(html).toContain('fetch("/api/tx-analysis/reports?" + params.toString()');
    expect(html).toContain('params.set("reviewStatus", reviewStatus)');
    expect(html).toContain('params.set("assignee", assignee)');
    expect(html).toContain('renderTxReportResults(payload.reports || [])');
    expect(html).toContain('queryTxReports.addEventListener("submit"');
    expect(html).toContain('return "tx pending"');
    expect(html).not.toContain('Enter tx hash, status, or failure reason.');
  });

  it('renders transaction analysis report review controls that save with the ops token', () => {
    const html = renderOpsPage();

    expect(html).toContain('reportReviewNodes(report)');
    expect(html).toContain('class="panel wide-panel"');
    expect(html).toContain('.row-title span');
    expect(html).toContain('function reportReviewNodes(report)');
    expect(html).toContain('function createReportReviewForm(report)');
    expect(html).toContain('function updateReportReview(report, payload, statusTarget)');
    expect(html).toContain('className = "report-review-form"');
    expect(html).toContain('status.name = "review-status"');
    expect(html).toContain('{ value: "in_review", label: "In review" }');
    expect(html).toContain('assignee.name = "assignee"');
    expect(html).toContain('note.name = "note"');
    expect(html).toContain('review.status || "open"');
    expect(html).toContain('grid-column: 1 / -1;');
    expect(html).toContain(
      'fetch("/api/tx-analysis/reports/" + encodeURIComponent(reportId) + "/review"',
    );
    expect(html).toContain('Authorization: "Bearer " + token');
  });

  it('renders transaction analysis report workflow action buttons for ops queues', () => {
    const html = renderOpsPage();

    expect(html).toContain('function createReportReviewWorkflowButton(');
    expect(html).toContain('claim.textContent = "Claim"');
    expect(html).toContain('close.textContent = "Close"');
    expect(html).toContain('reopen.textContent = "Reopen"');
    expect(html).toContain('action: "claim"');
    expect(html).toContain('action: "close"');
    expect(html).toContain('action: "reopen"');
    expect(html).toContain('assignee.value.trim()');
    expect(html).toContain('note.value.trim()');
  });

  it('renders source-filtered knowledge candidate queues for automatic answer quality review', () => {
    const html = renderOpsPage();

    expect(html).toContain('Knowledge Candidates');
    expect(html).toContain('id="knowledge-candidate-status-filter"');
    expect(html).toContain('<option value="approved">Approved</option>');
    expect(html).toContain('id="knowledge-candidate-type"');
    expect(html).toContain('<option value="eval_case">Eval cases</option>');
    expect(html).toContain('id="knowledge-candidate-source"');
    expect(html).toContain('<option value="">Any source</option>');
    expect(html).toContain('<option value="answer_feedback">Answer feedback</option>');
    expect(html).toContain('<option value="answer_quality_signal">Quality signals</option>');
    expect(html).toContain('function loadKnowledgeCandidates()');
    expect(html).toContain('params.set("status", knowledgeCandidateStatusFilter.value)');
    expect(html).toContain('if (knowledgeCandidateType.value) {');
    expect(html).toContain('params.set("type", knowledgeCandidateType.value)');
    expect(html).toContain('if (knowledgeCandidateSource.value) {');
    expect(html).toContain('params.set("source", knowledgeCandidateSource.value)');
    expect(html).toContain('fetch("/api/knowledge/candidates?" + params.toString()');
    expect(html).toContain('Authorization: "Bearer " + token');
    expect(html).toContain('renderKnowledgeCandidates(payload.candidates || [])');
  });

  it('renders bulk transaction analysis report review controls for ops queues', () => {
    const html = renderOpsPage();

    expect(html).toContain('id="tx-report-bulk-review"');
    expect(html).toContain('id="tx-report-bulk-assignee"');
    expect(html).toContain('id="tx-report-bulk-note"');
    expect(html).toContain('data-action="claim"');
    expect(html).toContain('data-action="close"');
    expect(html).toContain('data-action="reopen"');
    expect(html).toContain('function selectedTxReportIds()');
    expect(html).toContain('className = "tx-report-select"');
    expect(html).toContain('checkbox.value = reportId');
    expect(html).toContain('function updateSelectedTxReportCount()');
    expect(html).toContain('function updateBulkReportReview(action)');
    expect(html).toContain('fetch("/api/tx-analysis/reports/review"');
    expect(html).toContain('ids: selectedTxReportIds()');
    expect(html).toContain('renderTxReportResults(currentTxReports)');
  });

  it('does not hardcode an ops token in the page', () => {
    const html = renderOpsPage();

    expect(html).not.toContain('API_OPS_TOKEN');
    expect(html).not.toContain('secret-token');
  });
});

function post(port: number, path: string): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        method: 'POST',
        path,
        port,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ body, statusCode: res.statusCode ?? 0 });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
