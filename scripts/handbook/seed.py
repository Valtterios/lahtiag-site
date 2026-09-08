# Fictional sample data for the handbook screenshots, written straight into
# the LOCAL D1 file (never the remote database). Run from the repository
# root after `npx wrangler d1 migrations apply lahtiag --local`; see
# docs/OPERATIONS.md, "Editing this handbook". Every person here is made up.
import sqlite3, random, unicodedata, io, glob, time
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont

DB = [f for f in glob.glob('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite') if 'metadata' not in f][0]
HKI = ZoneInfo('Europe/Helsinki')
def t(s):  # 'YYYY-MM-DD HH:MM' Helsinki -> unix
    return int(datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=HKI).timestamp())
NOW = t('2026-09-06 21:30')
random.seed(7)
ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
def code(n=10): return ''.join(random.choice(ALPHABET) for _ in range(n))
def key(*parts): return unicodedata.normalize('NFD', ' '.join(p for p in parts if p)).encode('ascii', 'ignore').decode().lower()
def did(n): return f'1000000000000000{n:02d}'

con = sqlite3.connect(DB)
c = con.cursor()
for tbl in ['members','teams','team_members','events','signups','announcements','event_teams','bracket_matches','register_admins','register','settings','ticket_types','tickets','door_payments','event_questions','signup_answers','purchases','products','purchase_items','event_covers','product_images','event_role_grants','event_discord_channels','event_interest','event_waitlist','waitlist_promotions','event_photos','milestones','announcement_covers','minecraft_names']:
    c.execute(f'DELETE FROM {tbl}')

