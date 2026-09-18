import { createServer } from "node:http";

export const FIXTURE = `<!doctype html><html><head><title>Daily news</title></head><body>
<nav><a href="/s">Sections</a></nav>
<main>
<article><h2>City opens new park</h2><p>The council approved the plan on Tuesday after a long debate.</p></article>
<aside id="promo" class="sponsored-card"><a href="https://ads.example.test/deal?utm=1">Sponsored: 50% off risk-free trials today</a><img alt="special offer banner" src="https://cdn.example.test/banner.png"></aside>
</main></body></html>`;

export const IMAGE_AD = `<div class="AmPlaceholder__skeleton" data-v-de5f5118=""><div class="AmPlaceholder__skeletonContent" data-v-de5f5118=""><div class="AmPlaceholder__skeletonTitle" data-v-de5f5118="">L'ÉQUIPE</div><div class="AmPlaceholder__skeletonSubtitle" data-v-de5f5118="">publicité</div></div><div class="AmPlaceholder__skeletonAdContainer" data-v-de5f5118=""><div data-v-f07388f7="" data-v-b018ddd4="" class="DfpAm DfpAm--SLOT-1"><div data-v-f07388f7="" class="DfpAm__inner adm-ad-rendered" id="dfp_slot-1" data-adunitpath="/366560878/LEQUIPE/SITE-DESKTOP/HOME/SLOT-1" data-ad-position="SLOT-1" data-google-query-id="fixture-query"><div id="google_ads_iframe_fixture__container__" style="border:0;margin:auto;text-align:center;width:300px;height:250px"><iframe id="google_ads_iframe_fixture" name="google_ads_iframe_fixture" title="Contenu d'annonce tiers" width="3" height="1" scrolling="no" frameborder="0" aria-label="Publicité" tabindex="0" data-load-complete="true" data-google-container-id="2" style="border:0;vertical-align:bottom;width:300px;height:250px"></iframe></div></div></div></div></div>`;

export const WRAPPED_IMAGE_AD = `<div class="AmPlaceholder has-placeholder has-skeleton AmPlaceholder--SLOT AmPlaceholder--SLOT-2 non_subscribed_only is-rendered" data-v-b018ddd4="" data-v-de5f5118="">${IMAGE_AD.replaceAll("SLOT-1", "SLOT-2").replaceAll("slot-1", "slot-2").replaceAll("width:300px;height:250px", "width:728px;height:90px").replace('width="3" height="1"', 'width="728" height="90"')}</div>`;

export function startFixtureServer(html = FIXTURE) {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  return server;
}
