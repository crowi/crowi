# TODO List

## High Priority

- [ ] Update remaining middleware to return JSON errors
  - [ ] adminRequired
  - [ ] applicationNotInstalled
  - [ ] fileAccessRightOrLoginRequired
  - [ ] Other middleware that perform redirects

- [ ] Migrate remaining authentication routes to ts-rest
  - GET /login/google, GET /login/github
  - GET /login/invited, POST /login/activateInvited
  - GET /google/callback, GET /github/callback
  - GET /logout

- [ ] Migrate API routes (/_api/*) to ts-rest
  - Start with simple GET endpoints
  - Then move to more complex POST/PUT/DELETE operations
  - Ensure proper request/response validation with Zod

## Medium Priority

- [ ] Migrate page routes to ts-rest
  - Page display and editing routes
  - Search functionality
  - User pages and bookmarks

- [ ] Enhance ts-rest integration (middleware, error handling)
  - Move middleware logic into ts-rest handlers
  - Implement proper error handling with Zod validation
  - Add request/response transformers where needed
  - Generate TypeScript client from contracts

- [ ] Complete server-side TypeScript modernization
  - Replace `any` types with proper types
  - Update legacy code patterns

## Low Priority

- [ ] Implement frontend in apps/crowi-web
  - Complete Astro-based frontend implementation
  - Connect to ts-rest API

- [ ] Improve test coverage
  - Add more unit tests
  - Enhance integration tests
  - Test ts-rest endpoints

- [ ] Remove old Express routes after ts-rest migration
  - Once ts-rest routes are stable, remove old implementations
  - Update all internal API calls to use new endpoints
  - Update documentation

## Recently Completed

- [x] Updated applicationInstalled middleware to return JSON errors (HTTP 503)
- [x] Updated loginRequired middleware to return JSON errors (HTTP 401/403)
- [x] Created common error schemas (ApiError, AuthenticationRequiredError, etc.)

## Notes

- Working branch: `dev2-ts-rest`
- ts-rest routes available at `/api/v2` prefix
- Build api-contract with: `pnpm --filter @crowi/api-contract build`
- Middleware now returns JSON errors instead of redirects for API-only operation