people = [  # n, first, full name, domicile, email, student, union, type, discord name, status, source, applied, wants_active, is_active
 (1,'Aino','Aino Virtanen','Lahti','aino.virtanen@student.lut.fi','LUT','LTKY','full','aino.v','member','web','2024-09-10 12:00',1,1),
 (2,'Mikko','Mikko Lahtinen','Lahti','mikko.lahtinen@student.lab.fi','LAB','KOE','full','mikko_l','member','import','2023-10-02 12:00',0,0),
 (3,'Ben','Ben Korhonen','Hollola','ben.korhonen@gmail.com','other','none','external','benk','member','web','2025-02-14 12:00',0,0),
 (4,'Cara','Cara Nieminen','Lahti','cara.nieminen@student.lut.fi','LUT','LTKY','full','cara_n','member','web','2025-09-03 12:00',0,0),
 (5,'Eetu','Eetu Mäkelä','Lahti','eetu.makela@student.lab.fi','LAB','KOE','full','eetu','member','import','2023-09-20 12:00',1,0),
 (6,'Sara','Sara Koskinen','Heinola','sara.koskinen@student.lut.fi','LUT','LTKY','full','sarak','member','web','2024-10-05 12:00',0,0),
 (7,'Juho','Juho Heikkinen','Lahti','juho.heikkinen@student.lab.fi','LAB','none','full','juho_h','member','web','2026-01-20 12:00',0,0),
 (8,'Noora','Noora Salminen','Lahti','noora.salminen@gmail.com','alumni','none','external','noora','former','import','2022-11-11 12:00',0,0),
 (9,'Leo','Leo Hämäläinen','Orimattila','leo.hamalainen@student.lut.fi','LUT','LTKY','full','leo_h','member','web','2025-09-15 12:00',1,1),
 (10,'Venla','Venla Rantanen','Lahti','venla.rantanen@student.lab.fi','LAB','KOE','full',None,'member','import','2024-02-02 12:00',0,0),
 (11,'Oskari','Oskari Laine','Lahti','oskari.laine@student.lut.fi','LUT','LTKY','full','oskari','pending','web','2026-09-04 18:12',1,0),
 (12,'Emma','Emma Toivonen','Lahti','emma.toivonen@gmail.com','LUT','LTKY','full','emma.t','pending','web','2026-09-05 09:40',0,0),
 (13,'Mikko','Mikko Lahtinen','Lahti','mikko.lahtinen@gmail.com','LAB','KOE','full','mikko_l','pending','web','2026-09-06 14:05',0,0),
 (14,'Iida','Iida Jokinen','Lahti','iida.jokinen@student.lut.fi','LUT','LTKY','full','iida','member','web','2026-08-28 12:00',0,0),
 (15,'Onni','Onni Kinnunen','Lahti','onni.kinnunen@gmail.com','alumni','none','honorary',None,'member','board','2021-05-05 12:00',0,0),
 (16,'Helmi','Helmi Rautio','Lahti','helmi.rautio@student.lut.fi','LUT','LTKY','full','helmi','member','web','2024-11-20 12:00',0,0),
 (17,'Elias','Elias Peltola','Lahti','elias.peltola@student.lab.fi','LAB','KOE','full','elias_p','member','web','2025-03-08 12:00',0,0),
 (18,'Sofia','Sofia Ahonen','Nastola','sofia.ahonen@student.lut.fi','LUT','LTKY','full','sofia','member','web','2025-10-01 12:00',0,0),
 (19,'Väinö','Väinö Lehtonen','Lahti','vaino.lehtonen@student.lab.fi','LAB','KOE','full','vaino','member','web','2026-02-11 12:00',0,0),
 (20,'Ella','Ella Mattila','Lahti','ella.mattila@student.lut.fi','LUT','LTKY','full','ella_m','member','import','2023-11-30 12:00',0,0),
]
for n, first, full, dom, email, stu, uni, typ, dname, status, src, applied, wants, active in people:
    if dname and n != 13:
        c.execute('INSERT INTO members (discord_id, username, avatar_hash, last_seen) VALUES (?,?,NULL,?)', (did(n), first, NOW - n * 3600))
    a = t(applied)
    decided = a + 86400 if status != 'pending' else None
    c.execute('''INSERT INTO register (id, full_name, domicile, email, student_status, union_member, member_type, telegram, discord_name, discord_id, games, wants_active, message, board_note, status, source, applied_at, consented_at, decided_at, decided_by, updated_at, search_key, is_active, active_since, active_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
              (n, full, dom, email, stu, uni, typ, None, dname, did(n) if dname and n not in (13,) else None,
               random.choice(['CS2, Mario Kart', 'Minecraft', 'League, Valorant', 'Board games, Mario Kart', None]),
               wants, 'Mainly CS2 and Mario Kart, happy to help at LANs.' if n == 11 else None, 'Lends the projector.' if n == 2 else None,
               status, src, a, a, decided, 'aino.virtanen@lahtiag.fi' if decided else None, a, key(full, email, dname), active, a + 86400 if active else None, 'aino.virtanen@lahtiag.fi' if active else None))
# Venla asks to link her Discord account
c.execute('UPDATE register SET link_discord_id = ?, link_discord_name = ?, link_requested_at = ? WHERE id = 10', (did(10), 'venla', NOW - 3 * 3600))
c.execute('INSERT INTO members (discord_id, username, avatar_hash, last_seen) VALUES (?,?,NULL,?)', (did(10), 'Venla', NOW - 3 * 3600))
c.execute('INSERT INTO register_admins (email, added_by, added_at) VALUES (?,?,?)', ('aino.virtanen@lahtiag.fi', 'puheenjohtaja@lahtiag.fi', t('2026-06-01 12:00')))

# --- events ---------------------------------------------------------------
def event(id, title, desc, start, end, cap, team_size=None, published='2026-08-30 10:00', location=None, organizers=None, member_slots=None, created='2026-08-29 12:00', bracket_live=None, closed=None, link=None):
    c.execute('''INSERT INTO events (id, title, description, starts_at, capacity, created_by, created_at, team_size, organizers, signups_closed_at, ends_at, link_url, members_only, member_slots, location, published_at, bracket_live_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)''',
              (id, title, desc, t(start), cap, did(1), t(created), team_size, organizers, t(closed) if closed else None, t(end) if end else None, link, member_slots, location, t(published) if published else None, t(bracket_live) if bracket_live else None))
event(1, 'Autumn LAN 2026', 'A full day of LAN at the campus: bring your own machine, we bring the network, the power and the tournaments.\n\n**Schedule**\n\n- 12:00 doors, setup\n- 14:00 CS2 fun cup\n- 18:00 dinner for the dinner ticket holders\n- 20:00 Mario Kart\n\nMembers pay the member price. Guests are welcome.', '2026-10-03 12:00', '2026-10-03 22:00', 38, location='LAB campus, Mukkulankatu 19, Lahti', organizers='Aino, Leo', member_slots=10, link='https://discord.gg/lahtiag')
event(2, 'Board game night', 'Catan, Codenames and whatever you bring. Snacks from the association.', '2026-09-17 18:00', '2026-09-17 22:00', 12, published='2026-09-01 10:00', location='LTKY lounge, Lahti', created='2026-08-31 12:00')
event(3, 'Autumn CS2 Cup 2026', 'Five-a-side, single elimination, best of one until the final. Form your team on this page.', '2026-10-17 15:00', '2026-10-17 20:00', 8, team_size=5, published='2026-09-02 10:00', location='Online, Discord', organizers='Leo', created='2026-09-01 12:00')
event(4, 'Spring CS2 Cup 2026', 'The spring five-a-side.', '2026-04-19 15:00', '2026-04-19 19:00', 8, team_size=5, published='2026-04-01 10:00', created='2026-03-30 12:00', bracket_live='2026-04-19 15:05', closed='2026-04-19 14:00')
event(5, 'Mario Kart Tournament, May 2026', 'Eight players, Switch, 150cc.', '2026-05-12 17:00', '2026-05-12 20:00', 16, published='2026-04-28 10:00', created='2026-04-27 12:00')
event(6, 'Winter LAN 2027', 'Draft. Same recipe as the autumn one, in January.', '2027-01-23 12:00', '2027-01-23 22:00', 40, published=None, created='2026-09-05 12:00')
event(7, 'Hangout Game Afternoon', 'Wellbeing week: come play, no competition.', '2026-03-11 15:00', '2026-03-11 18:00', None, published='2026-03-01 10:00', created='2026-02-28 12:00')

def signup(ev, n, status='yes', team=None, when=None):
    c.execute('INSERT INTO signups (event_id, discord_id, status, created_at, event_team_id) VALUES (?,?,?,?,?)', (ev, did(n), status, when or (NOW - random.randint(3600, 400000)), team))
# Board game night: full, with a waitlist
for n in [1,2,3,4,5,6,7,9,11,12,14,16]: signup(2, n)
for n in [17, 18]: c.execute('INSERT INTO event_waitlist (event_id, discord_id, created_at) VALUES (?,?,?)', (2, did(n), NOW - 20000 * n))
for n in [19, 20, 10]: c.execute('INSERT INTO event_interest (event_id, discord_id, source, created_at) VALUES (?,?,?,?)', (2, did(n), 'site', NOW - 50000))
# Past events: attendance
for n in [1,2,3,4,5,6,7,9,14]: signup(5, n, when=t('2026-05-01 12:00'))
for n in [1,2,4,6,16,17,20]: signup(7, n, when=t('2026-03-05 12:00'))

def team(id, ev, name, by, members):
    c.execute('INSERT INTO event_teams (id, event_id, name, created_by, created_at) VALUES (?,?,?,?,?)', (id, ev, name, did(by), NOW - 200000 - id * 1000))
    for n in members: signup(ev, n, team=id, when=NOW - 190000 - n * 100)
team(1, 3, 'Nullpointers', 2, [2, 5, 7, 19])
team(2, 3, 'Lahti Legends', 3, [3, 4, 6, 14, 18])
team(3, 3, 'Ctrl+Alt+Elite', 9, [9, 1, 16, 17, 20])
team(4, 3, 'Byte Me', 12, [12, 11])
c.executemany('INSERT INTO bracket_matches (event_id, round, slot, side_a, side_b, winner) VALUES (?,?,?,?,?,?)', [
    (3, 1, 0, 't:1', 't:4', None), (3, 1, 1, 't:2', 't:3', None), (3, 2, 0, None, None, None)])
team(5, 4, 'Nullpointers', 2, [2, 5, 7, 19, 3])
team(6, 4, 'Lahti Legends', 4, [4, 6, 14, 18, 12])
team(7, 4, 'Ctrl+Alt+Elite', 9, [9, 1, 16, 17, 20])
team(8, 4, 'Byte Me', 11, [11])
c.executemany('INSERT INTO bracket_matches (event_id, round, slot, side_a, side_b, winner) VALUES (?,?,?,?,?,?)', [
    (4, 1, 0, 't:5', 't:8', 't:5'), (4, 1, 1, 't:6', 't:7', 't:7'), (4, 2, 0, 't:5', 't:7', 't:7')])

# tickets for the LAN
c.executemany('INSERT INTO ticket_types (id, event_id, name, price_cents, member_price_cents, members_only, quantity, sales_close_at, sort, active, description) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
    (1, 1, 'Entry', 800, 500, 0, 40, t('2026-10-03 12:00'), 0, 1, 'A seat, power and network for the whole day.'),
    (2, 1, 'Entry + dinner', 1400, 1100, 0, 20, t('2026-10-01 23:59'), 1, 1, 'The seat plus the 18:00 dinner (vegan option).'),
    (3, 1, 'Spectator', 0, None, 0, None, t('2026-10-03 22:00'), 2, 1, 'Come and watch, free.'),
])
c.executemany('INSERT INTO event_questions (id, event_id, label, kind, options, required, sort) VALUES (?,?,?,?,?,?,?)', [
    (1, 1, 'T-shirt size', 'choice', 'S\nM\nL\nXL', 0, 0), (2, 1, 'Diet', 'text', None, 0, 1), (3, 1, 'I bring my own monitor', 'checkbox', None, 0, 2)])
holders = [  # n or None, name, type, source, checked_in, member?
    (2, 'Mikko L', 1, 'online', '2026-10-03 13:12', True), (1, 'Aino V', 1, 'online', '2026-10-03 13:05', True),
    (3, 'Ben K', 1, 'door', None, True), (4, 'Cara N', 1, 'online', None, True), (5, 'Eetu M', 2, 'online', None, True),
    (6, 'Sara K', 1, 'online', None, True), (7, 'Juho H', 2, 'online', None, True), (9, 'Leo H', 2, 'online', None, True),
    (14, 'Iida J', 1, 'online', None, True), (16, 'Helmi R', 1, 'online', None, True), (17, 'Elias P', 1, 'online', None, True),
    (None, 'Pekka Korhonen', 1, 'online', None, False), (None, 'Anni S', 1, 'online', None, False), (20, 'Ella M', 3, 'online', None, True)]
sold = 0
for i, (n, name, typ, src, checked, member) in enumerate(holders, start=1):
    price = {1: (800, 500), 2: (1400, 1100), 3: (0, 0)}[typ]
    amount = price[1] if member else price[0]
    sold += amount
    pid = 'P' + code(9)
    created = t('2026-09-01 10:00') + i * 7000
    c.execute('INSERT INTO purchases (id, discord_id, buyer_name, status, total_cents, stripe_payment_intent, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?)',
              (pid, did(n) if n else None, name, 'paid', amount, 'pi_' + code(20) if amount else None, created, created + 60))
    c.execute('''INSERT INTO tickets (id, event_id, ticket_type_id, discord_id, holder_name, code, amount_cents, status, source, stripe_payment_intent, created_at, paid_at, checked_in_at, checked_in_by, bought_by, purchase_id)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
              (i, 1, typ, did(n) if n else None, name, code(), amount, 'paid', src, 'pi_' + code(20) if amount else None, created, created + 60, t(checked) if checked else None, did(1) if checked else None, did(n) if n else did(3), pid))
    if n: signup(1, n, when=created)
    if name == 'Ben K':
        c.execute('INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at) VALUES (?,?,?,?,?,?)', (1, 1, did(3), i, 'L', created))
        c.execute('INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at) VALUES (?,?,?,?,?,?)', (2, 1, did(3), i, 'vegan', created))
    if name == 'Eetu M':
        c.execute('INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at) VALUES (?,?,?,?,?,?)', (1, 1, did(5), i, 'M', created))
        c.execute('INSERT INTO signup_answers (question_id, event_id, discord_id, ticket_id, value, updated_at) VALUES (?,?,?,?,?,?)', (3, 1, did(5), i, 'yes', created))
