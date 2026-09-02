import { describe, it, expect } from 'vitest';
import {
  DISCORD_GUILD_ID,
  widgetUrl,
  inviteUrl,
  inviteCodeFrom,
  guildIconUrl,
  totalMemberCount,
  countsLabel,
  statusClass,
} from '../src/lib/discord-widget';

describe('DISCORD_GUILD_ID', () => {
  it('is the LahtiAG guild', () => {
    expect(DISCORD_GUILD_ID).toBe('1210598510999633971');
  });
});

describe('widgetUrl', () => {
  it('points at the public widget endpoint for the guild', () => {
    expect(widgetUrl('123')).toBe('https://discord.com/api/guilds/123/widget.json');
  });
});

describe('inviteUrl', () => {
  it('asks the invite endpoint for counts', () => {
    expect(inviteUrl('AbC123')).toBe('https://discord.com/api/v9/invites/AbC123?with_counts=true');
  });

  it('url-encodes the code', () => {
    expect(inviteUrl('a b')).toBe('https://discord.com/api/v9/invites/a%20b?with_counts=true');
  });
});

describe('inviteCodeFrom', () => {
  it('takes the last path segment of the instant invite', () => {
    expect(inviteCodeFrom('https://discord.gg/AbC123')).toBe('AbC123');
  });

  it('also handles the long invite form', () => {
    expect(inviteCodeFrom('https://discord.com/invite/AbC123')).toBe('AbC123');
  });

  it('drops a query string', () => {
    expect(inviteCodeFrom('https://discord.gg/AbC123?event=1')).toBe('AbC123');
  });

  it('returns null when the widget has no invite', () => {
    expect(inviteCodeFrom(null)).toBeNull();
    expect(inviteCodeFrom(undefined)).toBeNull();
    expect(inviteCodeFrom('https://discord.gg/')).toBeNull();
  });
});

describe('guildIconUrl', () => {
  it('uses png for a static icon hash', () => {
    expect(guildIconUrl('123', 'abc')).toBe('https://cdn.discordapp.com/icons/123/abc.png?size=128');
  });

  it('uses gif for an animated icon hash', () => {
    expect(guildIconUrl('123', 'a_abc')).toBe('https://cdn.discordapp.com/icons/123/a_abc.gif?size=128');
  });
});

describe('totalMemberCount', () => {
  it('prefers approximate_member_count', () => {
    expect(totalMemberCount({ approximate_member_count: 260, profile: { member_count: 1 } })).toBe(260);
  });

  it('falls back to profile.member_count', () => {
    expect(totalMemberCount({ profile: { member_count: 259 } })).toBe(259);
  });

  it('is undefined when neither is present', () => {
    expect(totalMemberCount({})).toBeUndefined();
  });
});

describe('countsLabel', () => {
  it('shows only the online count before the invite lookup', () => {
    expect(countsLabel(12)).toBe('12 online');
  });

  it('adds the total once known', () => {
    expect(countsLabel(12, 260)).toBe('12 online · 260 members');
  });

  it('treats a zero total as unknown', () => {
    expect(countsLabel(12, 0)).toBe('12 online');
  });
});

describe('statusClass', () => {
  it('passes through the three known presence values', () => {
    expect(statusClass('online')).toBe('online');
    expect(statusClass('idle')).toBe('idle');
    expect(statusClass('dnd')).toBe('dnd');
  });

  it('maps anything else to offline', () => {
    expect(statusClass('invisible')).toBe('offline');
    expect(statusClass(undefined)).toBe('offline');
  });
});
