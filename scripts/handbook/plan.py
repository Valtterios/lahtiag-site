# The shot list for the handbook pictures: which page, signed in as whom,
# what to crop to and what to highlight. Writes shots.json (for shoot.mjs)
# and jobs.json (for post.py) next to itself. Run from the repository root.
import json
import sqlite3, glob
_db = [f for f in glob.glob('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite') if 'metadata' not in f][0]
BEN = sqlite3.connect(_db).execute("SELECT code FROM tickets WHERE holder_name='Ben K'").fetchone()[0]
OUT = 'docs/images/site'
SHOTS = 'scripts/handbook/shots'
S = []  # name, url, as, opts (shot), post opts
def shot(name, url, as_='none', device=None, clip=None, hl=(), pad=12, top=None, skip=None, extend=None, width=None, nums=False, vw=None, vh=None, **kw):
    s = {'name': name, 'url': url, 'as': as_, 'clip': clip, 'hl': list(hl)}
    if vw: s['width'] = vw
    if vh: s['height'] = vh
    if device: s['device'] = device
    s.update(kw)
    job = {'src': f'{SHOTS}/{name}.png', 'rects': f'{SHOTS}/{name}.json', 'clip': 'auto' if clip else None, 'pad': pad,
           'hl': [{'i': i, **({'n': i + 1} if nums else {})} for i in range(len(hl))],
           'width': width or (780 if device == 'mobile' else 1200), 'out': f'{OUT}/{name}.png'}
    for k, v in (('top', top), ('skip', skip), ('extend', extend)):
        if v is not None: job[k] = v
    S.append((s, job))

