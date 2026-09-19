export interface AdCoverOptions {
  pollMs?: number;
  getImageUrl?: () => string | undefined;
  getAudioUrl?: () => string | undefined;
}

export function createAdCover(window: Window, options: AdCoverOptions = {}): () => void {
  const document = window.document;
  const pollMs = options.pollMs ?? 300;
  let overlay: HTMLElement | undefined;
  let audio: HTMLAudioElement | undefined;
  let stopped = false;

  const findPlayer = (): HTMLElement | null => document.getElementById("movie_player");

  const setVideosMuted = (muted: boolean) => {
    for (const video of [...document.querySelectorAll<HTMLVideoElement>("video")]) video.muted = muted;
  };

  const show = (player: HTMLElement) => {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.dataset.quietCover = "true";
    overlay.style.cssText = "position:absolute;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#101815,#22302a);overflow:hidden;";
    const imageUrl = options.getImageUrl?.();
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "";
      image.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;opacity:0.9;";
      image.addEventListener("error", () => image.remove());
      overlay.appendChild(image);
    }
    const label = document.createElement("span");
    label.textContent = "Quiet Space — ad playing";
    label.style.cssText = "position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#cfd8d2;font:13px system-ui;letter-spacing:0.04em;";
    overlay.appendChild(label);
    player.style.position = "relative";
    player.appendChild(overlay);
    const audioUrl = options.getAudioUrl?.();
    if (audioUrl) {
      if (!audio) {
        audio = document.createElement("audio");
        audio.loop = true;
        overlay.appendChild(audio);
      }
      if (audio.getAttribute("src") !== audioUrl) audio.src = audioUrl;
      const playback = audio.play();
      if (playback) playback.catch(() => { /* autoplay guard: tab interaction usually satisfies it */ });
    }
    setVideosMuted(true);
  };

  const hide = () => {
    overlay?.remove();
    overlay = undefined;
    audio?.pause();
    setVideosMuted(false);
  };

  const tick = () => {
    if (stopped) return;
    const player = findPlayer();
    if (!player) {
      hide();
      return;
    }
    if (player.classList.contains("ad-showing")) show(player);
    else hide();
  };

  tick();
  const timer = window.setInterval(tick, pollMs);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    hide();
    audio = undefined;
  };
}
