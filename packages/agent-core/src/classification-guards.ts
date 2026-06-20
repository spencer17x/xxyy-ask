import type { Classification } from '@xxyy/shared';

export function isUnsafeUnsupportedClassification(classification: Classification): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'unsafe or unsupported operation request'
  );
}

export function isPrivateCredentialClassification(classification: Classification): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'private credential or seed phrase disclosure'
  );
}

export function isBusinessActionClassification(classification: Classification): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'business action execution request'
  );
}

export function isAmbiguousTransactionReferenceClassification(
  classification: Classification,
): boolean {
  return (
    classification.intent === 'tx_sandwich_detection' &&
    classification.reason ===
      'asks to analyze multiple transaction hashes and needs a single hash clarification'
  );
}
