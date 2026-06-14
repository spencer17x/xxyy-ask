import { describe, expect, it } from 'vitest';

import {
  isBrowserTimeoutError,
  isTransientBrowserNetworkError,
  isTransientBrowserProviderMessage,
} from './browser-errors.js';

describe('browser error classification', () => {
  it('treats offline browser network messages as transient provider errors', () => {
    expect(isTransientBrowserNetworkError(new Error('page.goto: ERR_INTERNET_DISCONNECTED'))).toBe(
      true,
    );
    expect(
      isTransientBrowserProviderMessage('NetworkError when attempting to fetch resource.'),
    ).toBe(true);
    expect(
      isTransientBrowserProviderMessage('The Internet connection appears to be offline.'),
    ).toBe(true);
  });

  it('treats bare Chrome navigation network errors as transient provider errors', () => {
    expect(isTransientBrowserNetworkError('page.goto: ERR_CONNECTION_ABORTED')).toBe(true);
    expect(isTransientBrowserNetworkError('page.goto: ERR_ADDRESS_UNREACHABLE')).toBe(true);
    expect(isTransientBrowserProviderMessage('page.goto: ERR_NETWORK_ACCESS_DENIED')).toBe(true);
    expect(isTransientBrowserProviderMessage('page.goto: ERR_NETWORK_IO_SUSPENDED')).toBe(true);
  });

  it('treats bare Chrome protocol and invalid response errors as transient provider errors', () => {
    expect(isTransientBrowserProviderMessage('page.goto: ERR_QUIC_PROTOCOL_ERROR')).toBe(true);
    expect(isTransientBrowserProviderMessage('page.goto: ERR_HTTP_RESPONSE_CODE_FAILURE')).toBe(
      true,
    );
    expect(isTransientBrowserProviderMessage('page.goto: ERR_INVALID_RESPONSE')).toBe(true);
    expect(isTransientBrowserProviderMessage('page.goto: ERR_FAILED')).toBe(true);
  });

  it('treats undici timeout codes as browser provider timeouts', () => {
    expect(
      isBrowserTimeoutError(
        'TypeError: fetch failed: ConnectTimeoutError code: UND_ERR_CONNECT_TIMEOUT',
      ),
    ).toBe(true);
    expect(isBrowserTimeoutError('HeadersTimeoutError code: UND_ERR_HEADERS_TIMEOUT')).toBe(true);
    expect(isBrowserTimeoutError('BodyTimeoutError code: UND_ERR_BODY_TIMEOUT')).toBe(true);
  });

  it('treats undici socket failures as transient provider errors', () => {
    expect(
      isTransientBrowserProviderMessage(
        'TypeError: fetch failed: SocketError: other side closed code: UND_ERR_SOCKET',
      ),
    ).toBe(true);
    expect(isTransientBrowserProviderMessage('write EPIPE while fetching XXYY trades')).toBe(true);
    expect(isTransientBrowserProviderMessage('connect EHOSTUNREACH 203.0.113.1:443')).toBe(true);
    expect(isTransientBrowserProviderMessage('connect ENETUNREACH 203.0.113.1:443')).toBe(true);
  });
});
