import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { probeDuration, convertToOpus } from '../audio/converter.js';
import {
  getTotalBytes,
  getHardLimitBytes,
  checkStorageWarning,
  formatBytes
} from '../storage.js';
import { isAdmin } from '../admins.js';
import { logger } from '../logger.js';

const NAME_REGEX = /^[\w-]{1,32}$/;
// Hardcoded absolute ceiling — applies even to admins.
const ADMIN_HARD_CAP_MB = 200;
const ADMIN_HARD_CAP_BYTES = ADMIN_HARD_CAP_MB * 1024 * 1024;
// Raw pre-conversion input cap for regular users.
const USER_INPUT_CAP_BYTES = 100 * 1024 * 1024;

export async function handleUpload(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const attachment = interaction.options.getAttachment('file');
  const admin = isAdmin(interaction.user.id);

  // --- Normalize & validate name -------------------------------------------
  // Accept names with spaces, collapse runs of whitespace into a single underscore.
  const rawName = interaction.options.getString('name').trim();
  const name = rawName.replace(/\s+/g, '_');

  if (!NAME_REGEX.test(name)) {
    return interaction.editReply(
      'Name must be 1-32 characters. Allowed: letters, numbers, underscores, hyphens, and spaces (spaces become underscores).'
    );
  }

  if (queries.getByName.get(name)) {
    return interaction.editReply(`A sound named **${name}** already exists. Pick a different name.`);
  }

  // --- Check user's personal upload cap (admins bypass) --------------------
  if (!admin) {
    const userCount = queries.countByUploader.get(interaction.user.id).count;
    if (userCount >= config.maxSoundsPerUser) {
      return interaction.editReply(
        `You've reached the max of **${config.maxSoundsPerUser}** uploaded sounds. ` +
          `Use \`/sb delete\` to remove some first.`
      );
    }
  }

  // --- Storage hard lock (applies to everyone, even admins) ----------------
  const totalBytes = getTotalBytes();
  if (totalBytes >= getHardLimitBytes()) {
    logger.warn('upload blocked — storage hard cap reached', {
      userId: interaction.user.id,
      total: totalBytes,
      asAdmin: admin
    });
    return interaction.editReply(
      `🚫 Storage is full (**${formatBytes(totalBytes)}** / ${config.storageHardGB} GB hard limit). ` +
        `Delete some sounds before uploading.`
    );
  }

  // --- Raw attachment sanity ------------------------------------------------
  // Admins: up to the hardcoded 200MB absolute ceiling.
  // Users: up to USER_INPUT_CAP_BYTES (100MB).
  const maxInputBytes = admin ? ADMIN_HARD_CAP_BYTES : USER_INPUT_CAP_BYTES;
  if (attachment.size > maxInputBytes) {
    return interaction.editReply(
      `Input file too large (${formatBytes(attachment.size)}). Max for ${
        admin ? 'admins' : 'users'
      } is ${formatBytes(maxInputBytes)}.`
    );
  }

  // --- Download to temp -----------------------------------------------------
  const tempDir = path.join(config.dataDir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(config.soundsDir, { recursive: true });

  const tempId = crypto.randomBytes(8).toString('hex');
  const inputExt = path.extname(attachment.name || '').toLowerCase() || '.bin';
  const tempInput = path.join(tempDir, `${tempId}${inputExt}`);

  let outPath = null;

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tempInput, buffer);

    // --- Probe duration -----------------------------------------------------
    let duration;
    try {
      duration = await probeDuration(tempInput);
    } catch (err) {
      safeUnlink(tempInput);
      return interaction.editReply(
        `Could not read that file. Make sure it's a valid audio or video file.`
      );
    }

    // Admins bypass the duration cap entirely (limited only by the 200MB file ceiling).
    if (!admin && duration > config.maxDurationSeconds) {
      safeUnlink(tempInput);
      return interaction.editReply(
        `Sound is too long: **${duration.toFixed(1)}s**. Max is **${config.maxDurationSeconds}s**.`
      );
    }

    // --- Convert to Opus OGG -----------------------------------------------
    const outFilename = `${crypto.randomBytes(12).toString('hex')}.ogg`;
    outPath = path.join(config.soundsDir, outFilename);

    try {
      await convertToOpus(tempInput, outPath);
    } catch (err) {
      safeUnlink(tempInput);
      safeUnlink(outPath);
      logger.fail('upload conversion failed', {
        userId: interaction.user.id,
        err: err.message
      });
      return interaction.editReply(`Audio conversion failed. The file may be corrupted.`);
    }

    safeUnlink(tempInput);

    // --- Post-conversion size check ----------------------------------------
    // Admins: capped at the hardcoded 200MB ceiling.
    // Users: capped at config.maxFileSizeMB.
    const stats = fs.statSync(outPath);
    const maxBytes = admin ? ADMIN_HARD_CAP_BYTES : config.maxFileSizeMB * 1024 * 1024;
    if (stats.size > maxBytes) {
      safeUnlink(outPath);
      return interaction.editReply(
        `Converted file is too large: **${formatBytes(stats.size)}**. Max for ${
          admin ? `admins is ${ADMIN_HARD_CAP_MB} MB` : `users is ${config.maxFileSizeMB} MB`
        }.`
      );
    }

    // --- Persist to DB ------------------------------------------------------
    queries.insert.run(
      name,
      outFilename,
      interaction.user.id,
      interaction.user.tag,
      interaction.guild.id,
      duration,
      stats.size,
      Date.now()
    );

    logger.ok('sound uploaded', {
      name,
      userId: interaction.user.id,
      size: stats.size,
      duration,
      asAdmin: admin
    });

    const renamed = name !== rawName ? ` (stored as **${name}**)` : '';
    await interaction.editReply(
      `✅ Uploaded **${name}**${renamed} — ${duration.toFixed(1)}s, ${formatBytes(stats.size)}.\n` +
        `Play it with \`/sb play name:${name}\`.`
    );

    // --- Storage warning check (fire and forget) ---------------------------
    checkStorageWarning(interaction.client).catch(err =>
      logger.error('storage warning check failed', { err: err.message })
    );
  } catch (err) {
    logger.error('upload failed', {
      userId: interaction.user.id,
      err: err.message,
      stack: err.stack
    });
    safeUnlink(tempInput);
    if (outPath) safeUnlink(outPath);
    try {
      await interaction.editReply('Upload failed due to an unexpected error. Check the logs.');
    } catch {}
  }
}

function safeUnlink(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger.warn('unlink failed', { path: p, err: err.message });
  }
}
