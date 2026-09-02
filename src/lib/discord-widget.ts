// Pure helpers for the Discord widget. Everything that touches the DOM lives
// in src/components/DiscordWidget.astro; everything that can be unit-tested
// lives here.

export const DISCORD_GUILD_ID = '1210598510999633971';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

// Shape of https://discord.com/api/guilds/{id}/widget.json. Members are
// online-only and capped at 100 by Discord. `game` is not in Discord's
// documented widget object but is present in real responses.
export interface WidgetMember {
  id: string;
  username: string;
  status?: string;
  avatar_url: string;
  game?: { name: string };
}

export interface WidgetResponse {
  id: string;
  name: string;
  instant_invite: string | null;
  presence_count: number;
  members?: WidgetMember[];
}

// Shape of https://discord.com/api/v9/invites/{code}?with_counts=true, only
// the fields the widget reads. The widget endpoint omits the server icon and
// the total member count; the invite endpoint carries both and allows CORS.
export interface InviteResponse {
  approximate_member_count?: number;
  profile?: { member_count?: number };
  guild?: { icon?: string | null };
}

export function widgetUrl(guildId: string): string {
  return `https://discord.com/api/guilds/${guildId}/widget.json`;
}

export function inviteUrl(code: string): string {
  return `https://discord.com/api/v9/invites/${encodeURIComponent(code)}?with_counts=true`;
}

// The invite code expires, so it is read from widget.json on every load and
// never hardcoded. Both https://discord.gg/CODE and
// https://discord.com/invite/CODE end in the code.
export function inviteCodeFrom(instantInvite: string | null | undefined): string | null {
  if (!instantInvite) return null;
  const lastSegment = instantInvite.split('/').pop() ?? '';
  const code = lastSegment.split('?')[0] ?? '';
  return code.length > 0 ? code : null;
}

// Animated icons have hashes prefixed `a_` and are served as gif.
export function guildIconUrl(guildId: string, hash: string): string {
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${extension}?size=128`;
}

// Discord has moved the total between two fields over time; read both.
export function totalMemberCount(invite: InviteResponse): number | undefined {
  return invite.approximate_member_count ?? invite.profile?.member_count;
}

// The middle dot separator matches the standalone widget's label.
export function countsLabel(online: number, total?: number): string {
  return total ? `${online} online · ${total} members` : `${online} online`;
}

export function statusClass(status: string | undefined): PresenceStatus {
  return status === 'online' || status === 'idle' || status === 'dnd' ? status : 'offline';
}
