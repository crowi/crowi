# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crowi is a Markdown-based Wiki application built with TypeScript, Express.js, and MongoDB. It provides team knowledge sharing capabilities with features like timeline views, search functionality, and various integrations.

**Current Status**: This project has been converted to a Turborepo monorepo structure. The server-side code is located in `apps/crowi-api` and a new Astro-based frontend has been added in `apps/crowi-web`.

## Monorepo Structure

```
crowi/
├── apps/
│   ├── crowi-api/          # Express.js API server
│   │   ├── src/            # TypeScript source code
│   │   │   └── routes/
│   │   │       └── ts-rest/ # New ts-rest route implementations
│   │   ├── views/          # HTML templates
│   │   ├── locales/        # i18n files
│   │   ├── public/         # Static assets
│   │   └── package.json    # API-specific dependencies
│   └── crowi-web/          # Astro frontend
│       ├── src/            # Astro components and pages
│       ├── public/         # Static assets
│       └── package.json    # Frontend dependencies
├── packages/               # Shared packages
│   └── api-contract/       # ts-rest API contracts and Zod schemas
│       ├── src/
│       │   ├── contracts/  # ts-rest contract definitions
│       │   └── schemas/    # Zod schema definitions
│       └── package.json
├── turbo.json             # Turborepo configuration
├── pnpm-workspace.yaml    # PNPM workspace configuration
└── package.json           # Root monorepo configuration
```

## Development Commands

### Setup and Run
```bash
# Install dependencies (root)
pnpm install

# Run development server with auto-reload
pnpm dev

# Run specific app
pnpm --filter @crowi/api dev

# Run frontend only
pnpm --filter @crowi/web dev

# Run both API and frontend
pnpm dev

# Run with Docker Compose (includes MongoDB, Redis, Elasticsearch, PlantUML)
docker-compose -f docker-compose.development.yml up
```

### Testing
```bash
# Run all tests across all apps
pnpm test

# Run server tests only
pnpm test:server

# Run tests for specific app
pnpm --filter @crowi/api test
```

### Build and Type Checking
```bash
# Build all apps
pnpm build

# Type check all apps
pnpm type-check

# Build specific app
pnpm --filter @crowi/api build
```

### Code Formatting
```bash
# Format all TypeScript and JavaScript files across monorepo
pnpm format
```

## Architecture Overview

### Server-Side Structure (apps/crowi-api)
- **Entry Point**: `apps/crowi-api/src/app.ts` - Express application initialization
- **Controllers** (`apps/crowi-api/src/controllers/`): HTTP request handlers for pages, auth, admin, etc.
- **Models** (`apps/crowi-api/src/models/`): Mongoose schemas for MongoDB (Page, User, Comment, etc.)
- **Routes** (`apps/crowi-api/src/routes/`): Route definitions including API endpoints
- **Services** (`apps/crowi-api/src/service/`): Business logic layer (search, notifications, config)
- **Middlewares** (`apps/crowi-api/src/middlewares/`): Authentication, CSRF, admin checks
- **Events** (`apps/crowi-api/src/events/`): Event-driven architecture for page updates, notifications

### Key Services
- **MongoDB**: Primary data store for wiki content
- **Redis**: Session storage and Socket.io adapter
- **Elasticsearch**: Full-text search functionality (optional)
- **File Upload**: Supports AWS S3, local storage, or none

### Authentication
- Local authentication with username/password
- OAuth providers: GitHub, Google
- Session-based authentication using Passport.js

### Environment Configuration
Key environment variables (see `.env.sample`):
- `MONGO_URI`: MongoDB connection string
- `REDIS_URL`: Redis connection (optional)
- `ELASTICSEARCH_URI`: Elasticsearch URL (optional)
- `PASSWORD_SEED`: Required for password hashing
- `FILE_UPLOAD`: Storage type (`aws`, `local`, `none`)

### Testing Strategy
- Jest for unit and integration tests
- Test files located alongside source files (`*.test.ts`)
- MongoDB Memory Server for database tests
- Supertest for API endpoint testing

## Debugging Memories

- Debug process: When debugging, always run `npm run dev` and carefully check for any errors that might occur during the development server startup

## Commit Message Guidelines

- Write commit comments following the Conventional Commits format

## Crowi 2.0 Development Strategy

For Crowi 2.0 development, we follow these guidelines:

### Phase 1: API Server Migration
- Remove React and view-related code, focusing on API server only
- Maintain compatibility with existing data in the API server
- Comment out or temporarily disable non-core peripheral features, re-enabling them during future development
- After removing unnecessary files, upgrade core dependency packages to their latest versions
- Aim for a TypeScript build that compiles successfully at this stage

### Phase 2: Monorepo & Frontend
- Convert to monorepo structure
- Create new web frontend app equivalent to the previous views

## Project Status and Todos

- Current project status: Migrated to Turborepo monorepo structure (v2.0 migration)
- Recently completed:
  - ✅ Converted to Turborepo monorepo
  - ✅ Moved server-side code to apps/crowi-api
  - ✅ Removed unused frontend dependencies
  - ✅ Updated TypeScript and build configurations
