import type { Input } from './Input';

/**
 * Mobile touch controls: left virtual joystick for movement, right-side drag for
 * look, and on-screen fire/ADS/jump/reload/weapon buttons. All emit the same
 * game intents as keyboard/mouse via the Input instance.
 */
export class TouchControls {
  readonly enabled: boolean;
  private lookTouchId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private moveTouchId: number | null = null;

  constructor(
    private input: Input,
    private canvas: HTMLCanvasElement,
  ) {
    this.enabled =
      'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!this.enabled) return;

    this.input.touchMode = true;
    document.body.classList.add('touch');

    const stick = document.getElementById('touch-move');
    const knob = stick?.querySelector<HTMLElement>('.touch-knob');
    if (stick && knob) this.bindStick(stick, knob);

    this.bindHold('touch-fire', (down) => (this.input.touchFire = down));
    this.bindHold('touch-ads', (down) => (this.input.touchAds = down));
    this.bindTap('touch-jump', () => this.input.pressTouchJump());
    this.bindTap('touch-reload', () => this.input.pressTouchReload());
    for (const btn of document.querySelectorAll<HTMLElement>('.touch-wpn')) {
      btn.addEventListener(
        'touchstart',
        (e) => {
          e.preventDefault();
          if (btn.dataset.nade) this.input.pressTouchGrenade();
          else if (btn.dataset.slot) {
            const s = Number(btn.dataset.slot) as 1 | 2 | 3;
            this.input.pressTouchSlot(s);
          }
        },
        { passive: false },
      );
    }

    // right-side look drag on the canvas
    this.canvas.addEventListener('touchstart', this.onCanvasTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onCanvasTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onCanvasTouchEnd);
    this.canvas.addEventListener('touchcancel', this.onCanvasTouchEnd);
  }

  private bindStick(stick: HTMLElement, knob: HTMLElement): void {
    const radius = 52;
    const reset = (): void => {
      knob.style.transform = 'translate(0,0)';
      this.input.touchMoveX = 0;
      this.input.touchMoveY = 0;
      this.moveTouchId = null;
    };
    stick.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.moveTouchId = e.changedTouches[0].identifier;
      },
      { passive: false },
    );
    stick.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        const t = Array.from(e.touches).find((x) => x.identifier === this.moveTouchId);
        if (!t) return;
        const rect = stick.getBoundingClientRect();
        let dx = t.clientX - (rect.left + rect.width / 2);
        let dy = t.clientY - (rect.top + rect.height / 2);
        const len = Math.hypot(dx, dy);
        if (len > radius) {
          dx = (dx / len) * radius;
          dy = (dy / len) * radius;
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.input.touchMoveX = dx / radius;
        this.input.touchMoveY = -dy / radius; // up = forward
      },
      { passive: false },
    );
    stick.addEventListener('touchend', reset);
    stick.addEventListener('touchcancel', reset);
  }

  private bindHold(id: string, set: (down: boolean) => void): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); }, { passive: false });
    el.addEventListener('touchend', () => set(false));
    el.addEventListener('touchcancel', () => set(false));
  }

  private bindTap(id: string, fn: () => void): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
  }

  private onCanvasTouchStart = (e: TouchEvent): void => {
    if (this.lookTouchId !== null) return;
    // only start look for touches on the right half (left half is the stick zone)
    const t = e.changedTouches[0];
    if (t.clientX < window.innerWidth * 0.4) return;
    this.lookTouchId = t.identifier;
    this.lookLastX = t.clientX;
    this.lookLastY = t.clientY;
  };

  private onCanvasTouchMove = (e: TouchEvent): void => {
    const t = Array.from(e.touches).find((x) => x.identifier === this.lookTouchId);
    if (!t) return;
    e.preventDefault();
    this.input.addTouchLook(t.clientX - this.lookLastX, t.clientY - this.lookLastY);
    this.lookLastX = t.clientX;
    this.lookLastY = t.clientY;
  };

  private onCanvasTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.lookTouchId) this.lookTouchId = null;
    }
  };
}
