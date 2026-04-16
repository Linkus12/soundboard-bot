import path from 'node:path';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { queries } from '../db/database.js';
import { getSetting } from '../settings.js';
import { getSession, playSound, stopSession } from '../audio/player.js';
import { isAdmin } from '../admins.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

export async function handleTaggedPlaylist(interaction) {
  const tagName = interaction.options.getString('tag').toLowerCase().trim();
  const providedChannel = interaction.options.getChannel('channel');
  const member = interaction.member;
  const userVoice = member.voice?.channel;
  const guild = interaction.guild;

  let targetChannel;
  if (providedChannel) {
    const userPerms = providedChannel.permissionsFor(member);
    if (!userPerms?.has(PermissionFlagsBits.ViewChannel) || !userPerms?.has(PermissionFlagsBits.Connect)) {
      return interaction.reply({ 
        content: `You don't have permission to join <#${providedChannel.id}>. Looking like a slave rn ngl`, 
        flags: replyFlags(interaction) 
      });
    }
    targetChannel = providedChannel;
  } else if (userVoice) {
    targetChannel = userVoice;
  } else {
    return interaction.reply({ 
      content: 'You need to be in a voice channel, or pass `channel:` to pick one.', 
      flags: replyFlags(interaction) 
    });
  }

  const me = await guild.members.fetchMe();
  const perms = targetChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({ 
      content: `I don't have permission to connect/speak in <#${targetChannel.id}>.`, 
      flags: replyFlags(interaction) 
    });
  }

  const viewScope = getSetting(guild.id, 'view_scope');
  const sounds = viewScope === 'guild'
    ? queries.getSoundsForTagInGuild.all(tagName, guild.id)
    : queries.getSoundsForTag.all(tagName);

  if (sounds.length === 0) {
    return interaction.reply({ 
      content: `No sounds tagged with **${tagName}** found.`, 
      flags: replyFlags(interaction) 
    });
  }

  const admin = isAdmin(guild, member.id);
  const session = getSession(guild.id);
  if (session && session.channelId !== targetChannel.id) {
    if (admin) {
      stopSession(guild.id, 'admin-override');
      await new Promise(resolve => setTimeout(resolve, 300));
    } else {
      return interaction.reply({ 
        content: `🔒 I'm busy in <#${session.channelId}>. Wait your turn you dirty fucking nigger!`, 
        flags: replyFlags(interaction) 
      });
    }
  }

  const playable = sounds.filter(s => {
    const fp = path.join(config.soundsDir, s.filename);
    return fs.existsSync(fp);
  });

  if (playable.length === 0) {
    return interaction.reply({ 
      content: `All sounds tagged **${tagName}** are missing from disk. Rip.`, 
      flags: replyFlags(interaction) 
    });
  }

  await interaction.deferReply({ flags: replyFlags(interaction) });

  let currentIndex = 0;
  async function playNext() {
    if (currentIndex >= playable.length) {
        logger.info('Tagged playlist finished', { tag: tagName, guildId: guild.id });
        return;
    }

    const sound = playable[currentIndex++];
    const filePath = path.join(config.soundsDir, sound.filename);

    try {
      await playSound(guild, targetChannel, filePath, sound.name, member.id, {
        onComplete: playNext
      });
    } catch (err) {
      logger.error('Playlist playback error', { sound: sound.name, error: err.message });
      playNext(); // Skip failed sound and continue
    }
  }

  await playNext();

  const skipped = sounds.length - playable.length;
  const skipNote = skipped > 0 ? ` (${skipped} missing files skipped)` : '';
  await interaction.editReply({
    content: `Playing **${playable.length}** sounds tagged **${tagName}** in <#${targetChannel.id}>.${skipNote}`
  });
}
