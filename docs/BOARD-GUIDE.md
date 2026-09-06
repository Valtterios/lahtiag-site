# Board guide to lahtiag.fi

The short version: what the site does for the board, where each thing is,
and what happens behind the scenes. The [technical handbook](/handbook/technical)
has the details, the settings and the fixes.

## Contents

- [Signing in](#signing-in)
- [Who can do what](#who-can-do-what)
- [Members](#members)
- [Events](#events)
- [Tickets and the shop](#tickets-and-the-shop)
- [At the door](#at-the-door)
- [Money](#money)
- [News](#news)
- [Where things are](#where-things-are)

## Signing in

There are two logins.

- **Discord.** Everyone signs in with Discord, top right of every page. A
  board member's account carries the Board role on our server, and that
  unlocks the board tools: creating events, the door, the shop, news.
- **Register login.** The member register holds personal data, so it
  opens only for the chair, the treasurer and whoever they add, through
  the lahtiag.fi Google account. It lasts eight hours. The link is
  "Board login" at the bottom of every page.

## Who can do what

| | Any member | Board role | Register access |
|---|---|---|---|
| Sign up, buy tickets, manage own membership | yes | yes | yes |
| Create and publish events, sell tickets, run the door, shop, news | | yes | yes |
| Check whether someone is a member (name and status) | | yes | yes |
| Open the full register, approve members, export | | | yes |

Board tools sit at the bottom of a page in a folded "Board tools" block,
so nothing sensitive shows when a page is on a projector. A small pill at
the bottom right lets you view a page as a member or a visitor would.

## Members

- **Joining.** People apply at lahtiag.fi/join, ideally signed in with
  Discord so their account is linked from the start. The board's private
  Discord channel gets a note; the application waits in the register.
- **Approving.** On the register page, applications are at the top with
  Approve and Reject. Approving gives the Member role on Discord (and
  Actives, if approved as an active) and posts a welcome in the general
  channel. The register shows a hint if the person may already be in it,
  with the reason, and a Merge button.
- **Members manage themselves** at lahtiag.fi/membership: their details,
  the actives request, linking Discord.
- **Member check.** Any board member: Board login → Member check. Type a
  name, see member or not. Nothing else.
- **Export.** Register access: the register page has a CSV export.

## Events

- **Create** on the events page, Board tools → New event. It is saved as
  a **draft**: only the board sees it. Add a cover picture, a description,
  the location, ticket types and questions from the event's Board tools,
  then press **Publish**. Publishing lists it, opens signups or sales, and
  posts it on Discord. Edits afterwards update the Discord post.
- **Signups or tickets.** An event with no ticket types takes plain
  signups. Add a ticket type and it sells tickets instead; a paid ticket
  is the signup. Set a price, a member price, members-only, a quantity,
  a sales deadline, and a line describing what the ticket includes.
- **Reminders.** The day before an event the bot posts a reminder in the
  event's Discord channel and pings its role; a day before a ticket
  deadline it posts how many are left; when signups open at a set time
  it posts that too. Nothing to press.
- **Duplicate.** Board tools → Duplicate as a draft copies an event a
  week later with its ticket types, questions and cover. Fix the date
  and title, then publish.
- **My events.** Each member's membership page lists what they have a
  stake in: tickets, going, maybe, waitlists and hearts, upcoming only.
- **Signups open later, and the heart.** "Signups open on/at" in the
  event form holds signups and sales until that moment; until then the
  page shows the date and the ♡ Interested button. The count next to the
  heart adds up the site's hearts and the Interested clicks on Discord's
  event list, each person once.
- **Capacity and reserved seats.** The event's capacity is the total.
  "Seats reserved for members" keeps that many for members; non-members
  stop at the rest. Lowering the capacity under the going count moves the
  latest signups to the waitlist, first in line, and tells them. A full
  event with plain signups gets a **waitlist**:
  when a seat frees, the first in line is moved to Going on their own,
  the event's Discord channel tells them, and the roster shows who is
  waiting; the board can let anyone in with ✓, whatever their place or
  the capacity, or take them off with ×.
- **Questions** (T-shirt size, diet, team preference) are asked when
  someone signs up or buys, per ticket, and come out in the exports.
- **Team captains.** Whoever founds a team can add people who signed up
  without a team and take members out, while signups are open. The
  board's Manage participants does the rest.
- **Team events.** Set a team size; people form teams, or the board makes
  teams, renames them and groups loose players under Manage participants.
  Generate the bracket from Board tools: it starts as a draft only the
  board sees, the seeding can be rearranged on the bracket page, and Go
  live shows it to everyone. Substitutes are swapped in on the bracket
  page; results are recorded there or from the Discord panel.
- **On Discord.** Publishing puts the event on Discord's event list
  (cover, blurb, place, link) and asks what else it gets: a role with
  one channel under Events (the usual), or for a big event its own
  category with rules, a bot-only bracket channel, teams, discussion and the Commentators and
  Interviews voice channels, plus a voice channel per team that follows
  the teams as they form.
  The role follows the roster on its own: sign up and you have it, leave
  and it's gone. A week after the event the role is removed on its own
  and the channels stay for the board. Edits and cancellations carry
  over, and the tournament
  talks in the channel: the bracket, every result, the champion and the
  screen messages are posted there by the bot. Board tools → Discord
  shows the state. Afterwards, Archive keeps the channels for the board
  and takes the role away; Delete everything removes them.
- **Photos.** Board tools → Photos takes several pictures at once; the
  page shrinks them before upload. They show on the event page and the
  history page. Up to 40 per event.
- **Cancel** posts a cancellation on Discord and can be undone with
  Reinstate. Delete removes the event for good. Both ask first.

## Tickets and the shop

- **Shop items.** Delete takes a product off the shop and the door for
  good; past purchases keep their line. Unticking On sale keeps it in the
  shop as "Out of stock", with the stock count still yours to edit.

- **Buying.** Event pages and the shop only add to a **basket**. The
  checkout takes names and answers for every ticket and one payment for
  everything, including tickets to several events and shop items.
  Members get member prices automatically. A person can buy tickets for
  friends by name at the public price.
- **Without Discord.** Anyone can buy without signing in; their ticket is
  a link that is also on the receipt.
- **The ticket** is a QR code on its own page, under My tickets. Tickets
  bought for friends are there too, each with its own link to pass on.
- **The shop** (in the header) sells patches and such. Board tools on the
  shop page add products with a picture, prices, stock. Buyers collect
  items at an event; **Items to hand over** lists what is waiting.
- **Refunds** are done in Stripe, by the chair or treasurer. A full refund
  frees the seat and removes the person from the event by itself.

## At the door

Every event has a **door page** (event page → Board tools → Door page).
On a phone it does everything:

- **Scan** a ticket with the camera, or type its code. Scanning marks it
  used; a second scan is refused. The list shows who is in.
- **Sell** to people with a phone: they scan the sales QR, pay on their
  own phone, and appear in the list.
- **Take a card** with the Stripe app on an iPhone (Tap to Pay), then
  pick the person and the ticket or item on the door page.
- **No scanner?** The holder presses "Mark as used" on their ticket in
  front of you; the ticket then shows the **mark of the day**, an icon
  that changes daily and is shown on the door page too, so a screenshot
  from another day gives itself away. Shop items work the same with
  "Mark as collected".

## Money

- **Stripe** takes the payments: cards, Apple Pay, Google Pay, MobilePay,
  Revolut Pay. Buyers get a receipt by email. Payouts go to the Holvi
  account. The chair and treasurer have the Stripe login; door phones use
  the Stripe app.
- **Fees.** About 1.5 % plus 0.25 € per card payment in Europe. Refunds
  cost nothing extra, but the fee of the original payment is not returned.
- **Sales totals** are on each event's Board tools (Tickets), with a CSV
  of every ticket and its answers. The Stripe dashboard has the money
  side.

## News

Board tools on the news page. A post is saved as a draft; **Publish**
puts it on the page and on Discord.

- **Scheduled news.** Save a news post with a publish date and time and
  it goes out by itself, to the site and Discord. Handy for general
  meeting notices written ahead.
- **The bot in Discord.** Announcements carry I'm going, Maybe and
  Interested buttons; a click signs up under the same rules as the site.
  People get a private message when put in a team or let in from a
  waitlist. Mondays at nine the bot posts the week's digest in general;
  winners get the champion role; `/next`, `/champion`, `/roll`, `/coin`
  and `/pick` are there for fun.
- **Your stats.** The membership page shows your events, tournaments and
  wins, with a card; `/profile` in Discord posts the card for everyone.
  A tick there puts you on the public leaderboard on the history page.

## Where things are

| | |
|---|---|
| Register, applications, exports | lahtiag.fi/register (register login) |
| Member check | lahtiag.fi/register/lookup (Board role) |
| Events and the door | lahtiag.fi/events → event → Board tools |
| Shop and items to hand over | lahtiag.fi/shop, lahtiag.fi/shop/orders |
| News | lahtiag.fi/announcements |
| This guide, the technical handbook | lahtiag.fi/handbook, lahtiag.fi/handbook/technical |
| Money, refunds, receipts | dashboard.stripe.com |
| Rules, privacy policy, terms of sale | lahtiag.fi/rules, /privacy, /terms |
