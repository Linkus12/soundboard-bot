import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { getSession, playSound, stopSession } from '../audio/player.js';
import { isAdmin, isOwner } from '../admins.js';
import { getSetting } from '../settings.js';
import { formatBytes } from '../storage.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

const YOUTUBE_REGEX =
  /^(https?:\/\/)?((?:www\.|m\.|music\.)?youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/)[\w-]+/;

// Caps for temp downloads. Same logic as upload.
const ADMIN_HARD_CAP_BYTES = 200 * 1024 * 1024; // 200 MB
const USER_INPUT_CAP_BYTES = 100 * 1024 * 1024; // 100 MB

export async function handleQuickPlay(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  const owner = isOwner(interaction.user.id);
  const admin = isAdmin(guild, interaction.user.id);

  const youtubeUrl = interaction.options.getString('youtube_url', true);
  if (!YOUTUBE_REGEX.test(youtubeUrl)) {
    return interaction.reply({
      content: 'Dumbahhh that\'s not a valid YouTube URL!',
      flags: replyFlags(interaction)
    });
  }

  const userVoice = member.voice?.channel;
  const providedChannel = interaction.options.getChannel('channel');

  let targetChannel;
  if (providedChannel) {
    const userPerms = providedChannel.permissionsFor(member);
    if (!userPerms?.has(PermissionFlagsBits.ViewChannel) || !userPerms?.has(PermissionFlagsBits.Connect)) {
      return interaction.reply({
        content: `Yeah... I don't think you have permissions to join <#${providedChannel.id}> pal.`,
        flags: replyFlags(interaction)
      });
    }
    targetChannel = providedChannel;
  } else if (userVoice) {
    targetChannel = userVoice;
  } else {
    return interaction.reply({
      content: 'You need to be in a voice channel or pass me a channel to join, "Oh yeah bro just play sound" -"Okay where?" "-Mhm". Dumbass.',
      flags: replyFlags(interaction)
    });
  }

  const me = await guild.members.fetchMe();
  const perms = targetChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({
      content: `I don't have access to <#${targetChannel.id}>, you know that... Right?`,
      flags: replyFlags(interaction)
    });
  }

  const session = getSession(guild.id);
  if (session && session.channelId !== targetChannel.id) {
    if (admin) {
      stopSession(guild.id, 'admin-override');
      await new Promise(resolve => setTimeout(resolve, 300));
    } else {
      return interaction.reply({
        content: `Yeah nahhhh I'm currently playing in <#${session.channelId}>. Wait for me to finish, uno moment, thankie.`,
        flags: replyFlags(interaction)
      });
    }
  }

  await interaction.deferReply({ flags: replyFlags(interaction) });

  const tempDir = path.join(config.dataDir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempId = crypto.randomBytes(8).toString('hex');

  const maxSizeBytes = owner ? null : admin ? ADMIN_HARD_CAP_BYTES : USER_INPUT_CAP_BYTES;
  const maxDurationSeconds = getSetting(guild.id, 'max_duration_seconds');
  const durationCapSeconds = owner || admin ? null : maxDurationSeconds;

  let tempFile = null;
  try {
    tempFile = await downloadYouTube(youtubeUrl, tempDir, tempId, maxSizeBytes, durationCapSeconds);
  } catch (err) {
    logger.fail('quickplay download failed', { url: youtubeUrl, error: err.message });
    return interaction.editReply(err.userMessage || 'Could not download that YouTube video... Oops ;3');
  }

  const displayUrl = youtubeUrl.length > 50 ? youtubeUrl.slice(0, 47) + '...' : youtubeUrl;
  const stats = fs.statSync(tempFile);

  try {
    // ffmpeg decodes whatever yt-dlp returns, so we play the temp file directly — no conversion.
    await playSound(
      guild,
      targetChannel,
      tempFile,
      `quickplay: ${displayUrl}`,
      member.id,
      {
        onComplete: () => {
          safeUnlink(tempFile);
          logger.ok('quickplay temp file cleaned up', { tempId });
        }
      }
    );
  } catch (err) {
    safeUnlink(tempFile);
    logger.error('quickplay failed to play', { err: err.message });
    return interaction.editReply(`Failed to play: ${err.message}`);
  }

  const remoteNote = (!userVoice || userVoice.id !== targetChannel.id)
    ? ` in <#${targetChannel.id}>`
    : '';
  await interaction.editReply(
    `Quickplaying **${displayUrl}**${remoteNote} — ${formatBytes(stats.size)} (temp, auto-deleted).`
  );
}

function downloadYouTube(url, tempDir, tempId, maxSizeBytes, durationCapSeconds) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(tempDir, `${tempId}.%(ext)s`);
    const args = ['--no-playlist', '--format', 'bestaudio', '--output', outputTemplate];

    if (maxSizeBytes != null) args.push('--max-filesize', `${maxSizeBytes}`);
    if (durationCapSeconds != null) args.push('--match-filter', `duration <= ${durationCapSeconds}`);

    args.push(url);
    logger.info('quickplay yt-dlp download starting', { url, maxSizeBytes, durationCapSeconds });
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', () => {
      const e = new Error('yt-dlp not available');
      e.userMessage = 'yt-dlp is not installed on this bot. Contact your admin.';
      reject(e);
    });

    proc.on('close', code => {
      if (code !== 0) {
        logger.fail('quickplay yt-dlp failed', { code, stderr: stderr.slice(0, 500) });
        const e = new Error(`yt-dlp exited ${code}`);
        if (stderr.includes('does not pass filter')) {
          e.userMessage = `That video is too long. Max is **${durationCapSeconds}s**.`;
        } else if (stderr.includes('File is larger than max-filesize')) {
          e.userMessage = `That video's audio is too large to download.`;
        } else {
          e.userMessage = 'Could not download that YouTube video. It may be private, age-restricted, or unavailable.';
        }
        return reject(e);
      }

      const downloaded = fs.readdirSync(tempDir).find(f => f.startsWith(tempId)) ?? null;
      if (!downloaded) {
        const e = new Error('no output file after yt-dlp');
        e.userMessage = 'Download appeared to succeed but no audio file was produced.';
        return reject(e);
      }

      logger.ok('quickplay download complete', { file: downloaded });
      resolve(path.join(tempDir, downloaded));
    });
  });
}

function safeUnlink(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger.warn('quickplay: temp unlink failed', { path: p, err: err.message });
  }
}
