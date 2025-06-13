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

#### Quick Start
```bash
# 1. Start MongoDB and Redis services
docker compose up -d

# 2. Copy and configure environment variables
cp .env.sample .env
# Edit .env to set appropriate values

# 3. Install dependencies (root)
pnpm install

# 4. Run development server with auto-reload
pnpm dev
```

The application will be available at http://localhost:3000

#### Docker Services
The `docker compose` configuration provides:
- **MongoDB 8**: Running on port 37017 (host) → 27017 (container)
- **Redis 7.4**: Running on port 16379 (host) → 6379 (container)

Note: Elasticsearch and PlantUML support has been postponed and removed from the Docker setup.

#### Running Individual Apps
```bash
# Run API server only
pnpm --filter @crowi/api dev

# Run frontend only (when available)
pnpm --filter @crowi/web dev

# Run both API and frontend
pnpm dev
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
- **MongoDB**: Primary data store for wiki content (Docker: port 37017)
- **Redis**: Session storage and Socket.io adapter (Docker: port 16379)
- **Elasticsearch**: Full-text search functionality (optional - currently postponed)
- **File Upload**: Supports AWS S3, local storage, or none

### Authentication
- Local authentication with username/password
- OAuth providers: GitHub, Google
- Session-based authentication using Passport.js

### Environment Configuration
Key environment variables (see `.env.sample`):
- `MONGO_URI`: MongoDB connection string (default: `mongodb://localhost:37017/crowi`)
- `REDIS_URL`: Redis connection (default: `redis://localhost:16379`)
- `ELASTICSEARCH_URI`: Elasticsearch URL (optional - currently disabled)
- `PASSWORD_SEED`: Required for password hashing
- `SECRET_TOKEN`: Required for session security
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

## Project Status and Todos

- Current project status: Migrated to Turborepo monorepo structure
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

2. **Migrated Routes** (available at /api/v2 prefix):
   - ✅ GET /login - Display login page
   - ✅ POST /login - Process login
   - ✅ GET /register - Display registration page
   - ✅ POST /register - Process registration
   - ✅ GET /login/error/:reason - Display login errors
   - ✅ GET /installer - Get installer status
   - ✅ POST /installer/createAdmin - Create initial admin

3. **Implementation Details**:
   - Routes defined in `apps/crowi-api/src/routes/ts-rest/`
   - Contracts defined in `packages/api-contract/src/contracts/`
   - Schemas defined in `packages/api-contract/src/schemas/`
   - Middleware still applied using Express patterns (to be migrated later)
   - Existing controllers wrapped to maintain compatibility

### Next Steps for Migration
1. **Migrate remaining authentication routes**:
   - GET /login/google, GET /login/github
   - GET /login/invited, POST /login/activateInvited
   - GET /google/callback, GET /github/callback
   - GET /logout

2. **Migrate API routes** (/_api/*):
   - Start with simple GET endpoints
   - Then move to more complex POST/PUT/DELETE operations
   - Ensure proper request/response validation with Zod

3. **Migrate page routes**:
   - Page display and editing routes
   - Search functionality
   - User pages and bookmarks

4. **Enhance ts-rest integration**:
   - Move middleware logic into ts-rest handlers
   - Implement proper error handling with Zod validation
   - Add request/response transformers where needed
   - Generate TypeScript client from contracts

5. **Remove old Express routes** (after testing):
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