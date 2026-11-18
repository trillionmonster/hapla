import "reflect-metadata";

// Patch crypto.subtle.importKey to normalize base64 → base64url in JWK data.
// privacy-kit uses standard base64 for Ed25519 JWK keys, but Bun (correctly per spec)
// requires base64url. Node.js is lenient about this, Bun is not.
const origImportKey = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = function (format: any, keyData: any, algorithm: any, extractable: any, keyUsages: any) {
    if (format === 'jwk' && keyData && typeof keyData === 'object') {
        const fixed = { ...keyData };
        for (const field of ['d', 'x', 'y', 'n', 'e', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
            if (typeof fixed[field] === 'string') {
                fixed[field] = fixed[field].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
        }
        return origImportKey(format, fixed, algorithm, extractable, keyUsages);
    }
    return origImportKey(format, keyData, algorithm, extractable, keyUsages);
} as any;

import * as fs from "fs";
import * as path from "path";
import { createPGlite } from "./storage/pgliteLoader";

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");

async function migrate() {
    console.log(`Migrating database in ${pgliteDir}...`);
    fs.mkdirSync(pgliteDir, { recursive: true });

    const pg = createPGlite(pgliteDir);
    try {
        // Create migrations tracking table
        await pg.exec(`
            CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
                "id" TEXT PRIMARY KEY,
                "migration_name" TEXT NOT NULL UNIQUE,
                "finished_at" TIMESTAMPTZ,
                "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
                "logs" TEXT
            );
        `);

        // Find migrations directory - try multiple locations
        let migrationsDirResolved = "";
        const candidates = [
            path.join(process.cwd(), "prisma", "migrations"),
            path.join(process.cwd(), "packages", "hapla-server", "prisma", "migrations"),
            path.join(path.dirname(process.execPath), "prisma", "migrations"),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                migrationsDirResolved = candidate;
                break;
            }
        }
        if (!migrationsDirResolved) {
            throw new Error("Could not find prisma/migrations directory");
        }

        // Get all migration directories sorted
        const dirs = fs.readdirSync(migrationsDirResolved)
            .filter(d => fs.statSync(path.join(migrationsDirResolved, d)).isDirectory())
            .sort();

        // Get already applied migrations
        const applied = await pg.query<{ migration_name: string }>(
            `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
        );
        const appliedSet = new Set(applied.rows.map(r => r.migration_name));

        let appliedCount = 0;
        for (const dir of dirs) {
            if (appliedSet.has(dir)) {
                continue;
            }

            const sqlFile = path.join(migrationsDirResolved, dir, "migration.sql");
            if (!fs.existsSync(sqlFile)) {
                continue;
            }

            console.log(`  Applying ${dir}...`);
            const sql = fs.readFileSync(sqlFile, "utf-8");

            try {
                await pg.exec(sql);
                await pg.query(
                    `INSERT INTO "_prisma_migrations" ("id", "migration_name", "finished_at", "applied_steps_count") VALUES ($1, $2, now(), 1)`,
                    [crypto.randomUUID(), dir]
                );
                appliedCount++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const migrationError = new Error(`Failed to apply ${dir}: ${message}`) as Error & { cause?: unknown };
                migrationError.cause = error;
                throw migrationError;
            }
        }

        if (appliedCount === 0) {
            console.log("No new migrations to apply.");
        } else {
            console.log(`Applied ${appliedCount} migration(s).`);
        }
    } finally {
        // PGlite owns a filesystem mount. Always close it, including after a
        // failed migration, so a subsequent server start can safely reopen it.
        await pg.close();
    }
}

async function serve() {
    // A portable deployment has no separate migration job. Apply pending
    // migrations before Prisma opens the embedded database.
    await migrate();

    // Ensure DB_PROVIDER is set for db.ts
    process.env.DB_PROVIDER = process.env.DB_PROVIDER || "pglite";
    process.env.PGLITE_DIR = process.env.PGLITE_DIR || pgliteDir;

    // Import and run the main server
    await import("./main");
}

// CLI
const command = process.argv[2];

switch (command) {
    case "migrate":
        migrate().catch(e => {
            console.error(e);
            process.exit(1);
        });
        break;
    case "serve":
        serve().catch(e => {
            console.error(e);
            process.exit(1);
        });
        break;
    default:
        console.log(`hapla-server - portable distribution

Usage:
  hapla-server migrate    Apply database migrations
  hapla-server serve      Start the server

Environment variables:
  DATA_DIR          Base data directory (default: ./data)
  PGLITE_DIR        PGlite database directory (default: DATA_DIR/pglite)
  PORT              Server port (default: 3005)
  HAPLA_MASTER_SECRET  Required: master secret for auth/encryption
`);
        process.exit(command === "--help" || command === "-h" ? 0 : 1);
}
