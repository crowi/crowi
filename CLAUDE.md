# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crowi is a Markdown-based Wiki application built with TypeScript, Express.js, and MongoDB. It provides team knowledge sharing capabilities with features like timeline views, search functionality, and various integrations.

## Development Commands

### Setup and Run
```bash
# Install dependencies
npm install

# Run development server with auto-reload
npm run dev

# Run with Docker Compose (includes MongoDB, Redis, Elasticsearch, PlantUML)
docker-compose -f docker-compose.development.yml up
```

### Testing
```bash
# Run all tests
npm test

# Run server tests only
npm run test:server

# Run tests with coverage
npm run coverage
```

### Build and Type Checking
```bash
# Build for production
npm run build

# Type check without emitting files
npm run type-check

# Type check in watch mode
npm run type-check:watch
```

### Code Formatting
```bash
# Format all TypeScript and JavaScript files
npm run format
```

## Architecture Overview

### Server-Side Structure (TypeScript)
- **Entry Point**: `src/app.ts` - Express application initialization
- **Controllers** (`src/controllers/`): HTTP request handlers for pages, auth, admin, etc.
- **Models** (`src/models/`): Mongoose schemas for MongoDB (Page, User, Comment, etc.)
- **Routes** (`src/routes/`): Route definitions including API endpoints
- **Services** (`src/service/`): Business logic layer (search, notifications, config)
- **Middlewares** (`src/middlewares/`): Authentication, CSRF, admin checks
- **Events** (`src/events/`): Event-driven architecture for page updates, notifications

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