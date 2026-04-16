# Soundboard Bot — Project Plan

A Discord soundboard bot that lets users upload short audio clips, play them back in a voice channel, and overlap multiple sounds without interrupting each other. Runs as a Docker container on Unraid.

---

## Goals

- Users upload audio/video files via `/sb upload`, the bot converts them to a unified format (Opus OGG) and stores them.
- Users play sounds via `/sb play`. Multiple sounds can overlap in the same voice channel without stopping each other.
- Users can delete their own sounds. Admins can delete any sound.
- The bot refuses to leave an active voice channel for non-admin users ("don't steal the bot").
- Admins have priority: their `/sb play` overrides the channel lock.
- Storage is monitored; admins get a DM at 1GB, uploads are blocked at 5GB.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 (ESM) |
| Bot framework | discord.js v14 |
| Voice | @discordjs/voice |
| Audio processing | ffmpeg + ffprobe (spawned as child processes) |
| YouTube downloads | yt-dlp (installed in Docker image) |
| Database | better-sqlite3 |
| Container | Docker (multi-stage) on Unraid |

---

## Audio Format

All uploads are converted to **Opus in an OGG container** at **128kbps, 48kHz, stereo**.

Why: Discord's voice system uses Opus natively, so stored files can be streamed without re-encoding the codec (only the container changes). Excellent quality at tiny sizes — roughly 1MB/min at 128kbps.

---

## Overlapping Playback — PCM Mixer

Discord only allows one audio stream per voice connection. To play multiple sounds simultaneously without stopping the current one, the bot runs a custom **PCM mixer**:

1. Each active sound spawns its own `ffmpeg` process that decodes the file to raw 48kHz stereo PCM (s16le).
2. A `Mixer` Readable stream pulls 20ms frames from every active source, sums the samples (clamped to int16 range), and outputs a single mixed PCM stream.
3. That stream is wrapped in an `AudioResource` with `StreamType.Raw` and played through a single `AudioPlayer`.
4. When a source drains, it's removed from the mix. When the mixer has no more sources, the session ends and the bot disconnects.

---

## File Limits

Env values are defaults; most are overridable per server via `/sb settings`. Storage caps are clamped to an absolute ceiling of 10 GB.

| Limit | Default | Env var | Per-server override |
|---|---|---|---|
| Max duration | 120s | `MAX_DURATION_SECONDS` | `max_duration_seconds` |
| Max file size (post-conversion) | 10MB | `MAX_FILE_SIZE_MB` | `max_file_size_mb` |
| Max uploads per user | 20 | `MAX_SOUNDS_PER_USER` | `max_sounds_per_user` |
| Spam selection size | 15 sounds | n/a | `spam_pool_size` |
| Storage soft cap (warn) | 1GB → DM admins | `STORAGE_WARN_GB` | `storage_warn_gb_override` (owner only) |
| Storage hard cap (block) | 5GB → refuse uploads | `STORAGE_HARD_GB` | `storage_hard_gb_override` (owner only) |

---

## Commands

Every command is registered under both `/sb` and `/soundboard`.

