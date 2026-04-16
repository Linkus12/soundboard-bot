import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { SETTING_KEYS } from '../settings.js';

// 🔒 marker on subcommand descriptions for admin-gated commands. Discord
// can't hide individual subcommands from non-admins, so the lock is the
// visible signal.
const LOCK = '🔒 ';

const SETTING_KEY_CHOICES = SETTING_KEYS.map(k => ({ name: k, value: k }));

// Every subcommand ends with a `visibility` boolean so users can opt into
// making the reply public. Default is ephemeral (only-you).
const withVisibility = sub =>
  sub.addBooleanOption(o =>
    o
      .setName('visibility')
      .setDescription('Show this reply to everyone (default: only you see it)')
  );

function buildSlashCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription('Soundboard commands')
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('upload')
          .setDescription('Upload a new sound (audio/video file or YouTube link)')
          .addStringOption(o =>
            o
              .setName('name')
              .setDescription('Sound name (1-32 chars; spaces, hyphens, underscores all OK)')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(32)
          )
          .addAttachmentOption(o =>
            o.setName('file').setDescription('Audio or video file').setRequired(false)
          )
          .addStringOption(o =>
            o
              .setName('youtube_url')
              .setDescription('YouTube video URL (alternative to uploading a file)')
              .setRequired(false)
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(
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
          .addChannelOption(o =>
            o
              .setName('channel')
              .setDescription('Voice channel to play in (defaults to your current channel)')
              .addChannelTypes(ChannelType.GuildVoice)
          )
      )
    )

    .addSubcommand(s =>
      withVisibility(
        s
          .setName('playlist')
          .setDescription('Play a playlist of sounds tagged with a common keyword I guess? Basically tags')
          .addStringOption(o =>
            o
              .setName('tag')
              .setDescription('Playlist name (tags)')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('edit')
          .setDescription('Rename a sound you uploaded (owner can rename any)')
          .addStringOption(o =>
            o
              .setName('name')
              .setDescription('Existing sound name')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption(o =>
            o
              .setName('new_name')
              .setDescription('New name')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(64)
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('cut')
          .setDescription('Trim a sound you uploaded (owner can trim any). Replaces the original.')
          .addStringOption(o =>
            o
              .setName('name')
              .setDescription('Sound to trim')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption(o =>
            o
              .setName('start')
              .setDescription('Optional start time (defaults to 0; supports 12.500 or MM:SS)')
          )
          .addStringOption(o =>
            o.setName('end').setDescription('Optional end time (defaults to full length; supports 45.250 or MM:SS)')
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('delete')
          .setDescription(
            `${LOCK}Delete a sound (uploader, guild admin for own guild, or owner)`
          )
          .addStringOption(o =>
            o
              .setName('name')
              .setDescription('Sound name')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(s.setName('list').setDescription('List all available sounds'))
    )
    .addSubcommand(s =>
      withVisibility(
        s.setName('stop').setDescription(`${LOCK}Stop playback (admins: instant, users: vote)`)
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('spam')
          .setDescription(`${LOCK}Play every sound at once for 7s (admin only)`)
          .addChannelOption(o =>
            o
              .setName('channel')
              .setDescription('Voice channel to spam in (defaults to your current channel)')
              .addChannelTypes(ChannelType.GuildVoice)
          )
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('pause')
          .setDescription('Pause playback (initiator/admin: instant, others: vote)')
      )
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('resume')
          .setDescription('Resume paused playback (initiator/admin: instant, others: vote)')
      )
    )
    .addSubcommand(s =>
      withVisibility(s.setName('storage').setDescription('Show soundboard storage usage'))
    )
    .addSubcommand(s =>
      withVisibility(
        s
          .setName('quickplay')
          .setDescription('Play a YouTube link without saving it — temp file auto-deleted after playback')
          .addStringOption(o =>
            o
              .setName('youtube_url')
              .setDescription('YouTube video URL to play')
              .setRequired(true)
          )
          .addChannelOption(o =>
            o
              .setName('channel')
              .setDescription('Voice channel to play in (defaults to your current channel)')
              .addChannelTypes(ChannelType.GuildVoice)
          )
      )
    )
    .addSubcommandGroup(g =>
      g
        .setName('tag')
        .setDescription('Manage sound tags')
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('add')
              .setDescription('Add a tag to a sound (uploader or admin)')
              .addStringOption(o =>
                o.setName('name').setDescription('Sound name').setRequired(true).setAutocomplete(true)
              )
              .addStringOption(o =>
                o.setName('tag').setDescription('Tag to add (letters, numbers, hyphens)').setRequired(true)
              )
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('remove')
              .setDescription('Remove a tag from a sound (uploader or admin)')
              .addStringOption(o =>
                o.setName('name').setDescription('Sound name').setRequired(true).setAutocomplete(true)
              )
              .addStringOption(o =>
                o.setName('tag').setDescription('Tag to remove').setRequired(true).setAutocomplete(true)
              )
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('list')
              .setDescription('List all tags, or tags on a specific sound')
              .addStringOption(o =>
                o.setName('name').setDescription('Sound name (optional — omit to list all tags)').setAutocomplete(true)
              )
          )
        )
    )
    .addSubcommandGroup(g =>
      g
        .setName('admin')
        .setDescription('Manage bot admins for this server')
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('add')
              .setDescription(`${LOCK}Add a user as a bot admin in this server`)
              .addUserOption(o =>
                o.setName('user').setDescription('User to promote').setRequired(true)
              )
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('remove')
              .setDescription(`${LOCK}Remove a bot admin from this server`)
              .addUserOption(o =>
                o.setName('user').setDescription('User to demote').setRequired(true)
              )
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s.setName('list').setDescription("List this server's bot admins")
          )
        )
    )
    .addSubcommandGroup(g =>
      g
        .setName('settings')
        .setDescription(`${LOCK}Per-server soundboard settings`)
        .addSubcommand(s =>
          withVisibility(
            s.setName('view').setDescription(`${LOCK}Show current settings for this server`)
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('set')
              .setDescription(`${LOCK}Set a setting (some keys are owner-only)`)
              .addStringOption(o =>
                o
                  .setName('key')
                  .setDescription('Setting key')
                  .setRequired(true)
                  .addChoices(...SETTING_KEY_CHOICES)
              )
              .addStringOption(o =>
                o
                  .setName('value')
                  .setDescription('New value (autocomplete lists options for the selected key)')
                  .setRequired(true)
                  .setAutocomplete(true)
              )
          )
        )
        .addSubcommand(s =>
          withVisibility(
            s
              .setName('unset')
              .setDescription(`${LOCK}Clear an override and fall back to the default`)
              .addStringOption(o =>
                o
                  .setName('key')
                  .setDescription('Setting key')
                  .setRequired(true)
                  .addChoices(...SETTING_KEY_CHOICES)
              )
          )
        )
    )
    .toJSON();
}

// Register the command tree under both /sb and /soundboard.
export const commandData = [buildSlashCommand('sb'), buildSlashCommand('soundboard')];
