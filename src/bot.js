import { Client, Events, GatewayIntentBits, MessageFlags, ActivityType } from 'discord.js';
import { logger } from './logger.js';
import { queries } from './db/database.js';
import { getSetting, getSettingDef } from './settings.js';
import { canonicalize, displayName } from './names.js';
import { handleUpload } from './commands/upload.js';
import { handlePlay } from './commands/play.js';
import { handleDelete } from './commands/delete.js';
import { handleList } from './commands/list.js';
import { handleStop, handleStopVoteButton } from './commands/stop.js';
import { handleSpam } from './commands/spam.js';
import { handleStorage } from './commands/storage.js';
import {
  handleAdminAdd,
  handleAdminRemove,
  handleAdminList
} from './commands/admin.js';
import {
  handleSettingsView,
  handleSettingsSet,
  handleSettingsUnset
} from './commands/settings.js';
import { handleEdit } from './commands/edit.js';
import { handleCut } from './commands/cut.js';
import {
  handlePause,
  handleResume,
  handlePauseVoteButton,
  handleResumeVoteButton
} from './commands/pause.js';
import { scheduleDismiss } from './commands/visibility.js';
import { handleQuickPlay } from './commands/quickplay.js';
import { handleTagAdd, handleTagRemove, handleTagList } from './commands/tag.js';
import { handleTaggedPlaylist } from './commands/taggedplaylist.js';

// Both /sb and /soundboard route to the same handlers.
const COMMAND_NAMES = new Set(['sb', 'soundboard']);

