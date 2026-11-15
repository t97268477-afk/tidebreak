# Tidebreak server

This small Node.js app does two things:

1. Serves the game page (`public/index.html`).
2. Runs room-code multiplayer over WebSockets at `/ws`, and referees what players report. It drops hits that deal more damage than the weapon can, hits above a damage-per-second cap, hits on targets out of range, and position jumps faster than the game allows. It also rate-limits messages.

## Run it on your computer

```
npm install
npm start
```

Open http://localhost:8080. Create a room, then open a second tab and join it with the code.

## Put it online

Any Node host that supports WebSockets works: Render, Railway or Fly.io, for example.

- **Render:** create a "Web Service" from this folder. Set the build command to `npm install` and the start command to `npm start`.
- **Railway:** run `railway up` from this folder.
- **Fly.io:** run `fly launch`, then `fly deploy`.

The server reads the `PORT` environment variable that these hosts set for you. Once it's deployed, the game is playable at the service's URL, and it connects to its own `/ws` automatically.

## Hosting the page somewhere else (for example CrazyGames)

If the HTML is uploaded to a different site, tell it where the server lives. Either:

- open `index.html`, find `const TIDEBREAK_SERVER = '';` and set it to `'wss://YOUR-SERVER/ws'`, or
- add `?server=wss://YOUR-SERVER/ws` to the game's URL.

## Health check

`GET /health` returns the number of open rooms and players.