# Signing in, who can do what
shot('header-signin', '/events', clip='header.site-header', hl=['#site-account'], pad=0)
shot('footer-board-login', '/events', clip='footer.site-footer', hl=['footer a[href="/register"]', 'footer a[href="/handbook"]'], pad=0, nums=True)
shot('signed-in-bar', '/events', 'admin', clip='.session-box', hl=['text=Member check'], pad=8)
shot('board-tools-folded', '/events', 'admin', clip='details.admin-panel', hl=['details.admin-panel > summary'], pad=10)
shot('view-as-pill', '/events', 'admin', clip='.view-as', pad=40, keepPill=True, viewportOnly=True)
# Members
shot('register-toolbar', '/register', 'admin', clip='.stat-tiles', skip=-165, hl=['text=Add entry', 'text=Venue lookup', 'text=Access', 'text=Export CSV'], nums=True)
shot('register-queue', '/register', 'admin', clip={'sel': 'section.queue', 'i': 0}, hl=['text=Approve', 'text=Merge into this entry'], pad=8, nums=True)
shot('register-link-request', '/register', 'admin', clip={'sel': 'section.queue', 'i': 1}, hl=['text=Confirm link'], pad=8)
shot('register-actives', '/register', 'admin', clip={'sel': 'section.queue', 'i': 2}, hl=['text=Approve as active'], pad=8)
shot('register-list', '/register', 'admin', clip='section.list', top=470, hl=['.segmented', '.register-search input'], nums=True)
shot('register-numbers', '/register', 'admin', clip='section.numbers')
shot('register-entry', '/register/11', 'admin', clip='h1', pad=20, extend=170, hl=['text=Approve membership', 'text=Reject and delete'], nums=True)
shot('register-member-entry', '/register/2', 'admin', clip='h1', pad=20, extend=170, hl=['text=Mark as former member'])
shot('register-access', '/register/access', 'admin', clip='h1', skip=-10, extend=400, hl=['text=Grant access'])
shot('lookup', '/register/lookup?q=mikko', 'admin', device='mobile', clip='h1', skip=-10, extend=560)
shot('membership-top', '/membership', 'admin', clip='.page-head', skip=-10, extend=560, hl=['.leaderboard-optin', 'nav.tabs'], nums=True)
shot('membership-actives', '/membership', 'admin', clip={'sel': '#membership .panel-card', 'i': 0}, hl=['text=I want to be an active'], pad=8)
shot('membership-minecraft', '/membership#minecraft', 'admin', clip='.mc-card', hl=['text=Change', 'text=Ask the board'], pad=8, nums=True)
shot('join', '/join', clip='h1', skip=-10, extend=470, hl=['text=Sign in, then apply'])
# The board's own pages
shot('board-hub', '/board', 'admin', clip='.board-links', pad=16, hl=['text=Season'])
shot('season-top', '/board/season', 'admin', clip='h1', skip=0, extend=700, hl=['.stat-tiles'])
shot('season-ticks', '/board/season', 'admin', clip='#ticks', pad=12, hl=['text=Give tick', 'text=Add to the list'], nums=True)
shot('season-claims', '/board/season', 'admin', clip='#claims', pad=12, hl=['text=Approve'])
shot('event-ticks', '/events/2', 'admin', open=['details.admin-panel'], openText=['Manage participants'], clip='.ticks-box', pad=12, hl=['text=Give tick'])
# Events
shot('events-list', '/events', top=790, pad=0)
shot('events-board-tools', '/events', 'admin', open=['details.admin-panel'], clip='details.admin-panel', top=330, hl=['text=Member check', 'text=Minecraft whitelist', 'text=News', 'text^=Create an event'])
shot('event-board-tools', '/events/1', 'admin', open=['details.admin-panel'], clip='details.admin-panel', hl=['.admin-status', 'text=Door page', 'text^=Tickets ·'], nums=True)
shot('event-draft-page', '/events/6', 'admin', top=640, pad=0, hl=['.publish-form', 'text=Draft'])
shot('event-tickets-panel', '/events/1', 'admin', open=['details.admin-panel'], openText=['Tickets'], clip='details^=Tickets', top=520, hl=['text=Export CSV', 'text=Door page'], nums=True)
shot('event-questions-panel', '/events/1', 'admin', open=['details.admin-panel'], openText=['Questions'], clip='details^=Questions', top=330, hl=['text=Add question'])
shot('event-participants-panel', '/events/2', 'admin', open=['details.admin-panel'], openText=['Manage participants'], clip='details^=Manage participants', top=480, hl=['text=Add participant'])
shot('event-roster-waitlist', '/events/2', 'admin', clip={'text': "Who's coming", 'closest': 'section'}, hl=['text=Waitlist:'], pad=8)
shot('event-edit-panel', '/events/1', 'admin', open=['details.admin-panel', 'details.admin-edit'], clip='details.admin-edit', top=420)
shot('event-cover-duplicate', '/events/1', 'admin', open=['details.admin-panel', 'details.admin-edit'], clip='.cover-form', pad=16, extend=80, hl=['text=Replace cover', 'text=Duplicate as a draft', 'text=Cancel this event'], nums=True)
shot('event-photos-panel', '/events/1', 'admin', open=['details.admin-panel'], openText=['Photos'], clip='details^=Photos', hl=['text=Upload'])
shot('event-danger', '/events/1', 'admin', open=['details.admin-panel'], openText=['Danger zone'], clip='details^=Danger zone')
shot('bracket-draft', '/events/3/bracket', 'admin', clip='h1', skip=-40, extend=730, hl=['text=Save seeding', 'text=Go live'], nums=True)
shot('bracket-live', '/events/4/bracket', 'admin', clip='h1', skip=-40, extend=430)
shot('event-member-tickets', '/events/1', 'sara', clip='.tickets-box', hl=['text=Add for a friend'], pad=8)
shot('presenter', '/events/4/bracket?display', viewportOnly=True, pad=0, width=1400, vw=1920, vh=1080)
# Tickets, shop, door
shot('shop-board-tools', '/shop', 'admin', open=['details.admin-panel'], clip='details.admin-panel', top=560, hl=['text=Items to hand over', 'text=Edit', 'text=Replace picture'], nums=True)
shot('shop-new-product', '/shop', 'admin', open=['details.admin-panel'], clip='text=New product', skip=-10, extend=470, hl=['text=Add product'])
shot('orders', '/shop/orders', 'admin', clip='h1', skip=-20, extend=580, hl=['text=Attach', 'text=Handed over'], nums=True)
shot('door-scan', '/events/1/door', 'admin', device='mobile', clip='h1', skip=-30, extend=360, hl=['#door-form input', 'text=Scan with camera'], nums=True)
shot('door-sell', '/events/1/door', 'admin', device='mobile', clip='section.door-sell', top=372)
shot('door-tap', '/events/1/door', 'admin', device='mobile', clip='section.door-tap', extend=480, hl=['text=Attach'])
shot('door-list', '/events/1/door', 'admin', device='mobile', clip='section.list', top=560, hl=[{'text': 'Check in', 'i': 0}, {'text': 'Undo', 'i': 0}], nums=True)
shot('ticket-page', f'/tickets/{BEN}', 'ben', device='mobile', clip='h1', skip=-20, extend=720, hl=['text^=Mark as used'])
shot('purchase-page', '/purchase/PSHOPAB12C', 'sara', device='mobile', clip='h1', skip=-20, extend=720, hl=['text=Mark as collected'])
# News
shot('news-board-tools', '/announcements', 'admin', open=['details.admin-panel'], clip='details.admin-panel', hl=['details.admin-panel input[type=file]', 'details.admin-panel select', 'details.admin-panel input[type=date]'], nums=True)
shot('news-draft', '/announcements', 'admin', clip={'sel': 'article.news-card', 'i': 0}, hl=['text=Publish', {'text': 'Edit this post', 'i': 0}], pad=0, nums=True)
shot('news-edit-draft', '/announcements', 'admin', open=['details.news-edit'], clip={'sel': 'details.news-edit', 'i': 0}, hl=['details.news-edit select', {'sel': 'details.news-edit input[type=date]', 'i': 0}], nums=True)
shot('news-published-cover', '/announcements', 'admin', clip={'sel': 'article.news-card', 'i': 2}, top=700, hl=['text=Remove cover'], pad=0)
# Minecraft, history
shot('whitelist-table', '/whitelist', 'admin', clip='.page-head', skip=-10, extend=1180, hl=['text=Approve', '#hand-over form', '.wl-names .segmented'], nums=True)
shot('history-hall', '/history', clip='h1', skip=-10, extend=780)

json.dump({'base': 'http://localhost:8788', 'shots': [s for s, _ in S]}, open('scripts/handbook/shots.json', 'w'), indent=1)
json.dump([j for _, j in S], open('scripts/handbook/jobs.json', 'w'), indent=1)
print(len(S), 'shots planned')
