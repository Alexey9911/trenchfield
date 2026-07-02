// Multiplayer front-end: wallet panel, lobby browser + create modal, lobby room,
// global/lobby chat dock, leaderboards. All wired to NetClient + wallet helpers.
import type { ChatMessage, LobbyState, MetaPayload, NetClient } from '../net/NetClient';
import {
  connectWallet,
  detectWallets,
  payStake,
  signAuthMessage,
  walletBalance,
  type WalletInfo,
} from '../solana/wallet';
import type { MapId } from '../game/constants';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface MultiplayerUICallbacks {
  onUiClick: () => void;
  getNick: () => string;
  getGuestId: () => string;
  onWalletChange: (addr: string | null) => void;
}

export class MultiplayerUI {
  private wallet: WalletInfo | null = null;
  walletAddress: string | null = null;
  private authToken: string | null = null;
  private chatScope: 'global' | 'lobby' = 'global';
  private globalChat: ChatMessage[] = [];
  private lobbyChat: ChatMessage[] = [];

  constructor(
    private net: NetClient,
    private cb: MultiplayerUICallbacks,
  ) {
    this.bindDom();
  }

  // ---------------------------------------------------------------- wallet --

  private bindDom(): void {
    el<HTMLButtonElement>('mp-connect-btn').addEventListener('click', () => {
      this.cb.onUiClick();
      void this.openWalletChooser();
    });
    el<HTMLButtonElement>('btn-create-lobby').addEventListener('click', () => {
      this.cb.onUiClick();
      this.showCreateModal(true);
    });
    el<HTMLButtonElement>('create-cancel').addEventListener('click', () => {
      this.cb.onUiClick();
      this.showCreateModal(false);
    });
    el<HTMLButtonElement>('create-confirm').addEventListener('click', () => {
      this.cb.onUiClick();
      void this.createLobby();
    });
    el<HTMLButtonElement>('lobby-leave').addEventListener('click', () => {
      this.cb.onUiClick();
      this.net.leaveLobby();
      this.showLobbyRoom(false);
    });
    el<HTMLButtonElement>('lobby-ready').addEventListener('click', () => {
      this.cb.onUiClick();
      void this.onReadyClick();
    });
    el<HTMLButtonElement>('lobby-unstake').addEventListener('click', () => {
      this.cb.onUiClick();
      void this.net.unstake();
    });

    // wager mode toggles stake row
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="create-mode"]')) {
      radio.addEventListener('change', () => {
        el('create-stake-row').classList.toggle('hidden', radio.value !== 'wager' || !radio.checked);
      });
    }

    // chat
    const input = el<HTMLInputElement>('chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        this.net.sendChat(input.value.trim(), this.chatScope);
        input.value = '';
      }
      e.stopPropagation();
    });
    el<HTMLButtonElement>('chat-toggle').addEventListener('click', () => {
      const dock = el('chat-dock');
      // on mobile the toggle closes the sheet; on desktop it collapses
      if (dock.classList.contains('mobile-open')) dock.classList.remove('mobile-open');
      else dock.classList.toggle('collapsed');
    });
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.chat-tab')) {
      tab.addEventListener('click', () => {
        this.chatScope = tab.dataset.scope === 'lobby' ? 'lobby' : 'global';
        for (const t of document.querySelectorAll('.chat-tab')) t.classList.remove('active');
        tab.classList.add('active');
        this.renderChat();
      });
    }

    for (const tab of document.querySelectorAll<HTMLButtonElement>('.lb-tab')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.lb-tab')) t.classList.remove('active');
        tab.classList.add('active');
        this.renderLeaderboard();
      });
    }

    // mobile chat launcher: opens the dock as a bottom sheet
    el<HTMLButtonElement>('chat-fab').addEventListener('click', () => {
      el('chat-dock').classList.add('mobile-open');
      el('chat-dock').classList.remove('collapsed');
    });
  }

  private async openWalletChooser(): Promise<void> {
    const wallets = detectWallets();
    const list = el('wallet-options');
    if (wallets.length === 0) {
      list.innerHTML =
        '<p class="wallet-none">No Solana wallet detected. Install <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> and reload.</p>';
      el('wallet-modal').classList.add('active');
      el('wallet-modal-close').onclick = () => el('wallet-modal').classList.remove('active');
      return;
    }
    list.innerHTML = '';
    for (const w of wallets) {
      const btn = document.createElement('button');
      btn.className = 'wallet-option';
      btn.innerHTML = `<span class="wallet-glyph">◈</span>${esc(w.label)}`;
      btn.onclick = () => {
        el('wallet-modal').classList.remove('active');
        void this.connectFlow(w);
      };
      list.appendChild(btn);
    }
    el('wallet-modal').classList.add('active');
    el('wallet-modal-close').onclick = () => el('wallet-modal').classList.remove('active');
  }

  private async connectFlow(w: WalletInfo): Promise<void> {
    try {
      const address = await connectWallet(w);
      this.wallet = w;
      this.walletAddress = address;
      // nonce → sign → session token
      const n = await this.net.walletNonce(address);
      if (n.nonce && n.message) {
        const signature = await signAuthMessage(w, n.message);
        const auth = await this.net.walletAuth(address, signature, n.nonce);
        if (auth.token) {
          this.authToken = auth.token;
          localStorage.setItem('tf-wallet', address);
          localStorage.setItem('tf-token', auth.token);
          await this.net.hello(this.cb.getNick(), address, auth.token, this.cb.getGuestId());
          this.cb.onWalletChange(address);
        }
      }
      await this.refreshWalletPanel();
    } catch (err) {
      this.toast(`wallet: ${(err as Error).message}`);
    }
  }

  async tryResumeSession(): Promise<void> {
    const wallet = localStorage.getItem('tf-wallet');
    const token = localStorage.getItem('tf-token');
    if (wallet && token) {
      const res = await this.net.hello(this.cb.getNick(), wallet, token, this.cb.getGuestId());
      if (res.authed) {
        this.walletAddress = wallet;
        this.authToken = token;
        this.cb.onWalletChange(wallet);
        await this.refreshWalletPanel();
        return;
      }
    }
    await this.net.hello(this.cb.getNick(), null, null, this.cb.getGuestId());
  }

  private async refreshWalletPanel(): Promise<void> {
    const status = el('mp-wallet-status');
    const btn = el<HTMLButtonElement>('mp-connect-btn');
    if (this.walletAddress) {
      const short = `${this.walletAddress.slice(0, 4)}…${this.walletAddress.slice(-4)}`;
      const bal = await walletBalance(this.walletAddress);
      status.innerHTML = `<span class="wallet-addr-live">${esc(short)}</span><span class="wallet-bal">${bal.toFixed(3)} SOL</span>`;
      btn.textContent = 'CONNECTED';
      btn.classList.add('connected');
    } else {
      status.textContent = 'Not connected';
      btn.textContent = 'CONNECT WALLET';
      btn.classList.remove('connected');
    }
  }

  get isAuthed(): boolean {
    return Boolean(this.authToken);
  }

  // ---------------------------------------------------------------- lobbies --

  renderMeta(meta: MetaPayload): void {
    el('mp-online').textContent = String(meta.online);
    // lobby list
    const list = el('lobby-list');
    if (meta.lobbies.length === 0) {
      list.innerHTML = '<p class="lobby-empty">No open lobbies — create the first one.</p>';
    } else {
      list.innerHTML = meta.lobbies
        .map(
          (l) => `
          <div class="lobby-row ${l.joinable ? '' : 'locked'}" data-code="${l.code}">
            <span class="lobby-title">${esc(l.title)}</span>
            <span class="lobby-map ${l.map}">${l.map === 'day' ? 'DAY' : 'NIGHT'}</span>
            <span class="lobby-stake">${l.mode === 'wager' ? `◎ ${l.stake}` : 'FREE'}</span>
            <span class="lobby-count">${l.count}/${l.maxPlayers}</span>
            <span class="lobby-status">${l.status === 'waiting' ? 'OPEN' : 'LIVE'}</span>
          </div>`,
        )
        .join('');
      for (const row of list.querySelectorAll<HTMLDivElement>('.lobby-row:not(.locked)')) {
        row.onclick = () => {
          this.cb.onUiClick();
          void this.joinLobby(row.dataset.code ?? '');
        };
      }
    }
    this.renderLeaderboard();
    // stake selector options
    const sel = el<HTMLSelectElement>('create-stake');
    if (sel.options.length === 0 && meta.stakes) {
      for (const s of meta.stakes) {
        const o = document.createElement('option');
        o.value = String(s);
        o.textContent = `◎ ${s} SOL`;
        sel.appendChild(o);
      }
    }
    el('create-wager-label').classList.toggle('disabled', !meta.wagersEnabled);
  }

  private renderLeaderboard(): void {
    const meta = this.net.meta;
    if (!meta) return;
    const mode = document.querySelector<HTMLButtonElement>('.lb-tab.active')?.dataset.mode ?? 'kills';
    const body = el('leaderboard-body');
    if (mode === 'sol') {
      body.innerHTML = meta.leaderSol
        .map(
          (r, i) => `
          <tr><td>${i + 1}</td><td>${esc(r.nick)}</td><td class="lb-wallet">${esc(shortW(r.wallet))}</td>
          <td class="tp-green">◎ ${Number(r.sol_won).toFixed(3)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="lobby-empty">No SOL won yet</td></tr>';
    } else {
      body.innerHTML = meta.leaderKills
        .map(
          (r, i) => `
          <tr><td>${i + 1}</td><td>${esc(r.nick)}</td><td class="lb-wallet">${esc(shortW(r.wallet))}</td>
          <td>${r.kills}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="lobby-empty">No kills recorded yet</td></tr>';
    }
  }

  private showCreateModal(show: boolean): void {
    el('create-modal').classList.toggle('active', show);
  }

  private async createLobby(): Promise<void> {
    const mode =
      document.querySelector<HTMLInputElement>('input[name="create-mode"]:checked')?.value === 'wager'
        ? 'wager'
        : 'free';
    if (mode === 'wager' && !this.isAuthed) {
      this.toast('connect your wallet first');
      return;
    }
    const res = await this.net.createLobby({
      title: el<HTMLInputElement>('create-title').value || `${this.cb.getNick()}'s trench`,
      mode,
      stake: Number(el<HTMLSelectElement>('create-stake').value || 0.01),
      map: (document.querySelector<HTMLInputElement>('input[name="create-map"]:checked')?.value ??
        'day') as MapId,
      maxPlayers: Number(el<HTMLSelectElement>('create-max').value || 4),
    });
    if (res.error) return this.toast(res.error);
    this.showCreateModal(false);
    this.showLobbyRoom(true);
  }

  private async joinLobby(code: string): Promise<void> {
    const res = await this.net.joinLobby(code);
    if (res.error) return this.toast(res.error);
    this.showLobbyRoom(true);
  }

  showLobbyRoom(show: boolean): void {
    el('screen-lobby').classList.toggle('active', show);
    if (show && this.net.lobby) this.renderLobby(this.net.lobby);
  }

  renderLobby(l: LobbyState): void {
    if (!el('screen-lobby').classList.contains('active')) return;
    el('lobby-room-title').textContent = l.title;
    el('lobby-room-code').textContent = l.code;
    el('lobby-room-info').innerHTML = `
      <span class="lobby-map ${l.map}">${l.map === 'day' ? 'DAYBREAK' : 'MIDNIGHT'}</span>
      <span>${l.mode === 'wager' ? `◎ ${l.stake} SOL stake · kill = ◎ ${(l.stake * 0.1).toFixed(3)}` : 'FRIENDLY — no stakes'}</span>
      <span>${l.players.filter((p) => !p.gone).length}/${l.maxPlayers}</span>`;

    const me = l.players.find((p) => p.id === this.net.myId());
    const rows = el('lobby-room-players');
    rows.innerHTML = l.players
      .filter((p) => !p.gone)
      .map(
        (p) => `
        <div class="lr-player ${p.id === this.net.myId() ? 'you' : ''}">
          <span class="lr-nick">${esc(p.nick)}${p.id === l.hostId ? ' <em>HOST</em>' : ''}</span>
          <span class="lr-wallet">${esc(p.wallet ?? '—')}</span>
          ${l.mode === 'wager' ? `<span class="lr-stake ${p.escrowed ? 'ok' : ''}">${p.escrowed ? 'STAKED' : 'UNSTAKED'}</span>` : ''}
          <span class="lr-ready ${p.ready ? 'ok' : ''}">${p.ready ? 'READY' : 'WAITING'}</span>
        </div>`,
      )
      .join('');

    const readyBtn = el<HTMLButtonElement>('lobby-ready');
    const unstakeBtn = el<HTMLButtonElement>('lobby-unstake');
    if (l.mode === 'wager') {
      if (me?.escrowed) {
        readyBtn.textContent = 'STAKED & READY';
        readyBtn.disabled = true;
        unstakeBtn.classList.remove('hidden');
      } else {
        readyBtn.textContent = `STAKE ◎ ${l.stake} & READY`;
        readyBtn.disabled = false;
        unstakeBtn.classList.add('hidden');
      }
    } else {
      readyBtn.textContent = me?.ready ? 'UNREADY' : 'READY UP';
      readyBtn.disabled = false;
      unstakeBtn.classList.add('hidden');
    }

    const cd = el('lobby-countdown');
    if (l.countdownEnds) {
      cd.classList.add('show');
      const tick = (): void => {
        const left = Math.max(0, (l.countdownEnds ?? 0) - Date.now());
        cd.textContent = `DEPLOYING IN ${(left / 1000).toFixed(1)}s`;
        if (left > 0 && el('lobby-countdown').classList.contains('show')) requestAnimationFrame(tick);
      };
      tick();
    } else {
      cd.classList.remove('show');
      cd.textContent = '';
    }
  }

  private async onReadyClick(): Promise<void> {
    const l = this.net.lobby;
    if (!l) return;
    const me = l.players.find((p) => p.id === this.net.myId());
    if (l.mode === 'wager' && !me?.escrowed) {
      if (!this.wallet || !this.walletAddress) return this.toast('connect your wallet first');
      const escrow = this.net.meta?.escrow;
      if (!escrow) return this.toast('wagers unavailable');
      try {
        this.toast('confirm the transfer in your wallet…');
        const sig = await payStake(this.wallet, escrow, l.stake);
        this.toast('verifying deposit on-chain…');
        const res = await this.net.escrowDeposit(sig);
        if (res.error) return this.toast(res.error);
        this.toast('stake locked in ✔');
        void this.refreshWalletPanel();
      } catch (err) {
        this.toast(`stake failed: ${(err as Error).message}`);
      }
      return;
    }
    this.net.setReady(!(me?.ready ?? false));
  }

  // ------------------------------------------------------------------ chat --

  addChat(msg: ChatMessage): void {
    const list = msg.scope === 'lobby' ? this.lobbyChat : this.globalChat;
    list.push(msg);
    if (list.length > 60) list.shift();
    if (msg.scope === this.chatScope) this.renderChat();
  }

  setLobbyChatHistory(msgs: ChatMessage[]): void {
    this.lobbyChat = Array.isArray(msgs) ? msgs.map((m) => ({ ...m, scope: 'lobby' as const })) : [];
    if (this.chatScope === 'lobby') this.renderChat();
  }

  setGlobalChatHistory(msgs: ChatMessage[]): void {
    this.globalChat = Array.isArray(msgs) ? msgs : [];
    if (this.chatScope === 'global') this.renderChat();
  }

  removeChat(ids: number[]): void {
    this.globalChat = this.globalChat.filter((m) => !m.id || !ids.includes(m.id));
    this.renderChat();
  }

  private renderChat(): void {
    const list = this.chatScope === 'lobby' ? this.lobbyChat : this.globalChat;
    const box = el('chat-messages');
    box.innerHTML = list
      .map(
        (m) => `
        <div class="chat-msg"><span class="chat-nick">${esc(m.nick)}</span>${
          m.wallet ? `<span class="chat-wallet">${esc(m.wallet)}</span>` : ''
        }<span class="chat-text">${esc(m.msg)}</span></div>`,
      )
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  toast(text: string): void {
    const t = el('mp-toast');
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    window.setTimeout(() => t.classList.remove('show'), 2600);
  }

  setConnection(connected: boolean): void {
    el('mp-status-dot').classList.toggle('offline', !connected);
    el('mp-status-label').textContent = connected ? 'FRONTLINE ONLINE' : 'OFFLINE — solo only';
  }
}

function shortW(w: string | null): string {
  return w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '';
}
