import assert from "node:assert/strict";
import test from "node:test";
import { createAdCover } from "../extension/cover.js";
import { JSDOM } from "jsdom";

function playerWindow(): JSDOM["window"] {
  const window = new JSDOM(`<body><div id="movie_player"><video></video><div class="ytp-ad-player-overlay"></div></div></body>`).window;
  Object.defineProperty(window, "setInterval", { value: window.setInterval.bind(window), configurable: true });
  return window;
}

test("overlay covers the player while an ad shows and disappears when it ends", async () => {
  const window = playerWindow();
  const cover = createAdCover(window as unknown as Window, { pollMs: 10 });
  const player = window.document.getElementById("movie_player")!;
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const overlay = window.document.querySelector("[data-quiet-cover]");
  assert.ok(overlay, "overlay must appear during ads");
  assert.ok(overlay.parentElement === player);
  assert.match(overlay.textContent ?? "", /Quiet Space/);
  player.classList.remove("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(window.document.querySelector("[data-quiet-cover]"), null, "overlay must disappear when the ad ends");
  cover.stop();
  window.close();
});

test("overlay shows the configured image and survives player late arrival", async () => {
  const window = new JSDOM(`<body></body>`).window;
  const cover = createAdCover(window as unknown as Window, { pollMs: 10, getImageUrl: () => "https://images.example.test/calm.jpg" });
  const player = window.document.createElement("div");
  player.id = "movie_player";
  window.document.body.appendChild(player);
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const overlay = window.document.querySelector("[data-quiet-cover]");
  assert.ok(overlay, "overlay must appear once the player exists");
  const image = overlay.querySelector("img");
  assert.ok(image);
  assert.equal(image.getAttribute("src"), "https://images.example.test/calm.jpg");
  cover.stop();
  window.close();
});

test("replacement audio plays during ads with the player muted, and restores after", async () => {
  const window = playerWindow();
  const media = (window as unknown as { HTMLMediaElement: { prototype: Record<string, unknown> } }).HTMLMediaElement.prototype;
  media.play = function (this: HTMLMediaElement & { _plays?: number }) { this._plays = (this._plays ?? 0) + 1; return Promise.resolve(); };
  media.pause = function (this: HTMLMediaElement & { _pauses?: number }) { this._pauses = (this._pauses ?? 0) + 1; };
  const cover = createAdCover(window as unknown as Window, { pollMs: 10, getAudioUrl: () => "https://audio.example.test/calm.mp3" });
  const player = window.document.getElementById("movie_player")!;
  const video = window.document.createElement("video");
  player.appendChild(video);
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const audio = window.document.querySelector("audio");
  assert.ok(audio, "replacement audio element must exist during ads");
  assert.equal(audio.getAttribute("src"), "https://audio.example.test/calm.mp3");
  assert.equal(audio.loop, true);
  assert.equal(video.muted, true, "ad audio must be muted");
  player.classList.remove("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(video.muted, false, "player audio must be restored after the ad");
  assert.ok((audio as HTMLAudioElement & { _pauses?: number })._pauses, "replacement audio must be paused after the ad");
  cover.stop();
  window.close();
});

test("rain default is used, and setVolume controls live playback level", async () => {
  const window = playerWindow();
  const cover = createAdCover(window as unknown as Window, { pollMs: 10, defaultAudioUrl: "chrome-extension://ext/assets/rain.wav", volume: 0.6 });
  const player = window.document.getElementById("movie_player")!;
  const video = window.document.createElement("video");
  player.appendChild(video);
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const audio = window.document.querySelector("audio");
  assert.ok(audio, "default rain audio must play without a configured URL");
  assert.match(audio.getAttribute("src") ?? "", /rain\.wav$/);
  assert.equal(audio.volume, 0.6);
  cover.setVolume(0.25);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(audio.volume, 0.25, "volume changes apply live");
  cover.stop();
  assert.equal(window.document.querySelector("[data-quiet-cover]"), null, "overlay removed on stop");
  player.classList.remove("ad-showing");
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(window.document.querySelector("[data-quiet-cover]"), null, "no overlay after stop");
  window.close();
});

test("player ad audio is ducked to zero during ads and restored after", async () => {
  const window = playerWindow();
  const calls: string[] = [];
  const cover = createAdCover(window as unknown as Window, { pollMs: 10, defaultAudioUrl: "chrome-extension://ext/assets/rain.wav", volume: 0.6 });
  const player = window.document.getElementById("movie_player")!;
  (player as unknown as { setVolume: (volume: number) => void }).setVolume = (volume) => calls.push(`setVolume:${volume}`);
  (player as unknown as { mute: () => void }).mute = () => calls.push("mute");
  (player as unknown as { unMute: () => void }).unMute = () => calls.push("unMute");
  const video = window.document.createElement("video");
  player.appendChild(video);
  video.volume = 0.8;
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(calls.includes("setVolume:0"), "player API volume must be pinned to 0");
  assert.ok(calls.includes("mute"), "player API mute must be engaged");
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
  player.classList.remove("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(calls.includes("unMute"), "player audio must be restored after the ad");
  assert.equal(video.muted, false);
  cover.stop();
  window.close();
});
