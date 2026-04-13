import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { isOwner } from '../admins.js';
import { canonicalize, displayName } from '../names.js';
import { trimOpus, parseTimeString } from '../audio/trim.js';
import { probeDuration } from '../audio/converter.js';
import { formatBytes } from '../storage.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Trim. Permission: uploader OR bot owner. Replaces the original file in
// place; on any failure the original is left intact.
export async function handleCut(interaction) {
  await interaction.deferReply({ flags: replyFlags(interaction) });

  const rawName = interaction.options.getString('name', true);
  const sound = queries.getByMatch.get(canonicalize(rawName));
  if (!sound) {
    return interaction.editReply(`No sound named **${rawName}**.`);
  }

  const actor = interaction.user.id;
  if (sound.uploader_id !== actor && !isOwner(actor)) {
    return interaction.editReply(
      `You can only cut sounds you uploaded. **${displayName(sound.name)}** was uploaded by <@${sound.uploader_id}>.`
    );
  }

  const originalDuration = sound.duration_seconds;
  const durationLabel =
    `**${displayName(sound.name)}** is currently **${originalDuration.toFixed(3)}s** long.`;

  const rawStart = interaction.options.getString('start');
  const rawEnd = interaction.options.getString('end');

  if (!rawStart && !rawEnd) {
    return interaction.editReply(
      `${durationLabel}\nProvide at least \`start\` or \`end\`. Use seconds like \`12.500\` or \`0.250\`, or \`MM:SS\` / \`HH:MM:SS\`.`
    );
  }
  const start = rawStart ? parseTimeString(rawStart) : 0;
  const end = rawEnd ? parseTimeString(rawEnd) : sound.duration_seconds;
  if (start === null || end === null) {
    return interaction.editReply(
      `${durationLabel}\nUse seconds like \`12.500\` or \`0.250\`, or \`MM:SS\` / \`HH:MM:SS\`.`
    );
  }
  if (start < 0 || end <= start) {
    return interaction.editReply(
      `${durationLabel}\n\`start\` must be 0 or more, and \`end\` must be greater than \`start\`.`
    );
  }
  if (end > sound.duration_seconds + 0.05) {
    return interaction.editReply(
      `${durationLabel}\n\`end\` (${end.toFixed(3)}s) is past the sound's length.`
    );
  }

  const sourcePath = path.join(config.soundsDir, sound.filename);
  if (!fs.existsSync(sourcePath)) {
    logger.error('cut: source file missing', { filename: sound.filename });
    return interaction.editReply(`The file for **${displayName(sound.name)}** is missing from disk.`);
  }

  fs.mkdirSync(config.soundsDir, { recursive: true });
  const tempOut = path.join(config.soundsDir, `${crypto.randomBytes(8).toString('hex')}-cut.tmp.ogg`);

  try {
    await trimOpus(sourcePath, tempOut, start, end);

    // Re-probe duration from the trimmed file rather than trusting the
    // requested range — ffmpeg may snap to keyframes for tiny inputs.
    const newDuration = await probeDuration(tempOut);
    const newStats = fs.statSync(tempOut);

    replaceFile(tempOut, sourcePath);
    queries.updateAfterTrim.run(newDuration, newStats.size, sound.id);

    logger.ok('sound trimmed', {
      id: sound.id,
      name: sound.name,
      start,
      end,
      originalDuration,
      newDuration,
      newSize: newStats.size,
      by: actor
    });

    await interaction.editReply(
      `✂ Cut **${displayName(sound.name)}** from ${start.toFixed(3)}s to ${end.toFixed(3)}s.\n` +
        `Duration: **${originalDuration.toFixed(3)}s** → **${newDuration.toFixed(3)}s** (${formatBytes(newStats.size)}).`
    );
  } catch (err) {
    logger.error('cut failed', { id: sound.id, err: err.message });
    safeUnlink(tempOut);
    await interaction.editReply(`Trim failed: ${err.message}`);
  }
}

function safeUnlink(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger.warn('cut: temp unlink failed', { path: p, err: err.message });
  }
}

function replaceFile(tempPath, destinationPath) {
  try {
    fs.renameSync(tempPath, destinationPath);
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }

    fs.copyFileSync(tempPath, destinationPath);
    safeUnlink(tempPath);
  }
}