# Tap to Pay payments waiting to be attached: one at a ticket price, one
# at a member's price (and a shop item's), one at neither. These hang off
# the real clock, not the story's: every page that lists them only looks
# back twelve hours, so on the fictional NOW they would have aged out and
# the pictures would come back empty whenever the handbook is reshot.
REAL_NOW = int(time.time())
c.executemany('INSERT INTO door_payments (stripe_payment_intent, amount_cents, created_at, ticket_id, note) VALUES (?,?,?,?,?)', [
    ('pi_3R7Lk9QaX2mN0k9Qa', 800, REAL_NOW - 90, None, 'Pekka K'),
    ('pi_3R7Lm2QaX2mN0kW3b', 1200, REAL_NOW - 480, None, 'Joonas V'),
    ('pi_3R7Ln8QaX2mN0kZ7c', 500, REAL_NOW - 900, None, 'Sara K'),
])

# --- news -----------------------------------------------------------------
c.executemany('INSERT INTO announcements (id, title, body_md, published_at, author_id, source, draft, publish_at, ping) VALUES (?,?,?,?,?,?,?,?,?)', [
    (1, 'Autumn LAN 2026 tickets are on sale', 'The autumn LAN is on **Saturday 3 October** at the LAB campus, 12:00 to 22:00.\n\nTickets are 8 € (members 5 €), or 14 € with dinner. Get yours on the [event page](/events/1); the dinner ticket closes on 1 October.\n\nBring your own machine and a headset. We bring the rest.', t('2026-08-30 10:00'), did(1), 'web', 0, None, 'everyone'),
    (2, 'Invitation to the Autumn General Meeting 2026', 'Dear member,\n\nYou are invited to the Autumn General Meeting of Lahti Association of Gaming on **Tuesday 6 October 2026 at 17:00**, LAB campus room A126.\n\n**Agenda**\n\n1. Opening\n2. Budget and action plan for 2027\n3. Election of the board for 2027\n4. Other business\n\nCoffee and something sweet.', t('2026-09-20 09:00'), did(1), 'web', 1, t('2026-09-20 09:00'), 'everyone'),
    (3, 'Minecraft SMP season 2 is open', 'The survival server is back at **mc.lahtiag.fi**, fresh world. Members whitelist themselves on their membership page or with `/whitelist me <name>` in Discord, and can bring two friends.', t('2026-09-03 16:00'), did(9), 'web', 0, None, None),
])

