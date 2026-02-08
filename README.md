# 🔥 StakeFlow

**Focus with money on the line.** Put your stake up, stay focused, or lose it.

## Features

### Mobile/Web Version
- Set focus time (15/25/45/60 min)
- Set your stake ($5-$100)
- Timer with leave detection
- Stats tracking (wins, losses, streaks)
- Share your stats with friends
- PWA - install to home screen

### Desktop Version (Mac/PC)
- Everything from mobile PLUS:
- **AI Screen Monitor** - Takes screenshots every X seconds
- **Distraction Detection** - AI analyzes if you're on TikTok, Instagram, YouTube, etc.
- **3 Strike System** - Get caught 3 times = lose your stake
- Native desktop app experience

## Quick Start

### Web Version
```bash
cd stakeflow
python3 -m http.server 8080
# Open http://localhost:8080
```

### Desktop Version
```bash
cd stakeflow/desktop
npm install
npm start
```

## Deploy

### Vercel (Recommended)
```bash
cd stakeflow
vercel --prod
```

### Surge
```bash
cd stakeflow
surge . your-domain.surge.sh
```

## Tech Stack

- **Web:** Vanilla HTML/CSS/JS, PWA
- **Desktop:** Electron
- **AI:** Claude Vision API (Haiku for speed)

## Environment Variables (Desktop)

For AI screenshot analysis:
```bash
export ANTHROPIC_API_KEY=your_key_here
```

## Monetization Ideas

1. **Freemium** - Free basic, $4.99/mo for AI monitoring
2. **Lifetime** - $29 one-time purchase
3. **Stakes Pool** - Users can wager against each other (future)

## Roadmap

- [ ] Friend challenges / wagering
- [ ] Leaderboards
- [ ] Stripe integration for real money
- [ ] Team/accountability groups
- [ ] iOS/Android native apps

---

Built with 🔥 by Ethan King
