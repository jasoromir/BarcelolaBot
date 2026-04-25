# Barcelola WhatsApp Bot Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js + TypeScript WhatsApp automation bot for a Barcelona tour agency that broadcasts tour announcements to WhatsApp groups on a schedule (with open/close controls), sends real-time booking confirmation DMs driven by Wix webhooks, and is controllable through a minimal admin web UI.

**Architecture:** Single always-on Node process. Express HTTP layer hosts the admin UI and the Wix webhook. `node-cron` (Europe/Madrid) fires nightly (21:30) and morning (08:30) jobs. Static config (groups, tours, templates, allowlist, settings) lives in YAML in git; runtime state (event log, job history, webhook dedup, pending DMs, control flags) lives in SQLite (`better-sqlite3`). whatsapp-web.js is wrapped behind a thin adapter and mocked in tests. Module boundaries: `whatsapp/` + `wix/` are external adapters, `messaging/builder.ts` is pure, `jobs/` orchestrates, `persistence/` is the only SQLite caller.

**Tech Stack:** Node.js 20, TypeScript, Express, whatsapp-web.js, node-cron, better-sqlite3, winston, zod, js-yaml, vitest, tsx, bcrypt. Docker + Fly.io for production (Madrid region). Cloudflare Tunnel for local webhook dev.

**Spec:** [docs/superpowers/specs/2026-04-25-whatsapp-bot-redesign-design.md](../specs/2026-04-25-whatsapp-bot-redesign-design.md)

---

## File structure

This plan builds the project from scratch in a new subdirectory `app/` (leaving the existing `backend/` and `frontend/` trees untouched for reference until we're satisfied).

Files created, grouped by responsibility:

**Config loader & schemas** (Phase 2)
- `app/src/config/schemas.ts` — zod schemas for each YAML file
- `app/src/config/loader.ts` — load + validate + reload
- `app/config/groups.yaml`, `tours.yaml`, `templates.yaml`, `allowlist.yaml`, `settings.yaml` — real config (sample/placeholder values)

**Persistence** (Phase 3)
- `app/src/persistence/db.ts` — better-sqlite3 connection + migrations
- `app/src/persistence/eventLog.ts` — append + query events
- `app/src/persistence/jobHistory.ts` — job_runs CRUD
- `app/src/persistence/webhookDedup.ts` — processed_webhooks CRUD
- `app/src/persistence/pendingDms.ts` — queue of deferred DMs
- `app/src/persistence/controlState.ts` — pause/connection flags

**Logging** (Phase 3)
- `app/src/log/logger.ts` — winston (console + rotating file + SQLite sink)

**Control state** (Phase 4)
- `app/src/control/state.ts` — in-memory mirror of controlState
- `app/src/control/commands.ts` — pause/resume/connect/disconnect commands

**WhatsApp adapter** (Phase 5)
- `app/src/whatsapp/types.ts` — domain types (WhatsAppState, GroupHandle, etc.)
- `app/src/whatsapp/client.ts` — whatsapp-web.js wrapper
- `app/src/whatsapp/groupAdmin.ts` — close/open/verify-admin

**Wix adapter** (Phase 6)
- `app/src/wix/types.ts` — Tour, BookingEvent, etc.
- `app/src/wix/client.ts` — REST client (getToursForDate)
- `app/src/wix/webhookVerifier.ts` — signature + payload validation

**Messaging** (Phase 7)
- `app/src/messaging/phoneNormalizer.ts` — pure phone normalization
- `app/src/messaging/allowlistGate.ts` — pure allowlist check
- `app/src/messaging/builder.ts` — pure message composer
- `app/src/messaging/broadcaster.ts` — multi-group send + rate limit
- `app/src/messaging/directMessage.ts` — DM with allowlist gate + pending-queue fallback

**Jobs** (Phase 8)
- `app/src/jobs/runner.ts` — common wrapper (retry, dry-run, logging, job_runs)
- `app/src/jobs/nightlyJob.ts`
- `app/src/jobs/morningJob.ts`

**Webhook handler** (Phase 9)
- `app/src/webhook/bookingHandler.ts`

**HTTP layer + admin UI** (Phase 10)
- `app/src/http/server.ts` — Express app
- `app/src/http/auth.ts` — admin session middleware
- `app/src/http/adminRoutes.ts` — UI HTML + partial endpoints + action endpoints
- `app/src/http/webhookRoutes.ts` — POST /webhook/wix
- `app/web/admin.html` — single-page UI
- `app/web/admin.css`
- `app/web/admin.js`

**Scheduler + wiring** (Phase 11)
- `app/src/scheduler.ts` — node-cron bootstrap
- `app/src/index.ts` — wire everything, start up

**Deployment** (Phase 12)
- `app/Dockerfile`
- `app/fly.toml`
- `app/.dockerignore`

**Tests** — `app/tests/unit/*` and `app/tests/integration/*` as listed per task. Fixtures in `app/tests/fixtures/`.

---

## Phase 0 — Repo initialization

### Task 0.1: Initialize git and create `app/` subdirectory

**Files:**
- Create: `.gitignore` at repo root (only if not adequate already)
- Create: `app/` directory

- [ ] **Step 1: Initialize git at repo root (if not already)**

Run:
```bash
cd /workplace/jomedes/whatsapp_bot
git init 2>&1 | head -5
git status | head -5
```
Expected: either "Reinitialized existing Git repository" or "Initialized empty Git repository" + status output.

- [ ] **Step 2: Update `.gitignore` at repo root to cover the new `app/` tree**

Overwrite `/workplace/jomedes/whatsapp_bot/.gitignore` with:

```gitignore
# Node
node_modules/
npm-debug.log*
yarn-error.log*

# Env
.env
.env.local
.env.*.local

# Build
dist/
build/

# Runtime data (session, sqlite, logs)
app/data/
data/

# Editor
.vscode/
.idea/
*.swp
.DS_Store

# Old project trees (will delete later, ignore for now)
backend/node_modules/
frontend/node_modules/
backend/data/
```

- [ ] **Step 3: Create the `app/` subdirectory**

Run:
```bash
mkdir -p /workplace/jomedes/whatsapp_bot/app
ls /workplace/jomedes/whatsapp_bot/app
```
Expected: empty listing.

- [ ] **Step 4: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add .gitignore docs/
git commit -m "chore: add design doc and implementation plan; prepare app/ subdirectory"
```

---

### Task 0.2: Initialize Node project, TypeScript, vitest

**Files:**
- Create: `app/package.json`
- Create: `app/tsconfig.json`
- Create: `app/vitest.config.ts`
- Create: `app/.eslintrc.cjs`
- Create: `app/.prettierrc`
- Create: `app/src/index.ts` (stub)

- [ ] **Step 1: Initialize package.json**

Create `app/package.json`:

```json
{
  "name": "barcelola-whatsapp-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint 'src/**/*.ts' 'tests/**/*.ts'",
    "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.6",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "js-yaml": "^4.1.0",
    "node-cron": "^3.0.3",
    "qrcode": "^1.5.4",
    "whatsapp-web.js": "^1.23.0",
    "winston": "^3.14.2",
    "winston-daily-rotate-file": "^5.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/bcrypt": "^5.0.2",
    "@types/cookie-parser": "^1.4.7",
    "@types/express": "^4.17.21",
    "@types/express-session": "^1.18.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.14.10",
    "@types/node-cron": "^3.0.11",
    "@types/qrcode": "^1.5.5",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.3",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `app/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create .eslintrc.cjs**

Create `app/.eslintrc.cjs`:

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
```

- [ ] **Step 5: Create .prettierrc**

Create `app/.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 6: Create stub src/index.ts**

Create `app/src/index.ts`:

```typescript
console.log('Barcelola WhatsApp Bot — starting up');
```

- [ ] **Step 7: Install dependencies**

Run:
```bash
cd /workplace/jomedes/whatsapp_bot/app
npm install
```
Expected: installs without errors; `node_modules/` appears.

- [ ] **Step 8: Verify typecheck passes**

Run:
```bash
cd /workplace/jomedes/whatsapp_bot/app
npm run typecheck
```
Expected: no output, exit code 0.

- [ ] **Step 9: Verify vitest runs (no tests yet)**

Run:
```bash
cd /workplace/jomedes/whatsapp_bot/app
npm test 2>&1 | tail -5
```
Expected: "No test files found" or similar (exit code may be non-zero; that's fine for now).

- [ ] **Step 10: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/package.json app/package-lock.json app/tsconfig.json app/vitest.config.ts app/.eslintrc.cjs app/.prettierrc app/src/index.ts
git commit -m "chore(app): scaffold TypeScript project with vitest, eslint, prettier"
```

---

## Phase 1 — Domain types foundation

### Task 1.1: Core domain types

**Files:**
- Create: `app/src/types.ts`

- [ ] **Step 1: Create app/src/types.ts**

```typescript
// Domain types shared across modules. No I/O, no framework imports.

export type ISODateString = string; // e.g. "2026-04-25"
export type ISODateTime = string;   // e.g. "2026-04-25T19:30:00.000Z"

export interface Tour {
  id: string;                // must match a key in tours.yaml
  date: ISODateString;
  startTime: string;         // "HH:mm" local (Europe/Madrid)
  endTime: string;           // "HH:mm" local
  bookingCount: number;
}

export interface BookingEvent {
  bookingId: string;
  tourId: string;
  date: ISODateString;
  time: string;              // "HH:mm"
  clientName: string;
  phone: string;             // as received from Wix (not yet normalized)
}

export interface GroupRef {
  id: string;                // WhatsApp group id (ends in @g.us)
  name: string;              // human-readable
}

export type WhatsAppState =
  | { kind: 'disconnected' }
  | { kind: 'qr_pending'; qrDataUrl: string }
  | { kind: 'connected'; phone: string };

export type AutomationsState = 'running' | 'paused';

export type JobName = 'nightly' | 'morning';

export type JobStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';

export interface JobOutcome {
  jobName: JobName;
  status: JobStatus;
  toursCount: number;
  groupsSent: number;
  groupsClosed: number;
  dryRun: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/types.ts
git commit -m "feat(app): add core domain types"
```

---

## Phase 2 — Configuration (YAML + zod)

### Task 2.1: zod schemas

**Files:**
- Create: `app/src/config/schemas.ts`
- Create: `app/tests/unit/config.schemas.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/config.schemas.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  GroupsConfigSchema,
  ToursConfigSchema,
  TemplatesConfigSchema,
  AllowlistConfigSchema,
  SettingsConfigSchema,
} from '../../src/config/schemas';

describe('GroupsConfigSchema', () => {
  it('accepts valid groups', () => {
    const valid = {
      groups: [
        { id: '120363012345678901@g.us', name: 'Main', active: true },
      ],
    };
    expect(GroupsConfigSchema.parse(valid)).toEqual(valid);
  });

  it('rejects group id not ending in @g.us', () => {
    const bad = { groups: [{ id: '123', name: 'x', active: true }] };
    expect(() => GroupsConfigSchema.parse(bad)).toThrow();
  });
});

describe('ToursConfigSchema', () => {
  it('accepts tour with all required fields', () => {
    const valid = {
      tours: {
        'gaudi-modernista': {
          name_he: 'x',
          emoji: '🌻',
          description_he: 'desc',
          meeting_point_he: 'mp',
        },
      },
    };
    expect(ToursConfigSchema.parse(valid).tours['gaudi-modernista']?.emoji).toBe('🌻');
  });
});

describe('TemplatesConfigSchema', () => {
  it('requires all template fields', () => {
    const bad = { night_header: 'x' };
    expect(() => TemplatesConfigSchema.parse(bad)).toThrow();
  });
});

describe('AllowlistConfigSchema', () => {
  it('accepts explicit mode', () => {
    const v = { mode: 'explicit', explicit_phones: ['+972501234567'], rule: { country_codes: [] } };
    expect(AllowlistConfigSchema.parse(v).mode).toBe('explicit');
  });
  it('rejects phone without + prefix', () => {
    const v = { mode: 'explicit', explicit_phones: ['972501234567'], rule: { country_codes: [] } };
    expect(() => AllowlistConfigSchema.parse(v)).toThrow();
  });
});

describe('SettingsConfigSchema', () => {
  it('accepts valid settings', () => {
    const v = {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: '120@g.us', inter_message_delay_ms: 2000 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 3, backoff_ms: [60000, 300000, 900000] },
    };
    expect(SettingsConfigSchema.parse(v).broadcast.mode).toBe('test');
  });
});
```

- [ ] **Step 2: Run test (expect fail: module not found)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -10
```
Expected: errors resolving `../../src/config/schemas`.

- [ ] **Step 3: Create `app/src/config/schemas.ts`**

```typescript
import { z } from 'zod';

const GroupIdSchema = z.string().regex(/@g\.us$/, 'group id must end in @g.us');
const PhoneSchema = z.string().regex(/^\+\d{6,20}$/, 'phone must start with + and be digits');
const CronSchema = z.string().min(9);

export const GroupsConfigSchema = z.object({
  groups: z.array(
    z.object({
      id: GroupIdSchema,
      name: z.string().min(1),
      active: z.boolean(),
    }),
  ),
});
export type GroupsConfig = z.infer<typeof GroupsConfigSchema>;

export const ToursConfigSchema = z.object({
  tours: z.record(
    z.string(),
    z.object({
      name_he: z.string().min(1),
      emoji: z.string().min(1),
      description_he: z.string().min(1),
      meeting_point_he: z.string().min(1),
    }),
  ),
});
export type ToursConfig = z.infer<typeof ToursConfigSchema>;

export const TemplatesConfigSchema = z.object({
  night_header: z.string().min(1),
  morning_header: z.string().min(1),
  footer: z.string().min(1),
  tour_block: z.string().min(1),
  booking_confirmation: z.string().min(1),
});
export type TemplatesConfig = z.infer<typeof TemplatesConfigSchema>;

export const AllowlistConfigSchema = z.object({
  mode: z.enum(['explicit', 'rule', 'open']),
  explicit_phones: z.array(PhoneSchema),
  rule: z.object({
    country_codes: z.array(z.string().regex(/^\+\d+$/)),
  }),
});
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export const SettingsConfigSchema = z.object({
  timezone: z.string().min(1),
  schedule: z.object({
    nightly_cron: CronSchema,
    morning_cron: CronSchema,
  }),
  broadcast: z.object({
    mode: z.enum(['test', 'production']),
    test_group_id: GroupIdSchema,
    inter_message_delay_ms: z.number().int().nonnegative(),
  }),
  min_bookings_to_run: z.number().int().nonnegative(),
  retry: z.object({
    max_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().int().nonnegative()),
  }),
});
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/config/schemas.ts app/tests/unit/config.schemas.test.ts
git commit -m "feat(config): zod schemas for YAML config files"
```

---

### Task 2.2: Config loader

**Files:**
- Create: `app/src/config/loader.ts`
- Create: `app/tests/unit/config.loader.test.ts`
- Create: `app/tests/fixtures/config-valid/*.yaml`
- Create: `app/tests/fixtures/config-invalid/groups.yaml`

- [ ] **Step 1: Create valid fixture config files**

Create `app/tests/fixtures/config-valid/groups.yaml`:
```yaml
groups:
  - id: "120363012345678901@g.us"
    name: "Main"
    active: true
```

Create `app/tests/fixtures/config-valid/tours.yaml`:
```yaml
tours:
  gaudi-modernista:
    name_he: "tour"
    emoji: "🌻"
    description_he: "desc"
    meeting_point_he: "mp"
```

Create `app/tests/fixtures/config-valid/templates.yaml`:
```yaml
night_header: "night {date}"
morning_header: "morning {date}"
footer: "footer"
tour_block: "{emoji} {time_range} {name_he} {description_he} {meeting_point_he}"
booking_confirmation: "hi {client_name}"
```

Create `app/tests/fixtures/config-valid/allowlist.yaml`:
```yaml
mode: "explicit"
explicit_phones:
  - "+972501234567"
rule:
  country_codes: []
```

Create `app/tests/fixtures/config-valid/settings.yaml`:
```yaml
timezone: "Europe/Madrid"
schedule:
  nightly_cron: "30 21 * * *"
  morning_cron: "30 8 * * *"
broadcast:
  mode: "test"
  test_group_id: "120363099999999999@g.us"
  inter_message_delay_ms: 2000
min_bookings_to_run: 1
retry:
  max_attempts: 3
  backoff_ms: [60000, 300000, 900000]
```

Create `app/tests/fixtures/config-invalid/groups.yaml`:
```yaml
groups:
  - id: "not-a-group-id"
    name: "Bad"
    active: true
```

- [ ] **Step 2: Write failing test `app/tests/unit/config.loader.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader';
import path from 'node:path';

const validDir = path.resolve(__dirname, '../fixtures/config-valid');

describe('loadConfig', () => {
  it('loads and validates a valid config directory', () => {
    const cfg = loadConfig(validDir);
    expect(cfg.groups.groups).toHaveLength(1);
    expect(cfg.tours.tours['gaudi-modernista']?.emoji).toBe('🌻');
    expect(cfg.settings.broadcast.mode).toBe('test');
    expect(cfg.allowlist.mode).toBe('explicit');
    expect(cfg.templates.night_header).toContain('night');
  });

  it('throws when a required file is missing', () => {
    expect(() => loadConfig('/does/not/exist')).toThrow();
  });
});
```

- [ ] **Step 3: Run test (expect fail)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: fails — loader module not found.

- [ ] **Step 4: Create `app/src/config/loader.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  AllowlistConfig,
  AllowlistConfigSchema,
  GroupsConfig,
  GroupsConfigSchema,
  SettingsConfig,
  SettingsConfigSchema,
  TemplatesConfig,
  TemplatesConfigSchema,
  ToursConfig,
  ToursConfigSchema,
} from './schemas';
import { z } from 'zod';

export interface AppConfig {
  groups: GroupsConfig;
  tours: ToursConfig;
  templates: TemplatesConfig;
  allowlist: AllowlistConfig;
  settings: SettingsConfig;
}

function readYaml<T>(filePath: string, schema: z.ZodType<T>): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  try {
    return schema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid config at ${filePath}: ${(err as Error).message}`);
  }
}

