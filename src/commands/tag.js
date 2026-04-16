import { queries } from '../db/database.js';
import { isAdmin, isOwner } from '../admins.js';
import { canonicalize, displayName } from '../names.js';
import { getSetting } from '../settings.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Tags are lowercase, 1-32 chars, letters/numbers/hyphens/underscores.
const TAG_REGEX = /^[\w-]{1,32}$/;
const MAX_TAGS_PER_SOUND = 10;

function normalizeTag(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

function validateTag(raw) {
  const tag = normalizeTag(raw);
  if (!TAG_REGEX.test(tag)) return null;
  return tag;
}

// Permission: the sound's uploader OR any admin can add/remove tags.
function canManageTag(guild, userId, sound) {
  if (isOwner(userId)) return true;
  if (sound.uploader_id === userId) return true;
  return isAdmin(guild, userId);
}

export async function handleTagAdd(interaction) {
  await interaction.deferReply({ flags: replyFlags(interaction) });

  const guild = interaction.guild;
  const rawName = interaction.options.getString('name', true);
  const rawTag = interaction.options.getString('tag', true);

  const sound = queries.getByMatch.get(canonicalize(rawName));
  if (!sound) {
    return interaction.editReply(`No sound named **${rawName}**. You sure you know how to spell?`);
  }

  if (!canManageTag(guild, interaction.user.id, sound)) {
    return interaction.editReply(
      `You can only tag sounds you uploaded. **${displayName(sound.name)}** was uploaded by <@${sound.uploader_id}> ya dingus.`
    );
  }

  const tag = validateTag(rawTag);
  if (!tag) {
    return interaction.editReply(
      'Invalid tag - use letters, numbers, hyphens or underscores, BUT NOT WHATEVER YOU DID (Oh yeah forgot to mention, max length is 32 chars).'
    );
  }

  const existing = queries.getTagsForSound.all(sound.id);
  if (existing.length >= MAX_TAGS_PER_SOUND) {
    return interaction.editReply(
      `**${displayName(sound.name)}** already has ${MAX_TAGS_PER_SOUND} tags (the max). Remove one first. (YAYY WE LOVE HAVING LIMITS!!11!!)`
    );
  }

  queries.addTag.run(sound.id, tag, interaction.user.id, Date.now());
  logger.ok('tag added', { soundId: sound.id, tag, by: interaction.user.id });
  const allTags = queries.getTagsForSound.all(sound.id).map(r => `\`${r.tag}\``).join(', ');
  await interaction.editReply(
    `Tagged **${displayName(sound.name)}** with \`${tag}\`. All tags: ${allTags}\n Sheesh, imagine having hobbies that don't involve tagging sounds smh.`
  );
}

export async function handleTagRemove(interaction) {
  await interaction.deferReply({ flags: replyFlags(interaction) });

  const guild = interaction.guild;
  const rawName = interaction.options.getString('name', true);
  const rawTag = interaction.options.getString('tag', true);

  const sound = queries.getByMatch.get(canonicalize(rawName));
  if (!sound) {
    return interaction.editReply(`No sound named **${rawName}**.`);
  }

  if (!canManageTag(guild, interaction.user.id, sound)) {
    return interaction.editReply(
      `You can only manage tags on sounds you uploaded. **${displayName(sound.name)}** was uploaded by <@${sound.uploader_id}>. not you. Cristopher Colombus.`
    );
  }

  const tag = normalizeTag(rawTag);
  const result = queries.removeTag.run(sound.id, tag);

  if (result.changes === 0) {
    return interaction.editReply(`**${displayName(sound.name)}** doesn't have a \`${tag}\` tag. Guh???`);
  }

  logger.ok('tag removed', { soundId: sound.id, tag, by: interaction.user.id });

  const remaining = queries.getTagsForSound.all(sound.id).map(r => `\`${r.tag}\``);
  const tagLine = remaining.length > 0
    ? `Remaining tags: ${remaining.join(', ')}`
    : 'No tags remaining.';
  await interaction.editReply(
    `Removed tag \`${tag}\` from **${displayName(sound.name)}**. ${tagLine}. Wow, well played.`
  );
}

export async function handleTagList(interaction) {
  await interaction.deferReply({ flags: replyFlags(interaction) });

  const guild = interaction.guild;
  const rawName = interaction.options.getString('name');

  if (rawName) {
    // Show all tags for a specific sound.
    const sound = queries.getByMatch.get(canonicalize(rawName));
    if (!sound) {
      return interaction.editReply(`No sound named **${rawName}**.`);
    }
    const tags = queries.getTagsForSound.all(sound.id);
    if (tags.length === 0) {
      return interaction.editReply(`**${displayName(sound.name)}** has no tags.`);
    }
    return interaction.editReply(
      `🏷 Tags for **${displayName(sound.name)}**: ${tags.map(r => `\`${r.tag}\``).join(', ')}`
    );
  }

  // Show all tags visible in this guild.
  const viewScope = getSetting(guild.id, 'view_scope');
  const tagRows = viewScope === 'guild'
    ? queries.searchTagsForGuild.all(guild.id, '%')
    : queries.searchTagsGlobal.all('%');

  if (tagRows.length === 0) {
    return interaction.editReply('No tags exist yet. Use `/sb tag add` to create one.');
  }

  const tagList = tagRows.map(r => `\`${r.tag}\``).join(', ');
  await interaction.editReply(`Available tags: ${tagList}`);
}