| Command | Description |
|---|---|
| `/sb upload name:<text> [file:<attachment>] [youtube_url:<text>]` | Upload audio/video file or YouTube link. Exactly one source required. Names accept spaces/hyphens/underscores; stored kebab-case, displayed with spaces. Tag (global vs private) follows the server's `upload_scope`. Admins bypass the storage hard cap (owner always does). |
| `/sb play name:<text>` | Play a sound. Overlaps current playback if same channel. Blocked cross-channel for non-admins. Visibility honours `view_scope`. |
| `/sb quickplay youtube_url:<text> [channel:<channel>]` | Play a YouTube link without saving it — audio is downloaded to a temp file and deleted when playback finishes. Same caps as `/sb upload` (owner unlimited, admin 200 MB / no duration cap, user 100 MB / `max_duration_seconds`). |
| `/sb playlist tag:<text> [channel:<channel>]` | Play every sound carrying a given tag, in sequence. Scope follows `view_scope`. Missing files are skipped. |
| `/sb tag add name:<text> tag:<text>` | Attach a tag to a sound. Uploader, admin, or owner. Max 10 tags per sound, 1–32 chars `[a-zA-Z0-9_-]`. |
| `/sb tag remove name:<text> tag:<text>` | Remove a tag from a sound. Same permissions as `tag add`. |
| `/sb tag list [name:<text>]` | With `name:` → tags on that sound; without → every tag visible under `view_scope`. |
| `/sb edit name:<text> new_name:<text>` | Rename a sound. Uploader or owner only. |
| `/sb cut name:<text> start:<text> end:<text>` | Trim a sound in place. Uploader or owner only. Times accept `MM:SS`, `HH:MM:SS`, or seconds. |
| `/sb delete name:<text>` 🔒 | Uploader, admin of the source server, or owner. |
| `/sb list` | List sounds. Filtered by `view_scope`: `global` shows all public; `guild` shows only this server's uploads. |
| `/sb stop` 🔒 | Admins: stop immediately. Users: start a 20%-vote button with 30s window. |
| `/sb pause` / `/sb resume` | Initiator + admins instant; other VC members can vote. Bot disconnects 2 minutes after a pause if not resumed. |
| `/sb storage` | Show used/total GB, sound count, warn threshold (with override marks). |
| `/sb admin add\|remove\|list user:<@user>` 🔒 | Manage **per-server** bot admin list. Owner is implicit admin everywhere. |
| `/sb settings view\|set\|unset key:<choice> [value:<text>]` 🔒 | Per-server runtime settings. Some keys are owner-only. |

Autocomplete is enabled on the `name` option for every command that takes one. Lookups use a canonical match form so users can type the name with any combination of spaces, hyphens, and underscores. Tag inputs (`/sb playlist tag:`, `/sb tag remove tag:`) also autocomplete against the current `view_scope`.

---

## Admin System

Admins are **per-server**. The bot has two independent layers and a per-server toggle that picks which one applies.

1. **Bot owner** — `OWNER_ID` from `.env`. Always admin in every server. Can never be removed. Only role allowed to change `admin_mode` and `storage_*_gb_override` settings.
2. **Bot admins (per server)** — users added via `/sb admin add` *in that server*, stored in `bot_admins (guild_id, user_id, …)`. Used when a server's `admin_mode` setting is `bot` (the default).
3. **Server admins** — users with Discord's `ADMINISTRATOR` permission in that server. Used when `admin_mode` is `server`.

`isAdmin(guild, userId)` in `src/admins.js` is the single dispatcher: it returns `true` for the owner, then reads the guild's `admin_mode` setting and consults either `isBotAdmin` or `isServerAdmin`.

Admin powers (within a server):
- Stop / pause / resume playback instantly
- Override the channel lock when using `/sb play` from a different VC
- Delete any sound uploaded *from that server* (the owner can delete from anywhere)
- Add/remove other bot admins for that server
- Receive storage warning DMs (at the effective warn cap)

---

## Permission / Channel-Lock Rules

- When the bot is playing in channel A:
  - User in channel A runs `/sb play` → allowed (overlap).
  - User in channel B runs `/sb play` → rejected with "Bot is playing in #A".
  - Admin in channel B runs `/sb play` → **admin priority**: current session is stopped, bot moves to channel B, new sound plays.
- `/sb stop`:
  - Admin → stops instantly.
  - User → starts a vote (button click). Needed votes = `ceil(humans_in_channel * 0.20)` (min 1). 30s expiry. Voters must be in the active VC.
- Auto-disconnect when all sounds finish.

---

## Storage Warning & Hard Lock

- **Warn (1GB):** After any successful upload, total size is checked. If it crosses `STORAGE_WARN_GB`, DMs are sent to:
  - The bot owner (`OWNER_ID` env var)
  - Every member of the current guild with the `ADMINISTRATOR` permission
  - A sent-flag prevents spamming DMs on every upload; it resets if the total drops back below the warn threshold (e.g. after a delete).
