import type { Classification } from '@xxyy/shared';

export type AnswerPlanRoute = 'boundary' | 'clarify' | 'product_answer' | 'transaction_analysis';

export interface PlanAnswerInput {
  classification: Classification;
  resolvedMessage: string;
}

export type AnswerPlan =
  | {
      classification: Classification;
      messageForTool: string;
      route: 'product_answer' | 'transaction_analysis';
    }
  | {
      classification: Classification;
      route: 'boundary';
    }
  | {
      clarificationQuestion: string;
      classification: Classification;
      route: 'clarify';
    };

export function planAnswer(input: PlanAnswerInput): AnswerPlan {
  if (input.classification.intent === 'product_qa' || input.classification.intent === 'how_to') {
    return {
      classification: input.classification,
      messageForTool: input.resolvedMessage,
      route: 'product_answer',
    };
  }

  if (input.classification.intent === 'tx_sandwich_detection') {
    return {
      classification: input.classification,
      messageForTool: input.resolvedMessage,
      route: 'transaction_analysis',
    };
  }

  if (isUnsafeUnsupportedClassification(input.classification)) {
    return {
      classification: input.classification,
      route: 'boundary',
    };
  }

  if (input.classification.intent === 'unknown') {
    return {
      clarificationQuestion:
        '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
      classification: input.classification,
      route: 'clarify',
    };
  }

  return {
    classification: input.classification,
    route: 'boundary',
  };
}

export function isUnsafeUnsupportedClassification(classification: Classification): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'unsafe or unsupported operation request'
  );
}
