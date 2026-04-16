import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { canonicalize } from '../names.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, 'sounds.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sounds (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    filename         TEXT NOT NULL,
    uploader_id      TEXT NOT NULL,
    uploader_tag     TEXT NOT NULL,
    guild_id         TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    file_size_bytes  INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sounds_uploader ON sounds(uploader_id);
  CREATE INDEX IF NOT EXISTS idx_sounds_name ON sounds(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS admins (
    user_id   TEXT PRIMARY KEY,
    added_by  TEXT NOT NULL,
    added_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_admins (
    guild_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    added_by  TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE TABLE IF NOT EXISTS sound_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sound_id    INTEGER NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL COLLATE NOCASE,
    created_by  TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (sound_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_sound_tags_sound ON sound_tags(sound_id);
  CREATE INDEX IF NOT EXISTS idx_sound_tags_tag   ON sound_tags(tag COLLATE NOCASE);
`);

// --- Schema migrations: add columns added after initial release -------------
function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

if (!columnExists('sounds', 'is_private')) {
  db.exec(`ALTER TABLE sounds ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`);
  logger.info('migration: added sounds.is_private');
}

if (!columnExists('sounds', 'match_name')) {
  db.exec(`ALTER TABLE sounds ADD COLUMN match_name TEXT`);
  logger.info('migration: added sounds.match_name');
}

// Backfill match_name for any rows missing it (or all rows on first migration).
// Done synchronously at boot — soundboards are small.
{
  const rows = db
    .prepare("SELECT id, name FROM sounds WHERE match_name IS NULL OR match_name = ''")
    .all();
  if (rows.length > 0) {
    const upd = db.prepare('UPDATE sounds SET match_name = ? WHERE id = ?');
    const tx = db.transaction(items => {
      for (const r of items) upd.run(canonicalize(r.name), r.id);
    });
    tx(rows);
    logger.info('migration: backfilled match_name', { rows: rows.length });
  }
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sounds_match_name ON sounds(match_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sounds_guild ON sounds(guild_id)`);

// Legacy `admins` table — log entries before dropping so the owner can re-add per guild.
{
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='admins'`)
    .get();
  if (tableExists) {
    const legacy = db.prepare('SELECT user_id, added_by, added_at FROM admins').all();
    if (legacy.length > 0) {
      logger.warn('legacy admins table found — these users must be re-added per guild via /sb admin add', {
        count: legacy.length,
        users: legacy.map(r => r.user_id)
      });
    }
    // Keep the old table around for one release cycle as a safety net rather
    // than dropping immediately. Reads no longer reference it.
  }
}

logger.info('database initialized', { path: dbPath });

export const queries = {
  // --- Sounds: lookups all use match_name now -------------------------------
  getByMatch: db.prepare('SELECT * FROM sounds WHERE match_name = ?'),
  getByUploader: db.prepare('SELECT * FROM sounds WHERE uploader_id = ?'),
  countByUploader: db.prepare('SELECT COUNT(*) AS count FROM sounds WHERE uploader_id = ?'),

  getAllGlobal: db.prepare(
    'SELECT * FROM sounds WHERE is_private = 0 ORDER BY name COLLATE NOCASE ASC'
  ),
  getAllForGuild: db.prepare(
    'SELECT * FROM sounds WHERE guild_id = ? ORDER BY name COLLATE NOCASE ASC'
  ),

  searchGlobal: db.prepare(`
    SELECT * FROM sounds
    WHERE is_private = 0 AND match_name LIKE ?
    ORDER BY name COLLATE NOCASE ASC
    LIMIT 25
  `),
  searchForGuild: db.prepare(`
    SELECT * FROM sounds
    WHERE guild_id = ? AND match_name LIKE ?
    ORDER BY name COLLATE NOCASE ASC
    LIMIT 25
  `),

  insert: db.prepare(`
    INSERT INTO sounds
      (name, match_name, filename, uploader_id, uploader_tag, guild_id,
       duration_seconds, file_size_bytes, created_at, is_private)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  rename: db.prepare('UPDATE sounds SET name = ?, match_name = ? WHERE id = ?'),
  updateAfterTrim: db.prepare(
    'UPDATE sounds SET duration_seconds = ?, file_size_bytes = ? WHERE id = ?'
  ),
  deleteById: db.prepare('DELETE FROM sounds WHERE id = ?'),

  totalSize: db.prepare('SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM sounds'),
  count: db.prepare('SELECT COUNT(*) AS count FROM sounds'),
  topBySize: db.prepare('SELECT name, file_size_bytes FROM sounds ORDER BY file_size_bytes DESC LIMIT ?'),

  // --- Per-guild bot admins -------------------------------------------------
  isBotAdmin: db.prepare('SELECT 1 FROM bot_admins WHERE guild_id = ? AND user_id = ?'),
  addBotAdmin: db.prepare(
    'INSERT OR IGNORE INTO bot_admins (guild_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)'
  ),
  removeBotAdmin: db.prepare('DELETE FROM bot_admins WHERE guild_id = ? AND user_id = ?'),
  getBotAdminsForGuild: db.prepare(
    'SELECT user_id, added_by, added_at FROM bot_admins WHERE guild_id = ? ORDER BY added_at ASC'
  ),
  getAllBotAdmins: db.prepare(
    'SELECT guild_id, user_id, added_by, added_at FROM bot_admins ORDER BY added_at ASC'
  ),

  // --- Per-guild settings ---------------------------------------------------
  getSetting: db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?'),
  getAllSettingsForGuild: db.prepare(
    'SELECT key, value, updated_by, updated_at FROM guild_settings WHERE guild_id = ?'
  ),
  getAllSettings: db.prepare('SELECT guild_id, key, value FROM guild_settings'),
  upsertSetting: db.prepare(`
    INSERT INTO guild_settings (guild_id, key, value, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `),
  deleteSetting: db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?'),
  // --- Tags -----------------------------------------------------------------
  addTag: db.prepare(`
    INSERT OR IGNORE INTO sound_tags (sound_id, tag, created_by, created_at)
    VALUES (?, ?, ?, ?)
  `),
  removeTag: db.prepare(
    'DELETE FROM sound_tags WHERE sound_id = ? AND tag = ? COLLATE NOCASE'
  ),
  getTagsForSound: db.prepare(
    'SELECT tag FROM sound_tags WHERE sound_id = ? ORDER BY tag COLLATE NOCASE ASC'
  ),
  getSoundsForTag: db.prepare(`
    SELECT sounds.* FROM sounds
    JOIN sound_tags ON sounds.id = sound_tags.sound_id
    WHERE sound_tags.tag = ? COLLATE NOCASE
      AND sounds.is_private = 0
    ORDER BY sounds.name COLLATE NOCASE ASC
  `),
  getSoundsForTagInGuild: db.prepare(`
    SELECT sounds.* FROM sounds
    JOIN sound_tags ON sounds.id = sound_tags.sound_id
    WHERE sound_tags.tag = ? COLLATE NOCASE
      AND sounds.guild_id = ?
    ORDER BY sounds.name COLLATE NOCASE ASC
  `),
  searchTagsGlobal: db.prepare(`
    SELECT DISTINCT sound_tags.tag FROM sound_tags
    JOIN sounds ON sounds.id = sound_tags.sound_id
    WHERE sounds.is_private = 0 AND sound_tags.tag LIKE ? ESCAPE '\\'
    ORDER BY sound_tags.tag COLLATE NOCASE ASC
    LIMIT 25
  `),
  searchTagsForGuild: db.prepare(`
    SELECT DISTINCT sound_tags.tag FROM sound_tags
    JOIN sounds ON sounds.id = sound_tags.sound_id
    WHERE sounds.guild_id = ? AND sound_tags.tag LIKE ? ESCAPE '\\'
    ORDER BY sound_tags.tag COLLATE NOCASE ASC
    LIMIT 25
  `)
};

export default db;
