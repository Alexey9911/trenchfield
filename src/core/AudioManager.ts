import { clamp, rand } from '../game/constants';

export type AudioGroup = 'sfx' | 'ui' | 'ambience' | 'voice';

const MANIFEST: Record<string, { url: string; group: AudioGroup }> = {
  rifleShot: { url: '/assets/audio/sfx/rifle-shot.mp3', group: 'sfx' },
  scattergunShot: { url: '/assets/audio/sfx/scattergun-shot.mp3', group: 'sfx' },
  sniperShot: { url: '/assets/audio/sfx/sniper-shot.mp3', group: 'sfx' },
  reload: { url: '/assets/audio/sfx/reload.mp3', group: 'sfx' },
  dryFire: { url: '/assets/audio/sfx/dry-fire.mp3', group: 'sfx' },
  hitmarker: { url: '/assets/audio/sfx/hitmarker.mp3', group: 'sfx' },
  headshot: { url: '/assets/audio/sfx/headshot.mp3', group: 'sfx' },
  killConfirm: { url: '/assets/audio/sfx/kill-confirm.mp3', group: 'sfx' },
  footstep: { url: '/assets/audio/sfx/footstep.mp3', group: 'sfx' },
  jump: { url: '/assets/audio/sfx/jump.mp3', group: 'sfx' },
  land: { url: '/assets/audio/sfx/land.mp3', group: 'sfx' },
  grenadeThrow: { url: '/assets/audio/sfx/grenade-throw.mp3', group: 'sfx' },
  explosion: { url: '/assets/audio/sfx/explosion.mp3', group: 'sfx' },
  damageGrunt: { url: '/assets/audio/sfx/damage-grunt.mp3', group: 'sfx' },
  playerDeath: { url: '/assets/audio/sfx/player-death.mp3', group: 'sfx' },
  pickupHealth: { url: '/assets/audio/sfx/pickup-health.mp3', group: 'sfx' },
  pickupAmmo: { url: '/assets/audio/sfx/pickup-ammo.mp3', group: 'sfx' },
  uiClick: { url: '/assets/audio/ui/click.mp3', group: 'ui' },
  uiDeploy: { url: '/assets/audio/ui/deploy.mp3', group: 'ui' },
  ambienceLoop: { url: '/assets/audio/ambience/battlefield-dusk.mp3', group: 'ambience' },
  voWelcome: { url: '/assets/audio/voice/welcome.mp3', group: 'voice' },
  voDoubleKill: { url: '/assets/audio/voice/double-kill.mp3', group: 'voice' },
  voKillingSpree: { url: '/assets/audio/voice/killing-spree.mp3', group: 'voice' },
  voMatchOver: { url: '/assets/audio/voice/match-over.mp3', group: 'voice' },
  voOnTop: { url: '/assets/audio/voice/on-top.mp3', group: 'voice' },
};

export type SoundName = keyof typeof MANIFEST;

/** Web Audio manager: buffers, groups, distance attenuation, ambience loop. */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private groups = new Map<AudioGroup, GainNode>();
  private buffers = new Map<string, AudioBuffer>();
  private missing = new Set<string>();
  private loading = new Set<string>();
  private ambienceSource: AudioBufferSourceNode | null = null;
  private unlocked = false;
  muted = false;
  volume = 0.8;

  unlock(): void {
    if (this.unlocked) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      const groupGains: Record<AudioGroup, number> = {
        sfx: 0.9,
        ui: 0.7,
        ambience: 0.42,
        voice: 1.0,
      };
      for (const [name, gain] of Object.entries(groupGains) as Array<[AudioGroup, number]>) {
        const node = this.ctx.createGain();
        node.gain.value = gain;
        node.connect(this.master);
        this.groups.set(name, node);
      }
      this.unlocked = true;
      // warm the cache
      for (const name of Object.keys(MANIFEST)) void this.load(name as SoundName);
    } catch {
      this.unlocked = false;
    }
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  private async load(name: SoundName): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    if (this.buffers.has(name)) return this.buffers.get(name) ?? null;
    if (this.missing.has(name) || this.loading.has(name)) return null;
    this.loading.add(name);
    try {
      const res = await fetch(MANIFEST[name].url);
      if (!res.ok) throw new Error(`${res.status}`);
      const arr = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arr);
      this.buffers.set(name, buf);
      return buf;
    } catch {
      this.missing.add(name);
      return null;
    } finally {
      this.loading.delete(name);
    }
  }

  play(
    name: SoundName,
    opts: { volume?: number; pitchJitter?: number; distance?: number; maxDistance?: number } = {},
  ): void {
    if (!this.ctx || !this.unlocked) return;
    const buf = this.buffers.get(name);
    if (!buf) {
      void this.load(name);
      return;
    }
    const group = this.groups.get(MANIFEST[name].group);
    if (!group) return;

    let vol = opts.volume ?? 1;
    if (opts.distance !== undefined) {
      const maxD = opts.maxDistance ?? 46;
      if (opts.distance > maxD) return;
      vol *= Math.pow(1 - opts.distance / maxD, 1.6);
    }
    if (vol <= 0.01) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (opts.pitchJitter) {
      src.playbackRate.value = 1 + rand(-opts.pitchJitter, opts.pitchJitter);
    }
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(group);
    src.start();
  }

  startAmbience(): void {
    if (!this.ctx || this.ambienceSource) return;
    const buf = this.buffers.get('ambienceLoop');
    if (!buf) {
      void this.load('ambienceLoop').then((b) => {
        if (b && !this.ambienceSource) this.startAmbience();
      });
      return;
    }
    const group = this.groups.get('ambience');
    if (!group) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(group);
    src.start();
    this.ambienceSource = src;
  }

  stopAmbience(): void {
    if (this.ambienceSource) {
      try {
        this.ambienceSource.stop();
      } catch {
        /* already stopped */
      }
      this.ambienceSource = null;
    }
  }

  diagnostics(): { loaded: number; missing: string[] } {
    return { loaded: this.buffers.size, missing: [...this.missing] };
  }
}