- **Hard lock (5GB):** If total size is at or above `STORAGE_HARD_GB`, `/sb upload` is rejected with a message.

---

## Directory Layout

```
Soundboard Bot/
├── src/
│   ├── index.js              # Entry: register slash commands, login
│   ├── bot.js                # Client setup, interaction dispatcher
│   ├── config.js             # Env var loading + validation
│   ├── logger.js             # Diagnostic logger (console + general.log)
│   ├── storage.js            # Size checks, warning DM broadcaster
│   ├── admins.js             # Bot admin helper (isAdmin/addAdmin/…)
│   ├── db/
│   │   └── database.js       # SQLite schema + prepared queries
│   ├── audio/
│   │   ├── converter.js      # ffmpeg probe + convert to Opus OGG
│   │   ├── mixer.js          # PCM mixing Readable stream
│   │   └── player.js         # Voice connection / session management
│   └── commands/
│       ├── index.js          # Slash command definition (/sb with subcommands)
│       ├── upload.js
│       ├── play.js
│       ├── quickplay.js      # /sb quickplay — transient YouTube playback
│       ├── tag.js            # /sb tag add|remove|list
│       ├── taggedplaylist.js # /sb playlist
│       ├── delete.js
│       ├── list.js
│       ├── stop.js
│       ├── storage.js
│       └── admin.js          # /sb admin add|remove|list
├── .github/workflows/
│   └── docker.yml            # Build + publish image to ghcr.io on push
├── sounds/                   # Volume: converted .ogg files
├── data/                     # Volume: sounds.db (+ temp/ for uploads)
├── logs/                     # Volume: general.log
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
└── PROJECT_PLAN.md
```

---

## Database Schema

```sql
CREATE TABLE sounds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  filename         TEXT NOT NULL,            -- stored filename in /sounds
  uploader_id      TEXT NOT NULL,            -- Discord user ID
  uploader_tag     TEXT NOT NULL,
  guild_id         TEXT NOT NULL,            -- Guild where uploaded (metadata)
  duration_seconds REAL NOT NULL,
  file_size_bytes  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE admins (
  user_id   TEXT PRIMARY KEY,
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL
);

CREATE TABLE sound_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sound_id    INTEGER NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL COLLATE NOCASE,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (sound_id, tag)
);
```

Sounds are **global across all guilds** — names are unique everywhere the bot runs.
Admins are also global — the bot is designed for a single deployment where admin status applies everywhere.

---

## Logging

- Console + `/app/logs/general.log`
- Every significant action: `INFO`, `OK`, `FAIL`, `WARN`, `ERROR`, `SKIP`
- Structured as: `[timestamp] [LEVEL] message {json-metadata}`
- Never logs tokens or raw user attachment URLs (only IDs and result codes)

---

## Deployment (Unraid)

1. Clone the repo somewhere on the Unraid server (e.g. `/mnt/user/appdata/soundboard-bot/`).
2. Copy `.env.example` → `.env`, fill in `DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_ID`.
3. `docker compose up -d --build`
4. The `sounds/`, `data/`, and `logs/` directories on the host are bind-mounted into the container, so uploads and the DB persist across restarts and image rebuilds.

---

## Session Notes

### 2026-04-10 — Initial build
- Initial scaffolding, all commands, PCM mixer, Docker setup.
- Refactored admin model: dropped Discord guild `ADMINISTRATOR` permission checks entirely. Introduced `admins` table + `isAdmin()` helper + `/sb admin` subcommand group. Bot owner (`OWNER_ID` env) is always admin and immutable; other admins are stored in SQLite.
- Dropped the privileged `GuildMembers` intent — no longer needed after the admin refactor, simpler bot setup.
- Added `.github/workflows/docker.yml` to auto-build and push to ghcr.io on every push to `main`.
- Added `docker-compose.prod.yml` for pulling pre-built images on Unraid.