# --- shop -----------------------------------------------------------------
c.executemany('INSERT INTO products (id, name, description, price_cents, member_price_cents, stock, active, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
    (1, 'LahtiAG patch', 'Embroidered, 7 cm. Sew or iron on.', 500, 400, 23, 1, 0, t('2026-08-01 12:00')),
    (2, 'Sticker sheet', 'Six stickers, weatherproof.', 200, 150, None, 1, 1, t('2026-08-01 12:00')),
    (3, 'Hoodie 2025', 'Navy, last sizes.', 3500, 3000, 0, 0, 2, t('2025-11-01 12:00')),
])
for pid, n, name, total, items in [('PSHOPAB12CD', 6, 'Sara K', 850, [(1, 'LahtiAG patch', 1, 400, None), (2, 'Sticker sheet', 3, 150, t('2026-09-02 18:00'))]), ('PSHOPEF34GH', 3, 'Ben K', 1000, [(1, 'LahtiAG patch', 2, 500, None)])]:
    c.execute('INSERT INTO purchases (id, discord_id, buyer_name, status, total_cents, stripe_payment_intent, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?)', (pid, did(n), name, 'paid', total, 'pi_' + code(20), t('2026-09-02 17:00'), t('2026-09-02 17:01')))
    for prod, pname, qty, unit, delivered in items:
        c.execute('INSERT INTO purchase_items (purchase_id, product_id, name, quantity, unit_cents, delivered_at, delivered_by) VALUES (?,?,?,?,?,?,?)', (pid, prod, pname, qty, unit, delivered, did(1) if delivered else None))

