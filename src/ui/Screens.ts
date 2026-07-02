import { Match, type RosterEntry } from '../game/Match';
import { MATCH, type MapId } from '../game/constants';

export type ScreenName = 'landing' | 'pause' | 'death' | 'end' | null;

export interface ScreenCallbacks {
  onDeploy: () => void;
  onResume: () => void;
  onQuitToMenu: () => void;
  onPlayAgain: () => void;
  onSensitivity: (v: number) => void;
  onVolume: (v: number) => void;
  onMute: (muted: boolean) => void;
  onMapSelect: (id: MapId) => void;
  onUiClick: () => void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** Landing page, pause, death and end-of-match screens. */
export class Screens {
  private screens: Record<Exclude<ScreenName, null>, HTMLElement> = {
    landing: el('screen-landing'),
    pause: el('screen-pause'),
    death: el('screen-death'),
    end: el('screen-end'),
  };
  private walletValue = el<HTMLSpanElement>('wallet-value');
  private deathKiller = el<HTMLSpanElement>('death-killer');
  private deathCountdown = el<HTMLSpanElement>('death-countdown');
  private endPlacement = el<HTMLDivElement>('end-placement');
  private endStatsBody = el<HTMLTableSectionElement>('end-standings-body');
  private endTp = el<HTMLSpanElement>('end-tp');
  private endCreatorCut = el<HTMLSpanElement>('end-creator-cut');
  private endKd = el<HTMLSpanElement>('end-kd');
  current: ScreenName = 'landing';

  constructor(cb: ScreenCallbacks) {
    el<HTMLButtonElement>('btn-deploy').addEventListener('click', () => {
      cb.onUiClick();
      cb.onDeploy();
    });
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => {
      cb.onUiClick();
      cb.onResume();
    });
    el<HTMLButtonElement>('btn-quit').addEventListener('click', () => {
      cb.onUiClick();
      cb.onQuitToMenu();
    });
    el<HTMLButtonElement>('btn-redeploy').addEventListener('click', () => {
      cb.onUiClick();
      cb.onDeploy();
    });
    el<HTMLButtonElement>('btn-play-again').addEventListener('click', () => {
      cb.onUiClick();
      cb.onPlayAgain();
    });
    el<HTMLButtonElement>('btn-end-menu').addEventListener('click', () => {
      cb.onUiClick();
      cb.onQuitToMenu();
    });

    const sens = el<HTMLInputElement>('setting-sensitivity');
    sens.addEventListener('input', () => cb.onSensitivity(Number(sens.value)));
    const vol = el<HTMLInputElement>('setting-volume');
    vol.addEventListener('input', () => cb.onVolume(Number(vol.value)));
    const mute = el<HTMLInputElement>('setting-mute');
    mute.addEventListener('change', () => cb.onMute(mute.checked));

    for (const id of ['day', 'night'] as MapId[]) {
      el<HTMLButtonElement>(`map-card-${id}`).addEventListener('click', () => {
        cb.onUiClick();
        this.setSelectedMap(id);
        cb.onMapSelect(id);
      });
    }

    this.refreshWallet();
  }

  refreshWallet(): void {
    this.walletValue.textContent = Match.walletBalance().toLocaleString('en-US');
  }

  setSelectedMap(id: MapId): void {
    for (const m of ['day', 'night'] as MapId[]) {
      el(`map-card-${m}`).classList.toggle('selected', m === id);
    }
  }

  show(name: ScreenName): void {
    this.current = name;
    for (const [key, screen] of Object.entries(this.screens)) {
      screen.classList.toggle('active', key === name);
    }
    document.body.classList.toggle('in-menu', name === 'landing');
    if (name === 'landing') this.refreshWallet();
  }

  setDeathInfo(killerName: string): void {
    this.deathKiller.textContent = killerName;
  }

  setDeathCountdown(seconds: number): void {
    this.deathCountdown.textContent = seconds > 0 ? `${seconds.toFixed(1)}s` : 'READY';
    el<HTMLButtonElement>('btn-redeploy').disabled = seconds > 0;
  }

  setEndResults(
    standings: RosterEntry[],
    placement: number,
    pointsEarned: number,
    creatorCut: number,
  ): void {
    const suffix = placement === 1 ? 'st' : placement === 2 ? 'nd' : placement === 3 ? 'rd' : 'th';
    this.endPlacement.innerHTML =
      placement === 1
        ? `<span class="place-num gold">#1</span> TOP OF THE TRENCH`
        : `<span class="place-num">#${placement}</span> ${placement}${suffix} PLACE`;
    const you = standings.find((s) => s.isPlayer);
    const kd = you ? `${you.kills} / ${you.deaths}` : '0 / 0';
    this.endKd.textContent = kd;
    this.endTp.textContent = `+${pointsEarned.toLocaleString('en-US')} TP`;
    this.endCreatorCut.textContent = `${creatorCut.toLocaleString('en-US')} TP (${MATCH.creatorCutPct}%) → FRONTLINE-7 owner`;
    this.endStatsBody.innerHTML = standings
      .map(
        (e, i) => `
        <tr class="${e.isPlayer ? 'you' : ''}">
          <td>${i + 1}</td>
          <td>${e.name}</td>
          <td>${e.kills}</td>
          <td>${e.deaths}</td>
          <td>${e.score.toLocaleString('en-US')}</td>
        </tr>`,
      )
      .join('');
  }
}
