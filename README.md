# Trenches

Foxhole-inspired WW1 global war game. Browser client (HTML5 canvas, pixel style).

## Run
```
npm install
node server.js
```
Open http://localhost:3000

For fast war cycles (testing): `FAST=1 node server.js` (PowerShell: `$env:FAST=1; node server.js`) or add `?fast` to URL (server must be in fast mode).

## Features implemented
- Guest play as infantryman; registration unlocks ranks, building, production
- 2D top-down with trench depth (z levels) affecting bullets
- Military economy, resource nodes, buildings
- AI infantry bots
- 10 ranks gating vehicles/buildings/production
- Map markers & commander order tags
- Walkie-talkie radio chat by frequency (0-999 / 0-999), readable by anyone on freq (including enemies who capture radio)
- Armor/weapon fields, cosmetic tunics by side/rank
- Side selection once per war (vape)
- 10-day war (10 min demo) or MOB capture -> new war
- Profile stats
- Player-count modifiers (costs/speeds scale with population)