export function createBot() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  });

  client.once(Events.ClientReady, c => {
    logger.ok(`logged in as ${c.user.tag}`, {
      id: c.user.id,
      guilds: c.guilds.cache.size
    });
    c.user.setActivity({
      name: 'Custom Status',
      state: '💤 Playing nothing',
      type: ActivityType.Custom
    });
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      // --- Slash command dispatch ------------------------------------------
      if (interaction.isChatInputCommand() && COMMAND_NAMES.has(interaction.commandName)) {
        // All soundboard commands require a guild (voice)
        if (!interaction.inGuild()) {
          await interaction.reply({
            content: 'Soundboard commands only work in a server.',
            flags: MessageFlags.Ephemeral
          });
          scheduleDismiss(interaction);
          return;
        }

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        const handler = resolveHandler(group, sub);
        if (handler) {
          await handler(interaction);
        } else {
          const label = group ? `${group} ${sub}` : sub;
          await interaction.reply({
            content: `Unknown subcommand: ${label}`,
            flags: MessageFlags.Ephemeral
          });
        }

        // Auto-dismiss any plain-text reply after 30s. The helper checks for
        // attached components first, so vote buttons and the paginated list
        // are left alone.
        scheduleDismiss(interaction);
        return;
      }

      // --- Autocomplete dispatch -------------------------------------------
      if (interaction.isAutocomplete() && COMMAND_NAMES.has(interaction.commandName)) {
        const focused = interaction.options.getFocused(true);

        // Sound-name autocomplete (upload/play/edit/cut/delete).
        if (focused.name === 'name') {
          const query = focused.value || '';
          // Canonicalize the query so spaces, hyphens, underscores all match.
          // Strip SQL LIKE wildcards from the canonical form.
          const canonical = canonicalize(query).replace(/[%_]/g, '');
          const pattern = `%${canonical}%`;

          const viewScope = getSetting(interaction.guild.id, 'view_scope');
          const rows =
            viewScope === 'guild'
              ? queries.searchForGuild.all(interaction.guild.id, pattern)
              : queries.searchGlobal.all(pattern);

          // Display the user-friendly form, but use the stored kebab-case as
          // the autocomplete value so handlers see a canonical input.
          const choices = rows.slice(0, 25).map(s => ({
            name: displayName(s.name),
            value: s.name
          }));
          return interaction.respond(choices);
        }

        // Tag autocomplete — used by `/sb playlist tag:`, `/sb tag remove tag:`.
        // Scope matches view_scope: `guild` lists only tags on guild-local
        // sounds, `global` lists tags on all public sounds.
        if (focused.name === 'tag') {
          const query = String(focused.value || '').toLowerCase();
          const canonical = query.replace(/[%_]/g, '');
          const pattern = `%${canonical}%`;

          const viewScope = getSetting(interaction.guild.id, 'view_scope');
          const rows =
            viewScope === 'guild'
              ? queries.searchTagsForGuild.all(interaction.guild.id, pattern)
              : queries.searchTagsGlobal.all(pattern);

          const choices = rows.slice(0, 25).map(r => ({ name: r.tag, value: r.tag }));
          return interaction.respond(choices);
        }

        // `/sb settings set value:` — suggest options for the currently
        // selected key. Enum keys list each valid value with a description;
        // numeric keys surface the current default as a one-click suggestion.
        if (
          focused.name === 'value' &&
          interaction.options.getSubcommandGroup(false) === 'settings' &&
          interaction.options.getSubcommand(false) === 'set'
        ) {
          const key = interaction.options.getString('key');
          if (!key) return interaction.respond([]);
          const def = getSettingDef(key);
          if (!def) return interaction.respond([]);

          const query = String(focused.value || '').toLowerCase();
          const choices = [];

          if (def.type === 'enum' && Array.isArray(def.options)) {
            for (const opt of def.options) {
              if (query && !opt.value.toLowerCase().includes(query)) continue;
              // Discord caps autocomplete `name` at 100 chars.
              const label = `${opt.value} — ${opt.describe}`;
              const shown = label.length > 100 ? label.slice(0, 97) + '...' : label;
              choices.push({ name: shown, value: opt.value });
            }
          } else if (def.type === 'int' || def.type === 'float') {
            try {
              const current = def.default();
              choices.push({
                name: `current default: ${current}`,
                value: String(current)
              });
            } catch {}
          }

          return interaction.respond(choices.slice(0, 25));
        }

        return interaction.respond([]);
      }

      // --- Vote buttons -----------------------------------------------------
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('stop-vote-')) {
          return handleStopVoteButton(interaction);
        }
        if (interaction.customId.startsWith('pause-vote-')) {
          return handlePauseVoteButton(interaction);
        }
        if (interaction.customId.startsWith('resume-vote-')) {
          return handleResumeVoteButton(interaction);
        }
      }
    } catch (err) {
      logger.error('interaction handler threw', {
        type: interaction.type,
        err: err.message,
        stack: err.stack
      });
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Something went wrong handling that command.',
            flags: MessageFlags.Ephemeral
          });
        } else if (interaction.deferred) {
          await interaction.editReply('Something went wrong handling that command.');
        }
      } catch {}
    }
  });

  client.on(Events.Error, err => {
    logger.error('discord client error', { err: err.message });
  });

  client.on(Events.Warn, msg => {
    logger.warn('discord client warning', { msg });
  });

  return client;
}

// Map (group, sub) -> handler. Returning null lets the dispatcher emit a
// generic "unknown subcommand" reply with consistent formatting.
function resolveHandler(group, sub) {
  if (group === 'tag') {
    if (sub === 'add') return handleTagAdd;
    if (sub === 'remove') return handleTagRemove;
    if (sub === 'list') return handleTagList;
    return null;
  }
  if (group === 'admin') {
    if (sub === 'add') return handleAdminAdd;
    if (sub === 'remove') return handleAdminRemove;
    if (sub === 'list') return handleAdminList;
    return null;
  }
  if (group === 'settings') {
    if (sub === 'view') return handleSettingsView;
    if (sub === 'set') return handleSettingsSet;
    if (sub === 'unset') return handleSettingsUnset;
    return null;
  }
  switch (sub) {
    case 'upload': return handleUpload;
    case 'play': return handlePlay;
    case 'edit': return handleEdit;
    case 'cut': return handleCut;
    case 'delete': return handleDelete;
    case 'list': return handleList;
    case 'stop': return handleStop;
    case 'spam': return handleSpam;
    case 'pause': return handlePause;
    case 'resume': return handleResume;
    case 'quickplay': return handleQuickPlay;
    case 'playlist': return handleTaggedPlaylist;
    case 'storage': return handleStorage;
    default: return null;
  }
}
