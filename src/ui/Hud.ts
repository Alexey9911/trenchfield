import type { KillEvent, RosterEntry } from '../game/Match';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** DOM HUD: dog-tag health cluster, ammo block, killfeed, points ticker. */
export class Hud {
  private root = el<HTMLDivElement>('hud');
  private healthFill = el<HTMLDivElement>('health-fill');
  private healthNum = el<HTMLSpanElement>('health-num');
  private ammoMag = el<HTMLSpanElement>('ammo-mag');
  private ammoReserve = el<HTMLSpanElement>('ammo-reserve');
  private weaponName = el<HTMLSpanElement>('weapon-name');
  private pipFrag = el<HTMLDivElement>('pip-frag');
  private pipSmoke = el<HTMLDivElement>('pip-smoke');
  private pipFlash = el<HTMLDivElement>('pip-flash');
  private scopeOverlay = el<HTMLDivElement>('scope-overlay');
  private flashOverlay = el<HTMLDivElement>('flash-overlay');
  private timer = el<HTMLDivElement>('match-timer');
  private points = el<HTMLSpanElement>('tp-value');
  private sessionPoints = el<HTMLSpanElement>('tp-session');
  private killfeed = el<HTMLDivElement>('killfeed');
  private crosshair = el<HTMLDivElement>('crosshair');
  private hitmarkerEl = el<HTMLDivElement>('hitmarker');
  private scorePop = el<HTMLDivElement>('score-pop');
  private streakBanner = el<HTMLDivElement>('streak-banner');
  private damageVignette = el<HTMLDivElement>('damage-vignette');
  private scoreboardEl = el<HTMLDivElement>('scoreboard');
  private scoreboardBody = el<HTMLTableSectionElement>('scoreboard-body');
  private reloadHint = el<HTMLDivElement>('reload-hint');
  private toast = el<HTMLDivElement>('hud-toast');
  private lockHint = el<HTMLDivElement>('lock-hint');
  private liveLbBody = el<HTMLOListElement>('live-lb-body');
  private tpLabel = el<HTMLDivElement>('tp-label');
  private scoreboardTitle = el<HTMLHeadingElement>('scoreboard-title');
  private lowHealthActive = false;
  private hitmarkerTimeout = 0;
  private scorePopTimeout = 0;
  private streakTimeout = 0;
  private toastTimeout = 0;

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setLockHint(show: boolean): void {
    this.lockHint.classList.toggle('show', show);
  }

  /** points cluster label + scoreboard title differ for solo vs multiplayer */
  setMode(mode: 'solo' | 'mp', pointsLabel: string, scoreboardTitle: string): void {
    void mode;
    this.tpLabel.innerHTML = pointsLabel;
    this.scoreboardTitle.textContent = scoreboardTitle;
  }

  /** compact always-on standings (top 5). */
  setLiveLeaderboard(entries: RosterEntry[]): void {
    const top = entries.slice(0, 5);
    this.liveLbBody.innerHTML = top
      .map(
        (e, i) => `
        <li class="${e.isPlayer ? 'you' : ''}">
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">${e.name}</span>
          <span class="lb-k">${e.kills}</span>
        </li>`,
      )
      .join('');
  }

  reset(): void {
    this.killfeed.innerHTML = '';
    this.setHealth(100, 100);
    this.streakBanner.classList.remove('show');
    this.scorePop.classList.remove('show');
    this.hitmarkerEl.classList.remove('show', 'head');
  }

  setHealth(health: number, max: number): void {
    const pct = Math.max(0, Math.min(1, health / max));
    this.healthFill.style.transform = `scaleX(${pct})`;
    this.healthNum.textContent = String(Math.ceil(health));
    this.healthFill.classList.toggle('low', pct < 0.35);
    const low = pct < 0.35;
    if (low !== this.lowHealthActive) {
      this.lowHealthActive = low;
      this.damageVignette.classList.toggle('low-health', low);
    }
    this.damageVignette.style.setProperty('--dmg', String(Math.pow(1 - pct, 1.6) * 0.55));
  }

  setAmmo(
    mag: number,
    reserve: number,
    weapon: string,
    pips: { frag: number; smoke: number; flash: number },
  ): void {
    this.ammoMag.textContent = String(mag);
    this.ammoReserve.textContent = String(reserve);
    this.weaponName.textContent = weapon;
    this.ammoMag.classList.toggle('empty', mag === 0);
    const apply = (node: HTMLDivElement, ready: number): void => {
      node.style.setProperty('--ready', String(ready));
      node.classList.toggle('ready', ready >= 1);
    };
    apply(this.pipFrag, pips.frag);
    apply(this.pipSmoke, pips.smoke);
    apply(this.pipFlash, pips.flash);
  }