export function loadConfig(configDir: string): AppConfig {
  const p = (name: string) => path.join(configDir, name);
  return {
    groups: readYaml(p('groups.yaml'), GroupsConfigSchema),
    tours: readYaml(p('tours.yaml'), ToursConfigSchema),
    templates: readYaml(p('templates.yaml'), TemplatesConfigSchema),
    allowlist: readYaml(p('allowlist.yaml'), AllowlistConfigSchema),
    settings: readYaml(p('settings.yaml'), SettingsConfigSchema),
  };
}
```

- [ ] **Step 5: Run test (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/config/loader.ts app/tests/unit/config.loader.test.ts app/tests/fixtures/
git commit -m "feat(config): YAML loader with zod validation"
```

---

### Task 2.3: Create real config files with placeholder values

**Files:**
- Create: `app/config/groups.yaml`
- Create: `app/config/tours.yaml`
- Create: `app/config/templates.yaml`
- Create: `app/config/allowlist.yaml`
- Create: `app/config/settings.yaml`

- [ ] **Step 1: Create `app/config/groups.yaml`**

```yaml
# Broadcast groups. Bot must be admin of each.
# User will replace with real group IDs during initial setup.
groups:
  - id: "120363099999999999@g.us"
    name: "Test Group (placeholder)"
    active: false
```

- [ ] **Step 2: Create `app/config/tours.yaml`**

```yaml
# Tour ID -> Hebrew description block.
# Tour IDs must match what Wix returns for that tour.
tours:
  gaudi-modernista:
    name_he: "המסע בעקבות גאודי והמודרניסטה"
    emoji: "🌻"
    description_he: |
      בסיור נלמד ונכיר את הקטלאני המפורסם מכולם, ה"משוגאון" של ברצלונה,
      האדריכל המוכשר - אנטוני גאודי ונראה מבנים יפיפים שלו בשדרת פסאג' דה גרסייה.
      את הסיור נסיים במפעל חייו של גאודי - הסגרדה פאמיליה.
    meeting_point_he: "10:15 בכניסה למסעדת הארד רוק קפה, פלאסה קטלוניה."
  born-to-be-wild:
    name_he: "כשאומנות וקולינריה נפגשים Born to be wild"
    emoji: "🌻"
    description_he: |
      סיור לשכונת בורן - טיול בשכונה הכי שיקית בעיר, בסמטאות היפות נראה גלריות,
      חנויות מעצבים, אמנים מקומיים ונטעם טאפסים ומטעמים מקומיים.
    meeting_point_he: "15:50 בכניסה למטרו Jaume I צמוד למלון Suizo"
```

- [ ] **Step 3: Create `app/config/templates.yaml`**

```yaml
night_header: |
  *לילה טוב לכל המטיילים והמטיילות האהובים מ- Barcelola Tours ✨🌜*

  ❤️ *לנמצאים בברצלונה - הצטרפו לסיורי ברצלולה, מחר {weekday_he} ה-{date}* ❤️

  *סיורים חינם על בסיס טיפ בתוך העיר*

morning_header: |
  *בוקר טוב לכל המטיילים והמטיילות ☀️*
  *היום {weekday_he} ה-{date} — הסיורים שיתקיימו:*

footer: |
  🌻 *למידע נוסף והרשמה לסיורים הכנסו לאתר שלנו:*
  https://www.barcelola-tours.com/barcelolatours

  🌻בואו גם ל *קבוצת הפייסבוק* שלנו!
  https://www.facebook.com/groups/barcelolatours/?ref=share

tour_block: |
  {emoji} {time_range}
  *{name_he}*
  {description_he}
  *נקודת ושעת מפגש* - {meeting_point_he}

booking_confirmation: |
  שלום {client_name}! 👋
  אישור הזמנתך לסיור *{tour_name_he}* בתאריך {date} בשעה {time}.
  נתראה! 🌻
```

- [ ] **Step 4: Create `app/config/allowlist.yaml`**

```yaml
mode: "explicit"
explicit_phones: []
rule:
  country_codes: []
```

- [ ] **Step 5: Create `app/config/settings.yaml`**

```yaml
timezone: "Europe/Madrid"
schedule:
  nightly_cron: "30 21 * * *"
  morning_cron: "30 8 * * *"
broadcast:
  mode: "test"
  test_group_id: "120363099999999999@g.us"
  inter_message_delay_ms: 2000
min_bookings_to_run: 1
retry:
  max_attempts: 3
  backoff_ms: [60000, 300000, 900000]
```

- [ ] **Step 6: Verify loader accepts the real config**

Create `app/tests/unit/config.real.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader';
import path from 'node:path';

describe('real config files', () => {
  it('loads without error', () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config'));
    expect(cfg.settings.timezone).toBe('Europe/Madrid');
  });
});
```

Run:
```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/config/ app/tests/unit/config.real.test.ts
git commit -m "feat(config): seed placeholder YAML config files"
```

---

## Phase 3 — Persistence + logging

### Task 3.1: SQLite database + migrations

**Files:**
- Create: `app/src/persistence/db.ts`
- Create: `app/tests/integration/db.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/db.test.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});

function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

describe('openDatabase', () => {
  it('creates all tables on fresh db', () => {
    const db = openDatabase(tmpDbPath());
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('events');
    expect(names).toContain('job_runs');
    expect(names).toContain('processed_webhooks');
    expect(names).toContain('pending_dms');
    expect(names).toContain('control_state');
    db.close();
  });

  it('is idempotent (re-open does not error)', () => {
    const p = tmpDbPath();
    openDatabase(p).close();
    const db = openDatabase(p);
    db.close();
  });

  it('seeds control_state defaults', () => {
    const db = openDatabase(tmpDbPath());
    const row = db
      .prepare("SELECT value FROM control_state WHERE key = 'automations_paused'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('false');
    db.close();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: fails — module not found.

- [ ] **Step 3: Create `app/src/persistence/db.ts`**

```typescript
import Database, { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     level TEXT NOT NULL,
     source TEXT NOT NULL,
     event_type TEXT NOT NULL,
     message TEXT NOT NULL,
     metadata TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`,
  `CREATE TABLE IF NOT EXISTS job_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_name TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     status TEXT NOT NULL,
     tours_count INTEGER,
     groups_sent INTEGER,
     groups_closed INTEGER,
     dry_run INTEGER DEFAULT 0,
     error TEXT,
     metadata TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS processed_webhooks (
     booking_id TEXT PRIMARY KEY,
     received_at TEXT NOT NULL,
     completed_at TEXT,
     outcome TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS pending_dms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     phone TEXT NOT NULL,
     body TEXT NOT NULL,
     booking_id TEXT,
     created_at TEXT NOT NULL,
     attempts INTEGER DEFAULT 0,
     last_error TEXT,
     status TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_dms_status ON pending_dms(status)`,
  `CREATE TABLE IF NOT EXISTS control_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

const SEEDS: Array<[string, string]> = [
  ['automations_paused', 'false'],
  ['last_connect_state', 'disconnected'],
];

export function openDatabase(dbPath: string): DB {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    for (const sql of MIGRATIONS) db.exec(sql);
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO control_state (key, value, updated_at) VALUES (?, ?, ?)',
    );
    for (const [k, v] of SEEDS) insert.run(k, v, now);
  })();
  return db;
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/persistence/db.ts app/tests/integration/db.test.ts
git commit -m "feat(persistence): sqlite database + idempotent migrations"
```

---

### Task 3.2: Event log, job history, webhook dedup, pending DMs, control state

**Files:**
- Create: `app/src/persistence/eventLog.ts`
- Create: `app/src/persistence/jobHistory.ts`
- Create: `app/src/persistence/webhookDedup.ts`
- Create: `app/src/persistence/pendingDms.ts`
- Create: `app/src/persistence/controlState.ts`
- Create: `app/tests/integration/persistence.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/persistence.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { JobHistory } from '../../src/persistence/jobHistory';
import { WebhookDedup } from '../../src/persistence/webhookDedup';
import { PendingDms } from '../../src/persistence/pendingDms';
import { ControlState } from '../../src/persistence/controlState';

function freshDb() {
  return openDatabase(
    path.join(os.tmpdir(), `wabot-p-${Date.now()}-${Math.random()}.sqlite`),
  );
}

describe('EventLog', () => {
  it('appends and lists events', () => {
    const log = new EventLog(freshDb());
    log.append({ level: 'info', source: 'test', eventType: 'hello', message: 'hi' });
    const rows = log.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('hi');
  });
});

describe('JobHistory', () => {
  it('starts + finishes a run', () => {
    const h = new JobHistory(freshDb());
    const id = h.start('nightly', { dryRun: false });
    h.finish(id, { status: 'success', toursCount: 2, groupsSent: 1, groupsClosed: 1 });
    const rows = h.recent(5);
    expect(rows[0]?.status).toBe('success');
  });
});

describe('WebhookDedup', () => {
  it('first insert returns true, second returns false', () => {
    const d = new WebhookDedup(freshDb());
    expect(d.tryClaim('b1')).toBe(true);
    expect(d.tryClaim('b1')).toBe(false);
    d.complete('b1', 'sent');
  });
});

describe('PendingDms', () => {
  it('enqueues and drains', () => {
    const q = new PendingDms(freshDb());
    q.enqueue({ phone: '+1', body: 'hi', bookingId: 'b1' });
    const items = q.pending();
    expect(items).toHaveLength(1);
    q.markSent(items[0]!.id);
    expect(q.pending()).toHaveLength(0);
  });
});