### 2026-04-16 — Tags, playlists, quickplay
- New `sound_tags` table (unique on `(sound_id, tag)`, FK-cascade on sound delete, case-insensitive index on `tag`). Tags are lowercase `[a-zA-Z0-9_-]{1,32}`, max 10 per sound.
- New commands: `/sb tag add|remove|list`, `/sb playlist tag:`, `/sb quickplay youtube_url:`. Sequencing for the playlist reuses the mixer via a new `options.onComplete` callback threaded through `playSound` → `mixer.addSource.onFinish`.
- `/sb quickplay` runs the same yt-dlp caps as `/sb upload` (owner unlimited, admin 200 MB / no duration cap, user 100 MB / `max_duration_seconds`). The temp file lives under `data/temp/` and is deleted by the `onComplete` hook.
- Admins now bypass the storage hard cap in `/sb upload` (previously owner-only). Soft-cap DM warnings are unchanged.
- Tag inputs get autocomplete; `name` autocomplete was already wired.
- Naming: new files keep to the existing camelCase convention throughout.

### 2026-04-10 — Per-guild rework + edit/cut/pause
- Per-guild settings layer (`guild_settings` table + `src/settings.js`) with env values as defaults. Settable keys: `max_file_size_mb`, `max_duration_seconds`, `max_sounds_per_user`, `spam_pool_size`, `upload_scope`, `view_scope`, `admin_mode`, `storage_warn_gb_override`, `storage_hard_gb_override`. The two storage overrides and `admin_mode` are owner-only.
- Admin model is now fully per-guild. Old global `admins` table is left behind (read-only) and superseded by `bot_admins (guild_id, user_id, …)`. New `isAdmin(guild, userId)` dispatches on the guild's `admin_mode` between bot-admin list and Discord `ADMINISTRATOR` perm. Owner is implicit admin everywhere and the only role that can change `admin_mode` / storage overrides.
- Two independent visibility settings: `upload_scope` (`global`/`private`) tags new uploads; `view_scope` (`global`/`guild`) controls what `/sb list`, autocomplete, and `/sb play` see. Sounds keep the tag they were uploaded with.
- Storage cap override: when set on a guild it **fully replaces** the env hard/warn cap for that guild's uploads. Both env and overrides are clamped to an absolute 10 GB ceiling (`STORAGE_ABSOLUTE_CEILING_GB`). Float decimals supported (`0.5`, `1.25`, etc.).
- New commands: `/sb edit` (rename, uploader/owner only), `/sb cut` (in-place ffmpeg trim, uploader/owner only), `/sb pause` and `/sb resume` (initiator + admins instant, others vote — 20% / 30s, mirrors `/sb stop`). Pause idle timer disconnects after 2 minutes if not resumed.
- Vote logic extracted to `src/voteHelper.js`, reused by `/sb stop`, `/sb pause`, `/sb resume` with kind-prefixed customIds.
- Name handling normalized via new `src/names.js`: `storeName` (input → kebab-case, strict charset), `displayName` (kebab/underscore → spaces), `canonicalize`/`matchName` (loose lookup form). New `match_name` column on `sounds` (UNIQUE) backfilled on migration; lookups use it everywhere so users can type names with any combination of spaces, hyphens, or underscores.
- Delete permissions are now layered: owner → any sound; uploader → own; admin of source guild → only sounds uploaded from that guild **and only while acting in that guild**.
- `/sb` and `/soundboard` are registered as twin command trees from a single builder factory. Admin-only subcommands carry a 🔒 marker in their description (Discord can't hide individual subcommands by permission).
- Audio trim helper at `src/audio/trim.js` uses `ffmpeg -ss <start> -to <end> -i <in> -c:a libopus -b:a 128k -ar 48000 -ac 2 -f ogg`, atomically replaces the original on success, re-probes duration, and updates the DB row.
- Open questions for next session:
  - Verify mixer timing on real Discord voice (local testing).
  - Consider rate limiting on `/sb play` to prevent spam-overlap abuse.
  - Consider pagination buttons on `/sb list` if sound count grows beyond ~50.
  - Drop the legacy `admins` table once it's been verified that no deployment still depends on it.
