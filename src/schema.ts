import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS accepted (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		payment TEXT NOT NULL,
		acceptedAt INTEGER NOT NULL,
		expiresAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS accepted_by_id ON accepted (id);
	CREATE INDEX IF NOT EXISTS accepted_by_expiry ON accepted (expiresAt);

	CREATE TABLE IF NOT EXISTS schedule (
		id TEXT PRIMARY KEY,
		expiresAt INTEGER NOT NULL,
		dueAt INTEGER,
		announced INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS schedule_by_expiry ON schedule (expiresAt);
	CREATE INDEX IF NOT EXISTS schedule_by_due ON schedule (dueAt);

	CREATE TABLE IF NOT EXISTS paid (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		payment TEXT NOT NULL,
		settledAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		heardAt INTEGER,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS paid_by_id ON paid (id);
	CREATE INDEX IF NOT EXISTS paid_by_age ON paid (settledAt);

	CREATE TABLE IF NOT EXISTS outbox (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		url TEXT NOT NULL,
		body TEXT NOT NULL,
		owedAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		dueAt INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0,
		retryUntil INTEGER,
		parkedAt INTEGER,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS outbox_by_due ON outbox (dueAt);
	CREATE INDEX IF NOT EXISTS outbox_by_age ON outbox (owedAt);
	CREATE INDEX IF NOT EXISTS outbox_by_hook ON outbox (id, url);

	CREATE TABLE IF NOT EXISTS delivered (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		url TEXT NOT NULL,
		deliveredAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS delivered_by_hook ON delivered (id, url);
	CREATE INDEX IF NOT EXISTS delivered_by_age ON delivered (deliveredAt);

	CREATE TABLE IF NOT EXISTS progress (
		source TEXT NOT NULL,
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		PRIMARY KEY (source, origin)
	);

	CREATE TABLE IF NOT EXISTS requests (
		key TEXT PRIMARY KEY,
		fingerprint TEXT NOT NULL,
		paymentId TEXT,
		claimedAt INTEGER NOT NULL,
		leaseUntil INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS requests_by_age ON requests (claimedAt);

	CREATE TABLE IF NOT EXISTS kept (
		id TEXT PRIMARY KEY,
		caller TEXT,
		sealed TEXT NOT NULL,
		status TEXT NOT NULL,
		settledAt INTEGER,
		keptAt INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS kept_by_age ON kept (keptAt);
`;

const SCHEMA_VERSION = 3;

const BUSY_TIMEOUT_MS = 5000;

export function openLedgerFile(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);

	return db;
}

function migrate(db: DatabaseSync): void {
	const found = schemaVersion(db);
	if (found > SCHEMA_VERSION) {
		throw new Error(
			`this ledger is at schema ${found} and this build knows ${SCHEMA_VERSION}, so a newer build wrote it`,
		);
	}

	dropOutdatedRequestCache(db);
	addLocalColumns(db);
	db.exec(SCHEMA);
	if (found !== SCHEMA_VERSION) {
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}
}

function schemaVersion(db: DatabaseSync): number {
	return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function addLocalColumns(db: DatabaseSync): void {
	const missing = [
		["paid", "heardAt"],
		["outbox", "retryUntil"],
		["outbox", "parkedAt"],
	].filter(([table, column]) => {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		return columns.length > 0 && !columns.some((one) => one.name === column);
	});
	for (const [table, column] of missing) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
	}
}

function dropOutdatedRequestCache(db: DatabaseSync): void {
	const columns = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
	if (columns.length > 0 && !columns.some((column) => column.name === "fingerprint")) {
		db.exec("DROP TABLE requests");
	}
}
