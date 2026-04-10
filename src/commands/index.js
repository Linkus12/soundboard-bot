import { SlashCommandBuilder } from 'discord.js';

export const commandData = new SlashCommandBuilder()
  .setName('sb')
  .setDescription('Soundboard commands')
  .addSubcommand(s =>
    s
      .setName('upload')
      .setDescription('Upload a new sound (audio or video file)')
      .addAttachmentOption(o =>
        o.setName('file').setDescription('Audio or video file').setRequired(true)
      )
      .addStringOption(o =>
        o
          .setName('name')
          .setDescription('Sound name (letters, numbers, underscores, hyphens, spaces — 1-32 chars)')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(32)
      )
  )
  .addSubcommand(s =>
    s
      .setName('play')
      .setDescription('Play a sound')
      .addStringOption(o =>
        o
          .setName('name')
          .setDescription('Sound name')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(s =>
    s
      .setName('delete')
      .setDescription('Delete a sound you uploaded (admins can delete any)')
      .addStringOption(o =>
        o
          .setName('name')
          .setDescription('Sound name')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(s => s.setName('list').setDescription('List all available sounds'))
  .addSubcommand(s =>
    s.setName('stop').setDescription('Stop playback (admins: instant, users: vote)')
  )
  .addSubcommand(s => s.setName('storage').setDescription('Show soundboard storage usage'))
  .addSubcommandGroup(g =>
    g
      .setName('admin')
      .setDescription('Manage bot admins')
      .addSubcommand(s =>
        s
          .setName('add')
          .setDescription('Add a user as a bot admin')
          .addUserOption(o =>
            o.setName('user').setDescription('User to promote').setRequired(true)
          )
      )
      .addSubcommand(s =>
        s
          .setName('remove')
          .setDescription('Remove a bot admin')
          .addUserOption(o =>
            o.setName('user').setDescription('User to demote').setRequired(true)
          )
      )
      .addSubcommand(s => s.setName('list').setDescription('List all bot admins'))
  )
  .toJSON();
