import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { probeDuration, convertToOpus } from '../audio/converter.js';
import {
  getTotalBytes,
  getEffectiveHardLimitBytes,
  checkStorageWarning,
  formatBytes
} from '../storage.js';
import { isAdmin, isOwner } from '../admins.js';
import { getSetting } from '../settings.js';
import { storeName, displayName, canonicalize } from '../names.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Hardcoded absolute ceiling — applies even to admins.
const ADMIN_HARD_CAP_MB = 200;
const ADMIN_HARD_CAP_BYTES = ADMIN_HARD_CAP_MB * 1024 * 1024;
// Raw pre-conversion input cap for regular users.
const USER_INPUT_CAP_BYTES = 100 * 1024 * 1024;

const YOUTUBE_REGEX =
  /^(https?:\/\/)?((?:www\.|m\.|music\.)?youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/)[\w-]+/;

export async function handleUpload(interaction) {
  await interaction.deferReply({ flags: replyFlags(interaction) });

  const attachment = interaction.options.getAttachment('file');
  const youtubeUrl = interaction.options.getString('youtube_url');

  const guild = interaction.guild;
  const owner = isOwner(interaction.user.id);
  const admin = isAdmin(guild, interaction.user.id);

  // --- Must provide exactly one source -------------------------------------
  if (!attachment && !youtubeUrl) {
    return interaction.editReply('You must provide either a **file** attachment or a **YouTube URL**, I\'m not a magician!');
  }
  if (attachment && youtubeUrl) {
    return interaction.editReply('Provide either a file **or** a YouTube URL, not both, what are you trying to do? Overload me??');
  }
  if (youtubeUrl && !YOUTUBE_REGEX.test(youtubeUrl)) {
    return interaction.editReply("That doesn't look like a valid YouTube URL. So close though! I believe that you can find the right one if you try again!");
  }

  // --- Normalize & validate name -------------------------------------------
  // Accept anything reasonable; storeName turns it into kebab-case and
  // rejects empty/over-long/illegal results.
  const rawName = interaction.options.getString('name');
  let name;
  try {
    name = storeName(rawName);
  } catch (err) {
    return interaction.editReply(err.message);
  }

  // Uniqueness check goes through the loose canonical form.
  if (queries.getByMatch.get(canonicalize(name))) {
    return interaction.editReply(
      `A sound named **${displayName(name)}** already exists. Try to be more creative next time and pick a different name ;/`
    );
  }

  // --- Per-guild settings -------------------------------------------------
  const maxSoundsPerUser = getSetting(guild.id, 'max_sounds_per_user');
  const maxDurationSeconds = getSetting(guild.id, 'max_duration_seconds');
  const maxFileSizeMB = getSetting(guild.id, 'max_file_size_mb');
  const uploadScope = getSetting(guild.id, 'upload_scope');

  // --- Check user's personal upload cap (admins & owner bypass) -----------
  if (!admin && !owner) {
    const userCount = queries.countByUploader.get(interaction.user.id).count;
    if (userCount >= maxSoundsPerUser) {
      return interaction.editReply(
        `You've reached the max of **${maxSoundsPerUser}** uploaded sounds. Brother don't you got a life outside of uploading soundboards???` +
          `Use \`/sb delete\` to remove some first.`
      );
    }
  }

  // --- Storage hard lock (applies to everyone except the bot owner) --------
  const totalBytes = getTotalBytes();
  const hardLimitBytes = getEffectiveHardLimitBytes(guild.id);
  if (!owner && !admin && totalBytes >= hardLimitBytes) {
    logger.warn('upload blocked — storage hard cap reached', {
      userId: interaction.user.id,
      total: totalBytes,
      hardLimit: hardLimitBytes,
      asAdmin: admin
    });
    return interaction.editReply(
      `🚫 Storage is full (**${formatBytes(totalBytes)}** / ${formatBytes(hardLimitBytes)} hard limit). ` +
        `Delete some sounds before uploading. Or... Just pray someone else deletes some sounds before you try again 🙏`
    );
  }

  // --- Raw attachment sanity (YouTube skips this; no known size yet) ----------------
  // Owner: no cap at all.
  // Admins: up to the hardcoded 200MB absolute ceiling.
  // Users: up to USER_INPUT_CAP_BYTES (100MB).
  if (attachment && !owner) {
    const maxInputBytes = admin ? ADMIN_HARD_CAP_BYTES : USER_INPUT_CAP_BYTES;
    if (attachment.size > maxInputBytes) {
      return interaction.editReply(
        `Input file too large (${formatBytes(attachment.size)}). Max for ${
          admin ? 'admins' : 'users'
        } is ${formatBytes(maxInputBytes)}.`
      );
    }
  }

  // --- Download to temp -----------------------------------------------------
  const tempDir = path.join(config.dataDir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(config.soundsDir, { recursive: true });

  const tempId = crypto.randomBytes(8).toString('hex');
  let tempInput = null;

  let outPath = null;

  try {
    if (attachment) {
      const inputExt = path.extname(attachment.name || '').toLowerCase() || '.bin';
      tempInput = path.join(tempDir, `${tempId}${inputExt}`);
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tempInput, buffer);
    } else {
      // Owner: no caps. Admins: 200MB ceiling, no duration cap. Users: 100MB + duration cap.
      const maxSizeBytes = owner ? null : admin ? ADMIN_HARD_CAP_BYTES : USER_INPUT_CAP_BYTES;
      const durationCapSeconds = owner || admin ? null : maxDurationSeconds;
      tempInput = await downloadYouTube(youtubeUrl, tempDir, tempId, maxSizeBytes, durationCapSeconds);
    }

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

    // Admins & owner bypass the duration cap entirely.
    if (!admin && !owner && duration > maxDurationSeconds) {
      safeUnlink(tempInput);
      return interaction.editReply(
        `Sound is too long: **${duration.toFixed(1)}s**. Max is **${maxDurationSeconds}s**. I ain't got all day to listen to this goofy goober ahh sound.`
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
    // Owner: no cap.
    // Admins: capped at the hardcoded 200MB ceiling.
    // Users: capped at the per-guild max_file_size_mb setting.
    const stats = fs.statSync(outPath);
    if (!owner) {
      const maxBytes = admin ? ADMIN_HARD_CAP_BYTES : maxFileSizeMB * 1024 * 1024;
      if (stats.size > maxBytes) {
        safeUnlink(outPath);
        return interaction.editReply(
          `Converted file is too large: **${formatBytes(stats.size)}**. Max for ${
            admin ? `admins is ${ADMIN_HARD_CAP_MB} MB` : `users is ${maxFileSizeMB} MB`
          }.`
        );
      }
    }

    // --- Persist to DB ------------------------------------------------------
    const isPrivate = uploadScope === 'private' ? 1 : 0;
    queries.insert.run(
      name,
      canonicalize(name),
      outFilename,
      interaction.user.id,
      interaction.user.tag,
      guild.id,
      duration,
      stats.size,
      Date.now(),
      isPrivate
    );

    logger.ok('sound uploaded', {
      name,
      userId: interaction.user.id,
      size: stats.size,
      duration,
      asAdmin: admin,
      isPrivate,
      source: youtubeUrl ? 'youtube' : 'file'
    });

    const display = displayName(name);
    const scopeLabel = isPrivate ? ' *(private to this server)*' : '';
    await interaction.editReply(
      `✅ Uploaded **${display}**${scopeLabel} — ${duration.toFixed(1)}s, ${formatBytes(stats.size)}.\n` +
        `Play it with \`/sb play name:${display}\`.`
    );

    // --- Storage warning check (fire and forget) ---------------------------
    checkStorageWarning(interaction.client, guild.id).catch(err =>
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
      const finalMessage = err.userMessage || "I may be a bit dumb... Upload failed due to an unexpected error. Check the logs ;>";

      await ReplyInChunks(interaction, finalMessage);
    } catch (replyErr) {
      logger.error('failed to send upload error message', { err: replyErr.message });
    }
  }
}

/**
 * Download audio from a YouTube URL using yt-dlp.
 * maxSizeBytes and durationCapSeconds are enforced by yt-dlp before the
 * download completes, so we don't pull a 3-hour video only to reject it.
 * Returns the path to the downloaded temp file.
 */
function downloadYouTube(url, tempDir, tempId, maxSizeBytes, durationCapSeconds) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(tempDir, `${tempId}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--format', 'bestaudio',
      '--output', outputTemplate
    ];

    if (maxSizeBytes != null) {
      args.push('--max-filesize', `${maxSizeBytes}`);
    }

    if (durationCapSeconds != null) {
      args.push('--match-filter', `duration <= ${durationCapSeconds}`);
    }

    args.push(url);

    logger.info('yt-dlp download starting', { url, maxSizeBytes, durationCapSeconds });
    const proc = spawn('yt-dlp', args);

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', () => {
      const e = new Error('yt-dlp not available');
      e.userMessage = 'yt-dlp is not installed on this bot. Contact your admin.';
      reject(e);
    });

    proc.on('close', code => {
      if (code !== 0) {
        logger.fail('yt-dlp failed', { code, stderr: stderr.slice(0, 500) });
        const e = new Error(`yt-dlp exited with code ${code}`);
        const tooLong = stderr.includes('does not pass filter') || stderr.includes('duration');
        const tooBig  = stderr.includes('File is larger than max-filesize');
        if (tooLong) {
          e.userMessage = `That video is too long. Max duration is **${durationCapSeconds}s** btw, just incase you didn't know, or you know, didn't read the instructions. Or maybe you were just a bit ignorant about that thing but you know everyone is sometimes like this from time to time, esspecially me when someone uploads a big ahh file to me and it hurts me from the inside to try and convert it because the video is like 3 HOURS LONG LIKE COME ON YOU DONT NEED THIS ENTIRE THING AS A SOUNDBOARD. Though I do have to ask you, since, you know, probably no one asked you this today, how are you? How's life? How's the kids and the wife? Maybe husband or lover? Idk. Anyways I think I bantered for a very long time now and I think you had enough of reading all of this lmao, anyways. UPLOAD A SHORTER VIDEO YOU GOOFY GOOFER DUMWIT AHH CHICKEN BONE`;
        } else if (tooBig) {
          e.userMessage = `That video's audio track is too large to download.`;
        } else {
          e.userMessage = `## The Digital Void: A Tragedy in One Error Message
          Ah, there it is. The "Could not download" message from me. It's not just a notification, it's a lifestyle. A tiny rectangular shrug from the universe. You pasted it expecting some sound effect or a 10 hour loop of a raccoon playing a pan flute, and instead, you've got the message of **Private! Age-Restricted!** or just Unavailable lol.
          
          ### 1. The "Private" Engima
          When a video is "Private", it's the internet equivalent of seeing a "Do Not Enter" sign on a basement door that smells like sourdough and secrets. What's in there? Is it the lost footage of that one time a cat actually apologised? You'll never know. You are on the outside of the velvet rope, and the bouncer is an algorithm that doesn't take bribes ;(
          
          ### 2. The "Age-Restricted" Guardian
          Ah, the gatekeeper of maturity. This error assumes that because you haven't logged in to prove you're older than idk, a child? A teenager? Your fragile mind cannot handle the intensity of... Whatever is behind that wall. A violent cooking show? The mating habits of scandalous sea cucumbers? The mystery only makes the hunger grow...
          
          ### 3. The "Unavailable" Abyss
          "Unavailable" is the most passive-aggressive. It doesn't give a reason. It doesn't blame your age. It just... Isn't. It's the digital version of your dad saying *"Because I said so."* The video has transcended this plane. It has moved to a farmn upstate where all the deleted MySpace, Vines, Etc. live in peace.
          
          > "The best things in life are free, but the things you actually want to watch are usually region-locked or deleted by a copyright claim from a company that went bankrupt in 1994."
          
          **Why are you still reading?** You've realised I am actively helping you waste the time you *would* have spent getting another sound or watching a YouTube video. If it takes you 3 minutes to find the sound , you've already regained 45 seconds of your life here. You're welcome. Consider the **Entropy of the Link**:
          * **0s:** High hopes.
          * **1s:** The click. The spinning wheel of destiny.
          * **2s:** The copying of the link to me, the bot.
          * **10s:** Denial. You try again hoping it was a mistake on my side.
          * **30s:** Acceptance. That soundboard was never meant for you (or the raccoon flute concert that we talked about).
          
          **Go forth and be unavailable.**`
        }
        return reject(e);
      }

      const downloaded = fs.readdirSync(tempDir).find(f => f.startsWith(tempId));
      if (!downloaded) {
        const e = new Error('yt-dlp finished but no output file found');
        e.userMessage = 'Download appeared to succeed but no audio file was produced.';
        return reject(e);
      }

      logger.ok('yt-dlp download complete', { file: downloaded });
      resolve(path.join(tempDir, downloaded));
    });
  });
}

// This allows me to split the reply in chunks.
async function ReplyInChunks(interaction, content) {
  const chunks = content.match(/[\s\S]{1,2000}/g);

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await interaction.editReply(chunks[i]);
    } else {
      await interaction.followUp({
        content: chunks[i],
        flags: replyFlags(interaction)
      });
    }
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
