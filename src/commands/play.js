import path from 'node:path';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { getSession, playSound, stopSession } from '../audio/player.js';
import { isAdmin } from '../admins.js';
import { getSetting } from '../settings.js';
import { canonicalize, displayName } from '../names.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Remote-play cooldown (non-admins only). Firing /sb play with a channel
// option you're not already sitting in burns a 30s cooldown, so the bot
// can't be yanked around the server repeatedly. Playing into the channel
// you're already in is free — and once you walk into the target channel,
// the check below stops applying because `isRemotePlay` flips to false.
const REMOTE_COOLDOWN_MS = 30_000;
const remoteCooldowns = new Map(); // `${guildId}:${userId}` -> expiryTs

function cooldownRemainingMs(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const expiry = remoteCooldowns.get(key);
  if (!expiry) return 0;
  const remaining = expiry - Date.now();
  if (remaining <= 0) {
    remoteCooldowns.delete(key);
    return 0;
  }
  return remaining;
}

function armCooldown(guildId, userId) {
  remoteCooldowns.set(`${guildId}:${userId}`, Date.now() + REMOTE_COOLDOWN_MS);
}

export async function handlePlay(interaction) {
  const rawName = interaction.options.getString('name');
  const sound = queries.getByMatch.get(canonicalize(rawName));

  if (!sound) {
    return interaction.reply({
      content: `No sound named **${rawName}**. Use \`/sb list\` to see available sounds.`,
      flags: replyFlags(interaction)
    });
  }

  // --- Visibility check ----------------------------------------------------
  // view_scope=guild → can only play sounds uploaded in this guild.
  // view_scope=global → can only play public sounds (is_private = 0).
  const viewScope = getSetting(interaction.guild.id, 'view_scope');
  const visible =
    viewScope === 'guild'
      ? sound.guild_id === interaction.guild.id
      : sound.is_private === 0;
  if (!visible) {
    return interaction.reply({
      content: `**${displayName(sound.name)}** isn't available in this server ya dumwit! What are you trying to do, hack the planet??`,
      flags: replyFlags(interaction)
    });
  }

  const member = interaction.member;
  const userVoice = member.voice?.channel;
  const providedChannel = interaction.options.getChannel('channel');

  // --- Resolve target voice channel ----------------------------------------
  // Provided channel wins if present; otherwise fall back to the member's
  // current VC. Discord's channel picker already restricts the list to
  // channels the user can view, so we don't have to re-filter it — we only
  // double-check Connect, which Discord doesn't enforce at pick time.
  let targetChannel;
  if (providedChannel) {
    const userPerms = providedChannel.permissionsFor(member);
    if (
      !userPerms?.has(PermissionFlagsBits.ViewChannel) ||
      !userPerms?.has(PermissionFlagsBits.Connect)
    ) {
      return interaction.reply({
        content: `You don't have permission to join <#${providedChannel.id}>.`,
        flags: replyFlags(interaction)
      });
    }
    targetChannel = providedChannel;
  } else if (userVoice) {
    targetChannel = userVoice;
  } else {
    return interaction.reply({
      content:
        'You need to be in a voice channel, or pass `channel:` to pick one for me to join you know? I can\'t just read your mind, that would be crazy.',
      flags: replyFlags(interaction)
    });
  }

  // Bot needs permission to speak in the target channel
  const me = await interaction.guild.members.fetchMe();
  const perms = targetChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({
      content: `I don't have permission to connect or speak in <#${targetChannel.id}> my dude (or lass idk can't see your gender lmao). Fix that problem and then maybe I'll want to join you.`,
      flags: replyFlags(interaction)
    });
  }

  const admin = isAdmin(interaction.guild, member.id, member);
  const session = getSession(interaction.guild.id);

  // --- Remote-play cooldown (non-admins) -----------------------------------
  // Remote = target channel isn't the one the user is currently sitting in.
  // If they're already in the target channel, no cooldown applies, so the
  // user can always bypass an existing cooldown by moving into the channel.
  const isRemotePlay = !userVoice || userVoice.id !== targetChannel.id;
  if (isRemotePlay && !admin) {
    const remaining = cooldownRemainingMs(interaction.guild.id, member.id);
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      return interaction.reply({
        content:
          `⏳ Remote-play cooldown: **${seconds}s** left. ` +
          `Join <#${targetChannel.id}> to bypass it, or wait it out, ya impatient fuck!`,
        flags: replyFlags(interaction)
      });
    }
  }

  // --- Channel lock rules ---------------------------------------------------
  if (session && session.channelId !== targetChannel.id) {
    if (admin) {
      logger.info('admin overriding channel lock', {
        guildId: interaction.guild.id,
        from: session.channelId,
        to: targetChannel.id,
        userId: member.id
      });
      stopSession(interaction.guild.id, 'admin-override');
      // Small delay to let the old connection fully tear down before the new one opens
      await new Promise(resolve => setTimeout(resolve, 300));
    } else {
      return interaction.reply({
        content: `🔒 I'm currently playing in <#${session.channelId}>. Wait for it to finish or ask an admin (Admins aren't gonna help you though lmao).`,
        flags: replyFlags(interaction)
      });
    }
  }

  // --- Verify file still exists on disk ------------------------------------
  const filePath = path.join(config.soundsDir, sound.filename);
  if (!fs.existsSync(filePath)) {
    logger.error('sound file missing from disk', {
      name: sound.name,
      filename: sound.filename
    });
    return interaction.reply({
      content: `The file for **${sound.name}** is missing from disk. It may have been deleted manually ya dingus!`,
      flags: replyFlags(interaction)
    });
  }

  // --- Play -----------------------------------------------------------------
  // Defer here — voice connection can take >3s, which would expire the interaction token.
  // Ephemeral vs public is locked in at deferReply time; editReply can't change it.
  await interaction.deferReply({ flags: replyFlags(interaction) });

  try {
    const result = await playSound(
      interaction.guild,
      targetChannel,
      filePath,
      sound.name,
      member.id
    );

    // Only arm the cooldown once the play actually succeeds, so a failed
    // attempt doesn't lock the user out for 30s for nothing.
    if (isRemotePlay && !admin) {
      armCooldown(interaction.guild.id, member.id);
    }

    const display = displayName(sound.name);
    const suffix = result.overlapping > 1 ? ` (${result.overlapping} sounds overlapping)` : '';
    const remoteNote = isRemotePlay ? ` in <#${targetChannel.id}>` : '';
    await interaction.editReply({
      content: `▶ Playing **${display}**${remoteNote}${suffix}`
    });
  } catch (err) {
    logger.error('play failed', {
      guildId: interaction.guild.id,
      sound: sound.name,
      err: err.message
    });
    await interaction.editReply({
      content: `Failed to play **${displayName(sound.name)}**: ${err.message}. Oopsie woopsie!`
    });
  }
}
