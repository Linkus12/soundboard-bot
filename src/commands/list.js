import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { queries } from '../db/database.js';
import { getSetting } from '../settings.js';
import { displayName } from '../names.js';
import { replyFlags } from './visibility.js';
import { logger } from '../logger.js';

const PAGE_SIZE = 15;
const EMBED_DESC_LIMIT = 4000;
const COLLECTOR_IDLE_MS = 5 * 60 * 1000;
const MODAL_WAIT_MS = 2 * 60 * 1000;
// Discord hard cap on StringSelectMenu options.
const UPLOADER_SELECT_LIMIT = 25;

/**
 * Collapse the sound list down to a unique set of uploaders with their
 * stored tag and sound count. Sorted most-prolific-first so the select menu
 * surfaces the most useful options when there are more than 25 uploaders.
 */
function buildUploaderStats(sounds) {
  const map = new Map();
  for (const s of sounds) {
    const existing = map.get(s.uploader_id);
    if (existing) {
      existing.count++;
      // Refresh the tag from later rows so renamed users get their newer tag.
      if (s.uploader_tag) existing.tag = s.uploader_tag;
    } else {
      map.set(s.uploader_id, {
        id: s.uploader_id,
        tag: s.uploader_tag || s.uploader_id,
        count: 1
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function findUploaderTag(uploaders, id) {
  if (!id) return null;
  const found = uploaders.find(u => u.id === id);
  return found ? found.tag : id;
}

function fetchAllForScope(guildId) {
  const viewScope = getSetting(guildId, 'view_scope');
  const sounds =
    viewScope === 'guild'
      ? queries.getAllForGuild.all(guildId)
      : queries.getAllGlobal.all();
  return { viewScope, sounds };
}

function filtersActive(filters) {
  return (
    filters.uploaderId != null ||
    filters.minLength != null ||
    filters.maxLength != null
  );
}

function applyFilters(sounds, filters) {
  return sounds.filter(s => {
    if (filters.uploaderId && s.uploader_id !== filters.uploaderId) return false;
    if (filters.minLength != null && s.duration_seconds < filters.minLength) return false;
    if (filters.maxLength != null && s.duration_seconds > filters.maxLength) return false;
    return true;
  });
}

function clampPage(page, pageCount) {
  if (page < 0) return 0;
  if (page >= pageCount) return pageCount - 1;
  return page;
}

function buildEmbed({
  allCount,
  filtered,
  page,
  pageCount,
  viewScope,
  guild,
  filters,
  uploaders
}) {
  const start = page * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  const lines = slice.map(
    s =>
      `• **${displayName(s.name)}** (${s.duration_seconds.toFixed(1)}s) — ${s.uploader_tag || s.uploader_id}`
  );

  const scopeLabel = viewScope === 'guild' ? ` — ${guild.name}` : '';
  const active = filtersActive(filters);
  const countLabel = active
    ? `${filtered.length} of ${allCount}`
    : `${allCount}`;
  const pluralBase = active ? filtered.length : allCount;
  const title = `🔊 Soundboard${scopeLabel} — ${countLabel} sound${pluralBase === 1 ? '' : 's'}`;

  const filterBits = [];
  if (filters.uploaderId) {
    filterBits.push(`uploader: ${findUploaderTag(uploaders, filters.uploaderId)}`);
  }
  if (filters.minLength != null) filterBits.push(`≥ ${filters.minLength}s`);
  if (filters.maxLength != null) filterBits.push(`≤ ${filters.maxLength}s`);

  const header = filterBits.length ? `*Filters: ${filterBits.join(' · ')}*\n\n` : '';
  const body = lines.length ? lines.join('\n') : '_No sounds match the current filters._';
  let description = header + body;

  if (description.length > EMBED_DESC_LIMIT) {
    description = description.slice(0, EMBED_DESC_LIMIT - 30) + '\n*…truncated*';
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: `Page ${page + 1} / ${Math.max(1, pageCount)}` });
}

function buildComponents({ page, pageCount, filters, uploaders, disabled = false }) {
  const atStart = page <= 0;
  const atEnd = page >= pageCount - 1;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('list-first')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atStart),
    new ButtonBuilder()
      .setCustomId('list-prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atStart),
    new ButtonBuilder()
      .setCustomId('list-next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atEnd),
    new ButtonBuilder()
      .setCustomId('list-last')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atEnd)
  );

  // Show up to UPLOADER_SELECT_LIMIT uploaders, most-prolific first. If the
  // currently-selected uploader got cut from the top slice, splice them back
  // in so the menu can still render its "default" state correctly.
  const visible = uploaders.slice(0, UPLOADER_SELECT_LIMIT);
  if (
    filters.uploaderId &&
    !visible.some(u => u.id === filters.uploaderId)
  ) {
    const picked = uploaders.find(u => u.id === filters.uploaderId);
    if (picked) {
      visible.pop();
      visible.push(picked);
    }
  }

  const options = visible.map(u => {
    const rawLabel = `${u.tag} (${u.count})`;
    const label = rawLabel.length > 100 ? rawLabel.slice(0, 97) + '...' : rawLabel;
    return {
      label,
      value: u.id,
      default: u.id === filters.uploaderId
    };
  });

  const uploaderRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('list-uploader')
      .setPlaceholder(
        uploaders.length > UPLOADER_SELECT_LIMIT
          ? `Filter by uploader (top ${UPLOADER_SELECT_LIMIT} of ${uploaders.length})…`
          : 'Filter by uploader…'
      )
      .setMinValues(0)
      .setMaxValues(1)
      .setDisabled(disabled || options.length === 0)
      .addOptions(
        options.length > 0
          ? options
          : [{ label: 'No uploaders', value: '__none__', default: false }]
      )
  );

  const filterRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('list-length')
      .setLabel('Length filter')
      .setEmoji('🎚️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('list-clear')
      .setLabel('Clear filters')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || !filtersActive(filters))
  );

  return [navRow, uploaderRow, filterRow];
}

function parseLengthInput(raw) {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

export async function handleList(interaction) {
  const guild = interaction.guild;
  const { viewScope, sounds: allSounds } = fetchAllForScope(guild.id);

  if (allSounds.length === 0) {
    const hint =
      viewScope === 'guild'
        ? "This server hasn't uploaded any sounds yet. Use `/sb upload` to add one."
        : 'No sounds uploaded yet. Use `/sb upload` to add one.';
    return interaction.reply({
      content: hint,
      flags: replyFlags(interaction)
    });
  }

  const uploaders = buildUploaderStats(allSounds);

  const state = {
    page: 0,
    filters: { uploaderId: null, minLength: null, maxLength: null }
  };

  const render = () => {
    const filtered = applyFilters(allSounds, state.filters);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = clampPage(state.page, pageCount);
    return {
      embeds: [
        buildEmbed({
          allCount: allSounds.length,
          filtered,
          page: state.page,
          pageCount,
          viewScope,
          guild,
          filters: state.filters,
          uploaders
        })
      ],
      components: buildComponents({
        page: state.page,
        pageCount,
        filters: state.filters,
        uploaders
      })
    };
  };

  await interaction.reply({ ...render(), flags: replyFlags(interaction) });

  let reply;
  try {
    reply = await interaction.fetchReply();
  } catch (err) {
    logger.error('list: fetchReply failed', { err: err.message });
    return;
  }

  const collector = reply.createMessageComponentCollector({
    idle: COLLECTOR_IDLE_MS,
    filter: i => i.user.id === interaction.user.id
  });

  collector.on('collect', async i => {
    try {
      switch (i.customId) {
        case 'list-first':
          state.page = 0;
          await i.update(render());
          return;
        case 'list-prev':
          state.page -= 1;
          await i.update(render());
          return;
        case 'list-next':
          state.page += 1;
          await i.update(render());
          return;
        case 'list-last':
          state.page = Number.MAX_SAFE_INTEGER;
          await i.update(render());
          return;
        case 'list-uploader': {
          const picked = i.values?.[0];
          // The empty-state fallback option uses a sentinel value; ignore it
          // so it can never apply as an actual filter.
          state.filters.uploaderId = picked && picked !== '__none__' ? picked : null;
          state.page = 0;
          await i.update(render());
          return;
        }
        case 'list-clear':
          state.filters.uploaderId = null;
          state.filters.minLength = null;
          state.filters.maxLength = null;
          state.page = 0;
          await i.update(render());
          return;
        case 'list-length':
          await handleLengthModal(i, state, render, interaction.user.id);
          return;
        default:
          return;
      }
    } catch (err) {
      logger.error('list: collector handler threw', {
        customId: i.customId,
        err: err.message,
        stack: err.stack
      });
      try {
        if (!i.replied && !i.deferred) {
          await i.reply({
            content: 'Something went wrong updating the list.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch {}
    }
  });

  collector.on('end', async () => {
    // The list is interactive, so it's exempt from the bot-wide auto-dismiss
    // (the dispatcher skips messages with components). When the collector
    // finally goes idle, delete the message outright so it doesn't sit in
    // chat forever as a frozen UI.
    try {
      await interaction.deleteReply();
    } catch (err) {
      // Token expired or already gone — nothing to do.
      logger.debug?.('list: could not delete reply on collector end', { err: err.message });
    }
  });
}

async function handleLengthModal(btn, state, render, userId) {
  const modal = new ModalBuilder()
    .setCustomId(`list-length-modal-${btn.id}`)
    .setTitle('Filter by length')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('min')
          .setLabel('Minimum length (seconds)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('e.g. 2')
          .setValue(state.filters.minLength != null ? String(state.filters.minLength) : '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('max')
          .setLabel('Maximum length (seconds)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('e.g. 10')
          .setValue(state.filters.maxLength != null ? String(state.filters.maxLength) : '')
      )
    );

  await btn.showModal(modal);

  let submit;
  try {
    submit = await btn.awaitModalSubmit({
      time: MODAL_WAIT_MS,
      filter: mi => mi.customId === `list-length-modal-${btn.id}` && mi.user.id === userId
    });
  } catch {
    // Timed out or user dismissed — leave the list untouched.
    return;
  }

  const min = parseLengthInput(submit.fields.getTextInputValue('min'));
  const max = parseLengthInput(submit.fields.getTextInputValue('max'));

  if (!min.ok || !max.ok) {
    await submit.reply({
      content: 'Lengths must be non-negative numbers (seconds). Leave blank to clear.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (min.value != null && max.value != null && min.value > max.value) {
    await submit.reply({
      content: 'Minimum length cannot be greater than maximum length.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  state.filters.minLength = min.value;
  state.filters.maxLength = max.value;
  state.page = 0;
  await submit.update(render());
}
