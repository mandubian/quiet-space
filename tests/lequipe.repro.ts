import { build } from "esbuild";
import puppeteer from "puppeteer";

const bundle = await build({
  entryPoints: ["extension/dom.ts"], bundle: true, write: false,
  format: "iife", globalName: "JevProbe", platform: "browser",
});
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto("https://www.lequipe.fr/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(await page.evaluate(`${bundle.outputFiles[0].text}; (() => {
    const result = JevProbe.collect(document);
    return {
      title: document.title,
      elements: document.body.querySelectorAll('*').length,
      scanned: result.candidates.length,
      limited: result.limited,
      candidates: result.request.blocks.map(b => ({tag:b.tag, hints:b.hints, textLength:b.text.length})),
      frames: [...document.querySelectorAll('iframe')].map(f => ({id:f.id, title:f.title, visible:f.getBoundingClientRect().height > 0})),
      adSlots: [...document.querySelectorAll('[id],[class]')].filter(n => /advert|sponsor|publicit|dfp|gpt|adslot|ad-slot/i.test(n.id + ' ' + n.className)).slice(0,30).map(n => ({tag:n.tagName,id:n.id,classes:String(n.className).slice(0,100),height:n.getBoundingClientRect().height,textLength:(n.innerText || '').length}))
    };
  })()`));
} finally {
  await browser.close();
}
