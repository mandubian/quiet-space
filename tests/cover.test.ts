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
  const stop = createAdCover(window as unknown as Window, { pollMs: 10 });
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
  stop();
  window.close();
});

test("overlay shows the configured image and survives player late arrival", async () => {
  const window = new JSDOM(`<body></body>`).window;
  const stop = createAdCover(window as unknown as Window, { pollMs: 10, getImageUrl: () => "https://images.example.test/calm.jpg" });
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
  stop();
  window.close();
});

test("replacement audio plays during ads with the player muted, and restores after", async () => {
  const window = playerWindow();
  const media = (window as unknown as { HTMLMediaElement: { prototype: Record<string, unknown> } }).HTMLMediaElement.prototype;
  media.play = function (this: HTMLMediaElement & { _plays?: number }) { this._plays = (this._plays ?? 0) + 1; return Promise.resolve(); };
  media.pause = function (this: HTMLMediaElement & { _pauses?: number }) { this._pauses = (this._pauses ?? 0) + 1; };
  const stop = createAdCover(window as unknown as Window, { pollMs: 10, getAudioUrl: () => "https://audio.example.test/calm.mp3" });
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
  stop();
  window.close();
});

test("stop() removes the overlay and stops watching", async () => {
  const window = playerWindow();
  const stop = createAdCover(window as unknown as Window, { pollMs: 10 });
  const player = window.document.getElementById("movie_player")!;
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  assert.equal(window.document.querySelector("[data-quiet-cover]"), null, "overlay removed on stop");
  player.classList.remove("ad-showing");
  player.classList.add("ad-showing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(window.document.querySelector("[data-quiet-cover]"), null, "no overlay after stop");
  window.close();
});
