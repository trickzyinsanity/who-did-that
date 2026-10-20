# Who did that?

A party game for friends, in English and French. Everyone writes one anecdote. The anecdotes then show up one at a time, and the group has 45 seconds to vote on who wrote each one. The person with the most votes is the group's pick (a tie is broken at random). At the end, each verdict is revealed: a right guess shows the author, and a wrong guess stays a secret.

## Play

1. Double-click **start-game.bat**.
2. The first time, it offers to install Cloudflare's free tunnel tool (`cloudflared`). Say yes: it's what gives you a link your friends can open from anywhere.
3. A browser opens on the game, and the window prints a link like `https://something.trycloudflare.com`. Create a game. The waiting room shows the invite link: send it to your friends.
4. Start when at least 3 people are in.

Keep the black window open while you play. Closing it ends the game. The link changes every time you start the game.

## Good to know

- The person who creates the game is the host: they start the game, move to the next anecdote and reveal the verdicts. If the host leaves, someone else takes over.
- If someone's phone disconnects, opening the link again puts them back in their seat. Joining again with the same name works too.
- You can't vote for yourself. You can change your vote until the timer ends, and the round ends early once everyone has voted.
- People who join mid-game watch until the next game.
- Sound and language (EN/FR) can be switched at the top of the screen.

## Without the online link

`npm start` runs the game at http://localhost:3000 for this computer and your Wi-Fi only. `npm run online` does the same as start-game.bat.
