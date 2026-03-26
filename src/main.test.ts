/**
 * Tests for HTTP transport token validation.
 */

import { describe, expect, it } from 'vitest';

import { validateToken } from './main.js';

describe('validateToken', () => {
  const secret = 'my-secret-token-123';

  it('returns true when token query param matches', () => {
    expect(validateToken('/mcp?token=my-secret-token-123', secret)).toBe(true);
  });

  it('returns true when token is among multiple query params', () => {
    expect(validateToken('/mcp?foo=bar&token=my-secret-token-123&baz=1', secret)).toBe(true);
  });

  it('returns false when token does not match', () => {
    expect(validateToken('/mcp?token=wrong-token', secret)).toBe(false);
  });

  it('returns false when token param is missing', () => {
    expect(validateToken('/mcp', secret)).toBe(false);
  });

  it('returns false when token param is empty', () => {
    expect(validateToken('/mcp?token=', secret)).toBe(false);
  });

  it('returns false when url is undefined', () => {
    expect(validateToken(undefined, secret)).toBe(false);
  });

  it('returns false when token has different length', () => {
    expect(validateToken('/mcp?token=short', secret)).toBe(false);
  });

  it('handles URL-encoded tokens', () => {
    const tokenWithSpecial = 'token/with+special=chars';
    const encoded = encodeURIComponent(tokenWithSpecial);
    expect(validateToken(`/mcp?token=${encoded}`, tokenWithSpecial)).toBe(true);
  });
});