# --- Minecraft --------------------------------------------------------------
c.executemany('INSERT INTO minecraft_names (discord_id, name, kind, added_at, uuid, servers, approved_at, approved_by) VALUES (?,?,?,?,?,?,?,?)', [
    (did(1), 'AinoV', 'own', t('2026-09-03 17:00'), '069a79f4-44e9-4726-a5be-fca90e38aaf5', 'smp,gtnh', t('2026-09-03 17:00'), did(1)),
    (did(2), 'Mikko_L', 'own', t('2026-09-03 18:10'), '853c80ef-3c37-49fd-aa49-938b674adae6', 'smp,gtnh', t('2026-09-03 18:10'), did(2)),
    (did(1), 'Pekka_K', 'friend', t('2026-09-06 19:20'), '61699b2e-d327-4a01-9f1e-0ea8c3f06bc6', 'gtnh', None, None),
    (did(2), 'jonne99', 'friend', t('2026-09-04 12:00'), 'e6b5c088-0680-44df-9e1b-9bf11792291b', 'smp,gtnh', t('2026-09-04 13:00'), did(9)),
    ('board', 'Creeper_Hunter', 'board', t('2026-09-01 12:00'), None, 'smp,gtnh', t('2026-09-01 12:00'), 'board'),
    ('board', 'redstone_rita', 'board', t('2026-09-01 12:00'), None, 'smp,gtnh', t('2026-09-01 12:00'), 'board'),
    ('board', 'xX_Lasse_Xx', 'board', t('2026-09-01 12:00'), None, 'smp', t('2026-09-01 12:00'), 'board'),
])

