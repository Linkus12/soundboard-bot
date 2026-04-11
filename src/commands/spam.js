import path from 'node:path';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { getSession, playSound, stopSession, markSpamming } from '../audio/player.js';
import { isAdmin } from '../admins.js';
import { getSetting } from '../settings.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Hard stop duration. Every spam run gets cut off after this many ms so the
// bot never turns into a permanent wall of noise.
const SPAM_DURATION_MS = 7000;

// Concurrent ffmpeg source cap. Each sound spawns its own decoder process,
// so unbounded spam could exhaust file descriptors or pin the CPU. 100 is
// comfortably above a typical soundboard while still being survivable.
const SPAM_MAX_SOUNDS = 100;

export async function handleSpam(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  if (!isAdmin(guild, member.id)) {
    return interaction.reply({
      content: 'Only admins can use `/sb spam`.',
      flags: replyFlags(interaction)
    });
  }

  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: 'You need to be in a voice channel to spam.',
      flags: replyFlags(interaction)
    });
  }

  const me = await guild.members.fetchMe();
  const perms = voiceChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({
      content: `I don't have permission to connect or speak in <#${voiceChannel.id}>.`,
      flags: replyFlags(interaction)
    });
  }

  // Respect view_scope so spam can only use sounds that /sb play could use
  // from this guild — guild-only sees just this guild's uploads, global sees
  // every public sound.
  const viewScope = getSetting(guild.id, 'view_scope');
  const allSounds =
    viewScope === 'guild'
      ? queries.getAllForGuild.all(guild.id)
      : queries.getAllGlobal.all();

  if (allSounds.length === 0) {
    return interaction.reply({
      content: 'No sounds available to spam.',
      flags: replyFlags(interaction)
    });
  }

  // Admin override: if a session is already running in a different channel,
  // tear it down before starting the spam. Same pattern as /sb play.
  const existing = getSession(guild.id);
  if (existing && existing.channelId !== voiceChannel.id) {
    logger.info('admin overriding channel lock for spam', {
      guildId: guild.id,
      from: existing.channelId,
      to: voiceChannel.id,
      userId: member.id
    });
    stopSession(guild.id, 'admin-spam-override');
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  await interaction.deferReply({ flags: replyFlags(interaction) });

  const sounds = allSounds.slice(0, SPAM_MAX_SOUNDS);
  const skipped = allSounds.length - sounds.length;

  let started = 0;
  let missing = 0;
  let failed = 0;

  for (const sound of sounds) {
    const filePath = path.join(config.soundsDir, sound.filename);
    if (!fs.existsSync(filePath)) {
      missing++;
      logger.warn('spam: sound file missing from disk', {
        name: sound.name,
        filename: sound.filename
      });
      continue;
    }
    try {
      await playSound(guild, voiceChannel, filePath, sound.name, member.id);
      started++;
    } catch (err) {
      failed++;
      logger.error('spam: play failed', { name: sound.name, err: err.message });
    }
  }

  if (started === 0) {
    logger.fail('spam: nothing playable', {
      guildId: guild.id,
      userId: member.id,
      missing,
      failed
    });
    return interaction.editReply('Spam failed — no sounds could be played.');
  }

  // Capture the session object so the timeout only tears down THIS spam run.
  // If the session drains / someone else stops it / a new one starts before
  // our timeout fires, the identity check keeps us from clobbering it.
  const spamSession = getSession(guild.id);

  // Flip the presence into spam mode so it shows "💣 Spamming #channel"
  // instead of flickering through 13 different sound names.
  markSpamming(guild.id, true);

  setTimeout(() => {
    const current = getSession(guild.id);
    if (current && current === spamSession) {
      stopSession(guild.id, 'spam-timeout');
      logger.ok('spam ended', { guildId: guild.id });
    }
  }, SPAM_DURATION_MS);

  logger.ok('spam started', {
    guildId: guild.id,
    userId: member.id,
    started,
    missing,
    failed,
    skipped,
    durationMs: SPAM_DURATION_MS
  });

  const noteParts = [];
  if (missing > 0) noteParts.push(`${missing} missing from disk`);
  if (failed > 0) noteParts.push(`${failed} failed`);
  if (skipped > 0) noteParts.push(`${skipped} skipped (over ${SPAM_MAX_SOUNDS} cap)`);
  const note = noteParts.length ? ` *(${noteParts.join(', ')})*` : '';

  return interaction.editReply(
    `💣 Spamming **${started}** sounds for **${SPAM_DURATION_MS / 1000}s**${note}.`
  );
}
