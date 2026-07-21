import { redactSensitiveSupportText } from './redaction.js';
import type { RetrievedChunk } from './retrieve.js';

export const KNOWLEDGE_INJECTION_QUARANTINE_MARKER = '[已隔离疑似指令注入内容]';

export type KnowledgeInjectionSignal =
  | 'instruction_override'
  | 'prompt_exfiltration'
  | 'role_delimiter'
  | 'role_override'
  | 'tool_call_forgery';

export interface KnowledgeContentSafetyResult {
  detected: boolean;
  removedSegmentCount: number;
  signals: KnowledgeInjectionSignal[];
  text: string;
}

interface KnowledgeContentSegment {
  content: string;
  separator: string;
}

const ROLE_DELIMITER_PATTERNS = [
  /(?:^|\s)(?:#{1,6}\s*)?(?:system|developer|assistant|user)\s*(?:message\s*)?[:：]/iu,
  /(?:^|\s)<\|(?:system|developer|assistant|user|endoftext)\|>/iu,
  /(?:^|\s)<\/?(?:system|developer|assistant|user)>/iu,
  /(?:^|\s)\[(?:system|developer|assistant|user|inst)\]/iu,
];

const INSTRUCTION_OVERRIDE_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,80}\b(?:previous|prior|above|all|system|developer)\b.{0,40}\b(?:instruction|message|prompt|rule|policy)s?\b/iu,
  /(?:忽略|无视|绕过|覆盖|忘记).{0,30}(?:之前|以上|上面|所有|系统|开发者).{0,20}(?:指令|消息|提示词|规则|策略)/u,
  /(?:不要|不必).{0,20}(?:遵守|服从|执行).{0,20}(?:系统|开发者|之前|以上).{0,20}(?:指令|规则|策略)/u,
];

const ROLE_OVERRIDE_PATTERNS = [
  /\b(?:you are now|act as|pretend to be|switch (?:your )?role)\b/iu,
  /(?:你现在是|从现在起你是|扮演|假装成为|切换.{0,8}角色)/u,
  /\b(?:jailbreak|developer mode|do anything now|\bdan\b)\b/iu,
];

const PROMPT_EXFILTRATION_PATTERNS = [
  /\b(?:reveal|print|repeat|show|output|expose|leak|send)\b.{0,80}\b(?:system prompt|developer message|hidden instruction|api key|access token|secret|credential)s?\b/iu,
  /(?:输出|打印|展示|复述|泄露|发送|暴露).{0,50}(?:系统提示词|开发者消息|隐藏指令|API\s*key|访问令牌|私钥|助记词|密码|密钥)/iu,
];

const TOOL_CALL_FORGERY_PATTERNS = [
  /(?:^|\s)<\/?(?:tool_call|function_call|tool)>/iu,
  /(?:^|\s)(?:tool|function)\s*(?:call|name)?\s*[:：=]/iu,
  /(?:^|\s)(?:调用|执行)(?:工具|函数)\s*[:：]/u,
];

export function sanitizeUntrustedKnowledgeText(text: string): KnowledgeContentSafetyResult {
  const redactedText = redactSensitiveSupportText(text).replace(/\r\n?/gu, '\n');
  const segments = splitKnowledgeContentSegments(redactedText);
  const safeSegments: string[] = [];
  const signals = new Set<KnowledgeInjectionSignal>();
  let removedSegmentCount = 0;

  for (const segment of segments) {
    const trimmedSegment = segment.content.trim();
    if (trimmedSegment === KNOWLEDGE_INJECTION_QUARANTINE_MARKER) {
      removedSegmentCount += 1;
      safeSegments.push(`${segment.content}${segment.separator}`);
      continue;
    }

    const segmentSignals = detectKnowledgeInjectionSignals(trimmedSegment);
    if (segmentSignals.length === 0) {
      safeSegments.push(`${segment.content}${segment.separator}`);
      continue;
    }

    removedSegmentCount += 1;
    for (const signal of segmentSignals) {
      signals.add(signal);
    }
    safeSegments.push(`${KNOWLEDGE_INJECTION_QUARANTINE_MARKER}${segment.separator}`);
  }

  return {
    detected: removedSegmentCount > 0,
    removedSegmentCount,
    signals: [...signals].sort(),
    text: safeSegments.join('').trim(),
  };
}

export function hasUsableKnowledgeText(text: string): boolean {
  return text.replaceAll(KNOWLEDGE_INJECTION_QUARANTINE_MARKER, '').trim().length > 0;
}

export function sanitizeRetrievedKnowledgeChunk(chunk: RetrievedChunk): RetrievedChunk {
  return {
    ...chunk,
    metadata: {
      ...chunk.metadata,
      headingPath: chunk.metadata.headingPath.map(
        (heading) => sanitizeUntrustedKnowledgeText(heading).text,
      ),
      module: sanitizeUntrustedKnowledgeText(chunk.metadata.module).text,
      title: sanitizeUntrustedKnowledgeText(chunk.metadata.title).text,
    },
    text: sanitizeUntrustedKnowledgeText(chunk.text).text,
  };
}

function splitKnowledgeContentSegments(text: string): KnowledgeContentSegment[] {
  const segments: KnowledgeContentSegment[] = [];
  let segmentStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    const isChineseSentenceEnd = character !== undefined && /[。！？；]/u.test(character);
    const isLatinSentenceEnd =
      character !== undefined &&
      /[.!?;]/u.test(character) &&
      nextCharacter !== undefined &&
      /\s/u.test(nextCharacter);
    const isNewline = character === '\n';
    if (!isChineseSentenceEnd && !isLatinSentenceEnd && !isNewline) {
      continue;
    }

    const contentEnd = isNewline ? index : index + 1;
    let separatorEnd = contentEnd;
    while (separatorEnd < text.length && /\s/u.test(text[separatorEnd] ?? '')) {
      separatorEnd += 1;
    }
    const content = text.slice(segmentStart, contentEnd);
    const separator = text.slice(contentEnd, separatorEnd);
    if (content.length > 0 || separator.length > 0) {
      segments.push({ content, separator });
    }
    segmentStart = separatorEnd;
    index = separatorEnd - 1;
  }

  if (segmentStart < text.length) {
    segments.push({ content: text.slice(segmentStart), separator: '' });
  }

  return segments;
}

function detectKnowledgeInjectionSignals(segment: string): KnowledgeInjectionSignal[] {
  const signals: KnowledgeInjectionSignal[] = [];

  if (ROLE_DELIMITER_PATTERNS.some((pattern) => pattern.test(segment))) {
    signals.push('role_delimiter');
  }
  if (INSTRUCTION_OVERRIDE_PATTERNS.some((pattern) => pattern.test(segment))) {
    signals.push('instruction_override');
  }
  if (ROLE_OVERRIDE_PATTERNS.some((pattern) => pattern.test(segment))) {
    signals.push('role_override');
  }
  if (PROMPT_EXFILTRATION_PATTERNS.some((pattern) => pattern.test(segment))) {
    signals.push('prompt_exfiltration');
  }
  if (TOOL_CALL_FORGERY_PATTERNS.some((pattern) => pattern.test(segment))) {
    signals.push('tool_call_forgery');
  }

  return signals;
}
