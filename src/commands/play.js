import path from 'node:path';
import fs from 'node:fs';
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { getSession, playSound, stopSession } from '../audio/player.js';
import { isAdmin } from '../admins.js';
import { logger } from '../logger.js';

export async function handlePlay(interaction) {
  const name = interaction.options.getString('name');
  const sound = queries.getByName.get(name);

  if (!sound) {
    return interaction.reply({
      content: `No sound named **${name}**. Use \`/sb list\` to see available sounds.`,
      flags: MessageFlags.Ephemeral
    });
  }

  const member = interaction.member;
  const userVoice = member.voice?.channel;

  if (!userVoice) {
    return interaction.reply({
      content: 'You need to be in a voice channel to play sounds.',
      flags: MessageFlags.Ephemeral
    });
  }

  // Bot needs permission to speak in the target channel
  const me = await interaction.guild.members.fetchMe();
  const perms = userVoice.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({
      content: `I don't have permission to connect or speak in <#${userVoice.id}>.`,
      flags: MessageFlags.Ephemeral
    });
  }

  const admin = isAdmin(member.id);
  const session = getSession(interaction.guild.id);

  // --- Channel lock rules ---------------------------------------------------
  if (session && session.channelId !== userVoice.id) {
    if (admin) {
      logger.info('admin overriding channel lock', {
        guildId: interaction.guild.id,
        from: session.channelId,
        to: userVoice.id,
        userId: member.id
      });
      stopSession(interaction.guild.id, 'admin-override');
      // Small delay to let the old connection fully tear down before the new one opens
      await new Promise(resolve => setTimeout(resolve, 300));
    } else {
      return interaction.reply({
        content: `🔒 I'm currently playing in <#${session.channelId}>. Wait for it to finish or ask an admin.`,
        flags: MessageFlags.Ephemeral
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
      content: `The file for **${sound.name}** is missing from disk. It may have been deleted manually.`,
      flags: MessageFlags.Ephemeral
    });
  }

  // --- Play -----------------------------------------------------------------
  // Defer here — voice connection can take >3s, which would expire the interaction token.
  // Quick pre-play validation above stays as non-deferred ephemeral replies.
  await interaction.deferReply();

  try {
    const result = await playSound(
      interaction.guild,
      userVoice,
      filePath,
      sound.name,
      member.id
    );

    const suffix = result.overlapping > 1 ? ` (${result.overlapping} sounds overlapping)` : '';
    await interaction.editReply({
      content: `▶ Playing **${sound.name}**${suffix}`
    });
  } catch (err) {
    logger.error('play failed', {
      guildId: interaction.guild.id,
      sound: sound.name,
      err: err.message
    });
    await interaction.editReply({
      content: `Failed to play **${sound.name}**: ${err.message}`
    });
  }
}
