# Commonfield

A collaborative whiteboard for teams and facilitated workshops, built with an AI-Driven Development Life Cycle (AI-DLC).

## Project direction

The project is being developed in sequential iterations:

1. Team collaboration and shared whiteboards.
2. Facilitator-led workshops.
3. Public self-service.

Each iteration is subject to testing and acceptance before the next begins. The current implementation work is focused on Unit 1.

## Technical direction

- **Language:** TypeScript.
- **Frontend:** React and Vite.
- **Backend:** Fastify, including WebSocket support.
- **Database:** PostgreSQL.
- **Deployment topology:** one combined UI/backend service with a separate PostgreSQL service.
- **Verification tooling:** Vitest, Playwright, ESLint, TypeScript and Sonar.

## Development process

AI-DLC records requirements, design decisions, implementation work and review evidence. The existing native Penpot design is the canonical visual reference.

Implementation, supporting documentation and setup instructions will be added in subsequent pushes. This initial commit contains only the README; it is not a release or a claim that acceptance checks have passed.
