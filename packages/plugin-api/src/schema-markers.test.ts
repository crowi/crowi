import { z } from 'zod/v3';
import { getActionAnnotation, isSensitiveField } from './schema-markers';

describe('isSensitiveField', () => {
  it('returns true for a field described with the @sensitive marker', () => {
    const field = z.string().describe('@sensitive AWS secret access key');
    expect(isSensitiveField(field)).toBe(true);
  });

  it('tolerates leading whitespace before the marker', () => {
    const field = z.string().describe('  @sensitive leading-whitespace tolerated');
    expect(isSensitiveField(field)).toBe(true);
  });

  it('returns false for a plain description', () => {
    const field = z.string().describe('Bot User OAuth token (xoxb-…)');
    expect(isSensitiveField(field)).toBe(false);
  });

  it('returns false when there is no description', () => {
    const field = z.string();
    expect(isSensitiveField(field)).toBe(false);
  });
});

describe('getActionAnnotation', () => {
  it('parses a GET action annotation', () => {
    const field = z.string().describe('@action "Test connection" GET /test');
    expect(getActionAnnotation(field)).toEqual({ label: 'Test connection', method: 'GET', path: '/test' });
  });

  it('parses a POST action annotation', () => {
    const field = z.string().describe('@action "Generate Slack App manifest" POST /manifest');
    expect(getActionAnnotation(field)).toEqual({ label: 'Generate Slack App manifest', method: 'POST', path: '/manifest' });
  });

  it('returns null when there is no @action marker', () => {
    const field = z.string().describe('Just a plain description');
    expect(getActionAnnotation(field)).toBeNull();
  });

  it('returns null when there is no description at all', () => {
    const field = z.string();
    expect(getActionAnnotation(field)).toBeNull();
  });

  it('returns null for a PUT verb — PluginRouteMethod only supports GET/POST', () => {
    const field = z.string().describe('@action "Update resource" PUT /resource');
    expect(getActionAnnotation(field)).toBeNull();
  });

  it('returns null for a DELETE verb — PluginRouteMethod only supports GET/POST', () => {
    const field = z.string().describe('@action "Delete resource" DELETE /resource');
    expect(getActionAnnotation(field)).toBeNull();
  });

  it('returns null for a malformed annotation missing the quoted label', () => {
    const field = z.string().describe('@action GET /test');
    expect(getActionAnnotation(field)).toBeNull();
  });
});