- Pending todos:
  - Complete server-side code migration to modern TypeScript
  - Add frontend code after server migration is complete
  - Implement more comprehensive test coverage
  - Optimize Elasticsearch integration
  - Review and update OAuth provider support
  - Enhance file upload functionality
  - Investigate performance improvements for large wiki instances

## TypeScript Guidelines

- Avoid using `any` type in new code
- When encountering `any` in existing code, gradually replace it with the most appropriate type
- Do not attempt to modify entire files or unrelated code at once to prevent unexpected issues

## API Migration to ts-rest (2025/01/13)

### Overview
We are migrating the existing Express.js API to use `ts-rest` with `zod` for type-safe API definitions and client generation. This migration is being done gradually to maintain backward compatibility.

### Current Progress
1. **Created `@crowi/api-contract` package** (packages/api-contract)
   - Contains all ts-rest contract definitions using Zod schemas
   - Built with tsup for both CJS and ESM output
   - Serves as single source of truth for API types
   - Includes common error schemas for standardized API responses

2. **Migrated Routes** (available at /api/v2 prefix):
   - ✅ GET /login - Display login page
   - ✅ POST /login - Process login
   - ✅ GET /register - Display registration page
   - ✅ POST /register - Process registration
   - ✅ GET /login/error/:reason - Display login errors
   - ✅ GET /installer - Get installer status
   - ✅ POST /installer/createAdmin - Create initial admin

3. **Updated Middleware for API-only Operation**:
   - ✅ `applicationInstalled` - Returns JSON error (503) instead of redirect
   - ✅ `loginRequired` - Returns JSON errors (401/403) instead of redirects
   - Error schemas defined in `packages/api-contract/src/schemas/common.ts`:
     - `ApplicationNotInstalledError` - HTTP 503
     - `AuthenticationRequiredError` - HTTP 401
     - `UserStatusError` - HTTP 403 (for registered/suspended/invited users)
     - `ThirdPartyAuthRequiredError` - HTTP 403

4. **Implementation Details**:
   - Routes defined in `apps/crowi-api/src/routes/ts-rest/`
   - Contracts defined in `packages/api-contract/src/contracts/`
   - Schemas defined in `packages/api-contract/src/schemas/`
   - Middleware now returns JSON errors with `redirectTo` field for client compatibility
   - Existing controllers wrapped to maintain compatibility

### Next Steps for Migration
1. **Update remaining middleware to return JSON errors**:
   - adminRequired
   - applicationNotInstalled
   - fileAccessRightOrLoginRequired
   - Other middleware that perform redirects

2. **Migrate remaining authentication routes**:
   - GET /login/google, GET /login/github
   - GET /login/invited, POST /login/activateInvited
   - GET /google/callback, GET /github/callback
   - GET /logout

3. **Migrate API routes** (/_api/*):
   - Start with simple GET endpoints
   - Then move to more complex POST/PUT/DELETE operations
   - Ensure proper request/response validation with Zod

4. **Migrate page routes**:
   - Page display and editing routes
   - Search functionality
   - User pages and bookmarks

5. **Enhance ts-rest integration**:
   - Move middleware logic into ts-rest handlers
   - Implement proper error handling with Zod validation
   - Add request/response transformers where needed
   - Generate TypeScript client from contracts

6. **Remove old Express routes** (after testing):
   - Once ts-rest routes are stable, remove old implementations
   - Update all internal API calls to use new endpoints
   - Update documentation

### Technical Notes
- ts-rest routes currently mounted under `/api/v2` to avoid conflicts
- Middleware applied using Express patterns (will migrate to ts-rest middleware)
- Response handling wraps existing controllers for compatibility
- All types validated using Zod schemas
- Build api-contract with: `pnpm --filter @crowi/api-contract build`

### Branch Information
- Working branch: `dev2-ts-rest`
- Main development branch: `dev2-2` (changed from `dev2`)
- CI/CD configured to run on: main, dev, dev2-2

## Development Memories

- pnpm format before push


# Migration Workflow

Migration tasks are executed through a subagent pipeline.

## Usage

```bash
# Execute migration task
/migrate {task-name}

# Individual subagent invocation
Use the migration-planner subagent to analyze: {feature}
Use the migration-implementer subagent to implement: {task-id}
Use the migration-reviewer subagent to review: {task-id}
Use the migration-committer subagent to commit: {task-id}
```

## Task Management

- Queue: `.migration-state/queue.json`
- Tasks: `.migration-state/tasks/{task-id}.json`
- Status: `PLANNED` → `REVIEW` → `APPROVED` → `COMMITTED` → `DONE`

## migration-committer Pre-commit Checklist

For detailed pre-commit checklist, see `.claude/agents/migration-committer.md`.

**Overview:**
- Detection of secrets and environment-specific files
- Detection of build artifacts
- Detection of temporary files and caches
- Warnings for large files
