import { z } from '@hono/zod-openapi';

/**
 * Shared Zod schemas for AWS credentials used by both /admin/app (S3
 * uploads) and /admin/mail (SES). Lifted from per-section duplicates;
 * the underscore prefix keeps the file out of public re-exports unless
 * a specific schema is named in `packages/api-contract/src/index.ts`.
 */

/**
 * AWS region — matches the legacy express-form regex (e.g. `ap-northeast-1`).
 * Empty string is allowed so the operator can clear the field; if non-empty
 * it must match the AWS region naming convention.
 */
export const AwsRegionSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/.test(v), {
    message: 'Must be a valid AWS region name (e.g. ap-northeast-1)',
  });

/**
 * Access Key ID — alphanumeric only, matches the legacy form. Empty allowed.
 * Real AWS keys are 16-128 chars, but legacy did not enforce the length so
 * we keep it loose.
 */
export const AwsAccessKeyIdSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[\dA-Za-z]+$/.test(v), {
    message: 'Access Key ID must be alphanumeric',
  });