describe('ControlState', () => {
  it('reads defaults and writes', () => {
    const c = new ControlState(freshDb());
    expect(c.get('automations_paused')).toBe('false');
    c.set('automations_paused', 'true');
    expect(c.get('automations_paused')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: fail — modules not found.

- [ ] **Step 3: Create `app/src/persistence/eventLog.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';

export type LogLevel = 'info' | 'warn' | 'error';

export interface EventInput {
  level: LogLevel;
  source: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  event_type: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

export class EventLog {
  constructor(private readonly db: DB) {}

  append(evt: EventInput): void {
    this.db
      .prepare(
        `INSERT INTO events (ts, level, source, event_type, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        evt.level,
        evt.source,
        evt.eventType,
        evt.message,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
      );
  }

  recent(limit: number): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, source, event_type, message, metadata
         FROM events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<Omit<EventRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  since(sinceId: number, limit: number): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, source, event_type, message, metadata
         FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sinceId, limit) as Array<Omit<EventRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  pruneOlderThan(isoTs: string): number {
    return this.db.prepare('DELETE FROM events WHERE ts < ?').run(isoTs).changes;
  }
}
```

- [ ] **Step 4: Create `app/src/persistence/jobHistory.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';
import type { JobName, JobStatus } from '../types';

export interface JobRunRow {
  id: number;
  job_name: JobName;
  started_at: string;
  ended_at: string | null;
  status: JobStatus;
  tours_count: number | null;
  groups_sent: number | null;
  groups_closed: number | null;
  dry_run: 0 | 1;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

export interface FinishInput {
  status: JobStatus;
  toursCount?: number;
  groupsSent?: number;
  groupsClosed?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class JobHistory {
  constructor(private readonly db: DB) {}

  start(jobName: JobName, opts: { dryRun: boolean }): number {
    const info = this.db
      .prepare(
        `INSERT INTO job_runs (job_name, started_at, status, dry_run)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(jobName, new Date().toISOString(), opts.dryRun ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  finish(id: number, input: FinishInput): void {
    this.db
      .prepare(
        `UPDATE job_runs
         SET ended_at = ?, status = ?, tours_count = ?, groups_sent = ?, groups_closed = ?, error = ?, metadata = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        input.status,
        input.toursCount ?? null,
        input.groupsSent ?? null,
        input.groupsClosed ?? null,
        input.error ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        id,
      );
  }

  recent(limit: number): JobRunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM job_runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Omit<JobRunRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  markStaleRunning(olderThanIsoTs: string): number {
    return this.db
      .prepare(
        `UPDATE job_runs SET status = 'failed', ended_at = ?, error = 'process restart'
         WHERE status = 'running' AND started_at < ?`,
      )
      .run(new Date().toISOString(), olderThanIsoTs).changes;
  }
}
```

- [ ] **Step 5: Create `app/src/persistence/webhookDedup.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';

export type WebhookOutcome =
  | 'sent'
  | 'skipped_allowlist'
  | 'skipped_paused'
  | 'deferred'
  | 'failed';

export class WebhookDedup {
  constructor(private readonly db: DB) {}

  tryClaim(bookingId: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_webhooks (booking_id, received_at)
         VALUES (?, ?)`,
      )
      .run(bookingId, new Date().toISOString());
    return info.changes === 1;
  }

  complete(bookingId: string, outcome: WebhookOutcome): void {
    this.db
      .prepare(
        `UPDATE processed_webhooks SET completed_at = ?, outcome = ? WHERE booking_id = ?`,
      )
      .run(new Date().toISOString(), outcome, bookingId);
  }
}
```

- [ ] **Step 6: Create `app/src/persistence/pendingDms.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';

export interface EnqueueInput {
  phone: string;
  body: string;
  bookingId?: string;
}

export interface PendingDmRow {
  id: number;
  phone: string;
  body: string;
  booking_id: string | null;
  created_at: string;
  attempts: number;
  last_error: string | null;
  status: 'pending' | 'sent' | 'abandoned';
}

export class PendingDms {
  constructor(private readonly db: DB) {}

  enqueue(input: EnqueueInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO pending_dms (phone, body, booking_id, created_at, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(input.phone, input.body, input.bookingId ?? null, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  pending(): PendingDmRow[] {
    return this.db
      .prepare(`SELECT * FROM pending_dms WHERE status = 'pending' ORDER BY id ASC`)
      .all() as PendingDmRow[];
  }

  markSent(id: number): void {
    this.db.prepare(`UPDATE pending_dms SET status = 'sent' WHERE id = ?`).run(id);
  }

  recordFailure(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE pending_dms SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )
      .run(error, id);
  }

  markAbandoned(id: number): void {
    this.db.prepare(`UPDATE pending_dms SET status = 'abandoned' WHERE id = ?`).run(id);
  }
}
```

- [ ] **Step 7: Create `app/src/persistence/controlState.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';

export class ControlState {
  constructor(private readonly db: DB) {}

  get(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM control_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO control_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }
}
```

- [ ] **Step 8: Run tests (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/persistence/ app/tests/integration/persistence.test.ts
git commit -m "feat(persistence): event log, job history, dedup, pending DMs, control state"
```

---

### Task 3.3: Logger (winston → console + rotating file + SQLite sink)

**Files:**
- Create: `app/src/log/logger.ts`
- Create: `app/tests/unit/logger.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/logger.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { createLogger } from '../../src/log/logger';

describe('createLogger', () => {
  it('writes events to the SQLite sink', () => {
    const db = openDatabase(
      path.join(os.tmpdir(), `wabot-logger-${Date.now()}.sqlite`),
    );
    const eventLog = new EventLog(db);
    const log = createLogger({
      eventLog,
      logDir: path.join(os.tmpdir(), `wabot-logs-${Date.now()}`),
      consoleLevel: 'silent',
    });
    log.info({ source: 'test', eventType: 'hello', message: 'hi', metadata: { a: 1 } });
    const rows = eventLog.recent(5);
    expect(rows[0]?.event_type).toBe('hello');
    expect(rows[0]?.metadata).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: fail — logger module not found.

- [ ] **Step 3: Create `app/src/log/logger.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { EventLog, LogLevel } from '../persistence/eventLog';

export interface LogCall {
  source: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AppLogger {
  info(c: LogCall): void;
  warn(c: LogCall): void;
  error(c: LogCall): void;
}

export interface CreateLoggerOpts {
  eventLog: EventLog;
  logDir: string;
  consoleLevel?: 'info' | 'warn' | 'error' | 'silent';
}

export function createLogger(opts: CreateLoggerOpts): AppLogger {
  if (!fs.existsSync(opts.logDir)) fs.mkdirSync(opts.logDir, { recursive: true });

  const transports: winston.transport[] = [
    new DailyRotateFile({
      dirname: opts.logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      level: 'info',
    }),
  ];
  if (opts.consoleLevel !== 'silent') {
    transports.push(new winston.transports.Console({ level: opts.consoleLevel ?? 'info' }));
  }

  const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports,
  });

  const emit = (level: LogLevel, c: LogCall) => {
    winstonLogger.log({
      level: level === 'warn' ? 'warn' : level,
      message: c.message,
      source: c.source,
      eventType: c.eventType,
      metadata: c.metadata,
    });
    opts.eventLog.append({
      level,
      source: c.source,
      eventType: c.eventType,
      message: c.message,
      metadata: c.metadata,
    });
  };

  return {
    info: (c) => emit('info', c),
    warn: (c) => emit('warn', c),
    error: (c) => emit('error', c),
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/log/logger.ts app/tests/unit/logger.test.ts
git commit -m "feat(log): winston logger with console, rotating file, and sqlite sink"
```

---

## Phase 4 — Control state (pause/resume, connection flag)

### Task 4.1: Control state service

**Files:**
- Create: `app/src/control/state.ts`
- Create: `app/tests/unit/control.state.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/control.state.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { ControlState } from '../../src/persistence/controlState';
import { ControlStateService } from '../../src/control/state';

function svc() {
  const db = openDatabase(
    path.join(os.tmpdir(), `wabot-cs-${Date.now()}-${Math.random()}.sqlite`),
  );
  return new ControlStateService(new ControlState(db));
}

describe('ControlStateService', () => {
  it('defaults to running', () => {
    expect(svc().isPaused()).toBe(false);
  });

  it('pause() persists and returns', () => {
    const s = svc();
    s.pause();
    expect(s.isPaused()).toBe(true);
    s.resume();
    expect(s.isPaused()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: fail — module not found.

- [ ] **Step 3: Create `app/src/control/state.ts`**

```typescript
import type { ControlState } from '../persistence/controlState';

const KEY_PAUSED = 'automations_paused';

export class ControlStateService {
  constructor(private readonly store: ControlState) {}

  isPaused(): boolean {
    return this.store.get(KEY_PAUSED) === 'true';
  }

  pause(): void {
    this.store.set(KEY_PAUSED, 'true');
  }

  resume(): void {
    this.store.set(KEY_PAUSED, 'false');
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/control/state.ts app/tests/unit/control.state.test.ts
git commit -m "feat(control): pause/resume state service"
```

---

## Phase 5 — WhatsApp adapter

### Task 5.1: WhatsApp client wrapper (thin, event-emitter shaped)

**Files:**
- Create: `app/src/whatsapp/types.ts`
- Create: `app/src/whatsapp/client.ts`

This is the only module that imports `whatsapp-web.js`. Keep the surface narrow so the rest of the codebase can mock it easily.

- [ ] **Step 1: Create `app/src/whatsapp/types.ts`**

```typescript
import type { WhatsAppState } from '../types';

export interface SendResult {
  messageId: string;
}

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): WhatsAppState;
  onStateChange(cb: (s: WhatsAppState) => void): void;

  sendToGroup(groupId: string, body: string): Promise<SendResult>;
  sendDirect(phoneE164: string, body: string): Promise<SendResult>;

  isGroupAdmin(groupId: string): Promise<boolean>;
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;
}
```

- [ ] **Step 2: Create `app/src/whatsapp/client.ts`**

```typescript
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import type { WhatsAppState } from '../types';
import type { SendResult, WhatsAppClient } from './types';

const { Client, LocalAuth } = pkg;

export interface WhatsAppClientOpts {
  sessionDir: string;
  onQr?: (dataUrl: string) => void;
}

type Listener = (s: WhatsAppState) => void;

export function createWhatsAppClient(opts: WhatsAppClientOpts): WhatsAppClient {
  const listeners: Listener[] = [];
  let current: WhatsAppState = { kind: 'disconnected' };
  const setState = (s: WhatsAppState) => {
    current = s;
    for (const l of listeners) l(s);
  };

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: opts.sessionDir }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', async (qr: string) => {
    const dataUrl = await QRCode.toDataURL(qr);
    opts.onQr?.(dataUrl);
    setState({ kind: 'qr_pending', qrDataUrl: dataUrl });
  });
  client.on('ready', () => {
    const phone = client.info?.wid?.user ? `+${client.info.wid.user}` : 'unknown';
    setState({ kind: 'connected', phone });
  });
  client.on('disconnected', () => setState({ kind: 'disconnected' }));
  client.on('auth_failure', () => setState({ kind: 'disconnected' }));

  async function sendToGroup(groupId: string, body: string): Promise<SendResult> {
    const msg = await client.sendMessage(groupId, body);
    return { messageId: msg.id._serialized };
  }

  async function sendDirect(phoneE164: string, body: string): Promise<SendResult> {
    const digits = phoneE164.replace(/^\+/, '');
    const chatId = `${digits}@c.us`;
    const msg = await client.sendMessage(chatId, body);
    return { messageId: msg.id._serialized };
  }

  async function isGroupAdmin(groupId: string): Promise<boolean> {
    const chat = await client.getChatById(groupId);
    // whatsapp-web.js groups expose `participants` with `isAdmin` flag
    // Bot's own id is in client.info.wid._serialized
    const selfId = client.info?.wid?._serialized;
    if (!selfId) return false;
    const participants = (chat as unknown as { participants?: Array<{ id: { _serialized: string }; isAdmin: boolean }> })
      .participants ?? [];
    return participants.some((p) => p.id._serialized === selfId && p.isAdmin);
  }

  async function setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const chat = await client.getChatById(groupId);
    // whatsapp-web.js group chat exposes setMessagesAdminsOnly()
    await (chat as unknown as { setMessagesAdminsOnly: (v: boolean) => Promise<void> })
      .setMessagesAdminsOnly(adminsOnly);
  }

  return {
    async start(): Promise<void> {
      if (current.kind === 'connected' || current.kind === 'qr_pending') return;
      await client.initialize();
    },
    async stop(): Promise<void> {
      await client.destroy();
      setState({ kind: 'disconnected' });
    },
    state: () => current,
    onStateChange: (cb) => listeners.push(cb),
    sendToGroup,
    sendDirect,
    isGroupAdmin,
    setGroupMessagesAdminsOnly,
  };
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/whatsapp/
git commit -m "feat(whatsapp): client wrapper over whatsapp-web.js with typed interface"
```

**Note:** this module is not unit-tested (thin wrapper over external lib). All downstream code depends only on the `WhatsAppClient` interface and mocks it in tests.

---

### Task 5.2: Group admin service (close/open/verify-admin)

**Files:**
- Create: `app/src/whatsapp/groupAdmin.ts`
- Create: `app/tests/unit/groupAdmin.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GroupAdminService } from '../../src/whatsapp/groupAdmin';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';

function fakeClient(overrides?: Partial<WhatsAppClient>): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('GroupAdminService.verifyAdminAll', () => {
  it('returns admin groups and non-admin groups', async () => {
    const c = fakeClient({
      isGroupAdmin: vi.fn(async (id: string) => id === 'g1@g.us'),
    });
    const svc = new GroupAdminService(c);
    const result = await svc.verifyAdminAll(['g1@g.us', 'g2@g.us']);
    expect(result.admin).toEqual(['g1@g.us']);
    expect(result.notAdmin).toEqual(['g2@g.us']);
  });
});

describe('GroupAdminService.closeAll', () => {
  it('calls setGroupMessagesAdminsOnly(true) per group', async () => {
    const fn = vi.fn(async () => {});
    const c = fakeClient({ setGroupMessagesAdminsOnly: fn });
    await new GroupAdminService(c).closeAll(['g1@g.us', 'g2@g.us']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'g1@g.us', true);
    expect(fn).toHaveBeenNthCalledWith(2, 'g2@g.us', true);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/whatsapp/groupAdmin.ts`**

```typescript
import type { WhatsAppClient } from './types';

export interface VerifyResult {
  admin: string[];
  notAdmin: string[];
}

export class GroupAdminService {
  constructor(private readonly client: WhatsAppClient) {}

  async verifyAdminAll(groupIds: string[]): Promise<VerifyResult> {
    const admin: string[] = [];
    const notAdmin: string[] = [];
    for (const id of groupIds) {
      if (await this.client.isGroupAdmin(id)) admin.push(id);
      else notAdmin.push(id);
    }
    return { admin, notAdmin };
  }

  async closeAll(groupIds: string[]): Promise<void> {
    for (const id of groupIds) {
      await this.client.setGroupMessagesAdminsOnly(id, true);
    }
  }

  async openAll(groupIds: string[]): Promise<void> {
    for (const id of groupIds) {
      await this.client.setGroupMessagesAdminsOnly(id, false);
    }
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/whatsapp/groupAdmin.ts app/tests/unit/groupAdmin.test.ts
git commit -m "feat(whatsapp): group admin service with admin check + close/open"
```

---

## Phase 6 — Wix adapter

### Task 6.1: Wix types and client (REST: getToursForDate)

**Files:**
- Create: `app/src/wix/types.ts`
- Create: `app/src/wix/client.ts`

Note: The exact Wix REST endpoint / payload shape depends on the Wix Bookings app setup. This task defines the **shape the rest of the code depends on** and a client that performs one HTTP call. The mapping between Wix raw payload and `Tour` will be finalized during the Wix integration step (Phase 13 end-to-end). For v1 the client uses Node's `fetch`.

- [ ] **Step 1: Create `app/src/wix/types.ts`**

```typescript
import type { Tour, BookingEvent } from '../types';

export type { Tour, BookingEvent };

export interface WixClient {
  getToursForDate(date: string): Promise<Tour[]>;
}
```

- [ ] **Step 2: Create `app/src/wix/client.ts`**

```typescript
import type { Tour } from '../types';
import type { WixClient } from './types';

export interface WixClientOpts {
  apiKey: string;
  siteId: string;           // Wix site ID
  baseUrl?: string;         // override for tests
  fetchFn?: typeof fetch;
}

interface WixBookingsApiResponse {
  sessions: Array<{
    session_id: string;
    service_id: string;
    start: string;   // ISO datetime
    end: string;
    total_participants: number;
  }>;
}

function toHHmm(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function toYYYYMMDD(iso: string, tz: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

export function createWixClient(opts: WixClientOpts): WixClient {
  const base = opts.baseUrl ?? 'https://www.wixapis.com';
  const fetchFn = opts.fetchFn ?? fetch;
  const tz = 'Europe/Madrid';

  return {
    async getToursForDate(date: string): Promise<Tour[]> {
      // Query sessions for a given date. Endpoint subject to verification at integration.
      const url = `${base}/bookings/v2/sessions/query`;
      const body = {
        query: {
          filter: {
            start: { $gte: `${date}T00:00:00.000Z`, $lt: `${date}T23:59:59.999Z` },
          },
        },
      };
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: opts.apiKey,
          'wix-site-id': opts.siteId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Wix sessions query failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as WixBookingsApiResponse;
      return data.sessions.map((s) => ({
        id: s.service_id,
        date: toYYYYMMDD(s.start, tz),
        startTime: toHHmm(s.start, tz),
        endTime: toHHmm(s.end, tz),
        bookingCount: s.total_participants,
      }));
    },
  };
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/wix/types.ts app/src/wix/client.ts
git commit -m "feat(wix): REST client for tour-session queries"
```

---

### Task 6.2: Webhook verifier + payload parser

**Files:**
- Create: `app/src/wix/webhookVerifier.ts`
- Create: `app/tests/unit/webhookVerifier.test.ts`
- Create: `app/tests/fixtures/wix/booking-webhook.json`

- [ ] **Step 1: Create the fixture `app/tests/fixtures/wix/booking-webhook.json`**

```json
{
  "id": "evt_001",
  "entityId": "booking_42",
  "eventType": "wix.bookings.v1.booking_confirmed",
  "data": {
    "booking": {
      "id": "booking_42",
      "serviceId": "gaudi-modernista",
      "startDate": "2026-04-26T08:30:00.000Z",
      "contactDetails": {
        "firstName": "Dana",
        "lastName": "Levi",
        "phone": "+972501234567"
      }
    }
  }
}
```

- [ ] **Step 2: Write failing test `app/tests/unit/webhookVerifier.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseBookingWebhook } from '../../src/wix/webhookVerifier';
import fixture from '../fixtures/wix/booking-webhook.json';

describe('parseBookingWebhook', () => {
  it('extracts BookingEvent from a valid payload', () => {
    const result = parseBookingWebhook(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.bookingId).toBe('booking_42');
    expect(result.event.tourId).toBe('gaudi-modernista');
    expect(result.event.phone).toBe('+972501234567');
    expect(result.event.clientName).toBe('Dana Levi');
    expect(result.event.date).toBe('2026-04-26');
    expect(result.event.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns error on malformed payload', () => {
    const result = parseBookingWebhook({ foo: 'bar' });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test (expect fail)**

- [ ] **Step 4: Create `app/src/wix/webhookVerifier.ts`**

```typescript
import { z } from 'zod';
import type { BookingEvent } from '../types';

const BookingWebhookSchema = z.object({
  entityId: z.string(),
  data: z.object({
    booking: z.object({
      id: z.string(),
      serviceId: z.string(),
      startDate: z.string(),
      contactDetails: z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string(),
      }),
    }),
  }),
});

export type ParseResult =
  | { ok: true; event: BookingEvent }
  | { ok: false; error: string };

function fmtDate(iso: string, tz = 'Europe/Madrid'): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string, tz = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function parseBookingWebhook(payload: unknown): ParseResult {
  const parsed = BookingWebhookSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const b = parsed.data.data.booking;
  const first = b.contactDetails.firstName ?? '';
  const last = b.contactDetails.lastName ?? '';
  return {
    ok: true,
    event: {
      bookingId: b.id,
      tourId: b.serviceId,
      phone: b.contactDetails.phone,
      clientName: [first, last].filter(Boolean).join(' ').trim() || 'Guest',
      date: fmtDate(b.startDate),
      time: fmtTime(b.startDate),
    },
  };
}

export interface SignatureVerifier {
  verify(rawBody: string, signatureHeader: string | undefined): boolean;
}

export function createSignatureVerifier(signingSecret: string): SignatureVerifier {
  // Wix signs webhooks; exact algorithm is documented per-webhook.
  // For v1 we do a simple shared-secret header check; swap to HMAC at integration time.
  return {
    verify(_rawBody, header) {
      return header === signingSecret;
    },
  };
}
```

Note on `vitest.config.ts`: fixture JSON import requires `resolveJsonModule: true`, which is already set in tsconfig. If vitest complains about `tests/fixtures/wix/booking-webhook.json`, add `resolve: { alias: {} }` isn't needed — the standard TS resolver handles it.

- [ ] **Step 5: Run test (expect pass)**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/wix/webhookVerifier.ts app/tests/unit/webhookVerifier.test.ts app/tests/fixtures/wix/booking-webhook.json
git commit -m "feat(wix): webhook payload parser + signature verifier stub"
```

---

## Phase 7 — Messaging (pure + adapters)

### Task 7.1: Phone normalizer

**Files:**
- Create: `app/src/messaging/phoneNormalizer.ts`
- Create: `app/tests/unit/phoneNormalizer.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/phoneNormalizer.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../../src/messaging/phoneNormalizer';

describe('normalizePhone', () => {
  it('passes through valid +CC format', () => {
    expect(normalizePhone('+972501234567')).toBe('+972501234567');
  });
  it('strips spaces and dashes', () => {
    expect(normalizePhone('+972 50-123 4567')).toBe('+972501234567');
  });
  it('adds + if missing but starts with country code digits', () => {
    expect(normalizePhone('972501234567', { defaultCountry: '+972' })).toBe('+972501234567');
  });
  it('prepends default country code for local numbers starting with 0', () => {
    expect(normalizePhone('0501234567', { defaultCountry: '+972' })).toBe('+972501234567');
  });
  it('returns null on garbage input', () => {
    expect(normalizePhone('abc')).toBeNull();
  });
  it('returns null on too-short number', () => {
    expect(normalizePhone('+12')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/phoneNormalizer.ts`**

```typescript
export interface NormalizeOpts {
  defaultCountry?: string; // e.g. "+34" or "+972"
}

export function normalizePhone(input: string, opts: NormalizeOpts = {}): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s\-()]/g, '');
  if (/^\+\d{6,20}$/.test(cleaned)) return cleaned;
  if (/^\d{6,20}$/.test(cleaned)) {
    if (opts.defaultCountry && cleaned.startsWith('0')) {
      return `${opts.defaultCountry}${cleaned.slice(1)}`;
    }
    if (opts.defaultCountry) {
      return `${opts.defaultCountry}${cleaned}`;
    }
    return `+${cleaned}`;
  }
  return null;
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/phoneNormalizer.ts app/tests/unit/phoneNormalizer.test.ts
git commit -m "feat(messaging): pure phone normalizer with international + local handling"
```

---

### Task 7.2: Allowlist gate

**Files:**
- Create: `app/src/messaging/allowlistGate.ts`
- Create: `app/tests/unit/allowlistGate.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { allowlistAllows } from '../../src/messaging/allowlistGate';
import type { AllowlistConfig } from '../../src/config/schemas';

const explicit: AllowlistConfig = {
  mode: 'explicit',
  explicit_phones: ['+972501234567'],
  rule: { country_codes: [] },
};

const rule: AllowlistConfig = {
  mode: 'rule',
  explicit_phones: [],
  rule: { country_codes: ['+972', '+34'] },
};

const open: AllowlistConfig = {
  mode: 'open',
  explicit_phones: [],
  rule: { country_codes: [] },
};

describe('allowlistAllows', () => {
  it('explicit: allows listed, denies others', () => {
    expect(allowlistAllows(explicit, '+972501234567')).toBe(true);
    expect(allowlistAllows(explicit, '+34600111222')).toBe(false);
  });
  it('rule: allows matching country code', () => {
    expect(allowlistAllows(rule, '+972501234567')).toBe(true);
    expect(allowlistAllows(rule, '+34600111222')).toBe(true);
    expect(allowlistAllows(rule, '+10000000000')).toBe(false);
  });
  it('open: allows all', () => {
    expect(allowlistAllows(open, '+10000000000')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/allowlistGate.ts`**

```typescript
import type { AllowlistConfig } from '../config/schemas';

export function allowlistAllows(cfg: AllowlistConfig, phoneE164: string): boolean {
  switch (cfg.mode) {
    case 'open':
      return true;
    case 'explicit':
      return cfg.explicit_phones.includes(phoneE164);
    case 'rule':
      return cfg.rule.country_codes.some((cc) => phoneE164.startsWith(cc));
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/allowlistGate.ts app/tests/unit/allowlistGate.test.ts
git commit -m "feat(messaging): pure allowlist gate (explicit/rule/open)"
```

---

### Task 7.3: Message builder (pure: tours + templates → Hebrew string)

**Files:**
- Create: `app/src/messaging/builder.ts`
- Create: `app/tests/unit/messageBuilder.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/messageBuilder.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildBroadcastMessage,
  buildBookingConfirmation,
} from '../../src/messaging/builder';
import type { ToursConfig, TemplatesConfig } from '../../src/config/schemas';

const tours: ToursConfig = {
  tours: {
    'gaudi-modernista': {
      name_he: 'גאודי',
      emoji: '🌻',
      description_he: 'תיאור',
      meeting_point_he: 'נקודת מפגש',
    },
  },
};

const templates: TemplatesConfig = {
  night_header: 'NIGHT {weekday_he} {date}',
  morning_header: 'MORNING {weekday_he} {date}',
  footer: 'FOOTER',
  tour_block: '{emoji} {time_range} | {name_he} | {description_he} | {meeting_point_he}',
  booking_confirmation: 'HI {client_name} / {tour_name_he} / {date} {time}',
};

describe('buildBroadcastMessage', () => {
  it('composes night message', () => {
    const out = buildBroadcastMessage({
      kind: 'night',
      date: '2026-04-26',
      tours: [
        { id: 'gaudi-modernista', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 3 },
      ],
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('NIGHT');
    expect(out).toContain('2026-04-26');
    expect(out).toContain('10:30-13:30');
    expect(out).toContain('גאודי');
    expect(out).toContain('FOOTER');
  });

  it('skips tours with no config entry and logs name', () => {
    const out = buildBroadcastMessage({
      kind: 'night',
      date: '2026-04-26',
      tours: [
        { id: 'unknown-tour', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 3 },
      ],
      toursConfig: tours,
      templates,
    });
    // unknown tour produces no tour block but header + footer still present
    expect(out).toContain('NIGHT');
    expect(out).toContain('FOOTER');
    expect(out).not.toContain('10:30-13:30');
  });
});

describe('buildBookingConfirmation', () => {
  it('interpolates booking fields', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'gaudi-modernista',
        date: '2026-04-26',
        time: '10:30',
        clientName: 'Dana',
        phone: '+972501234567',
      },
      toursConfig: tours,
      templates,
    });
    expect(out).toBe('HI Dana / גאודי / 2026-04-26 10:30');
  });

  it('falls back to tour id when no config entry', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'unknown',
        date: '2026-04-26',
        time: '10:30',
        clientName: 'Dana',
        phone: '+972501234567',
      },
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('unknown');
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/builder.ts`**

```typescript
import type { Tour, BookingEvent } from '../types';
import type { ToursConfig, TemplatesConfig } from '../config/schemas';

const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function weekdayHe(dateIso: string): string {
  // dateIso is YYYY-MM-DD (Europe/Madrid calendar date).
  const [y, m, d] = dateIso.split('-').map((n) => Number(n));
  // Construct date at local-midnight in UTC offset-free way: noon UTC avoids DST edge cases.
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0));
  return WEEKDAYS_HE[dt.getUTCDay()] ?? '';
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

export interface BroadcastInput {
  kind: 'night' | 'morning';
  date: string;
  tours: Tour[];
  toursConfig: ToursConfig;
  templates: TemplatesConfig;
}

export function buildBroadcastMessage(input: BroadcastInput): string {
  const header =
    input.kind === 'night' ? input.templates.night_header : input.templates.morning_header;
  const headerVars = { weekday_he: weekdayHe(input.date), date: input.date };
  const parts: string[] = [interpolate(header, headerVars)];

  const sorted = [...input.tours].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const t of sorted) {
    const cfg = input.toursConfig.tours[t.id];
    if (!cfg) continue;
    const block = interpolate(input.templates.tour_block, {
      emoji: cfg.emoji,
      time_range: `${t.startTime}-${t.endTime}`,
      name_he: cfg.name_he,
      description_he: cfg.description_he.trim(),
      meeting_point_he: cfg.meeting_point_he,
    });
    parts.push(block);
  }
  parts.push(input.templates.footer);
  return parts.join('\n\n');
}

export interface BookingConfirmationInput {
  event: BookingEvent;
  toursConfig: ToursConfig;
  templates: TemplatesConfig;
}

export function buildBookingConfirmation(input: BookingConfirmationInput): string {
  const cfg = input.toursConfig.tours[input.event.tourId];
  const tourName = cfg?.name_he ?? input.event.tourId;
  return interpolate(input.templates.booking_confirmation, {
    client_name: input.event.clientName,
    tour_name_he: tourName,
    date: input.event.date,
    time: input.event.time,
  });
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/builder.ts app/tests/unit/messageBuilder.test.ts
git commit -m "feat(messaging): pure message builder for broadcast + booking confirmation"
```

---

### Task 7.4: Retry helper

**Files:**
- Create: `app/src/messaging/retry.ts`
- Create: `app/tests/unit/retry.test.ts`

- [ ] **Step 1: Write failing test `app/tests/unit/retry.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { retry } from '../../src/messaging/retry';

describe('retry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn(async () => 42);
    const r = await retry(fn, { attempts: 3, backoffMs: [0, 0] });
    expect(r).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    let i = 0;
    const fn = vi.fn(async () => {
      i++;
      if (i < 2) throw new Error('boom');
      return 'ok';
    });
    const r = await retry(fn, { attempts: 3, backoffMs: [0, 0] });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(retry(fn, { attempts: 2, backoffMs: [0] })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/retry.ts`**

```typescript
export interface RetryOpts {
  attempts: number;
  backoffMs: number[]; // indexed by (attempt-1); backoffMs[i] slept after attempt i fails
  onAttemptFailure?: (err: unknown, attempt: number) => void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttemptFailure?.(err, i);
      if (i < opts.attempts) {
        const waitMs = opts.backoffMs[i - 1] ?? 0;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/retry.ts app/tests/unit/retry.test.ts
git commit -m "feat(messaging): generic retry helper with per-attempt backoff"
```

---

### Task 7.5: Broadcaster (multi-group send with rate limit + retry)

**Files:**
- Create: `app/src/messaging/broadcaster.ts`
- Create: `app/tests/unit/broadcaster.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Broadcaster, type BroadcastResult } from '../../src/messaging/broadcaster';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

describe('Broadcaster.send', () => {
  it('sends to each group in order and reports success counts', async () => {
    const client = fakeClient();
    const b = new Broadcaster(client, { interMessageDelayMs: 0, retry: { attempts: 1, backoffMs: [] } });
    const res: BroadcastResult = await b.send('hello', ['g1@g.us', 'g2@g.us']);
    expect(res.sent).toBe(2);
    expect(res.failed).toHaveLength(0);
    expect(client.sendToGroup).toHaveBeenCalledTimes(2);
  });

  it('records failures without aborting the batch', async () => {
    let i = 0;
    const client = fakeClient({
      sendToGroup: vi.fn(async () => {
        i++;
        if (i === 1) throw new Error('bad');
        return { messageId: 'x' };
      }),
    });
    const b = new Broadcaster(client, { interMessageDelayMs: 0, retry: { attempts: 1, backoffMs: [] } });
    const res = await b.send('hello', ['g1@g.us', 'g2@g.us']);
    expect(res.sent).toBe(1);
    expect(res.failed).toEqual([{ groupId: 'g1@g.us', error: 'bad' }]);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/broadcaster.ts`**

```typescript
import type { WhatsAppClient } from '../whatsapp/types';
import { retry, type RetryOpts } from './retry';

export interface BroadcastResult {
  sent: number;
  failed: Array<{ groupId: string; error: string }>;
}

export interface BroadcasterOpts {
  interMessageDelayMs: number;
  retry: RetryOpts;
}

export class Broadcaster {
  constructor(
    private readonly client: WhatsAppClient,
    private readonly opts: BroadcasterOpts,
  ) {}

  async send(body: string, groupIds: string[]): Promise<BroadcastResult> {
    const result: BroadcastResult = { sent: 0, failed: [] };
    for (let i = 0; i < groupIds.length; i++) {
      const id = groupIds[i]!;
      try {
        await retry(() => this.client.sendToGroup(id, body), this.opts.retry);
        result.sent += 1;
      } catch (err) {
        result.failed.push({ groupId: id, error: (err as Error).message });
      }
      if (i < groupIds.length - 1 && this.opts.interMessageDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.opts.interMessageDelayMs));
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/broadcaster.ts app/tests/unit/broadcaster.test.ts
git commit -m "feat(messaging): broadcaster with per-group retry and rate limit"
```

---

### Task 7.6: Direct message sender (with allowlist + pending-queue fallback)

**Files:**
- Create: `app/src/messaging/directMessage.ts`
- Create: `app/tests/integration/directMessage.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/directMessage.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { PendingDms } from '../../src/persistence/pendingDms';
import { DirectMessageSender } from '../../src/messaging/directMessage';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { AllowlistConfig } from '../../src/config/schemas';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

function freshQueue() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-dm-${Date.now()}-${Math.random()}.sqlite`));
  return new PendingDms(db);
}

const openCfg: AllowlistConfig = {
  mode: 'open',
  explicit_phones: [],
  rule: { country_codes: [] },
};
const explicitCfg: AllowlistConfig = {
  mode: 'explicit',
  explicit_phones: ['+972501234567'],
  rule: { country_codes: [] },
};

describe('DirectMessageSender.send', () => {
  it('sends when connected and allowlisted', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1', body: 'hi' });
    expect(r.outcome).toBe('sent');
    expect(client.sendDirect).toHaveBeenCalledOnce();
  });

  it('returns skipped_allowlist when phone not allowed', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => explicitCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1234567890', body: 'hi' });
    expect(r.outcome).toBe('skipped_allowlist');
    expect(client.sendDirect).not.toHaveBeenCalled();
  });

  it('enqueues when disconnected', async () => {
    const client = fakeClient({ state: () => ({ kind: 'disconnected' }) });
    const q = freshQueue();
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1', body: 'hi', bookingId: 'b1' });
    expect(r.outcome).toBe('deferred');
    expect(q.pending()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/messaging/directMessage.ts`**

```typescript
import type { WhatsAppClient } from '../whatsapp/types';
import type { PendingDms } from '../persistence/pendingDms';
import type { AllowlistConfig } from '../config/schemas';
import { allowlistAllows } from './allowlistGate';
import { retry, type RetryOpts } from './retry';

export type DmOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'skipped_allowlist' }
  | { outcome: 'skipped_paused' }
  | { outcome: 'deferred'; queueId: number }
  | { outcome: 'failed'; error: string };

export interface DirectMessageSenderOpts {
  client: WhatsAppClient;
  pendingDms: PendingDms;
  allowlist: () => AllowlistConfig;
  retry: RetryOpts;
  isPaused?: () => boolean;
}

export interface SendInput {
  phone: string;
  body: string;
  bookingId?: string;
}

export class DirectMessageSender {
  constructor(private readonly opts: DirectMessageSenderOpts) {}

  async send(input: SendInput): Promise<DmOutcome> {
    if (this.opts.isPaused?.()) {
      return { outcome: 'skipped_paused' };
    }
    if (!allowlistAllows(this.opts.allowlist(), input.phone)) {
      return { outcome: 'skipped_allowlist' };
    }
    const state = this.opts.client.state();
    if (state.kind !== 'connected') {
      const id = this.opts.pendingDms.enqueue({
        phone: input.phone,
        body: input.body,
        bookingId: input.bookingId,
      });
      return { outcome: 'deferred', queueId: id };
    }
    try {
      const r = await retry(
        () => this.opts.client.sendDirect(input.phone, input.body),
        this.opts.retry,
      );
      return { outcome: 'sent', messageId: r.messageId };
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message };
    }
  }

  async drainPending(): Promise<{ sent: number; failed: number; abandoned: number }> {
    const stats = { sent: 0, failed: 0, abandoned: 0 };
    const items = this.opts.pendingDms.pending();
    for (const item of items) {
      try {
        await retry(
          () => this.opts.client.sendDirect(item.phone, item.body),
          this.opts.retry,
        );
        this.opts.pendingDms.markSent(item.id);
        stats.sent += 1;
      } catch (err) {
        this.opts.pendingDms.recordFailure(item.id, (err as Error).message);
        if (item.attempts + 1 >= this.opts.retry.attempts * 3) {
          // after 3 full drain cycles, abandon
          this.opts.pendingDms.markAbandoned(item.id);
          stats.abandoned += 1;
        } else {
          stats.failed += 1;
        }
      }
    }
    return stats;
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/messaging/directMessage.ts app/tests/integration/directMessage.test.ts
git commit -m "feat(messaging): DirectMessageSender with allowlist gate and pending-DM fallback"
```

---

## Phase 8 — Jobs (nightly + morning)

### Task 8.1: Job runner (common wrapper)

**Files:**
- Create: `app/src/jobs/runner.ts`

- [ ] **Step 1: Create `app/src/jobs/runner.ts`**

```typescript
import type { JobHistory } from '../persistence/jobHistory';
import type { AppLogger } from '../log/logger';
import type { JobName, JobOutcome } from '../types';

export interface RunOpts {
  jobName: JobName;
  dryRun: boolean;
  history: JobHistory;
  logger: AppLogger;
  fn: (ctx: { jobRunId: number }) => Promise<Omit<JobOutcome, 'jobName' | 'dryRun'>>;
}

export async function runJob(opts: RunOpts): Promise<JobOutcome> {
  const id = opts.history.start(opts.jobName, { dryRun: opts.dryRun });
  opts.logger.info({
    source: 'jobs',
    eventType: `${opts.jobName}_start`,
    message: `${opts.jobName} job started (dryRun=${opts.dryRun})`,
    metadata: { jobRunId: id },
  });
  try {
    const partial = await opts.fn({ jobRunId: id });
    opts.history.finish(id, partial);
    opts.logger.info({
      source: 'jobs',
      eventType: `${opts.jobName}_end`,
      message: `${opts.jobName} job finished: ${partial.status}`,
      metadata: { jobRunId: id, ...partial },
    });
    return { jobName: opts.jobName, dryRun: opts.dryRun, ...partial };
  } catch (err) {
    const errMsg = (err as Error).message;
    opts.history.finish(id, {
      status: 'failed',
      toursCount: 0,
      groupsSent: 0,
      groupsClosed: 0,
      error: errMsg,
    });
    opts.logger.error({
      source: 'jobs',
      eventType: `${opts.jobName}_error`,
      message: errMsg,
      metadata: { jobRunId: id },
    });
    return {
      jobName: opts.jobName,
      dryRun: opts.dryRun,
      status: 'failed',
      toursCount: 0,
      groupsSent: 0,
      groupsClosed: 0,
      error: errMsg,
    };
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/jobs/runner.ts
git commit -m "feat(jobs): common runJob wrapper with history + logging"
```

---

### Task 8.2: Nightly job

**Files:**
- Create: `app/src/jobs/nightlyJob.ts`
- Create: `app/tests/integration/nightlyJob.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/nightlyJob.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { JobHistory } from '../../src/persistence/jobHistory';
import { createLogger } from '../../src/log/logger';
import { runNightlyJob } from '../../src/jobs/nightlyJob';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { WixClient } from '../../src/wix/types';
import type { AppConfig } from '../../src/config/loader';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

function fakeConfig(over?: Partial<AppConfig>): AppConfig {
  return {
    groups: { groups: [{ id: 'g1@g.us', name: 'Main', active: true }] },
    tours: {
      tours: {
        t1: { name_he: 'T1', emoji: '🌻', description_he: 'd', meeting_point_he: 'mp' },
      },
    },
    templates: {
      night_header: 'NIGHT {date}',
      morning_header: 'MORNING {date}',
      footer: 'FOOTER',
      tour_block: '{emoji} {time_range} {name_he}',
      booking_confirmation: 'HI',
    },
    allowlist: { mode: 'open', explicit_phones: [], rule: { country_codes: [] } },
    settings: {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: 'test@g.us', inter_message_delay_ms: 0 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 1, backoff_ms: [] },
    },
    ...over,
  };
}

function freshInfra() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-nj-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const history = new JobHistory(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-nj-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { db, eventLog, history, logger };
}

describe('runNightlyJob', () => {
  it('happy path: fetches tours, sends to test group, closes group', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const wix: WixClient = {
      getToursForDate: vi.fn(async () => [
        { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
      ]),
    };
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix,
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(result.toursCount).toBe(1);
    expect(result.groupsSent).toBe(1);
    expect(result.groupsClosed).toBe(1);
    expect(client.sendToGroup).toHaveBeenCalledWith('test@g.us', expect.stringContaining('NIGHT'));
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', true);
  });

  it('skips when paused', async () => {
    const { history, logger } = freshInfra();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: fakeClient(),
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => true,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('skipped');
  });

  it('0 tours -> no broadcast, still closes groups', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(result.groupsSent).toBe(0);
    expect(result.groupsClosed).toBe(1);
    expect(client.sendToGroup).not.toHaveBeenCalled();
  });

  it('dryRun does not send or close', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: {
        getToursForDate: vi.fn(async () => [
          { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
        ]),
      },
      history,
      logger,
      isPaused: () => false,
      dryRun: true,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.sendToGroup).not.toHaveBeenCalled();
    expect(client.setGroupMessagesAdminsOnly).not.toHaveBeenCalled();
    expect(result.metadata?.preview).toContain('NIGHT');
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/jobs/nightlyJob.ts`**

```typescript
import type { WhatsAppClient } from '../whatsapp/types';
import type { WixClient } from '../wix/types';
import type { JobHistory } from '../persistence/jobHistory';
import type { AppLogger } from '../log/logger';
import type { AppConfig } from '../config/loader';
import type { JobOutcome } from '../types';
import { GroupAdminService } from '../whatsapp/groupAdmin';
import { Broadcaster } from '../messaging/broadcaster';
import { buildBroadcastMessage } from '../messaging/builder';
import { runJob } from './runner';

export interface NightlyJobInput {
  config: AppConfig;
  whatsapp: WhatsAppClient;
  wix: WixClient;
  history: JobHistory;
  logger: AppLogger;
  isPaused: () => boolean;
  dryRun: boolean;
  now?: () => Date;
}

function tomorrowDateString(now: Date, tz: string): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(tomorrow);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function resolveTargets(cfg: AppConfig): string[] {
  if (cfg.settings.broadcast.mode === 'test') {
    return [cfg.settings.broadcast.test_group_id];
  }
  return cfg.groups.groups.filter((g) => g.active).map((g) => g.id);
}

export async function runNightlyJob(input: NightlyJobInput): Promise<JobOutcome> {
  const now = (input.now ?? (() => new Date()))();
  return runJob({
    jobName: 'nightly',
    dryRun: input.dryRun,
    history: input.history,
    logger: input.logger,
    fn: async () => {
      if (input.isPaused()) {
        return { status: 'skipped', toursCount: 0, groupsSent: 0, groupsClosed: 0 };
      }
      if (input.whatsapp.state().kind !== 'connected' && !input.dryRun) {
        return {
          status: 'failed',
          toursCount: 0,
          groupsSent: 0,
          groupsClosed: 0,
          error: 'whatsapp not connected',
        };
      }

      const date = tomorrowDateString(now, input.config.settings.timezone);
      const tours = await input.wix.getToursForDate(date);
      const eligible = tours.filter(
        (t) => t.bookingCount >= input.config.settings.min_bookings_to_run,
      );
      const targets = resolveTargets(input.config);

      const message = buildBroadcastMessage({
        kind: 'night',
        date,
        tours: eligible,
        toursConfig: input.config.tours,
        templates: input.config.templates,
      });

      if (input.dryRun) {
        return {
          status: 'success',
          toursCount: eligible.length,
          groupsSent: 0,
          groupsClosed: 0,
          metadata: { preview: message, targets },
        };
      }

      // Verify admin status before broadcast
      const groupAdmin = new GroupAdminService(input.whatsapp);
      const verified = await groupAdmin.verifyAdminAll(targets);
      if (verified.notAdmin.length > 0) {
        input.logger.warn({
          source: 'jobs',
          eventType: 'nightly_admin_missing',
          message: `bot is not admin of ${verified.notAdmin.length} groups`,
          metadata: { notAdmin: verified.notAdmin },
        });
      }

      let groupsSent = 0;
      if (eligible.length > 0 && verified.admin.length > 0) {
        const b = new Broadcaster(input.whatsapp, {
          interMessageDelayMs: input.config.settings.broadcast.inter_message_delay_ms,
          retry: {
            attempts: input.config.settings.retry.max_attempts,
            backoffMs: input.config.settings.retry.backoff_ms,
          },
        });
        const res = await b.send(message, verified.admin);
        groupsSent = res.sent;
      }

      // Close groups regardless of whether a message was sent
      let groupsClosed = 0;
      for (const id of verified.admin) {
        try {
          await input.whatsapp.setGroupMessagesAdminsOnly(id, true);
          groupsClosed += 1;
        } catch (err) {
          input.logger.error({
            source: 'jobs',
            eventType: 'nightly_close_failed',
            message: (err as Error).message,
            metadata: { groupId: id },
          });
        }
      }

      const status =
        verified.notAdmin.length > 0 ? 'partial' : 'success';
      return {
        status,
        toursCount: eligible.length,
        groupsSent,
        groupsClosed,
        metadata: { targets: verified.admin, skipped: verified.notAdmin },
      };
    },
  });
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/jobs/nightlyJob.ts app/tests/integration/nightlyJob.test.ts
git commit -m "feat(jobs): nightly job — fetch tours, broadcast, close groups"
```

---

### Task 8.3: Morning job

**Files:**
- Create: `app/src/jobs/morningJob.ts`
- Create: `app/tests/integration/morningJob.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/morningJob.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { JobHistory } from '../../src/persistence/jobHistory';
import { createLogger } from '../../src/log/logger';
import { runMorningJob } from '../../src/jobs/morningJob';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { WixClient } from '../../src/wix/types';
import type { AppConfig } from '../../src/config/loader';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

function fakeConfig(): AppConfig {
  return {
    groups: { groups: [{ id: 'g1@g.us', name: 'Main', active: true }] },
    tours: {
      tours: {
        t1: { name_he: 'T1', emoji: '🌻', description_he: 'd', meeting_point_he: 'mp' },
      },
    },
    templates: {
      night_header: 'NIGHT {date}',
      morning_header: 'MORNING {date}',
      footer: 'FOOTER',
      tour_block: '{emoji} {time_range} {name_he}',
      booking_confirmation: 'HI',
    },
    allowlist: { mode: 'open', explicit_phones: [], rule: { country_codes: [] } },
    settings: {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: 'test@g.us', inter_message_delay_ms: 0 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 1, backoff_ms: [] },
    },
  };
}

function freshInfra() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-mj-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const history = new JobHistory(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-mj-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { history, logger };
}

describe('runMorningJob', () => {
  it('opens groups and sends morning message', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const wix: WixClient = {
      getToursForDate: vi.fn(async () => [
        { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
      ]),
    };
    const result = await runMorningJob({
      config: fakeConfig(),
      whatsapp: client,
      wix,
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-26T07:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', false);
    expect(client.sendToGroup).toHaveBeenCalledWith('test@g.us', expect.stringContaining('MORNING'));
  });

  it('opens groups even when 0 tours', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runMorningJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-26T07:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', false);
    expect(client.sendToGroup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/jobs/morningJob.ts`**

```typescript
import type { WhatsAppClient } from '../whatsapp/types';
import type { WixClient } from '../wix/types';
import type { JobHistory } from '../persistence/jobHistory';
import type { AppLogger } from '../log/logger';
import type { AppConfig } from '../config/loader';
import type { JobOutcome } from '../types';
import { GroupAdminService } from '../whatsapp/groupAdmin';
import { Broadcaster } from '../messaging/broadcaster';
import { buildBroadcastMessage } from '../messaging/builder';
import { runJob } from './runner';

export interface MorningJobInput {
  config: AppConfig;
  whatsapp: WhatsAppClient;
  wix: WixClient;
  history: JobHistory;
  logger: AppLogger;
  isPaused: () => boolean;
  dryRun: boolean;
  now?: () => Date;
}

function todayDateString(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function resolveTargets(cfg: AppConfig): string[] {
  if (cfg.settings.broadcast.mode === 'test') {
    return [cfg.settings.broadcast.test_group_id];
  }
  return cfg.groups.groups.filter((g) => g.active).map((g) => g.id);
}

export async function runMorningJob(input: MorningJobInput): Promise<JobOutcome> {
  const now = (input.now ?? (() => new Date()))();
  return runJob({
    jobName: 'morning',
    dryRun: input.dryRun,
    history: input.history,
    logger: input.logger,
    fn: async () => {
      if (input.isPaused()) {
        return { status: 'skipped', toursCount: 0, groupsSent: 0, groupsClosed: 0 };
      }
      if (input.whatsapp.state().kind !== 'connected' && !input.dryRun) {
        return {
          status: 'failed',
          toursCount: 0,
          groupsSent: 0,
          groupsClosed: 0,
          error: 'whatsapp not connected',
        };
      }

      const date = todayDateString(now, input.config.settings.timezone);
      const targets = resolveTargets(input.config);

      const groupAdmin = new GroupAdminService(input.whatsapp);
      const verified = await groupAdmin.verifyAdminAll(targets);
      if (verified.notAdmin.length > 0) {
        input.logger.warn({
          source: 'jobs',
          eventType: 'morning_admin_missing',
          message: `bot is not admin of ${verified.notAdmin.length} groups`,
          metadata: { notAdmin: verified.notAdmin },
        });
      }

      let groupsOpened = 0;
      if (!input.dryRun) {
        for (const id of verified.admin) {
          try {
            await input.whatsapp.setGroupMessagesAdminsOnly(id, false);
            groupsOpened += 1;
          } catch (err) {
            input.logger.error({
              source: 'jobs',
              eventType: 'morning_open_failed',
              message: (err as Error).message,
              metadata: { groupId: id },
            });
          }
        }
      }

      const tours = await input.wix.getToursForDate(date);
      const eligible = tours.filter(
        (t) => t.bookingCount >= input.config.settings.min_bookings_to_run,
      );

      const message = buildBroadcastMessage({
        kind: 'morning',
        date,
        tours: eligible,
        toursConfig: input.config.tours,
        templates: input.config.templates,
      });

      if (input.dryRun) {
        return {
          status: 'success',
          toursCount: eligible.length,
          groupsSent: 0,
          groupsClosed: 0,
          metadata: { preview: message, targets },
        };
      }

      let groupsSent = 0;
      if (eligible.length > 0 && verified.admin.length > 0) {
        const b = new Broadcaster(input.whatsapp, {
          interMessageDelayMs: input.config.settings.broadcast.inter_message_delay_ms,
          retry: {
            attempts: input.config.settings.retry.max_attempts,
            backoffMs: input.config.settings.retry.backoff_ms,
          },
        });
        const res = await b.send(message, verified.admin);
        groupsSent = res.sent;
      }

      const status = verified.notAdmin.length > 0 ? 'partial' : 'success';
      return {
        status,
        toursCount: eligible.length,
        groupsSent,
        groupsClosed: groupsOpened, // "opened" reported in the closed field for now; UI labels it correctly
        metadata: { targets: verified.admin, skipped: verified.notAdmin },
      };
    },
  });
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/jobs/morningJob.ts app/tests/integration/morningJob.test.ts
git commit -m "feat(jobs): morning job — open groups then broadcast today's tours"
```

---

## Phase 9 — Webhook handler

### Task 9.1: Booking webhook handler

**Files:**
- Create: `app/src/webhook/bookingHandler.ts`
- Create: `app/tests/integration/bookingHandler.test.ts`

- [ ] **Step 1: Write failing test `app/tests/integration/bookingHandler.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { WebhookDedup } from '../../src/persistence/webhookDedup';
import { PendingDms } from '../../src/persistence/pendingDms';
import { EventLog } from '../../src/persistence/eventLog';
import { createLogger } from '../../src/log/logger';
import { DirectMessageSender } from '../../src/messaging/directMessage';
import { handleBookingWebhook } from '../../src/webhook/bookingHandler';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { AppConfig } from '../../src/config/loader';
import fixture from '../fixtures/wix/booking-webhook.json';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

function fakeConfig(mode: 'open' | 'explicit' = 'open'): AppConfig {
  return {
    groups: { groups: [] },
    tours: {
      tours: {
        'gaudi-modernista': {
          name_he: 'Gaudi', emoji: '🌻', description_he: 'd', meeting_point_he: 'mp',
        },
      },
    },
    templates: {
      night_header: 'N', morning_header: 'M', footer: 'F',
      tour_block: '{emoji} {time_range} {name_he}',
      booking_confirmation: 'HI {client_name} {tour_name_he}',
    },
    allowlist: {
      mode,
      explicit_phones: mode === 'explicit' ? ['+999999999'] : [],
      rule: { country_codes: [] },
    },
    settings: {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: 'test@g.us', inter_message_delay_ms: 0 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 1, backoff_ms: [] },
    },
  };
}

function freshInfra() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-wh-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const dedup = new WebhookDedup(db);
  const pending = new PendingDms(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-wh-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { dedup, pending, logger };
}

describe('handleBookingWebhook', () => {
  it('sends DM when allowlist open and connected', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: pending,
      allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture,
      config: fakeConfig('open'),
      dedup,
      sender,
      logger,
      isPaused: () => false,
    });
    expect(result.outcome).toBe('sent');
    expect(client.sendDirect).toHaveBeenCalled();
  });

  it('dedups on second call', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client, pendingDms: pending, allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const first = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    const second = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('duplicate');
    expect(client.sendDirect).toHaveBeenCalledTimes(1);
  });

  it('skips when not on allowlist', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client, pendingDms: pending,
      allowlist: () => fakeConfig('explicit').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('explicit'), dedup, sender, logger, isPaused: () => false,
    });
    expect(result.outcome).toBe('skipped_allowlist');
    expect(client.sendDirect).not.toHaveBeenCalled();
  });

  it('defers when disconnected', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient({ state: () => ({ kind: 'disconnected' }) });
    const sender = new DirectMessageSender({
      client, pendingDms: pending,
      allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    expect(result.outcome).toBe('deferred');
    expect(pending.pending()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

- [ ] **Step 3: Create `app/src/webhook/bookingHandler.ts`**

```typescript
import type { WebhookDedup } from '../persistence/webhookDedup';
import type { AppLogger } from '../log/logger';
import type { AppConfig } from '../config/loader';
import type { DirectMessageSender } from '../messaging/directMessage';
import { parseBookingWebhook } from '../wix/webhookVerifier';
import { buildBookingConfirmation } from '../messaging/builder';
import { normalizePhone } from '../messaging/phoneNormalizer';

export type HandlerOutcome =
  | { outcome: 'sent' }
  | { outcome: 'duplicate' }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'skipped_allowlist' }
  | { outcome: 'skipped_paused' }
  | { outcome: 'deferred' }
  | { outcome: 'failed'; error: string };

export interface HandleInput {
  payload: unknown;
  config: AppConfig;
  dedup: WebhookDedup;
  sender: DirectMessageSender;
  logger: AppLogger;
  isPaused: () => boolean;
}

export async function handleBookingWebhook(input: HandleInput): Promise<HandlerOutcome> {
  const parsed = parseBookingWebhook(input.payload);
  if (!parsed.ok) {
    input.logger.warn({
      source: 'webhook',
      eventType: 'booking_invalid',
      message: parsed.error,
    });
    return { outcome: 'invalid', error: parsed.error };
  }
  const event = parsed.event;

  if (!input.dedup.tryClaim(event.bookingId)) {
    input.logger.info({
      source: 'webhook',
      eventType: 'booking_duplicate',
      message: `duplicate booking ${event.bookingId}`,
    });
    return { outcome: 'duplicate' };
  }

  if (input.isPaused()) {
    input.dedup.complete(event.bookingId, 'skipped_paused');
    input.logger.info({
      source: 'webhook',
      eventType: 'booking_skipped_paused',
      message: `paused; not sending ${event.bookingId}`,
    });
    return { outcome: 'skipped_paused' };
  }

  const phone = normalizePhone(event.phone);
  if (!phone) {
    input.dedup.complete(event.bookingId, 'failed');
    input.logger.warn({
      source: 'webhook',
      eventType: 'booking_bad_phone',
      message: `cannot normalize phone: ${event.phone}`,
      metadata: { bookingId: event.bookingId },
    });
    return { outcome: 'failed', error: 'unparseable phone' };
  }

  const body = buildBookingConfirmation({
    event,
    toursConfig: input.config.tours,
    templates: input.config.templates,
  });

  const r = await input.sender.send({ phone, body, bookingId: event.bookingId });
  switch (r.outcome) {
    case 'sent':
      input.dedup.complete(event.bookingId, 'sent');
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_sent',
        message: `confirmation sent for ${event.bookingId}`,
        metadata: { phone, bookingId: event.bookingId },
      });
      return { outcome: 'sent' };
    case 'skipped_allowlist':
      input.dedup.complete(event.bookingId, 'skipped_allowlist');
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_skipped_allowlist',
        message: `${event.bookingId} not on allowlist`,
        metadata: { phone },
      });
      return { outcome: 'skipped_allowlist' };
    case 'skipped_paused':
      input.dedup.complete(event.bookingId, 'skipped_paused');
      return { outcome: 'skipped_paused' };
    case 'deferred':
      input.dedup.complete(event.bookingId, 'deferred');
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_deferred',
        message: `${event.bookingId} queued; WA disconnected`,
      });
      return { outcome: 'deferred' };
    case 'failed':
      input.dedup.complete(event.bookingId, 'failed');
      input.logger.error({
        source: 'webhook',
        eventType: 'booking_send_failed',
        message: r.error,
        metadata: { bookingId: event.bookingId },
      });
      return { outcome: 'failed', error: r.error };
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

- [ ] **Step 5: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/webhook/bookingHandler.ts app/tests/integration/bookingHandler.test.ts
git commit -m "feat(webhook): booking webhook handler with dedup + allowlist + defer-on-disconnect"
```

---

## Phase 10 — HTTP layer + admin UI

### Task 10.1: App container + Express server skeleton

**Files:**
- Create: `app/src/app.ts` — wires dependencies together into an `App` record
- Create: `app/src/http/server.ts`

- [ ] **Step 1: Create `app/src/app.ts`**

```typescript
import type { Database as DB } from 'better-sqlite3';
import type { AppConfig } from './config/loader';
import type { EventLog } from './persistence/eventLog';
import type { JobHistory } from './persistence/jobHistory';
import type { WebhookDedup } from './persistence/webhookDedup';
import type { PendingDms } from './persistence/pendingDms';
import type { ControlState } from './persistence/controlState';
import type { ControlStateService } from './control/state';
import type { WhatsAppClient } from './whatsapp/types';
import type { WixClient } from './wix/types';
import type { DirectMessageSender } from './messaging/directMessage';
import type { AppLogger } from './log/logger';

export interface App {
  db: DB;
  config: AppConfig;
  reloadConfig: () => void;

  eventLog: EventLog;
  jobHistory: JobHistory;
  webhookDedup: WebhookDedup;
  pendingDms: PendingDms;
  controlStateStore: ControlState;
  controlState: ControlStateService;

  whatsapp: WhatsAppClient;
  wix: WixClient;
  dmSender: DirectMessageSender;
  logger: AppLogger;

  lastQrDataUrl: string | null;
}
```

- [ ] **Step 2: Create `app/src/http/server.ts`**

```typescript
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import type { App } from '../app';
import { registerAdminRoutes } from './adminRoutes';
import { registerWebhookRoutes } from './webhookRoutes';

export function createHttpServer(app: App): Express {
  const exp = express();
  exp.use(express.json({ limit: '1mb' }));
  exp.use(cookieParser());

  exp.get('/healthz', (_req, res) => {
    const state = app.whatsapp.state();
    res.json({
      wa: state.kind,
      paused: app.controlState.isPaused(),
      uptime_s: Math.floor(process.uptime()),
    });
  });

  registerWebhookRoutes(exp, app);
  registerAdminRoutes(exp, app);
  return exp;
}
```

- [ ] **Step 3: Verify typecheck**

(Will fail because adminRoutes/webhookRoutes don't exist yet — we create them in next tasks.)

No commit yet; combine with next task.

---

### Task 10.2: Webhook route

**Files:**
- Create: `app/src/http/webhookRoutes.ts`

- [ ] **Step 1: Create `app/src/http/webhookRoutes.ts`**

```typescript
import type { Express } from 'express';
import type { App } from '../app';
import { handleBookingWebhook } from '../webhook/bookingHandler';

export function registerWebhookRoutes(exp: Express, app: App): void {
  exp.post('/webhook/wix', async (req, res) => {
    // Respond 200 quickly; process asynchronously. Dedup ensures Wix retries are safe.
    res.status(200).json({ received: true });
    try {
      await handleBookingWebhook({
        payload: req.body,
        config: app.config,
        dedup: app.webhookDedup,
        sender: app.dmSender,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
      });
    } catch (err) {
      app.logger.error({
        source: 'http',
        eventType: 'webhook_handler_crash',
        message: (err as Error).message,
      });
    }
  });
}
```

- [ ] **Step 2: Commit webhook route + server skeleton once adminRoutes exists (see next task).**

---

### Task 10.3: Admin authentication middleware

**Files:**
- Create: `app/src/http/auth.ts`

- [ ] **Step 1: Create `app/src/http/auth.ts`**

```typescript
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';

const COOKIE_NAME = 'wabot_admin';

export interface AuthOpts {
  passwordHash: string;
  cookieSecret: string;
}

function sign(value: string, secret: string): string {
  return Buffer.from(`${value}.${require('node:crypto').createHmac('sha256', secret).update(value).digest('hex')}`).toString('base64url');
}

function verify(signed: string, secret: string): string | null {
  try {
    const decoded = Buffer.from(signed, 'base64url').toString('utf8');
    const [value, sig] = decoded.split('.');
    if (!value || !sig) return null;
    const expected = require('node:crypto').createHmac('sha256', secret).update(value).digest('hex');
    if (expected !== sig) return null;
    return value;
  } catch {
    return null;
  }
}

export function createAuth(opts: AuthOpts) {
  async function login(password: string): Promise<string | null> {
    const ok = await bcrypt.compare(password, opts.passwordHash);
    if (!ok) return null;
    return sign(`admin:${Date.now()}`, opts.cookieSecret);
  }

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const cookie = (req as Request & { cookies: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (!cookie || !verify(cookie, opts.cookieSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  return { login, requireAuth, COOKIE_NAME };
}
```

- [ ] **Step 2: Verify typecheck (combined with next task)**

---

### Task 10.4: Admin routes

**Files:**
- Create: `app/src/http/adminRoutes.ts`

- [ ] **Step 1: Create `app/src/http/adminRoutes.ts`**

```typescript
import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { App } from '../app';
import { createAuth } from './auth';
import { runNightlyJob } from '../jobs/nightlyJob';
import { runMorningJob } from '../jobs/morningJob';
import { GroupAdminService } from '../whatsapp/groupAdmin';

export interface AdminConfig {
  passwordHash: string;
  cookieSecret: string;
  webDir: string; // absolute path to /web (admin.html + assets)
}

export function registerAdminRoutes(exp: Express, app: App, cfg?: AdminConfig): void {
  const effective: AdminConfig =
    cfg ?? {
      passwordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
      cookieSecret: process.env.SESSION_COOKIE_SECRET ?? 'dev-insecure',
      webDir: path.resolve(process.cwd(), 'web'),
    };
  const auth = createAuth(effective);

  // Serve static admin page
  exp.get('/admin', (_req: Request, res: Response) => {
    res.sendFile(path.join(effective.webDir, 'admin.html'));
  });
  exp.get('/admin/admin.js', (_req, res) => res.sendFile(path.join(effective.webDir, 'admin.js')));
  exp.get('/admin/admin.css', (_req, res) => res.sendFile(path.join(effective.webDir, 'admin.css')));

  // Login
  exp.post('/admin/login', async (req, res) => {
    const password = (req.body?.password as string) ?? '';
    const cookie = await auth.login(password);
    if (!cookie) {
      res.status(401).json({ error: 'bad password' });
      return;
    }
    res.cookie(auth.COOKIE_NAME, cookie, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ ok: true });
  });
  exp.post('/admin/logout', (_req, res) => {
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ ok: true });
  });

  // Everything below requires auth
  exp.use('/admin/api', auth.requireAuth);

  exp.get('/admin/api/status', (_req, res) => {
    const state = app.whatsapp.state();
    res.json({
      wa: state.kind,
      phone: state.kind === 'connected' ? state.phone : null,
      qrDataUrl: state.kind === 'qr_pending' ? state.qrDataUrl : null,
      paused: app.controlState.isPaused(),
      broadcastMode: app.config.settings.broadcast.mode,
      testGroupId: app.config.settings.broadcast.test_group_id,
      groupsCount: app.config.groups.groups.filter((g) => g.active).length,
      toursCount: Object.keys(app.config.tours.tours).length,
      allowlistMode: app.config.allowlist.mode,
    });
  });

  exp.get('/admin/api/events', (req, res) => {
    const since = Number((req.query.since as string) ?? 0);
    const limit = Math.min(Number((req.query.limit as string) ?? 100), 500);
    const rows = since > 0 ? app.eventLog.since(since, limit) : app.eventLog.recent(limit);
    res.json({ events: rows });
  });

  exp.get('/admin/api/jobs/recent', (_req, res) => {
    res.json({ runs: app.jobHistory.recent(20) });
  });

  exp.post('/admin/api/connect', async (_req, res) => {
    await app.whatsapp.start();
    res.json({ ok: true, state: app.whatsapp.state().kind });
  });

  exp.post('/admin/api/disconnect', async (_req, res) => {
    await app.whatsapp.stop();
    res.json({ ok: true, state: app.whatsapp.state().kind });
  });

  exp.post('/admin/api/pause', (_req, res) => {
    app.controlState.pause();
    res.json({ ok: true, paused: true });
  });
  exp.post('/admin/api/resume', (_req, res) => {
    app.controlState.resume();
    res.json({ ok: true, paused: false });
  });

  exp.post('/admin/api/jobs/nightly', async (req, res) => {
    const dryRun = Boolean(req.body?.dry_run);
    const result = await runNightlyJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      logger: app.logger,
      isPaused: () => app.controlState.isPaused(),
      dryRun,
    });
    res.json({ result });
  });

  exp.post('/admin/api/jobs/morning', async (req, res) => {
    const dryRun = Boolean(req.body?.dry_run);
    const result = await runMorningJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      logger: app.logger,
      isPaused: () => app.controlState.isPaused(),
      dryRun,
    });
    res.json({ result });
  });

  async function bulkGroupAction(action: 'close' | 'open', res: Response): Promise<void> {
    const targets =
      app.config.settings.broadcast.mode === 'test'
        ? [app.config.settings.broadcast.test_group_id]
        : app.config.groups.groups.filter((g) => g.active).map((g) => g.id);
    const svc = new GroupAdminService(app.whatsapp);
    if (action === 'close') await svc.closeAll(targets);
    else await svc.openAll(targets);
    res.json({ ok: true, targets });
  }
  exp.post('/admin/api/groups/close-all', async (_req, res) => bulkGroupAction('close', res));
  exp.post('/admin/api/groups/open-all', async (_req, res) => bulkGroupAction('open', res));

  exp.post('/admin/api/config/reload', (_req, res) => {
    try {
      app.reloadConfig();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0. If not, fix any missing imports/typos.

- [ ] **Step 3: Commit HTTP layer**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/app.ts app/src/http/server.ts app/src/http/webhookRoutes.ts app/src/http/auth.ts app/src/http/adminRoutes.ts
git commit -m "feat(http): Express server with webhook + password-gated admin API"
```

---

### Task 10.5: Admin web UI (single HTML page)

**Files:**
- Create: `app/web/admin.html`
- Create: `app/web/admin.css`
- Create: `app/web/admin.js`

- [ ] **Step 1: Create `app/web/admin.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>WhatsApp Bot — Admin</title>
  <link rel="stylesheet" href="/admin/admin.css"/>
</head>
<body>
  <main id="app">
    <section id="login-panel" class="card hidden">
      <h1>Admin Login</h1>
      <form id="login-form">
        <input type="password" name="password" placeholder="Password" required autofocus/>
        <button type="submit">Login</button>
      </form>
      <p id="login-error" class="error"></p>
    </section>

    <section id="main-panel" class="hidden">
      <header>
        <h1>WhatsApp Bot — Admin</h1>
        <button id="logout">Logout</button>
      </header>

      <div class="card" id="status-card">
        <h2>Status</h2>
        <div id="status-content">Loading…</div>
        <div class="button-row">
          <button id="btn-pause">Pause automations</button>
          <button id="btn-resume">Resume automations</button>
          <button id="btn-connect">Connect WA</button>
          <button id="btn-disconnect">Disconnect WA</button>
        </div>
      </div>

      <div class="card hidden" id="qr-card">
        <h2>Scan to connect</h2>
        <img id="qr-img" alt="QR code"/>
      </div>

      <div class="card">
        <h2>Jobs</h2>
        <div class="button-row">
          <button data-job="nightly" data-dry="1">Run Nightly (dry-run)</button>
          <button data-job="nightly" data-dry="0">Run Nightly (LIVE)</button>
          <button data-job="morning" data-dry="1">Run Morning (dry-run)</button>
          <button data-job="morning" data-dry="0">Run Morning (LIVE)</button>
          <button id="btn-close-all">Close all groups</button>
          <button id="btn-open-all">Re-open all groups</button>
        </div>
        <pre id="job-output" class="log-tail"></pre>
      </div>

      <div class="card">
        <h2>Recent job runs</h2>
        <table id="job-runs"><thead><tr>
          <th>Job</th><th>Started</th><th>Status</th><th>Tours</th><th>Sent</th><th>Closed</th><th>Error</th>
        </tr></thead><tbody></tbody></table>
      </div>

      <div class="card">
        <h2>Recent events</h2>
        <pre id="event-log" class="log-tail"></pre>
      </div>

      <div class="card">
        <h2>Config</h2>
        <div id="config-summary"></div>
        <button id="btn-reload-config">Reload config</button>
      </div>
    </section>
  </main>
  <script src="/admin/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app/web/admin.css`**

```css
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f4f4f4; color: #222; }
main { max-width: 900px; margin: 0 auto; padding: 1rem; }
.card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
.card h2 { margin-top: 0; font-size: 1.1rem; }
header { display: flex; justify-content: space-between; align-items: center; }
.hidden { display: none; }
.button-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
button { padding: 0.5rem 1rem; cursor: pointer; border: 1px solid #bbb; background: #fafafa; border-radius: 4px; }
button:hover { background: #eee; }
.error { color: #b00; }
.log-tail { max-height: 300px; overflow-y: auto; background: #111; color: #0f0; padding: 0.5rem; font-size: 0.75rem; border-radius: 4px; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; }
img#qr-img { max-width: 280px; }
form input { padding: 0.5rem; margin-right: 0.5rem; }
```

- [ ] **Step 3: Create `app/web/admin.js`**

```javascript
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  return { ok: res.ok, status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
};

let lastEventId = 0;
let pollHandle = null;

function showLogin() {
  $('#login-panel').classList.remove('hidden');
  $('#main-panel').classList.add('hidden');
}
function showMain() {
  $('#login-panel').classList.add('hidden');
  $('#main-panel').classList.remove('hidden');
  if (!pollHandle) pollHandle = setInterval(refreshAll, 5000);
  refreshAll();
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshEvents(), refreshJobRuns()]);
}

async function refreshStatus() {
  const r = await api('/admin/api/status');
  if (r.status === 401) { showLogin(); return; }
  const s = r.data;
  $('#status-content').innerHTML = `
    <div><b>WhatsApp:</b> ${s.wa}${s.phone ? ' (' + s.phone + ')' : ''}</div>
    <div><b>Automations:</b> ${s.paused ? '⏸ Paused' : '▶ Running'}</div>
    <div><b>Broadcast mode:</b> ${s.broadcastMode}${s.broadcastMode === 'test' ? ' → ' + s.testGroupId : ''}</div>
    <div><b>Groups:</b> ${s.groupsCount} active • <b>Tours:</b> ${s.toursCount} • <b>Allowlist:</b> ${s.allowlistMode}</div>
  `;
  const qrCard = $('#qr-card');
  if (s.qrDataUrl) { qrCard.classList.remove('hidden'); $('#qr-img').src = s.qrDataUrl; }
  else qrCard.classList.add('hidden');
  $('#config-summary').innerHTML = `${s.groupsCount} groups, ${s.toursCount} tours, allowlist=${s.allowlistMode}`;
}

async function refreshEvents() {
  const r = await api('/admin/api/events?since=' + lastEventId);
  if (!r.ok) return;
  const events = r.data.events ?? [];
  const pre = $('#event-log');
  for (const ev of events) {
    pre.textContent += `${ev.ts} [${ev.level}] ${ev.source}/${ev.event_type}: ${ev.message}\n`;
    if (ev.id > lastEventId) lastEventId = ev.id;
  }
  pre.scrollTop = pre.scrollHeight;
}

async function refreshJobRuns() {
  const r = await api('/admin/api/jobs/recent');
  if (!r.ok) return;
  const tbody = $('#job-runs tbody');
  tbody.innerHTML = (r.data.runs ?? []).map((j) => `
    <tr>
      <td>${j.job_name}${j.dry_run ? ' (dry)' : ''}</td>
      <td>${j.started_at}</td>
      <td>${j.status}</td>
      <td>${j.tours_count ?? ''}</td>
      <td>${j.groups_sent ?? ''}</td>
      <td>${j.groups_closed ?? ''}</td>
      <td>${j.error ?? ''}</td>
    </tr>
  `).join('');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = new FormData(e.target).get('password');
  const r = await api('/admin/login', { method: 'POST', body: { password } });
  if (r.ok) showMain();
  else $('#login-error').textContent = 'Bad password';
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' });
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  showLogin();
});

$('#btn-pause').addEventListener('click', () => api('/admin/api/pause', { method: 'POST' }).then(refreshStatus));
$('#btn-resume').addEventListener('click', () => api('/admin/api/resume', { method: 'POST' }).then(refreshStatus));
$('#btn-connect').addEventListener('click', () => api('/admin/api/connect', { method: 'POST' }).then(refreshStatus));
$('#btn-disconnect').addEventListener('click', () => api('/admin/api/disconnect', { method: 'POST' }).then(refreshStatus));
$('#btn-close-all').addEventListener('click', () => api('/admin/api/groups/close-all', { method: 'POST' }).then(refreshStatus));
$('#btn-open-all').addEventListener('click', () => api('/admin/api/groups/open-all', { method: 'POST' }).then(refreshStatus));
$('#btn-reload-config').addEventListener('click', async () => {
  const r = await api('/admin/api/config/reload', { method: 'POST' });
  $('#job-output').textContent = r.ok ? 'Config reloaded' : 'Reload failed: ' + (r.data?.error ?? '');
  refreshStatus();
});

document.querySelectorAll('button[data-job]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const job = btn.dataset.job;
    const dryRun = btn.dataset.dry === '1';
    $('#job-output').textContent = `Running ${job} (dry=${dryRun})…\n`;
    const r = await api(`/admin/api/jobs/${job}`, { method: 'POST', body: { dry_run: dryRun } });
    $('#job-output').textContent += JSON.stringify(r.data?.result ?? r.data, null, 2);
    refreshJobRuns();
    refreshEvents();
  });
});

// On load: try a status call; 401 → login, else main
api('/admin/api/status').then((r) => r.status === 401 ? showLogin() : showMain());
```

- [ ] **Step 4: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/web/
git commit -m "feat(ui): minimal single-page admin UI (HTML + CSS + vanilla JS)"
```

---

## Phase 11 — Scheduler + main wiring

### Task 11.1: Scheduler

**Files:**
- Create: `app/src/scheduler.ts`

- [ ] **Step 1: Create `app/src/scheduler.ts`**

```typescript
import cron from 'node-cron';
import type { App } from './app';
import { runNightlyJob } from './jobs/nightlyJob';
import { runMorningJob } from './jobs/morningJob';

export interface ScheduledTasks {
  nightly: cron.ScheduledTask;
  morning: cron.ScheduledTask;
  prune: cron.ScheduledTask;
}

export function startScheduler(app: App): ScheduledTasks {
  const tz = app.config.settings.timezone;

  const nightly = cron.schedule(
    app.config.settings.schedule.nightly_cron,
    async () => {
      await runNightlyJob({
        config: app.config,
        whatsapp: app.whatsapp,
        wix: app.wix,
        history: app.jobHistory,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
        dryRun: false,
      });
    },
    { timezone: tz },
  );

  const morning = cron.schedule(
    app.config.settings.schedule.morning_cron,
    async () => {
      await runMorningJob({
        config: app.config,
        whatsapp: app.whatsapp,
        wix: app.wix,
        history: app.jobHistory,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
        dryRun: false,
      });
    },
    { timezone: tz },
  );

  // Daily prune at 03:00: trim events + job_runs older than 90 days.
  const prune = cron.schedule(
    '0 3 * * *',
    () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const removed = app.eventLog.pruneOlderThan(cutoff);
      app.logger.info({
        source: 'scheduler',
        eventType: 'prune',
        message: `pruned ${removed} old event rows`,
      });
    },
    { timezone: tz },
  );

  app.logger.info({
    source: 'scheduler',
    eventType: 'scheduler_started',
    message: `scheduler started (tz=${tz})`,
    metadata: {
      nightly_cron: app.config.settings.schedule.nightly_cron,
      morning_cron: app.config.settings.schedule.morning_cron,
    },
  });

  return { nightly, morning, prune };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/src/scheduler.ts
git commit -m "feat(scheduler): nightly/morning cron with Europe/Madrid + daily prune"
```

---

### Task 11.2: Main entry point (wire everything together)

**Files:**
- Modify: `app/src/index.ts` (replace stub)
- Create: `app/.env.example`

- [ ] **Step 1: Create `app/.env.example`**

```
# Copy to .env and fill values for local dev.
NODE_ENV=development
HTTP_PORT=3000

# bcrypt hash of your admin password. Generate with:
#   node -e "console.log(require('bcrypt').hashSync(process.argv[1], 10))" 'your-password'
ADMIN_PASSWORD_HASH=

# Long random string for signing the admin cookie
SESSION_COOKIE_SECRET=

# Wix
WIX_API_KEY=
WIX_SITE_ID=
WIX_WEBHOOK_SIGNING_SECRET=

# Optional: override data directory (defaults to ./data)
DATA_DIR=./data
```

- [ ] **Step 2: Replace `app/src/index.ts` with the full wiring**

```typescript
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config/loader';
import { openDatabase } from './persistence/db';
import { EventLog } from './persistence/eventLog';
import { JobHistory } from './persistence/jobHistory';
import { WebhookDedup } from './persistence/webhookDedup';
import { PendingDms } from './persistence/pendingDms';
import { ControlState } from './persistence/controlState';
import { ControlStateService } from './control/state';
import { createLogger } from './log/logger';
import { createWhatsAppClient } from './whatsapp/client';
import { createWixClient } from './wix/client';
import { DirectMessageSender } from './messaging/directMessage';
import { createHttpServer } from './http/server';
import { startScheduler } from './scheduler';
import type { App } from './app';

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionDir = path.join(dataDir, 'session');
  const logDir = path.join(dataDir, 'logs');
  const dbPath = path.join(dataDir, 'wabot.sqlite');
  const configDir = path.resolve(process.cwd(), 'config');

  const db = openDatabase(dbPath);
  const eventLog = new EventLog(db);
  const jobHistory = new JobHistory(db);
  const webhookDedup = new WebhookDedup(db);
  const pendingDms = new PendingDms(db);
  const controlStateStore = new ControlState(db);
  const controlState = new ControlStateService(controlStateStore);

  // Recover any jobs left "running" from a prior crash
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const recovered = jobHistory.markStaleRunning(cutoff);

  const logger = createLogger({ eventLog, logDir, consoleLevel: 'info' });
  if (recovered > 0) {
    logger.warn({
      source: 'startup',
      eventType: 'stale_job_runs_recovered',
      message: `marked ${recovered} stale running jobs as failed`,
    });
  }

  let config = loadConfig(configDir);
  const reloadConfig = () => {
    config = loadConfig(configDir);
    logger.info({
      source: 'startup',
      eventType: 'config_reloaded',
      message: 'config reloaded',
    });
    // Update the app record's config pointer
    app.config = config;
  };

  const whatsapp = createWhatsAppClient({ sessionDir });
  const wix = createWixClient({
    apiKey: process.env.WIX_API_KEY ?? '',
    siteId: process.env.WIX_SITE_ID ?? '',
  });

  const dmSender = new DirectMessageSender({
    client: whatsapp,
    pendingDms,
    allowlist: () => config.allowlist,
    retry: {
      attempts: config.settings.retry.max_attempts,
      backoffMs: config.settings.retry.backoff_ms,
    },
    isPaused: () => controlState.isPaused(),
  });

  const app: App = {
    db,
    config,
    reloadConfig,
    eventLog,
    jobHistory,
    webhookDedup,
    pendingDms,
    controlStateStore,
    controlState,
    whatsapp,
    wix,
    dmSender,
    logger,
    lastQrDataUrl: null,
  };

  // Drain pending DMs whenever WA reconnects
  whatsapp.onStateChange(async (s) => {
    if (s.kind === 'connected') {
      controlStateStore.set('last_connect_state', 'connected');
      const r = await dmSender.drainPending();
      if (r.sent + r.failed + r.abandoned > 0) {
        logger.info({
          source: 'pending',
          eventType: 'pending_dms_drained',
          message: `drain: sent=${r.sent} failed=${r.failed} abandoned=${r.abandoned}`,
        });
      }
    } else if (s.kind === 'disconnected') {
      controlStateStore.set('last_connect_state', 'disconnected');
    }
  });

  const server = createHttpServer(app);
  const port = Number(process.env.HTTP_PORT ?? 3000);
  server.listen(port, () => {
    logger.info({
      source: 'startup',
      eventType: 'http_listening',
      message: `HTTP listening on :${port}`,
    });
  });

  // Auto-reconnect if last state was "connected"
  if (controlStateStore.get('last_connect_state') === 'connected') {
    logger.info({
      source: 'startup',
      eventType: 'autoconnect',
      message: 'attempting WhatsApp reconnect (last state was connected)',
    });
    whatsapp.start().catch((err) => {
      logger.error({
        source: 'startup',
        eventType: 'autoconnect_failed',
        message: (err as Error).message,
      });
    });
  }

  startScheduler(app);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Try to start the dev server**

```bash
cd /workplace/jomedes/whatsapp_bot/app
# create a minimal .env for the run
cat > .env <<'ENV'
NODE_ENV=development
HTTP_PORT=3000
ADMIN_PASSWORD_HASH=$2b$10$abcdefghijklmnopqrstuvwxyz123456789012345678901234567890ab
SESSION_COOKIE_SECRET=local-dev-secret-please-change
WIX_API_KEY=placeholder
WIX_SITE_ID=placeholder
WIX_WEBHOOK_SIGNING_SECRET=placeholder
DATA_DIR=./data
ENV
timeout 10 npm run dev 2>&1 | head -30 || true
```
Expected: logs show "HTTP listening on :3000". WA will likely fail to auto-connect (no prior session); that's OK.

- [ ] **Step 5: Smoke test /healthz**

```bash
curl -s http://localhost:3000/healthz 2>&1 | head -5
```
Expected: JSON with `{"wa":"disconnected","paused":false,...}`.

Kill the dev server (Ctrl-C if still running interactively; `timeout` above will have stopped it).

- [ ] **Step 6: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/.env.example app/src/index.ts
git commit -m "feat(app): main entry point wiring persistence, WA, Wix, HTTP, scheduler"
```

---

## Phase 12 — Deployment artifacts

### Task 12.1: Dockerfile + .dockerignore

**Files:**
- Create: `app/Dockerfile`
- Create: `app/.dockerignore`

- [ ] **Step 1: Create `app/Dockerfile`**

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-color-emoji \
      fonts-noto \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxrandr2 \
      libxdamage1 libgbm1 libasound2 \
      ca-certificates \
      && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY web/ ./web/

RUN npm run build

# Runtime
RUN npm prune --omit=dev

EXPOSE 3000
VOLUME ["/data"]
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `app/.dockerignore`**

```
node_modules
dist
data
tests
.env
.env.local
*.log
npm-debug.log
```

- [ ] **Step 3: Build the image locally to verify**

```bash
cd /workplace/jomedes/whatsapp_bot/app
docker build -t barcelola-wabot:test . 2>&1 | tail -20
```
Expected: "Successfully tagged barcelola-wabot:test" (or equivalent). If Docker is not installed locally, skip this step and mark the task done after verifying the file contents.

- [ ] **Step 4: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/Dockerfile app/.dockerignore
git commit -m "build: Docker image with Chromium + Hebrew/emoji fonts"
```

---

### Task 12.2: fly.toml

**Files:**
- Create: `app/fly.toml`

- [ ] **Step 1: Create `app/fly.toml`**

```toml
app = "barcelola-wabot"
primary_region = "mad"

[build]

[env]
  NODE_ENV = "production"
  HTTP_PORT = "3000"
  DATA_DIR = "/data"

[[mounts]]
  source = "wabot_data"
  destination = "/data"

[[services]]
  internal_port = 3000
  protocol = "tcp"
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [services.concurrency]
    type = "connections"
    hard_limit = 25
    soft_limit = 20

  [[services.http_checks]]
    interval = "30s"
    timeout = "5s"
    method = "get"
    path = "/healthz"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 1024
```

- [ ] **Step 2: Commit**

```bash
cd /workplace/jomedes/whatsapp_bot
git add app/fly.toml
git commit -m "build: fly.toml with mad region, persistent volume, /healthz check"
```

---

## Phase 13 — End-to-end verification

### Task 13.1: Run all tests

- [ ] **Step 1: Run the full test suite**

```bash
cd /workplace/jomedes/whatsapp_bot/app && npm test 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 2: Run typecheck + lint**

```bash
cd /workplace/jomedes/whatsapp_bot/app
npm run typecheck
npm run lint
```
Expected: both succeed (warnings acceptable; errors are not).

- [ ] **Step 3: If anything fails, fix and commit**

---

### Task 13.2: Manual smoke test (local)

- [ ] **Step 1: Start the dev server**

```bash
cd /workplace/jomedes/whatsapp_bot/app
npm run dev
```

- [ ] **Step 2: In a browser, visit `http://localhost:3000/admin`**

Expected: login page.

- [ ] **Step 3: Generate an admin password hash**

In a separate terminal:
```bash
cd /workplace/jomedes/whatsapp_bot/app
node -e "console.log(require('bcrypt').hashSync(process.argv[1], 10))" your-test-password
```
Copy the hash into `app/.env` as `ADMIN_PASSWORD_HASH`. Restart the dev server.

- [ ] **Step 4: Log in, click "Connect WA"**

Expected: QR card appears. Scan with WhatsApp. Status updates to "connected".

- [ ] **Step 5: Run a dry-run nightly job**

Click "Run Nightly (dry-run)". Check `job-output` area for the preview message. With placeholder Wix credentials the Wix call will fail — that's OK for now; the job_runs row captures the error.

- [ ] **Step 6: Verify /healthz from CLI**

```bash
curl -s http://localhost:3000/healthz
```
Expected: JSON with `wa: "connected"`.

- [ ] **Step 7: POST a fixture webhook**

```bash
curl -s -X POST http://localhost:3000/webhook/wix \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/wix/booking-webhook.json
```
Expected: `{"received":true}`. Check event log in admin UI. With allowlist=explicit (empty) this will show `booking_skipped_allowlist`.

- [ ] **Step 8: Stop dev server, verify session survived**

Kill the server (Ctrl-C), restart with `npm run dev`. Check status: still "connected" (auto-reconnect on startup).

---

### Task 13.3: Final cleanup

**Files:**
- Delete: `backend/` and `frontend/` (old project) — only after user confirms the new one works.

- [ ] **Step 1: Ask user to confirm the new `app/` works end-to-end.**

Only after explicit confirmation:

- [ ] **Step 2: Remove old trees**

```bash
cd /workplace/jomedes/whatsapp_bot
rm -rf backend/ frontend/ PHASE2/ PHASE3/ PHASE4/ PHASE_DEPLOY/ database_kiro.js deploy-aws.sh setup.sh QUICKSTART.md TESTING.md
git add -A
git commit -m "chore: remove legacy project trees in favor of app/"
```

- [ ] **Step 3: Update root README**

Rewrite `README.md` briefly pointing at `app/` and the spec / plan under `docs/superpowers/`.

---

## Appendix A — Local Cloudflare Tunnel setup (for Wix webhook dev)

Run once to create a persistent named tunnel:

```bash
# Install cloudflared:
#   brew install cloudflared   (macOS)
#   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared
cloudflared tunnel login
cloudflared tunnel create wabot-dev
```

Create `~/.cloudflared/config.yml`:
```yaml
tunnel: wabot-dev
credentials-file: /home/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: wabot-dev.<your-domain>
    service: http://localhost:3000
  - service: http_status:404
```

Route:
```bash
cloudflared tunnel route dns wabot-dev wabot-dev.<your-domain>
cloudflared tunnel run wabot-dev
```

Register the webhook in Wix pointing at `https://wabot-dev.<your-domain>/webhook/wix`. The URL stays stable across laptop restarts.

---

## Appendix B — Deployment checklist (first Fly.io deploy)

1. `fly auth login`
2. `cd app && fly launch --copy-config --no-deploy` (will reuse `fly.toml`)
3. `fly volumes create wabot_data --region mad --size 3`
4. Set secrets:
   ```
   fly secrets set \
     ADMIN_PASSWORD_HASH='$2b$...' \
     SESSION_COOKIE_SECRET='<random>' \
     WIX_API_KEY='...' \
     WIX_SITE_ID='...' \
     WIX_WEBHOOK_SIGNING_SECRET='...'
   ```
5. `fly deploy`
6. Open `https://<app>.fly.dev/admin`, log in, click "Connect WA", scan QR.
7. Verify `/healthz`. Update Wix webhook URL to the Fly hostname.
8. Flip `broadcast.mode` to `production` in `config/settings.yaml`, redeploy when ready.

---

## Self-review (spec coverage check)

| Spec requirement | Task(s) covering it |
|---|---|
| Nightly broadcast at 21:30 Europe/Madrid | 8.2, 11.1 |
| Morning broadcast at 08:30 Europe/Madrid | 8.3, 11.1 |
| Booking confirmation webhook → DM | 6.2, 9.1, 10.2 |
| Hybrid Wix (API + webhook) | 6.1, 6.2 |
| Single always-on Node process | 11.2 |
| Pause / disconnect as independent controls | 4.1, 10.4 |
| Session files on local disk | 5.1 (LocalAuth dataPath); 11.2 (sessionDir) |
| Minimal web UI | 10.5 |
| Test-group mode override | 7.3 (builder neutral), 8.2/8.3 (resolveTargets) |
| YAML config + zod validation | 2.1, 2.2, 2.3 |
| SQLite runtime storage | 3.1, 3.2 |
| Wix read-only | 6.1 only has GET |
| Fail-loud admin check | 8.2/8.3 (verifyAdminAll) |
| Bounded retry (3 attempts 1m/5m/15m) | 7.4, 7.5 |
| 0 tours → skip broadcast + still close | 8.2 test case |
| Min bookings = 1 | 8.2/8.3 (filter) |
| Node + TypeScript | 0.2 |
| Fly.io (mad region) | 12.2 |
| Cloudflare Tunnel for dev webhooks | Appendix A |
| Europe/Madrid DST | 8.2/8.3 use Intl with timeZone; 11.1 passes tz to node-cron |
| Lean testing | Unit + a few integration tests; no UI regression |
| Staged allowlist rollout | 7.2, 7.6 |
| Phone normalization | 7.1 |
| Event log + job history observability | 3.2, 3.3, 10.4, 10.5 |
| Dry-run mode in UI | 8.2/8.3 (metadata preview), 10.4 (/admin/api/jobs/*), 10.5 buttons |
| Crash recovery | 11.2 (markStaleRunning) |
| Pending DMs drain on reconnect | 11.2 (onStateChange handler), 7.6 (drainPending) |

No gaps identified.