# --- pictures: a cover for the LAN and the news post, a product photo -------
FONT = '/usr/share/fonts/noto/NotoSans-Bold.ttf'
def poster(text, sub, w=1200, h=675):
    im = Image.new('RGB', (w, h), (30, 30, 30))
    d = ImageDraw.Draw(im)
    d.polygon([(0, h), (w * 0.55, 0), (w, 0), (w, h * 0.35), (w * 0.35, h)], fill=(65, 105, 225))
    d.polygon([(w * 0.62, h), (w, h * 0.45), (w, h)], fill=(255, 222, 89))
    f1 = ImageFont.truetype(FONT, 96); f2 = ImageFont.truetype(FONT, 40)
    d.text((70, h * 0.52), text, font=f1, fill=(255, 255, 255))
    d.text((74, h * 0.52 + 120), sub, font=f2, fill=(255, 222, 89))
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=85); return buf.getvalue(), w, h
b, w, h = poster('AUTUMN LAN 2026', 'Sat 3 Oct · LAB campus · 12:00–22:00')
c.execute('INSERT INTO event_covers (event_id, content_type, bytes, size, updated_at, width, height) VALUES (1,?,?,?,?,?,?)', ('image/jpeg', b, len(b), NOW, w, h))
c.execute('INSERT INTO announcement_covers (announcement_id, content_type, bytes, size, updated_at, width, height) VALUES (1,?,?,?,?,?,?)', ('image/jpeg', b, len(b), NOW, w, h))
b, w, h = poster('WINTER LAN 2027', 'Sat 23 Jan · draft')
c.execute('INSERT INTO event_covers (event_id, content_type, bytes, size, updated_at, width, height) VALUES (6,?,?,?,?,?,?)', ('image/jpeg', b, len(b), NOW, w, h))
# Photos from the events that have been: the front page and the history
# page show them, so the made-up site has a few.
def snap(top, bottom, w=1400, h=933):
    im = Image.new('RGB', (w, h), top)
    d = ImageDraw.Draw(im)
    for y in range(h):
        k = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * k) for i in range(3)))
    d.polygon([(0, h), (w * 0.4, h * 0.45), (w * 0.75, h)], fill=tuple(min(255, c + 25) for c in bottom))
    d.ellipse((w * 0.62, h * 0.12, w * 0.62 + 150, h * 0.12 + 150), fill=(255, 222, 89))
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=80); shot = buf.getvalue()
    thumb = im.resize((400, 267))
    tbuf = io.BytesIO(); thumb.save(tbuf, 'JPEG', quality=75)
    return shot, tbuf.getvalue(), w, h

for event_id, credit, shades in [
    (5, 'Photos: Aino Virtanen', [((28, 34, 66), (65, 105, 225)), ((40, 30, 60), (120, 80, 200)), ((20, 40, 40), (40, 140, 120))]),
    (7, None, [((45, 35, 30), (200, 140, 60)), ((30, 30, 35), (90, 90, 110))]),
    (4, 'Photos: Leo Hämäläinen', [((25, 25, 30), (200, 60, 60))]),
]:
    for i, (top, bottom) in enumerate(shades):
        b, t, w, h = snap(top, bottom)
        c.execute('INSERT INTO event_photos (event_id, content_type, bytes, thumb, size, width, height, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                  (event_id, 'image/jpeg', b, t, len(b), w, h, i, NOW - 86400))
    if credit:
        c.execute('UPDATE events SET photo_credit = ? WHERE id = ?', (credit, event_id))

im = Image.new('RGB', (600, 600), (245, 245, 245)); d = ImageDraw.Draw(im)
d.ellipse((60, 60, 540, 540), fill=(65, 105, 225), outline=(255, 222, 89), width=18)
d.text((150, 230), 'LAG', font=ImageFont.truetype(FONT, 130), fill=(255, 222, 89))
buf = io.BytesIO(); im.save(buf, 'PNG'); b = buf.getvalue()
c.execute('INSERT INTO product_images (product_id, content_type, bytes, size, width, height, updated_at) VALUES (1,?,?,?,?,?,?)', ('image/png', b, len(b), 600, 600, NOW))
con.commit()
print('seeded; tickets sold cents', sold)
