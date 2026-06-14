export function isBrowserTimeoutError(error: unknown): boolean {
  if (hasUnavailableReason(error, 'timeout')) {
    return true;
  }

  return /\b(?:timeout|ETIMEDOUT)\b|timed out|timed[_-]out|err[_-](?:connection[_-])?timed[_-]out|ns[_-]error[_-]net[_-]timeout|und[_-]err[_-](?:connect|headers|body)[_-]timeout|(?:connect|headers|body)timeouterror|超时/iu.test(
    browserErrorMessage(error),
  );
}

export function isTransientBrowserNetworkError(error: unknown): boolean {
  return /net::ERR_|err[_-](?:aborted|failed|address[_-]unreachable|internet[_-]disconnected|connection[_-](?:aborted|reset|closed|refused)|proxy[_-]connection[_-]failed|tunnel[_-]connection[_-]failed|http2[_-]protocol[_-]error|quic[_-]protocol[_-]error|http[_-]response[_-]code[_-]failure|ssl[_-]protocol[_-]error|cert(?:[_-][a-z0-9]+)*[_-]invalid|invalid[_-]response|network[_-](?:access[_-]denied|io[_-]suspended|changed)|empty[_-]response|name[_-]not[_-]resolved)|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENETRESET|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET)\b|socket hang up|other side closed|connection reset|connection refused|getaddrinfo|networkerror when attempting to fetch resource|internet connection appears to be offline/iu.test(
    browserErrorMessage(error),
  );
}

export function isTransientBrowserProviderMessage(message: string): boolean {
  return (
    isTransientBrowserNetworkError(message) ||
    /execution context was destroyed|frame\s+(?:was\s+)?detached|protocol error|target closed|page closed|browser has been closed|context closed|(?:page|renderer)\s+crashed|(?:http\s*)?(?:429|50[234]|52[0-6])|failed to fetch|fetch failed|load failed|\bETIMEDOUT\b|ssl handshake failed|invalid ssl certificate|too many requests|rate[ -]?limit(?:ed|ing)?|bad gateway|service unavailable|gateway timeout/iu.test(
      message,
    )
  );
}

function browserErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasUnavailableReason(error: unknown, reason: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'reason' in error &&
    (error as { reason?: unknown }).reason === reason
  );
}