  setScope(amount: number): void {
    const active = amount > 0.55;
    this.scopeOverlay.classList.toggle('show', active);
    this.crosshair.classList.toggle('hidden-by-scope', active);
  }

  flashBang(intensity: number, duration: number): void {
    this.flashOverlay.style.transition = 'none';
    this.flashOverlay.style.opacity = String(Math.min(intensity * 1.35, 1));
    void this.flashOverlay.offsetWidth;
    this.flashOverlay.style.transition = `opacity ${duration.toFixed(2)}s ease-out`;
    this.flashOverlay.style.opacity = '0';
  }

  setReloading(active: boolean): void {
    this.reloadHint.classList.toggle('show', active);
  }

  setTimer(text: string, urgent: boolean): void {
    this.timer.textContent = text;
    this.timer.classList.toggle('urgent', urgent);
  }

  setPoints(wallet: number, session: number): void {
    this.points.textContent = wallet.toLocaleString('en-US');
    this.sessionPoints.textContent = `+${session.toLocaleString('en-US')}`;
  }

  addKillFeed(ev: KillEvent): void {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const killer = `<span class="${ev.killerIsPlayer ? 'kf-you' : 'kf-bot'}">${ev.killerName}</span>`;
    const victim = `<span class="${ev.victimIsPlayer ? 'kf-you' : 'kf-bot'}">${ev.victimName}</span>`;
    const icon = ev.headshot ? '☠' : '✕';
    row.innerHTML = `${killer}<span class="kf-icon${ev.headshot ? ' hs' : ''}">${icon}</span>${victim}`;
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 5) {
      this.killfeed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      row.classList.add('fade');
      window.setTimeout(() => row.remove(), 600);
    }, 5200);
  }

  hitmarker(headshot: boolean): void {
    this.hitmarkerEl.classList.remove('show', 'head');
    void this.hitmarkerEl.offsetWidth;
    this.hitmarkerEl.classList.add('show');
    if (headshot) this.hitmarkerEl.classList.add('head');
    window.clearTimeout(this.hitmarkerTimeout);
    this.hitmarkerTimeout = window.setTimeout(() => {
      this.hitmarkerEl.classList.remove('show', 'head');
    }, 140);
  }

  showScorePop(points: number, reason: string): void {
    this.scorePop.innerHTML = `<strong>+${points}</strong><span>${reason}</span>`;
    this.scorePop.classList.remove('show');
    void this.scorePop.offsetWidth;
    this.scorePop.classList.add('show');
    window.clearTimeout(this.scorePopTimeout);
    this.scorePopTimeout = window.setTimeout(() => this.scorePop.classList.remove('show'), 1400);
  }

  showStreakBanner(text: string): void {
    this.streakBanner.textContent = text;
    this.streakBanner.classList.remove('show');
    void this.streakBanner.offsetWidth;
    this.streakBanner.classList.add('show');
    window.clearTimeout(this.streakTimeout);
    this.streakTimeout = window.setTimeout(() => this.streakBanner.classList.remove('show'), 2200);
  }

  showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => this.toast.classList.remove('show'), 1800);
  }

  damageFlash(): void {
    this.damageVignette.classList.remove('flash');
    void this.damageVignette.offsetWidth;
    this.damageVignette.classList.add('flash');
  }

  setCrosshairSpread(px: number, ads: number): void {
    this.crosshair.style.setProperty('--spread', `${px.toFixed(1)}px`);
    this.crosshair.style.setProperty('--ads', String(ads));
  }

  setScoreboard(entries: RosterEntry[], visible: boolean): void {
    this.scoreboardEl.classList.toggle('show', visible);
    if (!visible) return;
    this.scoreboardBody.innerHTML = entries
      .map(
        (e, i) => `
        <tr class="${e.isPlayer ? 'you' : ''}">
          <td>${i + 1}</td>
          <td>${e.name}</td>
          <td>${e.archetypeLabel}</td>
          <td>${e.kills}</td>
          <td>${e.deaths}</td>
          <td>${e.score.toLocaleString('en-US')}</td>
        </tr>`,
      )
      .join('');
  }
}
