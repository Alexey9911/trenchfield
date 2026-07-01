import { MATCH } from './constants';

export interface RosterEntry {
  id: string;
  name: string;
  isPlayer: boolean;
  archetypeLabel: string;
  kills: number;
  deaths: number;
  score: number;
  streak: number;
}

export interface KillEvent {
  killerName: string;
  victimName: string;
  headshot: boolean;
  killerIsPlayer: boolean;
  victimIsPlayer: boolean;
}

export interface MatchEvents {
  onKillFeed: (ev: KillEvent) => void;
  onPlayerScore: (points: number, reason: string) => void;
  onStreak: (streak: number) => void;
  onMatchEnd: () => void;
}

const WALLET_KEY = 'trenchfield-points';

/** Scoring, roster, timer, Trench Points wallet. */
export class Match {
  roster = new Map<string, RosterEntry>();
  timeLeft: number = MATCH.durationSec;
  running = false;
  pointsEarned = 0;

  constructor(private events: MatchEvents) {}

  static walletBalance(): number {
    const raw = localStorage.getItem(WALLET_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  static addToWallet(points: number): number {
    const total = Match.walletBalance() + points;
    localStorage.setItem(WALLET_KEY, String(total));
    return total;
  }

  register(id: string, name: string, isPlayer: boolean, archetypeLabel: string): void {
    this.roster.set(id, {
      id,
      name,
      isPlayer,
      archetypeLabel,
      kills: 0,
      deaths: 0,
      score: 0,
      streak: 0,
    });
  }

  start(): void {
    this.timeLeft = MATCH.durationSec;
    this.running = true;
    this.pointsEarned = 0;
    for (const e of this.roster.values()) {
      e.kills = 0;
      e.deaths = 0;
      e.score = 0;
      e.streak = 0;
    }
  }

  update(dt: number): void {
    if (!this.running) return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.running = false;
      this.events.onMatchEnd();
    }
  }

  recordKill(killerId: string, victimId: string, headshot: boolean): void {
    const killer = this.roster.get(killerId);
    const victim = this.roster.get(victimId);
    if (!killer || !victim || killerId === victimId) {
      if (victim) {
        victim.deaths += 1;
        victim.streak = 0;
      }
      return;
    }
    killer.kills += 1;
    killer.streak += 1;
    victim.deaths += 1;
    victim.streak = 0;

    let points = MATCH.pointsKill;
    if (headshot) points += MATCH.pointsHeadshot;
    if (killer.streak >= 2) points += (killer.streak - 1) * MATCH.pointsStreakStep;
    killer.score += points;

    this.events.onKillFeed({
      killerName: killer.name,
      victimName: victim.name,
      headshot,
      killerIsPlayer: killer.isPlayer,
      victimIsPlayer: victim.isPlayer,
    });

    if (killer.isPlayer) {
      this.pointsEarned += points;
      const reason = headshot
        ? 'HEADSHOT KILL'
        : killer.streak >= 2
          ? `STREAK x${killer.streak}`
          : 'KILL CONFIRMED';
      this.events.onPlayerScore(points, reason);
      if (killer.streak >= 2) this.events.onStreak(killer.streak);
    }
  }

  standings(): RosterEntry[] {
    return [...this.roster.values()].sort((a, b) => b.score - a.score || b.kills - a.kills);
  }

  playerPlacement(): number {
    const s = this.standings();
    return s.findIndex((e) => e.isPlayer) + 1;
  }

  creatorCut(): number {
    return Math.round((this.pointsEarned * MATCH.creatorCutPct) / 100);
  }

  formatTime(): string {
    const t = Math.max(0, Math.ceil(this.timeLeft));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
